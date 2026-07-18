'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

const PRELOAD = path.join(__dirname, 'preload.js');

let controlWin = null;
const outputWins = new Map();   // displayId -> BrowserWindow
const outputMeta = new Map();   // webContents.id -> { displayId }
const identifyWins = new Set();

// Current config, owned by the control window. Forwarded to every output.
let config = null;

function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i + 1,
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    pixelWidth: Math.round(d.bounds.width * d.scaleFactor),
    pixelHeight: Math.round(d.bounds.height * d.scaleFactor),
    internal: !!d.internal,
    primary: d.id === primary.id,
    active: outputWins.has(d.id),
  }));
}

function notifyControl(channel, payload) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, payload);
}

function broadcastToOutputs(channel, payload) {
  for (const win of outputWins.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function pushDisplays() {
  notifyControl('displays-changed', displayList());
  notifyControl('active-outputs', [...outputWins.keys()].map(String));
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Lattice',
    backgroundColor: '#14161a',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  controlWin.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  controlWin.on('closed', () => { controlWin = null; app.quit(); });
  controlWin.webContents.once('did-finish-load', () => console.log('[main] control window ready'));
}

function createOutput(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  const wcId = win.webContents.id;
  outputWins.set(display.id, win);
  outputMeta.set(wcId, { displayId: display.id });
  win.loadFile(path.join(__dirname, 'renderer', 'output.html'));
  win.once('ready-to-show', () => {
    win.show();
    // simpleFullscreen avoids the macOS Spaces animation and works per-display
    if (process.platform === 'darwin') win.setSimpleFullScreen(true);
    else win.setFullScreen(true);
  });
  win.on('closed', () => {
    outputWins.delete(display.id);
    outputMeta.delete(wcId);
    pushDisplays();
  });
  console.log(`[main] output started on display ${display.id} (${display.bounds.width}x${display.bounds.height})`);
}

// Virtual output: a regular resizable window that behaves like a physical
// output of the declared resolution — for mapping a show before the hardware
// is connected. The renderer composites at the virtual resolution first, then
// scales to the window, so scale modes and 1:1 offsets behave exactly like a
// real output of that size.
function createVirtualOutput(spec) {
  const wa = screen.getPrimaryDisplay().workArea;
  const scale = Math.min((wa.width * 0.55) / spec.width, (wa.height * 0.55) / spec.height, 1);
  const win = new BrowserWindow({
    width: Math.max(320, Math.round(spec.width * scale)),
    height: Math.max(180, Math.round(spec.height * scale)),
    title: `Lattice — ${spec.label || spec.id} (${spec.width}×${spec.height})`,
    backgroundColor: '#000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  // no aspect lock: resizing the window freely is how fit/fill/stretch become
  // visible on a virtual output (locked aspect made all three identical)
  const wcId = win.webContents.id;
  outputWins.set(spec.id, win);
  outputMeta.set(wcId, { displayId: spec.id, virtual: { width: spec.width, height: spec.height, label: spec.label || '' } });
  win.loadFile(path.join(__dirname, 'renderer', 'output.html'));
  win.on('closed', () => {
    outputWins.delete(spec.id);
    outputMeta.delete(wcId);
    pushDisplays();
  });
}

function identifyAll() {
  let vIndex = 0;
  for (const [key, win] of outputWins) {
    if (typeof key === 'string' && String(key).startsWith('v') && !win.isDestroyed()) {
      vIndex++;
      const meta = outputMeta.get(win.webContents.id);
      win.webContents.send('identify', { index: `V${vIndex}`, label: (meta && meta.virtual && meta.virtual.label) || 'Virtual output' });
    }
  }
  for (const d of displayList()) {
    if (outputWins.has(d.id)) {
      outputWins.get(d.id).webContents.send('identify', { index: d.index, label: d.label });
    } else {
      const win = new BrowserWindow({
        x: d.bounds.x + 40,
        y: d.bounds.y + 40,
        width: 340,
        height: 210,
        frame: false,
        alwaysOnTop: true,
        focusable: false,
        resizable: false,
        backgroundColor: '#000000',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      win.loadFile(path.join(__dirname, 'renderer', 'identify.html'), {
        query: { n: String(d.index), label: d.label, res: `${d.pixelWidth} x ${d.pixelHeight}` },
      });
      identifyWins.add(win);
      setTimeout(() => {
        identifyWins.delete(win);
        if (!win.isDestroyed()) win.close();
      }, 2500);
    }
  }
}

// ---------- auto-update (GitHub releases, packaged builds only) ----------
// electron-builder bakes the publish config (YoshiBowman/Lattice) into the app;
// electron-updater checks the latest release, downloads in the background, and
// installs on quit. Same setup verified end-to-end in RDM Explorer.

let updateDownloaded = false;
let macNeedsManualSwap = false; // unsigned/ad-hoc macOS builds: Squirrel.Mac can't swap them

function appBundlePath() {
  // /Applications/Lattice.app/Contents/MacOS/Lattice -> /Applications/Lattice.app
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

// Squirrel.Mac only installs updates into properly signed apps (Developer ID).
// Ad-hoc/linker-signed builds (unsigned electron-builder output) need the
// manual bundle-swap fallback below.
function macProperlySigned() {
  try {
    const out = spawnSync('codesign', ['-dvv', appBundlePath()], { encoding: 'utf8' });
    return /Authority=/.test((out.stderr || '') + (out.stdout || ''));
  } catch (_) {
    return false;
  }
}

// Fallback installer for unsigned macOS builds: take the zip electron-updater
// already downloaded, unpack to staging, swap the bundle, relaunch.
function installUnsignedMacUpdate() {
  const pendingDir = path.join(os.homedir(), 'Library', 'Caches', 'lattice-updater', 'pending');
  const zips = fs.readdirSync(pendingDir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => path.join(pendingDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!zips.length) return { ok: false, error: 'No downloaded update zip found' };

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-update-'));
  execFileSync('ditto', ['-x', '-k', zips[0], staging]);
  const newApp = fs.readdirSync(staging).map((f) => path.join(staging, f)).find((f) => f.endsWith('.app'));
  if (!newApp || !fs.existsSync(path.join(newApp, 'Contents', 'MacOS'))) {
    return { ok: false, error: 'Update zip did not contain a valid app bundle' };
  }

  const bundle = appBundlePath();
  const backup = bundle + '.old';
  fs.rmSync(backup, { recursive: true, force: true });
  execFileSync('/bin/mv', [bundle, backup]);   // running app keeps working from the renamed bundle
  execFileSync('/bin/mv', [newApp, bundle]);

  spawn('open', ['-n', bundle], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

function setupAutoUpdater() {
  if (!app.isPackaged) return; // dev runs from source — nothing to update
  if (process.platform === 'darwin') {
    macNeedsManualSwap = !macProperlySigned();
    // clean up the previous bundle left behind by a manual swap
    fs.rm(appBundlePath() + '.old', { recursive: true, force: true }, () => {});
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = !macNeedsManualSwap; // Squirrel would fail silently
  autoUpdater.on('update-available', (info) => {
    notifyControl('update-available', { version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    notifyControl('update-progress', { percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    notifyControl('update-downloaded', { version: info.version, manualOnly: macNeedsManualSwap });
  });
  autoUpdater.on('error', (err) => {
    // Non-fatal: a failed check must never interrupt a show.
    console.error('[autoUpdater]', err && err.message ? err.message : err);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 4 * 60 * 60 * 1000); // re-check every 4h while running
}

ipcMain.handle('install-update', () => {
  if (!updateDownloaded) return { ok: false, error: 'No update downloaded yet' };
  if (macNeedsManualSwap) {
    try {
      return installUnsignedMacUpdate();
    } catch (err) {
      console.error('[updater] manual swap failed:', err.message);
      return { ok: false, error: err.message };
    }
  }
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

// ---------- IPC ----------

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-displays', () => displayList());
ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (e, cfg) => {
  config = cfg;
  broadcastToOutputs('config', config);
});

ipcMain.handle('start-output', (e, displayId, virtualSpec) => {
  if (outputWins.has(displayId)) { outputWins.get(displayId).focus(); return; }
  if (virtualSpec && virtualSpec.width > 0 && virtualSpec.height > 0) {
    createVirtualOutput({
      id: String(displayId),
      width: Math.min(16384, virtualSpec.width | 0),
      height: Math.min(16384, virtualSpec.height | 0),
      label: String(virtualSpec.label || ''),
    });
    pushDisplays();
    return;
  }
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return;
  createOutput(display);
  pushDisplays();
});

ipcMain.handle('set-output-title', (e, displayId, title) => {
  const win = outputWins.get(displayId);
  if (win && !win.isDestroyed() && typeof title === 'string' && title) win.setTitle(title);
});

// arrow-key nudge from an output window: the control window owns the config,
// so relay the delta there; it updates posX/posY and pushes a fresh config
ipcMain.handle('nudge-output', (e, displayId, dx, dy) => {
  notifyControl('nudge-output', { id: displayId, dx: dx | 0, dy: dy | 0 });
});

// Readout logo is persisted on disk, NOT in localStorage — a multi-MB data
// URL blows the ~5MB localStorage quota and the resulting setItem exception
// used to kill config pushes entirely (outputs stopped responding).
const logoPath = () => path.join(app.getPath('userData'), 'readout-logo.dat');

ipcMain.handle('save-logo', (e, dataUrl) => {
  try {
    if (dataUrl && typeof dataUrl === 'string') fs.writeFileSync(logoPath(), dataUrl, 'utf8');
    else fs.rmSync(logoPath(), { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('load-logo', () => {
  try {
    return fs.existsSync(logoPath()) ? fs.readFileSync(logoPath(), 'utf8') : null;
  } catch (err) {
    return null;
  }
});

// ---------- show files (.lattice) ----------

ipcMain.handle('save-show', async (e, json) => {
  const res = await dialog.showSaveDialog(controlWin, {
    title: 'Save Show',
    defaultPath: 'show.lattice',
    filters: [{ name: 'Lattice Show', extensions: ['lattice'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, json, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('load-show', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    title: 'Load Show',
    properties: ['openFile'],
    filters: [{ name: 'Lattice Show', extensions: ['lattice', 'json'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    return { ok: true, path: res.filePaths[0], json: fs.readFileSync(res.filePaths[0], 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-output', (e, displayId) => {
  const win = outputWins.get(displayId);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('stop-all', () => {
  for (const win of [...outputWins.values()]) if (!win.isDestroyed()) win.close();
});

ipcMain.handle('identify', () => identifyAll());

ipcMain.handle('close-self', (e) => {
  const meta = outputMeta.get(e.sender.id);
  if (!meta) return;
  const win = outputWins.get(meta.displayId);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('my-output', (e) => {
  const meta = outputMeta.get(e.sender.id);
  if (!meta) return null;
  if (meta.virtual) {
    return {
      id: meta.displayId,
      virtual: true,
      vWidth: meta.virtual.width,
      vHeight: meta.virtual.height,
      index: 'V',
      label: meta.virtual.label || `Virtual ${meta.virtual.width}×${meta.virtual.height}`,
    };
  }
  const d = displayList().find((x) => x.id === meta.displayId);
  return d || { id: meta.displayId, index: 0, label: 'Unknown display' };
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  createControl();
  setupAutoUpdater();
  screen.on('display-added', pushDisplays);
  screen.on('display-removed', (e, oldDisplay) => {
    const win = outputWins.get(oldDisplay.id);
    if (win && !win.isDestroyed()) win.close();
    pushDisplays();
  });
  screen.on('display-metrics-changed', pushDisplays);
});

app.on('window-all-closed', () => app.quit());

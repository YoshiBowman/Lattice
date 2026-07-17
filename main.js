'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
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

function pushDisplays() { notifyControl('displays-changed', displayList()); }

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

function identifyAll() {
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

function setupAutoUpdater() {
  if (!app.isPackaged) return; // dev runs from source — nothing to update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    notifyControl('update-available', { version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    notifyControl('update-progress', { percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    notifyControl('update-downloaded', { version: info.version });
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
  if (updateDownloaded) {
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  }
  return { ok: false, error: 'No update downloaded yet' };
});

// ---------- IPC ----------

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-displays', () => displayList());
ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (e, cfg) => {
  config = cfg;
  broadcastToOutputs('config', config);
});

ipcMain.handle('start-output', (e, displayId) => {
  if (outputWins.has(displayId)) { outputWins.get(displayId).focus(); return; }
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return;
  createOutput(display);
  pushDisplays();
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

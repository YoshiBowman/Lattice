'use strict';
// DeckLink SDI output support.
//
// Every entry point here is designed so that "no helper binary, no driver, no
// card" is a NORMAL state, not an error: enumeration returns [], the Outputs
// panel simply shows no DeckLink cards, and Lattice behaves exactly as it does
// without any of this. Nothing in this file may throw into the config pipeline.

const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { execFile, spawn } = require('child_process');

const PRELOAD = path.join(__dirname, 'preload.js');

// Packaged builds carry the helper in extraResources; running from source uses
// the tree copy. Absence of both is expected and handled, not reported.
function helperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'decklink', 'latticeout'),
    path.join(__dirname, 'native', 'decklink-out', 'latticeout'),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* try next */ }
  }
  return null;
}

let cachedAvailable = null;
function available() {
  if (cachedAvailable === null) cachedAvailable = !!helperPath();
  return cachedAvailable;
}

// Enumerate sub-devices. Resolves to [] on any failure — a missing driver, a
// helper that will not run, malformed output. Never rejects.
function listDevices() {
  return new Promise((resolve) => {
    const bin = helperPath();
    if (!bin) return resolve([]);
    execFile(bin, ['list'], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.log('[decklink] enumeration unavailable:', err.message);
        return resolve([]);
      }
      try {
        const list = JSON.parse(stdout);
        resolve(Array.isArray(list) ? list : []);
      } catch (e) {
        console.log('[decklink] could not parse device list:', e.message);
        resolve([]);
      }
    });
  });
}

// Modes offered per output.
//
// `nativeBGRA` records only which modes the card will accept an RGB buffer for
// — NOT whether the SDI wire carries 4:4:4. Measured through the Videohub
// loopback, chroma is 4:2:2 in every mode including the BGRA ones: handing the
// card BGRA just moves the RGB->YUV conversion into the card. True 4:4:4 needs
// 444 output enabled on both ends and is not offered here.
const MODES = [
  { id: '1080p59.94', label: '1080p59.94', width: 1920, height: 1080, fps: 59.94, nativeBGRA: false },
  { id: '1080p60',    label: '1080p60',    width: 1920, height: 1080, fps: 60,    nativeBGRA: false },
  { id: '1080p50',    label: '1080p50',    width: 1920, height: 1080, fps: 50,    nativeBGRA: false },
  { id: '1080p30',    label: '1080p30',    width: 1920, height: 1080, fps: 30,    nativeBGRA: true },
  { id: '1080p29.97', label: '1080p29.97', width: 1920, height: 1080, fps: 29.97, nativeBGRA: true },
  { id: '1080p25',    label: '1080p25',    width: 1920, height: 1080, fps: 25,    nativeBGRA: true },
  { id: '1080p24',    label: '1080p24',    width: 1920, height: 1080, fps: 24,    nativeBGRA: true },
  { id: '720p59.94',  label: '720p59.94',  width: 1280, height: 720,  fps: 59.94, nativeBGRA: true },
  { id: '720p60',     label: '720p60',     width: 1280, height: 720,  fps: 60,    nativeBGRA: true },
  { id: '720p50',     label: '720p50',     width: 1280, height: 720,  fps: 50,    nativeBGRA: true },
];

function modeById(id) {
  return MODES.find((m) => m.id === id) || MODES[0];
}

// One helper process per output.
//
// Chosen over a single multiplexing helper for crash isolation — a driver fault
// on one sub-device cannot take the other seven with it — and because it keeps
// each frame socket owned by exactly one producer and one consumer, with no
// routing header and no cross-output head-of-line blocking. Two concurrent
// outputs were already measured clean inside one process, so this is not
// working around a limitation; it is buying containment at the cost of a few MB
// of RSS per output.
const active = new Map();   // outputId -> Session

class Session {
  constructor(id, deviceIndex, mode, range, onStatus) {
    this.id = id;
    this.deviceIndex = deviceIndex;
    this.mode = mode;
    this.range = range;
    this.onStatus = onStatus;
    this.win = null;
    this.child = null;
    this.server = null;
    this.conn = null;
    this.sockPath = path.join(os.tmpdir(), `lattice-dl-${process.pid}-${id}.sock`);
    this.frameBytes = 0;
    this.painted = 0;
    this.sentFrames = 0;
    this.skipped = 0;
    this.stopping = false;
    this.failed = false;
  }

  start() {
    const bin = helperPath();
    if (!bin) return { ok: false, error: 'The DeckLink helper is not installed with this build.' };
    const m = modeById(this.mode);

    try { fs.unlinkSync(this.sockPath); } catch (_) {}

    this.server = net.createServer((c) => {
      this.conn = c;
      c.on('error', () => {});
      c.on('close', () => { this.conn = null; });
    });
    this.server.on('error', (err) => {
      this.fail(`Could not open the frame channel: ${err.message}`);
    });

    this.server.listen(this.sockPath, () => {
      const args = ['stream', '--device', String(this.deviceIndex), '--mode', m.id,
                    '--socket', this.sockPath, '--range', this.range === 'full' ? 'full' : 'legal'];
      // Measured: when the card is handed BGRA it applies its own fixed
      // RGB->YUV matrix, which is always legal range — the range setting is
      // silently ignored. Forcing our own vImage conversion is the only way to
      // actually produce full range, so ask for it whenever full is selected.
      if (this.range === 'full') args.push('--yuv');
      this.child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let errText = '';
      this.child.stdout.on('data', (d) => this.onHelperLine(d.toString()));
      this.child.stderr.on('data', (d) => { errText += d.toString(); });
      this.child.on('error', (err) => this.fail(`The DeckLink helper failed to start: ${err.message}`));
      this.child.on('exit', (code, signal) => {
        if (this.stopping) return;
        // Exit code 3 is the port-safety guard; surface its reason verbatim
        // rather than a generic failure.
        const why = code === 3
          ? (errText.trim() || 'That SDI port is currently receiving a signal.')
          : (errText.trim() || `The DeckLink helper stopped unexpectedly (${signal || 'exit ' + code}).`);
        this.fail(why);
      });

      this.openWindow(m);
    });
    return { ok: true };
  }

  // Offscreen BrowserWindow running the ordinary output renderer at the SDI
  // raster size. output.js sizes its canvas from the window, so scale modes,
  // Crop X/Y and Pos X/Y behave exactly as on a physical display of that size —
  // no separate rendering path to keep in sync.
  openWindow(m) {
    this.win = new BrowserWindow({
      width: m.width,
      height: m.height,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        // Keep the raster at 1:1 regardless of where the window nominally sits.
        zoomFactor: 1,
        // The window is never shown, so Chromium would otherwise throttle its
        // rAF loop down to a crawl and the SDI feed would freeze.
        backgroundThrottling: false,
      },
    });
    this.frameBytes = m.width * m.height * 4;
    this.win.webContents.setFrameRate(Math.round(m.fps));
    this.win.webContents.on('paint', (_e, _dirty, image) => {
      this.painted++;
      const c = this.conn;
      if (!c || c.destroyed) return;
      // Live video: if the channel is full, drop this frame rather than queue
      // it. Buffering would trade a bounded loss for unbounded latency, which
      // is the wrong trade for an output feed.
      // One frame of slack absorbs normal scheduling jitter; beyond that the
      // helper is genuinely behind and queueing would only add latency.
      if (c.writableLength > this.frameBytes) { this.skipped++; return; }
      c.write(image.getBitmap());
      this.sentFrames++;
    });
    this.win.loadFile(path.join(__dirname, 'renderer', 'output.html'));
  }

  onHelperLine(text) {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const msg = JSON.parse(s);
        if (msg.event === 'ready') { this.deviceName = msg.device; this.onStatus(this.id, { state: 'running', info: msg }); }
        else if (msg.event === 'stats') {
          this.onStatus(this.id, {
            state: 'running',
            stats: Object.assign({}, msg, {
              paintFps: this.painted, sent: this.sentFrames, skipped: this.skipped,
            }),
          });
          this.painted = 0;
        }
      } catch (_) { /* a partial line is not worth reporting */ }
    }
  }

  fail(reason) {
    if (this.stopping) return;
    console.log(`[decklink] output ${this.id} stopped: ${reason}`);
    this.failed = true;
    this.onStatus(this.id, { state: 'error', error: reason });
    this.stop();
  }

  stop() {
    this.stopping = true;
    try { if (this.conn && !this.conn.destroyed) this.conn.end(); } catch (_) {}
    try { if (this.child) this.child.kill(); } catch (_) {}
    try { if (this.server) this.server.close(); } catch (_) {}
    try { if (this.win && !this.win.isDestroyed()) this.win.destroy(); } catch (_) {}
    try { fs.unlinkSync(this.sockPath); } catch (_) {}
    this.conn = null; this.child = null; this.server = null; this.win = null;
    active.delete(this.id);
    // The child's exit handler stays silent once `stopping` is set, so without
    // this the renderer is never told the output ended: the card keeps showing
    // "Stop" and pressing it does nothing visible even though the helper really
    // did stop. Suppressed after fail(), which has already reported a reason
    // that would otherwise be overwritten and lost from the card.
    if (!this.failed) {
      try { this.onStatus(this.id, { state: 'stopped' }); } catch (_) {}
    }
  }
}

function startOutput(id, deviceIndex, mode, range, onStatus) {
  if (active.has(id)) return { ok: true };
  const s = new Session(id, deviceIndex, mode, range, onStatus);
  active.set(id, s);
  const res = s.start();
  if (!res.ok) active.delete(id);
  return res;
}

function stopOutput(id) {
  const s = active.get(id);
  if (s) s.stop();
}

function stopAll() {
  for (const s of [...active.values()]) s.stop();
}

function activeIds() {
  return [...active.keys()];
}

// Forward a fresh config to every offscreen renderer, exactly as the main
// process does for on-screen outputs.
function broadcastConfig(config) {
  for (const s of active.values()) {
    if (s.win && !s.win.isDestroyed()) {
      try { s.win.webContents.send('config', config); } catch (_) {}
    }
  }
}

// What output.js's getMyOutput() needs, for an offscreen DeckLink renderer.
// Shaped like a physical display of the raster size so output.js needs no
// special case.
function metaForWebContents(wcId) {
  for (const s of active.values()) {
    if (s.win && !s.win.isDestroyed() && s.win.webContents.id === wcId) {
      const m = modeById(s.mode);
      return {
        id: s.id,
        decklink: true,
        index: 'SDI',
        label: s.deviceName || `DeckLink ${s.mode}`,
        pixelWidth: m.width,
        pixelHeight: m.height,
      };
    }
  }
  return null;
}

module.exports = {
  available, listDevices, startOutput, stopOutput, stopAll, activeIds,
  broadcastConfig, metaForWebContents, MODES, modeById,
};

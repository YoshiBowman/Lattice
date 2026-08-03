// End-to-end Phase 3 harness: drives the real decklink.js path inside Electron
// — offscreen BrowserWindow -> socket -> helper -> card — and reports the paint
// rate and the card's own pacing counters. No UI clicking required.
const path = require('path');
const { app, ipcMain } = require('electron');

const LATTICE = '/Users/resolume1/Lattice';
const decklink = require(path.join(LATTICE, 'decklink.js'));

const DEVICE = parseInt(process.env.DL_DEVICE || '0', 10);
const MODE = process.env.DL_MODE || '1080p59.94';
const SECONDS = parseInt(process.env.DL_SECONDS || '25', 10);
const OUTPUTS = parseInt(process.env.DL_OUTPUTS || '1', 10);

// Minimal config of the shape control.js broadcasts, so the offscreen renderer
// has a wall and a pattern to draw.
const wallId = 'w1';
const config = {
  walls: [{ id: wallId, name: 'Test wall', width: 1920, height: 1080, panelW: 128, panelH: 128,
            cabling: { signal: { runs: [], prefix: 'Port' }, power: { runs: [], prefix: 'Circuit' } } }],
  outputs: {},
  pattern: { type: process.env.DL_PATTERN || 'motion', fg: '#ffffff', bg: '#000000', size: 16, speed: 2, gradMode: 'gray-h', dir: 'h' },
  overlay: { type: 'none' },
  readout: { image: null },
  cablingLayer: 'signal',
};

const last = new Map();
function onStatus(id, s) {
  if (s.state === 'error') console.log(`[status ${id}] ERROR: ${s.error}`);
  else if (s.info) console.log(`[status ${id}] ready:`, JSON.stringify(s.info));
  else if (s.stats) { last.set(id, s.stats); console.log(`[status ${id}]`, JSON.stringify(s.stats)); }
}

ipcMain.handle('get-config', () => config);
ipcMain.handle('my-output', (e) => decklink.metaForWebContents(e.sender.id));
ipcMain.handle('set-output-title', () => {});
ipcMain.handle('nudge-output', () => {});
ipcMain.handle('close-self', () => {});

app.disableHardwareAcceleration = () => {};

app.whenReady().then(async () => {
  const devs = await decklink.listDevices();
  console.log(`devices: ${devs.length}`);
  const free = devs.filter((d) => !d.signalPresentOnInput);
  console.log(`free (not receiving): ${free.map((d) => d.index + ':' + d.name).join(', ')}`);

  const chosen = free.slice(0, OUTPUTS);
  if (!chosen.length) { console.log('no free port'); app.quit(); return; }

  for (const d of chosen) {
    const id = 'dl:' + d.persistentId;
    config.outputs[id] = { mode: '1to1', offsetX: 0, offsetY: 0, posX: 0, posY: 0, label: 'E2E', wallId };
    const r = decklink.startOutput(id, d.index, MODE, 'legal', onStatus);
    console.log(`start ${id} on device ${d.index}:`, JSON.stringify(r));
  }

  setTimeout(() => decklink.broadcastConfig(config), 1500);

  setTimeout(() => {
    console.log('\n--- summary ---');
    for (const [id, s] of last) {
      console.log(`${id}: paintFps=${s.paintFps} sent=${s.sent} skipped=${s.skipped} ` +
                  `rxFps=${s.rxFps} late=${s.late} dropped=${s.dropped} repeated=${s.repeated} discarded=${s.discarded}`);
    }
    decklink.stopAll();
    setTimeout(() => app.quit(), 500);
  }, SECONDS * 1000);
});

app.on('window-all-closed', () => {});

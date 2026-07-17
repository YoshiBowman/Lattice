'use strict';
// One-shot icon generator: renders build/icon.png (1024x1024, alpha) offscreen.
// Run: npx electron build/gen-icon.js   Then convert to .icns via iconutil.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">
<canvas id="c" width="1024" height="1024"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');

function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// macOS-style rounded square plate, 824x824 centered
const m = 100, S = 824, R = 186;
const plate = ctx.createLinearGradient(m, m, m, m + S);
plate.addColorStop(0, '#23262d');
plate.addColorStop(1, '#0e1013');
rr(m, m, S, S, R);
ctx.fillStyle = plate;
ctx.fill();

// lattice of LED cabinets — mixed sizes (one tall 1:2 tile), like the app's manual grid
rr(m, m, S, S, R);
ctx.clip();
const pad = 96, gap = 20;
const x0 = m + pad, y0 = m + pad;
const inner = S - pad * 2;                    // 632
const u = (inner - gap * 2) / 3;              // tile unit
const tiles = [
  // [x, y, w, h, color] in units
  [0, 0, 1, 1, '#8bd3ff'], [1, 0, 1, 1, '#3fa9f5'], [2, 0, 1, 2, '#1f6feb'], // tall 1:2 tile
  [0, 1, 1, 1, '#3fa9f5'], [1, 1, 1, 1, '#2b87d3'],
  [0, 2, 1, 1, '#1f6feb'], [1, 2, 1, 1, '#3fb950'], [2, 2, 1, 1, '#3fa9f5'], // one accent green
];
for (const [tx, ty, tw, th, color] of tiles) {
  const x = x0 + tx * (u + gap);
  const y = y0 + ty * (u + gap);
  const w = tw * u + (tw - 1) * gap;
  const h = th * u + (th - 1) * gap;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, color);
  g.addColorStop(1, color + 'cc');
  rr(x, y, w, h, 26);
  ctx.fillStyle = g;
  ctx.fill();
}
window.__done = true;
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  // Export straight from the canvas — keeps alpha regardless of window compositing
  const dataUrl = await win.webContents.executeJavaScript(
    `document.getElementById('c').toDataURL('image/png')`
  );
  fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote build/icon.png');
  app.quit();
});

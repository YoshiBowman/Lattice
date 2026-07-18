'use strict';
// Output window: renders the current pattern at native wall resolution into an
// offscreen canvas, then blits to the physical display per this output's scale mode.

let cfg = null;
let me = null;
let rafId = null;

const wall = document.createElement('canvas');
const wctx = wall.getContext('2d');
const view = document.getElementById('view');
const vctx = view.getContext('2d');
const infoEl = document.getElementById('info');
const identifyEl = document.getElementById('identify');

function myOutputCfg() {
  const o = (cfg && cfg.outputs && cfg.outputs[me.id]) || {};
  return {
    mode: o.mode || 'fit',
    offsetX: o.offsetX | 0,   // source crop into the wall (1:1 mode)
    offsetY: o.offsetY | 0,
    posX: o.posX | 0,         // where the image lands in the output frame
    posY: o.posY | 0,
    label: o.label || '',
    wallId: o.wallId,
  };
}

// The wall this output is assigned to (falls back to the first wall)
function myWall() {
  if (cfg && cfg.walls && cfg.walls.length) {
    const { wallId } = myOutputCfg();
    return cfg.walls.find((w) => w.id === wallId) || cfg.walls[0];
  }
  return cfg && cfg.wall; // legacy single-wall configs
}

function updateLabelOverlay() {
  // label now renders into the frame itself (center readout); here we only
  // keep the virtual window title in sync
  const oc = myOutputCfg();
  if (me && me.virtual) {
    window.ledwall.setOutputTitle(me.id,
      `Lattice — ${oc.label || me.label} (${me.vWidth}×${me.vHeight})`);
  }
}

function sizeView() {
  const dpr = window.devicePixelRatio || 1;
  view.width = Math.round(window.innerWidth * dpr);
  view.height = Math.round(window.innerHeight * dpr);
}

function ensureWall() {
  const wc = myWall();
  const w = Math.max(1, wc.width | 0);
  const h = Math.max(1, wc.height | 0);
  if (wall.width !== w) wall.width = w;
  if (wall.height !== h) wall.height = h;
}

const isIntegerScale = (s) => Math.abs(s - Math.round(s)) < 1e-6 && Math.round(s) >= 1;

// Virtual outputs composite at their declared resolution, then scale to the window
const virt = document.createElement('canvas');
const virtCtx = virt.getContext('2d');

function blit() {
  const isVirtual = !!(me && me.virtual);
  let tctx, W, H;
  if (isVirtual) {
    if (virt.width !== me.vWidth) virt.width = me.vWidth;
    if (virt.height !== me.vHeight) virt.height = me.vHeight;
    tctx = virtCtx; W = virt.width; H = virt.height;
  } else {
    tctx = vctx; W = view.width; H = view.height;
  }
  blitTo(tctx, W, H);
  if (isVirtual) {
    // present the virtual frame in the window, letterboxed, smooth
    vctx.fillStyle = '#000000';
    vctx.fillRect(0, 0, view.width, view.height);
    const s = Math.min(view.width / virt.width, view.height / virt.height);
    const dw = virt.width * s, dh = virt.height * s;
    vctx.imageSmoothingEnabled = !(isIntegerScale(s));
    vctx.imageSmoothingQuality = 'high';
    vctx.drawImage(virt, (view.width - dw) / 2, (view.height - dh) / 2, dw, dh);
  }
}

function blitTo(vctx, W, H) {
  const w = wall.width, h = wall.height;
  vctx.fillStyle = '#000000';
  vctx.fillRect(0, 0, W, H);
  // posX/posY shift where the image lands in the output frame — LED processors
  // often capture a region that doesn't start at the frame's top-left corner
  const { mode, offsetX, offsetY, posX, posY } = myOutputCfg();
  if (mode === '1to1') {
    // true pixel mapping — always crisp
    vctx.imageSmoothingEnabled = false;
    const sx = Math.max(0, Math.min(offsetX, w - 1));
    const sy = Math.max(0, Math.min(offsetY, h - 1));
    vctx.drawImage(wall, sx, sy, w - sx, h - sy, posX, posY, w - sx, h - sy);
    return;
  }
  // Scaled modes: nearest-neighbor at non-integer ratios renders 1px lines
  // unevenly (2px/3px alternating) or drops them entirely when a line lands
  // on a sampling boundary. Smooth-scale unless the ratio is a clean integer.
  let sX, sY, dx, dy, dw, dh;
  if (mode === 'stretch') {
    sX = W / w; sY = H / h; dx = 0; dy = 0; dw = W; dh = H;
  } else {
    const s = mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    sX = s; sY = s;
    dw = w * s; dh = h * s;
    dx = (W - dw) / 2; dy = (H - dh) / 2;
  }
  const crisp = isIntegerScale(sX) && isIntegerScale(sY);
  vctx.imageSmoothingEnabled = !crisp;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(wall, dx + posX, dy + posY, dw, dh);
}

const renderWallFrame = window.LED_CREATE_FRAME_RENDERER();

function renderFrame(t) {
  const oc = myOutputCfg();
  renderWallFrame(wctx, {
    wall: myWall(),
    pattern: cfg.pattern,
    overlay: cfg.overlay,
    readout: cfg.readout,
    centerLabel: oc.label,
  }, t);
  blit();
}

function apply() {
  if (!cfg || !me) return;
  ensureWall();
  updateLabelOverlay();
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  if (window.LED_FRAME_ANIMATED(cfg)) {
    const loop = (t) => { renderFrame(t); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
  } else {
    renderFrame(performance.now());
  }
}

function showInfo() {
  const dpr = window.devicePixelRatio || 1;
  const res = me.virtual
    ? `virtual ${me.vWidth} x ${me.vHeight} px`
    : `${Math.round(window.innerWidth * dpr)} x ${Math.round(window.innerHeight * dpr)} px`;
  const wc = myWall();
  infoEl.textContent =
    `Output ${me.index}: ${me.label} — ${res} | ${wc.name || 'wall'} ${wc.width} x ${wc.height} | ESC closes this output`;
  infoEl.classList.remove('hidden');
  setTimeout(() => infoEl.classList.add('hidden'), 4000);
}

async function init() {
  me = await window.ledwall.getMyOutput();
  cfg = await window.ledwall.getConfig();
  sizeView();

  window.ledwall.onConfig((c) => { cfg = c; apply(); });
  window.ledwall.onIdentify(({ index, label }) => {
    const oc = myOutputCfg();
    identifyEl.querySelector('.num').textContent = index;
    identifyEl.querySelector('.lbl').textContent = oc.label ? `${oc.label} — ${label}` : label;
    identifyEl.style.display = 'flex';
    setTimeout(() => { identifyEl.style.display = 'none'; }, 2500);
  });

  window.addEventListener('resize', () => { sizeView(); apply(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.ledwall.closeSelf(); return; }
    // arrow keys nudge this output's position in the frame (Shift = 10 px)
    const step = e.shiftKey ? 10 : 1;
    const nudge = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    }[e.key];
    if (nudge) {
      e.preventDefault();
      window.ledwall.nudgeOutput(me.id, nudge[0], nudge[1]);
      const oc = myOutputCfg();
      infoEl.textContent = `position ${oc.posX + nudge[0]}, ${oc.posY + nudge[1]}  (arrows nudge · shift = 10px)`;
      infoEl.classList.remove('hidden');
      clearTimeout(window.__posT);
      window.__posT = setTimeout(() => infoEl.classList.add('hidden'), 1500);
    }
  });
  if (me && me.virtual) document.body.style.cursor = 'default'; // windowed — keep the cursor
  window.LED_ON_IMAGE_READY(() => apply()); // re-render once the logo decodes

  if (cfg) { apply(); showInfo(); }
}

init();

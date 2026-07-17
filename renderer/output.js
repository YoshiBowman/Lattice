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
    offsetX: o.offsetX | 0,
    offsetY: o.offsetY | 0,
    label: o.label || '',
    showLabel: !!o.showLabel,
  };
}

function updateLabelOverlay() {
  const oc = myOutputCfg();
  const el = document.getElementById('outLabel');
  if (oc.showLabel && oc.label) {
    el.textContent = oc.label;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function sizeView() {
  const dpr = window.devicePixelRatio || 1;
  view.width = Math.round(window.innerWidth * dpr);
  view.height = Math.round(window.innerHeight * dpr);
}

function ensureWall() {
  const w = Math.max(1, cfg.wall.width | 0);
  const h = Math.max(1, cfg.wall.height | 0);
  if (wall.width !== w) wall.width = w;
  if (wall.height !== h) wall.height = h;
}

function blit() {
  const W = view.width, H = view.height;
  const w = wall.width, h = wall.height;
  vctx.imageSmoothingEnabled = false;
  vctx.fillStyle = '#000000';
  vctx.fillRect(0, 0, W, H);
  const { mode, offsetX, offsetY } = myOutputCfg();
  if (mode === 'stretch') {
    vctx.drawImage(wall, 0, 0, W, H);
  } else if (mode === '1to1') {
    const sx = Math.max(0, Math.min(offsetX, w - 1));
    const sy = Math.max(0, Math.min(offsetY, h - 1));
    const sw = Math.min(w - sx, W);
    const sh = Math.min(h - sy, H);
    vctx.drawImage(wall, sx, sy, sw, sh, 0, 0, sw, sh);
  } else {
    const s = mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    const dw = w * s, dh = h * s;
    vctx.drawImage(wall, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
}

function renderFrame(t) {
  window.LED_RENDER_FRAME(wctx, cfg, t);
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
  infoEl.textContent =
    `Output ${me.index}: ${me.label} — ${Math.round(window.innerWidth * dpr)} x ${Math.round(window.innerHeight * dpr)} px` +
    ` | wall ${cfg.wall.width} x ${cfg.wall.height} | ESC closes this output`;
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
    if (e.key === 'Escape') window.ledwall.closeSelf();
  });

  if (cfg) { apply(); showInfo(); }
}

init();

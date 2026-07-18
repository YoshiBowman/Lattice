'use strict';
const $ = (s) => document.querySelector(s);

const STORAGE_KEY = 'lattice-config-v1';
const LEGACY_STORAGE_KEY = 'ledwall-config-v1'; // pre-rename builds

const DEFAULTS = {
  wall: {
    mode: 'uniform', // 'uniform' | 'manual'
    defineBy: 'mm',  // 'mm' (physical size + pitch) | 'px'
    mmW: 500, mmH: 500, pitch: 2.9,
    panelW: 172, panelH: 172, panelsX: 8, panelsY: 4,
    colWidths: [500, 500], rowHeights: [500, 500],
    custom: false, width: 1024, height: 512,
  },
  pattern: { type: 'grid', fg: '#ffffff', bg: '#000000', size: 16, speed: 2, gradMode: 'gray-h', dir: 'h' },
  overlay: { type: 'none', color: '#3fb950', opacity: 70, speed: 1, dir: 'h' },
  outputs: {}, // displayId -> { mode, offsetX, offsetY, label, showLabel }
};

let cfg = loadConfig();
let displays = [];
let previewRaf = null;

const preview = $('#preview');
const previewCtx = preview.getContext('2d');

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        wall: { ...DEFAULTS.wall, ...saved.wall },
        pattern: { ...DEFAULTS.pattern, ...saved.pattern },
        overlay: { ...DEFAULTS.overlay, ...saved.overlay },
        outputs: saved.outputs || {},
      };
    }
  } catch (err) { /* corrupted config — fall through to defaults */ }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function resolveWall() {
  const w = cfg.wall;
  if (w.mode !== 'manual' && w.defineBy === 'mm') {
    // physical cabinet size + pixel pitch -> pixels per panel
    const pitch = Math.max(0.1, parseFloat(w.pitch) || 2.9);
    w.panelW = Math.max(1, Math.round(w.mmW / pitch));
    w.panelH = Math.max(1, Math.round(w.mmH / pitch));
  }
  if (!w.custom) {
    const g = window.LED_WALL_GRID(w);
    w.width = Math.max(1, g.width);
    w.height = Math.max(1, g.height);
  }
}

function parsePxList(raw, fallback) {
  const arr = String(raw).split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 16384);
  return arr.length ? arr : fallback.slice();
}

function push() {
  resolveWall();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  window.ledwall.setConfig(cfg);
  updateSummary();
  startPreview();
}

function updateSummary() {
  const w = cfg.wall;
  const g = window.LED_WALL_GRID(w);
  const lastCol = window.LED_COL_LETTER(g.cols - 1);
  let text = `Wall canvas: ${w.width} × ${w.height} px — panels A1…${lastCol}${g.rows} (${g.cols} × ${g.rows})`;
  if (w.mode !== 'manual' && w.defineBy === 'mm') {
    const mW = (w.panelsX * w.mmW) / 1000;
    const mH = (w.panelsY * w.mmH) / 1000;
    text += ` — ${mW.toFixed(2)} × ${mH.toFixed(2)} m`;
    $('#pxPerPanel').textContent = `${w.panelW} × ${w.panelH} px`;
  }
  $('#wallSummary').textContent = text;
  $('#previewRes').textContent = `${w.width} × ${w.height}`;
}

// ---------- pattern buttons & params ----------

function buildPatternButtons() {
  const box = $('#patternButtons');
  box.innerHTML = '';
  for (const [id, p] of Object.entries(window.LED_PATTERNS)) {
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.dataset.pattern = id;
    btn.addEventListener('click', () => {
      cfg.pattern.type = id;
      syncPatternUI();
      push();
    });
    box.appendChild(btn);
  }
}

function syncPatternUI() {
  const p = window.LED_PATTERNS[cfg.pattern.type] || window.LED_PATTERNS.grid;
  document.querySelectorAll('#patternButtons button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pattern === cfg.pattern.type);
  });
  document.querySelectorAll('.param').forEach((el) => {
    el.classList.toggle('visible', p.params.includes(el.dataset.param));
  });
  $('#sizeVal').textContent = `${cfg.pattern.size}px`;
  $('#speedVal').textContent = `${cfg.pattern.speed}×`;
}

// ---------- overlay pulse buttons & params ----------

function buildOverlayButtons() {
  const box = $('#overlayButtons');
  box.innerHTML = '';
  for (const [id, o] of Object.entries(window.LED_OVERLAYS)) {
    const btn = document.createElement('button');
    btn.textContent = o.name;
    btn.dataset.overlay = id;
    btn.addEventListener('click', () => {
      cfg.overlay.type = id;
      syncOverlayUI();
      push();
    });
    box.appendChild(btn);
  }
}

function syncOverlayUI() {
  const o = window.LED_OVERLAYS[cfg.overlay.type] || window.LED_OVERLAYS.none;
  document.querySelectorAll('#overlayButtons button').forEach((b) => {
    b.classList.toggle('active', b.dataset.overlay === cfg.overlay.type);
  });
  document.querySelectorAll('.oparam').forEach((el) => {
    el.classList.toggle('visible', o.params.includes(el.dataset.param));
  });
  $('#ovOpacityVal').textContent = `${cfg.overlay.opacity}%`;
  $('#ovSpeedVal').textContent = `${cfg.overlay.speed}×`;
}

// ---------- preview ----------

// Build a config whose wall is scaled to preview size, with panel seams at
// rounded positions. Rendering the pattern AT preview resolution keeps every
// seam a crisp, uniform 1px line — downscaling a wall-resolution image instead
// makes 1px lines vanish or vary in brightness depending on where they land.
function scaledCfgFor(s) {
  const g = window.LED_WALL_GRID(cfg.wall);
  const xs = g.xs.map((v) => Math.round(v * s));
  const ys = g.ys.map((v) => Math.round(v * s));
  const colWidths = [], rowHeights = [];
  for (let i = 0; i < g.cols; i++) colWidths.push(Math.max(1, xs[i + 1] - xs[i]));
  for (let i = 0; i < g.rows; i++) rowHeights.push(Math.max(1, ys[i + 1] - ys[i]));
  return {
    wall: {
      ...cfg.wall,
      mode: 'manual',
      colWidths, rowHeights,
      custom: true,
      width: Math.max(1, Math.round(cfg.wall.width * s)),
      height: Math.max(1, Math.round(cfg.wall.height * s)),
      pxLabelScale: 1 / s, // panelmap shows true panel px, not scaled
    },
    pattern: { ...cfg.pattern, size: Math.max(1, Math.round((cfg.pattern.size || 16) * s)) },
    overlay: cfg.overlay,
    outputs: cfg.outputs,
  };
}

function drawPreviewFrame(t) {
  resolveWall();
  const boxW = Math.max(100, $('#previewBox').clientWidth - 16);
  const boxH = 300;
  const s = Math.min(boxW / cfg.wall.width, boxH / cfg.wall.height, 1);
  const pcfg = s < 1 ? scaledCfgFor(s) : cfg;
  if (preview.width !== pcfg.wall.width) preview.width = pcfg.wall.width;
  if (preview.height !== pcfg.wall.height) preview.height = pcfg.wall.height;
  window.LED_RENDER_FRAME(previewCtx, pcfg, t);
}

function startPreview() {
  if (previewRaf !== null) { cancelAnimationFrame(previewRaf); previewRaf = null; }
  if (window.LED_FRAME_ANIMATED(cfg)) {
    const loop = (t) => { drawPreviewFrame(t); previewRaf = requestAnimationFrame(loop); };
    previewRaf = requestAnimationFrame(loop);
  } else {
    drawPreviewFrame(performance.now());
  }
}

// ---------- outputs ----------

function outCfgFor(id) {
  if (!cfg.outputs[id]) cfg.outputs[id] = { mode: 'fit', offsetX: 0, offsetY: 0, label: '', showLabel: false };
  return cfg.outputs[id];
}

function renderDisplays() {
  const box = $('#displayList');
  box.innerHTML = '';
  for (const d of displays) {
    const oc = outCfgFor(d.id);
    const card = document.createElement('div');
    card.className = 'display-card';

    const num = document.createElement('div');
    num.className = 'dnum';
    num.textContent = d.index;

    const info = document.createElement('div');
    info.className = 'dinfo';
    const name = document.createElement('div');
    name.className = 'dname';
    name.textContent = d.label + (d.primary ? '  (primary)' : '');
    const res = document.createElement('div');
    res.className = 'dres';
    res.textContent = `${d.pixelWidth} × ${d.pixelHeight} px` +
      (d.scaleFactor !== 1 ? ` (${d.bounds.width} × ${d.bounds.height} pt @ ${d.scaleFactor}x)` : '');
    info.append(name, res);

    const ctl = document.createElement('div');
    ctl.className = 'dctl';

    if (d.active) {
      const badge = document.createElement('span');
      badge.className = 'badge live';
      badge.textContent = 'Live';
      ctl.appendChild(badge);
    }

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'olabel';
    labelInput.placeholder = 'Output label';
    labelInput.value = oc.label || '';
    labelInput.addEventListener('change', () => { oc.label = labelInput.value.trim(); push(); });
    ctl.appendChild(labelInput);

    const showLab = document.createElement('label');
    showLab.className = 'check-inline';
    const showChk = document.createElement('input');
    showChk.type = 'checkbox';
    showChk.checked = !!oc.showLabel;
    showChk.addEventListener('change', () => { oc.showLabel = showChk.checked; push(); });
    showLab.append(showChk, document.createTextNode(' overlay'));
    ctl.appendChild(showLab);

    const modeSel = document.createElement('select');
    for (const [v, label] of [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch'], ['1to1', '1:1 pixel']]) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = label;
      modeSel.appendChild(opt);
    }
    modeSel.value = oc.mode;
    modeSel.addEventListener('change', () => { oc.mode = modeSel.value; renderDisplays(); push(); });
    ctl.appendChild(modeSel);

    if (oc.mode === '1to1') {
      for (const key of ['offsetX', 'offsetY']) {
        const lab = document.createElement('label');
        lab.textContent = key === 'offsetX' ? 'X' : 'Y';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.value = oc[key];
        inp.addEventListener('change', () => { oc[key] = Math.max(0, inp.value | 0); push(); });
        lab.appendChild(inp);
        ctl.appendChild(lab);
      }
    }

    const btn = document.createElement('button');
    btn.className = d.active ? 'btn danger' : 'btn primary';
    btn.textContent = d.active ? 'Stop' : 'Start Output';
    btn.addEventListener('click', () => {
      if (d.active) window.ledwall.stopOutput(d.id);
      else window.ledwall.startOutput(d.id);
    });
    ctl.appendChild(btn);

    card.append(num, info, ctl);
    box.appendChild(card);
  }
}

// ---------- input wiring ----------

function bindNumber(id, obj, key, after) {
  const el = $(id);
  el.value = obj[key];
  el.addEventListener('change', () => {
    obj[key] = Math.max(parseInt(el.min, 10) || 1, el.value | 0);
    el.value = obj[key];
    if (after) after();
    push();
  });
}

function syncWallModeUI() {
  $('#uniformRows').style.display = cfg.wall.mode === 'manual' ? 'none' : '';
  $('#manualRows').style.display = cfg.wall.mode === 'manual' ? '' : 'none';
  $('#mmRows').style.display = cfg.wall.defineBy === 'mm' ? '' : 'none';
  $('#pxRows').style.display = cfg.wall.defineBy === 'px' ? '' : 'none';
}

function wireInputs() {
  bindNumber('#panelW', cfg.wall, 'panelW');
  bindNumber('#panelH', cfg.wall, 'panelH');
  bindNumber('#panelsX', cfg.wall, 'panelsX');
  bindNumber('#panelsY', cfg.wall, 'panelsY');
  bindNumber('#wallW', cfg.wall, 'width');
  bindNumber('#wallH', cfg.wall, 'height');

  const wallMode = $('#wallMode');
  wallMode.value = cfg.wall.mode;
  wallMode.addEventListener('change', () => {
    cfg.wall.mode = wallMode.value;
    syncWallModeUI();
    push();
  });

  const defineBy = $('#defineBy');
  defineBy.value = cfg.wall.defineBy;
  defineBy.addEventListener('change', () => {
    cfg.wall.defineBy = defineBy.value;
    syncWallModeUI();
    push();
  });

  bindNumber('#mmW', cfg.wall, 'mmW');
  bindNumber('#mmH', cfg.wall, 'mmH');

  const pitch = $('#pitch');
  pitch.value = cfg.wall.pitch;
  pitch.addEventListener('change', () => {
    cfg.wall.pitch = Math.min(50, Math.max(0.4, parseFloat(pitch.value) || 2.9));
    pitch.value = cfg.wall.pitch;
    push();
  });

  syncWallModeUI();

  document.querySelectorAll('.preset-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.dataset.pitch) {
        cfg.wall.pitch = parseFloat(chip.dataset.pitch);
        $('#pitch').value = cfg.wall.pitch;
      } else if (chip.dataset.mmw) {
        cfg.wall.mmW = chip.dataset.mmw | 0;
        cfg.wall.mmH = chip.dataset.mmh | 0;
        $('#mmW').value = cfg.wall.mmW;
        $('#mmH').value = cfg.wall.mmH;
      } else {
        cfg.wall.panelW = chip.dataset.pw | 0;
        cfg.wall.panelH = chip.dataset.ph | 0;
        $('#panelW').value = cfg.wall.panelW;
        $('#panelH').value = cfg.wall.panelH;
      }
      push();
    });
  });

  for (const [id, key] of [['#colWidths', 'colWidths'], ['#rowHeights', 'rowHeights']]) {
    const el = $(id);
    el.value = cfg.wall[key].join(', ');
    el.addEventListener('change', () => {
      cfg.wall[key] = parsePxList(el.value, DEFAULTS.wall[key]);
      el.value = cfg.wall[key].join(', ');
      push();
    });
  }

  const customRes = $('#customRes');
  customRes.checked = cfg.wall.custom;
  $('#customResRow').style.display = cfg.wall.custom ? '' : 'none';
  customRes.addEventListener('change', () => {
    cfg.wall.custom = customRes.checked;
    $('#customResRow').style.display = cfg.wall.custom ? '' : 'none';
    push();
  });

  for (const id of ['fg', 'bg']) {
    const el = $('#' + id);
    el.value = cfg.pattern[id];
    el.addEventListener('input', () => { cfg.pattern[id] = el.value; push(); });
  }

  const size = $('#size');
  size.value = cfg.pattern.size;
  size.addEventListener('input', () => {
    cfg.pattern.size = size.value | 0;
    $('#sizeVal').textContent = `${cfg.pattern.size}px`;
    push();
  });

  const speed = $('#speed');
  speed.value = cfg.pattern.speed;
  speed.addEventListener('input', () => {
    cfg.pattern.speed = parseFloat(speed.value);
    $('#speedVal').textContent = `${cfg.pattern.speed}×`;
    push();
  });

  const gradMode = $('#gradMode');
  gradMode.value = cfg.pattern.gradMode;
  gradMode.addEventListener('change', () => { cfg.pattern.gradMode = gradMode.value; push(); });

  const dir = $('#dir');
  dir.value = cfg.pattern.dir || 'h';
  dir.addEventListener('change', () => { cfg.pattern.dir = dir.value; push(); });

  // overlay pulse params
  const ovColor = $('#ovColor');
  ovColor.value = cfg.overlay.color;
  ovColor.addEventListener('input', () => { cfg.overlay.color = ovColor.value; push(); });

  const ovOpacity = $('#ovOpacity');
  ovOpacity.value = cfg.overlay.opacity;
  ovOpacity.addEventListener('input', () => {
    cfg.overlay.opacity = ovOpacity.value | 0;
    $('#ovOpacityVal').textContent = `${cfg.overlay.opacity}%`;
    push();
  });

  const ovSpeed = $('#ovSpeed');
  ovSpeed.value = cfg.overlay.speed;
  ovSpeed.addEventListener('input', () => {
    cfg.overlay.speed = parseFloat(ovSpeed.value);
    $('#ovSpeedVal').textContent = `${cfg.overlay.speed}×`;
    push();
  });

  const ovDir = $('#ovDir');
  ovDir.value = cfg.overlay.dir;
  ovDir.addEventListener('change', () => { cfg.overlay.dir = ovDir.value; push(); });

  $('#identifyBtn').addEventListener('click', () => window.ledwall.identify());
  $('#stopAllBtn').addEventListener('click', () => window.ledwall.stopAll());
}

// ---------- auto-update toast ----------

function updateBar() {
  let el = document.getElementById('updateBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'updateBar';
    el.innerHTML = '<span class="msg"></span>';
    document.body.appendChild(el);
  }
  return el;
}

function showUpdate(msg, withRestart) {
  const el = updateBar();
  el.querySelector('.msg').textContent = msg;
  let btn = el.querySelector('button');
  if (withRestart && !btn) {
    btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Restart & Update';
    btn.addEventListener('click', () => window.ledwall.installUpdate());
    el.appendChild(btn);
  }
  el.style.display = 'flex';
}

function wireUpdates() {
  window.ledwall.onUpdateAvailable(({ version }) => showUpdate(`Update v${version} available — downloading…`, false));
  window.ledwall.onUpdateProgress(({ percent }) => showUpdate(`Downloading update… ${percent}%`, false));
  window.ledwall.onUpdateDownloaded(({ version, manualOnly }) => showUpdate(
    manualOnly ? `Update v${version} ready —` : `v${version} downloaded — installs on quit, or`, true));
}

// ---------- init ----------

async function init() {
  $('#version').textContent = 'v' + (await window.ledwall.getVersion());
  buildPatternButtons();
  buildOverlayButtons();
  wireInputs();
  wireUpdates();
  syncPatternUI();
  syncOverlayUI();

  displays = await window.ledwall.getDisplays();
  renderDisplays();
  window.ledwall.onDisplaysChanged((list) => { displays = list; renderDisplays(); });

  window.addEventListener('resize', () => startPreview());

  push(); // send initial config to main so outputs can pick it up
}

init();

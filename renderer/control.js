'use strict';
const $ = (s) => document.querySelector(s);

const STORAGE_KEY = 'lattice-config-v1';
const LEGACY_STORAGE_KEY = 'ledwall-config-v1'; // pre-rename builds

// Per-wall fields. A show can have many walls, each with its own size,
// panel layout and orientation; outputs are assigned a wall to display.
const WALL_DEFAULTS = {
  name: 'Wall 1',
  mode: 'uniform', // 'uniform' | 'manual'
  defineBy: 'mm',  // 'mm' (physical size + pitch) | 'px'
  mmW: 500, mmH: 500, pitch: 2.9,
  panelW: 172, panelH: 172, panelsX: 8, panelsY: 4,
  colWidths: [500, 500], rowHeights: [500, 500],
  custom: false, width: 1376, height: 688,
};

// Cabling defaults follow industry norms: ~650k pixels per gigabit processor
// port; power sized by NEC continuous-load derate (volts × amps × 0.8).
function emptyCabling() {
  return {
    signal: { runs: [], processorId: '', maxPixelsPerPort: 650000, prefix: 'Port' },
    power: { runs: [], wattsPerPanel: 150, volts: 120, ampsPerCircuit: 20, derate: 0.8, prefix: 'Circuit' },
  };
}

// WALL_DEFAULTS holds objects/arrays — every new wall needs its own copies or
// walls would share cabling runs and column lists.
function freshWall(id, name, over) {
  return {
    ...WALL_DEFAULTS,
    colWidths: WALL_DEFAULTS.colWidths.slice(),
    rowHeights: WALL_DEFAULTS.rowHeights.slice(),
    cabling: emptyCabling(),
    id,
    name,
    ...(over || {}),
  };
}

const DEFAULTS = {
  walls: [freshWall('w1', 'Wall 1')],
  selectedWall: 'w1',
  cablingLayer: 'signal',
  pattern: { type: 'grid', fg: '#ffffff', bg: '#000000', size: 16, speed: 2, gradMode: 'gray-h', dir: 'h' },
  overlay: { type: 'none', color: '#3fb950', opacity: 70, speed: 1, dir: 'h' },
  readout: { label: true, dims: false, scrim: true, font: 'mono', image: null }, // center label / wall name + dims + logo
  outputs: {}, // displayId | virtual id -> { mode, offsetX, offsetY, posX, posY, label, wallId }
  virtualOutputs: [], // [{ id: 'v...', width, height }]
};

let cfg = loadConfig();
let displays = [];
let previewRaf = null;
let activeSet = new Set(); // stringified ids of currently running outputs
let vSeq = 0;

const preview = $('#preview');
const previewCtx = preview.getContext('2d');
const renderPreviewFrame = window.LED_CREATE_FRAME_RENDERER();
let previewBoxW = 0; // cached; reading clientWidth every frame forces reflow

// Normalize any saved config shape (localStorage, legacy single-wall, or a
// .lattice show file) into the current structure with defaults filled in.
function normalizeConfig(saved) {
  if (!saved.walls && saved.wall) {
    saved.walls = [{ ...saved.wall, id: 'w1', name: 'Wall 1' }];
    saved.selectedWall = 'w1';
  }
  const walls = (saved.walls && saved.walls.length ? saved.walls : DEFAULTS.walls)
    .map((w, i) => {
      const merged = { ...freshWall('w' + (i + 1), `Wall ${i + 1}`), ...w };
      // walls saved before cabling existed, or with a partial layer
      const base = emptyCabling();
      merged.cabling = {
        signal: { ...base.signal, ...((w.cabling || {}).signal || {}) },
        power: { ...base.power, ...((w.cabling || {}).power || {}) },
      };
      return merged;
    });
  return {
    walls,
    selectedWall: walls.some((w) => w.id === saved.selectedWall) ? saved.selectedWall : walls[0].id,
    cablingLayer: saved.cablingLayer === 'power' ? 'power' : 'signal',
    pattern: { ...DEFAULTS.pattern, ...saved.pattern },
    overlay: { ...DEFAULTS.overlay, ...saved.overlay },
    readout: { ...DEFAULTS.readout, ...saved.readout },
    outputs: saved.outputs || {},
    virtualOutputs: saved.virtualOutputs || [],
  };
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) return normalizeConfig(JSON.parse(raw));
  } catch (err) { /* corrupted config — fall through to defaults */ }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function curWall() {
  return cfg.walls.find((w) => w.id === cfg.selectedWall) || cfg.walls[0];
}

function resolveWall(w) {
  if (w.mode !== 'manual' && w.defineBy === 'mm') {
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

function resolveWalls() { cfg.walls.forEach(resolveWall); }

function parsePxList(raw, fallback) {
  const arr = String(raw).split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 16384);
  return arr.length ? arr : fallback.slice();
}

function push() {
  resolveWalls();
  // Never let persistence kill the live pipeline: the logo data URL stays out
  // of localStorage (quota!), and a failed save must not block setConfig.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cfg, readout: { ...cfg.readout, image: cfg.readout.image ? true : null } }));
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
  window.ledwall.setConfig(cfg);
  updateSummary();
  renderWalls();
  if (cablingView) drawCablingEditor();
  else startPreview();
}

function wallSummaryText(w) {
  const g = window.LED_WALL_GRID(w);
  return `${w.width} × ${w.height} px (${g.cols} × ${g.rows})`;
}

function updateSummary() {
  const w = curWall();
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
  $('#previewRes').textContent = `${w.name}: ${w.width} × ${w.height}`;
}

// ---------- walls list ----------

function renderWalls() {
  const box = $('#wallList');
  box.innerHTML = '';
  cfg.walls.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'wall-row' + (w.id === cfg.selectedWall ? ' selected' : '');
    row.addEventListener('click', () => {
      if (cfg.selectedWall !== w.id) {
        cfg.selectedWall = w.id;
        syncWallInputs();
        activeRunId = null; // runs belong to the wall
        if (cablingView) {
          if (runs().length) activeRunId = runs()[0].id;
          syncCablingLimits();
          renderRunList();
        }
        push();
      }
    });

    const name = document.createElement('div');
    name.className = 'wname';
    name.textContent = w.name;

    const res = document.createElement('div');
    res.className = 'wres';
    res.textContent = wallSummaryText(w);

    const ctl = document.createElement('div');
    ctl.className = 'wctl';

    const winBtn = document.createElement('button');
    winBtn.className = 'btn small';
    winBtn.textContent = 'Window';
    winBtn.title = 'Open this wall in a virtual output window';
    winBtn.addEventListener('click', (e) => { e.stopPropagation(); previewWallInWindow(w); });
    ctl.appendChild(winBtn);

    const dupBtn = document.createElement('button');
    dupBtn.className = 'btn small';
    dupBtn.textContent = '⧉';
    dupBtn.title = 'Duplicate wall';
    dupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const copy = JSON.parse(JSON.stringify({ ...w, id: newWallId(), name: w.name + ' copy' }));
      cfg.walls.push(copy);
      cfg.selectedWall = copy.id;
      syncWallInputs();
      push();
      renderDisplays();
    });
    ctl.appendChild(dupBtn);

    if (cfg.walls.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn small remove';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove wall';
      rmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cfg.walls = cfg.walls.filter((x) => x.id !== w.id);
        if (cfg.selectedWall === w.id) cfg.selectedWall = cfg.walls[0].id;
        syncWallInputs();
        push();
        renderDisplays();
      });
      ctl.appendChild(rmBtn);
    }

    row.append(name, res, ctl);
    box.appendChild(row);
  });
}

function newWallId() {
  let id;
  do { id = 'w' + Date.now().toString(36) + (vSeq++); } while (cfg.walls.some((x) => x.id === id));
  return id;
}

function addWall() {
  const w = freshWall(newWallId(), `Wall ${cfg.walls.length + 1}`);
  cfg.walls.push(w);
  cfg.selectedWall = w.id;
  syncWallInputs();
  push();
  renderDisplays();
}

// Open a wall in a virtual output window at native wall resolution, 1:1
function previewWallInWindow(w) {
  resolveWalls();
  let id;
  do { id = 'v' + Date.now().toString(36) + (vSeq++); } while (cfg.virtualOutputs.some((x) => x.id === id));
  cfg.virtualOutputs.push({ id, width: w.width, height: w.height });
  const oc = outCfgFor(id);
  oc.wallId = w.id;
  oc.mode = 'fit'; // whole wall visible however the window is sized
  oc.label = w.name;
  push();
  renderDisplays();
  window.ledwall.startOutput(id, { width: w.width, height: w.height, label: w.name });
}

// ---------- wall -> output assignment dropdown ----------

function rebuildWallOutputSelect() {
  const sel = $('#wallOutput');
  if (!sel) return;
  const w = curWall();
  sel.innerHTML = '';
  const add = (v, label) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('', '— choose output —');
  displays.forEach((d) => add('d:' + d.id, `Display ${d.index}: ${d.label}`));
  cfg.virtualOutputs.forEach((v, i) => {
    const oc = cfg.outputs[v.id];
    add('v:' + v.id, `V${i + 1}: ${(oc && oc.label) || `${v.width}×${v.height}`}`);
  });
  add('new', '+ New virtual window (wall size)');
  // show the output currently assigned to this wall (prefer a live one)
  const assigned = Object.keys(cfg.outputs)
    .filter((k) => cfg.outputs[k].wallId === w.id)
    .sort((a, b) => (activeSet.has(String(b)) ? 1 : 0) - (activeSet.has(String(a)) ? 1 : 0))[0];
  if (assigned !== undefined) {
    const prefix = cfg.virtualOutputs.some((v) => String(v.id) === String(assigned)) ? 'v:' : 'd:';
    sel.value = prefix + assigned;
    if (sel.selectedIndex === -1) sel.value = ''; // stale id (display unplugged)
  }
}

function wireWallOutputSelect() {
  $('#wallOutput').addEventListener('change', () => {
    const val = $('#wallOutput').value;
    if (!val) return;
    const w = curWall();
    if (val === 'new') {
      previewWallInWindow(w);
      renderDisplays();
      return;
    }
    const kind = val.slice(0, 1);
    const idRaw = val.slice(2);
    const id = kind === 'd' ? Number(idRaw) : idRaw;
    const oc = outCfgFor(id);
    oc.wallId = w.id;
    push();
    renderDisplays();
    if (!activeSet.has(String(id))) {
      if (kind === 'd') {
        window.ledwall.startOutput(id);
      } else {
        const v = cfg.virtualOutputs.find((x) => String(x.id) === String(id));
        if (v) window.ledwall.startOutput(v.id, { width: v.width, height: v.height, label: oc.label });
      }
    }
  });
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

// ---------- preview (renders the SELECTED wall) ----------

// Build a config whose wall is scaled to preview size, with panel seams at
// rounded positions. Rendering the pattern AT preview resolution keeps every
// seam a crisp, uniform 1px line.
function scaledCfgFor(w, s) {
  const g = window.LED_WALL_GRID(w);
  const xs = g.xs.map((v) => Math.round(v * s));
  const ys = g.ys.map((v) => Math.round(v * s));
  const colWidths = [], rowHeights = [];
  for (let i = 0; i < g.cols; i++) colWidths.push(Math.max(1, xs[i + 1] - xs[i]));
  for (let i = 0; i < g.rows; i++) rowHeights.push(Math.max(1, ys[i + 1] - ys[i]));
  return {
    wall: {
      ...w,
      mode: 'manual',
      colWidths, rowHeights,
      custom: true,
      width: Math.max(1, Math.round(w.width * s)),
      height: Math.max(1, Math.round(w.height * s)),
      pxLabelScale: 1 / s, // panelmap/readout show true px, not scaled
      origMode: w.mode,
      origDefineBy: w.defineBy,
    },
    pattern: { ...cfg.pattern, size: Math.max(1, Math.round((cfg.pattern.size || 16) * s)) },
    overlay: cfg.overlay,
  };
}

// Rebuilt only on config changes — the animation loop reuses the same object
// every frame (the cached renderer invalidates on identity; per-frame object
// churn caused GC hitches in the pulses).
let previewCfg = null;

function rebuildPreviewCfg() {
  const w = curWall();
  resolveWall(w);
  previewBoxW = Math.max(100, $('#previewBox').clientWidth - 16);
  const boxH = 300;
  const s = Math.min(previewBoxW / w.width, boxH / w.height, 1);
  previewCfg = s < 1 ? scaledCfgFor(w, s) : { wall: w, pattern: cfg.pattern, overlay: cfg.overlay };
  previewCfg.readout = cfg.readout;
  previewCfg.cablingLayer = cfg.cablingLayer;
}

function drawPreviewFrame(t) {
  if (!previewCfg) rebuildPreviewCfg();
  if (preview.width !== previewCfg.wall.width) preview.width = previewCfg.wall.width;
  if (preview.height !== previewCfg.wall.height) preview.height = previewCfg.wall.height;
  renderPreviewFrame(previewCtx, previewCfg, t);
}

function startPreview() {
  rebuildPreviewCfg();
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
  if (!cfg.outputs[id]) cfg.outputs[id] = { mode: 'fit', offsetX: 0, offsetY: 0, posX: 0, posY: 0, label: '', wallId: cfg.walls[0].id };
  return cfg.outputs[id];
}

function wallSelectFor(oc) {
  const sel = document.createElement('select');
  for (const w of cfg.walls) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    sel.appendChild(opt);
  }
  sel.value = cfg.walls.some((w) => w.id === oc.wallId) ? oc.wallId : cfg.walls[0].id;
  sel.title = 'Which wall this output displays';
  sel.addEventListener('change', () => { oc.wallId = sel.value; push(); });
  return sel;
}

function field(caption, el, title) {
  const lab = document.createElement('label');
  lab.className = 'field';
  if (title) lab.title = title;
  const cap = document.createElement('span');
  cap.textContent = caption;
  lab.append(cap, el);
  return lab;
}

// The labeled control row shared by physical and virtual output cards.
function appendOutputControls(ctl, key, oc, nameEl) {
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'olabel';
  labelInput.placeholder = 'e.g. STAGE LEFT';
  labelInput.value = oc.label || '';
  // 'input' so the label applies live with every keystroke — no blur needed
  labelInput.addEventListener('input', () => {
    oc.label = labelInput.value.trim();
    if (nameEl) nameEl.textContent = oc.label || nameEl.dataset.fallback;
    push();
  });
  ctl.appendChild(field('Label', labelInput));

  ctl.appendChild(field('Wall', wallSelectFor(oc), 'Which wall this output displays'));

  const modeSel = document.createElement('select');
  for (const [val, label] of [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch'], ['1to1', '1:1 pixel']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    modeSel.appendChild(opt);
  }
  modeSel.value = oc.mode;
  modeSel.addEventListener('change', () => { oc.mode = modeSel.value; renderDisplays(); push(); });
  ctl.appendChild(field('Scale', modeSel));

  if (oc.mode === '1to1') {
    for (const key2 of ['offsetX', 'offsetY']) {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.value = oc[key2];
      inp.className = 'pos';
      inp.addEventListener('change', () => { oc[key2] = Math.max(0, inp.value | 0); push(); });
      ctl.appendChild(field(key2 === 'offsetX' ? 'Crop X' : 'Crop Y', inp, 'Which part of the wall this output shows (source crop)'));
    }
  }

  // where the image lands in the output frame — processors often capture a
  // region that doesn't start at the frame's top-left. Arrow keys on the
  // output window nudge these live (Shift = 10 px).
  for (const key3 of ['posX', 'posY']) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '1'; inp.value = oc[key3] | 0;
    inp.className = 'pos';
    inp.dataset.poskey = key3;
    inp.dataset.outid = String(key);
    inp.addEventListener('change', () => { oc[key3] = inp.value | 0; push(); });
    ctl.appendChild(field(key3 === 'posX' ? 'Pos X' : 'Pos Y', inp, 'Position within the output frame (arrow keys on the output nudge this)'));
  }
}

function startStopButton(key, active, startFn) {
  const btn = document.createElement('button');
  btn.className = active ? 'btn danger' : 'btn primary';
  btn.textContent = active ? 'Stop' : 'Start';
  btn.addEventListener('click', () => {
    if (active) window.ledwall.stopOutput(key);
    else startFn();
  });
  return btn;
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

    const head = document.createElement('div');
    head.className = 'dhead';
    head.append(num, info);
    if (d.active) {
      const badge = document.createElement('span');
      badge.className = 'badge live';
      badge.textContent = 'Live';
      head.appendChild(badge);
    }
    head.appendChild(startStopButton(d.id, d.active, () => window.ledwall.startOutput(d.id)));

    const ctl = document.createElement('div');
    ctl.className = 'dctl';
    appendOutputControls(ctl, d.id, oc, null);

    card.append(head, ctl);
    box.appendChild(card);
  }
  renderVirtuals();
  rebuildWallOutputSelect();
}

function renderVirtuals() {
  const box = $('#virtualList');
  box.innerHTML = '';
  cfg.virtualOutputs.forEach((v, i) => {
    const oc = outCfgFor(v.id);
    const active = activeSet.has(String(v.id));
    const card = document.createElement('div');
    card.className = 'display-card';

    const num = document.createElement('div');
    num.className = 'dnum';
    num.textContent = 'V' + (i + 1);

    const info = document.createElement('div');
    info.className = 'dinfo';
    const name = document.createElement('div');
    name.className = 'dname';
    name.dataset.fallback = `Virtual output ${i + 1}`;
    name.textContent = oc.label || name.dataset.fallback;
    const res = document.createElement('div');
    res.className = 'dres';
    res.textContent = `${v.width} × ${v.height} px — virtual`;
    info.append(name, res);

    const head = document.createElement('div');
    head.className = 'dhead';
    head.append(num, info);
    const badge = document.createElement('span');
    badge.className = active ? 'badge live' : 'badge virtual';
    badge.textContent = active ? 'Live' : 'Virtual';
    head.appendChild(badge);
    head.appendChild(startStopButton(v.id, active,
      () => window.ledwall.startOutput(v.id, { width: v.width, height: v.height, label: oc.label })));

    const rm = document.createElement('button');
    rm.className = 'btn remove';
    rm.textContent = '✕';
    rm.title = 'Remove virtual output';
    rm.addEventListener('click', () => {
      window.ledwall.stopOutput(v.id);
      cfg.virtualOutputs = cfg.virtualOutputs.filter((x) => x.id !== v.id);
      delete cfg.outputs[v.id];
      push();
      renderDisplays();
    });
    head.appendChild(rm);

    const ctl = document.createElement('div');
    ctl.className = 'dctl';
    appendOutputControls(ctl, v.id, oc, name);

    card.append(head, ctl);
    box.appendChild(card);
  });
}

function addVirtualOutput() {
  const width = Math.max(16, $('#vW').value | 0);
  const height = Math.max(16, $('#vH').value | 0);
  let id;
  do { id = 'v' + Date.now().toString(36) + (vSeq++); } while (cfg.virtualOutputs.some((x) => x.id === id));
  cfg.virtualOutputs.push({ id, width, height });
  push();
  renderDisplays();
}

// ---------- cabling ----------
//
// One "run" is a home run: a cable leaving a processor port (signal) or a
// circuit breaker (power), entering the wall at its first panel, then
// daisy-chaining panel to panel. Multiple runs per wall per layer.

let cablingView = false;
let activeRunId = null;
let cabScale = 1;
let cabWall = null;      // scaled copy of the wall used for drawing + hit-testing
let cabPad = 0;          // margin the home-run markers/labels are drawn in
let painting = false;

const cabCanvas = $('#cablingCanvas');
const cabCtx = cabCanvas.getContext('2d');

function curLayer() { return cfg.cablingLayer === 'power' ? 'power' : 'signal'; }
function layerCfg() { return curWall().cabling[curLayer()]; }
function runs() { return layerCfg().runs; }
function activeRun() { return runs().find((r) => r.id === activeRunId) || null; }

function newRunId() { return 'r' + Date.now().toString(36) + (vSeq++); }

function addRun(name) {
  const list = runs();
  const layer = curLayer();
  const prefix = layerCfg().prefix || (layer === 'signal' ? 'Port' : 'Circuit');
  const run = {
    id: newRunId(),
    name: name || `${prefix} ${list.length + 1}`,
    color: window.LED_RUN_COLORS[list.length % window.LED_RUN_COLORS.length],
    entry: '',
    path: [],
  };
  list.push(run);
  activeRunId = run.id;
  return run;
}

// panel -> how many runs of this layer include it (0 = unassigned, >1 = double-fed)
function assignmentMap() {
  const map = new Map();
  runs().forEach((run) => {
    (run.path || []).forEach(([c, r]) => {
      const k = c + ',' + r;
      map.set(k, (map.get(k) || 0) + 1);
    });
  });
  return map;
}

function cablingBoxWidth() {
  const box = $('#cablingBox');
  return Math.max(200, (box.clientWidth || 700) - 18);
}

// Shared painter for the editor canvas and the exported diagram: panel grid
// with A1 coordinates and assignment shading, then the cabling on top. `pad`
// is the margin that home-run markers and port labels live in.
function paintCablingDiagram(ctx, wallObj, layer, pad, opts) {
  const o = opts || {};
  const g = window.LED_WALL_GRID(wallObj);
  const assigned = o.assigned || new Map();
  const unit = Math.min(g.colWidths[0] || 40, g.rowHeights[0] || 40);
  const fs = Math.max(7, Math.floor(unit * 0.26));

  ctx.save();
  ctx.translate(pad, pad);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const x = g.xs[c], y = g.ys[r], pw = g.colWidths[c], ph = g.rowHeights[r];
      const n = assigned.get(c + ',' + r) || 0;
      ctx.fillStyle = n === 0 ? '#181b21' : '#23303d';
      ctx.fillRect(x + 1, y + 1, pw - 2, ph - 2);
      ctx.strokeStyle = n > 1 ? '#e5534b' : '#2e323b';
      ctx.lineWidth = n > 1 ? 2 : 1;
      ctx.strokeRect(x + 1.5, y + 1.5, pw - 3, ph - 3);
      ctx.fillStyle = n === 0 ? '#5c636e' : '#9aa1ad';
      ctx.font = `bold ${fs}px Menlo, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(window.LED_COL_LETTER(c) + (r + 1), x + 4, y + 3);
    }
  }
  window.LED_DRAW_CABLING(ctx, wallObj, wallObj.cabling, {
    layer,
    activeRunId: o.activeRunId,
    bounds: { x0: -pad, y0: -pad, x1: g.width + pad, y1: g.height + pad },
  });
  ctx.restore();
}

function drawCablingEditor() {
  if (!cablingView) return;
  const w = curWall();
  resolveWall(w);
  const boxW = cablingBoxWidth();
  const boxH = 430;
  const marginGuess = 64; // room for the home-run margin at either end
  cabScale = Math.min((boxW - marginGuess) / w.width, (boxH - marginGuess) / w.height, 1);
  cabWall = scaledCfgFor(w, cabScale).wall;
  cabWall.cabling = w.cabling;

  const g = window.LED_WALL_GRID(cabWall);
  const unit = Math.min(g.colWidths[0] || 40, g.rowHeights[0] || 40);
  cabPad = Math.max(20, Math.round(unit * 0.8));
  cabCanvas.width = cabWall.width + cabPad * 2;
  cabCanvas.height = cabWall.height + cabPad * 2;

  cabCtx.fillStyle = '#0b0d10';
  cabCtx.fillRect(0, 0, cabCanvas.width, cabCanvas.height);
  paintCablingDiagram(cabCtx, cabWall, curLayer(), cabPad, { activeRunId, assigned: assignmentMap() });
}

// canvas point -> [col, row] or null
function panelAt(evt) {
  if (!cabWall) return null;
  const rect = cabCanvas.getBoundingClientRect();
  const x = ((evt.clientX - rect.left) / rect.width) * cabCanvas.width - cabPad;
  const y = ((evt.clientY - rect.top) / rect.height) * cabCanvas.height - cabPad;
  const g = window.LED_WALL_GRID(cabWall);
  let c = -1, r = -1;
  for (let i = 0; i < g.cols; i++) if (x >= g.xs[i] && x < g.xs[i + 1]) { c = i; break; }
  for (let i = 0; i < g.rows; i++) if (y >= g.ys[i] && y < g.ys[i + 1]) { r = i; break; }
  return c >= 0 && r >= 0 ? [c, r] : null;
}

function touchPanel(cell, isDrag) {
  if (!cell) return;
  let run = activeRun();
  if (!run) run = addRun();
  const path = run.path;
  const [c, r] = cell;
  const last = path[path.length - 1];
  if (last && last[0] === c && last[1] === r) {
    if (!isDrag) path.pop(); // clicking the tip backs the cable up one panel
    return;
  }
  if (path.some(([pc, pr]) => pc === c && pr === r)) return; // already in this run
  path.push([c, r]);
}

function wireCablingCanvas() {
  cabCanvas.addEventListener('mousedown', (e) => {
    painting = true;
    touchPanel(panelAt(e), false);
    push();
    renderRunList();
  });
  cabCanvas.addEventListener('mousemove', (e) => {
    if (!painting) return;
    const before = (activeRun() || { path: [] }).path.length;
    touchPanel(panelAt(e), true);
    if ((activeRun() || { path: [] }).path.length !== before) {
      drawCablingEditor();
      renderRunList();
    }
  });
  const end = () => {
    if (!painting) return;
    painting = false;
    push();
    renderRunList();
  };
  window.addEventListener('mouseup', end);
  cabCanvas.addEventListener('mouseleave', end);
}

function loadText(load, layer) {
  if (layer === 'signal') {
    return `${load.panels}p · ${(load.pixels / 1000).toFixed(0)}k px / ${(load.limit / 1000).toFixed(0)}k`;
  }
  return `${load.panels}p · ${load.watts}W · ${load.amps.toFixed(1)}A / ${load.limit.toFixed(1)}A`;
}

function renderRunList() {
  const box = $('#runList');
  if (!box) return;
  const w = curWall();
  const layer = curLayer();
  box.innerHTML = '';
  runs().forEach((run) => {
    const row = document.createElement('div');
    row.className = 'run-row' + (run.id === activeRunId ? ' selected' : '');
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      activeRunId = run.id;
      renderRunList();
      drawCablingEditor();
    });

    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = run.color;

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'rname';
    name.value = run.name;
    name.addEventListener('input', () => { run.name = name.value; push(); drawCablingEditor(); });

    const edge = document.createElement('select');
    for (const [v, t] of [['', 'auto'], ['left', '←'], ['right', '→'], ['top', '↑'], ['bottom', '↓']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      edge.appendChild(o);
    }
    edge.className = 'redge';
    edge.title = 'Which edge the home run enters from';
    edge.value = run.entry || '';
    edge.addEventListener('change', () => { run.entry = edge.value; push(); drawCablingEditor(); });

    const load = window.LED_RUN_LOAD(w, w.cabling, layer, run);
    const ld = document.createElement('span');
    ld.className = 'rload' + (load.over ? ' over' : '');
    ld.textContent = loadText(load, layer);
    if (load.over) ld.title = 'Over the limit for one port/circuit';

    const rm = document.createElement('button');
    rm.className = 'btn small remove';
    rm.textContent = '✕';
    rm.title = 'Delete run';
    rm.addEventListener('click', () => {
      const list = runs();
      list.splice(list.indexOf(run), 1);
      if (activeRunId === run.id) activeRunId = list.length ? list[0].id : null;
      push();
      renderRunList();
      drawCablingEditor();
    });

    row.append(sw, name, edge, ld, rm);
    box.appendChild(row);
  });

  updateCablingSummary();
}

function selectedProcessor() {
  return window.LED_PROCESSOR_BY_ID(curWall().cabling.signal.processorId || '');
}

function updateCablingSummary() {
  const w = curWall();
  const g = window.LED_WALL_GRID(w);
  const layer = curLayer();
  const total = g.cols * g.rows;
  const assigned = assignmentMap();
  let covered = 0, doubled = 0;
  assigned.forEach((n) => { covered++; if (n > 1) doubled++; });
  const list = runs();
  const over = list.filter((r) => window.LED_RUN_LOAD(w, w.cabling, layer, r).over).length;
  const bits = [`${list.length} run${list.length === 1 ? '' : 's'}`,
    `${covered}/${total} panels assigned`];
  if (doubled) bits.push(`⚠ ${doubled} double-fed`);
  if (over) bits.push(`⚠ ${over} over limit`);
  if (total - covered > 0) bits.push(`${total - covered} unassigned`);

  // processor-level checks: a wall can fit per-port yet still exceed the
  // processor's port count or its overall pixel ceiling
  let bad = doubled || over;
  if (layer === 'signal') {
    const proc = selectedProcessor();
    if (proc) {
      if (list.length > proc.ports) {
        bits.push(`⚠ ${list.length} runs > ${proc.ports} ports on ${proc.model}`);
        bad = true;
      }
      let px = 0;
      list.forEach((r) => { px += window.LED_RUN_LOAD(w, w.cabling, 'signal', r).pixels; });
      if (px > proc.totalPx) {
        bits.push(`⚠ ${(px / 1e6).toFixed(2)}M px > ${(proc.totalPx / 1e6).toFixed(2)}M on ${proc.model}`);
        bad = true;
      }
    }
  }

  const el = $('#cablingSummary');
  el.textContent = bits.join(' · ');
  el.style.color = bad ? 'var(--danger)' : 'var(--accent)';
  $('#cablingWallName').textContent = w.name;
}

function buildProcessorSelect() {
  const sel = $('#processorSel');
  sel.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = 'Custom / not set';
  sel.appendChild(custom);
  window.LED_PROCESSOR_BRANDS().forEach((brand) => {
    const grp = document.createElement('optgroup');
    grp.label = brand;
    window.LED_PROCESSORS.filter((p) => p.brand === brand).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.model} — ${p.ports} × ${(p.pxPerPort / 1000).toFixed(0)}k`;
      grp.appendChild(o);
    });
    sel.appendChild(grp);
  });
}

function updateProcessorInfo() {
  const proc = selectedProcessor();
  const el = $('#processorInfo');
  if (!proc) {
    el.textContent = 'Pick your processor to load its real per-port budget, or set the value by hand.';
    return;
  }
  el.textContent = `${proc.ports} × ${proc.portType} · ${(proc.pxPerPort / 1000).toFixed(0)}k px per port · `
    + `${(proc.totalPx / 1e6).toFixed(2)}M total${proc.note ? ' · ' + proc.note : ''}`;
}

// Walk order for auto-routing: serpentine reverses alternate lines (S-route),
// straight keeps every line in the same direction (Z-route, longer jumpers).
function routeOrder(cols, rows, pattern, axis, corner) {
  const cs = [...Array(cols).keys()];
  const rs = [...Array(rows).keys()];
  const colOrder = corner.includes('r') ? cs.slice().reverse() : cs;
  const rowOrder = corner.startsWith('b') ? rs.slice().reverse() : rs;
  const order = [];
  if (axis === 'v') {
    colOrder.forEach((c, i) => {
      const line = (pattern === 'serp' && i % 2) ? rowOrder.slice().reverse() : rowOrder;
      line.forEach((r) => order.push([c, r]));
    });
  } else {
    rowOrder.forEach((r, i) => {
      const line = (pattern === 'serp' && i % 2) ? colOrder.slice().reverse() : colOrder;
      line.forEach((c) => order.push([c, r]));
    });
  }
  return order;
}

function suggestedPerRun() {
  const w = curWall();
  const g = window.LED_WALL_GRID(w);
  const layer = curLayer();
  const probe = { id: 'x', path: [[0, 0]] };
  const one = window.LED_RUN_LOAD(w, w.cabling, layer, probe);
  const per = one.used > 0 ? Math.floor(one.limit / one.used) : g.cols * g.rows;
  return Math.max(1, Math.min(per, g.cols * g.rows));
}

function applyAutoRoute() {
  const w = curWall();
  const g = window.LED_WALL_GRID(w);
  const perRun = Math.max(1, $('#arPerRun').value | 0);
  const order = routeOrder(g.cols, g.rows, $('#arPattern').value, $('#arAxis').value, $('#arCorner').value);
  const prefix = layerCfg().prefix || (curLayer() === 'signal' ? 'Port' : 'Circuit');
  const list = [];
  for (let i = 0; i < order.length; i += perRun) {
    const idx = list.length;
    list.push({
      id: newRunId(),
      name: `${prefix} ${idx + 1}`,
      color: window.LED_RUN_COLORS[idx % window.LED_RUN_COLORS.length],
      entry: '',
      path: order.slice(i, i + perRun),
    });
  }
  layerCfg().runs = list;
  activeRunId = list.length ? list[0].id : null;
  $('#autoRoutePanel').style.display = 'none';
  push();
  renderRunList();
  drawCablingEditor();
}

function syncCablingLimits() {
  const layer = curLayer();
  const L = layerCfg();
  $('#signalLimits').style.display = layer === 'signal' ? '' : 'none';
  $('#powerLimits').style.display = layer === 'power' ? '' : 'none';
  $('#powerLimits2').style.display = layer === 'power' ? '' : 'none';
  if (layer === 'signal') {
    $('#processorSel').value = L.processorId || '';
    if ($('#processorSel').selectedIndex === -1) $('#processorSel').value = '';
    updateProcessorInfo();
    $('#maxPixels').value = L.maxPixelsPerPort;
    $('#signalPrefix').value = L.prefix || 'Port';
  } else {
    $('#wattsPerPanel').value = L.wattsPerPanel;
    $('#volts').value = L.volts;
    $('#ampsPerCircuit').value = L.ampsPerCircuit;
    $('#derate').value = L.derate;
  }
  document.querySelectorAll('#cablingCard .tabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.layer === layer);
  });
}

function setView(view) {
  cablingView = view === 'cabling';
  $('#previewBox').style.display = cablingView ? 'none' : '';
  $('#cablingBox').style.display = cablingView ? '' : 'none';
  $('#cablingCard').style.display = cablingView ? '' : 'none';
  document.querySelectorAll('.card-head .tabs .tab[data-view]').forEach((t) => {
    t.classList.toggle('active', (t.dataset.view === 'cabling') === cablingView);
  });
  if (cablingView) {
    if (!activeRunId && runs().length) activeRunId = runs()[0].id;
    syncCablingLimits();
    renderRunList();
    drawCablingEditor();
  } else {
    startPreview();
  }
}

function exportCablingPNG() {
  const w = curWall();
  resolveWall(w);
  const g = window.LED_WALL_GRID(w);
  const unit = Math.min(g.colWidths[0] || 100, g.rowHeights[0] || 100);
  const pad = Math.max(24, Math.round(unit * 0.8));
  const title = Math.round(unit * 0.5);
  const c = document.createElement('canvas');
  c.width = w.width + pad * 2;
  c.height = w.height + pad * 2 + title;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e6e8ec';
  ctx.font = `bold ${Math.round(title * 0.6)}px Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const proc = curLayer() === 'signal' ? selectedProcessor() : null;
  const src = proc ? ` · ${proc.brand} ${proc.model}`
    : (curLayer() === 'power' ? ` · ${w.cabling.power.volts}V ${w.cabling.power.ampsPerCircuit}A` : '');
  ctx.fillText(`${w.name} — ${curLayer() === 'signal' ? 'SIGNAL' : 'POWER'} — ${w.width}×${w.height}px · ${g.cols}×${g.rows} panels${src}`,
    pad, title * 0.62);
  ctx.save();
  ctx.translate(0, title);
  paintCablingDiagram(ctx, w, curLayer(), pad, { assigned: assignmentMap() });
  ctx.restore();
  const a = document.createElement('a');
  const safe = (w.name || 'wall').replace(/[^\w-]+/g, '_');
  a.download = `lattice-${safe}-${curLayer()}-cabling.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

function wireCabling() {
  document.querySelectorAll('.card-head .tabs .tab[data-view]').forEach((t) => {
    t.addEventListener('click', () => setView(t.dataset.view));
  });
  document.querySelectorAll('#cablingCard .tabs .tab[data-layer]').forEach((t) => {
    t.addEventListener('click', () => {
      cfg.cablingLayer = t.dataset.layer;
      activeRunId = runs().length ? runs()[0].id : null;
      syncCablingLimits();
      renderRunList();
      drawCablingEditor();
      push();
    });
  });

  $('#addRunBtn').addEventListener('click', () => {
    addRun();
    push();
    renderRunList();
    drawCablingEditor();
  });
  $('#clearRunBtn').addEventListener('click', () => {
    const run = activeRun();
    if (!run) return;
    run.path = [];
    push();
    renderRunList();
    drawCablingEditor();
  });
  $('#autoRouteBtn').addEventListener('click', () => {
    const panel = $('#autoRoutePanel');
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : '';
    if (!showing) {
      const s = suggestedPerRun();
      $('#arPerRun').value = s;
      const g = window.LED_WALL_GRID(curWall());
      const needed = Math.ceil((g.cols * g.rows) / s);
      const unit = curLayer() === 'signal' ? 'port' : 'circuit';
      let txt = `limit allows ~${s} panels per ${unit} → ${needed} ${unit}${needed === 1 ? '' : 's'} for this wall`;
      const proc = curLayer() === 'signal' ? selectedProcessor() : null;
      if (proc) txt += needed > proc.ports ? ` — ${proc.model} has only ${proc.ports}` : ` (${proc.model} has ${proc.ports})`;
      $('#arSuggest').textContent = txt;
    }
  });
  $('#arCancel').addEventListener('click', () => { $('#autoRoutePanel').style.display = 'none'; });
  $('#arApply').addEventListener('click', applyAutoRoute);
  $('#exportCablingBtn').addEventListener('click', exportCablingPNG);

  const limitBind = (sel, key, parse) => {
    $(sel).addEventListener('change', () => {
      const el = $(sel);
      layerCfg()[key] = parse(el.value);
      el.value = layerCfg()[key];
      push();
      renderRunList();
    });
  };
  limitBind('#maxPixels', 'maxPixelsPerPort', (v) => Math.max(1000, v | 0));

  buildProcessorSelect();
  $('#processorSel').addEventListener('change', () => {
    const id = $('#processorSel').value;
    const L = curWall().cabling.signal;
    L.processorId = id;
    const proc = window.LED_PROCESSOR_BY_ID(id);
    if (proc) {
      // selecting a processor loads its budget; the field stays editable for
      // bit-depth / frame-rate cases the headline number doesn't cover
      L.maxPixelsPerPort = proc.pxPerPort;
      $('#maxPixels').value = proc.pxPerPort;
      if (!L.prefix || L.prefix === 'Port') L.prefix = 'Port';
    }
    updateProcessorInfo();
    push();
    renderRunList();
  });
  limitBind('#wattsPerPanel', 'wattsPerPanel', (v) => Math.max(1, v | 0));
  limitBind('#volts', 'volts', (v) => Math.max(90, v | 0));
  limitBind('#ampsPerCircuit', 'ampsPerCircuit', (v) => Math.max(1, v | 0));
  limitBind('#derate', 'derate', (v) => Math.min(1, Math.max(0.1, parseFloat(v) || 0.8)));
  $('#signalPrefix').addEventListener('input', () => { layerCfg().prefix = $('#signalPrefix').value; });

  wireCablingCanvas();
}

// ---------- show files ----------

// re-sync every content/readout input from cfg (after loading a show)
function syncContentUI() {
  $('#fg').value = cfg.pattern.fg;
  $('#bg').value = cfg.pattern.bg;
  $('#size').value = cfg.pattern.size;
  $('#sizeVal').textContent = `${cfg.pattern.size}px`;
  $('#speed').value = cfg.pattern.speed;
  $('#speedVal').textContent = `${cfg.pattern.speed}×`;
  $('#gradMode').value = cfg.pattern.gradMode;
  $('#dir').value = cfg.pattern.dir || 'h';
  $('#ovColor').value = cfg.overlay.color;
  $('#ovOpacity').value = cfg.overlay.opacity;
  $('#ovOpacityVal').textContent = `${cfg.overlay.opacity}%`;
  $('#ovSpeed').value = cfg.overlay.speed;
  $('#ovSpeedVal').textContent = `${cfg.overlay.speed}×`;
  $('#ovDir').value = cfg.overlay.dir;
  $('#roLabel').checked = cfg.readout.label !== false;
  $('#roDims').checked = !!cfg.readout.dims;
  $('#roScrim').checked = cfg.readout.scrim !== false;
  $('#roFont').value = cfg.readout.font || 'mono';
  $('#roImageClear').style.display = cfg.readout.image ? '' : 'none';
}

function flashButton(id, text) {
  const btn = $(id);
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1600);
}

async function saveShowFile() {
  resolveWalls();
  const payload = JSON.stringify({
    latticeShow: 1,
    savedAt: new Date().toISOString(),
    cfg, // includes the logo data URL — show files are self-contained
  }, null, 2);
  const res = await window.ledwall.saveShow(payload);
  if (res.ok) flashButton('#saveShowBtn', 'Saved ✓');
  else if (!res.canceled) alert('Could not save show: ' + res.error);
}

async function loadShowFile() {
  const res = await window.ledwall.loadShow();
  if (!res.ok) {
    if (!res.canceled) alert('Could not load show: ' + res.error);
    return;
  }
  try {
    const data = JSON.parse(res.json);
    const savedCfg = data.cfg || data;
    if (!savedCfg.walls && !savedCfg.wall) throw new Error('not a Lattice show file');
    cfg = normalizeConfig(savedCfg);
    if (cfg.readout.image && typeof cfg.readout.image === 'string') window.ledwall.saveLogo(cfg.readout.image);
    else { cfg.readout.image = null; window.ledwall.saveLogo(null); }
    syncWallInputs();
    syncPatternUI();
    syncOverlayUI();
    syncContentUI();
    activeRunId = null;
    if (cablingView) { syncCablingLimits(); renderRunList(); }
    push();
    renderDisplays();
    flashButton('#loadShowBtn', 'Loaded ✓');
  } catch (err) {
    alert('Could not load show: ' + err.message);
  }
}

// ---------- export ----------

function exportWallPNG() {
  const w = curWall();
  resolveWall(w);
  const c = document.createElement('canvas');
  c.width = w.width;
  c.height = w.height;
  window.LED_RENDER_FRAME(c.getContext('2d'), { wall: w, pattern: cfg.pattern, overlay: cfg.overlay, readout: cfg.readout }, performance.now());
  const a = document.createElement('a');
  const safeName = (w.name || 'wall').replace(/[^\w-]+/g, '_');
  a.download = `lattice-${safeName}-${cfg.pattern.type}-${w.width}x${w.height}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
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
  let btn = el.querySelector('button.install');
  if (withRestart && !btn) {
    btn = document.createElement('button');
    btn.className = 'btn primary install';
    btn.textContent = 'Restart & Update';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Updating…';
      // A failed install used to be swallowed here, so the button looked dead.
      // Surface the reason and offer the manual download instead.
      let res;
      try {
        res = await window.ledwall.installUpdate();
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      if (res && res.ok) return; // app is quitting to relaunch
      btn.disabled = false;
      btn.textContent = 'Try Again';
      el.classList.add('failed');
      el.querySelector('.msg').textContent = (res && res.error) || 'Update failed.';
      if (!el.querySelector('button.manual')) {
        const dl = document.createElement('button');
        dl.className = 'btn manual';
        dl.textContent = 'Download Manually';
        dl.addEventListener('click', () => window.ledwall.openReleases());
        el.appendChild(dl);
      }
    });
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

// ---------- wall setup input wiring (all bound to the SELECTED wall) ----------

function syncWallModeUI() {
  const w = curWall();
  $('#uniformRows').style.display = w.mode === 'manual' ? 'none' : '';
  $('#manualRows').style.display = w.mode === 'manual' ? '' : 'none';
  $('#mmRows').style.display = w.defineBy === 'mm' ? '' : 'none';
  $('#pxRows').style.display = w.defineBy === 'px' ? '' : 'none';
}

// refresh every wall-setup input from the selected wall (after selection change)
function syncWallInputs() {
  const w = curWall();
  $('#wallName').value = w.name;
  $('#wallMode').value = w.mode;
  $('#defineBy').value = w.defineBy;
  $('#mmW').value = w.mmW;
  $('#mmH').value = w.mmH;
  $('#pitch').value = w.pitch;
  $('#panelW').value = w.panelW;
  $('#panelH').value = w.panelH;
  $('#panelsX').value = w.panelsX;
  $('#panelsY').value = w.panelsY;
  $('#colWidths').value = w.colWidths.join(', ');
  $('#rowHeights').value = w.rowHeights.join(', ');
  $('#customRes').checked = w.custom;
  $('#customResRow').style.display = w.custom ? '' : 'none';
  $('#wallW').value = w.width;
  $('#wallH').value = w.height;
  syncWallModeUI();
  rebuildWallOutputSelect();
}

function bindWallNumber(sel, key) {
  const el = $(sel);
  el.addEventListener('change', () => {
    const w = curWall();
    w[key] = Math.max(parseInt(el.min, 10) || 1, el.value | 0);
    el.value = w[key];
    push();
  });
}

function wireInputs() {
  $('#wallName').addEventListener('input', () => {
    curWall().name = $('#wallName').value.trim() || curWall().name;
    push();
    renderDisplays(); // wall dropdowns show names
  });

  bindWallNumber('#panelW', 'panelW');
  bindWallNumber('#panelH', 'panelH');
  bindWallNumber('#panelsX', 'panelsX');
  bindWallNumber('#panelsY', 'panelsY');
  bindWallNumber('#wallW', 'width');
  bindWallNumber('#wallH', 'height');
  bindWallNumber('#mmW', 'mmW');
  bindWallNumber('#mmH', 'mmH');

  $('#wallMode').addEventListener('change', () => {
    curWall().mode = $('#wallMode').value;
    syncWallModeUI();
    push();
  });

  $('#defineBy').addEventListener('change', () => {
    curWall().defineBy = $('#defineBy').value;
    syncWallModeUI();
    push();
  });

  const pitch = $('#pitch');
  pitch.addEventListener('change', () => {
    const w = curWall();
    w.pitch = Math.min(50, Math.max(0.4, parseFloat(pitch.value) || 2.9));
    pitch.value = w.pitch;
    push();
  });

  document.querySelectorAll('.preset-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const w = curWall();
      if (chip.dataset.pitch) {
        w.pitch = parseFloat(chip.dataset.pitch);
        $('#pitch').value = w.pitch;
      } else if (chip.dataset.mmw) {
        w.mmW = chip.dataset.mmw | 0;
        w.mmH = chip.dataset.mmh | 0;
        $('#mmW').value = w.mmW;
        $('#mmH').value = w.mmH;
      } else {
        w.panelW = chip.dataset.pw | 0;
        w.panelH = chip.dataset.ph | 0;
        $('#panelW').value = w.panelW;
        $('#panelH').value = w.panelH;
      }
      push();
    });
  });

  for (const [id, key] of [['#colWidths', 'colWidths'], ['#rowHeights', 'rowHeights']]) {
    const el = $(id);
    el.addEventListener('change', () => {
      const w = curWall();
      w[key] = parsePxList(el.value, WALL_DEFAULTS[key]);
      el.value = w[key].join(', ');
      push();
    });
  }

  const customRes = $('#customRes');
  customRes.addEventListener('change', () => {
    const w = curWall();
    w.custom = customRes.checked;
    $('#customResRow').style.display = w.custom ? '' : 'none';
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

  // center readout toggles
  const roLabel = $('#roLabel');
  roLabel.checked = cfg.readout.label !== false;
  roLabel.addEventListener('change', () => { cfg.readout.label = roLabel.checked; push(); });

  const roDims = $('#roDims');
  roDims.checked = !!cfg.readout.dims;
  roDims.addEventListener('change', () => { cfg.readout.dims = roDims.checked; push(); });

  const roScrim = $('#roScrim');
  roScrim.checked = cfg.readout.scrim !== false;
  roScrim.addEventListener('change', () => { cfg.readout.scrim = roScrim.checked; push(); });

  const roFont = $('#roFont');
  roFont.value = cfg.readout.font || 'mono';
  roFont.addEventListener('change', () => { cfg.readout.font = roFont.value; push(); });

  const roImage = $('#roImage');
  const roImageClear = $('#roImageClear');
  roImageClear.style.display = cfg.readout.image ? '' : 'none';
  roImage.addEventListener('change', () => {
    const file = roImage.files && roImage.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      alert('Logo file is too large — keep it under 4 MB.');
      roImage.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      cfg.readout.image = reader.result;
      window.ledwall.saveLogo(reader.result); // persisted on disk, not localStorage
      roImageClear.style.display = '';
      push();
    };
    reader.readAsDataURL(file);
  });
  roImageClear.addEventListener('click', () => {
    cfg.readout.image = null;
    window.ledwall.saveLogo(null);
    roImage.value = '';
    roImageClear.style.display = 'none';
    push();
  });

  $('#identifyBtn').addEventListener('click', () => window.ledwall.identify());
  $('#stopAllBtn').addEventListener('click', () => window.ledwall.stopAll());
  $('#exportBtn').addEventListener('click', exportWallPNG);
  $('#addVirtualBtn').addEventListener('click', addVirtualOutput);
  $('#addWallBtn').addEventListener('click', addWall);
  $('#saveShowBtn').addEventListener('click', saveShowFile);
  $('#loadShowBtn').addEventListener('click', loadShowFile);
  wireWallOutputSelect();
  wireCabling();
}

// ---------- init ----------

async function init() {
  $('#version').textContent = 'v' + (await window.ledwall.getVersion());

  // logo lives on disk; older configs stored the data URL in localStorage —
  // migrate it over once, then only a boolean marker remains in the config
  const diskLogo = await window.ledwall.loadLogo();
  if (diskLogo) cfg.readout.image = diskLogo;
  else if (cfg.readout.image && typeof cfg.readout.image === 'string') window.ledwall.saveLogo(cfg.readout.image);
  else cfg.readout.image = null;
  $('#roImageClear').style.display = cfg.readout.image ? '' : 'none';

  buildPatternButtons();
  buildOverlayButtons();
  wireInputs();
  wireUpdates();
  syncWallInputs();
  syncPatternUI();
  syncOverlayUI();

  displays = await window.ledwall.getDisplays();
  renderDisplays();
  window.ledwall.onDisplaysChanged((list) => { displays = list; renderDisplays(); });
  window.ledwall.onActiveOutputs((list) => { activeSet = new Set(list); renderDisplays(); });
  window.ledwall.onNudgeOutput(({ id, dx, dy }) => {
    const oc = outCfgFor(id);
    oc.posX = (oc.posX | 0) + dx;
    oc.posY = (oc.posY | 0) + dy;
    push();
    // update visible pos inputs in place (full re-render would steal focus)
    document.querySelectorAll(`input.pos[data-outid="${id}"]`).forEach((inp) => {
      if (inp.dataset.poskey) inp.value = oc[inp.dataset.poskey];
    });
  });
  window.LED_ON_IMAGE_READY(() => startPreview()); // re-render once the logo decodes

  window.addEventListener('resize', () => startPreview());

  push(); // send initial config to main so outputs can pick it up
}

init();

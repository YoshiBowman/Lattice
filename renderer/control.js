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
  color: '#3fa9f5', // identity colour, used when wall colours are set to Per wall
  // a wall carried by more than one output: one processor feed per segment
  split: { cols: 1, rows: 1, overlap: 0, colPanels: [], rowPanels: [] },
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
function freshWall(id, name, over, index) {
  const palette = (window.LED_WALL_COLORS || ['#3fa9f5']);
  return {
    ...WALL_DEFAULTS,
    color: palette[(index || 0) % palette.length],
    colWidths: WALL_DEFAULTS.colWidths.slice(),
    rowHeights: WALL_DEFAULTS.rowHeights.slice(),
    split: { ...WALL_DEFAULTS.split, colPanels: [], rowPanels: [] },
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
  wallColorMode: 'same', // 'same' | 'perWall'
  pattern: {
    type: 'grid', fg: '#ffffff', bg: '#000000', size: 16, speed: 2, gradMode: 'gray-h', dir: 'h',
    panelA: '#101010', panelB: '#303030', // Panel Map's two alternating colours
  },
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
      const merged = { ...freshWall('w' + (i + 1), `Wall ${i + 1}`, null, i), ...w };
      // walls saved before identity colours existed get one from the palette
      if (!merged.color) merged.color = freshWall('x', 'x', null, i).color;
      merged.split = { cols: 1, rows: 1, overlap: 0, colPanels: [], rowPanels: [], ...(w.split || {}) };
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
    wallColorMode: saved.wallColorMode === 'perWall' ? 'perWall' : 'same',
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

    if (cfg.wallColorMode === 'perWall') {
      const sw = document.createElement('div');
      sw.className = 'wswatch';
      sw.style.background = w.color || '#3fa9f5';
      row.appendChild(sw);
    }

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
  const w = freshWall(newWallId(), `Wall ${cfg.walls.length + 1}`, null, cfg.walls.length);
  cfg.walls.push(w);
  cfg.selectedWall = w.id;
  syncWallInputs();
  push();
  renderDisplays();
}

// Open a wall in a virtual output window at native wall resolution, 1:1
// Opens a wall — or one segment of it — in a virtual output window. A segment
// window is sized to that feed and pinned to 1:1, since it stands in for a
// processor feed rather than a view of the whole wall.
function previewWallInWindow(w, segment, seg) {
  resolveWalls();
  let id;
  do { id = 'v' + Date.now().toString(36) + (vSeq++); } while (cfg.virtualOutputs.some((x) => x.id === id));
  const width = seg ? seg.w : w.width;
  const height = seg ? seg.h : w.height;
  const label = seg ? `${w.name} — segment ${segment + 1}` : w.name;
  cfg.virtualOutputs.push({ id, width, height });
  const oc = outCfgFor(id);
  oc.wallId = w.id;
  oc.assigned = true;
  oc.segment = segment | 0;
  oc.mode = seg ? '1to1' : 'fit'; // whole wall: fit; one feed: true pixels
  oc.label = label;
  push();
  renderDisplays();
  window.ledwall.startOutput(id, { width, height, label });
}

// ---------- wall split across outputs ----------

function syncSplitUI() {
  const w = curWall();
  resolveWall(w);
  const s = w.split;
  const g = window.LED_WALL_GRID(w);
  const key = `${s.cols}x${s.rows}`;
  const sel = $('#splitPreset');
  const known = [...sel.options].some((o) => o.value === key);
  sel.value = known ? key : 'custom';
  $('#splitCustomRow').style.display = sel.value === 'custom' ? '' : 'none';
  $('#splitCols').value = s.cols;
  $('#splitRows').value = s.rows;
  $('#splitOverlap').value = s.overlap;

  const split = window.LED_WALL_IS_SPLIT(w);
  // panel spans only mean something along an axis that is actually divided
  $('#splitColPanelsRow').style.display = s.cols > 1 ? '' : 'none';
  $('#splitRowPanelsRow').style.display = s.rows > 1 ? '' : 'none';
  $('#splitOverlapRow').style.display = split ? '' : 'none';
  renderSpanBoxes('col', s.cols, g.cols);
  renderSpanBoxes('row', s.rows, g.rows);

  updateSplitSummary();
  renderSegmentOutputs();
}

// One numeric box per segment rather than a comma-separated list. Boxes are
// only rebuilt when the segment count changes — rebuilding on every keystroke
// would steal focus mid-edit.
function renderSpanBoxes(axis, count, total) {
  const key = axis === 'col' ? 'colPanels' : 'rowPanels';
  const box = $(`#split${axis === 'col' ? 'Col' : 'Row'}PanelsBoxes`);
  if (!box) return;
  const w = curWall();
  // a split may arrive without span arrays at all — from a show saved before
  // panel-sized segments existed, or set directly — so never assume them
  const current = Array.isArray(w.split[key]) ? w.split[key] : [];
  const values = window.LED_SPLIT_SPANS(current, count, total);
  // commit the seeded split so what the boxes show is what the wall holds —
  // otherwise state and UI disagree until the first manual edit
  if (current.join(',') !== values.join(',')) w.split[key] = values.slice();

  if (box.children.length !== count) {
    box.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const lab = document.createElement('label');
      lab.className = 'span-box';
      const cap = document.createElement('span');
      cap.textContent = `Seg ${i + 1}`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '1';
      inp.max = String(total);
      inp.dataset.idx = String(i);
      inp.addEventListener('input', () => applySpanBoxes(axis, count, total));
      lab.append(cap, inp);
      box.appendChild(lab);
    }
  }
  // refresh values without disturbing whichever box is being typed in
  [...box.querySelectorAll('input')].forEach((inp, i) => {
    if (document.activeElement !== inp) inp.value = values[i];
  });
  validateSpanBoxes(axis, total);
}

function spanBoxValues(axis) {
  const box = $(`#split${axis === 'col' ? 'Col' : 'Row'}PanelsBoxes`);
  return [...box.querySelectorAll('input')].map((inp) => parseInt(inp.value, 10));
}

function validateSpanBoxes(axis, total) {
  const box = $(`#split${axis === 'col' ? 'Col' : 'Row'}PanelsBoxes`);
  const msg = $(`#split${axis === 'col' ? 'Col' : 'Row'}PanelsMsg`);
  const vals = spanBoxValues(axis);
  const inputs = [...box.querySelectorAll('input')];
  const sum = vals.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const anyBad = vals.some((v) => !Number.isFinite(v) || v < 1);
  const ok = !anyBad && sum === total;

  inputs.forEach((inp, i) => {
    const bad = !Number.isFinite(vals[i]) || vals[i] < 1;
    inp.classList.toggle('invalid', bad || (!ok && !anyBad));
  });
  msg.classList.toggle('invalid', !ok);
  if (ok) {
    msg.textContent = `${sum} of ${total} panels ✓`;
  } else if (anyBad) {
    msg.textContent = `every segment needs at least 1 panel`;
  } else {
    const diff = sum - total;
    msg.textContent = `${sum} of ${total} panels — ${Math.abs(diff)} too ${diff > 0 ? 'many' : 'few'}`;
  }
  return ok;
}

// Only a valid set is committed to the wall: an in-progress edit that doesn't
// add up must not make the preview jump to some other layout.
function applySpanBoxes(axis, count, total) {
  const key = axis === 'col' ? 'colPanels' : 'rowPanels';
  if (!validateSpanBoxes(axis, total)) return;
  const w = curWall();
  w.split[key] = spanBoxValues(axis);
  updateSplitSummary();
  renderSegmentOutputs();
  push();
  renderDisplays();
}

function updateSplitSummary() {
  const w = curWall();
  resolveWall(w);
  const el = $('#splitSummary');
  const g = window.LED_WALL_GRID(w);
  if (!window.LED_WALL_IS_SPLIT(w)) {
    el.textContent = `The whole wall — ${g.cols} × ${g.rows} panels — goes to one output.`;
    el.style.color = '';
    return;
  }
  // Segments are panel-aligned by construction, so the only thing worth
  // reporting is what each feed actually carries.
  const segs = window.LED_WALL_SEGMENTS(w);
  const parts = segs.map((sg, i) => `${i + 1}: ${sg.panelsX}×${sg.panelsY} panels (${sg.w}×${sg.h} px)`);
  el.textContent = parts.join('   ') + (w.split.overlap > 0 ? `   · sharing ${w.split.overlap} px` : '');
  el.style.color = 'var(--accent)';
}

function setSplit(cols, rows) {
  const w = curWall();
  const g = window.LED_WALL_GRID(w);
  w.split.cols = Math.max(1, Math.min(g.cols, cols | 0));
  w.split.rows = Math.max(1, Math.min(g.rows, rows | 0));
  // re-derive spans for the new shape rather than carrying stale ones over
  w.split.colPanels = window.LED_SPLIT_SPANS([], w.split.cols, g.cols);
  w.split.rowPanels = window.LED_SPLIT_SPANS([], w.split.rows, g.rows);
  if (!window.LED_WALL_IS_SPLIT(w)) w.split.overlap = 0;
  syncSplitUI();
  push();
  renderDisplays();
}

function wireSplit() {
  $('#splitPreset').addEventListener('change', () => {
    const v = $('#splitPreset').value;
    if (v === 'custom') { $('#splitCustomRow').style.display = ''; return; }
    const [c, r] = v.split('x').map(Number);
    setSplit(c, r);
  });
  $('#splitCols').addEventListener('change', () => setSplit($('#splitCols').value, curWall().split.rows));
  $('#splitRows').addEventListener('change', () => setSplit(curWall().split.cols, $('#splitRows').value));

  // span boxes wire themselves as they are built (renderSpanBoxes)

  $('#splitOverlap').addEventListener('change', () => {
    const w = curWall();
    w.split.overlap = Math.max(0, Math.min(4096, $('#splitOverlap').value | 0));
    $('#splitOverlap').value = w.split.overlap;
    syncSplitUI();
    push();
    renderDisplays();
  });
}

// Next segment of this wall that no other output has claimed, so assigning a
// second output to a split wall lands on the other half rather than duplicating.
function nextFreeSegment(wallId, exceptId) {
  const w = cfg.walls.find((x) => x.id === wallId);
  if (!w || !window.LED_WALL_IS_SPLIT(w)) return 0;
  const total = window.LED_WALL_SEGMENTS(w).length;
  const taken = new Set();
  Object.keys(cfg.outputs).forEach((k) => {
    if (String(k) === String(exceptId)) return;
    const o = cfg.outputs[k];
    if (o.wallId === wallId) taken.add(o.segment | 0);
  });
  for (let i = 0; i < total; i++) if (!taken.has(i)) return i;
  return 0;
}

// ---------- wall -> output assignment dropdown ----------

// One dropdown per segment. An unsplit wall has exactly one, labelled
// 'Send to output'; a wall split across N feeds gets N, so the operator picks
// where each piece goes without touching the Outputs panel.
function renderSegmentOutputs() {
  const box = $('#segmentOutputs');
  if (!box) return;
  const w = curWall();
  resolveWall(w);
  const segs = window.LED_WALL_SEGMENTS(w);
  const isLive = (k) => activeSet.has(String(k)) || deckLinkActive.has(String(k));
  box.innerHTML = '';

  segs.forEach((sg, i) => {
    const lab = document.createElement('label');
    lab.textContent = segs.length === 1
      ? 'Send to output'
      : `Segment ${i + 1} → output   (${sg.panelsX}×${sg.panelsY} panels)`;

    const sel = document.createElement('select');
    sel.dataset.segment = String(i);
    const add = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    };
    add('', '— choose output —');
    displays.forEach((d) => add('d:' + d.id, `Display ${d.index}: ${d.label}`));
    // SDI sits in the same list as everything else: sending a wall to a
    // DeckLink port should be the same gesture as sending it to a display.
    (deckLinkInfo.devices || []).forEach((dev) => {
      const id = dlOutputId(dev);
      const oc = cfg.outputs[id];
      add('s:' + id, `SDI: ${(oc && oc.label) || dev.name}`);
    });
    cfg.virtualOutputs.forEach((v, n) => {
      const oc = cfg.outputs[v.id];
      add('v:' + v.id, `V${n + 1}: ${(oc && oc.label) || `${v.width}×${v.height}`}`);
    });
    add('new', '+ New virtual window (segment size)');

    // whichever output currently carries THIS segment of THIS wall
    const owner = Object.keys(cfg.outputs)
      .filter((k) => cfg.outputs[k].wallId === w.id && (cfg.outputs[k].segment | 0) === i && cfg.outputs[k].assigned)
      .sort((a, b) => (isLive(b) ? 1 : 0) - (isLive(a) ? 1 : 0))[0];
    if (owner !== undefined) {
      const prefix = String(owner).startsWith('dl:') ? 's:'
        : cfg.virtualOutputs.some((v) => String(v.id) === String(owner)) ? 'v:' : 'd:';
      sel.value = prefix + owner;
      if (sel.selectedIndex === -1) sel.value = ''; // stale id (display unplugged)
    }

    sel.addEventListener('change', () => assignSegmentOutput(sel.value, i, sg));
    lab.appendChild(sel);
    box.appendChild(lab);
  });
}

// Kept as the name the rest of the file calls after displays/outputs change.
function rebuildWallOutputSelect() { renderSegmentOutputs(); }

// Assigning an output to a segment: same gesture whatever the output type.
// The output is bound to this wall AND this segment, then started, so the
// operator never has to open the Outputs panel to map a feed.
function assignSegmentOutput(val, segment, seg) {
  if (!val) return;
  const w = curWall();

  if (val === 'new') {
    // a window sized to the SEGMENT, since that is the feed being simulated
    previewWallInWindow(w, segment, seg);
    renderDisplays();
    syncSplitUI();
    return;
  }

  const kind = val.slice(0, 1);
  const idRaw = val.slice(2);
  const id = kind === 'd' ? Number(idRaw) : idRaw;

  if (kind === 's') {
    const dev = (deckLinkInfo.devices || []).find((x) => dlOutputId(x) === id);
    if (!dev) return;
    const oc = dlCfgFor(dev);           // seeds dlMode/dlRange and 1:1 defaults
    oc.wallId = w.id;
    oc.assigned = true;
    oc.segment = segment;
    push();
    renderDisplays();
    renderDeckLink();
    syncSplitUI();
    if (!deckLinkActive.has(id)) startDeckLinkOutputFor(dev, oc);
    return;
  }

  const oc = outCfgFor(id);
  oc.wallId = w.id;
  oc.assigned = true;
  oc.segment = segment;
  push();
  renderDisplays();
  syncSplitUI();
  if (!activeSet.has(String(id))) {
    if (kind === 'd') {
      window.ledwall.startOutput(id);
    } else {
      const v = cfg.virtualOutputs.find((x) => String(x.id) === String(id));
      if (v) window.ledwall.startOutput(v.id, { width: v.width, height: v.height, label: oc.label });
    }
  }
}

function wireWallOutputSelect() { /* dropdowns wire themselves as they are built */ }

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
  syncWallColorBinding();
}

// In per-wall mode the wall's colour replaces one of the pattern's colours.
// Rather than leave that picker looking editable while being overridden, the
// picker BECOMES the wall-colour control: same place, still works, and it says
// which wall it is editing.
function wallColorTarget() {
  if (cfg.wallColorMode !== 'perWall') return null;
  return window.LED_WALL_COLOR_PARAM(cfg.pattern.type);
}

function syncWallColorBinding() {
  const target = wallColorTarget();
  const w = curWall();
  ['fg', 'bg', 'panelA', 'panelB'].forEach((id) => {
    const input = $('#' + id);
    const label = input.closest('label');
    if (!label.dataset.baseLabel) label.dataset.baseLabel = label.childNodes[0].textContent;
    const driven = id === target;
    label.childNodes[0].textContent = driven ? `${w.name} colour` : label.dataset.baseLabel;
    label.classList.toggle('wall-driven', driven);
    input.value = driven ? (w.color || '#3fa9f5') : cfg.pattern[id];
  });
  const note = $('#wallColorNote');
  if (note) {
    note.style.display = cfg.wallColorMode === 'perWall' ? '' : 'none';
    note.textContent = window.LED_WALL_COLOR_PARAM(cfg.pattern.type)
      ? `Colours are per wall — this picker sets ${w.name}. Select another wall to set its colour.`
      : 'This pattern is colour-critical, so it is never tinted per wall.';
  }
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
      // exact panel sizes: scaling rounded preview dimensions back up reports
      // 171 or 174 for a wall whose panels are all really 172
      origColWidths: g.colWidths.slice(),
      origRowHeights: g.rowHeights.slice(),
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
  previewCfg.pattern = window.LED_WALL_PATTERN(previewCfg.pattern, w, cfg.wallColorMode);
  previewCfg.readout = cfg.readout;
  previewCfg.cablingLayer = cfg.cablingLayer;
}

function drawPreviewFrame(t) {
  if (!previewCfg) rebuildPreviewCfg();
  if (preview.width !== previewCfg.wall.width) preview.width = previewCfg.wall.width;
  if (preview.height !== previewCfg.wall.height) preview.height = previewCfg.wall.height;
  renderPreviewFrame(previewCtx, previewCfg, t);
  drawSegmentGuides();
}

// Preview-only: shows where the feeds divide the wall. Deliberately not part of
// the rendered frame — this is a planning aid, not something to send to a wall.
function drawSegmentGuides() {
  const w = curWall();
  if (!window.LED_WALL_IS_SPLIT(w)) return;
  const scale = preview.width / w.width;
  const segs = window.LED_WALL_SEGMENTS(w);
  const ctx = previewCtx;
  ctx.save();
  segs.forEach((sg, i) => {
    const x = sg.x * scale, y = sg.y * scale;
    const sw = sg.w * scale, sh = sg.h * scale;
    ctx.strokeStyle = w.split.overlap > 0 ? 'rgba(245,166,35,0.95)' : 'rgba(63,169,245,0.95)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, sw - 2, sh - 2);
    ctx.setLineDash([]);
    const fs = Math.max(10, Math.min(18, sh * 0.16));
    const tag = String(i + 1);
    ctx.font = `bold ${fs}px Menlo, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x + 4, y + 4, fs * 1.5, fs * 1.4);
    ctx.fillStyle = w.split.overlap > 0 ? '#f5a623' : '#3fa9f5';
    ctx.textAlign = 'center';
    ctx.fillText(tag, x + 4 + fs * 0.75, y + 4 + fs * 0.2);
  });
  ctx.restore();
}

function startPreview() {
  rebuildPreviewCfg();
  if (previewRaf !== null) { cancelAnimationFrame(previewRaf); previewRaf = null; }
  if (window.LED_FRAME_ANIMATED(cfg)) {
    const loop = () => { drawPreviewFrame(window.LED_NOW()); previewRaf = requestAnimationFrame(loop); };
    previewRaf = requestAnimationFrame(loop);
  } else {
    drawPreviewFrame(window.LED_NOW());
  }
}

// ---------- outputs ----------

function outCfgFor(id) {
  if (!cfg.outputs[id]) cfg.outputs[id] = { mode: 'fit', offsetX: 0, offsetY: 0, posX: 0, posY: 0, label: '', wallId: cfg.walls[0].id };
  return cfg.outputs[id];
}

function wallSelectFor(oc, key) {
  const sel = document.createElement('select');
  for (const w of cfg.walls) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    sel.appendChild(opt);
  }
  sel.value = cfg.walls.some((w) => w.id === oc.wallId) ? oc.wallId : cfg.walls[0].id;
  sel.title = 'Which wall this output displays';
  sel.addEventListener('change', () => {
    oc.wallId = sel.value;
    oc.assigned = true;
    oc.segment = nextFreeSegment(oc.wallId, key);
    push();
    renderDisplays();
  });
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

// Fields that only make sense for one kind of output. Kept in the same
// labelled-field flow as everything else rather than a separate panel.
function appendTypeSpecificControls(ctl, oc, opts) {
  if (opts.kind === 'sdi') {
    // The raster and the conversion are fixed once the card is transmitting,
    // so these lock while the output is live.
    const live = !!opts.active;

    const vmSel = document.createElement('select');
    for (const mm of (opts.modes || [])) {
      const o = document.createElement('option');
      o.value = mm.id;
      o.textContent = mm.label;
      vmSel.appendChild(o);
    }
    vmSel.value = oc.dlMode;
    vmSel.disabled = live;
    vmSel.title = live ? 'Stop the output to change video mode' : 'SDI video mode';
    vmSel.addEventListener('change', () => { oc.dlMode = vmSel.value; push(); renderDeckLink(); });
    ctl.appendChild(field('Video mode', vmSel));

    const rgSel = document.createElement('select');
    for (const [v, l] of [['full', 'Full (0–255)'], ['legal', 'Legal (16–235)']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = l;
      rgSel.appendChild(o);
    }
    rgSel.value = oc.dlRange;
    rgSel.disabled = live;
    rgSel.title = 'SDI convention is legal range; LED processors commonly expect full. ' +
      'Full forces Lattice\'s own conversion — the card\'s built-in RGB conversion only ever ' +
      'produces legal range.';
    rgSel.addEventListener('change', () => { oc.dlRange = rgSel.value; push(); });
    ctl.appendChild(field('Colour range', rgSel));

    // Only meaningful on 3G modes, and hidden at the 1080p30 default so it does
    // not clutter the common case. Kept because it is hardware-verified and may
    // matter on other rigs, even though it did not resolve the HVT11.
    const sel = (opts.modes || []).find((x) => x.id === oc.dlMode);
    if (sel && sel.threeG) {
      const lvSel = document.createElement('select');
      for (const [v, l] of [['b', 'Level B (default)'], ['a', 'Level A']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        lvSel.appendChild(o);
      }
      lvSel.value = oc.dlLevel;
      lvSel.disabled = live;
      lvSel.title = 'How this rate is mapped onto 3G-SDI. Some devices accept only one mapping.';
      lvSel.addEventListener('change', () => { oc.dlLevel = lvSel.value; push(); });
      ctl.appendChild(field('3G-SDI level', lvSel));
    }
    return;
  }

  if (opts.kind === 'virtual' && opts.spec) {
    const res = document.createElement('input');
    res.type = 'text';
    res.className = 'olabel';
    res.value = `${opts.spec.width}×${opts.spec.height}`;
    res.title = 'Resolution of this virtual output, e.g. 1920×1080';
    const applyRes = () => {
      const m = res.value.match(/(\d+)\s*[x×*,\s]\s*(\d+)/);
      if (!m) { res.value = `${opts.spec.width}×${opts.spec.height}`; return; }
      const w = Math.max(16, Math.min(16384, parseInt(m[1], 10)));
      const h = Math.max(16, Math.min(16384, parseInt(m[2], 10)));
      if (w === opts.spec.width && h === opts.spec.height) { res.value = `${w}×${h}`; return; }
      opts.spec.width = w; opts.spec.height = h;
      push();
      // A live virtual output is a window sized to the old resolution; restart
      // it so the change actually takes effect.
      if (opts.active) {
        window.ledwall.stopOutput(opts.spec.id);
        window.ledwall.startOutput(opts.spec.id, { width: w, height: h, label: oc.label });
      }
      renderDisplays();
    };
    res.addEventListener('change', applyRes);
    ctl.appendChild(field('Resolution', res));
  }
}

// The labeled control row shared by every output card, whatever its kind.
//
// `opts.kind` selects the type-specific fields that sit inline between Wall and
// Scale — video mode and colour range for SDI, resolution for virtual, nothing
// for a physical display. Everything else is identical across kinds on purpose:
// an SDI output is a display card with two extra fields, not a different sort
// of object.
function appendOutputControls(ctl, key, oc, nameEl, opts) {
  opts = opts || {};
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

  ctl.appendChild(field('Wall', wallSelectFor(oc, key), 'Which wall this output displays'));

  // When the assigned wall is carried by several outputs, this picks which
  // piece this one shows — and the crop follows from it, so nobody works out
  // pixel offsets by hand.
  const assignedWall = cfg.walls.find((w) => w.id === oc.wallId) || cfg.walls[0];
  if (window.LED_WALL_IS_SPLIT(assignedWall)) {
    const segs = window.LED_WALL_SEGMENTS(assignedWall);
    const segSel = document.createElement('select');
    segs.forEach((sg, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      const where = assignedWall.split.rows > 1 && assignedWall.split.cols > 1
        ? ` (col ${sg.col + 1}, row ${sg.row + 1})` : '';
      o.textContent = `${i + 1} of ${segs.length}${where}`;
      segSel.appendChild(o);
    });
    segSel.value = String(Math.min(oc.segment | 0, segs.length - 1));
    segSel.addEventListener('change', () => {
      oc.segment = segSel.value | 0;
      push();
      renderDisplays();
    });
    const seg = segs[Math.min(oc.segment | 0, segs.length - 1)];
    ctl.appendChild(field('Segment', segSel,
      `Which piece of ${assignedWall.name} this output carries — crop ${seg.x},${seg.y}`));
  }

  appendTypeSpecificControls(ctl, oc, opts);

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

  // manual crop only matters when the wall isn't split — with segments the
  // crop is derived, and showing both would let them contradict each other
  if (oc.mode === '1to1' && !window.LED_WALL_IS_SPLIT(assignedWall)) {
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
    appendOutputControls(ctl, d.id, oc, null, { kind: 'display' });

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
    appendOutputControls(ctl, v.id, oc, name, { kind: 'virtual', spec: v, active });

    card.append(head, ctl);
    box.appendChild(card);
  });
}

// ---------- DeckLink SDI outputs ----------
//
// A DeckLink sub-device is just another output: same card, same controls
// (label, wall, scale mode, Crop X/Y, Pos X/Y) via appendOutputControls. The
// only extra controls are the ones that are genuinely specific to SDI — video
// mode and colour range — because the raster is fixed by the standard rather
// than by a monitor.

let deckLinkInfo = { available: false, devices: [], modes: [] };
let deckLinkActive = new Set();
let deckLinkRescan = null;
const deckLinkStatus = new Map();   // output id -> { state, error, stats }

// A DeckLink output's config key is stable across restarts: it is tied to the
// card's persistent ID, not to enumeration order.
function dlOutputId(dev) { return 'dl:' + dev.persistentId; }

function dlCfgFor(dev) {
  const oc = outCfgFor(dlOutputId(dev));
  // Defaults chosen from measurement on real hardware, not convention:
  // 1080p30 because a DBSTAR HVT11 refuses 3G-SDI (1080p50 and above) while
  // accepting 1.5G, and full range because the signal those processors are
  // already fed -- a Hippotizer -- measures full range on the wire.
  if (!oc.dlMode) oc.dlMode = '1080p30';
  if (!oc.dlRange) oc.dlRange = 'full';
  if (!oc.dlLevel) oc.dlLevel = 'b';
  // SDI cannot rescale: 1:1 with Crop X/Y is the primary path for mapping a
  // larger wall across several feeds (brief §5a decision 2).
  if (!oc.dlInit) { oc.mode = '1to1'; oc.dlInit = true; }
  return oc;
}

// Shared by the card's Start button and the wall's "Send to output" dropdown so
// both routes behave identically — including the half-duplex guard, which must
// hold however the output was started.
function startDeckLinkOutputFor(dev, oc) {
  const id = dlOutputId(dev);
  if (dev.signalPresentOnInput) {
    deckLinkStatus.set(id, {
      state: 'error',
      error: 'This SDI port is currently receiving a signal. Starting an output here would ' +
             'flip the port to transmit and interrupt that capture.',
    });
    renderDeckLink();
    return;
  }
  deckLinkStatus.delete(id);
  window.ledwall.startDeckLinkOutput(id, dev.index, oc.dlMode, oc.dlRange, oc.dlLevel).then((r) => {
    if (r && r.ok === false) {
      deckLinkStatus.set(id, { state: 'error', error: r.error });
      renderDeckLink();
    }
  });
}

function renderDeckLink() {
  const box = $('#decklinkList');
  if (!box) return;
  box.innerHTML = '';
  // Absence is normal: no helper, driver or card simply means no SDI cards and
  // no SDI entries in the wall dropdown.
  if (!deckLinkInfo.available || !deckLinkInfo.devices.length) { rebuildWallOutputSelect(); return; }

  // Eight sub-devices would otherwise bury the panel. Show only the ones that
  // matter right now: those assigned to the wall being edited, plus anything
  // live or errored — nothing transmitting should ever be invisible.
  const relevant = deckLinkInfo.devices.filter((dev) => {
    const id = dlOutputId(dev);
    const oc = cfg.outputs[id];
    const st = deckLinkStatus.get(id) || {};
    if (deckLinkActive.has(id) || st.state === 'error') return true;
    return !!(oc && oc.assigned && oc.wallId === cfg.selectedWall);
  });

  if (!relevant.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = `${deckLinkInfo.devices.length} SDI outputs available — assign one to `
      + `${curWall().name} with “Send to output”.`;
    box.appendChild(hint);
    rebuildWallOutputSelect();
    return;
  }

  for (const dev of relevant) {
    const id = dlOutputId(dev);
    const oc = dlCfgFor(dev);
    const st = deckLinkStatus.get(id) || {};
    const active = deckLinkActive.has(id);
    const busy = !!dev.signalPresentOnInput;

    const card = document.createElement('div');
    card.className = 'display-card';

    const num = document.createElement('div');
    num.className = 'dnum';
    num.textContent = 'SDI';

    const info = document.createElement('div');
    info.className = 'dinfo';
    const name = document.createElement('div');
    name.className = 'dname';
    // Model + sub-device index, never the stored CardInfoLabel — one card's
    // sub-devices are literally named "Input 1-4" (brief §5a decision 5).
    name.dataset.fallback = dev.name;
    name.textContent = oc.label || dev.name;
    const res = document.createElement('div');
    res.className = 'dres';
    const m = deckLinkInfo.modes.find((x) => x.id === oc.dlMode) || deckLinkInfo.modes[0];
    res.textContent = `${m.width} × ${m.height} px — SDI ${m.label}`;
    info.append(name, res);

    const head = document.createElement('div');
    head.className = 'dhead';
    head.append(num, info);

    const badge = document.createElement('span');
    if (busy && !active) { badge.className = 'badge'; badge.textContent = 'Receiving'; }
    else if (st.state === 'error') { badge.className = 'badge'; badge.textContent = 'Error'; }
    else { badge.className = active ? 'badge live' : 'badge virtual'; badge.textContent = active ? 'Live' : 'SDI'; }
    head.appendChild(badge);

    const btn = document.createElement('button');
    btn.className = active ? 'btn danger' : 'btn primary';
    btn.textContent = active ? 'Stop' : 'Start';
    // Half-duplex: opening output on a receiving port flips it to transmit and
    // kills whatever capture is running. Block it here as well as in the helper.
    if (busy && !active) {
      btn.disabled = true;
      btn.title = 'This SDI port is currently receiving a signal. Starting an output would interrupt it.';
    }
    btn.addEventListener('click', () => {
      if (active) window.ledwall.stopDeckLinkOutput(id);
      else startDeckLinkOutputFor(dev, oc);
    });
    head.appendChild(btn);

    const ctl = document.createElement('div');
    ctl.className = 'dctl';

    appendOutputControls(ctl, id, oc, name,
      { kind: 'sdi', active, modes: deckLinkInfo.modes });

    card.append(head, ctl);

    // Measured through an SDI loopback: chroma is 4:2:2 in EVERY mode, not just
    // the high frame rates. Feeding the card RGB only moves the RGB->YUV
    // conversion into the card; it does not put 4:4:4 on the wire. Said once
    // per card rather than as a per-mode warning, because no mode escapes it.
    const chroma = document.createElement('div');
    chroma.className = 'hint';
    chroma.textContent = 'SDI carries YUV 4:2:2 in all modes: luma detail (grid, Panel Map, ' +
      'Checkerboard, Gray Steps) is pixel-exact — verified 1px lines with no bleed — but ' +
      'horizontal colour detail is halved, so coloured single-pixel features and Colour Bars ' +
      'edges are not. No available mode avoids this.';
    card.appendChild(chroma);

    // Hard-won on a DBSTAR HVT11: it locks 1080p30 and below but refuses
    // 1080p50/59.94/60, while accepting a 1080p59.94 feed from another source
    // through the same router. Level A, full range and matching every
    // measurable property of that working signal made no difference. Put the
    // knowledge in front of the operator at the moment it matters rather than
    // leaving them to rediscover it.
    if (m.threeG) {
      const tg = document.createElement('div');
      tg.className = 'hint';
      tg.textContent = `${m.label} is 3G-SDI. Some LED processors and sending cards accept only ` +
        '1.5G HD-SDI and will show no signal at this rate even though the card is transmitting ' +
        'correctly. If the device does not lock, try 1080p30 — everything except Motion Test ' +
        'is unaffected by the lower rate.';
      card.appendChild(tg);
    }
    if (oc.mode !== '1to1') {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.textContent = `Scale mode "${oc.mode}" resamples the wall into the ${m.width}×${m.height} raster — ` +
        'not pixel-exact. Use 1:1 with Crop X/Y to map a region of a larger wall.';
      card.appendChild(warn);
    }
    if (busy && !active) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.textContent = 'This port is receiving a signal. It is half-duplex, so starting an output here ' +
        'would flip it to transmit and interrupt that capture.';
      card.appendChild(warn);
    }
    if (st.state === 'error' && st.error) {
      const err = document.createElement('div');
      err.className = 'hint';
      err.textContent = st.error + ' — press Start to try again.';
      card.appendChild(err);
    }

    box.appendChild(card);
  }
  // SDI outputs are offered in the wall's "Send to output" list, so that list
  // has to be rebuilt whenever the device set or their labels change.
  rebuildWallOutputSelect();
}

async function refreshDeckLink() {
  try {
    const info = await window.ledwall.getDeckLink();
    if (info) {
      deckLinkInfo = info;
      if (Array.isArray(info.active)) deckLinkActive = new Set(info.active);
    }
  } catch (err) {
    // Enumeration failing is not an error condition for the app — it just
    // means no DeckLink outputs are on offer.
    deckLinkInfo = { available: false, devices: [], modes: [] };
  }
  renderDeckLink();
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
  $('#panelA').value = cfg.pattern.panelA;
  $('#panelB').value = cfg.pattern.panelB;
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
  $('#wallColorMode').checked = cfg.wallColorMode === 'perWall';
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
  window.LED_RENDER_FRAME(c.getContext('2d'), {
    wall: w, pattern: window.LED_WALL_PATTERN(cfg.pattern, w, cfg.wallColorMode),
    overlay: cfg.overlay, readout: cfg.readout,
  }, window.LED_NOW());
  const a = document.createElement('a');
  const safeName = (w.name || 'wall').replace(/[^\w-]+/g, '_');
  a.download = `lattice-${safeName}-${cfg.pattern.type}-${w.width}x${w.height}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

// ---------- loop export ----------
//
// A clip is only useful on a media server if it loops without a visible jump,
// so the export covers a whole number of animation cycles: the last frame is
// one frame-step before the first repeats.

let exportCaps = { ffmpeg: false };
let exporting = false;

function loopPlan() {
  const w = curWall();
  resolveWall(w);
  const cfgForLoop = { wall: w, pattern: cfg.pattern, overlay: cfg.overlay };
  const period = window.LED_LOOP_PERIOD(cfgForLoop);
  const fps = parseFloat($('#loopFps').value) || 60;
  const cycles = Math.max(1, $('#loopCycles').value | 0);
  const ms = period.ms * cycles;
  return { wall: w, period, fps, cycles, ms, frames: Math.max(1, Math.round((ms / 1000) * fps)) };
}

function updateLoopInfo() {
  const p = loopPlan();
  const info = $('#loopInfo');
  const warn = $('#loopWarn');
  const fmt = $('#loopFormat').value;

  if (!p.period.animated) {
    info.textContent = `${p.wall.name} — ${p.wall.width} × ${p.wall.height} — this pattern is static`;
    warn.textContent = 'Nothing is moving, so a loop would be one repeated frame. Use Export PNG instead.';
    warn.style.color = 'var(--danger)';
    $('#loopCyclesRow').style.display = 'none';
  } else if (!p.period.exact) {
    info.textContent = `${p.wall.name} — ${p.wall.width} × ${p.wall.height} @ ${p.fps} fps`;
    warn.textContent = 'This pattern has no short repeat (Motion Test and Pixel Walk never return to '
      + 'their exact start), so the clip will jump when it loops. Radar, Ring Pulse, Wave Sweep, '
      + 'Colour Cycle and Panel Chase all loop cleanly.';
    warn.style.color = 'var(--danger)';
    $('#loopCyclesRow').style.display = 'none';
  } else {
    const secs = p.ms / 1000;
    info.textContent = `${p.wall.name} — ${p.wall.width} × ${p.wall.height} @ ${p.fps} fps — `
      + `${secs.toFixed(2)} s, ${p.frames} frames, seamless`;
    warn.textContent = '';
    $('#loopCyclesRow').style.display = '';
  }

  const note = $('#loopFormatNote');
  $('#ffmpegRow').style.display = (fmt === 'mp4' && !exportCaps.ffmpeg) ? '' : 'none';
  if (fmt === 'mp4' && !exportCaps.ffmpeg) {
    if (exportCaps.blocked && exportCaps.blocked.length) {
      // found, but it refused to run — usually Gatekeeper quarantine on a
      // web download, which looks identical to "missing" without this
      note.textContent = `Found ffmpeg at ${exportCaps.blocked[0]} but it would not run. `
        + 'If you downloaded it, macOS has probably quarantined it — in Terminal: '
        + `xattr -d com.apple.quarantine "${exportCaps.blocked[0]}"  then Check again.`;
    } else {
      note.textContent = `MP4 needs ffmpeg and none was found (${exportCaps.searched || 0} locations checked, `
        + 'including your login shell PATH). Install it with "brew install ffmpeg", or if it is '
        + 'already on this machine use Locate ffmpeg… to point at it. A PNG sequence needs no encoder '
        + 'and is what media servers prefer anyway.';
    }
    note.style.color = 'var(--danger)';
  } else if (fmt === 'mp4') {
    note.textContent = `H.264 at CRF 16 — high enough that single-pixel grid lines survive encoding. `
      + `Using ${exportCaps.ffmpegPath || 'ffmpeg'}.`;
    note.style.color = '';
  } else if (fmt === 'png') {
    note.textContent = 'A numbered PNG sequence in its own folder — lossless, and what Hippotizer, '
      + 'Resolume and disguise take natively.';
    note.style.color = '';
  } else if (fmt === 'webm') {
    note.textContent = 'VP9 WebM. Fine for VLC or a quick check; most media servers will not take it.';
    note.style.color = '';
  }
  $('#loopGo').disabled = exporting || !p.period.animated || (fmt === 'mp4' && !exportCaps.ffmpeg);
}

async function openExportModal() {
  exportCaps = await window.ledwall.exportCapabilities();
  const sel = $('#loopFormat');
  sel.value = exportCaps.ffmpeg ? 'mp4' : 'png';
  $('#loopProgress').textContent = '';
  $('#exportModal').style.display = 'flex';
  updateLoopInfo();
}

async function runLoopExport() {
  if (exporting) return;
  const p = loopPlan();
  if (!p.period.animated) return;
  const fmt = $('#loopFormat').value;
  const safe = (p.wall.name || 'wall').replace(/[^\w-]+/g, '_');
  const suggested = `lattice-${safe}-${cfg.pattern.type}${cfg.overlay.type !== 'none' ? '-' + cfg.overlay.type : ''}`;

  const chosen = await window.ledwall.exportChoose(suggested);
  if (!chosen.ok) return;

  exporting = true;
  $('#loopGo').disabled = true;
  const progress = $('#loopProgress');
  const frameMs = p.ms / p.frames;

  // Render off the live canvases so the preview and any running outputs are
  // untouched while this runs.
  const c = document.createElement('canvas');
  c.width = p.wall.width;
  c.height = p.wall.height;
  const ctx = c.getContext('2d');
  const frameCfg = {
    wall: p.wall, pattern: window.LED_WALL_PATTERN(cfg.pattern, p.wall, cfg.wallColorMode),
    overlay: cfg.overlay, readout: cfg.readout,
  };

  try {
    if (fmt === 'webm') {
      progress.textContent = 'Recording…';
      const blobUrl = await recordWebM(c, ctx, frameCfg, p, frameMs);
      const out = chosen.path.replace(/\.(webm|mp4|png)$/i, '') + '.webm';
      const res = await window.ledwall.exportWriteFile(out, blobUrl);
      progress.textContent = res.ok ? `Saved ${out.split('/').pop()}` : `Failed: ${res.error}`;
      if (res.ok) window.ledwall.exportReveal(out);
    } else {
      const begun = await window.ledwall.exportBegin(chosen.path);
      if (!begun.ok) throw new Error(begun.error);
      for (let i = 0; i < p.frames; i++) {
        // frame i represents the instant i*frameMs into the loop; frame count
        // is chosen so frame `frames` would be exactly the start again
        window.LED_RENDER_FRAME(ctx, frameCfg, i * frameMs);
        const url = c.toDataURL('image/png');
        const w = await window.ledwall.exportFrame(begun.dir, i, url);
        if (!w.ok) throw new Error(w.error);
        if (i % 5 === 0 || i === p.frames - 1) {
          progress.textContent = `Rendering ${i + 1} / ${p.frames} frames…`;
          await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
        }
      }
      if (fmt === 'mp4') {
        progress.textContent = 'Encoding H.264…';
        const out = chosen.path.replace(/\.(webm|mp4|png)$/i, '') + '.mp4';
        const enc = await window.ledwall.exportEncode(begun.dir, out, p.fps);
        if (!enc.ok) throw new Error(enc.error);
        await window.ledwall.exportCleanup(begun.dir, false);
        progress.textContent = `Saved ${out.split('/').pop()} — ${p.frames} frames, ${(p.ms / 1000).toFixed(2)} s`;
        window.ledwall.exportReveal(out);
      } else {
        progress.textContent = `Saved ${p.frames} PNGs to ${begun.dir.split('/').pop()}`;
        window.ledwall.exportReveal(begun.dir);
      }
    }
  } catch (err) {
    progress.textContent = `Export failed: ${err.message}`;
  } finally {
    exporting = false;
    updateLoopInfo();
  }
}

// MediaRecorder path. captureStream(0) means frames are only emitted when we
// ask, so the clip contains exactly the frames we rendered.
function recordWebM(canvas, ctx, frameCfg, plan, frameMs) {
  return new Promise((resolve, reject) => {
    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 40000000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(new Error(e.error ? e.error.message : 'recorder failed'));
    rec.onstop = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('could not read the recording'));
      reader.readAsDataURL(new Blob(chunks, { type }));
    };
    rec.start();
    let i = 0;
    const step = () => {
      if (i >= plan.frames) { track.stop(); rec.stop(); return; }
      window.LED_RENDER_FRAME(ctx, frameCfg, i * frameMs);
      track.requestFrame();
      i++;
      if (i % 5 === 0) $('#loopProgress').textContent = `Recording ${i} / ${plan.frames}…`;
      setTimeout(step, 1000 / plan.fps);
    };
    step();
  });
}

function wireExport() {
  $('#exportLoopBtn').addEventListener('click', openExportModal);
  $('#loopCancel').addEventListener('click', () => { $('#exportModal').style.display = 'none'; });
  $('#loopGo').addEventListener('click', runLoopExport);
  ['#loopFormat', '#loopFps', '#loopCycles'].forEach((s) => {
    $(s).addEventListener('change', updateLoopInfo);
  });
  $('#recheckFfmpeg').addEventListener('click', async () => {
    $('#loopProgress').textContent = 'Looking for ffmpeg…';
    exportCaps = await window.ledwall.exportCapabilities();
    $('#loopProgress').textContent = exportCaps.ffmpeg ? `Found ${exportCaps.ffmpegPath}` : 'Still not found.';
    updateLoopInfo();
  });
  $('#locateFfmpeg').addEventListener('click', async () => {
    const res = await window.ledwall.exportLocateFfmpeg();
    if (res.canceled) return;
    if (!res.ok) { $('#loopProgress').textContent = res.error; return; }
    exportCaps = await window.ledwall.exportCapabilities();
    $('#loopProgress').textContent = `Using ${res.path}`;
    updateLoopInfo();
  });
  $('#exportModal').addEventListener('click', (e) => {
    if (e.target === $('#exportModal') && !exporting) $('#exportModal').style.display = 'none';
  });
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
  $('#wallColor').value = w.color || '#3fa9f5';
  $('#wallColorRow').style.display = cfg.wallColorMode === 'perWall' ? '' : 'none';
  syncWallColorBinding();
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
  syncSplitUI();
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
    if (chip.dataset.pa) return; // panel-colour pairs, wired with the pattern params
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

  for (const id of ['fg', 'bg', 'panelA', 'panelB']) {
    const el = $('#' + id);
    el.value = cfg.pattern[id];
    el.addEventListener('input', () => {
      if (wallColorTarget() === id) {
        curWall().color = el.value;
        $('#wallColor').value = el.value;
        renderWalls();
      } else {
        cfg.pattern[id] = el.value;
      }
      push();
    });
  }

  // panel-colour pairs (these chips carry data-pa/data-pb, unlike the wall
  // preset chips which the Wall Setup handler owns)
  document.querySelectorAll('.chip[data-pa]').forEach((chip) => {
    chip.addEventListener('click', () => {
      cfg.pattern.panelA = chip.dataset.pa;
      cfg.pattern.panelB = chip.dataset.pb;
      $('#panelA').value = cfg.pattern.panelA;
      $('#panelB').value = cfg.pattern.panelB;
      push();
    });
  });

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

  // Wall identity colours: off by default so a single-wall show is unchanged.
  const wcMode = $('#wallColorMode');
  wcMode.checked = cfg.wallColorMode === 'perWall';
  wcMode.addEventListener('change', () => {
    cfg.wallColorMode = wcMode.checked ? 'perWall' : 'same';
    $('#wallColorRow').style.display = wcMode.checked ? '' : 'none';
    syncWallColorBinding();
    push();
    renderWalls();
  });
  $('#wallColor').addEventListener('input', () => {
    curWall().color = $('#wallColor').value;
    syncWallColorBinding();
    push();
    renderWalls();
  });
  wireExport();
  $('#saveShowBtn').addEventListener('click', saveShowFile);
  $('#loadShowBtn').addEventListener('click', loadShowFile);
  wireWallOutputSelect();
  wireSplit();
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
  // DeckLink enumeration runs after the UI is up so a slow or absent driver can
  // never delay the control window appearing.
  refreshDeckLink();
  window.ledwall.onDeckLinkStatus((s) => {
    if (!s || !s.id) return;
    deckLinkStatus.set(s.id, s);
    if (s.state === 'running') deckLinkActive.add(s.id);
    else deckLinkActive.delete(s.id);
    // Stats arrive every second; only re-render on a state change to avoid
    // rebuilding the cards (and stealing focus) sixty times a minute.
    if (!s.stats) renderDeckLink();
    // Whether a port is receiving can change at any time — a router being
    // re-patched, a source being powered up — so an enumeration taken at
    // launch goes stale and Start can look available on a port that is now
    // busy. A refusal is the signal to re-read the real state. Debounced
    // because starting several outputs at once produces a burst of these.
    if (s.state === 'error') {
      clearTimeout(deckLinkRescan);
      deckLinkRescan = setTimeout(refreshDeckLink, 400);
    }
  });

  window.LED_ON_IMAGE_READY(() => startPreview()); // re-render once the logo decodes

  window.addEventListener('resize', () => startPreview());

  push(); // send initial config to main so outputs can pick it up
}

init();

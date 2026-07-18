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

const DEFAULTS = {
  walls: [{ ...WALL_DEFAULTS, id: 'w1' }],
  selectedWall: 'w1',
  pattern: { type: 'grid', fg: '#ffffff', bg: '#000000', size: 16, speed: 2, gradMode: 'gray-h', dir: 'h' },
  overlay: { type: 'none', color: '#3fb950', opacity: 70, speed: 1, dir: 'h' },
  readout: { label: true, dims: false }, // center label / wall name + dimensions line
  outputs: {}, // displayId | virtual id -> { mode, offsetX, offsetY, label, wallId }
  virtualOutputs: [], // [{ id: 'v...', width, height }]
};

let cfg = loadConfig();
let displays = [];
let previewRaf = null;
let activeSet = new Set(); // stringified ids of currently running outputs
let vSeq = 0;

const preview = $('#preview');
const previewCtx = preview.getContext('2d');

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // migrate single-wall configs (pre-0.6) to the walls list
      if (!saved.walls && saved.wall) {
        saved.walls = [{ ...saved.wall, id: 'w1', name: 'Wall 1' }];
        saved.selectedWall = 'w1';
      }
      const walls = (saved.walls && saved.walls.length ? saved.walls : DEFAULTS.walls)
        .map((w, i) => ({ ...WALL_DEFAULTS, name: `Wall ${i + 1}`, id: 'w' + (i + 1), ...w }));
      return {
        walls,
        selectedWall: walls.some((w) => w.id === saved.selectedWall) ? saved.selectedWall : walls[0].id,
        pattern: { ...DEFAULTS.pattern, ...saved.pattern },
        overlay: { ...DEFAULTS.overlay, ...saved.overlay },
        readout: { ...DEFAULTS.readout, ...saved.readout },
        outputs: saved.outputs || {},
        virtualOutputs: saved.virtualOutputs || [],
      };
    }
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  window.ledwall.setConfig(cfg);
  updateSummary();
  renderWalls();
  startPreview();
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
      const copy = { ...w, id: newWallId(), name: w.name + ' copy', colWidths: w.colWidths.slice(), rowHeights: w.rowHeights.slice() };
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
  const w = { ...WALL_DEFAULTS, id: newWallId(), name: `Wall ${cfg.walls.length + 1}`, colWidths: [500, 500], rowHeights: [500, 500] };
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
  oc.mode = '1to1';
  oc.label = w.name;
  push();
  renderDisplays();
  window.ledwall.startOutput(id, { width: w.width, height: w.height, label: w.name });
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

function drawPreviewFrame(t) {
  const w = curWall();
  resolveWall(w);
  const boxW = Math.max(100, $('#previewBox').clientWidth - 16);
  const boxH = 300;
  const s = Math.min(boxW / w.width, boxH / w.height, 1);
  const pcfg = s < 1 ? scaledCfgFor(w, s) : { wall: w, pattern: cfg.pattern, overlay: cfg.overlay };
  pcfg.readout = cfg.readout;
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
  if (!cfg.outputs[id]) cfg.outputs[id] = { mode: 'fit', offsetX: 0, offsetY: 0, label: '', wallId: cfg.walls[0].id };
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

function appendOutputControls(ctl, key, oc, active, startFn, nameEl) {
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'olabel';
  labelInput.placeholder = 'Output label';
  labelInput.value = oc.label || '';
  // 'input' so the label applies live with every keystroke — no blur needed
  labelInput.addEventListener('input', () => {
    oc.label = labelInput.value.trim();
    if (nameEl) nameEl.textContent = oc.label || nameEl.dataset.fallback;
    push();
  });
  ctl.appendChild(labelInput);

  ctl.appendChild(wallSelectFor(oc));

  const modeSel = document.createElement('select');
  for (const [val, label] of [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch'], ['1to1', '1:1 pixel']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    modeSel.appendChild(opt);
  }
  modeSel.value = oc.mode;
  modeSel.addEventListener('change', () => { oc.mode = modeSel.value; renderDisplays(); push(); });
  ctl.appendChild(modeSel);

  if (oc.mode === '1to1') {
    for (const key2 of ['offsetX', 'offsetY']) {
      const lab = document.createElement('label');
      lab.textContent = key2 === 'offsetX' ? 'X' : 'Y';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.value = oc[key2];
      inp.addEventListener('change', () => { oc[key2] = Math.max(0, inp.value | 0); push(); });
      lab.appendChild(inp);
      ctl.appendChild(lab);
    }
  }

  const btn = document.createElement('button');
  btn.className = active ? 'btn danger' : 'btn primary';
  btn.textContent = active ? 'Stop' : 'Start Output';
  btn.addEventListener('click', () => {
    if (active) window.ledwall.stopOutput(key);
    else startFn();
  });
  ctl.appendChild(btn);
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

    appendOutputControls(ctl, d.id, oc, d.active, () => window.ledwall.startOutput(d.id));

    card.append(num, info, ctl);
    box.appendChild(card);
  }
  renderVirtuals();
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

    const ctl = document.createElement('div');
    ctl.className = 'dctl';

    const badge = document.createElement('span');
    badge.className = active ? 'badge live' : 'badge virtual';
    badge.textContent = active ? 'Live' : 'Virtual';
    ctl.appendChild(badge);

    appendOutputControls(ctl, v.id, oc, active,
      () => window.ledwall.startOutput(v.id, { width: v.width, height: v.height, label: oc.label }),
      name);

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
    ctl.appendChild(rm);

    card.append(num, info, ctl);
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

  $('#identifyBtn').addEventListener('click', () => window.ledwall.identify());
  $('#stopAllBtn').addEventListener('click', () => window.ledwall.stopAll());
  $('#exportBtn').addEventListener('click', exportWallPNG);
  $('#addVirtualBtn').addEventListener('click', addVirtualOutput);
  $('#addWallBtn').addEventListener('click', addWall);
}

// ---------- init ----------

async function init() {
  $('#version').textContent = 'v' + (await window.ledwall.getVersion());
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

  window.addEventListener('resize', () => startPreview());

  push(); // send initial config to main so outputs can pick it up
}

init();

'use strict';
// Shared test-pattern library. Loaded by both the control-window preview and
// every output window, so what you see in the preview is exactly what the wall gets.
//
// Every pattern draws at native wall resolution (cfg.wall.width x cfg.wall.height)
// into a canvas 2d context. Scaling to the physical output happens later, in the
// output window, with image smoothing disabled for pixel accuracy.
//
// draw(ctx, cfg, t): cfg = { wall: {width,height,panelW,panelH,panelsX,panelsY},
//                            pattern: {type,fg,bg,size,speed,gradMode} }, t = ms.
(function () {
  const BAR_COLORS = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
  const CYCLE_COLORS = [
    ['#ff0000', 'RED'], ['#00ff00', 'GREEN'], ['#0000ff', 'BLUE'],
    ['#ffffff', 'WHITE'], ['#00ffff', 'CYAN'], ['#ff00ff', 'MAGENTA'],
    ['#ffff00', 'YELLOW'], ['#000000', 'BLACK'],
  ];

  function fillBG(ctx, cfg) {
    ctx.fillStyle = cfg.pattern.bg;
    ctx.fillRect(0, 0, cfg.wall.width, cfg.wall.height);
  }

  // One clock for every window. performance.now() is measured from each
  // document's own load, so two output windows opened seconds apart animate
  // seconds out of phase — the radar sweep sits at a different angle in each
  // feed. Date.now() is absolute and shared by every process; the epoch just
  // keeps the numbers small enough to stay precise.
  const ANIM_EPOCH = 1735689600000; // 2025-01-01
  const now = () => Date.now() - ANIM_EPOCH;

  // Animations that advance in pixels per second must be expressed relative to
  // the wall, or they run at different speeds wherever the canvas is a
  // different size — most visibly the scaled preview versus a real output.
  // Rates below are quoted for a 1920px-wide wall and scaled from there.
  const rate = (wall, perSecondAt1920) => perSecondAt1920 * (wall.width / 1920);

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Black or white, whichever stays legible on the given fill — so panel
  // coordinates read whatever pair of colours the operator picks.
  function readableOn(hex) {
    const n = parseInt(String(hex || '#000000').slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 140 ? '#000000' : '#ffffff';
  }

  // Spreadsheet-style column letters: 0->A, 25->Z, 26->AA ...
  function colLetter(i) {
    let s = '';
    i = i | 0;
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }

  // A wall can be carried by more than one output — a processor feed per
  // segment, joined back into one image on the wall. Segments tile the wall
  // left-to-right, top-to-bottom; `overlap` is how many pixels adjacent
  // segments share, for rigs where the feeds deliberately overlap rather than
  // butt together. Overlap 0 (the default) is a plain tile.
  // Segments are measured in PANELS, not equal fractions: a 9 × 11 wall can be
  // split into a 9 × 4 top and a 9 × 7 bottom, because that is how feeds
  // actually divide. Boundaries therefore land on panel seams by construction.
  //
  // `spans` distributes `total` panels over `count` segments; anything missing
  // or inconsistent falls back to as even a split as the panel count allows.
  function splitSpans(spans, count, total) {
    let a = Array.isArray(spans) ? spans.slice(0, count).map((n) => Math.max(1, n | 0)) : [];
    const sum = a.reduce((x, y) => x + y, 0);
    if (a.length !== count || sum !== total) {
      a = [];
      let left = total;
      for (let i = 0; i < count; i++) {
        const take = Math.max(1, Math.min(Math.round(left / (count - i)), left - (count - i - 1)));
        a.push(take);
        left -= take;
      }
    }
    return a;
  }

  function wallSegments(wall) {
    const g = wallGrid(wall);
    const s = (wall && wall.split) || {};
    const cols = Math.max(1, Math.min(g.cols, s.cols | 0 || 1));
    const rows = Math.max(1, Math.min(g.rows, s.rows | 0 || 1));
    const ov = Math.max(0, s.overlap | 0);
    const colSpans = splitSpans(s.colPanels, cols, g.cols);
    const rowSpans = splitSpans(s.rowPanels, rows, g.rows);

    const cStart = [];
    const rStart = [];
    let acc = 0;
    for (const n of colSpans) { cStart.push(acc); acc += n; }
    acc = 0;
    for (const n of rowSpans) { rStart.push(acc); acc += n; }

    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = g.xs[cStart[c]];
        const x1 = g.xs[cStart[c] + colSpans[c]];
        const y0 = g.ys[rStart[r]];
        const y1 = g.ys[rStart[r] + rowSpans[r]];
        let x = x0, y = y0, w = x1 - x0, h = y1 - y0;
        // overlap extends each feed into its neighbours on the inner edges,
        // which is what a rig sharing pixels between feeds actually does
        if (ov) {
          if (c > 0) { x -= ov; w += ov; }
          if (c < cols - 1) w += ov;
          if (r > 0) { y -= ov; h += ov; }
          if (r < rows - 1) h += ov;
        }
        out.push({
          index: r * cols + c, col: c, row: r,
          x, y, w, h,
          panelsX: colSpans[c], panelsY: rowSpans[r],
          firstCol: cStart[c], firstRow: rStart[r],
        });
      }
    }
    return out;
  }

  const wallIsSplit = (wall) => {
    const s = (wall && wall.split) || {};
    return (s.cols | 0) > 1 || (s.rows | 0) > 1;
  };

  // Panel grid geometry. Uniform mode repeats panelW/panelH; manual mode uses
  // explicit per-column widths and per-row heights (mixed cabinet sizes).
  function wallGrid(wall) {
    let colWidths, rowHeights;
    if (wall.mode === 'manual') {
      colWidths = (wall.colWidths && wall.colWidths.length) ? wall.colWidths : [500, 500];
      rowHeights = (wall.rowHeights && wall.rowHeights.length) ? wall.rowHeights : [500, 500];
    } else {
      colWidths = new Array(Math.max(1, wall.panelsX | 0)).fill(Math.max(8, wall.panelW | 0));
      rowHeights = new Array(Math.max(1, wall.panelsY | 0)).fill(Math.max(8, wall.panelH | 0));
    }
    const xs = [0];
    for (const w of colWidths) xs.push(xs[xs.length - 1] + w);
    const ys = [0];
    for (const h of rowHeights) ys.push(ys[ys.length - 1] + h);
    return {
      colWidths, rowHeights, xs, ys,
      cols: colWidths.length, rows: rowHeights.length,
      width: xs[xs.length - 1], height: ys[ys.length - 1],
    };
  }

  const PATTERNS = {
    solid: {
      name: 'Solid Color',
      params: ['bg'],
      draw(ctx, cfg) { fillBG(ctx, cfg); },
    },

    colorbars: {
      name: 'Color Bars',
      params: [],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const n = BAR_COLORS.length;
        for (let i = 0; i < n; i++) {
          const x0 = Math.round((i * w) / n);
          const x1 = Math.round(((i + 1) * w) / n);
          ctx.fillStyle = BAR_COLORS[i];
          ctx.fillRect(x0, 0, x1 - x0, h);
        }
      },
    },

    grid: {
      name: 'Grid',
      params: ['fg', 'bg', 'size'],
      draw(ctx, cfg) {
        // Panel-aware: bright lines on every panel seam; the fine sub-grid
        // restarts at each panel's origin so every panel looks identical
        // regardless of whether `size` divides the panel evenly.
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        const step = Math.max(2, cfg.pattern.size | 0);
        fillBG(ctx, cfg);
        ctx.fillStyle = hexToRgba(cfg.pattern.fg, 0.45);
        for (let c = 0; c < g.cols; c++) {
          const end = Math.min(g.xs[c + 1], w);
          for (let x = g.xs[c] + step; x < end; x += step) ctx.fillRect(x, 0, 1, h);
        }
        for (let r = 0; r < g.rows; r++) {
          const end = Math.min(g.ys[r + 1], h);
          for (let y = g.ys[r] + step; y < end; y += step) ctx.fillRect(0, y, w, 1);
        }
        ctx.fillStyle = cfg.pattern.fg;
        for (const x of g.xs) ctx.fillRect(Math.min(x, w - 1), 0, 1, h);
        for (const y of g.ys) ctx.fillRect(0, Math.min(y, h - 1), w, 1);
      },
    },

    checker: {
      name: 'Checkerboard',
      params: ['fg', 'bg', 'size'],
      draw(ctx, cfg) {
        // Panel-aware: the checker phase restarts at each panel's origin, so
        // every panel starts with a background tile in its top-left corner —
        // identical panels, and seams show up as phase resets.
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        const s = Math.max(1, cfg.pattern.size | 0);
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            const x0 = g.xs[c], y0 = g.ys[r];
            const x1 = Math.min(g.xs[c + 1], w), y1 = Math.min(g.ys[r + 1], h);
            for (let y = y0, ty = 0; y < y1; y += s, ty++) {
              for (let x = x0 + ((ty & 1) ? 0 : s), tx = 0; x < x1; x += s * 2, tx++) {
                ctx.fillRect(x, y, Math.min(s, x1 - x), Math.min(s, y1 - y));
              }
            }
          }
        }
      },
    },

    panelmap: {
      name: 'Panel Map',
      params: ['panelA', 'panelB', 'fg'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        // Panels alternate between two chosen colours, so every seam is visible
        // as a colour change rather than relying on the 1px border alone.
        const colA = cfg.pattern.panelA || '#101010';
        const colB = cfg.pattern.panelB || '#303030';
        const textOn = [readableOn(colA), readableOn(colB)];
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            ctx.fillStyle = ((r + c) & 1) ? colB : colA;
            ctx.fillRect(g.xs[c], g.ys[r], g.colWidths[c], g.rowHeights[r]);
          }
        }
        ctx.fillStyle = cfg.pattern.fg;
        for (const x of g.xs) ctx.fillRect(Math.min(x, w - 1), 0, 1, h);
        for (const y of g.ys) ctx.fillRect(0, Math.min(y, h - 1), w, 1);
        // coordinates: letters across (A, B, C...), numbers down (1, 2, 3...)
        ctx.textAlign = 'center';
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            const pw = g.colWidths[c], ph = g.rowHeights[r];
            const cx = g.xs[c] + pw / 2, cy = g.ys[r] + ph / 2;
            if (g.xs[c] >= w || g.ys[r] >= h) continue;
            const big = Math.max(8, Math.floor(Math.min(pw, ph) * 0.34));
            // legible on whichever of the two colours this panel carries
            ctx.fillStyle = textOn[(r + c) & 1];
            ctx.font = `bold ${big}px Menlo, monospace`;
            ctx.fillText(colLetter(c) + (r + 1), cx, cy + big * 0.35);
            if (ph >= 48) {
              // report the wall's real panel size: the preview draws a scaled
              // copy, so scaling its rounded widths back up is off by a pixel
              const ls = cfg.wall.pxLabelScale || 1;
              const oc = cfg.wall.origColWidths, or = cfg.wall.origRowHeights;
              const tw = oc && oc[c] != null ? oc[c] : Math.round(pw * ls);
              const th = or && or[r] != null ? or[r] : Math.round(ph * ls);
              const small = Math.max(6, Math.floor(big * 0.4));
              ctx.font = `${small}px Menlo, monospace`;
              ctx.fillText(`${tw}×${th}`, cx, cy + big * 0.35 + small * 1.4);
            }
          }
        }
      },
    },

    panelchase: {
      name: 'Panel Chase',
      params: ['fg', 'bg', 'speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        const speed = cfg.pattern.speed || 1; // panels per second
        const n = g.cols * g.rows;
        const idx = Math.floor((t / 1000) * speed) % n;
        const r = Math.floor(idx / g.cols), c = idx % g.cols;
        fillBG(ctx, cfg);
        // faint grid so you can see what's coming
        ctx.fillStyle = hexToRgba(cfg.pattern.fg, 0.25);
        for (const x of g.xs) ctx.fillRect(Math.min(x, w - 1), 0, 1, h);
        for (const y of g.ys) ctx.fillRect(0, Math.min(y, h - 1), w, 1);
        // lit panel with its coordinate
        const px = g.xs[c], py = g.ys[r], pw = g.colWidths[c], ph = g.rowHeights[r];
        ctx.fillStyle = cfg.pattern.fg;
        ctx.fillRect(px, py, pw, ph);
        const big = Math.max(10, Math.floor(Math.min(pw, ph) * 0.4));
        ctx.font = `bold ${big}px Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = cfg.pattern.bg;
        ctx.fillText(colLetter(c) + (r + 1), px + pw / 2, py + ph / 2 + big * 0.35);
        // corner readout: current coordinate + progress
        ctx.textAlign = 'left';
        ctx.fillStyle = cfg.pattern.fg;
        const fs = Math.max(10, Math.floor(Math.min(w, h) / 16));
        ctx.font = `bold ${fs}px Menlo, monospace`;
        ctx.fillText(`${colLetter(c)}${r + 1}  ${idx + 1}/${n}`, 6, fs * 1.1);
      },
    },

    cablingmap: {
      name: 'Cabling Map',
      params: ['fg', 'bg'],
      draw(ctx, cfg) {
        // panel grid with A1 coordinates, then the wall's cabling on top —
        // the same diagram the editor shows, displayed on the wall itself
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        fillBG(ctx, cfg);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            if ((r + c) & 1) ctx.fillRect(g.xs[c], g.ys[r], g.colWidths[c], g.rowHeights[r]);
          }
        }
        ctx.fillStyle = cfg.pattern.fg;
        for (const x of g.xs) ctx.fillRect(Math.min(x, w - 1), 0, 1, h);
        for (const y of g.ys) ctx.fillRect(0, Math.min(y, h - 1), w, 1);
        ctx.textAlign = 'center';
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            const pw = g.colWidths[c], ph = g.rowHeights[r];
            const fs = Math.max(7, Math.floor(Math.min(pw, ph) * 0.2));
            ctx.font = `bold ${fs}px Menlo, monospace`;
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fillText(colLetter(c) + (r + 1), g.xs[c] + pw / 2, g.ys[r] + fs * 1.4);
          }
        }
        if (cfg.wall.cabling) {
          drawCabling(ctx, cfg.wall, cfg.wall.cabling, { layer: cfg.cablingLayer || 'signal' });
        }
      },
    },

    gradient: {
      name: 'Gradient',
      params: ['gradMode'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const mode = cfg.pattern.gradMode || 'gray-h';
        if (mode === 'hue') {
          for (let x = 0; x < w; x++) {
            ctx.fillStyle = `hsl(${(x / w) * 360}, 100%, 50%)`;
            ctx.fillRect(x, 0, 1, h);
          }
          return;
        }
        const vertical = mode === 'gray-v';
        const g = ctx.createLinearGradient(0, 0, vertical ? 0 : w, vertical ? h : 0);
        const ends = {
          'gray-h': ['#000000', '#ffffff'],
          'gray-v': ['#000000', '#ffffff'],
          red: ['#000000', '#ff0000'],
          green: ['#000000', '#00ff00'],
          blue: ['#000000', '#0000ff'],
        }[mode] || ['#000000', '#ffffff'];
        g.addColorStop(0, ends[0]);
        g.addColorStop(1, ends[1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      },
    },

    graysteps: {
      name: 'Gray Steps',
      params: [],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const steps = 16;
        const half = Math.floor(h / 2);
        for (let i = 0; i < steps; i++) {
          const v = Math.round((i / (steps - 1)) * 255);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          const x0 = Math.round((i * w) / steps);
          const x1 = Math.round(((i + 1) * w) / steps);
          ctx.fillRect(x0, 0, x1 - x0, half);
        }
        // smooth ramp below for banding comparison
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, '#000000');
        g.addColorStop(1, '#ffffff');
        ctx.fillStyle = g;
        ctx.fillRect(0, half, w, h - half);
      },
    },

    geometry: {
      name: 'Geometry',
      params: ['fg', 'bg'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        // 1px border + center cross (fillRect keeps them crisp)
        ctx.fillRect(0, 0, w, 1); ctx.fillRect(0, h - 1, w, 1);
        ctx.fillRect(0, 0, 1, h); ctx.fillRect(w - 1, 0, 1, h);
        ctx.fillRect(0, Math.floor(h / 2), w, 1);
        ctx.fillRect(Math.floor(w / 2), 0, 1, h);
        ctx.strokeStyle = cfg.pattern.fg;
        ctx.lineWidth = 1;
        // diagonals
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(w, h);
        ctx.moveTo(w, 0); ctx.lineTo(0, h);
        ctx.stroke();
        // circles: center big + quadrant circles — squares if wall isn't square, so distortion shows
        const cx = w / 2, cy = h / 2;
        const r = Math.min(w, h) / 2 - 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, r / 2, 0, Math.PI * 2); ctx.stroke();
        const qr = Math.min(w, h) / 6;
        for (const [qx, qy] of [[w / 4, h / 4], [(3 * w) / 4, h / 4], [w / 4, (3 * h) / 4], [(3 * w) / 4, (3 * h) / 4]]) {
          ctx.beginPath(); ctx.arc(qx, qy, qr, 0, Math.PI * 2); ctx.stroke();
        }
      },
    },

    moire: {
      name: '1px Lines',
      params: ['fg', 'bg', 'size'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const s = Math.max(1, cfg.pattern.size | 0);
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        const half = Math.floor(h / 2);
        for (let x = 0; x < w; x += s * 2) ctx.fillRect(x, 0, s, half); // vertical stripes top
        for (let y = half; y < h; y += s * 2) ctx.fillRect(0, y, w, s); // horizontal stripes bottom
      },
    },

    pixelwalk: {
      name: 'Pixel Walk',
      params: ['fg', 'bg', 'speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1; // pixels per frame @60fps
        const step = Math.floor((t / (1000 / 60)) * speed);
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        ctx.fillRect(step % w, 0, 1, h);
        ctx.fillRect(0, step % h, w, 1);
      },
    },

    radar: {
      name: 'Radar Sweep',
      params: ['fg', 'bg', 'speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1; // speed 1 = one revolution per 4s
        const fg = cfg.pattern.fg;
        // radius and angle are already wall-relative, so this one scales
        fillBG(ctx, cfg);
        const cx = w / 2, cy = h / 2;
        const R = Math.hypot(w, h) / 2; // reach the corners
        ctx.strokeStyle = hexToRgba(fg, 0.25);
        ctx.lineWidth = 1;
        for (let i = 1; i <= 4; i++) {
          ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(0, cy); ctx.lineTo(w, cy);
        ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
        ctx.stroke();
        // rotating beam with fading trail (trail sits just behind the beam)
        // reduce to one revolution BEFORE the trig: the shared clock makes t
        // ~5e10 ms, and an unreduced angle of ~1e8 radians loses several
        // degrees of precision, so the beam and the conic gradient disagree
        const rev = (t / 4000) * speed;
        const ang = (rev - Math.floor(rev)) * Math.PI * 2;
        const grad = ctx.createConicGradient(ang, cx, cy);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.72, 'rgba(0,0,0,0)');
        grad.addColorStop(1, hexToRgba(fg, 0.75));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = fg;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        ctx.stroke();
      },
    },

    ringpulse: {
      name: 'Ring Pulse',
      params: ['fg', 'bg', 'speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1;
        fillBG(ctx, cfg);
        const cx = w / 2, cy = h / 2;
        const R = Math.hypot(w, h) / 2;
        const rings = 3;
        for (let i = 0; i < rings; i++) {
          const frac = (((t / 2000) * speed) + i / rings) % 1;
          ctx.strokeStyle = hexToRgba(cfg.pattern.fg, 1 - frac);
          ctx.lineWidth = Math.max(2, Math.min(w, h) / 60);
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, frac * R), 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = cfg.pattern.fg;
        ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      },
    },

    wavesweep: {
      name: 'Wave Sweep',
      params: ['fg', 'bg', 'speed', 'dir'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1;
        const dir = cfg.pattern.dir || 'h';
        const fg = cfg.pattern.fg;
        fillBG(ctx, cfg);
        const span = dir === 'h' ? w : dir === 'v' ? h : Math.hypot(w, h);
        const trail = Math.max(40, span * 0.25);
        const pos = ((t / 1000) * rate(cfg.wall, 250) * speed) % (span + trail);
        ctx.save();
        if (dir === 'v') { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
        else if (dir === 'd') { ctx.rotate(Math.PI / 4); }
        const g = ctx.createLinearGradient(pos - trail, 0, pos, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, hexToRgba(fg, 0.85));
        ctx.fillStyle = g;
        ctx.fillRect(pos - trail, -span, trail, span * 3);
        ctx.fillStyle = fg;
        ctx.fillRect(pos, -span, 3, span * 3);
        ctx.restore();
      },
    },

    colorcycle: {
      name: 'Color Cycle',
      params: ['speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1; // colors per second
        const idx = Math.floor((t / 1000) * speed) % CYCLE_COLORS.length;
        const [color, label] = CYCLE_COLORS[idx];
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        const fs = Math.max(10, Math.floor(Math.min(w, h) / 12));
        ctx.font = `bold ${fs}px Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = idx >= 3 && idx !== 5 ? '#00000088' : '#ffffff88';
        ctx.fillText(label, fs * 0.5, fs * 1.2);
      },
    },

    motion: {
      name: 'Motion Test',
      params: ['fg', 'bg', 'speed'],
      animated: true,
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const speed = cfg.pattern.speed || 1;
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        // bouncing box
        const box = Math.max(8, Math.floor(Math.min(w, h) / 8));
        const px = (t / 1000) * rate(cfg.wall, 120) * speed;
        const rangeX = Math.max(1, w - box), rangeY = Math.max(1, h - box);
        const bx = Math.abs(((px) % (rangeX * 2)) - rangeX);
        const by = Math.abs(((px * 0.7) % (rangeY * 2)) - rangeY);
        ctx.fillRect(Math.floor(bx), Math.floor(by), box, box);
        // sweeping vertical bar for judder
        const barX = Math.floor(((t / 1000) * rate(cfg.wall, 60) * speed) % w);
        ctx.fillRect(barX, 0, 2, h);
        // frame counter
        const fs = Math.max(10, Math.floor(Math.min(w, h) / 14));
        ctx.font = `bold ${fs}px Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.floor(t / (1000 / 60)) % 100000), 4, fs * 1.1);
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Overlay pulses — animated layers composited OVER the current pattern
  // (Resolume-style: the sweep travels across the test pattern). They draw only
  // their moving elements, never a background. Opacity is applied by the caller.
  const OVERLAYS = {
    none: { name: 'None', params: [] },

    radar: {
      name: 'Radar Sweep',
      params: ['ovColor', 'ovOpacity', 'ovSpeed'],
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const o = cfg.overlay;
        const cx = w / 2, cy = h / 2;
        const R = Math.hypot(w, h) / 2;
        // reduced to one revolution before the trig — see the pattern version
        const rev = (t / 4000) * (o.speed || 1);
        const ang = (rev - Math.floor(rev)) * Math.PI * 2;
        const grad = ctx.createConicGradient(ang, cx, cy);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.72, 'rgba(0,0,0,0)');
        grad.addColorStop(1, hexToRgba(o.color, 0.9));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = o.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        ctx.stroke();
      },
    },

    ringpulse: {
      name: 'Ring Pulse',
      params: ['ovColor', 'ovOpacity', 'ovSpeed'],
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const o = cfg.overlay;
        const cx = w / 2, cy = h / 2;
        const R = Math.hypot(w, h) / 2;
        const rings = 3;
        for (let i = 0; i < rings; i++) {
          const frac = (((t / 2000) * (o.speed || 1)) + i / rings) % 1;
          ctx.strokeStyle = hexToRgba(o.color, 1 - frac);
          ctx.lineWidth = Math.max(2, Math.min(w, h) / 60);
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, frac * R), 0, Math.PI * 2); ctx.stroke();
        }
      },
    },

    wavesweep: {
      name: 'Wave Sweep',
      params: ['ovColor', 'ovOpacity', 'ovSpeed', 'ovDir'],
      draw(ctx, cfg, t) {
        const { width: w, height: h } = cfg.wall;
        const o = cfg.overlay;
        const dir = o.dir || 'h';
        const span = dir === 'h' ? w : dir === 'v' ? h : Math.hypot(w, h);
        const trail = Math.max(40, span * 0.25);
        const pos = ((t / 1000) * rate(cfg.wall, 250) * (o.speed || 1)) % (span + trail);
        ctx.save();
        if (dir === 'v') { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
        else if (dir === 'd') { ctx.rotate(Math.PI / 4); }
        const g = ctx.createLinearGradient(pos - trail, 0, pos, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, hexToRgba(o.color, 0.9));
        ctx.fillStyle = g;
        ctx.fillRect(pos - trail, -span, trail, span * 3);
        ctx.fillStyle = o.color;
        ctx.fillRect(pos, -span, 3, span * 3);
        ctx.restore();
      },
    },
  };

  // Center readout: label / wall name and optional dimensions line, rendered
  // INTO the frame so it shows identically on outputs, the preview and exports.
  function dimsText(w) {
    const g = wallGrid(w);
    const ls = w.pxLabelScale || 1; // preview renders scaled — show true px
    let t = `${Math.round(w.width * ls)} × ${Math.round(w.height * ls)} px · ${g.cols} × ${g.rows} panels`;
    // origMode/origDefineBy: the preview renders a scaled manual-grid copy of
    // the wall — the readout must still reflect the real wall's definition
    const mode = w.origMode || w.mode;
    const defineBy = w.origDefineBy || w.defineBy;
    if (mode !== 'manual' && defineBy === 'mm') {
      t += ` · ${((w.panelsX * w.mmW) / 1000).toFixed(2)} × ${((w.panelsY * w.mmH) / 1000).toFixed(2)} m`;
    }
    return t;
  }

  // ---------------------------------------------------------------------------
  // Cabling: signal (data) and power runs through the panel grid.
  //
  // A run models one home run: a cable leaving a processor port / power circuit
  // (the source), entering the wall at the first panel, then daisy-chaining
  // panel to panel — the industry S-route / straight-route patterns. Segments
  // between non-adjacent panels are drawn dashed: those are the long jumper
  // cables at the end of a column or row.
  const RUN_COLORS = [
    '#3fa9f5', '#3fb950', '#f5a623', '#e5534b', '#bd93f9',
    '#00d4c8', '#ff79c6', '#9fd356', '#ffd166', '#7aa2f7',
  ];

  function panelRect(g, c, r) {
    return { x: g.xs[c], y: g.ys[r], w: g.colWidths[c], h: g.rowHeights[r] };
  }

  function panelCenter(g, c, r) {
    const p = panelRect(g, c, r);
    return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  }

  function panelPixels(w, c, r) {
    const g = wallGrid(w);
    const ls = w.pxLabelScale || 1;
    return Math.round(g.colWidths[c] * ls) * Math.round(g.rowHeights[r] * ls);
  }

  // Load / limit maths for one run. Signal = pixels vs port budget,
  // power = watts vs circuit capacity (volts × amps × derate).
  function runLoad(wall, cabling, layer, run) {
    const path = run.path || [];
    const out = { panels: path.length, pixels: 0, watts: 0, amps: 0, over: false, limit: 0, used: 0 };
    if (layer === 'signal') {
      const cfgL = cabling.signal || {};
      for (const [c, r] of path) out.pixels += panelPixels(wall, c, r);
      out.limit = cfgL.maxPixelsPerPort || 650000;
      out.used = out.pixels;
    } else {
      const cfgL = cabling.power || {};
      const wpp = cfgL.wattsPerPanel || 150;
      const volts = cfgL.volts || 120;
      out.watts = path.length * wpp;
      out.amps = out.watts / volts;
      out.limit = (cfgL.ampsPerCircuit || 20) * (cfgL.derate == null ? 0.8 : cfgL.derate);
      out.used = out.amps;
    }
    out.over = out.used > out.limit;
    return out;
  }

  function arrowHead(ctx, x, y, angle, size) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(angle - 0.4) * size, y - Math.sin(angle - 0.4) * size);
    ctx.lineTo(x - Math.cos(angle + 0.4) * size, y - Math.sin(angle + 0.4) * size);
    ctx.closePath();
    ctx.fill();
  }

  // Which wall edge the home run enters from. Explicit setting wins; otherwise
  // infer it from the first hop — the cable arrives from behind the direction
  // of travel — falling back to the nearest edge for single-panel runs.
  function entryEdge(run, g, c, r) {
    if (run.entry) return run.entry;
    const path = run.path || [];
    if (path.length > 1) {
      const [nc, nr] = path[1];
      if (nr < r) return 'bottom';
      if (nr > r) return 'top';
      if (nc > c) return 'left';
      if (nc < c) return 'right';
    }
    const p = panelRect(g, c, r);
    const d = [
      ['left', p.x],
      ['right', g.width - (p.x + p.w)],
      ['top', p.y],
      ['bottom', g.height - (p.y + p.h)],
    ].sort((a, b) => a[1] - b[1]);
    return d[0][0];
  }

  // Draws the cabling layer over an existing panel-grid background.
  // opts: { layer, activeRunId, showSeq, dim }
  function drawCabling(ctx, wall, cabling, opts) {
    const o = opts || {};
    const layer = o.layer || 'signal';
    const g = wallGrid(wall);
    const runs = ((cabling && cabling[layer]) || {}).runs || [];
    const unit = Math.min(g.colWidths[0] || 100, g.rowHeights[0] || 100);
    const lw = Math.max(2, unit * 0.055);
    const dot = Math.max(3, unit * 0.1);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    runs.forEach((run, ri) => {
      const path = (run.path || []).filter(([c, r]) => c < g.cols && r < g.rows);
      if (!path.length) return;
      const color = run.color || RUN_COLORS[ri % RUN_COLORS.length];
      const active = !o.activeRunId || run.id === o.activeRunId;
      ctx.globalAlpha = active ? 1 : 0.28;

      // home-run stub from outside the wall into the first panel
      const [c0, r0] = path[0];
      const first = panelCenter(g, c0, r0);
      const p0 = panelRect(g, c0, r0);
      const edge = entryEdge(run, g, c0, r0);
      const stub = unit * 0.45;
      const stubStart = {
        left: { x: p0.x - stub, y: first.y },
        right: { x: p0.x + p0.w + stub, y: first.y },
        top: { x: first.x, y: p0.y - stub },
        bottom: { x: first.x, y: p0.y + p0.h + stub },
      }[edge];
      // Clamp the entry marker into the drawable area. `bounds` lets callers
      // with a margin (the editor and the exported diagram) put home-run
      // markers and port labels OUTSIDE the wall, the way wiring diagrams are
      // drawn; on the wall itself bounds is the wall rect, so they tuck inside.
      const B = o.bounds || { x0: 0, y0: 0, x1: g.width, y1: g.height };
      const pad = dot * 1.4;
      stubStart.x = Math.max(B.x0 + pad, Math.min(B.x1 - pad, stubStart.x));
      stubStart.y = Math.max(B.y0 + pad, Math.min(B.y1 - pad, stubStart.y));

      // dark casing under everything for contrast on any pattern
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = lw * 2.1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(stubStart.x, stubStart.y);
      ctx.lineTo(first.x, first.y);
      for (let i = 1; i < path.length; i++) {
        const p = panelCenter(g, path[i][0], path[i][1]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // colored cable: solid between adjacent panels, dashed on jumper runs
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(stubStart.x, stubStart.y);
      ctx.lineTo(first.x, first.y);
      ctx.stroke();
      for (let i = 1; i < path.length; i++) {
        const [pc, pr] = path[i - 1];
        const [cc, cr] = path[i];
        const a = panelCenter(g, pc, pr);
        const b = panelCenter(g, cc, cr);
        const adjacent = Math.abs(cc - pc) + Math.abs(cr - pr) === 1;
        ctx.setLineDash(adjacent ? [] : [lw * 1.6, lw * 1.4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // direction arrow at the midpoint of every segment
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        arrowHead(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x), lw * 2.4);
      }
      ctx.setLineDash([]);

      // home marker + source label at the stub
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(stubStart.x, stubStart.y, dot * 1.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = Math.max(1, lw * 0.35);
      ctx.stroke();

      // source label sits beside the marker, offset perpendicular to the entry
      // direction so it never lands on the marker or the "1" sequence badge
      const fs = Math.max(9, unit * 0.17);
      const label = run.source || run.name || `Run ${ri + 1}`;
      ctx.font = `bold ${fs}px Menlo, Consolas, monospace`;
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      const bw = tw + fs * 0.5;
      const bh = fs * 1.44;
      let bx, by;
      if (edge === 'left') { bx = stubStart.x - bw - dot * 1.2; by = stubStart.y - bh / 2; }
      else if (edge === 'right') { bx = stubStart.x + dot * 1.2; by = stubStart.y - bh / 2; }
      else if (edge === 'top') { bx = stubStart.x - bw / 2; by = stubStart.y - bh - dot * 1.1; }
      else { bx = stubStart.x - bw / 2; by = stubStart.y + dot * 1.1; }
      bx = Math.max(B.x0 + 2, Math.min(B.x1 - bw - 2, bx));
      by = Math.max(B.y0 + 2, Math.min(B.y1 - bh - 2, by));
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, fs * 0.25);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + fs * 0.25, by + bh / 2);

      // per-panel sequence numbers (install order)
      if (o.showSeq !== false) {
        const sf = Math.max(8, unit * 0.15);
        ctx.font = `bold ${sf}px Menlo, Consolas, monospace`;
        ctx.textAlign = 'center';
        path.forEach(([c, r], i) => {
          // bottom-right corner: keeps the badge off the cable, which runs
          // through the panel centers, and off the A1 coordinate label
          const pr2 = panelRect(g, c, r);
          const x = pr2.x + pr2.w - sf * 1.05;
          const y = pr2.y + pr2.h - sf * 1.05;
          ctx.fillStyle = 'rgba(0,0,0,0.72)';
          ctx.beginPath();
          ctx.arc(x, y, sf * 0.82, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = color;
          ctx.fillText(String(i + 1), x, y);
        });
      }
    });

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  const READOUT_FONTS = {
    mono: 'Menlo, Consolas, monospace',
    sans: '-apple-system, "Helvetica Neue", Arial, sans-serif',
    black: '"Arial Black", "Helvetica Neue", sans-serif',
    condensed: '"Avenir Next Condensed", "Arial Narrow", sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  };

  // Logo image cache: readout.image is a data URL; decode once, notify
  // renderers when ready so static frames re-render with the image.
  let _imgSrc = null, _imgEl = null, _imgReady = false;
  const _imgCbs = [];
  function getReadoutImage(src) {
    if (!src) { _imgSrc = null; _imgEl = null; _imgReady = false; return null; }
    if (src !== _imgSrc) {
      _imgSrc = src;
      _imgReady = false;
      _imgEl = new Image();
      _imgEl.onload = () => { _imgReady = true; _imgCbs.forEach((cb) => { try { cb(); } catch (_) { /* renderer gone */ } }); };
      _imgEl.src = src;
    }
    return _imgReady ? _imgEl : null;
  }

  function drawCenterReadout(ctx, cfg) {
    const w = cfg.wall;
    const readout = cfg.readout || {};
    const font = READOUT_FONTS[readout.font] || READOUT_FONTS.mono;
    const lines = [];
    if (readout.label !== false) {
      const label = cfg.centerLabel || w.name;
      if (label) lines.push({ text: String(label), big: true });
    }
    if (readout.dims) lines.push({ text: dimsText(w), big: false });
    const img = getReadoutImage(readout.image);
    if (!lines.length && !img) return;

    const big = Math.max(9, Math.min(w.width, w.height) * 0.11);
    const small = big * 0.42;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // fit each line to 90% of wall width independently — a long dimensions
    // line must not shrink the big label
    let maxW = 0;
    for (const l of lines) {
      const base = l.big ? big : small;
      ctx.font = `bold ${base}px ${font}`;
      const tw = ctx.measureText(l.text).width;
      l.size = base * Math.min(1, (w.width * 0.9) / Math.max(1, tw));
      maxW = Math.max(maxW, Math.min(tw, w.width * 0.9));
    }
    const heights = lines.map((l) => l.size * 1.35);
    let totalH = heights.reduce((a, b) => a + b, 0);

    // logo below the text — wall-relative sizing so the preview matches outputs
    let imgW = 0, imgH = 0, imgGap = 0;
    if (img && img.width && img.height) {
      const s = Math.min((w.width * 0.4) / img.width, (w.height * 0.22) / img.height);
      imgW = img.width * s;
      imgH = img.height * s;
      imgGap = lines.length ? big * 0.35 : 0;
      maxW = Math.max(maxW, imgW);
      totalH += imgGap + imgH;
    }

    const padX = big * 0.6, padY = big * 0.4;
    const cx = w.width / 2, cy = w.height / 2;

    if (readout.scrim !== false) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(cx - maxW / 2 - padX, cy - totalH / 2 - padY, maxW + padX * 2, totalH + padY * 2, Math.max(3, big * 0.25));
      ctx.fill();
    }

    ctx.fillStyle = '#ffffff';
    let y = cy - totalH / 2;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      ctx.font = `bold ${l.size}px ${font}`;
      ctx.fillText(l.text, cx, y + heights[i] / 2);
      y += heights[i];
    }
    if (imgH) ctx.drawImage(img, cx - imgW / 2, y + imgGap, imgW, imgH);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Loop periods. A clip only loops seamlessly if it covers a whole number of
  // animation cycles, so each animated layer reports how long one cycle takes.
  // `exact: false` means the layer has no short repeat — the caller should say
  // so rather than pretend the export loops.
  const PERIODS = {
    radar: (speed) => ({ ms: 4000 / speed, exact: true }),
    ringpulse: (speed) => ({ ms: 2000 / speed, exact: true }),
    wavesweep: (speed, wall, dir) => {
      const span = dir === 'v' ? wall.height : dir === 'd'
        ? Math.hypot(wall.width, wall.height) : wall.width;
      const trail = Math.max(40, span * 0.25);
      return { ms: ((span + trail) / (rate(wall, 250) * speed)) * 1000, exact: true };
    },
  };

  function layerPeriod(kind, type, speed, wall, dir) {
    if (PERIODS[type]) return PERIODS[type](speed, wall, dir);
    if (kind === 'pattern') {
      if (type === 'colorcycle') return { ms: (CYCLE_COLORS.length * 1000) / speed, exact: true };
      if (type === 'panelchase') {
        const g = wallGrid(wall);
        return { ms: (g.cols * g.rows * 1000) / speed, exact: true };
      }
      // Pixel Walk repeats only after lcm(width,height) steps and Motion Test
      // combines three incommensurable rates — neither has a usable short loop.
      if (type === 'pixelwalk' || type === 'motion') return { ms: 0, exact: false };
    }
    return null; // static layer
  }

  const gcd = (a, b) => (b < 1e-6 ? a : gcd(b, a % b));

  // Smallest span covering whole cycles of every animated layer.
  function loopPeriod(cfg) {
    const wall = cfg.wall;
    const parts = [];
    const p = layerPeriod('pattern', cfg.pattern.type, cfg.pattern.speed || 1, wall, cfg.pattern.dir);
    if (p) parts.push(p);
    if (cfg.overlay && cfg.overlay.type && cfg.overlay.type !== 'none') {
      const o = layerPeriod('overlay', cfg.overlay.type, cfg.overlay.speed || 1, wall, cfg.overlay.dir);
      if (o) parts.push(o);
    }
    if (!parts.length) return { ms: 0, exact: true, animated: false };
    if (parts.some((x) => !x.exact)) return { ms: 0, exact: false, animated: true };

    // combine by least common multiple, with a tolerance so floating periods
    // (the wave sweep is rarely a round number) still line up
    let ms = parts[0].ms;
    for (let i = 1; i < parts.length; i++) {
      const b = parts[i].ms;
      ms = (ms * b) / gcd(Math.max(ms, b), Math.min(ms, b));
      if (!isFinite(ms) || ms > 120000) return { ms: parts[0].ms, exact: false, animated: true };
    }
    return { ms, exact: true, animated: true };
  }


  // Wall identity colours. In a multi-wall show it is hard to tell which feed
  // is which; giving each wall its own colour makes that obvious at a glance.
  // Colour-critical patterns are deliberately left alone — tinting Colour Bars,
  // a Gradient or Gray Steps would destroy the thing they exist to measure.
  const WALL_COLORS = [
    '#3fa9f5', '#3fb950', '#f5a623', '#e5534b', '#bd93f9',
    '#00d4c8', '#ff79c6', '#9fd356', '#ffd166', '#7aa2f7', '#c0c0c0',
  ];
  const COLOR_CRITICAL = ['colorbars', 'gradient', 'graysteps'];

  // A dimmed companion, so a new wall has a usable two-tone identity without
  // anyone picking a second colour by hand.
  function dimColor(hex, f) {
    const n = parseInt(String(hex || '#3fa9f5').slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  // Which of the pattern's own colours the wall identity replaces. The UI uses
  // this to retarget that picker, so the control never sits there looking
  // editable while being silently overridden.
  function wallColorParam(type) {
    if (COLOR_CRITICAL.indexOf(type) !== -1) return null;
    if (type === 'solid') return 'bg';
    if (type === 'panelmap') return 'panelA';
    return 'fg';
  }

  // Patterns whose two colours are both panel fills — a checkerboard either
  // way — take both wall colours. Everywhere else the second colour is a
  // background, which should stay the operator's choice rather than becoming
  // an identity colour.
  function wallColorParam2(type) {
    if (type === 'panelmap') return 'panelB';
    if (type === 'checker') return 'bg';
    return null;
  }

  function wallPattern(pattern, wall, mode) {
    if (mode !== 'perWall' || !wall || !wall.color) return pattern;
    if (COLOR_CRITICAL.indexOf(pattern.type) !== -1) return pattern;
    const out = { ...pattern };
    // Solid has no foreground, so its background IS the colour; Panel Map keeps
    // its checkerboard but takes the wall colour as one of the two tiles.
    if (pattern.type === 'solid') out.bg = wall.color;
    else if (pattern.type === 'panelmap') out.panelA = wall.color;
    else out.fg = wall.color;
    const second = wallColorParam2(pattern.type);
    if (second) out[second] = wall.color2 || dimColor(wall.color, 0.35);
    return out;
  }

  function drawDynamicLayers(ctx, cfg, t) {
    const ovCfg = cfg.overlay;
    const ov = ovCfg && OVERLAYS[ovCfg.type];
    if (ov && ov.draw) {
      ctx.save();
      ctx.globalAlpha = (ovCfg.opacity == null ? 70 : ovCfg.opacity) / 100;
      ov.draw(ctx, cfg, t);
      ctx.restore();
    }
    drawCenterReadout(ctx, cfg);
  }

  // Single entry point: base pattern, overlay pulse, then center readout.
  function renderFrame(ctx, cfg, t) {
    const pat = PATTERNS[cfg.pattern.type] || PATTERNS.grid;
    pat.draw(ctx, cfg, t);
    drawDynamicLayers(ctx, cfg, t);
  }

  // Cached renderer for continuous animation loops. Two offscreen layers:
  // the static base pattern and the (static) center readout, both invalidated
  // by CONFIG OBJECT IDENTITY — callers must hand in a new cfg object when
  // anything changes and reuse the same object across frames. Zero per-frame
  // allocations (no key stringify, no object churn) so GC never hitches the
  // animation loop.
  function createFrameRenderer() {
    const base = document.createElement('canvas');
    const bctx = base.getContext('2d');
    const deco = document.createElement('canvas');
    const dctx = deco.getContext('2d');
    let lastCfg = null;
    let baseValid = false;
    let decoValid = false;
    _imgCbs.push(() => { decoValid = false; }); // logo decoded — redraw readout layer
    return function render(ctx, cfg, t) {
      if (cfg !== lastCfg) { lastCfg = cfg; baseValid = false; decoValid = false; }
      const w = cfg.wall;
      if (base.width !== w.width) { base.width = w.width; deco.width = w.width; baseValid = false; decoValid = false; }
      if (base.height !== w.height) { base.height = w.height; deco.height = w.height; baseValid = false; decoValid = false; }
      const pat = PATTERNS[cfg.pattern.type] || PATTERNS.grid;
      if (pat.animated) {
        pat.draw(ctx, cfg, t);
      } else {
        if (!baseValid) { pat.draw(bctx, cfg, t); baseValid = true; }
        ctx.drawImage(base, 0, 0);
      }
      const ovCfg = cfg.overlay;
      const ov = ovCfg && OVERLAYS[ovCfg.type];
      if (ov && ov.draw) {
        ctx.save();
        ctx.globalAlpha = (ovCfg.opacity == null ? 70 : ovCfg.opacity) / 100;
        ov.draw(ctx, cfg, t);
        ctx.restore();
      }
      if (!decoValid) {
        dctx.clearRect(0, 0, deco.width, deco.height);
        drawCenterReadout(dctx, cfg);
        decoValid = true;
      }
      ctx.drawImage(deco, 0, 0);
    };
  }

  function frameAnimated(cfg) {
    if (PATTERNS[cfg.pattern.type] && PATTERNS[cfg.pattern.type].animated) return true;
    return !!(cfg.overlay && cfg.overlay.type && cfg.overlay.type !== 'none');
  }

  window.LED_PATTERNS = PATTERNS;
  window.LED_CREATE_FRAME_RENDERER = createFrameRenderer;
  window.LED_ON_IMAGE_READY = (cb) => _imgCbs.push(cb);
  window.LED_PATTERN_IS_ANIMATED = (type) => !!(PATTERNS[type] && PATTERNS[type].animated);
  window.LED_OVERLAYS = OVERLAYS;
  window.LED_RENDER_FRAME = renderFrame;
  window.LED_FRAME_ANIMATED = frameAnimated;
  window.LED_WALL_GRID = wallGrid;
  window.LED_COL_LETTER = colLetter;
  window.LED_WALL_SEGMENTS = wallSegments;
  window.LED_WALL_IS_SPLIT = wallIsSplit;
  window.LED_SPLIT_SPANS = splitSpans;
  window.LED_NOW = now;
  window.LED_LOOP_PERIOD = loopPeriod;
  window.LED_WALL_PATTERN = wallPattern;
  window.LED_WALL_COLORS = WALL_COLORS;
  window.LED_WALL_COLOR_PARAM = wallColorParam;
  window.LED_WALL_COLOR_PARAM2 = wallColorParam2;
  window.LED_DIM_COLOR = dimColor;
  window.LED_DRAW_CABLING = drawCabling;
  window.LED_RUN_LOAD = runLoad;
  window.LED_RUN_COLORS = RUN_COLORS;
  window.LED_PANEL_RECT = panelRect;
})();

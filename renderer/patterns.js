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

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Spreadsheet-style column letters: 0->A, 25->Z, 26->AA ...
  function colLetter(i) {
    let s = '';
    i = i | 0;
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }

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
        const { width: w, height: h } = cfg.wall;
        const step = Math.max(2, cfg.pattern.size | 0);
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        for (let x = 0; x < w; x += step) ctx.fillRect(x, 0, 1, h);
        for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, 1);
        ctx.fillRect(w - 1, 0, 1, h);
        ctx.fillRect(0, h - 1, w, 1);
      },
    },

    checker: {
      name: 'Checkerboard',
      params: ['fg', 'bg', 'size'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const s = Math.max(1, cfg.pattern.size | 0);
        fillBG(ctx, cfg);
        ctx.fillStyle = cfg.pattern.fg;
        for (let y = 0, ry = 0; y < h; y += s, ry++) {
          for (let x = (ry & 1) ? s : 0; x < w; x += s * 2) {
            ctx.fillRect(x, y, Math.min(s, w - x), Math.min(s, h - y));
          }
        }
      },
    },

    panelmap: {
      name: 'Panel Map',
      params: ['fg', 'bg'],
      draw(ctx, cfg) {
        const { width: w, height: h } = cfg.wall;
        const g = wallGrid(cfg.wall);
        fillBG(ctx, cfg);
        // subtle alternate-panel tint so seams are obvious even without borders
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            if ((r + c) & 1) ctx.fillRect(g.xs[c], g.ys[r], g.colWidths[c], g.rowHeights[r]);
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
            ctx.fillStyle = cfg.pattern.fg;
            ctx.font = `bold ${big}px Menlo, monospace`;
            ctx.fillText(colLetter(c) + (r + 1), cx, cy + big * 0.35);
            if (ph >= 48) {
              const small = Math.max(6, Math.floor(big * 0.4));
              ctx.font = `${small}px Menlo, monospace`;
              ctx.fillText(`${pw}×${ph}`, cx, cy + big * 0.35 + small * 1.4);
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
        const ang = (t / 4000) * speed * Math.PI * 2;
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
        const pos = ((t / 1000) * 250 * speed) % (span + trail);
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
        const px = (t / 1000) * 120 * speed;
        const rangeX = Math.max(1, w - box), rangeY = Math.max(1, h - box);
        const bx = Math.abs(((px) % (rangeX * 2)) - rangeX);
        const by = Math.abs(((px * 0.7) % (rangeY * 2)) - rangeY);
        ctx.fillRect(Math.floor(bx), Math.floor(by), box, box);
        // sweeping vertical bar for judder
        const barX = Math.floor(((t / 1000) * 60 * speed) % w);
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
        const ang = (t / 4000) * (o.speed || 1) * Math.PI * 2;
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
        const pos = ((t / 1000) * 250 * (o.speed || 1)) % (span + trail);
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

  // Single entry point: base pattern, then overlay pulse composited on top.
  function renderFrame(ctx, cfg, t) {
    const pat = PATTERNS[cfg.pattern.type] || PATTERNS.grid;
    pat.draw(ctx, cfg, t);
    const ovCfg = cfg.overlay;
    const ov = ovCfg && OVERLAYS[ovCfg.type];
    if (ov && ov.draw) {
      ctx.save();
      ctx.globalAlpha = (ovCfg.opacity == null ? 70 : ovCfg.opacity) / 100;
      ov.draw(ctx, cfg, t);
      ctx.restore();
    }
  }

  function frameAnimated(cfg) {
    if (PATTERNS[cfg.pattern.type] && PATTERNS[cfg.pattern.type].animated) return true;
    return !!(cfg.overlay && cfg.overlay.type && cfg.overlay.type !== 'none');
  }

  window.LED_PATTERNS = PATTERNS;
  window.LED_PATTERN_IS_ANIMATED = (type) => !!(PATTERNS[type] && PATTERNS[type].animated);
  window.LED_OVERLAYS = OVERLAYS;
  window.LED_RENDER_FRAME = renderFrame;
  window.LED_FRAME_ANIMATED = frameAnimated;
  window.LED_WALL_GRID = wallGrid;
  window.LED_COL_LETTER = colLetter;
})();

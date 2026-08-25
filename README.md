# Lattice

Free, cross-platform LED wall test pattern generator. One control window; live fullscreen
test-pattern feeds on any number of connected outputs — a one-stop shop for whatever show
wall configuration you're facing.

## Install

Grab the latest installer from [Releases](https://github.com/YoshiBowman/Lattice/releases)
(macOS DMG, Windows NSIS, Linux AppImage). Installed builds **auto-update over the air**:
the app checks GitHub releases on launch and every 4 hours, downloads in the background,
and installs on quit (or immediately via the Restart & Update button).

## Run from source

```bash
npm install
npm start
```

## Release a new version

Bump `version` in `package.json`, commit and push, then publish the release
(uploads installers + `latest*.yml` auto-update metadata to GitHub):

```bash
GH_TOKEN=<github-token-with-repo-scope> npm run release
```

Every installed copy picks the new version up over the air (checked on launch and
every 4 hours; downloads in background; installs on quit or via Restart & Update).

### Optional: CI releases on tag push

`.github/workflows/build.yml` builds macOS/Windows/Linux and publishes the release
whenever a `v*` tag is pushed — but the GitHub token currently stored on this machine
lacks the `workflow` scope, so the file is gitignored. To enable: configure a token
with `repo` + `workflow` scopes (or add the file once via the GitHub web UI), remove
the `.github/workflows/` line from `.gitignore`, and push. From then on:

```bash
git tag v<version> && git push origin main --tags
```

## What it does

- **Show files** — Save Show / Load Show (.lattice) capture everything: every wall, pattern
  and overlay settings, label/readout styling including the logo, virtual outputs and all
  output assignments (scale mode, crop, position). Build the show at home, load it at the
  venue. The control window is organized in three columns: **Walls** (geometry), **content**
  (pattern / overlay pulse / label & readout), and **Preview + Outputs** (routing).

- **Multiple walls** — build every wall in the show as its own entry (name, size, panel
  layout, orientation): 11 walls of 11 different shapes is a normal day. Select a wall to
  edit it, duplicate for variants, and pick its destination from the **Send to output**
  dropdown — any physical display, any virtual output, or a new virtual window — which
  assigns and starts it in one step. The whole show can be pre-vis'd and mapped before a
  single processor is connected. Pre-vis windows resize freely: fit letterboxes, fill
  crops, stretch fills the window, 1:1 shows true pixels.
- **Wall colours** — tick "Colour each wall differently" and every wall takes its own
  identity colour from a palette, so several walls running at once are told apart at a
  glance. Both colours are yours to set: the pattern's colour pickers retarget to the
  selected wall (labelled "STAGE LEFT colour" / "colour 2"), so patterns that fill two
  colours — Panel Map, Checkerboard — carry a full two-tone identity per wall rather than
  sharing one global second tile. A plain background stays a background. Colour-critical
  patterns — Colour Bars, Gradient, Gray Steps — are deliberately left untinted, since
  tinting them would destroy what they measure.
- **Wall setup** — define panels the way spec sheets do: **physical size (mm) + pixel
  pitch** (e.g. 500×500 mm @ 2.9 → 172×172 px per panel, with 500×500 / 500×1000 mm and
  P1.9–P5.2 quick presets), or enter pixels directly. Set panel count and the wall canvas
  plus physical dimensions in meters are computed. Or switch to **Manual grid** and enter
  per-column widths and per-row heights for mixed cabinet sizes. Panels are addressed
  spreadsheet-style: letters across (A, B, C…), numbers down (1, 2, 3…) — A1, B1, C2.
  A custom total resolution override is also available.
- **Overlay pulses** — Resolume-style: a Radar Sweep, Ring Pulse, or Wave Sweep animates
  **over** the active test pattern (adjustable color, opacity, speed, direction), so you
  can watch a pulse travel across panel seams while the mapping pattern stays up.
- **Distortion circles** — tick it under the Grid or Panel Map pattern for the circularity
  check a pixel test slate carries: equal circles, each as tall as the wall, tiled tangent
  across the span. A circle is the one shape whose distortion you can't talk yourself out
  of — a grid stretched 5% on an axis still looks like a grid, while a 5% oval is obvious
  from the back of the room. Keeping every circle the same size is the point: one going
  oval is directly comparable against its neighbours, and a wall four circles long gets
  checked end to end rather than by one big circle in the middle. The circles at the ends
  run off the edge, which is where a cropped or misplaced capture window shows itself. If
  a circle reads as an oval, the image is being scaled: check the processor's input
  resolution and scaling mode before touching the wall. **Circle thickness** is yours to
  set (1–16 px, default a 2 px hairline) — they are drawn as a plain line in the pattern's
  foreground colour, with no outline. They span output boundaries on a split wall, so a
  circle that steps at the seam means the two feeds don't line up. On Panel Map the circles
  pass behind the panel coordinates rather than striking through them, so one image gives
  you panel names and a geometry check at the same time; on a Black / White panel pair a
  white circle disappears against the white tiles exactly as the white seam lines do —
  pick a foreground colour that contrasts both.
- **Patterns** — Solid Color, Color Bars, Grid, Checkerboard, Panel Map (a two-colour checkerboard of
  panels — pick both colours or use a preset pair — with A1…Z9 coordinates and
  per-panel pixel size, the labels auto-contrasting against whichever colour the
  panel carries), **Panel Chase** (lights each panel in order
  with its coordinate — mapping verification), **Radar Sweep**, **Ring Pulse**, **Wave
  Sweep** (horizontal/vertical/diagonal pulse with trail), Gradient (gray/R/G/B/hue),
  Gray Steps (banding), Geometry (circles/crosshair/diagonals), 1px Lines (moiré/pixel
  pitch), Pixel Walk, Color Cycle, Motion Test (judder/latency, frame counter).
  Foreground/background colors, size/spacing, speed, and direction adjustable per pattern.
- **Cabling** — lay out signal and power home runs per wall. Each run is a cable leaving a
  processor port (or a circuit breaker), entering the wall at its first panel and daisy-
  chaining onward; multiple runs per wall per layer. Click or drag panels in the Cabling tab
  to lay cable, or **Auto-route** with serpentine (S-route) / straight (Z-route) patterns,
  choice of axis and start corner. The diagram shows direction arrows, install sequence
  numbers, home-run entry markers with port labels in the margin, and dashes the long jumper
  cables between non-adjacent panels. Live load checks: signal against a pixels-per-port
  budget, power against volts × amps × NEC 0.8 derate — over-limit runs, double-fed panels
  and unassigned panels are all flagged. **Pick your processor** (NovaStar VX4S/VX600/
  VX1000/VX16s/MCTRL660/MCTRL660 PRO/MCTRL4K/MX40 Pro, Brompton Tessera S4/S8/SX40/SQ200,
  Megapixel HELIOS, Colorlight Z6 Pro, DBSTAR HVT09/HVT11/HVT13VP/HVT13VP-M) to load its
  real per-port budget, and Lattice also checks your run
  count against its port count and the wall against its total capacity. Values stay
  editable — capacity varies with colour depth and frame rate. Export a wiring diagram PNG, or
  select the **Cabling Map** test pattern to display the diagram on the wall itself.
- **Output labels & center readout** — name each output (e.g. "STAGE LEFT WALL"); the label
  renders into the pattern itself, centered, live as you type (falls back to the wall name).
  Toggles for a wall-dimensions line (px · panels · meters) and the backdrop box; five font
  choices; optional **logo PNG** rendered under the text. All of it shows identically on
  outputs, the preview and exports.
- **One wall across several outputs** — set "Split across outputs" on a wall and Lattice
  divides it into segments **measured in panels**, so a 9 × 11 wall can go out as a 9 × 4
  top and a 9 × 7 bottom rather than being cut in half. Boundaries therefore always land on
  panel seams. Wall Setup then shows **one dropdown per segment** — send segment 1 to an SDI
  port, segment 2 to a display — and each output's crop follows from its segment, so nobody
  works out pixel offsets by hand. Optional overlap covers rigs whose feeds deliberately
  share pixels, and the preview draws the numbered feed boundaries.
- **Output position** — Pos X/Y on every output shifts where the image lands in the frame
  (LED processors often capture a region that doesn't start at the frame's top-left).
  Works in every scale mode; in 1:1, Crop X/Y picks the wall region and Pos X/Y places it.
  **Arrow keys on an output window nudge position live** (Shift = 10 px).
- **Virtual outputs** — add windowed outputs at any resolution (e.g. four 1920×1080
  "processor feeds") with no physical hardware connected. Each behaves exactly like a real
  output — scale modes, 1:1 region offsets, labels — so the whole show can be mapped out in
  advance. Remove them with ✕ when done.
- **Export PNG** — save the current wall frame (pattern + overlay) at native wall
  resolution, e.g. to load into a media server or send to the LED vendor.
- **Export Loop** — render an animated pattern or overlay pulse as a **seamlessly looping
  clip** for a media server, so the wall can be tested without Lattice running. Lattice
  computes the exact loop length from the animation itself (a radar sweep at speed 1 is
  4.00 s; a colour cycle over a radar sweep is 8.00 s) and renders precisely that many
  frames, so the frame after the last *is* the first. Formats:
  **PNG image sequence** — lossless and what Hippotizer, Resolume and disguise ingest
  natively; **MP4 (H.264, CRF 16)** when ffmpeg is installed, high enough quality that
  single-pixel grid lines survive; **WebM (VP9)** for VLC or a quick check.
  Motion Test and Pixel Walk never return to their exact start, and the dialog says so
  rather than exporting a clip that jumps.
- **Live preview** — the control window previews exactly what outputs render (same code).
- **Multiple outputs** — every display the OS sees gets a card: graphics card outputs
  (HDMI/DP/Thunderbolt), and playback/SDI cards whose drivers present them as displays.
  Start/stop each independently; all outputs follow the pattern live.
- **Scaling per output** — Fit (letterbox), Fill, Stretch, or **1:1 pixel** with X/Y offset,
  so a wall larger than one output can be split across several outputs, each showing its
  own region at true pixel scale (image smoothing off everywhere).
- **Identify** — flashes a big number on every physical display so you know which is which.
- ESC on an output closes it. Config persists between launches.

## Notes

- On macOS, outputs use simple-fullscreen (no Spaces animation), so multiple outputs on
  multiple displays behave predictably.
- For pixel accuracy on HiDPI/Retina outputs, the canvas renders at the display's physical
  pixel resolution; use 1:1 mode for true pixel mapping.

## Roadmap

- Native Blackmagic DeckLink SDI/HDMI playback output (via Desktop Video SDK — e.g. the
  `macadam` Node bindings) for cards that don't present as displays
- NDI output
- Custom image/logo test slides, per-output pattern override
- Wall presets (save/load named venue configurations)
- Test pattern scheduling / DMX-triggered pattern changes (tie-in with RDM Explorer)

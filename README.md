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
- **Patterns** — Solid Color, Color Bars, Grid, Checkerboard, Panel Map (A1…Z9 coordinates
  and per-panel pixel size on seam borders), **Panel Chase** (lights each panel in order
  with its coordinate — mapping verification), **Radar Sweep**, **Ring Pulse**, **Wave
  Sweep** (horizontal/vertical/diagonal pulse with trail), Gradient (gray/R/G/B/hue),
  Gray Steps (banding), Geometry (circles/crosshair/diagonals), 1px Lines (moiré/pixel
  pitch), Pixel Walk, Color Cycle, Motion Test (judder/latency, frame counter).
  Foreground/background colors, size/spacing, speed, and direction adjustable per pattern.
- **Output labels** — name each output (e.g. "STAGE LEFT WALL") and toggle a big on-screen
  overlay so you always know which feed you're looking at; labels also show in Identify.
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

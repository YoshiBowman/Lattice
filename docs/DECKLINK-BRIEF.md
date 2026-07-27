# Lattice — DeckLink SDI output: working brief

Context for a Claude Code session running **on the machine that has the DeckLink
card(s) installed**. Everything here was written from the machine that builds
Lattice but has no DeckLink hardware, which is exactly why this work has to
happen on yours.

---

## 1. What Lattice is

Lattice is an Electron LED-wall test-pattern generator (repo:
`https://github.com/YoshiBowman/Lattice`, run from source with `npm install &&
npm start`, Electron 29.4.6, **currently zero runtime native dependencies**).

Architecture you need to know:

| File | Role |
|---|---|
| `main.js` | Main process. Owns windows and all IPC. `createOutput(display)` opens a fullscreen output on a physical display; `createVirtualOutput(spec)` opens a windowed output at a declared resolution. `outputWins` maps output id → BrowserWindow. |
| `preload.js` | The only main↔renderer bridge (`window.ledwall.*`). |
| `renderer/control.js` | Control window: walls, patterns, outputs, cabling, show files. Owns the config and broadcasts it via `set-config`. |
| `renderer/output.js` | An output window. Renders the assigned wall into an offscreen canvas at **native wall resolution** (`wall` canvas), then `blit()` scales that into the visible canvas per the output's scale mode (`fit` / `fill` / `stretch` / `1to1`) and `posX`/`posY` offsets. |
| `renderer/patterns.js` | All pattern + overlay + cabling drawing. `LED_CREATE_FRAME_RENDERER()` returns a cached renderer used by the animation loop. |

**The key integration point:** `renderer/output.js` already produces a finished
RGBA frame at wall resolution every tick. A DeckLink output is another consumer
of those frames — not a new rendering path.

## 2. Goal

Let a user pick a DeckLink device as an **output** in Lattice's Outputs panel,
alongside physical displays and virtual outputs, and have Lattice play the
selected wall's test pattern out of that card's SDI/HDMI port at the correct
video mode and frame rate.

**Non-goals for now:** capture/input, fill+key, audio, genlock configuration
beyond selecting a reference if trivially available.

## 3. Hard constraints — do not break these

1. **Existing outputs must keep working.** Physical-display and virtual outputs
   are the app's core and are verified working. DeckLink is additive.
2. **DeckLink support must be optional at runtime.** The app is built and
   distributed for machines with no Blackmagic drivers at all. Load any native
   module inside `try/catch` and degrade gracefully — a missing SDK/driver must
   never prevent Lattice from starting or block a scan of normal outputs.
3. **Nothing in the config pipeline may throw.** There is prior history here: a
   failure inside the control window's `push()` once killed `setConfig` and
   silently froze every output. Persist/serialise defensively.
4. **Match the existing code style**: vanilla JS, no frameworks, no build step
   for renderer code, comments that explain *why* rather than *what*.
5. **Work on a branch** (e.g. `decklink`), not `main`. Do not publish releases —
   the release pipeline signs and uploads to GitHub from the other machine.
6. **Verify against real hardware at every phase.** Untested DeckLink code is
   the entire reason this work is on your machine and not the build machine.

## 4. Phase plan — each phase has a verification gate

### Phase 0 — establish ground truth about the hardware

Before any code, find out exactly what is installed. Useful probes on macOS
(adapt for Windows/Linux):

```
ls /Library/Application\ Support/Blackmagic\ Design/
ls /Applications/Blackmagic\ Desktop\ Video/
system_profiler SPPCIDataType | grep -i -A5 blackmagic
system_profiler SPThunderboltDataType | grep -i -A5 blackmagic
ioreg -l | grep -i blackmagic | head
```

Open **Blackmagic Desktop Video Setup** and record: card model(s), how many
sub-devices, Desktop Video driver version, current connector config (SDI vs
HDMI, single vs quad link), and whether each sub-device is set to **playback**,
capture, or half-duplex. Some cards default to capture and must be switched.

**Report:** exact model names, driver version, OS version, and the supported
output modes listed in Desktop Video Setup.

### Phase 1 — get *any* picture out of the card without Lattice

Do not debug two unknowns at once. Prove the card → cable → monitor/processor
path independently first. Fastest options:

- **Blackmagic Media Player / Media Express** playing any clip, or
- **OBS Studio → Tools → Decklink Output**, or
- `ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=60 -f decklink -pix_fmt uyvy422 "DeckLink SDI"`
  (only if the local ffmpeg build has the decklink muxer — `ffmpeg -devices`).

**Gate:** a picture on the downstream device. If this fails, the problem is
hardware/config/cabling and no amount of Lattice code will help.

### Phase 2 — minimal standalone frame push

Write the smallest possible program that pushes a **known test frame** (e.g.
solid magenta, then a 1px grid) to the card, outside Electron. Two viable
routes — evaluate both before committing:

**(a) `macadam`** — Node bindings for the Blackmagic SDK
(`npm i macadam`). Fastest if it builds. Check: does it compile against the
installed Node? Against Electron 29's ABI (`electron-rebuild`)? Is it
maintained enough for your Desktop Video version? If it works, this is the
shortest path.

**(b) A small native helper binary** (C++ against the Blackmagic Desktop Video
SDK, downloaded from Blackmagic's support site — it is not on npm and cannot be
fetched automatically). Lattice spawns it as a child process and streams frames
to it over stdin or shared memory.

**(b) is worth serious consideration** even though it is more code: it decouples
native code from Electron's ABI entirely (no `electron-rebuild`, no per-Electron
rebuilds), isolates crashes from the app, and keeps Lattice's own dependency
tree native-free so existing macOS/Windows/Linux builds and the auto-updater are
unaffected. Recommend a route with reasoning before building it out.

**Gate:** your known test frame visibly on the downstream device, correct
colours, no tearing.

### Phase 3 — integrate into Lattice

Design notes:

- Add a third output kind next to physical and virtual. Enumerate devices in
  the main process and send them to the control window so they appear as cards
  in the Outputs panel with the same controls (label, wall assignment, scale
  mode, Pos X/Y).
- Frames: reuse the existing wall canvas. Getting pixels out of a renderer
  process at 60fps needs care — evaluate an offscreen `BrowserWindow` with
  `webPreferences.offscreen` + `paint` events, or `webContents.capturePage`
  (likely too slow), or rendering the wall in the **main process** via a
  headless canvas. Measure before choosing; the current renderer holds 60fps
  on two simultaneous 4K outputs, and the DeckLink path must not regress it.
- **Pixel format:** canvas gives RGBA; DeckLink wants `bmdFormat8BitBGRA` or
  `bmdFormat8BitYUV` (UYVY). Prefer BGRA if the card accepts it to avoid a
  colour-space conversion; otherwise convert carefully.
- **Timing:** use scheduled playback with a proper frame clock. Do not push
  frames from a `requestAnimationFrame` loop and hope — SDI needs frames at the
  exact mode rate or the card underruns (visible as dropped/repeated frames).

### Phase 4 — the two gotchas that will bite on an LED wall

1. **SDI is locked to standard rasters.** 1920×1080, 3840×2160 etc. An
   arbitrary wall resolution (e.g. 1376×688) cannot be sent as-is. Decide and
   document the behaviour: letterbox the wall inside the raster (`fit`), or run
   `1to1` with the wall pixel-mapped into the top-left of the raster and the
   processor cropping. Lattice's existing scale modes and Pos X/Y already
   express this — reuse them rather than inventing new controls.
2. **Colour range.** SDI is conventionally legal/video range (16–235); LED
   processors are frequently expecting full range (0–255). Mismatch shows as
   crushed blacks and clipped whites. **Test this explicitly** with Lattice's
   **Gray Steps** pattern: all 16 steps must be distinguishable, and pure black
   and pure white must not clip. If the card or SDK offers a range setting,
   surface it in the UI; otherwise document which the output produces.

### Phase 5 — packaging implications (report, do not act)

If the chosen route adds a native dependency, the build/release pipeline on the
other machine changes: per-platform native compilation, the Blackmagic SDK as a
build input, and possible `electron-rebuild` steps. Write up what would be
required rather than changing the release workflow yourself.

## 5. Verification checklist (run on real hardware)

- [ ] Device appears in Lattice's Outputs panel and can be started/stopped
- [ ] Panel Map pattern out of SDI, correct orientation, no mirroring
- [ ] 1:1 mode pixel-exact: a 1px grid shows single-pixel lines, no softening
- [ ] Gray Steps: no black crush, no white clip (colour-range check)
- [ ] Motion Test: smooth, no dropped/stuttering frames over 60+ seconds
- [ ] Two outputs at once (DeckLink + a display) both hold frame rate
- [ ] Unplugging/disabling the card does not crash or hang Lattice
- [ ] Lattice still starts normally on this machine with the DeckLink output
      stopped, and existing display/virtual outputs behave exactly as before

## 5a. Decisions after Phase 0 (added once the hardware was known)

Phase 0 on the target machine found **2 × DeckLink Duo 2** (8 half-duplex
sub-devices, Desktop Video 16.1, macOS 26.5.1 arm64), **SDI only, 1080p60
maximum — no 4K modes at all**, and **no BGRA at 1080p50/59.94/60** (those rates
are YUV 4:2:2 only). Two corrections and four decisions follow from that.

**Correction to §4 gotcha 1:** the brief's "1920×1080, 3840×2160 etc." was
written blind. On Duo 2 the ceiling is 1920×1080. That is not the limitation it
first appears to be — see decision 2.

**Correction to §3 / Phase 2 pixel format:** "prefer BGRA" only holds up to
1080p30. At 1080p50/59.94/60 an RGBA→UYVY conversion is mandatory.

1. **Verification method: SDI loopback, and it is the preferred gate.**
   Play a known frame out of one sub-device, capture it on another, compare
   pixels. This makes Phase 1 and most of the §5 checklist byte-exact instead of
   someone squinting at a monitor, and it is the standard the rest of Lattice is
   held to. Note its one limit: a loopback proves the *card's* path is clean
   (clipping in the encode/decode round trip will show up), but it cannot tell
   you which colour range a downstream **LED processor** expects. That last
   question needs a real processor or reference monitor once, at the end.

2. **Raster strategy: 1:1 with crop is the primary path, not the fallback.**
   1080p is the natural unit here. LED processors take ~1920×1200 class inputs
   by design (a NovaStar MCTRL660's standard input is 1920×1200), so a wall
   larger than one raster is normally split across several feeds anyway — which
   is exactly what Lattice's per-output wall assignment + `1to1` + Crop X/Y
   already express. **Eight sub-devices map cleanly onto eight processor feeds,
   each carrying a 1920×1080 region of a larger wall.** Design for that.
   `fit` remains available for oversized walls but must be labelled in the UI as
   downscaled / not pixel-exact.

3. **Video mode: expose a per-output mode picker; do not hard-code 1080p60.**
   The 60fps-versus-4:4:4 trade-off is real and depends on what is being tested:
   - Grids, Panel Map, Checkerboard, Gray Steps are luma-contrast and survive
     4:2:2 fine — 1080p60 is right for them.
   - Motion Test is meaningless below 60fps.
   - Colour Bars and coloured single-pixel detail need 4:4:4, so 1080p30 or
     720p60.
   Default to 1080p59.94/60, and surface a warning when the selected mode
   subsamples chroma so the operator knows a colour-critical check is
   compromised. Let them choose rather than choosing for them.

4. **Route: (b), the standalone native helper — confirmed.** macadam vendoring
   SDK 10.11.2 headers against a 16.1 driver, last released at 2.0.18, plus an
   Electron 29 arm64 ABI rebuild, is too much fragility to attach to the release
   pipeline. Keep Lattice's dependency tree native-free. Design notes for the
   helper:
   - **Frame transport must be shared memory, not a stdin pipe.** 1920×1080
     BGRA at 60fps is ~500 MB/s; use an mmap'd ring buffer for pixels with a
     small stdin/socket channel for control messages (start, stop, mode change)
     and back-pressure.
   - **Get frames out of Electron via an offscreen `BrowserWindow`**
     (`webPreferences: { offscreen: true }`, `setFrameRate(60)`, `paint` event).
     It hands you a raw **BGRA** buffer per frame, which is already the format
     the card wants for ≤1080p30 and the natural input for the UYVY conversion.
     Rule out `webContents.capturePage` — far too slow for 60fps.
   - **Do the RGBA/BGRA→UYVY conversion in the helper using vImage**
     (Accelerate.framework — present on every Mac, no new dependency,
     SIMD-optimised). Keep it off the JS main thread.
   - Frame pacing is the risk to watch: the existing renderer holds 60fps on two
     simultaneous 4K outputs, and the DeckLink path must not regress that.

5. **Device naming:** the sub-device labels are cosmetic user strings — one
   card's are "Input 1–4". Show the card model plus sub-device index in
   Lattice's UI (e.g. "DeckLink Duo 2 — SDI 3"), not the stored label, or an
   output will appear named "Input 3".

## 6. What to report back

1. Hardware/driver/OS specifics from Phase 0.
2. Which route you chose in Phase 2 and **why** (build success, ABI issues,
   maintenance state).
3. Measured frame rate and any dropped-frame behaviour.
4. The answers to the two Phase 4 gotchas: which raster strategy, and which
   colour range the output produces.
5. Anything that had to change in existing files, so it can be reviewed against
   the invariants in §3.

Push the branch when there is something working, even partially — a verified
Phase 2 prototype is more valuable than an unverified full integration.

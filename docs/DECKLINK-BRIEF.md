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

## 5b. Phase 1/2 outcome (measured on the hardware machine)

**Cabling — CORRECTED 2026-08-03 by the operator. Read the correction before
the measurement.**

The matrix scan of all 56 ordered port pairs found: no incoming signal on any of
card #1's ports, live external signal at 1080i59.94 on all four of card #2's
(SDI 4 carrying moving content), and zero loopback pairs.

That was over-interpreted as "card #1's BNCs are unconnected". **Both cards are
in fact cabled.** Card #2 is the input card, fed by external sources. Card #1 is
the **output card, and its four ports already run to downstream devices.**

**The blind spot to remember: an SDI output port with a cable running downstream
is indistinguishable from an empty port.** The card sees no incoming signal
either way and cannot sense a passive load at the far end. "No signal received"
means nothing is *feeding* the port — never that nothing is *attached* to it.
The passive scan is therefore a detector for incoming feeds only, not for
cables, and the "reliable cable detector" claim in the earlier session was
wrong.

Consequences, in order of importance:

1. **Phase 1's gate may already be satisfiable with no new cable at all.** Card
   #1's outputs are idle (radiating black, so nothing else is driving them) and
   already connected to something. Transmitting a test pattern and having the
   operator look at whatever those cables feed satisfies "a picture on the
   downstream device" today.
2. **If those cables reach an LED processor or wall, that is strictly more
   valuable than the loopback**, because it answers the legal-vs-full range
   question that §5a decision 1 says loopback can never settle.
3. **Ask before transmitting.** Anything sent on card #1 now lands on real
   downstream equipment. Establish what is on the far end first. (Note: the
   topology scans already transmitted mid-grey on these ports.)
4. The byte-exact loopback is still worth having for pixel-exactness, but it now
   requires temporarily borrowing a port — either freeing one of card #1's
   outputs to loop back into another, or freeing one of card #2's inputs to
   receive from card #1 — rather than plugging in a spare cable.

### The return path exists already — via the Videohub

**Both cards land on a Blackmagic Videohub**: card #1's outputs feed hub inputs,
card #2's inputs come from hub outputs. **Routing a card #1 source to a card #2
destination creates the loopback in software, with no recabling.** This is
better than a direct BNC jumper — the signal traverses the real show path, and
an SDI router is a bit-transparent crosspoint, so the byte-exact comparison
still holds.

- Start with **one pair** to prove the path (card #1 SDI 1 → card #2 SDI 1),
  then extend to the rest.
- Note what is being displaced: card #2's inputs currently carry live external
  signal, one with moving content. Confirm before overwriting those routes.
- **If the Videohub is on the network, automate it.** Blackmagic's Videohub
  Ethernet Protocol is a plain-text TCP service on **port 9990** — connect and
  send `VIDEO OUTPUT ROUTING:\n<output> <input>\n\n`. That makes the whole
  verification matrix scriptable: route, transmit, capture, compare, re-route,
  unattended. Worth building into the harness rather than driving the hub by
  hand.
- Once the card's output is proven byte-exact, **routing it onward to an LED
  processor or the wall answers the legal-vs-full range question** that
  loopback alone can never settle (§5a decision 1).

**Phase 2 helper (`latticeout`) is built and verified on hardware**: universal
arm64+x86_64, links only CoreFoundation and Accelerate.

| Check | Result |
|---|---|
| 1080p59.94, UYVY via vImage, 65 s | 3896/3896 frames, 0 late, 0 dropped |
| Two simultaneous 1080p59.94 outputs, 65 s | both 3896/3896, 0 late, 0 dropped |
| 1080p30, native BGRA, 8 s | 238/240, 0 late, 0 dropped |
| Enumeration + naming | 8 devices, matches ground truth |
| Refuses to open output on a receiving port | exits 3 |

The 60fps UYVY conversion holding frame rate closes the main open risk in
decision 4.

**Still unproven — and it is the actual Phase 2 gate:** that the pixels leaving
the connector are the pixels we sent. Everything above is what the card reports
about its own scheduling. 1:1 pixel-exactness, Gray Steps crush/clip and the
legal-vs-full range answer all remain blocked on the loopback cable.
`tools/loopscan.cpp` already does content-correlated capture-and-compare.

**Bug worth remembering (same class as the two silent failures already fixed in
Lattice):** `bmdDeckLinkStatusVideoInputSignalLocked` queried cold is always
false — it only means anything once video input is enabled and streaming. The
port-safety guard therefore reported "no signal" on every port including four
known-receiving ones, and would never have fired. Fixed by enabling input to
sample, with the settle time raised 900 ms → 1.6 s (at 900 ms only one of four
receiving ports had locked).

## 5c. Open question before Phase 3: sub-device pairing

One unreproduced observation: transmitting on card #2 SDI 3 caused SDI 4 to lose
its input signal entirely, while the reverse did not. This may be the same
phenomenon as the `ProfileFourCC = '2dhd'` in the prefs plist that was dismissed
in Phase 0 as contradicting the API's four enumerating sub-devices.

**This must be pinned down before the UI exposes eight outputs**, because the
whole "8 sub-devices = 8 processor feeds" design in decision 2 assumes the ports
are independent. If connectors pair in the active profile, a Duo 2 gives fewer
usable simultaneous outputs than it enumerates, and starting one Lattice output
could disturb a neighbouring port.

Investigate via the API rather than the plist:

- `IDeckLinkProfileManager` / `IDeckLinkProfile` — read the **active** profile
  and enumerate the available ones per card.
- Duo 2 profiles pair connectors in the duplex configurations; the one we want
  is four sub-devices half-duplex, which the four enumerating sub-devices
  suggest is already active. If it is, the interference needs another
  explanation — try to reproduce it deterministically (transmit on 3, sample 4,
  repeat; then all other ordered pairs) before assuming pairing.
- If reproducible, record which pairs interact and either constrain the UI to
  the safe set or set the profile explicitly at start-up.

### 5c resolved — the ports ARE independent

The pairing hypothesis is **refuted**; the original sighting was a measurement
artefact. Control-vs-test trials across every ordered pair:

| Settle | Result |
|---|---|
| 900 ms | sporadic failures, control clean |
| 1200 ms | sporadic failures **including the control row** (an input dropped with nobody transmitting) |
| 1600 / 2000 ms | 100 %, every ordered pair, identical to control |

An input dropping out while nothing transmits rules transmission out as the
cause, and the original observation came from `loopscan`, which used exactly
1200 ms. Re-reading the two original runs corroborates it independently: the
interference appeared in run 1 but not run 2, and run 2 showed a card #1 →
card #2 dropout that connector pairing cannot explain at all.

**"8 sub-devices = 8 processor feeds" therefore holds and the Phase 3 UI needs
no constraining.** `loopscan`'s settle was raised 1200 → 2200 ms, since a false
negative there would have read as "the loopback isn't working".

**Constraint that generalises — no fixed settle constants anywhere.** The margin
between flaky and clean is ~400 ms and will move with signal type and driver
version. Poll for lock with a timeout, or drive off the input format-changed
callback. `latticeout`'s 1.6 s enumeration sleep is the same fragile pattern and
should be replaced when the frame transport goes in.

The `IDeckLinkProfileManager` readout could not be done: that interface arrived
in **SDK 11.0** and is absent from the 10.11.2 headers vendored by macadam,
which is all the machine has. Declining to hand-declare an interface with a
guessed IID was the right call. It is now confirmation rather than new
information — "which ports actually interfere" is what Phase 3 needed, and the
empirical answer is better evidence than the nominal profile.

## 5e. Phase 3 — authorised, with these constraints

1. **Missing helper is a normal state**, not an error: no binary, no driver, or
   no card means Lattice simply offers no DeckLink outputs and behaves exactly
   as it does today. This is §3 constraint 2 and is not negotiable.
2. **No fixed sleeps** in device enumeration or start-up — see above.
3. **Reuse the existing output card UI.** A DeckLink output gets the same
   controls as any other: label, wall assignment, scale mode, Pos X/Y, Crop X/Y
   in 1:1. Do not invent a parallel control surface.
4. **Naming:** card model + sub-device index ("DeckLink Duo 2 — SDI 3"), never
   the stored `CardInfoLabel`.
5. **Per-output video mode picker** with a chroma-subsampling warning at
   1080p50/59.94/60 (decision 3).
6. **Keep the port-safety guard.** Never open output on a sub-device that is
   receiving; surface why rather than failing silently.
7. **Helper lifecycle must not take Lattice down.** A crashed or exiting helper
   should surface an actionable message and allow restart — model it on the
   updater's failure handling, which now reports the reason and offers a
   fallback rather than dying quietly.
8. **No regression:** the renderer holds 60 fps on two simultaneous 4K outputs
   today. Measure before and after.

Open design question, your call with reasoning: **one helper process per output,
or one helper managing all devices?** Per-output gives crash isolation and
simpler shared-memory ownership; a single helper has less process overhead and
you have already proven two concurrent outputs work inside one process. Lean
per-output for isolation unless measurement says otherwise.

## 5g. Gate passed; 3G refused by the rig (site-specific, unresolved)

**The byte-exact gate is closed.** Run through the Videohub loopback, it passes
identically at 1080p30 and 1080p59.94 — pixel-exactness and Gray Steps
crush/clip both verified against real transmitted-then-captured pixels. §5a
decision 1's open item is answered: **full range** is correct for this rig,
established empirically (the Hippotizer feed the processors already accept
measures full range on the wire, Y 1–254).

**Default changed to 1080p30, full range — approved.** This overrides §5a
decision 3's "default to 1080p59.94/60", which was written before any processor
had been tested. A default that does not lock on real hardware is worse than one
that does, and the cost is confined to Motion Test: every other pattern is
static, so 30 fps is indistinguishable, and the gate passed identically at both
rates. 3G modes stay selectable with an on-card warning describing the symptom.

**Unresolved, and recorded as such:** a DBSTAR HVT11 on this rig accepts
1080p30 (1.5G) and refuses 1080p59.94 (3G). Everything measurable was matched to
a Hippotizer feed the same processor does accept — same mode, raster, 4:2:2,
progressive, full range — and Level A was confirmed genuinely on the wire
(`BMDDeckLinkSupportsSMPTELevelAOutput` = yes on every sub-device). The hub
demonstrably passes 3G, since our own 3G returns through it. The two signals are
indistinguishable in every property the card can measure.

The only remaining difference is **VPID (SMPTE 352M payload ID)**, which lives
in horizontal blanking; the DeckLink ancillary API exposes vertical only, so it
cannot be read or verified from software. Settling that definitively needs an
SDI analyser, not more code.

**Two cheap tests that would isolate it, neither yet run — do these before
spending more time:**

1. **Reciprocal routing test.** Route our card #1 output to the *exact* hub
   output, cable and processor input the Hippo currently uses. Then route the
   Hippo to the hub output we have been using. If ours locks on the Hippo's path
   and the Hippo fails on ours, the fault is the **path** — most likely cable or
   interconnect bandwidth, which passes 1.5G and fails 3G routinely and would
   explain every observation. If ours still fails on the Hippo's exact path,
   the difference really is in metadata we cannot see.
2. **Does 1080p50 fail?** Also 3G. Failing puts the boundary exactly at
   1.5G/3G; working makes it specific to 59.94 and points somewhere else
   entirely. This was asked and never answered.

**Also worth resolving: what is actually receiving the SDI?** The HVT11 is a
*sending card* whose native formats are 2048×640, 1280×1024 and 1024×1200 —
1920×1080 is not among them, and a 1080p frame (2.07 M px) exceeds the card's
entire 1.31 M px capacity. If SDI is arriving at a converter or input board in
front of it, that device's rating is what matters, and a 1.5G-only converter
would explain the whole symptom.

**CLOSED 2026-08-04 by the operator** as something in the signal chain rather
than a Lattice defect. 1080p30 full range is the accepted configuration. Do not
spend further software time on 3G; the two isolating tests above remain written
down only in case someone with an analyser wants them later.

## 5h. UI: SDI outputs belong in the wall-first flow

Requested after seeing the first integration. DeckLink settings currently read
as a side attachment; they should sit in the same flow as every other output.

1. **SDI outputs appear in the wall's "Send to output" dropdown**
   (`rebuildWallOutputSelect`) alongside physical displays, virtual outputs and
   "+ New virtual window". Selecting one assigns the wall to that output and
   starts it, exactly as the existing entries do.
2. **SDI-specific settings — video mode and colour range — live in that
   output's card in the Outputs panel under the preview**, inline with Label /
   Wall / Scale / Pos X/Y, not in a separate area. Selecting an SDI output for a
   wall therefore surfaces its settings in the same place every other output's
   settings appear.
3. **Type-specific controls appear only for the relevant type**: mode and range
   for SDI, resolution for virtual, neither for physical displays.
4. Reuse `appendOutputControls()` and the `field()` helper. Do not build a
   parallel control surface — that was §5e constraint 3 and it still holds.

## 5f. Transport decision (Phase 3)

Measured over a unix socket, offscreen → helper → card, 1080p59.94 BGRA:
one output clean at 60 fps / 497 MB/s / 0 skipped; **two outputs degrade to 47
unique fps** with ~285 skipped each. The design target is eight. So the socket
does not scale, and §5e's shared-memory requirement is now evidence-based.

**Do these in order, measuring after each — the later steps may prove
unnecessary.**

1. **Measure the STATIC case first.** The transport was characterised with
   `motion`, an animated pattern, which is the worst case and not the common
   one. Most test patterns — Grid, Panel Map, Checkerboard, Colour Bars, Gray
   Steps, Solid — are static, and `renderer/output.js` already skips the rAF
   loop entirely when `LED_FRAME_ANIMATED()` is false. Chromium OSR paints on
   invalidation, so a static pattern should produce almost no paints, and the
   helper already holds the last frame on starvation. **Eight static outputs may
   already work over the plain socket at effectively zero sustained bandwidth.**
   If so, the transport rebuild is only needed for multiple *animated* outputs,
   which changes its priority considerably. Measure eight static outputs, and
   eight with one animated, before building anything.

2. **Convert to UYVY before the transport** for modes that require it
   (1080p50/59.94/60). It halves the wire cost — 4.15 MB/frame instead of
   8.29 — and the conversion is mandatory somewhere anyway. Keep it off the
   main thread (worker + SharedArrayBuffer) and re-measure the two-output case;
   it may clear on the socket alone.

3. **Then, if still needed: file-backed mmap. Not a native addon.** Protecting
   the release pipeline from native dependencies is why route (b) was chosen
   and that still holds — a native addon reintroduces `electron-rebuild`, the
   Blackmagic SDK as a build input on the release machine, and per-Electron
   rebuilds.

   The stated disk cost deserves measurement rather than acceptance. A small
   ring (3 frames ≈ 25 MB) rewritten at 60 Hz dirties the *same* pages
   repeatedly; the pager flushes current contents on its own schedule, so
   actual writeback should be bounded by flush frequency × ring size, not by
   write rate. That is a reasonable expectation, not a fact — **verify with
   `fs_usage` / `iostat` before accepting it.** If writeback is genuinely heavy,
   a RAM disk (`hdiutil attach -nomount ram://…`) removes the concern at the
   cost of a mount to manage and clean up.

Noted for later, not now: when several outputs show regions of the *same* wall
(the eight-feeds case), the wall could be rendered once and each helper given
its own crop, replacing N renderers with one. Worth it only if N-renderer CPU
shows up as a problem.

## 5d. SDK headers and packaging — confirmed

**Do not vendor Blackmagic's SDK headers into the repo.** They sit behind a
registration wall with their own licence. The `DECKLINK_SDK` build variable plus
documentation is the right call.

Consequence for the release pipeline, to be settled at Phase 5: the build
machine has no SDK, so it cannot compile the helper. Expected shape — the helper
is built once per platform on a machine that has the SDK and bundled as a
prebuilt binary (electron-builder `extraResources`) or attached as a release
asset, with Lattice detecting its absence and simply not offering DeckLink
outputs. That satisfies §3 constraint 2 either way.

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

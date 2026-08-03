# latticeout — DeckLink SDI output helper

Standalone native helper for Lattice's DeckLink output (route (b) in
`docs/DECKLINK-BRIEF.md` §5a). Runs as a child process so Lattice's own
dependency tree stays native-free: no `electron-rebuild`, no per-Electron
recompiles, and a driver-level crash cannot take the app down.

## Building

The Blackmagic Desktop Video SDK is **not vendored here** — it sits behind a
registration wall on Blackmagic's support site and its headers carry their own
licence. Point `DECKLINK_SDK` at a directory containing `DeckLinkAPI.h` and
`DeckLinkAPIDispatch.cpp`:

```sh
DECKLINK_SDK=/path/to/'Blackmagic DeckLink SDK'/Mac/include ./build.sh
```

Produces a universal (arm64 + x86_64) `latticeout`. Links only
`CoreFoundation` and `Accelerate`, both of which ship with macOS.

## Usage

```sh
latticeout list
latticeout play --device 0 --mode 1080p59.94 --pattern motion --seconds 60
latticeout play --device 0 --mode 1080p30 --pattern graysteps --range full
```

`list` emits JSON for the main process to consume. `signalPresentOnInput`
matters: sub-devices are half-duplex, so opening output on a port that is
currently receiving flips it to transmit and kills whatever capture was running.
`play` refuses such a port unless `--force` is passed.

## Verification status

Measured on 2 × DeckLink Duo 2, Desktop Video 16.1, macOS 26.5.1 arm64.

**Verified on hardware:**

| Check | Result |
|---|---|
| Device enumeration, card/sub-device naming | 8 sub-devices, matches ground truth |
| Input-signal detection (busy-port guard) | correctly flags card #2's 4 receiving ports |
| Refuses to hijack a receiving half-duplex port | exits 3 |
| 1080p59.94, UYVY via vImage, 10s | 598/599 frames, 0 late, 0 dropped |
| 1080p30, native BGRA, 8s | 238/240 frames, 0 late, 0 dropped |
| 1080p59.94 motion, 65s | 3896/3896 frames, 0 late, 0 dropped |
| Two simultaneous 1080p59.94 outputs, 65s | both 3896/3896, 0 late, 0 dropped |

## The byte-exact gate — PASSED

Run through the Videohub loopback (card #1 SDI 1 → hub → card #2 SDI 1) with
`tools/gate.cpp`, which transmits a known pattern and compares captured pixels.
An SDI router is a bit-transparent crosspoint, so this is still byte-exact.

| Check | 1080p59.94 legal | 1080p30 legal | full range |
|---|---|---|---|
| Black / white level | Y=16 / Y=235 | Y=16 / Y=234 | Y=1 / Y=254 |
| Gray Steps (16) | all distinct, monotonic, no crush or clip | same | same |
| 1px grid at 1:1 | **120/120 lines, 0 neighbour bleed** | same | same |
| Chroma (1px red/blue) | Cr swing **0** | Cr swing **0** | — |

**1:1 is genuinely pixel-exact in luma** — every 1px line recovered at the right
column with no spreading.

**Independently corroborated by eye:** the test output was observed on a monitor
fed from the Videohub. This matters beyond "it works". A loopback runs through
two sub-devices of the same card family on the same driver, so a *symmetric*
fault — transmit and capture sharing the same wrong matrix or offset — would
cancel out and produce a clean round trip from a wrong signal. Confirmation on a
non-DeckLink device rules that out. It also closes the original Phase 1 gate
("any picture out of the card"), which no amount of software could settle from
this machine.

**Two corrections to earlier conclusions, both measured:**

1. **Chroma is 4:2:2 in *every* mode, not just 1080p50/59.94/60.** Handing the
   card BGRA does not put 4:4:4 on the wire; it only moves the RGB→YUV
   conversion into the card. The Phase 0 pixel-format table showed which modes
   *accept* an RGB buffer, and reading that as "4:4:4 available" was an
   inference, not a measurement. §5a decision 3's premise — pick 1080p30 for
   colour-critical work — does not hold: no available mode avoids 4:2:2.
   True 4:4:4 needs 444 output enabled on both ends.

2. **The colour-range control silently did nothing in BGRA modes.** The card's
   built-in RGB→YUV conversion always emits legal range and ignores the setting;
   selecting "full" at 1080p30 still measured Y=16/234. Fixed by forcing the
   vImage path whenever full range is selected, then re-verified: 1080p30 full
   now measures Y=1/254 with 16 distinct steps.

**Still open — loopback cannot answer it:** which range a downstream LED
processor actually expects. That needs routing onward to a processor or
reference monitor (§5a decision 1).

## Transport scaling (§5f step 1)

Measured end-to-end, offscreen → socket → card, 1080p59.94:

| Outputs | Pattern | Paint | Received | Card |
|---|---|---|---|---|
| 4 | static (grid) | 0 fps steady | **~0 fps, ~16 frames total in 25 s** | 0 late, 0 dropped |
| 1 | animated | 60 fps | 60 fps, 0 skipped | 0 late, 0 dropped |
| 2 | animated | 60 fps | 47 fps, 285 skipped each | 0 late, 0 dropped |
| 4 | animated | 60 fps | 24 fps, ~750 skipped each | 0 late, ≤1 dropped |

**Static outputs cost essentially nothing at any count** — Chromium OSR paints on
invalidation, `output.js` skips the rAF loop when the pattern is not animated,
and the helper holds the last frame. The socket only fails for *multiple
simultaneous animated* outputs, where it saturates around 800 MB/s aggregate.
The renderer itself holds 60 fps paint throughout; the ceiling is transport
alone.

Only four outputs were measurable: card #2 is the input card, so its four
sub-devices are not available as outputs.

**NOT verified:**

- Which colour range a downstream LED processor expects. Loopback cannot settle
  it; that needs routing onward to a processor or reference monitor.
- The shared-memory transport (§5f steps 2–3), needed only for multiple
  simultaneous *animated* outputs.
- The no-regression check on the existing renderer with two 4K outputs.

## Sub-device pairing (§5c) — resolved, ports are independent

The observation that transmitting on card #2 SDI 3 made SDI 4 lose its input
**does not reproduce, and is explained**. It was a measurement artefact of too
short a settle window, not connector pairing.

`tools/pairtest.cpp` runs repeated trials: a control that transmits nothing, and
one trial per transmitting port, sampling every other input. Fraction of trials
in which each card #2 input delivered frames:

| Settle | Result |
|---|---|
| 900 ms | sporadic failures; control clean |
| 1200 ms | sporadic failures **including the control row** (c2/SDI2 at 67% with nobody transmitting) |
| 1600 ms | 100% across 8 trials, every ordered pair |
| 2000 ms | 100% across 6 trials, every ordered pair |

The 1200 ms control failure is the decisive one: an input dropped out with
nothing being transmitted at all, so transmission cannot be the cause. The
original sighting came from `loopscan`, which used exactly 1200 ms.

**Consequence:** the eight sub-devices are independent. Decision 2's "8
sub-devices = 8 processor feeds" holds and the Phase 3 UI does not need
constraining.

**Still open, but no longer blocking:** reading the *active* profile via
`IDeckLinkProfileManager` as §5c asked. That interface was introduced in SDK
11.0 and is absent from the 10.11.2 headers currently available on this machine,
and no newer SDK is obtainable from npm. It needs the real Desktop Video SDK
from Blackmagic's site. It would be confirmation rather than new information —
the empirical result above already answers the question the profile readout was
being used to infer.

**Design note for Phase 3:** do not depend on a fixed settle constant. The
margin between 1200 ms (flaky) and 1600 ms (clean) is not large, and it will
differ with signal type and driver version. Poll for lock with a timeout, or
drive off the input format-changed callback, rather than sleeping a magic
number.

## tools/

Read-only diagnostics from Phase 0/1, kept because they are the verification
harness, not throwaways.

- `probe.cpp` — enumerate devices, attributes, duplex state, and every supported
  output mode with its usable pixel formats. Changes nothing.
- `loopscan.cpp` — transmit a colour unique to each port, capture on all others,
  correlate by content. Lock state alone cannot do this: `IdleOutputOperation =
  Black` means an idle output still radiates valid SDI, so every cabled input
  reads as "locked" whether or not you are driving it. Its settle was raised
  1200 ms → 2200 ms after the pairing work showed 1200 ms is marginal; a shorter
  window can report a false negative.
- `pairtest.cpp` — repeated control-vs-test trials used to settle §5c.
  `--trials N --settle MS`.

**A passive scan is NOT a cable detector.** An SDI output cabled to a downstream
device is indistinguishable from an unconnected one: there is no incoming signal
either way and the card cannot sense a passive load. These tools detect incoming
*feeds*, never cables. An earlier claim to the contrary here was wrong, and led
to card #1 being reported as "nothing plugged in" when its four ports were in
fact already feeding a Videohub.

Build either the same way as the helper:

```sh
clang++ -std=c++17 -I"$DECKLINK_SDK" tools/loopscan.cpp \
  "$DECKLINK_SDK/DeckLinkAPIDispatch.cpp" -framework CoreFoundation -o loopscan
```

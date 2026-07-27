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

**NOT yet verified — needs one BNC cable:**

The Phase 2 gate proper ("known test frame visibly on the downstream device,
correct colours") is **unproven**. Nothing is connected to card #1's four SDI
ports, and card #2's four are fed inward by external sources, so there is no
return path. Everything above measures what the card *reports* about its own
scheduling; none of it confirms the pixels leaving the connector are the pixels
we sent.

Outstanding as a direct consequence:

- pixel-exactness of the 1px grid at 1:1
- Gray Steps black-crush / white-clip, i.e. the actual colour-range answer
- whether legal (16–235) or full (0–255) range is what a downstream LED
  processor wants — which a loopback cannot answer even once cabled (§5a
  decision 1); that needs a real processor or reference monitor

To close these: connect **card #1 SDI 1 → card #1 SDI 2** and run
`tools/loopscan.cpp`, which already does content-correlated capture and compare.

## tools/

Read-only diagnostics from Phase 0/1, kept because they are the verification
harness, not throwaways.

- `probe.cpp` — enumerate devices, attributes, duplex state, and every supported
  output mode with its usable pixel formats. Changes nothing.
- `loopscan.cpp` — transmit a colour unique to each port, capture on all others,
  correlate by content. Lock state alone cannot do this: `IdleOutputOperation =
  Black` means an idle output still radiates valid SDI, so every cabled input
  reads as "locked" whether or not you are driving it.

Build either the same way as the helper:

```sh
clang++ -std=c++17 -I"$DECKLINK_SDK" tools/loopscan.cpp \
  "$DECKLINK_SDK/DeckLinkAPIDispatch.cpp" -framework CoreFoundation -o loopscan
```

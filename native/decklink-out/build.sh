#!/bin/sh
# Build the latticeout DeckLink helper.
#
# The Blackmagic Desktop Video SDK is NOT vendored into this repo — it is behind
# a registration wall on Blackmagic's support site and its headers carry their
# own licence. Point DECKLINK_SDK at the "Mac/include" directory of an unpacked
# SDK, or at any directory containing DeckLinkAPI.h and DeckLinkAPIDispatch.cpp.
#
#   DECKLINK_SDK=/path/to/'Blackmagic DeckLink SDK'/Mac/include ./build.sh
#
# Output: ./latticeout (universal arm64 + x86_64)
set -eu

SDK="${DECKLINK_SDK:-}"
if [ -z "$SDK" ] || [ ! -f "$SDK/DeckLinkAPI.h" ]; then
  echo "error: set DECKLINK_SDK to a directory containing DeckLinkAPI.h" >&2
  echo "       (Blackmagic Desktop Video SDK -> Mac/include)" >&2
  exit 1
fi

OUT="$(dirname "$0")/latticeout"

clang++ -std=c++17 -O2 \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -I"$SDK" \
  "$(dirname "$0")/main.cpp" \
  "$SDK/DeckLinkAPIDispatch.cpp" \
  -framework CoreFoundation \
  -framework Accelerate \
  -o "$OUT"

echo "built $OUT"

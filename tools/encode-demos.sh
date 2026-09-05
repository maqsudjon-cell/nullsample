#!/usr/bin/env bash
# Encodes the demo WAVs to MP3 and removes the WAVs.
#
# Uses lame or ffmpeg, whichever is present. These are build-time tools, not
# project dependencies: the encoded files are committed, so CI only copies them.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=web/demos
BITRATE=96

if command -v lame >/dev/null 2>&1; then
  ENC=lame
elif command -v ffmpeg >/dev/null 2>&1; then
  ENC=ffmpeg
else
  echo "neither lame nor ffmpeg found; cannot encode demo audio" >&2
  exit 1
fi

total=0
for wav in "$DIR"/*.wav; do
  [ -e "$wav" ] || continue
  mp3="${wav%.wav}.mp3"
  if [ "$ENC" = lame ]; then
    lame --quiet -b "$BITRATE" -q 2 "$wav" "$mp3"
  else
    ffmpeg -loglevel error -y -i "$wav" -b:a "${BITRATE}k" "$mp3"
  fi
  size=$(wc -c < "$mp3")
  total=$((total + size))
  printf "  %7.1f KB  %s\n" "$(echo "scale=1; $size/1024" | bc)" "$(basename "$mp3")"
  rm "$wav"
done
printf "  %7.1f KB  total\n" "$(echo "scale=1; $total/1024" | bc)"

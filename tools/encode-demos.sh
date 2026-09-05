#!/usr/bin/env bash
# Encodes the demo WAVs to MP3 and removes the WAVs.
#
# Uses lame or ffmpeg, whichever is present. These are build-time tools, not
# project dependencies: the encoded files are committed, so CI only copies them.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=web/demos
BITRATE=96
# Card and stem clips are illustrations, not listening material: mono, low
# bitrate, a few seconds each. The four track excerpts stay stereo.
CARD_BITRATE=64

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
  base=$(basename "$wav")
  case "$base" in
    card-*|stem-*) BR=$CARD_BITRATE; MONO=1 ;;
    *)             BR=$BITRATE;      MONO=0 ;;
  esac
  if [ "$ENC" = lame ]; then
    if [ "$MONO" = 1 ]; then
      lame --quiet -m m -b "$BR" -q 2 "$wav" "$mp3"
    else
      lame --quiet -b "$BR" -q 2 "$wav" "$mp3"
    fi
  else
    if [ "$MONO" = 1 ]; then
      ffmpeg -loglevel error -y -i "$wav" -ac 1 -b:a "${BR}k" "$mp3"
    else
      ffmpeg -loglevel error -y -i "$wav" -b:a "${BR}k" "$mp3"
    fi
  fi
  size=$(wc -c < "$mp3")
  total=$((total + size))
  printf "  %7.1f KB  %s\n" "$(echo "scale=1; $size/1024" | bc)" "$(basename "$mp3")"
  rm "$wav"
done
printf "  %7.1f KB  total\n" "$(echo "scale=1; $total/1024" | bc)"

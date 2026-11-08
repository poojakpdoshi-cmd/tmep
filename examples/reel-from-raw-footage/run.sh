#!/usr/bin/env bash
# Raw talking-head footage -> 30 s Instagram reel. Requires whisper.cpp (or faster-whisper)
# for transcription; alternatively pass --file subs.srt to `transcribe`.
set -euo pipefail
TMEP="node $(dirname "$0")/../../bin/tmep.js -p ./my-reel"
FOOTAGE="${1:?usage: run.sh raw.mp4 [music.mp3]}"

$TMEP init
$TMEP import "$FOOTAGE" ${2:+"$2"}
$TMEP transcribe v1 --lang auto
$TMEP plan --template reel --target 30 --title "Your hook here" ${2:+--music a1}
$TMEP render --preview --frames 6          # fast half-res check + contact sheet
$TMEP edit "delete fillers=true" "captions kinetic"   # iterate with compact ops
$TMEP render --quality standard

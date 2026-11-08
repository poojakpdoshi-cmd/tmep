"""faster-whisper helper for TMEP. Prints {"language":..., "words":[{"w","s","e","p"}]} on stdout.

Usage: python fw_transcribe.py audio.wav --model small [--lang en] [--prompt "..."] [--device auto]
Requires: pip install faster-whisper   (MIT licensed; models download from the Hugging Face Hub)
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute", default="default")
    a = ap.parse_args()

    from faster_whisper import WhisperModel  # imported late so --help works without it

    model = WhisperModel(a.model, device=a.device, compute_type=a.compute)
    segments, info = model.transcribe(
        a.audio,
        language=a.lang or None,
        initial_prompt=a.prompt,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)})
    json.dump({"language": info.language, "words": words}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

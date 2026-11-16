"""faster-whisper helper for TMEP. Prints {"language":..., "words":[{"w","s","e","p"}]} on stdout.

Usage: python fw_transcribe.py audio.wav --model small [--lang en] [--prompt "..."] [--device auto]
Requires: pip install faster-whisper   (MIT licensed; models download from the Hugging Face Hub)
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?")
    ap.add_argument("--batch", metavar="MANIFEST")
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute", default="default")
    a = ap.parse_args()

    from faster_whisper import WhisperModel  # imported late so --help works without it

    model = WhisperModel(a.model, device=a.device, compute_type=a.compute, **({"local_files_only": True} if a.batch else {}))
    if a.batch:
        with open(a.batch, encoding="utf-8") as manifest:
            items = json.load(manifest)
        for item in items:
            try:
                result = transcribe(model, item["wav"], a)
            except Exception as error:
                result = {"error": str(error)[-2000:]}
            with open(item["out"], "w", encoding="utf-8") as out:
                json.dump(result, out, ensure_ascii=False)
    else:
        if a.audio is None:
            ap.error("audio is required unless --batch is used")
        json.dump(transcribe(model, a.audio, a), sys.stdout, ensure_ascii=False)
    return 0


def transcribe(model, audio, a):
    segments, info = model.transcribe(
        audio,
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
    return {"language": info.language, "words": words}



if __name__ == "__main__":
    sys.exit(main())

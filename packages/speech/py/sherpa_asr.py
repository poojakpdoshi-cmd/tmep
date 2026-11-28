"""FRAME sherpa-onnx speech worker (Phase 6). Local, CPU.

Usage: sherpa_asr.py WAV16K_MONO MODEL_DIR [LANG]  (LANG for multilingual Whisper, e.g. hi; 'auto' detects)
Prints {"language": "en", "words": [{"w","s","e"}], "engine": ..., "timing": "token"|"segment"}.

The audio is split at pauses found by a simple energy detector (max 20 s per chunk) so long files fit
in memory. CTC/transducer models give token timestamps → word timings; Whisper models give text only,
so word times are spread over their chunk and the result is marked "segment".
"""
import json
import os
import re
import resource
import time
import sys
import wave

import numpy as np
import sherpa_onnx

t_start = time.time()
wav, mdir = sys.argv[1], sys.argv[2]
files = os.listdir(mdir)
pick = lambda *names: next((os.path.join(mdir, f) for n in names for f in files if f.endswith(n)), None)
tokens = pick('tokens.txt')
threads = max(1, min(4, os.cpu_count() or 1))
lang = sys.argv[3] if len(sys.argv) > 3 else 'en'
if any(f.endswith('preprocess.onnx') for f in files):
    rec = sherpa_onnx.OfflineRecognizer.from_moonshine(preprocessor=pick('preprocess.onnx'), encoder=pick('encode.int8.onnx', 'encode.onnx'), uncached_decoder=pick('uncached_decode.int8.onnx', 'uncached_decode.onnx'), cached_decoder=pick('cached_decode.int8.onnx', 'cached_decode.onnx'), tokens=tokens, num_threads=threads)
    kind = 'moonshine'
elif any('encoder' in f for f in files) and any('decoder' in f for f in files) and not any('joiner' in f for f in files):
    # Whisper; multilingual models take a language code ('' = auto-detect), .en models are English-only.
    wl = 'en' if any('.en' in f for f in os.listdir(mdir)) or 'whisper' in mdir and mdir.rstrip('/').endswith('.en') else ('' if lang == 'auto' else lang)
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=pick('encoder.int8.onnx', 'encoder.onnx'), decoder=pick('decoder.int8.onnx', 'decoder.onnx'), tokens=tokens, num_threads=threads, language=wl, task='transcribe')
    kind = 'whisper'
elif any('joiner' in f for f in files):
    # NeMo transducers (Parakeet TDT) need model_type; icefall/k2 transducers do not.
    nemo = 'parakeet' in mdir or 'nemo' in mdir
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=pick('encoder.int8.onnx', 'encoder.onnx'), decoder=pick('decoder.int8.onnx', 'decoder.onnx'), joiner=pick('joiner.int8.onnx', 'joiner.onnx'), tokens=tokens, num_threads=threads, **({'model_type': 'nemo_transducer'} if nemo else {}))
    kind = 'transducer'
else:
    rec = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=pick('model.int8.onnx', 'model.onnx'), tokens=tokens, num_threads=threads)
    kind = 'ctc'

def transcribe(wav):
    t_file = time.time()
    with wave.open(wav) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

    # Energy-based chunking at pauses: 30 ms frames, threshold 12 dB above the 10th-percentile floor.
    hop = int(sr * 0.03)
    n = len(x) // hop
    rms = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2) + 1e-10) for i in range(n)])
    db = 20 * np.log10(rms)
    voiced = db > np.percentile(db, 10) + 12
    chunks, start, last_voice = [], None, -1
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = max(0, i - 5)
            last_voice = i
        if start is not None and ((not v and i - last_voice > 15) or (i - start) * 0.03 > 20):
            chunks.append((start, min(n, last_voice + 5)))
            start = None
    if start is not None:
        chunks.append((start, min(n, last_voice + 5)))

    if kind in ('whisper', 'moonshine') and chunks:
        # Whisper-style models decode whole utterances best: merge pause-split chunks into windows of at
        # most 28 s (the model's context is 30 s) instead of decoding fragments.
        merged = [list(chunks[0])]
        for a, b in chunks[1:]:
            if (b - merged[-1][0]) * 0.03 <= 28: merged[-1][1] = b
            else: merged.append([a, b])
        chunks = [tuple(c) for c in merged]
    words = []
    for a, b in chunks:
        s0, s1 = a * hop, b * hop
        if s1 - s0 < sr * 0.3:
            continue
        st = rec.create_stream()
        if kind == 'whisper':
            # The default cap (6 tokens/s) truncates scripts that need many byte-level tokens (e.g. Devanagari).
            st.set_option('max_tokens_per_second', '40')
        st.accept_waveform(sr, x[s0:s1])
        rec.decode_stream(st)
        r = st.result
        t0 = s0 / sr
        # Whisper writes non-speech as [Music] / (upbeat music): not words.
        text = re.sub(r'[\[(][^\])]*[\])]?', ' ', r.text).strip() if kind in ('whisper', 'moonshine') else r.text.strip()
        if not text:
            continue
        # Byte-level BPE tokens (Whisper) can be partial UTF-8: only token-timed models read them.
        toks, ts = (list(getattr(r, 'tokens', []) or []), list(getattr(r, 'timestamps', []) or [])) if kind not in ('whisper', 'moonshine') else ([], [])
        if kind not in ('whisper', 'moonshine') and toks and len(ts) == len(toks):
            # Map each character of the decoded text (spaces removed) to the token that produced it.
            owner = []
            for k, tok in enumerate(toks):
                owner += [k] * len(tok.replace('\u2581', '').replace(' ', ''))
            pos = 0
            ws = text.split()
            for k, wd in enumerate(ws):
                i0, i1 = min(pos, len(owner) - 1), min(pos + len(wd) - 1, len(owner) - 1)
                words.append({'w': wd, 's': round(t0 + ts[owner[i0]], 3), 'e': round(t0 + ts[owner[i1]] + 0.08, 3)})
                pos += len(wd)
        else:
            ws = text.split()
            dur = (s1 - s0) / sr
            for k, wd in enumerate(ws):
                words.append({'w': wd, 's': round(t0 + dur * k / len(ws), 3), 'e': round(t0 + dur * (k + 1) / len(ws), 3)})
    # Word ends: never past the next word's start.
    for i in range(len(words) - 1):
        words[i]['e'] = min(max(words[i]['e'], words[i]['s'] + 0.05), words[i + 1]['s'])
    return ({'language': lang if lang != 'auto' else 'und', 'words': words, 'engine': kind, 'timing': 'segment' if kind in ('whisper', 'moonshine') else 'token', 'chunks': len(chunks), 'seconds': round(len(x) / sr, 2), 'ms': int((time.time() - t_file) * 1000),  'maxRssMB': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)})


if wav.endswith('.list'):
    # Batch: one model load, one JSON line per file.
    for line in open(wav, encoding='utf-8'):
        path = line.strip()
        if path:
            r = transcribe(path); r['file'] = path
            print(json.dumps(r), flush=True)
else:
    print(json.dumps(transcribe(wav)))

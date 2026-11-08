# Voiceover reel prototype — verification (v2)

**Command:** `node examples/voiceover-reel/render.ts` (add `--captions 0` for the caption-free export; add `--audio vo.wav --words words.json` to use a real voiceover)

## Measured (ffprobe / ebur128)
| | v1 (kept) | v2 |
|---|---|---|
| Resolution | 1080×1920 | 1080×1920 |
| fps | 60 | 60 |
| Duration | 16.10 s (over the 15 s target) | 14.00 s |
| Audio | AAC 48 kHz | AAC 48 kHz, −13.9 LUFS integrated |
| Render time | 112.9 s | 98.1 s (840 frames) |

## Honesty notes
- **The voiceover is synthetic** (FFmpeg flite, voice "slt"). It is synthesized one word at a time, so each word's timestamps are exact by construction. They were **not** produced by speech recognition, and real-voice alignment (Whisper) is **untested**.
- **Caption-to-audio sync was checked by inspecting frames.** At t=3.83 s the highlighted word is "finds" (3.34 s, next word 3.87 s). At t=5.50 s it is "times" (5.15 s, next word 5.62 s). There was no listening test.
- **Scene choreography is a hand-designed template.** The automated parts come from the word timestamps:
  - the scene split, one scene per sentence
  - kinetic word reveals
  - caption pages and the highlight pill
  - beat cut times
  - waveform peaks

## Top 3 defects in v1 → fixed in v2
1. **The reel ran 16.1 s, over the 15 s target.** Fix: atempo 1.1 and tighter gaps and tail. Result: 14.0 s.
2. **Scene 3 showed the same caption twice**, once inside the frame and once at the bottom. Fix: removed the in-frame track.
3. **Scenes 1–2 were top-heavy, with the lower 40% empty.** Fix: moved the waveform, title and caption toward the vertical centre.

## Known remaining issues
- **The reel plates in scenes 3–4 are abstract gradients, not footage.** As a result, the reel reveal doesn't land strongly.
- **Word labels crowd together on the waveform** around 4.3–5.1 s.
- **The hero line "a voiceover." is visible for only about 0.5 s** before the morph.

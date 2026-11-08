# Raw footage -> Instagram reel

```bash
./run.sh raw.mp4 [music.mp3]          # macOS / Linux
.\run.ps1 -Footage raw.mp4 -Music music.mp3   # Windows PowerShell
```

What happens:

1. `import` registers the files and returns ids (`v1`, `a1`); probing and hashing happen locally.
2. `transcribe v1` runs whisper.cpp (or faster-whisper) once; the result is cached by content hash.
3. `plan --template reel` picks the strongest sentences for a 30 s cut, removes fillers and pauses,
   adds kinetic captions, icon cards for spoken lists, stat callouts, step badges, a CTA, punch
   zooms, jump-cut reframing, sound effects and (optionally) ducked music.
4. `render --preview` renders a half-resolution check plus a contact sheet in seconds.
5. `edit` applies compact ops as a new undoable revision; `render` reuses unchanged segments.

Ask your agent for changes in plain language; it should translate them into `video_edit` ops,
for example `"zoom @the key phrase to=1.2"` or `"gfx stat @ninety props.value=90% props.label=faster"`.

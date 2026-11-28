# AGENTS.md — Canonical Agent Contract for FRAME

**FRAME** (*Footage Reasoning and Agent-driven Media Editing*, formerly TMEP) is local-first media-production infrastructure powered by the **Token-Minimal Editing Protocol (TMEP)**.

This file is the canonical source of truth for all AI coding and editing agents (Claude Code, Codex, Antigravity, Cursor, and MCP clients). Do not duplicate its rules elsewhere; load specialized guidance on demand from `skills/<name>/SKILL.md`.

## Core Principles

1. **Creative quality over feature count**: A restrained, legible, well-paced edit beats a cluttered timeline with excessive zooms and pop-up graphics.
2. **Evidence-grounded edits**: Never fabricate visual evidence, transcript timestamps, or QA results. Distinguish observed facts from inferred creative choices.
3. **Token minimalism**: Use compact MCP tools (`video_plan`, `video_edit`, `video_inspect`) and TMEP DSL ops (`217` tokens vs `18k+` raw scripts). Inspect only what you need (`detail: "minimal"` or `"standard"`).
4. **Local-first & deterministic**: Prefer FFmpeg, `libass`, `@napi-rs/canvas`, and local Whisper over ad-hoc external scripts.

## Mandatory Prohibitions

- **No excessive zooms**: Never spam punch-zooms or leave `push`/`jumpZoom` active when restrained/static framing is requested.
- **No meaningless animations**: Every graphic, reveal, or transition must serve comprehension or pacing.
- **No fabricated visual evidence**: Never present synthetic mockups or stock placeholders as genuine product footage or real-world events.
- **No inaccurate captions**: Never invent or proportionally guess word timestamps for voiceover sync; flag `approx: true` or reject when strict sync is required.
- **No unnecessary background changes**: Preserve consistent framing and backgrounds across continuous explanations.
- **No irrelevant graphics**: Do not auto-insert decorative icons/stats that contradict or distract from the narration.
- **No unverified quality claims**: Never claim a render looks or sounds good without probing output streams, checking safe zones/collisions, and inspecting rendered frames.

## Production Pipeline

1. **Inspect & Diagnose**: Run `doctor` / `video_doctor` if environment state is unknown; `video_import` media; `video_transcribe` (or `transcribe-batch`); `video_inspect {what:"brief", asset, task}` instead of asking the user to describe the footage. Treat `inferred` items as suggestions with evidence, not facts.
2. **Creative Direction**: Choose format, pacing, typography, and restraint level. Load `skills/creative-direction/SKILL.md`.
3. **Rough Cut & Structure**: `video_plan` or `video_storyboard` / `video_script`.
4. **Fine Edit & Motion**: `video_edit` with compact TMEP ops (`cut`, `trim`, `broll`, `gfx`, `scene`, `fx`, `transition`, `music`, `sfx`).
5. **Render & Verify**: `video_render` (preview first, then final), inspect contact sheet / decoded frames and audio levels against `QUALITY_STANDARDS.md`.

## Canonical Document Map

- `INSTRUCTIONS.md` — Operational guide for MCP tools, CLI commands, and TMEP protocol usage.
- `QUALITY_STANDARDS.md` — Measurable technical and creative acceptance gates.
- `ARCHITECTURE.md` — Package boundaries, rendering backends, and data flow.
- `ROADMAP.md` — Phased development plan (implemented vs planned capabilities).
- `skills/<skill>/SKILL.md` — Modular domain skills loaded only when needed.

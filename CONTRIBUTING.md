# Contributing

Thanks for helping. TMEP aims to stay small, dependency-free and honest about what works.

## Setup

```bash
node --version        # >= 22.18
ffmpeg -version       # with libass + libx264
npm install           # typescript + @types/node (dev only)
npm run typecheck && npm test && npm run test:e2e
```

## Ground rules

- **No new runtime dependencies** without an issue explaining the measured benefit.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties): files run
  directly under Node's type stripping. `npm run typecheck` enforces `erasableSyntaxOnly`.
- **Every feature ships with a test.** Rendering features need an e2e assertion on real
  output (ffprobe, pixels or audio), not a mocked command.
- **Never fabricate results.** Benchmarks and compatibility claims must come from runs you
  can reproduce; mark anything unverified as such in docs.
- **Token economy is a feature.** New tool fields, response keys and descriptions cost tokens
  on every agent turn. Prefer an op, a preset or a `video_help` topic over a new tool.
- **Assets must be original or permissively licensed**, with the license recorded.

## Where things go

| Adding... | Edit |
|---|---|
| an op | `packages/core/src/ops.ts` (schema + `applyOne` + positional form) + test |
| a motion preset | `packages/motion/src/presets.ts` + preset test props |
| an icon | `packages/motion/src/icons.ts` (`ICONS` + concept words) |
| a template | `packages/story/src/templates.ts` |
| a storytelling rule | `packages/story/src/rules.ts` + detection test |
| a speech engine | `packages/speech/src/engines.ts` (+ parser in `transcript.ts`) |
| an MCP tool field | `packages/mcp/src/tools.ts` (keep descriptions terse) |

## Commit style

Small, focused commits with an imperative subject line. Include test evidence in PRs
(commands run and their results).

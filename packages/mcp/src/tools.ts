/**
 * MCP tool definitions. Designed for token economy and interoperability:
 *  - 9 tools; names match ^[a-zA-Z0-9_-]{1,64}$ (Claude, Antigravity, OpenAI reject dots)
 *    and stay short so "server + tool" fits Cursor's 60-char limit.
 *  - Short descriptions; detailed references are fetched on demand via video_help.
 *  - Every tool accepts optional `project` (path; defaults to TMEP_PROJECT or the
 *    server's working directory) and `detail` (minimal|standard|debug).
 */
import { obj, str, num, bool, oneOf, arr, any, union, record, type Schema } from '../../core/src/schema.ts';

const project = { project: str().optional() };
const detail = { detail: oneOf(['minimal', 'standard', 'debug'] as const).optional() };
const anchor = union([num(), str()]);

export interface ToolDef {
  name: string;
  description: string;
  schema: Schema<Record<string, unknown>>;
  annotations?: Record<string, boolean>;
}

/** Descriptions are terse on purpose: tool definitions are re-sent on every agent turn. */
export const TOOLS: ToolDef[] = [
  {
    name: 'video_import',
    description: 'Register media files. Returns asset ids (v1 video, a1 audio, i1 image); same content keeps its id.',
    schema: obj({ paths: arr(str({ min: 1 }), { min: 1, max: 50 }), ...project }),
  },
  {
    name: 'video_reference',
    description: 'Analyze imported reference video for hard-cut timestamps and pacing. Cached, compact output; not full visual style analysis.',
    schema: obj({ asset: str({ min: 1 }), threshold: num({ min: 0.05, max: 0.8 }).optional(), sampleFps: num({ min: 2, max: 30 }).optional(),
      maxSeconds: num({ min: 1, max: 300 }).optional(), minGapSec: num({ min: 0.1, max: 2 }).optional(), ...project, ...detail }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'video_transcribe',
    description: 'Local speech-to-text, word timestamps, cached. engine auto|whisper.cpp|faster-whisper|import(file=srt/vtt/json). lang auto|en|hi|hinglish|... Returns stats; text stays on disk.',
    schema: obj({ asset: str(), engine: str().optional(), lang: str().optional(), model: str().optional(), file: str().optional(), prompt: str().optional(), force: bool().optional(), wait: num().optional(), ...project }),
  },
  {
    name: 'video_plan',
    description: 'Optional reference asset guides safe sentence/pause cuts, preserving narration. Build a full edit from transcript+template: cuts, captions, graphics, zooms, SFX. template reel|short|talking_head|tutorial|product_demo|cinematic_explainer|youtube. off: features to skip (sfx,graphics,zooms,transitions).',
    schema: obj({ reference: str().optional(), src: union([str(), arr(str())]).optional(), template: str().optional(), target: num().optional(), ratio: str().optional(), title: str().optional(), sub: str().optional(), music: str().optional(), captions: record(any()).optional(), off: arr(str()).optional(), ...project }),
  },
  {
    name: 'video_edit',
    description: 'Apply ops as one undoable revision. Op = object or string: "cut 3.2 4", "delete fillers=true", "zoom @phrase to=1.2", "gfx stat @phrase props.value=90%", "captions boxed". Times: seconds|@phrase|w:N|c:ID|end. video_help ops.',
    schema: obj({ ops: arr(union([str(), record(any())])).optional(), undo: num().optional(), redo: num().optional(), checkout: num().optional(), note: str().optional(), ...project, ...detail }),
  },
  {
    name: 'video_inspect',
    description: 'Selective state read. what project|assets|timeline|transcript|silence|diff|log|jobs; narrow with from,to,find,words,max.',
    schema: obj({ what: str().optional(), asset: str().optional(), from: num().optional(), to: num().optional(), find: str().optional(), words: bool().optional(), max: num().optional(), rev: num().optional(), ...project, ...detail }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'video_render',
    description: 'Render current revision to MP4 (background job, cached segments). preview: fast half-res; range [s,e]; alpha: graphics-only overlay; frames: contact sheet.',
    schema: obj({ preview: bool().optional(), range: arr(anchor).optional(), quality: str().optional(), out: str().optional(), alpha: bool().optional(), frames: num().optional(), wait: num().optional(), ...project, ...detail }),
  },
  {
    name: 'video_status',
    description: 'Job progress/result; cancel=true stops; wait=N blocks N s.',
    schema: obj({ job: str(), cancel: bool().optional(), wait: num().optional(), ...project }),
  },
  {
    name: 'video_help',
    description: 'Reference: workflow|ops|anchors|presets|templates|sfx|icons|captions.',
    schema: obj({ topic: str().optional() }),
    annotations: { readOnlyHint: true },
  },
];

export function toolList(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema.json, ...(t.annotations ? { annotations: t.annotations } : {}) }));
}

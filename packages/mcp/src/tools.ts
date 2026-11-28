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
    description: 'Register media files. Returns asset ids (v1 video, a1 audio, i1 image); same content keeps its id. library={kind,title,description,tags,licence:{id,source,attribution,url},provenance,genuine} adds visual assets (images, clips, screen recordings, SVG, charts, diagrams) to the asset library instead.',
    schema: obj({ paths: arr(str({ min: 1 }), { min: 1, max: 50 }), library: record(any()).optional(), ...project }),
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
    description: 'Local speech-to-text, word timestamps, cached. Pass asset or assets[] (batch). engine auto|whisper.cpp|faster-whisper|import(file=srt/vtt/json).',
    schema: obj({ asset: str().optional(), assets: arr(str()).optional(), engine: str().optional(), lang: str().optional(), model: str().optional(), file: str().optional(), prompt: str().optional(), force: bool().optional(), wait: num().optional(), ...project }),
  },
  {
    name: 'video_plan',
    description: 'Build an edit from transcript+template, compile high-level intent, or compile script/storyboard JSON. off: sfx,graphics,zooms,transitions. mode=structured: inspectable plan from footage intelligence (action build|show|refresh|override|compile; asset, task, overrides {itemId: accept|drop|{ops}}, dryRun, rebase, semantic). mode=produce: persistent production pipeline ingest→…→preview→inspect→correct→final (action start|resume|revise|status|report; id, asset, genre informative|cinematic|sports|podcast|product|educational, goal, constraints {target, ratio, captions, zooms, graphics, transitions, music, keep, avoid, allowLook, maxEffectsPerMinute}, reference asset, overrides {stage:{skip|ops|drop}}, until stage); only changed stages recompute.',
    schema: obj({ reference: str().optional(), src: union([str(), arr(str())]).optional(), template: str().optional(), target: num().optional(), ratio: str().optional(), title: str().optional(), sub: str().optional(), music: str().optional(), captions: record(any()).optional(), off: arr(str()).optional(), script: str().optional(), storyboard: record(any()).optional(), intent: record(any()).optional(), dryRun: bool().optional(), wpm: num().optional(), narration: str().optional(), mode: str().optional(), action: str().optional(), asset: str().optional(), task: str().optional(), overrides: record(any()).optional(), rebase: bool().optional(), semantic: bool().optional(), id: str().optional(), genre: str().optional(), goal: str().optional(), constraints: record(any()).optional(), until: str().optional(), ...project }),
  },
  {
    name: 'video_edit',
    description: 'Apply ops as one undoable revision (or dryRun:true to validate). Op = object or string: "cut 3.2 4", "delete fillers=true", "zoom @phrase to=1.2", "gfx stat @phrase props.value=90%", "captions boxed", "fx zoomin c1 d=1.2".',
    schema: obj({ ops: arr(union([str(), record(any())])).optional(), undo: num().optional(), redo: num().optional(), checkout: num().optional(), note: str().optional(), ratio: str().optional(), expectedRev: num().optional(), dryRun: bool().optional(), ...project, ...detail }),
  },
  {
    name: 'video_inspect',
    description: 'Selective state read. what project|assets|timeline|transcript|silence|diff|log|jobs|scenes|qa|footage|brief|library (action list|search find=query|dups|recommend asset=v1). qa: pass file for a rendered MP4. footage/brief: local analysis of a video asset (cached); brief task informative|sports|cinematic|product|podcast|educational|generic; faces/ocr use local OpenCV/tesseract; temporalText = OCR every second; semantic = local MediaPipe objects/pose/tracking/scene types (models via video_doctor).',
    schema: obj({ what: str().optional(), asset: str().optional(), from: num().optional(), to: num().optional(), find: str().optional(), words: bool().optional(), max: num().optional(), rev: num().optional(), scene: str().optional(), spec: record(any()).optional(), file: str().optional(), targetLufs: num().optional(), task: str().optional(), faces: bool().optional(), ocr: bool().optional(), temporalText: bool().optional(), semantic: bool().optional(), gestures: bool().optional(), action: str().optional(), kind: str().optional(), minScore: num().optional(), product: str().optional(), force: bool().optional(), maxSeconds: num().optional(), ...project, ...detail }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'video_render',
    description: 'Render MP4 with cached segments. preview: half-res; range [s,e]; scene: half-res; alpha: graphics-only; frames: contact sheet.',
    schema: obj({ preview: bool().optional(), range: arr(anchor).optional(), scene: str().optional(), quality: str().optional(), out: str().optional(), alpha: bool().optional(), frames: num().optional(), rev: num().optional(), parallel: num().optional(), encoder: str().optional(), wait: num().optional(), ...project, ...detail }),
  },
  {
    name: 'video_status',
    description: 'Job progress/result; cancel=true stops; wait=N blocks N s.',
    schema: obj({ job: str(), cancel: bool().optional(), wait: num().optional(), ...project }),
  },
  {
    name: 'video_help',
    description: 'Reference: workflow|ops|anchors|presets|templates|sfx|icons|captions|storyboard|scene.',
    schema: obj({ topic: str().optional(), schema: bool().optional() }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'video_doctor',
    description: 'Check FFmpeg, encoders, local speech engines; models=true adds semantic model status. install=[names] returns the download plan (sizes, licences); with confirm=true it downloads.',
    schema: obj({ models: bool().optional(), install: arr(str()).optional(), confirm: bool().optional() }),
    annotations: { readOnlyHint: true },
  },
];

export function toolList(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema.json, ...(t.annotations ? { annotations: t.annotations } : {}) }));
}

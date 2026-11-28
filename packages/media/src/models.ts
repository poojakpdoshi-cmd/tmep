/**
 * FRAME model manager (Phase 5). Lists what the semantic layer needs, what is installed, and what an
 * install would download — sizes, checksums and licences are shown before anything is fetched, and a
 * download happens only through `installModels(..., { confirm: true })`.
 *
 * Models live outside the repository: $FRAME_MODELS (alias $TMEP_MODELS) or ~/.cache/frame/models.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmepError } from '../../core/src/index.ts';
import { run } from './exec.ts';

const BASE = 'https://storage.googleapis.com/mediapipe-models/';
export interface ModelSpec { name: string; file: string; url: string; bytes: number; sha256: string; licence: string; task: string; notes: string }

/** Chosen for CPU speed, size and licence (all Apache-2.0, Google MediaPipe model cards). */
export const MODELS: ModelSpec[] = [
  { name: 'objects', file: 'efficientdet_lite0.tflite', url: BASE + 'object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite', bytes: 4602795, sha256: '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb', licence: 'Apache-2.0', task: 'object detection (80 COCO classes)', notes: 'EfficientDet-Lite0 int8, 320×320 input' },
  { name: 'faces', file: 'blaze_face_short_range.tflite', url: BASE + 'face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite', bytes: 229746, sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f', licence: 'Apache-2.0', task: 'face location (no identity)', notes: 'BlazeFace short range: faces within ~2 m of the camera' },
  { name: 'pose', file: 'pose_landmarker_lite.task', url: BASE + 'pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task', bytes: 5777746, sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a', licence: 'Apache-2.0', task: 'body pose, 33 landmarks, up to 4 people', notes: 'BlazePose lite' },
  { name: 'gestures', file: 'gesture_recognizer.task', url: BASE + 'gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task', bytes: 8373440, sha256: '97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482', licence: 'Apache-2.0', task: 'hand gestures (7 classes) and hand boxes', notes: 'optional; slowest model' },
  { name: 'embed', file: 'mobilenet_v3_small.tflite', url: BASE + 'image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite', bytes: 4117670, sha256: 'bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40', licence: 'Apache-2.0', task: 'image embeddings (1024-d) for similarity and duplicates', notes: 'MobileNetV3 small' },
];

export const RUNTIME = {
  python: 'Python 3.9–3.13 with the `mediapipe` package (pip install mediapipe; ≈ 580 MB with numpy, opencv-contrib, matplotlib, jax/protobuf dependencies)',
  linux: 'Linux needs the EGL/GLES client libraries even on CPU (e.g. apt install libegl1 libgles2)',
  gpu: 'not required; all models run on CPU through XNNPACK',
};

export function modelDir(): string {
  return process.env.FRAME_MODELS ?? process.env.TMEP_MODELS ?? path.join(os.homedir(), '.cache', 'frame', 'models');
}

const sha256 = async (f: string) => createHash('sha256').update(await fsp.readFile(f)).digest('hex');

export interface ModelStatus { name: string; file: string; installed: boolean; verified: boolean; bytes: number; licence: string; task: string; url: string }
export async function modelStatus(names = MODELS.map((m) => m.name)): Promise<{ dir: string; models: ModelStatus[]; downloadBytes: number; runtime: typeof RUNTIME }> {
  const dir = modelDir();
  const models: ModelStatus[] = [];
  for (const m of MODELS.filter((x) => names.includes(x.name))) {
    const f = path.join(dir, m.file);
    let installed = false, verified = false;
    try { await fsp.access(f); installed = true; verified = (await sha256(f)) === m.sha256; } catch { /* absent */ }
    models.push({ name: m.name, file: m.file, installed, verified, bytes: m.bytes, licence: m.licence, task: m.task, url: m.url });
  }
  return { dir, models, downloadBytes: models.filter((m) => !m.verified).reduce((a, m) => a + m.bytes, 0), runtime: RUNTIME };
}

/**
 * Download missing models. Without `confirm: true` this only returns the plan (what would be fetched,
 * from where, how large, under which licence). A checksum mismatch deletes the file and fails.
 */
export async function installModels(names: string[], opts: { confirm?: boolean } = {}): Promise<{ planned: ModelStatus[]; installed: string[]; downloadBytes: number }> {
  const st = await modelStatus(names);
  const planned = st.models.filter((m) => !m.verified);
  if (!opts.confirm || !planned.length) return { planned, installed: [], downloadBytes: st.downloadBytes };
  await fsp.mkdir(st.dir, { recursive: true });
  const installed: string[] = [];
  for (const m of planned) {
    const spec = MODELS.find((x) => x.name === m.name)!;
    const r = await fetch(spec.url);
    if (!r.ok) throw new TmepError('E_DOWNLOAD', `${spec.file}: HTTP ${r.status} from ${new URL(spec.url).host}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== spec.sha256) throw new TmepError('E_DOWNLOAD', `${spec.file}: sha256 ${got.slice(0, 12)}… does not match the pinned ${spec.sha256.slice(0, 12)}… (upstream "latest" changed); not installed`);
    const tmp = path.join(st.dir, `.${spec.file}.${process.pid}`);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, path.join(st.dir, spec.file));
    installed.push(spec.name);
  }
  return { planned, installed, downloadBytes: st.downloadBytes };
}

/** A Python interpreter that can import mediapipe, honouring FRAME_PYTHON/TMEP_PYTHON and FRAME_PYTHONPATH. */
export async function semanticRuntime(): Promise<{ python?: string; env: NodeJS.ProcessEnv; reason?: string }> {
  const env = { ...process.env };
  const extra = process.env.FRAME_PYTHONPATH ?? process.env.TMEP_PYTHONPATH;
  if (extra) env.PYTHONPATH = [extra, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  let last = '';
  for (const py of [process.env.FRAME_PYTHON ?? process.env.TMEP_PYTHON, 'python3', 'python'].filter(Boolean) as string[]) {
    try {
      const r = await run(py, ['-c', 'import mediapipe, numpy; from mediapipe.tasks.python import vision'], { timeoutMs: 60000, env });
      if (r.code === 0) return { python: py, env };
      last = r.stderr.trim().split('\n').pop() ?? '';
    } catch { /* not on PATH */ }
  }
  const egl = /libEGL|libGLES/.test(last);
  return { env, reason: egl ? `mediapipe is installed but cannot load: ${last}. ${RUNTIME.linux}` : `mediapipe for Python not found (${RUNTIME.python})` };
}

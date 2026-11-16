import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { hashOf, mediaHash, TmepError } from '../../core/src/index.ts';
import { findWhisperCpp, resolveGgmlModel, type EngineOptions } from './engines.ts';
import { detectorPath } from './vad.ts';

async function identity(file: string | undefined): Promise<unknown> {
  if (!file) return null;
  const resolved = path.resolve(file);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) return { path: resolved, files: await Promise.all(['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.json', 'vocabulary.txt'].map(name => identity(path.join(resolved, name)))) };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) hash.update(chunk);
    return { path: resolved, sha256: hash.digest('hex') };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { path: resolved, missing: true };
  }
}
/** Model/binary hashing happens once per engine per batch, never per clip. */
export async function speechIdentity(engine: string, o: EngineOptions) {
  const bin = engine === 'whisper.cpp' ? await findWhisperCpp() : undefined;
  const model = engine === 'whisper.cpp' ? await resolveGgmlModel(o.model) ?? o.model ?? process.env.TMEP_WHISPER_MODEL ?? 'base' : o.model ?? 'small';
  return { version: 2, engine, model: await identity(model), binary: await identity(bin),
    vad: o.vad ?? (engine === 'faster-whisper' ? 'legacy-on' : 'off'),
    ...((o.vad === 'on' || o.vad === 'verify') && { vadModel: await identity(o.vadModel ?? process.env.TMEP_WHISPER_VAD_MODEL),
      detector: await identity(bin ? detectorPath(bin) : undefined), threshold: o.vadThreshold ?? .5, padMs: o.vadPadMs ?? 400 }) };
}
export function assertSource(a: { path: string; hash: string }) {
  if (mediaHash(a.path) !== a.hash) throw new TmepError('E_MEDIA', 'source changed since import', 'reimport the changed media before transcription');
}
export function speechCacheKey(assetHash: string, engine: string, o: EngineOptions, identity: unknown, fileHash?: string) {
  return hashOf({ a: assetHash, engine, lang: o.lang ?? 'auto', model: o.model ?? null, prompt: o.prompt ?? null, f: fileHash ?? null, identity });
}

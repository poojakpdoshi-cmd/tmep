export * from './schema.ts';
export * from './errors.ts';
export * from './util.ts';
export * from './timeline.ts';
export * from './project.ts';
export * from './ops.ts';

export type Detail = 'minimal' | 'standard' | 'debug';

/**
 * Adaptive response detail. `minimal` carries only status, IDs and errors;
 * `standard` adds concise operational facts; `debug` adds diagnostics.
 * Large payloads (transcripts, logs) are never inlined: they are written to
 * project files and returned as paths.
 */
export function shape(detail: Detail, core: Record<string, unknown>, std?: Record<string, unknown>, dbg?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...core };
  if (detail !== 'minimal' && std) Object.assign(out, std);
  if (detail === 'debug' && dbg) Object.assign(out, dbg);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export const VERSION = '0.1.0';
export const PROTOCOL = 'tmep/1';

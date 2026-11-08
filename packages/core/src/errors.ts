/**
 * Structured error codes. Every failure surfaced to an agent carries a stable code,
 * a one-line message and (when possible) a hint describing the fix. Codes are part of
 * the TMEP contract: agents may branch on them without parsing prose.
 */
export const ERROR_CODES = {
  E_INPUT: 'Invalid tool/command input',
  E_STATE: 'Project state does not allow this operation',
  E_NOT_FOUND: 'Referenced project, asset, revision, job or item does not exist',
  E_ANCHOR: 'A time anchor (@phrase, w:N) could not be resolved',
  E_RANGE: 'Time range is empty or outside the media/timeline',
  E_NO_TRANSCRIPT: 'Operation needs a transcript; run transcribe first',
  E_FFMPEG_MISSING: 'ffmpeg/ffprobe not found',
  E_FFMPEG_FAILED: 'ffmpeg exited with an error',
  E_ENGINE_MISSING: 'Requested speech engine or model is not installed',
  E_ENGINE_FAILED: 'Speech engine failed',
  E_MEDIA: 'Media file is unreadable or has no usable streams',
  E_CANCELLED: 'Job was cancelled',
  E_IO: 'File system error',
  E_INTERNAL: 'Unexpected internal error',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class TmepError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly detail: unknown;

  constructor(code: ErrorCode, message: string, hint?: string, detail?: unknown) {
    super(message);
    this.name = 'TmepError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }

  toJSON(debug = false): Record<string, unknown> {
    const o: Record<string, unknown> = { code: this.code, msg: this.message };
    if (this.hint) o.hint = this.hint;
    if (debug && this.detail !== undefined) o.detail = this.detail;
    return o;
  }
}

export function asTmepError(e: unknown): TmepError {
  if (e instanceof TmepError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err && typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) {
    return new TmepError('E_IO', `${err.code}: ${err.message}`);
  }
  return new TmepError('E_INTERNAL', e instanceof Error ? e.message : String(e), undefined, e instanceof Error ? e.stack : undefined);
}

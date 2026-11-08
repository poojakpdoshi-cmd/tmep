/**
 * Minimal, dependency-free schema layer (validation + defaults + JSON Schema emission).
 *
 * Why not Zod? TMEP's core is deliberately zero-dependency so the CLI and MCP server
 * run straight from a git clone with `node` (Node >= 22.18 strips TypeScript types).
 * We need exactly three things: validate agent input, apply defaults, and emit compact
 * JSON Schema (2020-12 subset) for MCP `inputSchema`. That fits in ~250 lines.
 * The API intentionally mirrors a small subset of Zod so it can be swapped later.
 */

export interface Issue {
  path: string;
  msg: string;
}

type Checker = (v: unknown, path: string, issues: Issue[]) => unknown;

export class Schema<T = unknown> {
  readonly json: Record<string, unknown>;
  readonly check: Checker;
  readonly isOptional: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;

  constructor(json: Record<string, unknown>, check: Checker, isOptional = false, hasDefault = false, defaultValue?: unknown) {
    this.json = json;
    this.check = check;
    this.isOptional = isOptional;
    this.hasDefault = hasDefault;
    this.defaultValue = defaultValue;
  }

  optional(): Schema<T | undefined> {
    return new Schema<T | undefined>(this.json, this.check, true, this.hasDefault, this.defaultValue);
  }

  default(d: T): Schema<T> {
    return new Schema<T>({ ...this.json, default: d }, this.check, true, true, d);
  }

  describe(description: string): Schema<T> {
    return new Schema<T>({ ...this.json, description }, this.check, this.isOptional, this.hasDefault, this.defaultValue);
  }

  parse(v: unknown): { ok: true; value: T } | { ok: false; issues: Issue[] } {
    const issues: Issue[] = [];
    const value = this.check(v, '', issues) as T;
    return issues.length ? { ok: false, issues } : { ok: true, value };
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const at = (path: string): string => path || '(root)';

export function str(opts: { min?: number; max?: number; pattern?: RegExp } = {}): Schema<string> {
  const json: Record<string, unknown> = { type: 'string' };
  if (opts.min !== undefined) json.minLength = opts.min;
  if (opts.max !== undefined) json.maxLength = opts.max;
  if (opts.pattern) json.pattern = opts.pattern.source;
  return new Schema<string>(json, (v, p, iss) => {
    if (typeof v !== 'string') {
      iss.push({ path: at(p), msg: `expected string, got ${typeName(v)}` });
      return v;
    }
    if (opts.min !== undefined && v.length < opts.min) iss.push({ path: at(p), msg: `min length ${opts.min}` });
    if (opts.max !== undefined && v.length > opts.max) iss.push({ path: at(p), msg: `max length ${opts.max}` });
    if (opts.pattern && !opts.pattern.test(v)) iss.push({ path: at(p), msg: `must match ${opts.pattern.source}` });
    return v;
  });
}

export function num(opts: { min?: number; max?: number; int?: boolean } = {}): Schema<number> {
  const json: Record<string, unknown> = { type: opts.int ? 'integer' : 'number' };
  if (opts.min !== undefined) json.minimum = opts.min;
  if (opts.max !== undefined) json.maximum = opts.max;
  return new Schema<number>(json, (v, p, iss) => {
    // Agents sometimes send numbers as strings ("1.5"). Accept numeric strings.
    let n = v;
    if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) n = Number(n);
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      iss.push({ path: at(p), msg: `expected number, got ${typeName(v)}` });
      return v;
    }
    if (opts.int && !Number.isInteger(n)) iss.push({ path: at(p), msg: 'expected integer' });
    if (opts.min !== undefined && n < opts.min) iss.push({ path: at(p), msg: `must be >= ${opts.min}` });
    if (opts.max !== undefined && n > opts.max) iss.push({ path: at(p), msg: `must be <= ${opts.max}` });
    return n;
  });
}

export function bool(): Schema<boolean> {
  return new Schema<boolean>({ type: 'boolean' }, (v, p, iss) => {
    if (v === 'true' || v === 1) return true;
    if (v === 'false' || v === 0) return false;
    if (typeof v !== 'boolean') iss.push({ path: at(p), msg: `expected boolean, got ${typeName(v)}` });
    return v;
  });
}

export function oneOf<const V extends readonly (string | number)[]>(values: V): Schema<V[number]> {
  return new Schema<V[number]>({ enum: [...values] }, (v, p, iss) => {
    if (!values.includes(v as string | number)) {
      const hint = typeof v === 'string' ? closest(v, values.map(String)) : undefined;
      iss.push({ path: at(p), msg: `must be one of ${values.join('|')}${hint ? ` (did you mean '${hint}'?)` : ''}` });
    }
    return v;
  });
}

export function any(): Schema<unknown> {
  return new Schema<unknown>({}, (v) => v);
}

export function arr<T>(item: Schema<T>, opts: { min?: number; max?: number } = {}): Schema<T[]> {
  const json: Record<string, unknown> = { type: 'array', items: item.json };
  if (opts.min !== undefined) json.minItems = opts.min;
  if (opts.max !== undefined) json.maxItems = opts.max;
  return new Schema<T[]>(json, (v, p, iss) => {
    if (!Array.isArray(v)) {
      iss.push({ path: at(p), msg: `expected array, got ${typeName(v)}` });
      return v;
    }
    if (opts.min !== undefined && v.length < opts.min) iss.push({ path: at(p), msg: `needs >= ${opts.min} items` });
    if (opts.max !== undefined && v.length > opts.max) iss.push({ path: at(p), msg: `max ${opts.max} items` });
    return v.map((x, i) => item.check(x, `${p}[${i}]`, iss));
  });
}

export function record<T>(item: Schema<T>): Schema<Record<string, T>> {
  return new Schema<Record<string, T>>({ type: 'object', additionalProperties: item.json }, (v, p, iss) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      iss.push({ path: at(p), msg: `expected object, got ${typeName(v)}` });
      return v;
    }
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) out[k] = item.check(x, p ? `${p}.${k}` : k, iss) as T;
    return out;
  });
}

type Shape = Record<string, Schema<unknown>>;
type ObjOut<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

export function obj<S extends Shape>(shape: S, opts: { strict?: boolean } = {}): Schema<ObjOut<S>> {
  const strict = opts.strict ?? true;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, s] of Object.entries(shape)) {
    properties[k] = s.json;
    if (!s.isOptional) required.push(k);
  }
  const json: Record<string, unknown> = { type: 'object', properties };
  if (required.length) json.required = required;
  if (strict) json.additionalProperties = false;
  return new Schema<ObjOut<S>>(json, (v, p, iss) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      iss.push({ path: at(p), msg: `expected object, got ${typeName(v)}` });
      return v;
    }
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(shape)) {
      const kp = p ? `${p}.${k}` : k;
      if (src[k] === undefined || src[k] === null) {
        if (s.hasDefault) out[k] = structuredClone(s.defaultValue);
        else if (!s.isOptional) iss.push({ path: kp, msg: 'required' });
        continue;
      }
      out[k] = s.check(src[k], kp, iss);
    }
    if (strict) {
      for (const k of Object.keys(src)) {
        if (!(k in shape)) {
          const hint = closest(k, Object.keys(shape));
          iss.push({ path: p ? `${p}.${k}` : k, msg: `unknown key${hint ? ` (did you mean '${hint}'?)` : ''}` });
        }
      }
    } else {
      for (const k of Object.keys(src)) if (!(k in shape)) out[k] = src[k];
    }
    return out;
  });
}

export function union<T extends Schema<unknown>[]>(options: T): Schema<Infer<T[number]>> {
  return new Schema<Infer<T[number]>>({ anyOf: options.map((o) => o.json) }, (v, p, iss) => {
    let best: Issue[] | undefined;
    for (const o of options) {
      const local: Issue[] = [];
      const r = o.check(v, p, local);
      if (!local.length) return r;
      if (!best || local.length < best.length) best = local;
    }
    iss.push(...(best ?? [{ path: at(p), msg: 'no union member matched' }]));
    return v;
  });
}

/** Levenshtein-based "did you mean" for agent self-correction. */
export function closest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function formatIssues(issues: Issue[], max = 4): string {
  const shown = issues.slice(0, max).map((i) => `${i.path}: ${i.msg}`);
  if (issues.length > max) shown.push(`+${issues.length - max} more`);
  return shown.join('; ');
}

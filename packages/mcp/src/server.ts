/**
 * Dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Dual-era per the 2026-07-28 spec "Backward Compatibility" section:
 *  - Legacy clients (2024-11-05 .. 2025-11-25) use the initialize handshake.
 *  - Modern clients (2026-07-28) send per-request `_meta` (protocolVersion,
 *    clientCapabilities) and may probe with `server/discover`.
 * The server holds no conversational state: project state lives on disk and is
 * addressed by explicit handles (project path, asset ids, revision numbers, job ids).
 */
import path from 'node:path';
import { createInterface } from 'node:readline';
import { TmepError, asTmepError, formatIssues, VERSION, type Detail } from '../../core/src/index.ts';
import * as api from '../../engine/src/api.ts';
import { startJob, waitJob, jobView } from '../../render/src/jobs.ts';
import { TOOLS, toolList } from './tools.ts';

export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MODERN_VERSIONS = ['2026-07-28'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = { name: 'tmep', title: 'TMEP video engine', version: VERSION };
const INSTRUCTIONS =
  'Video editing engine. Flow: video_import -> video_transcribe -> video_plan(template) -> video_render(preview) -> video_edit(ops) -> video_render. Reference media by asset id; never paste transcripts or write ffmpeg/animation code. video_help for references.';

type Json = Record<string, unknown>;
interface Request {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Json;
}

export interface ServerOptions {
  cwd?: string;
  detail?: Detail;
  /** emit notifications (progress) */
  notify?: (msg: Json) => void;
}

export class McpServer {
  private readonly cwd: string;
  private readonly detail: Detail;
  private readonly notify: (msg: Json) => void;

  constructor(o: ServerOptions = {}) {
    this.cwd = o.cwd ?? process.env.TMEP_PROJECT ?? process.cwd();
    this.detail = o.detail ?? ((process.env.TMEP_DETAIL as Detail) || 'standard');
    this.notify = o.notify ?? (() => {});
  }

  /** Handle one parsed JSON-RPC message; returns the response (undefined for notifications). */
  async handle(msg: unknown): Promise<Json | undefined> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.err(null, -32600, 'Invalid Request');
    const req = msg as Request;
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      if ('result' in req || 'error' in req) return undefined; // response to a server request: ignore
      return this.err(req.id ?? null, -32600, 'Invalid Request');
    }
    const isNotification = req.id === undefined || req.id === null;
    if (isNotification) return undefined; // notifications/initialized, cancelled, etc.
    const id = req.id!;
    const params = (req.params ?? {}) as Json;
    const meta = (params._meta ?? {}) as Json;
    const modernVersion = typeof meta[META_VERSION] === 'string' ? (meta[META_VERSION] as string) : undefined;
    const modern = modernVersion !== undefined;
    if (modern) {
      if (!MODERN_VERSIONS.includes(modernVersion) && !LEGACY_VERSIONS.includes(modernVersion)) {
        return this.err(id, -32022, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: modernVersion });
      }
      if (MODERN_VERSIONS.includes(modernVersion) && (meta[META_CAPS] === undefined || typeof meta[META_CAPS] !== 'object')) {
        return this.err(id, -32602, `missing required _meta "${META_CAPS}"`);
      }
    }
    const ok = (result: Json) => ({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : result });
    try {
      switch (req.method) {
        case 'initialize': {
          const requested = String(params.protocolVersion ?? '');
          const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0]!;
          return { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
        }
        case 'server/discover':
          return ok({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, ttlMs: 3600000, cacheScope: 'public' });
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return ok({ tools: toolList(), ...(modern ? { ttlMs: 3600000, cacheScope: 'public' } : {}) });
        case 'tools/call':
          return ok(await this.callTool(params));
        case 'resources/list':
          return ok({ resources: [] });
        case 'prompts/list':
          return ok({ prompts: [] });
        default:
          return this.err(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      if (e instanceof RpcError) return this.err(id, e.code, e.message);
      const te = asTmepError(e);
      return this.err(id, -32603, te.message);
    }
  }

  private err(id: string | number | null, code: number, message: string, data?: unknown): Json {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  }

  /** Tool execution. Input/business errors are tool results with isError (model can self-correct). */
  async callTool(params: Json): Promise<Json> {
    const name = String(params.name ?? '');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
    const parsed = tool.schema.parse(params.arguments ?? {});
    if (!parsed.ok) return this.toolError(new TmepError('E_INPUT', formatIssues(parsed.issues)), 'minimal');
    const args = parsed.value as Json;
    const detail = (args.detail as Detail) ?? this.detail;
    const ctx: api.Ctx = { project: path.resolve(this.cwd, (args.project as string) ?? '.'), detail };
    const progressToken = ((params._meta ?? {}) as Json).progressToken;
    try {
      const result = await this.dispatch(name, args, ctx, progressToken);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return this.toolError(asTmepError(e), detail);
    }
  }

  private toolError(e: TmepError, detail: Detail): Json {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: 0, err: e.toJSON(detail === 'debug') }) }], isError: true };
  }

  private async dispatch(name: string, a: Json, ctx: api.Ctx, progressToken: unknown): Promise<Json> {
    switch (name) {
      case 'video_import':
        return api.importMedia(ctx, { paths: a.paths as string[] });
      case 'video_transcribe': {
        // speech recognition can exceed client tool timeouts: run as a job, wait briefly
        const p = await api.openProject(ctx.project);
        const job = await startJob(p, 'transcribe', 0, { asset: a.asset }, (signal) => api.transcribe(ctx, { ...(a as Record<string, unknown> as { asset: string }), signal }));
        const j = await this.waitWithProgress(p, job.id, (a.wait as number) ?? 50, progressToken);
        if (j.state === 'done') return j.result!;
        return jobView(j, ctx.detail);
      }
      case 'video_plan': {
        const off = new Set((a.off as string[] | undefined) ?? []);
        return api.plan(ctx, { ...(a as Record<string, unknown>), ...(off.has('sfx') && { sfx: false }), ...(off.has('graphics') && { graphics: false }), ...(off.has('zooms') && { zooms: false }), ...(off.has('transitions') && { transitions: false }) } as never);
      }
      case 'video_edit':
        return api.edit(ctx, a as never);
      case 'video_inspect':
        return api.inspect(ctx, a as never);
      case 'video_render': {
        const res = await api.render(ctx, { ...(a as Record<string, unknown>), wait: 0 });
        const p = await api.openProject(ctx.project);
        const j = await this.waitWithProgress(p, String(res.job), (a.wait as number) ?? 50, progressToken);
        const view = jobView(j, ctx.detail);
        if (j.result?.sheet) view.sheet = j.result.sheet;
        return view;
      }
      case 'video_status':
        return api.status(ctx, { job: a.job as string, cancel: a.cancel as boolean, wait: a.wait as number });
      case 'video_help':
        return api.help((a.topic as string) ?? 'workflow');
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  }

  private async waitWithProgress(p: Awaited<ReturnType<typeof api.openProject>>, jobId: string, seconds: number, token: unknown) {
    if (token === undefined) return waitJob(p, jobId, seconds);
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const j = await waitJob(p, jobId, Math.min(1, Math.max(0, (deadline - Date.now()) / 1000)));
      if (j.state !== 'running' || Date.now() >= deadline) return j;
      this.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: j.progress, total: 1, message: j.phase } });
    }
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** stdio transport: one JSON-RPC message per line on stdin/stdout; logs go to stderr. */
export function serveStdio(o: ServerOptions = {}): void {
  const write = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const server = new McpServer({ ...o, notify: write });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // requests are handled concurrently so a long render never blocks status calls
    void server.handle(msg).then((res) => {
      if (res) write(res);
    });
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`tmep MCP server ${VERSION} ready (cwd ${path.resolve(o.cwd ?? process.env.TMEP_PROJECT ?? process.cwd())})\n`);
}

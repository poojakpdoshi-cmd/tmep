/**
 * `tmep` command-line interface. Mirrors the MCP tools one-to-one so any coding agent
 * that can run shell commands gets the same token-minimal workflow without MCP.
 * Output is compact JSON on stdout (use --pretty for humans); progress goes to stderr.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asTmepError, TmepError, VERSION, type Detail } from '../../core/src/index.ts';
import * as api from '../../engine/src/api.ts';
import { renderTimeline } from '../../render/src/render.ts';
import { serveStdio } from '../../mcp/src/server.ts';

interface Args {
  _: string[];
  [k: string]: unknown;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = coerce(a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        const value = next === undefined ? undefined : coerce(next);
        // --cancel can precede the job ID. Keep accepting explicit boolean and numeric values.
        if (next !== undefined && next !== '-p' && !next.startsWith('--') && (a !== '--cancel' || typeof value !== 'string')) {
          out[a.slice(2)] = value;
          i++;
        } else out[a.slice(2)] = true;
      }
    } else if (a === '-p') out.project = argv[++i];
    else out._.push(a);
  }
  return out;
}

const coerce = (v: string): unknown => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);

const HELP = `frame ${VERSION} - FRAME (Footage Reasoning and Agent-driven Media Editing), formerly TMEP

usage: frame <command> [args] [-p project_dir] [--detail minimal|standard|debug] [--pretty]
       (legacy alias: tmep; project directories .tmep/ and the tmep/1 protocol are unchanged)

  init [dir]                         create a project (default: current dir)
  import <files...>                  register media -> asset ids (v1, a1, i1)
  reference <asset> [--threshold 0.3] [--sampleFps 15] [--maxSeconds 120]  analyze reference cuts
  transcribe-batch <asset...> [--engine auto|whisper.cpp|faster-whisper] [--lang en] [--model base] [--force]
  transcribe <asset> [--engine auto|whisper.cpp|faster-whisper|import] [--lang auto|en|hi|hinglish] [--model base] [--file subs.srt] [--force]
  plan [--reference v2] [--template reel] [--src v1,v2] [--target 30] [--ratio 9:16] [--title "..."] [--music a1] [--no-sfx] [--no-graphics]
  script <file.txt> [--wpm 150] [--narration a1] [--compile-only | --render [--preview] [--out file.mp4]]
  storyboard <plan.json> [--out file.mp4] [--preview] [--compile-only]
  edit <op> [<op>...]                ops as strings, e.g. "cut 3.2 4.0" "zoom @phrase to=1.2" "fx panleft c2"  (or --json '[...]')
  undo [n] | redo [n] | checkout <rev>
  inspect [project|assets|timeline|transcript|silence|diff|log|jobs|scenes] [--asset v1] [--from s] [--to s] [--find q] [--words]
  inspect scenes [--scene id | --spec json]
  render [--preview] [--range a,b] [--quality draft|standard|high] [--out file.mp4] [--alpha] [--frames n] [--detach]
  status <job> [--cancel] [--wait s] | jobs
  render --scene id [--range localStart,localEnd]
  help [workflow|ops|anchors|presets|templates|sfx|icons|captions|scene|storyboard]
  doctor                             check ffmpeg, filters, speech engines
  mcp                                start the MCP server on stdio`;

function print(o: unknown, pretty: boolean): void {
  process.stdout.write(`${pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o)}\n`);
}

function bar(p: number, phase: string): void {
  if (!process.stderr.isTTY) return;
  const w = 28;
  const n = Math.round(p * w);
  process.stderr.write(`\r[${'#'.repeat(n)}${'.'.repeat(w - n)}] ${(p * 100).toFixed(0).padStart(3)}% ${phase.padEnd(8)}`);
  if (p >= 1) process.stderr.write('\n');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._.shift() ?? 'help';
  const pretty = !!args.pretty;
  const ctx: api.Ctx = { project: path.resolve(String(args.project ?? (process.env.FRAME_PROJECT ?? process.env.TMEP_PROJECT) ?? '.')), detail: (args.detail as Detail) ?? 'standard' };
  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        if (args._[0]) print(api.help(args._[0]), true);
        else process.stdout.write(`${HELP}\n`);
        return 0;
      case 'version':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case 'init': {
        const dir = path.resolve(args._[0] ?? ctx.project);
        await api.openProject(dir, true);
        print({ ok: 1, project: dir }, pretty);
        return 0;
      }
      case 'import':
        print(await api.importMedia(ctx, { paths: args._ }), pretty);
        return 0;
      case 'reference':
        print(await api.reference(ctx, { asset: String(args._[0] ?? ''),
          threshold: args.threshold as number, sampleFps: args.sampleFps as number,
          maxSeconds: args.maxSeconds as number, minGapSec: args.minGapSec as number }), pretty);
        return 0;
      case 'transcribe-batch': {
        const result = await api.transcribeBatch(ctx, { assets: args._, engine: args.engine as string, lang: args.lang as string, model: args.model as string, prompt: args.prompt as string, force: !!args.force });
        print(result, pretty);
        return result.ok ? 0 : 1;
      }
      case 'transcribe':
        print(await api.transcribe(ctx, { asset: String(args._[0] ?? ''), engine: args.engine as string, lang: args.lang as string, model: args.model as string, file: args.file as string, prompt: args.prompt as string, force: !!args.force }), pretty);
        return 0;
      case 'plan':
        print(
          await api.plan(ctx, {
            reference: args.reference as string,
            template: args.template as string,
            src: typeof args.src === 'string' ? args.src.split(',') : undefined,
            target: args.target as number,
            ratio: args.ratio as never,
            title: args.title as string,
            sub: args.sub as string,
            music: args.music as string,
            sfx: args.sfx as boolean,
            graphics: args.graphics as boolean,
            zooms: args.zooms as boolean,
            transitions: args.transitions as boolean,
            captions: args.captions ? { style: args.captions } : undefined,
          }),
          pretty,
        );
        return 0;
      case 'compile': {
        if (args._.length !== 1) throw new TmepError('E_INPUT', 'compile needs one JSON file');
        const raw = JSON.parse(readFileSync(path.resolve(args._[0]!), 'utf8').replace(/^\uFEFF/, ''));
        print(await api.compile(ctx, { ...raw, ...(args['dry-run'] ? { dryRun: true } : {}) }), pretty);
        return 0;
      }
      case 'script':
      case 'storyboard': {
        if (args._.length !== 1) throw new TmepError('E_INPUT', `${cmd} needs one input file`);
        if (args.out !== undefined && (typeof args.out !== 'string' || !/\.mp4$/i.test(args.out))) throw new TmepError('E_INPUT', '--out must be an MP4 path');
        const source = readFileSync(path.resolve(args._[0]!), 'utf8');
        let input: unknown;
        if (cmd === 'script') {
          const render = args.render === true || args.preview === true || args.out !== undefined;
          if (render && args['compile-only']) throw new TmepError('E_INPUT', 'choose --compile-only or rendering');
          const plan = api.planScript(source, { wpm: args.wpm, narration: args.narration });
          for (const warning of plan.warnings) process.stderr.write(`${warning}\n`);
          if (!render && !args['compile-only']) { print(plan.storyboard, pretty); return 0; }
          input = plan.storyboard;
        } else {
          try { input = JSON.parse(source.replace(/^\uFEFF/, '')); }
          catch { throw new TmepError('E_INPUT', 'storyboard file must contain valid JSON'); }
        }
        const project = await api.storyboard(ctx, input);
        if (args['compile-only']) { print(project, pretty); return 0; }
        const result = await api.render(ctx, { rev: project.rev, out: args.out as string | undefined, preview: !!args.preview, parallel: 1, wait: 1e9 });
        print({ ...result, rev: project.rev }, pretty);
        return result.state === 'done' ? 0 : 1;
      }
      case 'edit': {
        const ops = args.json ? (JSON.parse(String(args.json)) as unknown[]) : args._;
        print(await api.edit(ctx, { ops, note: args.note as string }), pretty);
        return 0;
      }
      case 'undo':
        print(await api.edit(ctx, { undo: Number(args._[0] ?? 1) }), pretty);
        return 0;
      case 'redo':
        print(await api.edit(ctx, { redo: Number(args._[0] ?? 1) }), pretty);
        return 0;
      case 'checkout':
        print(await api.edit(ctx, { checkout: Number(args._[0]) }), pretty);
        return 0;
      case 'inspect':
        print(await api.inspect(ctx, { what: args._[0], asset: args.asset as string, from: args.from as number, to: args.to as number, find: args.find as string, words: !!args.words, max: args.max as number, rev: args.rev as number,
          ...(args._[0] === 'scenes' && { scene: args.scene as string, spec: args.spec === undefined ? undefined : JSON.parse(String(args.spec)) }) }), pretty);
        return 0;
      case 'render': {
        if (args.detach) {
          const logDir = path.join(ctx.project, '.tmep', 'work');
          mkdirSync(logDir, { recursive: true });
          const log = path.join(logDir, `render-${Date.now()}.log`);
          const fd = openSync(log, 'a');
          const self = fileURLToPath(new URL('../../../bin/tmep.js', import.meta.url));
          const child = spawn(process.execPath, [self, ...argv.filter((a) => a !== '--detach')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
          child.unref();
          print({ ok: 1, detached: true, pid: child.pid, log: path.relative(ctx.project, log), hint: 'tmep jobs / tmep status <job>' }, pretty);
          return 0;
        }
        const range = typeof args.range === 'string' ? (args.range.split(',').map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)) as (number | string)[]) : undefined;
        if (args.out !== undefined && (typeof args.out !== 'string' || !/\.(mp4|mov|webm)$/i.test(args.out))) {
          throw new TmepError('E_INPUT', '--out must be an .mp4, .mov, or .webm path');
        }
        const res = await api.render(ctx, { preview: !!args.preview, range, scene: args.scene as string, quality: args.quality as never, out: args.out as string, alpha: !!args.alpha, frames: args.frames as number, rev: args.rev as number | undefined, parallel: args.parallel as number | undefined, encoder: args.encoder as never, wait: 1e9 });
        if (process.stderr.isTTY) process.stderr.write('\n');
        print(res, pretty);
        return res.state === 'done' ? 0 : 1;
      }
      case 'status':
        print(await api.status(ctx, { job: String(args._[0]), cancel: !!args.cancel, wait: args.wait as number }), pretty);
        return 0;
      case 'jobs':
        print(await api.inspect(ctx, { what: 'jobs' }), pretty);
        return 0;
      case 'doctor':
        print(await api.doctor(), true);
        return 0;
      case 'mcp':
        serveStdio({ cwd: ctx.project, detail: args.detail as Detail | undefined });
        return -1; // keep running
      default:
        process.stderr.write(`unknown command "${cmd}"\n${HELP}\n`);
        return 2;
    }
  } catch (e) {
    const err = asTmepError(e);
    print({ ok: 0, err: err.toJSON(ctx.detail === 'debug') }, pretty);
    return 1;
  }
}

export { bar, renderTimeline };

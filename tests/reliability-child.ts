/**
 * Subprocess driver for tests/render-reliability.test.ts.
 *
 * Each scenario runs in its own Node process, the way an MCP server or CLI process would,
 * WITHOUT any unhandledRejection handler: if the engine leaks a rejected promise the
 * process dies and the parent test sees it. Results are printed as one `RESULT {json}` line.
 *
 *   node tests/reliability-child.ts <scenario> <fixtureDir> [args...]
 */
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as api from '../packages/engine/src/api.ts';

const [scenario, fixtures, ...rest] = process.argv.slice(2) as [string, string, ...string[]];

function emit(obj: unknown): void {
  writeSync(1, `RESULT ${JSON.stringify(obj)}\n`);
}

/** All files under dir (relative paths). */
function files(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return [];
  }
}

/** Live ffmpeg children of this process (Linux only; [] elsewhere). */
function ffmpegChildren(): string[] {
  if (process.platform !== 'linux') return [];
  const r = spawnSync('ps', ['-o', 'pid=,comm=', '--ppid', String(process.pid)], { encoding: 'utf8' });
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => /ffmpeg/.test(l));
}

async function newProject(withMusic: 'none' | 'ok' | 'corrupt' = 'none'): Promise<api.Ctx> {
  const ctx: api.Ctx = { project: mkdtempSync(path.join(os.tmpdir(), 'tmep-rel-')), detail: 'standard' };
  const paths = [path.join(fixtures, 'clip.mp4')];
  let music: string | undefined;
  if (withMusic !== 'none') {
    music = path.join(ctx.project, 'music.m4a');
    writeFileSync(music, readFileSync(path.join(fixtures, 'music.m4a')));
    paths.push(music);
  }
  await api.importMedia(ctx, { paths });
  // several hard cuts -> several video units, so video work is still running when audio fails
  const ranges = Array.from({ length: 6 }, (_, i) => [i * 0.5, i * 0.5 + 0.4]);
  const ops: unknown[] = [{ op: 'format', ratio: '9:16' }, { op: 'keep', src: 'v1', ranges }];
  if (music) ops.push({ op: 'music', src: 'a1' });
  await api.edit(ctx, { ops });
  // still on disk, no longer decodable: the audio mix fails at once while video units render
  if (withMusic === 'corrupt' && music) writeFileSync(music, Buffer.alloc(4096, 7));
  return ctx;
}

async function finish(ctx: api.Ctx, job: string): Promise<Record<string, unknown>> {
  return (await api.status(ctx, { job, wait: 600 })) as Record<string, unknown>;
}

const view = (ctx: api.Ctx, r: Record<string, unknown>) => ({
  state: r.state,
  err: r.err,
  out: r.out ? path.resolve(ctx.project, r.out as string) : undefined,
});

switch (scenario) {
  case 'concurrent': {
    // two jobs on ONE project started together; rest[0] = 'final' | 'preview'
    const ctx = await newProject();
    const a = (await api.render(ctx, { wait: 0, out: 'renders/a.mp4' })) as Record<string, unknown>;
    const b = (await api.render(ctx, { wait: 0, out: 'renders/b.mp4', preview: rest[0] === 'preview' })) as Record<string, unknown>;
    const ra = await finish(ctx, a.job as string);
    const rb = await finish(ctx, b.job as string);
    emit({ project: ctx.project, jobs: [view(ctx, ra), view(ctx, rb)], leftovers: files(ctx.project).filter((f) => f.includes('.tmp')), ffmpeg: ffmpegChildren() });
    break;
  }
  case 'two-projects': {
    const p1 = await newProject();
    const p2 = await newProject();
    const [a, b] = await Promise.all([api.render(p1, { wait: 600 }), api.render(p2, { wait: 600 })]);
    emit({ jobs: [view(p1, a as Record<string, unknown>), view(p2, b as Record<string, unknown>)], leftovers: [...files(p1.project), ...files(p2.project)].filter((f) => f.includes('.tmp')) });
    break;
  }
  case 'audio-fail': {
    const ctx = await newProject('corrupt');
    const r = (await api.render(ctx, { wait: 600 })) as Record<string, unknown>;
    // give any orphaned ffmpeg a moment to show up before listing children
    await new Promise((res) => setTimeout(res, 300));
    const units = files(path.join(ctx.project, '.tmep', 'cache', 'units')).map((f) => path.join(ctx.project, '.tmep', 'cache', 'units', f));
    emit({ project: ctx.project, job: view(ctx, r), leftovers: files(ctx.project).filter((f) => f.includes('.tmp')), units, ffmpeg: ffmpegChildren(), alive: true });
    break;
  }
  case 'single': {
    const ctx = await newProject('ok');
    const r1 = (await api.render(ctx, { wait: 600 })) as Record<string, unknown>;
    const r2 = (await api.render(ctx, { wait: 600 })) as Record<string, unknown>;
    emit({ jobs: [view(ctx, r1), view(ctx, r2)], cached: r2.cached, leftovers: files(ctx.project).filter((f) => f.includes('.tmp')) });
    break;
  }
  case 'start-and-die': {
    // start a render, then die abruptly (no cleanup, no exit handlers) while it runs
    const ctx = await newProject();
    const r = (await api.render(ctx, { wait: 0 })) as Record<string, unknown>;
    emit({ project: ctx.project, job: r.job });
    await new Promise((res) => setTimeout(res, 400));
    process.kill(process.pid, 'SIGKILL');
    break;
  }
  case 'render-shared': {
    // render an EXISTING project from a separate process; rest = [projectDir, out, barrierFile]
    // All children block on the barrier file so they start publishing at the same moment.
    const ctx: api.Ctx = { project: rest[0]!, detail: 'standard' };
    const { existsSync } = await import('node:fs');
    while (!existsSync(rest[2]!)) await new Promise((res) => setTimeout(res, 5));
    const r = (await api.render(ctx, { wait: 600, out: rest[1]! })) as Record<string, unknown>;
    // which file the custom font resolved to in THIS process (custom-font tests set the name)
    const fontName = process.env.TMEP_TEST_FONT_NAME;
    const fontFile = fontName ? (await import('../packages/motion/src/fonts.ts')).resolveFont(fontName).file : undefined;
    emit({ job: view(ctx, r), cachedUnits: r.cached, fontFile });
    break;
  }
  case 'render-once': {
    // one render; prints the job id and the raw job view (persistence tests)
    const ctx = await newProject();
    const r = (await api.render(ctx, { wait: 600 })) as Record<string, unknown>;
    // let the cross-process cancel poll run at least once on a long-lived process
    if (rest[0]) await new Promise((res) => setTimeout(res, Number(rest[0])));
    emit({ project: ctx.project, view: r, jobs: files(path.join(ctx.project, '.tmep', 'jobs')) });
    break;
  }
  case 'status': {
    // inspect a job of another process: rest = [projectDir, jobId]
    const ctx: api.Ctx = { project: rest[0]!, detail: 'standard' };
    const r = (await api.status(ctx, { job: rest[1]! })) as Record<string, unknown>;
    emit(r);
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}

/**
 * Repeatable token benchmark: TMEP (MCP tools) vs a conventional agent workflow
 * (shell + file-write tools, the agent reads probe/transcript output and writes the
 * subtitle/graphics file and FFmpeg commands itself) for the SAME editing task.
 *
 * TMEP side: real MCP server, real tool calls, real responses, real renders.
 * Baseline side: a scripted replay. Every payload is a real artifact produced from the
 * same input (actual ffprobe JSON, the word-level transcript, the ASS file and FFmpeg
 * commands that implement the identical edit, actual FFmpeg logs). What is modeled is
 * the agent loop itself: we assume the agent emits exactly those artifacts once, with
 * no mistakes or retries, which is a LOWER bound on a real conventional run.
 *
 * Usage: node bench/token-bench.ts [--anthropic] [--out bench/results/latest.json]
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeFixture } from '../tests/fixtures.ts';
import { McpServer } from '../packages/mcp/src/server.ts';
import { toolList } from '../packages/mcp/src/tools.ts';
import { Project, layout, timelineWords, totalFrames, type Timeline } from '../packages/core/src/index.ts';
import { transcriptsFor } from '../packages/engine/src/api.ts';
import { compileAss } from '../packages/motion/src/compile.ts';
import { planUnits, unitArgs, type MediaRef } from '../packages/render/src/graph.ts';
import { clipAudio, planSpeech, planSfx, speechChunkArgs, sfxWindowArgs, finalMixArgs, samplePos } from '../packages/render/src/audio.ts';
import { run } from '../packages/media/src/exec.ts';
import { ffmpegInfo, ffmpeg } from '../packages/media/src/ffmpeg.ts';
import { estimateCounter, anthropicCounter, type Counter } from './tokens.ts';

interface Msg {
  role: 'assistant' | 'tool';
  text: string;
  label: string;
}

interface Workflow {
  name: string;
  /** static context sent every turn: system prompt + tool definitions */
  staticCtx: string;
  msgs: Msg[];
  ms?: number;
  correctness: string;
}

const USER_PROMPT =
  'Edit my raw footage talking_head.mp4 into a professional 20-second Instagram reel (9:16) with animated word-by-word subtitles, a title "AI video in 20s", motion graphics for key points, punch zooms and sound effects. Then: make the captions boxed and zoom in on the word "faster".';
const SYSTEM = 'You are a coding agent with tools. Complete the user task using the tools.';

async function tmepWorkflow(fixture: Awaited<ReturnType<typeof makeFixture>>, dir: string, detail: 'minimal' | 'standard'): Promise<Workflow> {
  const server = new McpServer({ cwd: dir, detail });
  const tools = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: unknown[] };
  const init = (await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }))!.result as { instructions: string };
  const msgs: Msg[] = [];
  const t0 = Date.now();
  let id = 10;
  const call = async (name: string, args: Record<string, unknown>) => {
    const callText = JSON.stringify({ name, arguments: args });
    msgs.push({ role: 'assistant', text: callText, label: name });
    const res = (await server.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }))!.result as { content: { text: string }[]; isError?: boolean };
    if (res.isError) throw new Error(`${name} failed: ${res.content[0]!.text}`);
    msgs.push({ role: 'tool', text: res.content[0]!.text, label: name });
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  };
  await call('video_import', { paths: ['talking_head.mp4'] });
  await call('video_transcribe', { asset: 'v1', file: 'talking_head.words.json' });
  await call('video_plan', { template: 'reel', target: 20, title: 'AI video in 20s' });
  await call('video_render', { preview: true });
  await call('video_edit', { ops: ['captions boxed', 'zoom @faster to=1.2'] });
  const fin = await call('video_render', {});
  msgs.push({ role: 'assistant', text: `Done: ${String(fin.out)}`, label: 'answer' });
  return {
    name: `TMEP (MCP, detail=${detail})`,
    staticCtx: SYSTEM + init.instructions + JSON.stringify(tools.tools),
    msgs,
    ms: Date.now() - t0,
    correctness: fin.state === 'done' ? `rendered + ffprobe-verified (${String(fin.size ?? '1080x1920')}, ${String(fin.dur ?? '')}s)` : `FAILED: ${JSON.stringify(fin)}`,
  };
}

async function baselineWorkflow(fixture: Awaited<ReturnType<typeof makeFixture>>, dir: string): Promise<Workflow> {
  // Generic tools a coding agent typically has (representative definitions).
  const shellTools = [
    { name: 'bash', description: 'Run a shell command and return stdout/stderr. Use for ffmpeg, ffprobe, whisper and file inspection.', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command to run' }, timeout: { type: 'number', description: 'Timeout in ms' } }, required: ['command'] } },
    { name: 'write_file', description: 'Create or overwrite a file with the given content.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  ];
  const info = await ffmpegInfo();
  const p = await Project.open(dir);
  const msgs: Msg[] = [];
  const sh = (cmd: string, out: string, label: string) => {
    msgs.push({ role: 'assistant', text: JSON.stringify({ name: 'bash', input: { command: cmd } }), label });
    msgs.push({ role: 'tool', text: out, label });
  };
  const write = (file: string, content: string, label: string) => {
    msgs.push({ role: 'assistant', text: JSON.stringify({ name: 'write_file', input: { path: file, content } }), label });
    msgs.push({ role: 'tool', text: `wrote ${file}`, label });
  };
  // 1. probe (real output)
  const probe = await run(info.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', fixture.video]);
  sh('ffprobe -v error -print_format json -show_format -show_streams talking_head.mp4', probe.stdout, 'probe');
  // 2. transcribe + read word timestamps (compact faster-whisper style JSON; whisper.cpp -ojf is larger)
  const segs: { start: number; end: number; text: string; words: unknown[] }[] = [];
  let cur: { start: number; end: number; text: string; words: unknown[] } | undefined;
  for (const w of fixture.words) {
    if (!cur) cur = { start: w.s, end: w.e, text: '', words: [] };
    cur.words.push({ word: ` ${w.w}`, start: w.s, end: w.e, probability: 0.97 });
    cur.text += ` ${w.w}`;
    cur.end = w.e;
    if (/[.!?]$/.test(w.w)) {
      segs.push(cur);
      cur = undefined;
    }
  }
  if (cur) segs.push(cur);
  sh('python transcribe.py talking_head.mp4 --word-timestamps > words.json && cat words.json', JSON.stringify({ language: 'en', segments: segs }), 'transcript');
  // 3+4. the agent writes subtitles/graphics + ffmpeg commands that implement the same edit
  const artifacts = async (tl: Timeline) => {
    const placed = layout(tl);
    const words = timelineWords(tl, await transcriptsFor(p, ['v1']), placed);
    const ass = compileAss(tl, words, placed).ass;
    const media: Record<string, MediaRef> = { v1: { path: 'talking_head.mp4', kind: 'video', hash: 'x', audio: true, dur: fixture.dur } };
    const enc = { vcodec: 'libx264', preset: 'veryfast', crf: 19, scale: 1 };
    const cmds = planUnits(placed).map((u, i) => `ffmpeg -y ${unitArgs(tl, u, media, enc, placed, `seg${i}.mp4`, 'gfx.ass', 'fonts').args.map(q).join(' ')}`);
    const sfx = tl.sfx.map((s, i) => ({ file: `sfx_${s.kind}.wav`, t: i, vol: s.vol, len: 48000 / 2 }));
    // audio: one command per speech chunk and per sound-effect window, then the final mix
    const total = samplePos(totalFrames(tl), tl.settings.fps);
    const chunks = planSpeech(clipAudio(placed, media, tl.settings.fps));
    for (const [i, c] of chunks.entries()) cmds.push(`ffmpeg -y ${speechChunkArgs(c, `speech${i}.wav`).args.map(q).join(' ')}`);
    const windows = planSfx(sfx, total);
    for (const [i, w] of windows.entries()) cmds.push(`ffmpeg -y ${sfxWindowArgs(w, `sfx${i}.wav`).args.map(q).join(' ')}`);
    cmds.push(`ffmpeg -y ${finalMixArgs(tl, { speechList: 'speech.txt', ...(windows.length ? { sfxList: 'sfx.txt' } : {}), totalSamples: total, out: 'audio.m4a' }).args.map(q).join(' ')}`);
    cmds.push('printf "file seg%d.mp4\\n" ... > list.txt && ffmpeg -y -f concat -safe 0 -i list.txt -i audio.m4a -c copy -movflags +faststart reel.mp4');
    return { ass, cmds, tl };
  };
  const r1 = await artifacts(await p.timeline(1));
  write('gfx.ass', r1.ass, 'write ass');
  // sound effects must be produced too (TMEP synthesizes them internally)
  sh('ffmpeg -f lavfi -i "aevalsrc=...pop..." sfx_pop.wav && ffmpeg ... (whoosh, ding, click, swoosh)', 'ok', 'sfx');
  // real ffmpeg log for a unit-sized render (agents read at least the tail)
  const unitLog = await ffmpeg({ args: ['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-'] });
  const logTail = unitLog.log.split(/\r?\n|\r/).filter((l) => l.trim()).slice(-25).join('\n');
  sh(r1.cmds.join(' && \\\n'), logTail, 'render');
  // iteration: boxed captions changes every caption event; zoom changes one segment command
  const r2 = await artifacts(await p.timeline(2));
  const capSection = (a: string) => a.split('\n').filter((l) => l.startsWith('Style: Cap') || l.startsWith('Dialogue: 2,')).join('\n');
  write('gfx.ass (caption events rewritten)', capSection(r2.ass), 'edit ass');
  const changed = r2.cmds.filter((c) => !r1.cmds.includes(c));
  sh(changed.join(' && \\\n'), logTail, 're-render');
  msgs.push({ role: 'assistant', text: 'Done: reel.mp4', label: 'answer' });
  return {
    name: 'Conventional agent (shell + write_file), scripted lower bound',
    staticCtx: SYSTEM + JSON.stringify(shellTools),
    msgs,
    correctness: 'not executed by an agent; artifacts are the exact commands/ASS TMEP rendered successfully',
  };
}

const q = (s: string) => (/^[\w./:=,@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

interface Score {
  workflow: string;
  calls: number;
  outputTokens: number;
  toolResultTokens: number;
  staticTokensPerTurn: number;
  cumulativeInputTokens: number;
  largestMessage: { label: string; tokens: number };
  wallMs?: number;
  correctness: string;
}

async function score(w: Workflow, count: Counter): Promise<Score> {
  const staticT = (await count(w.staticCtx)) + (await count(USER_PROMPT));
  let out = 0;
  let res = 0;
  let history = 0;
  let cumulative = 0;
  let largest = { label: '', tokens: 0 };
  let calls = 0;
  for (const m of w.msgs) {
    const n = await count(m.text);
    if (m.role === 'assistant') {
      cumulative += staticT + history; // model is invoked with everything so far
      out += n;
      if (m.label !== 'answer') calls++;
    } else res += n;
    history += n;
    if (n > largest.tokens) largest = { label: `${m.role}:${m.label}`, tokens: n };
  }
  return { workflow: w.name, calls, outputTokens: out, toolResultTokens: res, staticTokensPerTurn: staticT, cumulativeInputTokens: cumulative, largestMessage: largest, wallMs: w.ms, correctness: w.correctness };
}

async function main() {
  const args = process.argv.slice(2);
  const useAnthropic = args.includes('--anthropic');
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1]! : path.join('bench', 'results', 'latest.json');
  const count = useAnthropic ? anthropicCounter() : estimateCounter;
  const fixture = await makeFixture(path.join(os.tmpdir(), 'tmep-bench-fixture'));
  const results: Score[] = [];
  let baselineDir = '';
  for (const detail of ['standard', 'minimal'] as const) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `tmep-bench-${detail}-`));
    await fsp.copyFile(fixture.video, path.join(dir, 'talking_head.mp4'));
    await fsp.copyFile(fixture.truth, path.join(dir, 'talking_head.words.json'));
    const w = await tmepWorkflow(fixture, dir, detail);
    results.push(await score(w, count));
    if (detail === 'standard') baselineDir = dir;
  }
  results.push(await score(await baselineWorkflow(fixture, baselineDir), count));
  const out = {
    date: new Date().toISOString(),
    tokenizer: useAnthropic ? `anthropic count_tokens (${process.env.TMEP_BENCH_MODEL ?? 'claude-sonnet-5-5'})` : 'heuristic estimate (bench/tokens.ts, +-20% absolute)',
    task: USER_PROMPT,
    fixture: { dur: fixture.dur, words: fixture.words.length, tts: fixture.tts },
    machine: `${os.platform()} ${os.arch()} ${os.cpus().length} cpu, node ${process.version}`,
    results,
  };
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, JSON.stringify(out, null, 2));
  const fmt = (n: number) => n.toLocaleString('en-US');
  console.log(`tokenizer: ${out.tokenizer}\n`);
  console.log('| workflow | tool calls | output tokens | tool-result tokens | static/turn | cumulative input | largest message | wall time |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.workflow} | ${r.calls} | ${fmt(r.outputTokens)} | ${fmt(r.toolResultTokens)} | ${fmt(r.staticTokensPerTurn)} | ${fmt(r.cumulativeInputTokens)} | ${r.largestMessage.label} (${fmt(r.largestMessage.tokens)}) | ${r.wallMs ? `${(r.wallMs / 1000).toFixed(1)}s` : 'n/a'} |`);
  console.log(`\nwritten: ${outFile}`);
}

await main();

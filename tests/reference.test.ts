/** Encoded video fixtures exercise the actual FFmpeg analyzer, planner and renderer.
 * Controlled tones/timestamps test synchronization, not speech-recognition accuracy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../packages/engine/src/api.ts';
import { ffmpeg, probe } from '../packages/media/src/ffmpeg.ts';
import { runBinary } from '../packages/media/src/exec.ts';
import { fileURLToPath } from 'node:url';
import { compileAss } from '../packages/motion/src/compile.ts';
import { Project, timelineWords } from '../packages/core/src/index.ts';

test('reference video -> safe plan -> captioned MP4; slow reference changes pacing', {timeout:180000}, async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tmep-reference-e2e-'));
  const ctx:api.Ctx={project:dir,detail:'standard'};
  try {
    const source=path.join(dir,'source.mp4'), fast=path.join(dir,'fast.mp4'), slow=path.join(dir,'slow.mp4');
    await ffmpeg({args:['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=8','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]});
    for(const [file,period] of [[fast,1],[slow,4]] as const) await ffmpeg({args:['-f','lavfi','-i',`nullsrc=s=160x90:r=30:d=8,geq=lum='if(mod(floor(N/${30*period}),2),235,16)':cb=128:cr=128`,'-c:v','libx264','-pix_fmt','yuv420p',file]});
    await api.importMedia(ctx,{paths:[source,fast,slow]});
    await assert.rejects(api.plan(ctx,{src:'v1',reference:'v2'}),/measured word/);
    const words=Array.from({length:8},(_,i)=>({w:`Sentence${i}.`,s:i+0.1,e:i+0.7}));
    const truth=path.join(dir,'words.json');
    await writeFile(truth,JSON.stringify({words}));
    await api.transcribe(ctx,{asset:'v1',file:truth});
    const fastPlan=await api.plan(ctx,{reference:'v2',target:2,graphics:false,sfx:false,zooms:false});
    const p=await Project.open(dir), tl=await p.timeline();
    assert.equal(tl.clips[0]!.src,'v1','reference excluded from default source');
    assert.equal(fastPlan.dur,8);
    const mapped=timelineWords(tl,await api.transcriptsFor(p,['v1']));
    assert.equal(mapped.length,words.length);
    mapped.forEach((w,i)=>{assert.ok(Math.abs(w.s-words[i]!.s)<1/30);assert.ok(Math.abs(w.e-words[i]!.e)<1/30);});
    const ass = compileAss(tl, mapped).ass;
    const events = ass.split('\n').filter(l => l.startsWith('Dialogue: 2,')).map(l => {
      const parts = l.split(',');
      const seconds = (v: string) => v.split(':').reduce((a, b) => a * 60 + Number(b), 0);
      return { s: seconds(parts[1]!), e: seconds(parts[2]!), text: l };
    });
    for (const word of mapped) {
      const mid = (word.s + word.e) / 2;
      assert.ok(events.some(e => e.s <= mid && e.e >= mid && e.text.toLowerCase().includes(word.w.toLowerCase())), 'caption covers ' + word.w);
    }
    assert.equal((await api.reference(ctx,{asset:'v2'})).cached,true);
    const render=await api.render(ctx,{preview:true,wait:120});
    assert.equal(render.state,'done',JSON.stringify(render));
    const output=await probe(path.join(dir,String(render.out)));
    assert.ok(output.audio);
    assert.ok(Math.abs(output.dur-8)<0.1);
    assert.equal(output.w,540);
    const cli = fileURLToPath(new URL('../bin/tmep.js', import.meta.url));
    const slowPlan = JSON.parse((await runBinary(process.execPath, [cli, 'plan', '--project', dir, '--src', 'v1', '--reference', 'v3', '--no-graphics', '--no-sfx', '--no-zooms'])).toString());
    assert.ok(Number(fastPlan.clips)>Number(slowPlan.clips));
    await writeFile(truth,JSON.stringify({words,approx:true}));
    await api.transcribe(ctx,{asset:'v1',file:truth});
    await assert.rejects(api.plan(ctx,{src:'v1',reference:'v2'}),/measured word/);
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

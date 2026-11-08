import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]??'../tmep-launch-reel');
const timeline=JSON.parse(await fs.readFile(path.join(out,'editorial-timeline.json'),'utf8'));
const normalize=s=>s.replace(/\s+/g,' ').trim();
assert.equal(normalize(timeline.captions.map(c=>c.text).join(' ')),normalize(await fs.readFile(path.join(here,'script.txt'),'utf8')),'Entire supplied script is preserved');
const ctx=createCanvas(1080,1920).getContext('2d');
timeline.captions.forEach((cap,i)=>{assert.ok(cap.lines.length<=3);ctx.font='600 51px "Segoe UI"';cap.lines.forEach(l=>assert.ok(ctx.measureText(l).width<=830));if(i)assert.equal(cap.start,timeline.captions[i-1].end);});
for(const s of timeline.scenes){const size=s.title.some(t=>t.length>20)?67:83;ctx.font=`600 ${size}px "Segoe UI"`;s.title.forEach(t=>assert.ok(ctx.measureText(t).width<900,'Headline safe width'));}
const run=(bin,args)=>{const r=spawnSync(bin,args,{maxBuffer:64*1024*1024});if(r.status!==0)throw Error(r.stderr?.toString()||String(r.error));return r.stdout;};
const video=path.join(out,'TMEP-launch-reel.mp4'),ff=process.env.TMEP_FFMPEG??'ffmpeg';
const probe=JSON.parse(run(process.env.TMEP_FFPROBE??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',video]));
const v=probe.streams.find(s=>s.codec_type==='video');assert.equal(v.width,1080);assert.equal(v.height,1920);assert.equal(v.r_frame_rate,'60/1');assert.equal(Number(v.nb_frames),timeline.frames);assert.equal(probe.streams.length,1,'Silent by design');
run(ff,['-v','error','-i',video,'-f','null','-']);
const raw=run(ff,['-v','error','-i',video,'-vf','scale=64:114,format=gray','-f','rawvideo','pipe:1']);const size=64*114,means=[],deltas=[];
for(let f=0;f<timeline.frames;f++){let sum=0,delta=0;for(let j=0;j<size;j++){sum+=raw[f*size+j];if(f)delta+=Math.abs(raw[f*size+j]-raw[(f-1)*size+j]);}means.push(sum/size);if(f)deltas.push({frame:f,time:f/60,delta:delta/size});}
assert.ok(Math.min(...means)>3,'No near-empty frame');
const sheet=createCanvas(1080,1920),sc=sheet.getContext('2d');await fs.mkdir(path.join(out,'frames'),{recursive:true});
for(let i=0;i<timeline.scenes.length;i++){const s=timeline.scenes[i],file=path.join(out,'frames',`scene-${i+1}.png`);run(ff,['-v','error','-y','-ss',String((s.start+s.end)/2),'-i',video,'-frames:v','1',file]);sc.drawImage(await loadImage(file),(i%3)*360,Math.floor(i/3)*640,360,640);}
await fs.writeFile(path.join(out,'contact-sheet.png'),sheet.toBuffer('image/png'));
for(const [name,t] of [['first',0],['last',timeline.duration-1/60]])run(ff,['-v','error','-y','-ss',String(t),'-i',video,'-frames:v','1',path.join(out,'frames',`${name}.png`)]);
// Inspect the exact end/start neighborhood of each scene. Six-frame sampling covers 0.8 s.
for(let i=1;i<timeline.scenes.length;i++)run(ff,['-v','error','-y','-ss',String(Math.max(0,timeline.scenes[i].start-.3)),'-i',video,'-vf',"select='not(mod(n,6))',scale=216:384,tile=8x1",'-frames:v','1',path.join(out,'frames',`transition-${i}.png`)]);
const report={resolution:'1080x1920',fps:60,frames:Number(v.nb_frames),duration:Number(probe.format.duration),bytes:Number(probe.format.size),audio:'none, intentionally',captionSegments:timeline.captions.length,fullScriptPreserved:true,captionWidthCheck:true,headlineWidthCheck:true,fullDecode:true,minMeanLuma:Math.min(...means),largestFrameDeltas:deltas.sort((a,b)=>b.delta-a.delta).slice(0,12),timingSource:timeline.timingSource};
await fs.writeFile(path.join(out,'quality-checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));


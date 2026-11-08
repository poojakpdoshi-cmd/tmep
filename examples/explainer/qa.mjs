import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const dir=path.resolve(process.argv[2]??'../trial');
const file=path.join(dir,process.argv[3]??'trial-visual-only.mp4');
const run=(bin,args,extra={})=>{const r=spawnSync(bin,args,{maxBuffer:32*1024*1024,...extra});if(r.status!==0)throw Error(r.stderr?.toString()||String(r.error));return r.stdout;};
const probe=JSON.parse(run(process.env.TMEP_FFPROBE??'ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
const v=probe.streams.find(s=>s.codec_type==='video');const plan=JSON.parse(await fs.readFile(path.join(dir,'timeline.json'),'utf8'));
if(v.width!==1080||v.height!==1920||v.r_frame_rate!=='60/1'||Number(v.nb_frames)!==plan.frames)throw Error('Resolution, frame rate or frame count failed');
const ff=process.env.TMEP_FFMPEG??'ffmpeg';
run(ff,['-v','error','-i',file,'-f','null','-']);
const raw=run(ff,['-v','error','-i',file,'-vf','scale=64:114,format=gray','-f','rawvideo','pipe:1']);
const size=64*114,differences=[],means=[];
for(let f=0;f<raw.length/size;f++){let sum=0,diff=0;for(let j=0;j<size;j++){sum+=raw[f*size+j];if(f)diff+=Math.abs(raw[f*size+j]-raw[(f-1)*size+j]);}means.push(sum/size);if(f)differences.push({frame:f,delta:diff/size});}
const top=[...differences].sort((a,b)=>b.delta-a.delta).slice(0,12);
const min=Math.min(...means);if(min<3)throw Error('Possible blank frame');
const selected=[0,...plan.starts.map((s,i)=>(s+(plan.starts[i+1]??plan.duration))/2),plan.duration-1/60];
await fs.mkdir(path.join(dir,'frames'),{recursive:true});
for(let i=0;i<selected.length;i++)run(ff,['-v','error','-y','-ss',String(selected[i]),'-i',file,'-frames:v','1',path.join(dir,'frames',`scene-${i}.png`)]);
run(ff,['-v','error','-y','-i',file,'-vf','fps=1/4,scale=270:480,tile=5x1','-frames:v','1',path.join(dir,'contact-sheet.png')]);
// Adjacent frames across each transition, extracted from the final encoded MP4.
for(let i=1;i<plan.starts.length;i++)run(ff,['-v','error','-y','-ss',String(plan.starts[i]-1/60),'-i',file,'-vf','scale=216:384,tile=8x4','-frames:v','1',path.join(dir,`transition-${i}.png`)]);
await fs.writeFile(path.join(dir,'qa.json'),JSON.stringify({width:v.width,height:v.height,fps:v.r_frame_rate,frames:v.nb_frames,duration:probe.format.duration,audioStreams:probe.streams.filter(s=>s.codec_type==='audio').length,decoded:true,minMeanLuma:min,maxMeanLuma:Math.max(...means),largestFrameDeltas:top,captionQuantizationToleranceMs:1000/60,realSpeechSyncMeasured:false},null,2));
console.log(JSON.stringify({frames:v.nb_frames,minMeanLuma:min,largestFrameDeltas:top.slice(0,3)}));

import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {planExplainer} from '../../packages/motion/src/explainer-plan.ts';
import {createExplainer} from '../../packages/motion/src/explainer-canvas.mjs';
import {probe,ffmpegInfo,ffmpeg} from '../../packages/media/src/ffmpeg.ts';
import {transcribeWhisperCpp,transcribeFasterWhisper} from '../../packages/speech/src/engines.ts';

const configFile=path.resolve(process.argv[2]??'examples/explainer/preview.json');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
const relative=p=>path.resolve(path.dirname(configFile),p);
const out=relative(config.output??'../../../trial');await fs.mkdir(out,{recursive:true});
let transcript, audio, duration=config.duration??20;
if(config.audio){audio=relative(config.audio);const info=await probe(audio);if(!info.audio)throw Error('Narration input has no audio stream.');duration=info.dur;
  if(config.transcript)transcript=await fs.readFile(relative(config.transcript),'utf8');
  else{const wav=path.join(out,'narration-16k.wav');await ffmpeg({args:['-i',audio,'-vn','-ar','16000','-ac','1',wav]});
    const tr=config.engine==='faster-whisper'?await transcribeFasterWhisper(wav,{lang:config.lang}):await transcribeWhisperCpp(wav,out,{lang:config.lang});transcript=JSON.stringify(tr);await fs.writeFile(path.join(out,'transcript.json'),transcript);}
}else if(config.transcript)throw Error('A transcript requires its matching narration audio.');
const plan=planExplainer(duration,transcript,config.sceneStarts);
if(config.script && transcript){const script=await fs.readFile(relative(config.script),'utf8');const norm=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');if(norm(script)!==norm(plan.words.map(w=>w.w).join(' ')))throw Error('Script differs from transcript. Correct or force-align externally; no timestamps were invented.');}
await fs.writeFile(path.join(out,'timeline.json'),JSON.stringify(plan,null,2));
const renderer=createExplainer(plan,config);
await fs.writeFile(path.join(out,'illustration.png'),renderer.art.toBuffer('image/png'));
await fs.writeFile(path.join(out,'captions.json'),JSON.stringify(renderer.groups,null,2));
const binaries=await ffmpegInfo();
const base=path.join(out,plan.preview?'trial-visual-only.mp4':'trial-caption-free.mp4');
const args=['-hide_banner','-loglevel','error','-n','-f','rawvideo','-pix_fmt','rgba','-s','1080x1920','-r','60','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart',base];
const child=spawn(binaries.ffmpeg,args,{stdio:['pipe','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);let pipeError;child.stdin.on('error',e=>pipeError=e);const done=once(child,'close');
for(let f=0;f<plan.frames;f++){
  const canvas=renderer.draw(f,{captions:false});
  if(pipeError)throw pipeError;
  if(!child.stdin.write(canvas.data()))await Promise.race([once(child.stdin,'drain'),done.then(()=>{throw Error(stderr||'Encoder stopped');})]);
  if(f%120===0)console.log(`Rendered ${f}/${plan.frames} frames`);
}
child.stdin.end();const [code]=await done;if(code!==0)throw Error(stderr);
// Keep the no-narration preview silent; never fabricate a narration or caption track.
if(audio){
  const raw=path.join(out,'visual-master.mp4');await fs.rename(base,raw);
  await ffmpeg({args:['-i',raw,'-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','copy','-af',`apad=whole_dur=${plan.duration}`,'-t',String(plan.duration),'-c:a','aac','-b:a','192k','-movflags','+faststart',base]});
  // A second deterministic pass adds captions, without a large lossless intermediate.
  const capVideo=path.join(out,'captioned-visual-master.mp4');
  const cp=spawn(binaries.ffmpeg,['-hide_banner','-loglevel','error','-n','-f','rawvideo','-pix_fmt','rgba','-s','1080x1920','-r','60','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',capVideo],{stdio:['pipe','ignore','pipe']});let err='';cp.stderr.on('data',b=>err+=b);const closed=once(cp,'close');cp.stdin.on('error',()=>{});
  for(let f=0;f<plan.frames;f++){const c=renderer.draw(f);if(!cp.stdin.write(c.data()))await Promise.race([once(cp.stdin,'drain'),closed.then(()=>{throw Error(err);})]);}cp.stdin.end();if((await closed)[0]!==0)throw Error(err);
  await ffmpeg({args:['-i',capVideo,'-i',base,'-map','0:v','-map','1:a','-c:v','copy','-c:a','copy','-movflags','+faststart',path.join(out,'trial-captioned.mp4')]});
}
// Presenter assets must have genuine alpha for transparent mode. Opaque facecam uses a reserved slot.
if(config.presenter){const p=config.presenter;const asset=relative(p.path);const info=await probe(asset);if(info.kind!=='video'&&info.kind!=='image')throw Error('Presenter must be a video or image.');
  if(info.kind==='video'&&info.dur+1/60<duration)throw Error('Presenter is shorter than narration; supply a complete recording.');
  if(p.mode==='transparent'){
    const {run}=await import('../../packages/media/src/exec.ts');const r=await run(binaries.ffprobe,['-v','error','-show_streams','-of','json',asset]);const streams=JSON.parse(r.stdout).streams;
    if(!streams.some(s=>/^(rgba|bgra|argb|abgr|yuva|gbrap)/.test(s.pix_fmt??'')||s.tags?.alpha_mode==='1'))throw Error('Transparent mode requires an alpha-channel image/video. Background removal is not provided.');
  }else if(p.mode!=='facecam')throw Error('presenter.mode must be facecam or transparent.');
  const files=audio?['trial-caption-free.mp4','trial-captioned.mp4']:['trial-visual-only.mp4'];
  for(const name of files)await ffmpeg({args:['-i',path.join(out,name),...(info.kind==='image'?['-loop','1']:[]),'-i',asset,'-filter_complex','[1:v]scale=280:290:force_original_aspect_ratio=decrease,format=rgba[p];[0:v][p]overlay=x=650+(280-w)/2:y=1225+(290-h)/2:eof_action=pass[v]','-map','[v]','-map','0:a?','-t',String(plan.duration),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','copy',path.join(out,name.replace('.mp4','-presenter.mp4'))]});
}
console.log(JSON.stringify({out,frames:plan.frames,preview:plan.preview}));

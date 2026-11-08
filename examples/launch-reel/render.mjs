import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {createLaunchReel} from '../../packages/motion/src/launch-reel.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]??'../tmep-launch-reel');await fs.mkdir(out,{recursive:true});
const story=JSON.parse(await fs.readFile(path.join(here,'storyboard.json'),'utf8'));const reel=createLaunchReel(story);
await fs.writeFile(path.join(out,'editorial-timeline.json'),JSON.stringify({timingSource:story.timingSource,fps:reel.fps,frames:reel.frames,duration:reel.duration,scenes:reel.scenes,captions:reel.captions},null,2));
const tc=t=>{const n=Math.round(t*1000);return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')},${String(n%1000).padStart(3,'0')}`;};
await fs.writeFile(path.join(out,'captions-editorial.srt'),reel.captions.map((c,i)=>`${i+1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.lines.join('\n')}\n`).join('\n'));
const sheet=createCanvas(1080,1920),sc=sheet.getContext('2d');
for(let i=0;i<reel.scenes.length;i++){const s=reel.scenes[i];const b=reel.draw(Math.floor((s.start+s.end)/2*60)).toBuffer('image/png');await fs.writeFile(path.join(out,`design-${i+1}.png`),b);sc.drawImage(await loadImage(b),(i%3)*360,Math.floor(i/3)*640,360,640);}
await fs.writeFile(path.join(out,'design-contact-sheet.png'),sheet.toBuffer('image/png'));
if(!process.argv.includes('--stills')){
  const target=path.join(out,'TMEP-launch-reel.mp4');
  const child=spawn(process.env.TMEP_FFMPEG??'ffmpeg',['-hide_banner','-loglevel','error','-n','-f','rawvideo','-pix_fmt','rgba','-s','1080x1920','-r','60','-i','pipe:0','-an','-vf','scale=out_color_matrix=bt709','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart',target],{stdio:['pipe','ignore','pipe']});
  let error='';child.stderr.on('data',b=>error+=b);child.stdin.on('error',()=>{});const closed=once(child,'close');let ended=false;closed.then(()=>ended=true);
  for(let f=0;f<reel.frames;f++){if(ended)throw Error(error||'Encoder stopped');if(!child.stdin.write(reel.draw(f).data()))await Promise.race([once(child.stdin,'drain'),closed.then(()=>{throw Error(error||'Encoder stopped');})]);if(f%600===0)console.log(`Rendered ${f}/${reel.frames}`);}
  child.stdin.end();if((await closed)[0]!==0)throw Error(error);console.log(target);
}
console.log(JSON.stringify({duration:reel.duration,frames:reel.frames,captions:reel.captions.length}));

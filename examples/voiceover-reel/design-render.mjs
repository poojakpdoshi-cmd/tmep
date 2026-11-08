import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ChromePage} from '../../packages/media/src/chrome.ts';
const out=resolve('../quality-prototype');mkdirSync(out,{recursive:true});
const version=process.argv[2]||'v1';
const asset=readFileSync('examples/voiceover-reel/assets/coast.png').toString('base64');
const html=readFileSync('examples/voiceover-reel/design.html','utf8').replace('ASSET',asset).replace('VERSION',version==='v2'?'2':'1');
const file=join(out,`design-${version}.html`);writeFileSync(file,html);
const page=await ChromePage.launch();await page.open(pathToFileURL(file).href,1080,1920);await page.eval('document.fonts.ready');await page.eval('img.decode()');
const enc=spawn('ffmpeg',['-v','error','-n','-f','image2pipe','-framerate','60','-c:v','mjpeg','-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',join(out,`TMEP-quality-prototype-${version}.mp4`)],{stdio:['pipe','inherit','inherit']});const done=once(enc,'close');enc.stdin.on('error',()=>{});
try{for(let f=0;f<900;f++){await page.eval(`draw(${f}/60)`);const b=await page.screenshot(1080,1920,1,'jpeg');if(!enc.stdin.write(b))await once(enc.stdin,'drain');if(f%180===0)console.log(f);}enc.stdin.end();if((await done)[0]!==0)throw Error('encode failed');}finally{await page.close();}

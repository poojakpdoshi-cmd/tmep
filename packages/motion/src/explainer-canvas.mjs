import {createCanvas} from '@napi-rs/canvas';
import {ease, phraseGroups} from './explainer-plan.ts';

const C={bg:'#091322',panel:'#101f33',line:'#29405a',blue:'#5a9dff',white:'#f4f7fd',muted:'#98abc3'};
export function createExplainer(plan, config={}) {
  const canvas=createCanvas(1080,1920), ctx=canvas.getContext('2d');
  const font=config.font??'Segoe UI';
  const cap=config.captions??{};
  const fontSize=cap.fontSize??48;
  if(fontSize<28||fontSize>64)throw Error('Caption fontSize must be 28–64.');
  const text=(s,x,y,size=38,color=C.white,weight=400)=>{ctx.font=`${weight} ${size}px "${font}"`;ctx.fillStyle=color;ctx.fillText(s,x,y);};
  const rect=(x,y,w,h,fill,r=0)=>{ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();};
  const line=(x,y,x2,y2,col=C.line,width=2)=>{ctx.strokeStyle=col;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x2,y2);ctx.stroke();};
  const label=(s,y)=>text(s,86,y,25,C.blue,600);
  const title=(a,b)=>{text(a,82,324,88,C.white,600);text(b,82,425,88,C.white,600);};
  const cover=(im,x,y,w,h)=>{const scale=Math.max(w/im.width,h/im.height),sw=w/scale,sh=h/scale;ctx.drawImage(im,(im.width-sw)/2,(im.height-sh)/2,sw,sh,x,y,w,h);};
  const roundedImage=(im,x,y,w,h,r=24)=>{ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.clip();cover(im,x,y,w,h);ctx.restore();};
  // Original vector landscape: this is an illustration, never represented as model output.
  const art=createCanvas(900,900), a=art.getContext('2d');
  const g=a.createLinearGradient(0,0,0,900);g.addColorStop(0,'#213e67');g.addColorStop(.55,'#e9b58c');g.addColorStop(1,'#5787a0');a.fillStyle=g;a.fillRect(0,0,900,900);
  a.fillStyle='#fff0c5';a.beginPath();a.arc(623,230,78,0,Math.PI*2);a.fill();
  const poly=(pts,col)=>{a.fillStyle=col;a.beginPath();pts.forEach(([x,y],i)=>i?a.lineTo(x,y):a.moveTo(x,y));a.closePath();a.fill();};
  poly([[0,540],[0,390],[145,260],[280,440],[440,225],[665,470],[790,320],[900,435],[900,600]],'#69849a');
  poly([[350,350],[440,225],[540,352],[478,329],[440,285],[400,337]],'#dce8e8');
  poly([[0,620],[0,460],[180,345],[390,610],[655,389],[900,540],[900,675]],'#365872');
  poly([[0,680],[0,588],[233,522],[460,660],[688,549],[900,604],[900,730]],'#1c4058');
  const water=a.createLinearGradient(0,640,0,900);water.addColorStop(0,'#7ca9ba');water.addColorStop(1,'#193b56');a.fillStyle=water;a.fillRect(0,664,900,236);
  for(let i=0;i<24;i++){a.fillStyle=`rgba(255,227,183,${.23*(1-i/28)})`;const w=30+i*6;a.fillRect(623-w/2+Math.sin(i*2)*12,680+i*8,w,2);}
  poly([[0,900],[0,774],[130,750],[290,840],[400,900]],'#112c3a');poly([[900,900],[900,730],[825,760],[740,900]],'#102c3d');
  for(const [x,y,s] of [[90,755,1],[155,790,.7],[843,780,.9],[800,837,.65]]){a.fillStyle='#0b2632';a.fillRect(x-3,y-120*s,6,150*s);for(let k=0;k<3;k++)poly([[x,y-(175-k*35)*s],[x-(38+k*10)*s,y-(65-k*24)*s],[x+(38+k*10)*s,y-(65-k*24)*s]],'#0b2632');}
  const low=createCanvas(20,20);low.getContext('2d').drawImage(art,0,0,20,20);
  const field=createCanvas(20,20),fieldCtx=field.getContext('2d');
  for(let y=0;y<20;y++)for(let x=0;x<20;x++){const n=((x*73+y*139+x*y*31)%149)/149;fieldCtx.fillStyle=`rgb(${Math.round(35+n*75)},${Math.round(63+n*83)},${Math.round(94+n*84)})`;fieldCtx.fillRect(x,y,1,1);}
  ctx.font=`600 ${fontSize}px "${font}"`;
  const groups=phraseGroups(plan.words,s=>ctx.measureText(s).width,820);
  const transition=.48;
  function promptPanel(amount=1,y=565){
    rect(82,y,856,300,C.panel,26);line(108,y+76,912,y+76);text('PROMPT',114,y+49,23,C.muted,600);
    const str='An alpine lake at sunrise';const n=Math.floor(str.length*amount);
    text(str.slice(0,n),118,y+153,49,C.white,500);
    text('Soft light. Still water. A quiet horizon.'.slice(0,Math.max(0,Math.floor((amount-.45)/.55*40))),118,y+219,29,C.muted);
    if(amount<1){ctx.font=`500 49px "${font}"`;rect(120+ctx.measureText(str.slice(0,n)).width,y+111,3,53,C.blue);}
  }
  function scene(i,t){
    const start=plan.starts[i],end=plan.starts[i+1]??plan.duration;
    const p=Math.max(0,Math.min(1,(t-start)/(end-start)));
    label(['01 / THE IDEA','02 / THE PROMPT','03 / LEARNED PATTERNS','04 / THE RESULT','05 / THE BIG PICTURE'][i],210);
    if(i===0){title('Start with','a few words.');promptPanel(ease((p-.12)/.75));
      text('Describe the scene you want to see.',86,1040,35,C.muted);
      line(86,1134,934,1134);text('Language becomes creative direction.',86,1190,31,C.white);
    } else if(i===1){title('Your words','set the direction.');promptPanel(1,565);
      const tokens=[['ALPINE LAKE',86,232],['SUNRISE',338,200],['SOFT LIGHT',558,236]];
      for(let k=0;k<tokens.length;k++){const [s,x,w]=tokens[k];const q=ease((p-.08-k*.13)/.3);ctx.save();ctx.globalAlpha=q;rect(x,970+(1-q)*22,w,64,'#1b3553',12);text(s,x+18,1012+(1-q)*22,24,C.blue,600);ctx.restore();}
      line(116,1116,904,1116);text('Subject',86,1180,30,C.muted);text('Setting',370,1180,30,C.muted);text('Style',654,1180,30,C.muted);
    } else if(i===2){title('Learned patterns.','New possibilities.');
      text('The model uses patterns learned in training.',86,521,31,C.muted);
      // Stable matrix resolves into the SAME landscape; no random particles or camera jumps.
      const q=ease((p-.05)/.85),alpha=ctx.globalAlpha;ctx.save();ctx.beginPath();ctx.roundRect(82,565,856,760,24);ctx.clip();
      ctx.imageSmoothingEnabled=false;cover(field,82,565,856,760);ctx.globalAlpha=alpha*ease(p/.65);cover(low,82,565,856,760);ctx.imageSmoothingEnabled=true;ctx.globalAlpha=alpha*q;cover(art,82,565,856,760);ctx.globalAlpha=alpha*(1-q)*.65;
      for(let k=0;k<20;k++){line(82+k*42.8,565,82+k*42.8,1325,C.bg,2);line(82,565+k*38,938,565+k*38,C.bg,2);}ctx.restore();
      text('Conceptual illustration of refinement',86,1400,29,C.muted);
    } else if(i===3){title('From an idea','to an image.');
      roundedImage(art,82,565,856,760);
      text('“An alpine lake at sunrise”',86,1380,36,C.white,500);
      text('Original vector illustration • not live generation',86,1430,25,C.muted);
    } else {title('A few words.','A new visual.');
      roundedImage(art,82,565,856,760);
      const q=ease((p-.05)/.45);ctx.save();ctx.globalAlpha=q;
      text('PROMPT',86,1390,27,C.blue,600);line(238,1380,330,1380,C.blue,3);text('PATTERNS',365,1390,27,C.blue,600);line(540,1380,632,1380,C.blue,3);text('IMAGE',669,1390,27,C.blue,600);ctx.restore();
      text('That’s generative AI.',86,1492,46,C.white,600);
    }
  }
  function draw(frame,{captions=true}={}){
    const t=frame/plan.fps;ctx.globalAlpha=1;rect(0,0,1080,1920,C.bg);
    text('TMEP / EXPLAINED',86,112,26,C.muted,600);line(86,148,934,148);
    // Presenter mode scales the visual region into the top band, preserving captions below.
    ctx.save();if(config.presenter){ctx.translate(32,80);ctx.scale(.92,.78);}
    let i=plan.starts.findLastIndex(s=>t>=s);i=Math.max(0,i);
    const q=i>0?ease((t-plan.starts[i])/transition):1;
    if(q<1){
      scene(i-1,t);
      // An eased editorial wipe keeps text fully opaque, avoiding overlapping headlines.
      ctx.save();ctx.beginPath();ctx.rect(0,160,1080,1400*q);ctx.clip();rect(0,160,1080,1400,C.bg);scene(i,t);ctx.restore();
    }else scene(i,t);
    ctx.restore();
    if(captions && !plan.preview){const group=groups.find(g=>t>=g.s&&t<g.e);if(group){
      const y=1585;rect(62,y-58,876,group.lines.length*64+40,'#07101f',18);
      ctx.font=`600 ${fontSize}px "${font}"`;
      group.lines.forEach((words,row)=>{let x=500-ctx.measureText(words.map(w=>w.w).join(' ')).width/2;for(const w of words){text(w.w,x,y+row*64,fontSize,cap.highlight!==false&&t>=w.s&&t<w.e?(cap.accent??C.blue):C.white,600);x+=ctx.measureText(w.w+' ').width;}});
    }}
    text(plan.preview?'VISUAL-ONLY PREVIEW • NO NARRATION':'TEXT → IMAGE / CONCEPTUAL EXPLAINER',86,1780,23,C.muted,500);
    rect(86,1820,848,3,C.line);rect(86,1820,848*Math.min(1,t/(plan.duration-1/plan.fps)),3,C.blue);
    return canvas;
  }
  return {canvas,draw,groups,art};
}

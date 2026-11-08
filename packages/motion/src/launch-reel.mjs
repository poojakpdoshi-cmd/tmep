import {createCanvas} from '@napi-rs/canvas';
import {ease} from './explainer-plan.ts';

export function createLaunchReel(story){
  const fps=60,canvas=createCanvas(1080,1920),c=canvas.getContext('2d');
  const P={bg:'#081323',panel:'#11243a',line:'#29405a',blue:'#62a7ff',ink:'#f4f7fc',muted:'#9fb1c9',mint:'#8edbcb',amber:'#e7bb7b'};
  const captions=[],scenes=[];let clock=0;
  for(const src of story.scenes){const scene={...src,start:clock};for(const text of src.captions){const seconds=Math.max(2.5,text.split(/\s+/).length/2.65+.35);const frames=Math.ceil(seconds*fps);captions.push({text,start:clock,end:clock+frames/fps,scene:scenes.length});clock+=frames/fps;}scene.end=clock;scenes.push(scene);}
  const duration=clock+.8,frames=Math.round(duration*fps);
  const text=(s,x,y,size=38,color=P.ink,weight=500)=>{c.font=`${weight} ${size}px "Segoe UI"`;c.fillStyle=color;c.fillText(s,x,y);};
  const box=(x,y,w,h,color=P.panel,r=20)=>{c.fillStyle=color;c.beginPath();c.roundRect(x,y,w,h,r);c.fill();};
  const line=(x,y,X,Y,color=P.line,width=2)=>{c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(X,Y);c.stroke();};
  const circle=(x,y,r,color)=>{c.fillStyle=color;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();};
  const center=(s,x,y,size,color=P.ink,weight=600)=>{c.font=`${weight} ${size}px "Segoe UI"`;text(s,x-c.measureText(s).width/2,y,size,color,weight);};
  const arrow=(x,y,X,Y,color=P.blue)=>{line(x,y,X,Y,color,3);const a=Math.atan2(Y-y,X-x);line(X,Y,X-13*Math.cos(a-.55),Y-13*Math.sin(a-.55),color,3);line(X,Y,X-13*Math.cos(a+.55),Y-13*Math.sin(a+.55),color,3);};
  function wave(x,y,w,t,scale=1,color=P.blue){for(let k=0;k<35;k++){const env=.25+.75*Math.sin((k+1)/36*Math.PI);const h=(18+42*(.5+.5*Math.sin(k*.8+t*2.6)))*env*scale;box(x+k*w/35,y-h/2,Math.max(3,w/35-5),h,color,3);}}
  function icon(kind,x,y,s,color=P.blue){c.save();c.translate(x,y);c.scale(s/100,s/100);c.strokeStyle=color;c.lineWidth=5;c.lineCap='round';
    if(kind==='voice'){c.beginPath();c.roundRect(34,10,32,52,16);c.stroke();c.beginPath();c.arc(50,48,29,0,Math.PI);c.stroke();line(50,77,50,94,color,5);line(32,94,68,94,color,5);}
    if(kind==='caption'){c.strokeRect(8,18,84,65);text('CC',20,66,37,color,700);}
    if(kind==='motion'){c.strokeRect(15,17,30,30);circle(70,69,18,color);arrow(23,73,48,73,color);}
    if(kind==='edit'){for(let k=0;k<3;k++){line(9,24+k*26,91,24+k*26,color,4);circle(30+k*18,24+k*26,6,P.bg);circle(30+k*18,24+k*26,4,color);}}
    if(kind==='play'){c.beginPath();c.moveTo(35,20);c.lineTo(79,50);c.lineTo(35,80);c.closePath();c.stroke();}
    if(kind==='code'){line(35,23,10,50,color,5);line(10,50,35,77,color,5);line(65,23,90,50,color,5);line(90,50,65,77,color,5);line(57,15,43,85,color,4);}
    c.restore();
  }
  function phone(x,y,w,h,t,face=false){box(x-3,y-3,w+6,h+6,P.line,34);box(x,y,w,h,'#0c1b2f',32);box(x+w*.35,y+15,w*.3,6,P.line,3);
    const inner=w-38,ix=x+19,iy=y+65;box(ix,iy,inner,h*.48,'#183956',12);
    if(face){icon('play',x+w/2-35,iy+48,70,P.blue);center('FACECAM',x+w/2,iy+h*.34,22,P.ink);}else{for(let k=0;k<3;k++){const bw=inner*(.35+.16*k);box(ix+18,iy+28+k*53,bw*(.65+.35*Math.sin(t*.8+k*.3)),18,k===2?P.mint:P.blue,5);}icon('motion',x+w/2-30,iy+h*.3,60,P.blue);}
    box(ix,y+h*.69,inner,44,'#21324a',8);box(ix+13,y+h*.69+14,inner*.7,6,P.ink,3);box(ix+13,y+h*.69+27,inner*.48,5,P.muted,3);
    line(ix,y+h*.86,ix+inner,y+h*.86,P.line,3);line(ix,y+h*.86,ix+inner*(.25+.6*(.5-.5*Math.cos(t*.6))),y+h*.86,P.blue,3);
  }
  function timeline(x,y,w,t,aligned=false){const labels=['CAPTIONS','GRAPHICS','MOTION','TRANSITIONS'];for(let i=0;i<4;i++){text(labels[i],x,y+i*115,23,P.muted,600);line(x,y+32+i*115,x+w,y+32+i*115);for(let j=0;j<3;j++){const target=x+j*(w/3)+10,offset=aligned?0:(i%2?35:-10);const xx=target+offset*(1-ease(t/2));box(xx,y+45+i*115,w/3-28,37,i===0?'#376ba2':i===1?'#235d6b':'#233e5c',7);}}
    const play=x+w*(.12+.76*(.5-.5*Math.cos(t*.45)));line(play,y+19,play,y+438,P.ink,2);circle(play,y+17,5,P.ink);
  }
  function content(s,local,p,page){
    if(s.kind==='hook'){
      box(80,560,390,360);text('VOICE IN',112,614,24,P.muted,600);icon('voice',210,650,112);wave(115,840,310,local,1);
      arrow(490,752,583,752);phone(626,510,302,610,local);text('REEL OUT',658,1190,25,P.blue,600);
      box(80,1250,850,96,'#10263d',18);center('Less editing. More creating.',505,1312,40,P.ink);
    }else if(s.kind==='intro'){
      const q=ease(local/1.2);c.save();c.translate(505,820);c.scale(.93+.07*q,.93+.07*q);center('TMEP',0,30,192,P.ink,700);c.restore();line(90,944,920,944,P.blue,4);
      text('AN OPEN-SOURCE VIDEO EDITING PROJECT',90,1020,28,P.muted,600);icon('code',90,1120,85);text('Built in public.',220,1180,48);text('Designed around your ideas.',220,1240,32,P.muted);
    }else if(s.kind==='problem'){
      box(80,545,850,680);timeline(115,620,770,local,false);
      circle(122,1305,31,P.panel);line(122,1305,122,1284,P.amber,3);line(122,1305,139,1316,P.amber,3);text('Every layer needs attention.',175,1320,36,P.amber);
    }else if(s.kind==='solution'){
      const q=ease(local/2.5);const kinds=['voice','caption','motion','play'];for(let i=0;i<4;i++){const x=120+i*218,y=710+(i%2?80:-45)*(1-q);circle(x+40,y+40,73,P.panel);icon(kinds[i],x,y,80);if(i<3)arrow(x+121,y+40,x+150,y+40);}
      box(80,1000,850,190);center('ONE CONNECTED WORKFLOW',505,1080,34,P.ink);center('That’s the goal.',505,1140,38,P.blue);
      text('Concept illustration • in development',85,1300,29,P.muted);
    }else if(s.kind==='workflow'){
      const labels=['Upload voiceover','Analyze speech','Captions + graphics','Assemble the reel'];const kinds=['voice','edit','caption','play'];const active=Math.min(3,page);
      line(146,635,146,1200,P.line,4);
      for(let i=0;i<4;i++){const y=570+i*180;box(85,y,840,146,i===active?'#193b5b':P.panel,18);circle(145,y+72,35,i===active?P.blue:'#1d354d');center(String(i+1),145,y+84,32,i===active?P.bg:P.muted);icon(kinds[i],212,y+33,70,i===active?P.mint:P.blue);text(labels[i],318,y+86,39,i===active?P.ink:P.muted,600);if(i===active){const u=(.5-.5*Math.cos(local*1.2));box(318,y+113,540*u,3,P.blue);}}
      text('Planned workflow • not a live software demo',85,1350,28,P.muted);
    }else if(s.kind==='modes'){
      phone(115,545,338,652,local,true);phone(580,545,338,652,local,false);center('WITH FACECAM',284,1270,30,P.ink);center('VOICE + VISUALS',749,1270,30,P.ink);line(515,700,515,1070,P.line,2);
    }else if(s.kind==='open'){
      box(80,550,850,392);circle(112,587,6,P.blue);circle(136,587,6,P.muted);circle(160,587,6,P.line);text('tmep / open source',197,596,24,P.muted);line(105,622,905,622);icon('code',120,695,95);text('Explore. Contribute. Improve.',265,755,39,P.ink,600);text('A project you can help shape.',265,820,30,P.muted);
      const nodes=[[200,1110],[505,1015],[810,1110],[505,1270]];for(let i=0;i<4;i++){const [x,y]=nodes[i];if(i)line(200,1110,x,y,P.blue,3);}nodes.forEach(([x,y],i)=>{circle(x,y,24,P.panel);circle(x,y,10,i===3?P.mint:P.blue);});
      center('github.com/poojakpdoshi-cmd/tmep',505,1380,30,P.muted);
    }else if(s.kind==='progress'){
      const labels=['PROGRESS','CHALLENGES','RESULTS'];for(let i=0;i<3;i++){const y=590+i*220;box(80,y,850,176);text(`0${i+1}`,110,y+67,31,P.blue);text(labels[i],210,y+69,38,P.ink,600);text(['What works today','What still needs work','What we learn next'][i],210,y+124,31,P.muted);line(110,y+143,160,y+143,i===1?P.amber:P.mint,4);}
      box(80,1290,850,70,'#263024',14);center('STILL UNDER DEVELOPMENT',505,1337,27,P.amber,600);
    }else{
      center('TMEP',505,820,190,P.ink,700);line(90,912,920,912,P.blue,4);center('OPEN SOURCE. IN PROGRESS.',505,992,31,P.muted,600);
      box(160,1100,690,132,P.blue,24);center('Follow the build',505,1186,52,P.bg,700);center('github.com/poojakpdoshi-cmd/tmep',505,1320,30,P.muted);
    }
  }
  const wrap=(s,width,size)=>{c.font=`600 ${size}px "Segoe UI"`;const rows=[''];for(const w of s.split(' ')){const i=rows.length-1;if(rows[i]&&c.measureText(rows[i]+' '+w).width>width)rows.push(w);else rows[i]+=(rows[i]?' ':'')+w;}return rows;};
  for(const cap of captions){cap.lines=wrap(cap.text,830,51);if(cap.lines.length>3)throw Error('Caption exceeds 3-line safe band: '+cap.text);}
  function draw(frame){const t=frame/fps;box(0,0,1080,1920,P.bg,0);const grad=c.createLinearGradient(0,0,1080,1400);grad.addColorStop(0,'rgba(38,81,122,.14)');grad.addColorStop(1,'rgba(8,19,35,0)');box(0,0,1080,1500,grad,0);
    text('TMEP / BUILDING IN PUBLIC',80,112,25,P.muted,600);line(80,151,930,151);
    let i=scenes.findLastIndex(s=>t>=s.start);i=Math.max(0,i);const s=scenes[i],local=t-s.start,p=Math.min(1,local/(s.end-s.start));const cap=captions.find(cap=>t>=cap.start&&t<cap.end)??(t>=clock?captions.at(-1):null);const page=captions.filter(cap=>cap.scene===i).findIndex(cap=>t<cap.end);
    const enter=i===0?1:ease(local/.45);c.save();c.globalAlpha=enter*(i===scenes.length-1?1:ease((s.end-t)/.25));c.translate(0,18*(1-enter));text(`${String(i+1).padStart(2,'0')} / ${s.label}`,80,216,25,P.blue,600);
    const size=s.title.some(x=>x.length>20)?67:83;text(s.title[0],78,330,size,P.ink,600);text(s.title[1],78,430,size,P.ink,600);
    content(s,local,p,Math.max(0,page));c.restore();
    if(cap){box(60,1454,890,272,'#07101d',20);const total=cap.lines.length*66,base=1590-total/2+44;for(let j=0;j<cap.lines.length;j++)center(cap.lines[j],505,base+j*66,51,P.ink,600);}
    text('SCRIPT-LED FILM / NO VOICEOVER',80,1785,22,P.muted,500);text('OPEN SOURCE',760,1785,22,P.muted,500);box(80,1824,850,3,P.line,0);box(80,1824,850*Math.min(1,t/(duration-1/fps)),3,P.blue,0);
    return canvas;
  }
  return {canvas,draw,scenes,captions,fps,frames,duration};
}


import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planExplainer,phraseGroups,ease} from '../src/explainer-plan.ts';
import {makeTranscript,parseTranscriptJson} from '../../speech/src/transcript.ts';

test('strict timing rejects approximate imports, NaN, reverse intervals and same-start words',()=>{
  assert.equal(parseTranscriptJson(JSON.stringify({approx:true,words:[]})).approx,true);
  assert.throws(()=>planExplainer(20,JSON.stringify({approx:true,words:[]})),/Approximate/);
  for(const words of [[{w:'a',s:NaN,e:1}],[{w:'a',s:1,e:0}],[{w:'a',s:0,e:1},{w:'b',s:0,e:2}]])assert.throws(()=>makeTranscript('test','en',words));
});
test('preview uses exact frames and no fabricated speech; easing is monotonic with stopped endpoints',()=>{
  const p=planExplainer(20);assert.equal(p.frames,1200);assert.equal(p.words.length,0);assert.ok(p.preview);
  for(let i=0;i<100;i++)assert.ok(ease(i/100)<=ease((i+1)/100));
  assert.equal(ease(-1),0);assert.equal(ease(2),1);assert.ok(ease(.001)<1e-7);
});
test('audio plan preserves final speech and requires valid scene anchors',()=>{
  const words=[{w:'Hello',s:0,e:.5},{w:'world.',s:19,e:19.93}];
  const p=planExplainer(19.94,JSON.stringify({words}),[0,3,7,12,17]);
  assert.ok(p.duration>=19.94);assert.equal(p.words.at(-1)!.e,19.93);assert.equal(p.pauses.length,1);
  assert.throws(()=>planExplainer(18,JSON.stringify({words}),[0,3,7,12,17]),/beyond/);
  assert.throws(()=>planExplainer(20,undefined,[0,3,2,12,17]),/ordered/);
  assert.throws(()=>planExplainer(20,JSON.stringify({words})),/storyboard cues/);
});
test('caption phrases use widths, do not overlap, and preserve all words',()=>{
  const words='Imagine a beautiful mountain lake at sunrise. Then make it new.'.split(' ').map((w,i)=>({w,s:i*.3,e:i*.3+.2}));
  const g=phraseGroups(words,s=>s.length*10,180);
  assert.deepEqual(g.flatMap(g=>g.words),words);
  g.forEach((x,i)=>{assert.ok(x.lines.length<=2);x.lines.forEach(l=>assert.ok(l.map(w=>w.w).join(' ').length*10<=180));if(i)assert.ok(g[i-1]!.e<=x.s);});
});

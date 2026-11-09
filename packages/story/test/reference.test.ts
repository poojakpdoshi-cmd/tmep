import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceRanges } from '../src/reference.ts';
import { planTimeline } from '../src/planner.ts';
import { timelineWords, duration } from '../../core/src/index.ts';

const words = Array.from({length: 8}, (_,i)=>({w:`Sentence${i}.`, s:i+0.1, e:i+0.7}));
test('reference pacing changes cuts while preserving every word and timestamp', ()=>{
  const make=(shot:number)=>planTimeline({template:'reel',referenceShotSec:shot,target:2,sources:[{id:'v1',dur:8,kind:'video',words}],graphics:false,sfx:false,zooms:false});
  const fast=make(1), slow=make(4);
  assert.ok(fast.tl.clips.length>slow.tl.clips.length);
  for(const {tl,summary} of [fast,slow]){
    assert.equal(duration(tl),8);
    assert.equal(summary.kept,8);
    assert.equal(summary.trans,0);
    const mapped=timelineWords(tl,{v1:words});
    assert.equal(mapped.length,words.length);
    mapped.forEach((w,i)=>{assert.equal(w.w,words[i]!.w);assert.ok(Math.abs(w.s-words[i]!.s)<1e-9);assert.ok(Math.abs(w.e-words[i]!.e)<1e-9);});
    tl.clips.slice(1).forEach(c=>assert.ok(!words.some(w=>w.s<c.in&&w.e>c.in)));
  }
  assert.deepEqual(make(1),fast,'deterministic');
});
test('continuous speech stays intact; pause boundaries work without punctuation',()=>{
  const continuous=words.map(w=>({...w,w:'word',e:w.s+0.9}));
  assert.deepEqual(referenceRanges(continuous,8.1,1,30),[[0,8.1]]);
  const pauses=words.map(w=>({...w,w:'word',e:w.s+0.3}));
  assert.ok(referenceRanges(pauses,8,1,30).length>1);
});
test('frame rounding cannot split a word at a narrow sentence gap',()=>{
  const narrow=[{w:'End.',s:0,e:1.005},{w:'Next.',s:1.006,e:2}];
  assert.deepEqual(referenceRanges(narrow,2,1,30),[[0,2]]);
});
test('invalid or unavailable timestamps and pacing fail closed',()=>{
  for(const bad of [[],[{w:'bad',s:1,e:0}],[{w:'a',s:0,e:2},{w:'b',s:1,e:3}],[{w:'a',s:0,e:9}]]) assert.throws(()=>referenceRanges(bad,8,1,30));
  for(const shot of [NaN,Infinity,0,-1]) assert.throws(()=>referenceRanges(words,8,shot,30));
});

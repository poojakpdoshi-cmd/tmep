import { makeTranscript, parseTranscriptJson } from '../../speech/src/transcript.ts';
import { sentences } from '../../speech/src/analyze.ts';
import type { Word } from '../../core/src/index.ts';

export const FPS = 60;
export const CONCEPTS = ['instruction', 'prompt', 'patterns', 'image', 'summary'];
export interface ExplainerPlan { fps: number; frames: number; duration: number; preview: boolean; words: Word[]; starts: number[]; pauses: {s:number;e:number}[]; sentences: ReturnType<typeof sentences>; }
export const ease = (p: number) => { const x = Math.max(0, Math.min(1,p)); return x*x*x*(x*(x*6-15)+10); };

export function planExplainer(duration = 20, json?: string, anchors?: number[]): ExplainerPlan {
  if (!Number.isFinite(duration) || duration < 5 || duration > 300) throw Error('Explainer duration must be 5–300 seconds.');
  let words: Word[] = [];
  if (json) {
    const parsed = parseTranscriptJson(json);
    if (parsed.approx) throw Error('Approximate word timing is not accepted. Supply measured word timestamps or run a speech recognizer.');
    words = makeTranscript('import', parsed.lang ?? 'und', parsed.words).words;
    if (!words.length || words.at(-1)!.e > duration + 0.05) throw Error('Transcript is empty or extends beyond the narration.');
  }
  // This is a focused text-to-image storyboard. Explicit anchors are source seconds.
  // Automatic boundaries follow actual spoken cue words; fail rather than silently invent timing.
  let starts = anchors;
  if (!starts && words.length) {
    const patterns = [/instruction|typing/i, /generative|patterns|training/i, /create.*|new/i, /from/i];
    let after = 0;
    starts = [0];
    for (const re of patterns) {
      const index = words.findIndex((w,i) => i > after && re.test(w.w));
      if (index < 0) throw Error('Cannot locate storyboard cues. Set five ordered sceneStarts in config using real speech times.');
      starts.push(words[index]!.s); after = index;
    }
  }
  starts ??= [0, 3.3, 7.3, 12.4, 16.7].map(t => t*duration/20);
  if (starts.length !== 5 || starts[0] !== 0 || starts.some((s,i)=> !Number.isFinite(s) || s<0 || s>=duration || (i>0 && s-starts![i-1]!<0.6)))
    throw Error('sceneStarts must contain five ordered times, start at 0, and leave each scene at least 0.6 seconds.');
  if (duration-starts[4]! < 0.6) throw Error('Closing scene needs at least 0.6 seconds.');
  const frames = Math.ceil(duration*FPS);
  return {fps:FPS, frames, duration:frames/FPS, preview:!json, words, starts, sentences:sentences(words), pauses:words.slice(1).flatMap((w,i)=>w.s-words[i]!.e>=0.35?[{s:words[i]!.e,e:w.s}]:[])};
}

export function phraseGroups(words: Word[], measure: (s:string)=>number, width=820) {
  const groups: {s:number;e:number;words:Word[];lines:Word[][]}[]=[];
  let current: Word[]=[];
  const lineCount=(ws:Word[])=>{let count=1,line='';for(const w of ws){if(line&&measure(line+' '+w.w)>width){count++;line=w.w;}else line+=(line?' ':'')+w.w;}return count;};
  const flush=()=>{if(!current.length)return; const lines:Word[][]=[[]]; for(const w of current){const l=lines.at(-1)!; if(l.length && measure([...l,w].map(w=>w.w).join(' '))>width) lines.push([w]);else l.push(w);} groups.push({s:current[0]!.s,e:current.at(-1)!.e,words:current,lines});current=[];};
  for(const w of words){
    if(measure(w.w)>width) throw Error('Caption word exceeds safe width; reduce caption fontSize.');
    if(current.length && (current.length>=7 || w.s-current.at(-1)!.e>0.35 || lineCount([...current,w])>2 || measure([...current,w].map(w=>w.w).join(' '))>width*1.65))flush();
    current.push(w); if(/[.!?,;:]$/.test(w.w))flush();
  }flush();
  groups.forEach((g,i)=>g.e=Math.min(groups[i+1]?.s??Infinity,g.e+0.18));
  return groups;
}

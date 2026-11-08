/**
 * Zero-setup demo: synthesizes a short "talking head" clip with known speech (no
 * footage or speech model needed), then runs the full TMEP flow and renders a reel.
 *
 *   node examples/demo/demo.ts [output_dir]
 */
import path from 'node:path';
import { makeFixture } from '../../tests/fixtures.ts';
import * as api from '../../packages/engine/src/api.ts';

const out = path.resolve(process.argv[2] ?? 'tmep-demo');
const step = (s: string, o: unknown) => console.log(`${s.padEnd(11)} ${JSON.stringify(o)}`);

const fx = await makeFixture(path.join(out, 'media'));
const ctx: api.Ctx = { project: out, detail: 'standard' };
step('import', await api.importMedia(ctx, { paths: [fx.video] }));
step('transcribe', await api.transcribe(ctx, { asset: 'v1', file: fx.truth }));
step('plan', await api.plan(ctx, { template: 'reel', target: 20, title: 'AI video in 20s' }));
step('preview', await api.render(ctx, { preview: true, frames: 6, wait: 600 }));
step('edit', await api.edit(ctx, { ops: ['captions boxed', 'zoom @faster to=1.2'] }));
step('final', await api.render(ctx, { frames: 4, wait: 600 }));
console.log(`\nOpen ${path.join(out, 'renders')} to watch the result.`);

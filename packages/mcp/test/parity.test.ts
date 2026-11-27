import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { McpServer } from '../src/server.ts';
import { toolList } from '../src/tools.ts';
import { estimateTokens } from '../../../bench/tokens.ts';

test('mcp parity: video_doctor, compact storyboard/scene help, and script/storyboard planning', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-mcp-parity-'));
  const srv = new McpServer({ cwd: dir });
  try {
    assert.ok(toolList().length <= 10);

    // 1. video_doctor
    const doc = (await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'video_doctor', arguments: {} } })) as any;
    assert.equal(doc.result.isError, undefined);
    const docJson = JSON.parse(doc.result.content[0].text);
    assert.ok(docJson.ffmpeg && docJson.node);

    // 2. Compact help by default, full schema on demand
    const sbCompact = (await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'video_help', arguments: { topic: 'storyboard' } } })) as any;
    const sbText = sbCompact.result.content[0].text;
    assert.ok(estimateTokens(sbText) < 400, `expected compact storyboard help < 400 tokens, got ${estimateTokens(sbText)}`);

    const sbFull = (await srv.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'video_help', arguments: { topic: 'storyboard', schema: true } } })) as any;
    assert.ok(JSON.parse(sbFull.result.content[0].text).schema);

    // 3. video_plan with script
    const scriptPlan = (await srv.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'video_plan',
        arguments: { script: 'First, import your footage. Second, edit the timeline. Finally, export clean video.' },
      },
    })) as any;
    assert.equal(scriptPlan.result.isError, undefined);
    const planRes = JSON.parse(scriptPlan.result.content[0].text);
    assert.equal(planRes.ok, 1);
    assert.ok(planRes.rev >= 1);

    // 4. notifications/cancelled does not throw and returns undefined
    const cancelRes = await srv.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
    assert.equal(cancelRes, undefined);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

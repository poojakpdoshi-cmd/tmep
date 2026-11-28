/** Phase 6: the production pipeline is reachable through MCP (video_plan mode=produce) and validates input. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { McpServer } from '../src/server.ts';

test('mcp: video_plan mode=produce validates and reports structured errors', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-mcp-produce-'));
  const srv = new McpServer({ cwd: dir });
  try {
    const call = (args: Record<string, unknown>) => srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'video_plan', arguments: args } }) as Promise<any>;
    const bad = await call({ mode: 'produce', action: 'start', asset: 'v1', genre: 'vlog' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /E_INPUT|E_STATE|E_NOT_FOUND/);
    const missing = await call({ mode: 'produce', action: 'status', id: 'nope' });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /E_NOT_FOUND|E_STATE/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

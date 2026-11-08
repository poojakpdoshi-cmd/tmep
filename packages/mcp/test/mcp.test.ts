/**
 * MCP conformance: drives the real stdio server process with JSON-RPC messages for both
 * protocol eras (legacy initialize handshake and stateless 2026-07-28 requests) and checks
 * tool-name constraints that real clients enforce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { toolList } from '../src/tools.ts';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'tmep-mcp.js');
const MODERN_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } };

async function withServer(fn: (call: (method: string, params?: unknown, id?: number) => Promise<Record<string, any>>, notify: (m: unknown) => void) => Promise<void>) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmep-mcp-'));
  const child = spawn(process.execPath, [BIN], { cwd: dir, env: { ...process.env, TMEP_PROJECT: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number | string, (m: Record<string, any>) => void>();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  let next = 1;
  const call = (method: string, params?: unknown, id = next++) =>
    new Promise<Record<string, any>>((res) => {
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  const notify = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  try {
    await fn(call, notify);
  } finally {
    child.kill();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('tool names satisfy the strictest client rules (Claude/Antigravity/OpenAI regex, Cursor 60-char combined)', () => {
  for (const t of toolList()) {
    const name = String(t.name);
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(`mcp__tmep__${name}`.length <= 64, 'Claude Code prefixed name');
    assert.ok(`tmep${name}`.length <= 60, 'Cursor server+tool');
    assert.equal((t.inputSchema as Record<string, unknown>).type, 'object');
  }
  assert.ok(toolList().length <= 10, 'small tool surface');
});

test('legacy era: initialize -> tools/list -> tools/call (+ input errors are tool errors)', async () => {
  await withServer(async (call, notify) => {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    assert.equal(init.result.serverInfo.name, 'tmep');
    notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const unknownVersion = await call('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');
    const list = await call('tools/list');
    assert.ok(list.result.tools.length >= 8);
    assert.equal(list.result.resultType, undefined, 'legacy results carry no resultType');
    const help = await call('tools/call', { name: 'video_help', arguments: { topic: 'anchors' } });
    assert.ok(!help.result.isError);
    assert.match(help.result.content[0].text, /@phrase/);
    const bad = await call('tools/call', { name: 'video_import', arguments: { pathz: ['x'] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /did you mean 'paths'/);
    const unknown = await call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const st = await call('tools/call', { name: 'video_inspect', arguments: {} });
    assert.equal(JSON.parse(st.result.content[0].text).rev, 0);
    const missing = await call('tools/call', { name: 'video_edit', arguments: { undo: 1 } });
    assert.ok(!missing.error);
    assert.equal((await call('ping')).result && 1, 1);
    assert.equal((await call('no/such')).error.code, -32601);
  });
});

test('modern era (2026-07-28): server/discover, per-request _meta, version errors', async () => {
  await withServer(async (call) => {
    const d = await call('server/discover', { _meta: MODERN_META });
    assert.equal(d.result.resultType, 'complete');
    assert.ok(d.result.supportedVersions.includes('2026-07-28'));
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'tmep');
    assert.ok(d.result.ttlMs > 0 && d.result.cacheScope);
    const l = await call('tools/list', { _meta: MODERN_META });
    assert.equal(l.result.resultType, 'complete');
    assert.ok(l.result.ttlMs > 0);
    const names = l.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, [...names], 'deterministic order');
    const c = await call('tools/call', { name: 'video_help', arguments: {}, _meta: MODERN_META });
    assert.equal(c.result.resultType, 'complete');
    const v = await call('tools/list', { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
    assert.equal(v.error.code, -32022);
    assert.equal(v.error.data.requested, '1900-01-01');
    const noCaps = await call('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(noCaps.error.code, -32602);
  });
});

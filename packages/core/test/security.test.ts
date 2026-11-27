import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Project } from '../src/project.ts';
import { assertSafeId, isUncOrDevicePath, resolveContainedPath } from '../src/security.ts';
import { McpServer } from '../../mcp/src/server.ts';
import * as api from '../../engine/src/api.ts';

test('security: assertSafeId rejects traversal, separators, and reserved names', () => {
  assert.equal(assertSafeId('j1234abcd', 'job id'), 'j1234abcd');
  for (const bad of ['', '../tmep', '..\\tmep', 'a/b', 'a\\b', 'CON', 'nul.json', 'a\0b']) {
    assert.throws(() => assertSafeId(bad, 'job id'), /invalid job id/i);
  }
});

test('security: UNC and Windows device paths are detected and rejected', async () => {
  assert.equal(isUncOrDevicePath('\\\\server\\share\\file.mp4'), true);
  assert.equal(isUncOrDevicePath('\\\\?\\C:\\file.mp4'), true);
  assert.equal(isUncOrDevicePath('//server/share/file.mp4'), true);
  assert.equal(isUncOrDevicePath('C:\\Users\\test\\file.mp4'), false);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-sec-unc-'));
  try {
    await assert.rejects(() => resolveContainedPath('\\\\server\\share\\evil.mp4', [dir], 'out'), /UNC or device/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('security: resolveContainedPath blocks traversal and symlink escapes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-sec-root-'));
  const workspace = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');

  try {
    await assert.rejects(() => resolveContainedPath('../outside/secret.txt', [workspace], 'import'), /escapes allowed workspace/i);
    // Symlink / junction escape test
    const linkPath = path.join(workspace, 'escape-link');
    try {
      await fsp.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => resolveContainedPath('escape-link/secret.txt', [workspace], 'import'), /escapes allowed workspace/i);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EPERM') throw e;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('security: MCP blocks out-of-workspace project, render out overwrite, import, and read-only inspect mutation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-sec-mcp-'));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  const authorizedMedia = path.join(root, 'media-bank');
  await fsp.mkdir(ws, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.mkdir(authorizedMedia, { recursive: true });
  await fsp.writeFile(path.join(outside, 'victim.mp4'), 'do-not-overwrite');
  await fsp.writeFile(path.join(outside, 'subs.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');

  const srv = new McpServer({ cwd: ws, mediaRoots: [authorizedMedia] });
  try {
    // 1. Read-only inspect on non-existent project must not create files
    const missingProj = path.join(ws, 'uninitialized');
    const inspectRes = (await srv.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'video_inspect', arguments: { project: 'uninitialized' } },
    })) as any;
    assert.equal(inspectRes.result.isError, undefined);
    assert.equal(JSON.parse(inspectRes.result.content[0].text).rev, 0);
    await assert.rejects(() => fsp.stat(missingProj));

    // 2. Project path traversal rejected without creating directory
    const evilProjRes = (await srv.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'video_edit', arguments: { project: '../outside/pwn', ops: [] } },
    })) as any;
    assert.equal(evilProjRes.result.isError, true);
    assert.match(evilProjRes.result.content[0].text, /E_SECURITY/);
    await assert.rejects(() => fsp.stat(path.join(outside, 'pwn')));

    // 3. Import outside workspace & authorized mediaRoots rejected
    const evilImport = (await srv.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'video_import', arguments: { paths: ['../outside/victim.mp4'] } },
    })) as any;
    assert.equal(evilImport.result.isError, true);
    assert.match(evilImport.result.content[0].text, /E_SECURITY/);

    // 4. Render out outside project rejected and victim.mp4 untouched
    const p = await Project.open(ws, { create: true });
    assert.ok(p);
    const evilRender = (await srv.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'video_render', arguments: { out: '../outside/victim.mp4' } },
    })) as any;
    assert.equal(evilRender.result.isError, true);
    assert.equal(await fsp.readFile(path.join(outside, 'victim.mp4'), 'utf8'), 'do-not-overwrite');

    // 5. Job ID traversal rejected
    const evilStatus = (await srv.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'video_status', arguments: { job: '../tmep' } },
    })) as any;
    assert.equal(evilStatus.result.isError, true);
    assert.match(evilStatus.result.content[0].text, /E_SECURITY/);

    // 6. Authorized external media root is permitted to reach probe/read stage
    const extPath = path.join(authorizedMedia, 'not-a-video.txt');
    await fsp.writeFile(extPath, 'plain text');
    const authImport = (await srv.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'video_import', arguments: { paths: [extPath] } },
    })) as any;
    assert.equal(authImport.result.isError, true);
    assert.doesNotMatch(authImport.result.content[0].text, /E_SECURITY/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('security: Project.revision and checkout reject non-integer revisions', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-sec-rev-'));
  try {
    const p = await Project.open(dir, { create: true });
    for (const bad of [1.5, NaN, -1, Infinity, '1' as unknown as number]) {
      await assert.rejects(() => p.revision(bad), /invalid revision/i);
      await assert.rejects(() => p.checkout(bad), /invalid revision/i);
    }
    await assert.rejects(() => api.status({ project: dir, detail: 'minimal' }, { job: '../tmep' }), /invalid job id/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeCandidates } from '../src/chrome.ts';

test('FRAME_* environment variables take precedence and TMEP_* still work', () => {
  const save = { f: process.env.FRAME_CHROME, t: process.env.TMEP_CHROME };
  try {
    delete process.env.FRAME_CHROME;
    process.env.TMEP_CHROME = '/legacy/chrome';
    assert.equal(chromeCandidates()[0], '/legacy/chrome');
    process.env.FRAME_CHROME = '/frame/chrome';
    assert.equal(chromeCandidates()[0], '/frame/chrome');
  } finally {
    if (save.f === undefined) delete process.env.FRAME_CHROME; else process.env.FRAME_CHROME = save.f;
    if (save.t === undefined) delete process.env.TMEP_CHROME; else process.env.TMEP_CHROME = save.t;
  }
});

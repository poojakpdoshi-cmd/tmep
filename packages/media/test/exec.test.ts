/**
 * Command-line length accounting (Stabilization A5). Windows starts no process whose command
 * line exceeds 32,767 characters; `commandLineLength` reproduces how libuv builds that line so
 * the limit can be checked, and enforced in tests, on every OS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLineLength, run, WINDOWS_CMDLINE_MAX } from '../src/exec.ts';
import { TmepError } from '../../core/src/index.ts';

test('commandLineLength quotes and escapes like libuv on Windows', () => {
  // ffmpeg -i clip.mp4            -> ffmpeg -i clip.mp4\0
  assert.equal(commandLineLength('ffmpeg', ['-i', 'clip.mp4']), 'ffmpeg -i clip.mp4'.length + 1);
  // an empty argument is ""
  assert.equal(commandLineLength('x', ['']), 'x ""'.length + 1);
  // spaces: wrapped in quotes
  assert.equal(commandLineLength('x', ['a b']), 'x "a b"'.length + 1);
  // backslashes without quotes or spaces stay as they are (Windows paths)
  assert.equal(commandLineLength('x', ['C:\\Users\\me\\clip.mp4']), 'x C:\\Users\\me\\clip.mp4'.length + 1);
  // a quote is escaped, backslashes before it are doubled:  a\"b  ->  "a\\\"b"
  assert.equal(commandLineLength('x', ['a\\"b']), 'x "a\\\\\\"b"'.length + 1);
  // trailing backslashes of a quoted argument are doubled:  a b\  ->  "a b\\"
  assert.equal(commandLineLength('x', ['a b\\']), 'x "a b\\\\"'.length + 1);
});

test('the length grows by the whole argument: 400 inputs of a typical Windows path exceed the limit', () => {
  const file = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\tmep-reliability-fixture\\clip.mp4';
  const inputs = (n: number) => Array.from({ length: n }, () => ['-ss', '0.5', '-t', '0.7', '-i', file]).flat();
  assert.ok(commandLineLength('ffmpeg', inputs(200)) < WINDOWS_CMDLINE_MAX);
  assert.ok(commandLineLength('ffmpeg', inputs(400)) > WINDOWS_CMDLINE_MAX);
});

test('TMEP_CMDLINE_LIMIT makes an over-long command fail before it is started, on every OS', async () => {
  const before = process.env.TMEP_CMDLINE_LIMIT;
  process.env.TMEP_CMDLINE_LIMIT = '200';
  try {
    const ok = await run(process.execPath, ['-e', 'process.stdout.write("ran")']);
    assert.equal(ok.stdout, 'ran');
    await assert.rejects(
      run(process.execPath, ['-e', 'process.stdout.write("ran")', 'x'.repeat(300)]),
      (e: unknown) => e instanceof TmepError && e.code === 'E_INTERNAL' && /command line too long: \d+ characters/.test(e.message),
    );
  } finally {
    if (before === undefined) delete process.env.TMEP_CMDLINE_LIMIT;
    else process.env.TMEP_CMDLINE_LIMIT = before;
  }
});

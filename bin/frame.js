#!/usr/bin/env node
// FRAME CLI entrypoint (also available as `tmep`).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  process.stderr.write(`frame needs Node.js >= 22.18 (found ${process.version}).\n`);
  process.exit(1);
}
const { main } = await import('../packages/cli/src/main.ts');
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;

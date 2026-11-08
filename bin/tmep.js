#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 22.18 strips types natively; no build step).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  process.stderr.write(`tmep needs Node.js >= 22.18 (found ${process.version}).\n`);
  process.exit(1);
}
const { main } = await import('../packages/cli/src/main.ts');
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;

#!/usr/bin/env node
// FRAME MCP stdio server entrypoint (also available as `tmep-mcp`).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  process.stderr.write(`frame-mcp needs Node.js >= 22.18 (found ${process.version}).\n`);
  process.exit(1);
}
const { serveStdio } = await import('../packages/mcp/src/server.ts');
serveStdio();

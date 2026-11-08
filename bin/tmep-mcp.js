#!/usr/bin/env node
// MCP stdio server entry point: `node bin/tmep-mcp.js` (project dir = TMEP_PROJECT or cwd).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  process.stderr.write(`tmep-mcp needs Node.js >= 22.18 (found ${process.version}).\n`);
  process.exit(1);
}
const { serveStdio } = await import('../packages/mcp/src/server.ts');
serveStdio();

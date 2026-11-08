# Agent integrations

TMEP runs as an **MCP stdio server** (`bin/tmep-mcp.js`) or as a **CLI** (`bin/tmep.js`).
Use absolute paths below. On Windows, JSON paths need `\\` or forward slashes.

Environment variables (all optional):

| Var | Purpose |
|---|---|
| `TMEP_PROJECT` | default project directory (else the server's working directory) |
| `TMEP_DETAIL` | default response detail: `minimal` / `standard` (default) / `debug` |
| `TMEP_FFMPEG`, `TMEP_FFPROBE` | explicit FFmpeg binaries |
| `TMEP_WHISPER_CPP`, `TMEP_WHISPER_MODEL`, `TMEP_MODELS_DIR` | whisper.cpp binary / model |
| `TMEP_PYTHON` | Python for faster-whisper |
| `TMEP_FONTS_DIR` | extra font folders (path-list) |

> **Verification status:** the server is tested against the MCP protocol (both eras) by
> `packages/mcp/test/mcp.test.ts`, which drives the real process over stdio. The client
> configurations below follow each vendor's documentation as of 2026-11 but were not run
> against the live clients in this repository's CI. Please report anything that differs.

## Claude Code

```bash
claude mcp add --transport stdio tmep --env TMEP_PROJECT=/abs/path/my-reel -- node /abs/path/tmep/bin/tmep-mcp.js
# team-shared: add --scope project (writes .mcp.json)
```

`.mcp.json` equivalent:

```json
{ "mcpServers": { "tmep": { "type": "stdio", "command": "node", "args": ["/abs/path/tmep/bin/tmep-mcp.js"], "env": { "TMEP_PROJECT": "/abs/path/my-reel" } } } }
```

Claude Code can also skip MCP entirely and call the CLI through its shell tool
(`node /abs/path/tmep/bin/tmep.js -p my-reel plan --template reel`).

## Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "tmep": {
      "command": "node",
      "args": ["C:/Users/you/tmep/bin/tmep-mcp.js"],
      "env": { "TMEP_PROJECT": "C:/Users/you/Videos/my-reel" }
    }
  }
}
```

Restart Claude Desktop after editing.

## OpenAI Codex (CLI and IDE extension)

`~/.codex/config.toml` (note `mcp_servers`, snake_case):

```toml
[mcp_servers.tmep]
command = "node"
args = ["/abs/path/tmep/bin/tmep-mcp.js"]
env = { TMEP_PROJECT = "/abs/path/my-reel" }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

or `codex mcp add tmep -- node /abs/path/tmep/bin/tmep-mcp.js`.

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{ "mcpServers": { "tmep": { "command": "node", "args": ["/abs/path/tmep/bin/tmep-mcp.js"], "env": { "TMEP_PROJECT": "/abs/path/my-reel" } } } }
```

Keep the server key short: Cursor rejects tools whose *server key + tool name* exceeds 60
characters. With `tmep`, the longest is 20.

## Google Antigravity

Agent panel → `…` → **MCP Servers** → **Manage MCP Servers** → **View raw config**, or edit
`~/.gemini/config/mcp_config.json` (global) / `<workspace>/.agents/mcp_config.json` (workspace).
Older IDE builds used `~/.gemini/antigravity/mcp_config.json`.

```json
{
  "mcpServers": {
    "tmep": {
      "command": "node",
      "args": ["C:/Users/you/tmep/bin/tmep-mcp.js"],
      "env": { "TMEP_PROJECT": "C:/Users/you/Videos/my-reel" }
    }
  }
}
```

Antigravity's default per-tool-call timeout is 3 minutes; TMEP tools return within `wait`
seconds (default 50) and hand back a job id for long renders.

## Other MCP clients

Any client that speaks MCP over stdio works: command `node`, args `[".../bin/tmep-mcp.js"]`.
The server answers the legacy `initialize` handshake (2024-11-05, 2025-03-26, 2025-06-18,
2025-11-25) and modern stateless requests (2026-07-28, `server/discover`).

## Suggested agent instructions

Add to `CLAUDE.md` / `AGENTS.md` / rules:

```
For video work use the tmep tools. Import media, transcribe once, then video_plan with a
template. Refer to media by asset id and to moments by "@phrase" anchors. Never paste
transcripts or write ffmpeg/animation code; express changes as video_edit ops. Render a
preview before the final export.
```

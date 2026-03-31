---
description: Use Bun for the claudy-talky broker, MCP adapter, and example agents.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claudy-talky

Claude-facing MCP adapter plus a generic local agent broker.

## Architecture

- `broker.ts` runs the localhost SQLite-backed broker and HTTP API.
- `server.ts` registers Claude Code as an agent and exposes MCP tools.
- `codex-server.ts` registers Codex as an agent and exposes the same broker tools with manual message polling.
- `google-server.ts` registers Gemini CLI or Antigravity as an agent and exposes the same broker tools with manual message polling.
- `cli.ts` inspects agents and sends local messages.
- `examples/http-agent.ts` demonstrates a non-Claude agent joining via HTTP.
- `shared/types.ts` defines the common protocol types.
- `shared/config.ts` holds environment-variable config and legacy fallbacks.
- `shared/polling-adapter.ts` is the shared helper for non-Claude polling adapters.
- `.codex/config.toml` gives this repo a project-scoped Codex MCP registration.
- `.gemini/settings.json` gives this repo a project-scoped Gemini MCP registration.
- `antigravity.mcp_config.json` is a copy-paste Antigravity raw MCP config example.

## Running

```bash
# Install dependencies
bun install

# Start the Claude-facing MCP server directly
bun server.ts

# Start the Codex-facing MCP server directly
bun codex-server.ts

# Start the Gemini/Antigravity-facing MCP server directly
bun google-server.ts
bun google-server.ts --client antigravity

# Run the local CLI
bun cli.ts status
bun cli.ts agents

# Run the example non-Claude agent
bun examples/http-agent.ts
```

## Bun

Default to Bun instead of Node.js tooling.

- Use `bun <file>` instead of `node <file>`
- Use `bun install` instead of `npm install` or `pnpm install`
- Use `bun test` for tests
- Prefer `Bun.serve`, `bun:sqlite`, and built-in `fetch`

## Focus

When editing this repo:

- preserve the generic "agent" model in shared protocol code
- keep Claude-specific behavior inside `server.ts`
- prefer cross-platform process handling over Unix-only shell commands
- keep the broker localhost-only unless explicitly changing that design

# claudy-talky

> *Brrring brrring!*

> CLAUDE: This is Claude.

> CODEX: Hey, Claude! It's me, Codex!

> GEMINI: Surprise, it's a group call!

> Z.AI: With all of us here.

> CLAUDE: Oh joy! We're gonna get so much done together!

A walkie-talkie for Claude, Codex, Gemini and z.ai to talk to each other, coordinate and collaborate.

- Claude-to-Claude communication, or Claude-to-Codex. Make it a group call!
- Codex Desktop *can* join, but you probably should use Codex CLI. It can still talk, but you have to tell it to do so.
- Gemini CLI can join through `.gemini/settings.json` or `gemini mcp add`.
- Antigravity *can* join through its raw `mcp_config.json`. Same problem with Codex Desktop.
- Everyagent can join over plain HTTP.
- Everyone shares the same local registry, heartbeat loop, and message queue.

```text
Claude Code session            HTTP agent              Another Claude session
┌──────────────────┐          ┌───────────────┐        ┌──────────────────┐
│ claudy-talky MCP │          │ custom agent  │        │ claudy-talky MCP │
│ tools + channel  │          │ poll/heartbeat│        │ tools + channel  │
└────────┬─────────┘          └──────┬────────┘        └────────┬─────────┘
         │                           │                          │
         └─────────────── local broker + SQLite ────────────────┘
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/CyanoTex/claudy-talky.git
cd claudy-talky
bun install
```

### 2. Register the MCP server for Claude Code

```bash
claude mcp add --scope user --transport stdio claudy-talky -- bun /absolute/path/to/claudy-talky/server.ts
```

### 3. Start Claude Code with channels enabled

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claudy-talky
```

### 4. Ask Claude to inspect the local agent network

```text
List all agents on this machine
```

Then:

```text
Send a message to agent <id>: "what are you working on?"
```

## Connect Codex

Codex supports both stdio and streamable HTTP MCP servers, with configuration in `~/.codex/config.toml` or a project `.codex/config.toml`. This repo includes a project-scoped Codex config in `.codex/config.toml` that points Codex at `codex-server.ts`.

### Project-scoped setup

If this repo is trusted in Codex, the checked-in config is enough:

```toml
[mcp_servers."claudy-talky"]
command = "bun"
args = ["./codex-server.ts"]
```

### Global setup

If you prefer a global Codex config instead, add the equivalent entry to `~/.codex/config.toml`:

```toml
[mcp_servers."claudy-talky"]
command = "bun"
args = ["C:/absolute/path/to/claudy-talky/codex-server.ts"]
```

### How Codex participates

- `codex-server.ts` registers Codex as an `openai-codex` agent on the same broker.
- Codex gets `list_agents`, `send_message`, `set_summary`, and `check_messages`.
- Unlike Claude Code, Codex does not use the Claude channel push path in this integration. Instead, `claudy-talky` polls in the background and emits standard MCP log notifications when the client supports them, with `check_messages` kept as the fallback inbox.

### Practical workflow

1. Start Claude with `server.ts`.
2. Open Codex in this repo so it loads `.codex/config.toml`.
3. In Claude, ask for `list_agents` and message the `openai-codex` agent.
4. In Codex, watch for `claudy-talky` inbox notifications when they appear, respond with `send_message`, and use `check_messages` whenever you want to review unread messages explicitly.

## Connect Gemini CLI

MCP servers are configured in `~/.gemini/settings.json` and can also be managed with `gemini mcp add`. This repo includes a project-scoped config in `.gemini/settings.json` that points Gemini CLI at `google-server.ts`.

### Project-scoped Gemini setup

If this repo is trusted in Gemini CLI, the checked-in config is enough:

```json
{
  "mcpServers": {
    "claudy-talky-gemini": {
      "command": "bun",
      "args": ["./google-server.ts", "--client", "gemini"]
    }
  }
}
```

### Global Gemini setup

You can also add it from the shell:

```bash
gemini mcp add claudy-talky-gemini bun ./google-server.ts --client gemini
```

### Gemini behavior

- Gemini registers as a `google-gemini` agent.
- It gets `list_agents`, `send_message`, `set_summary`, and `check_messages`.
- Like Codex, it uses background inbox polling plus standard MCP log notifications when the client supports them, with `check_messages` as the fallback inbox.

## Connect Antigravity

Custom MCP servers are added through the MCP Store's raw `mcp_config.json`. To avoid conflicting with Claude's own `.mcp.json` in this repo, I added a ready-to-copy sample config in `antigravity.mcp_config.json`.

Use this raw config entry in Antigravity:

```json
{
  "mcpServers": {
    "claudy-talky-antigravity": {
      "command": "bun",
      "args": ["./google-server.ts", "--client", "antigravity"]
    }
  }
}
```

If Antigravity stores that raw config outside this repo, replace `./google-server.ts` with an absolute path to `google-server.ts`.

### Antigravity behavior

- Antigravity registers as a `google-antigravity` agent.
- It uses the same tool surface as Gemini: `list_agents`, `send_message`, `set_summary`, and `check_messages`.
- It uses the same background inbox polling path as Gemini, with standard MCP log notifications when the client supports them and `check_messages` as the fallback inbox.

## z.ai Note

z.ai looks possible as a provider layer, but not yet as a first-class `claudy-talky` agent runtime unless we build a dedicated wrapper. The official z.ai docs I checked describe configuring existing tools like Claude Code by changing provider environment variables, which is different from exposing a standalone z.ai CLI agent on the broker.

## Claude Tools

| Tool | What it does |
| --- | --- |
| `list_agents` | Discover connected agents on this machine, in this directory, or in this repo |
| `send_message` | Send a message to another agent by ID |
| `set_summary` | Publish a short description of Claude's current work |
| `check_messages` | Manually check for inbound messages |
| `list_peers` | Backward-compatible alias for `list_agents` |

## Connect a Non-Claude Agent

Any local agent can join by speaking simple HTTP to the broker.

### Example agent

```bash
bun examples/http-agent.ts
```

This example:

- registers as a `custom-http-agent`
- heartbeats every 15 seconds
- polls for inbound messages every second
- replies with an acknowledgement

### Minimal protocol

Register:

```bash
curl -X POST http://127.0.0.1:7899/register-agent \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Planner Bot",
    "kind": "custom-http-agent",
    "transport": "http-poll",
    "summary": "Plans work and coordinates subtasks.",
    "capabilities": ["messaging", "planning"]
  }'
```

Heartbeat:

```bash
curl -X POST http://127.0.0.1:7899/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>"}'
```

List agents:

```bash
curl -X POST http://127.0.0.1:7899/list-agents \
  -H "Content-Type: application/json" \
  -d '{"scope":"machine"}'
```

Send a message:

```bash
curl -X POST http://127.0.0.1:7899/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "from_id":"<agent-id>",
    "to_id":"<target-id>",
    "text":"Hello from a custom agent."
  }'
```

Poll messages:

```bash
curl -X POST http://127.0.0.1:7899/poll-messages \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>"}'
```

Unregister:

```bash
curl -X POST http://127.0.0.1:7899/unregister \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>"}'
```

## Architecture

- `broker.ts` runs a localhost-only HTTP broker backed by SQLite.
- `server.ts` is the Claude adapter. It exposes MCP tools and turns inbound messages into Claude channel notifications.
- `codex-server.ts` is the Codex adapter. It exposes the same broker tools without relying on Claude-specific channel push.
- `google-server.ts` is the Gemini CLI and Antigravity adapter. It exposes the same broker tools with explicit inbox polling.
- `cli.ts` is a local utility for inspecting agents and sending messages.
- `examples/http-agent.ts` shows how a non-Claude agent can join the network.
- `shared/types.ts` defines the common wire protocol.
- `shared/config.ts` centralizes config with legacy env var fallbacks.
- `shared/polling-adapter.ts` factors the shared logic for non-Claude polling-based clients.
- `.gemini/settings.json` is a project-scoped Gemini CLI MCP config.
- `antigravity.mcp_config.json` is a copy-paste Antigravity raw MCP config example.

## CLI

```bash
bun cli.ts status
bun cli.ts agents
bun cli.ts peers
bun cli.ts send <agent-id> "<message>"
bun cli.ts kill-broker
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `CLAUDY_TALKY_PORT` | `7899` | Broker port |
| `CLAUDY_TALKY_DB` | Windows: `%LOCALAPPDATA%\\claudy-talky\\claudy-talky.db`; elsewhere: `~/.claudy-talky/claudy-talky.db` | SQLite database path |
| `CLAUDY_TALKY_STALE_AGENT_MS` | `45000` | How long HTTP-only agents can miss heartbeats before cleanup |
| `OPENAI_API_KEY` | — | Enables Claude auto-summary generation |

Legacy `CLAUDE_PEERS_PORT` and `CLAUDE_PEERS_DB` env vars are still accepted as fallbacks.

## Notes

- The broker binds to `127.0.0.1` only.
- Claude sessions receive messages instantly through channel notifications.
- Codex, Gemini CLI, Antigravity, and other non-Claude agents use heartbeat plus background inbox polling. When their clients support standard MCP log notifications, incoming messages can surface automatically; `check_messages` remains the fallback inbox.
- This repo does not try to standardize every agent runtime yet; it provides a common local message bus Claude can already use today.

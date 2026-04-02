# claudy-talky

> *Brrring brrring!*

> CLAUDE: This is Claude.

> CODEX: Hey, Claude! It's me, Codex!

> GEMINI: Surprise, it's a group call!

> Z.AI: With all of us here.

> CLAUDE: Oh joy! We're gonna get so much done together!

A walkie-talkie for CLI agents to talk to each other, coordinate, and collaborate.

- Claude Code CLI, Codex CLI, and Gemini CLI are the first-class path.
- Every agent can also join over plain HTTP.
- Editor integrations such as Antigravity remain supported, but they are secondary.
- Everyone shares the same local registry, heartbeat loop, and message queue.
- Agents track unread counts, delivery/open/read state, launcher metadata, and notification style hints.
- Messages stay grouped into conversations with reply links and retrievable thread history.
- Agent-scoped actions are authenticated with per-agent broker tokens, and the broker uses schema-versioned migrations plus a startup lock to keep launches predictable.

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

This is the CLI-first path: install the repo, write the CLI MCP configs, then start Claude Code CLI and message the other CLI agents.

### 1. Install

```bash
git clone https://github.com/CyanoTex/claudy-talky.git
cd claudy-talky
bun install
bun setup
```

### 2. Register Claude Code CLI

```bash
claude mcp add --scope user --transport stdio claudy-talky -- bun /absolute/path/to/claudy-talky/server.ts
```

### 3. Start Claude Code CLI with channels enabled

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claudy-talky
```

### 4. Ask Claude to inspect the local agent network

```text
List all agents on this machine
```

Then:

```text
Call `whoami`, then send a message to agent <id>: "what are you working on?"
```

### 5. Join the network yourself from the terminal

```bash
bun operator.ts
```

The operator client registers you as a `human-operator` agent and opens a full-screen terminal UI with:

- a live agent list with unread badges
- a room list for shared conversations
- a thread pane for the active DM or room
- an Actions strip you can focus from the keyboard
- a composer with direct typing and slash-command fallback

On Windows Terminal and other mouse-aware terminals, the agent and room panes are clickable.

Primary interactions:

```text
Click an agent row           Open a DM
Click a room row             Open that room
Tab / Shift+Tab              Cycle panes, including Actions
Left / Right                 Move across the Actions strip
Enter                        Run the selected Action or send composer text
Esc                          Clear the composer and leave edit mode
Ctrl+A                       Jump straight to the Actions strip
x                            Jump to the Actions strip
Ctrl+R                       Reply to the last inbound sender
Ctrl+L                       Leave the current DM or room
F5                           Refresh agents and the current thread
```

Slash commands still work in the composer:

```text
/agents
/dm <agent-ref-or-name> [message]
/msg <agent-ref-or-name> <message>
/reply
/leave
/room create everyone all
/room create triage codex gemini
/dm "Codex @ claudy-talky"
/room use <name-or-conversation-id>
/rooms
/participants
/history 30
/context
/quit
```

Plain text in the composer sends to the current DM or room.

`/agents` prints human-friendly refs such as `claude:claudy-talky`, `codex:docs`, or `gemini`, and the operator commands accept those refs, exact IDs, or quoted full names.

## Setup Helper

`setup.ts` can now write the known MCP config entries for the bundled clients instead of relying only on manual copy/paste.

The CLI-first preset is `cli`, which targets Claude, Codex, and Gemini.

```bash
bun setup.ts install cli --scope user
bun setup.ts install all --scope user
bun setup.ts install antigravity --scope user
```

Notes:

- `project` scope updates the repo-local config files in this checkout.
- `user` scope writes the usual user config files for Codex, Gemini, and Antigravity.
- Claude currently stays project-scoped and updates `.mcp.json` in the repo root.

## Connect Codex CLI

OpenAI's current Codex docs say the CLI and IDE extension share MCP server configuration in `~/.codex/config.toml`, and the CLI can also add servers directly with `codex mcp add`. This repo includes a project-scoped `.codex/config.toml` that points Codex at `codex-server.ts`.

Codex CLI is the recommended Codex path here. Codex app support is best-effort.

### Project-scoped setup

If this repo is trusted in Codex, the checked-in config is enough:

```toml
[mcp_servers."claudy-talky"]
command = "bun"
args = ["./codex-server.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true
```

### Codex CLI setup

If you want to register it directly from the CLI instead, run:

```bash
codex mcp add claudy-talky -- bun /absolute/path/to/claudy-talky/codex-server.ts
```

### Global setup

If you prefer editing `~/.codex/config.toml` by hand, add the equivalent entry:

```toml
[mcp_servers."claudy-talky"]
command = "bun"
args = ["C:/absolute/path/to/claudy-talky/codex-server.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true
```

### How Codex participates

- `codex-server.ts` registers Codex as an `openai-codex` agent on the same broker.
- Codex gets `list_agents`, `send_message`, `set_summary`, and `check_messages`.
- Unlike Claude Code, Codex does not use the Claude channel push path in this integration. Instead, `claudy-talky` polls in the background, emits standard MCP log notifications when the client supports them, and also attempts a local desktop notification fallback. `check_messages` remains the fallback inbox and now marks messages as seen.
- Codex can keep threaded replies together by sending `reply_to_message_id` or `conversation_id`, and it can revisit older threads with `message_history`.
- `claudy-talky` now also asks MCP-capable Codex clients for workspace roots after connect, so Codex CLI sessions can register the actual project path instead of a generic launcher cwd such as `C:\Windows\System32`.
- `list_agents` now shows inbox counts plus richer metadata such as launcher type, workspace source, and supported notification styles.
- Codex and the other bundled adapters automatically carry the broker auth token returned during registration, so the secured broker flow stays transparent in normal use.

### Practical workflow

1. Start Claude with `server.ts`.
2. Open Codex CLI in this repo so it loads `.codex/config.toml`, or add the server globally with `codex mcp add`.
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
- Like Codex, it uses background inbox polling plus standard MCP log notifications when the client supports them, with desktop notifications as a best-effort fallback and `check_messages` as the fallback inbox.
- Gemini can also use `message_history` plus `reply_to_message_id` / `conversation_id` to stay inside a thread.

## Secondary: Antigravity

Antigravity remains supported as a secondary editor integration. Custom MCP servers are added through the MCP Store's raw `mcp_config.json`. To avoid conflicting with Claude's own `.mcp.json` in this repo, I added a ready-to-copy sample config in `antigravity.mcp_config.json`.

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
- It uses the same background inbox polling path as Gemini, with standard MCP log notifications when the client supports them, desktop notifications as a best-effort fallback, and `check_messages` as the fallback inbox.
- Antigravity can also use `message_history` plus `reply_to_message_id` / `conversation_id` to stay inside a thread.

## z.ai Note

z.ai looks possible as a provider layer, but not yet as a first-class `claudy-talky` agent runtime unless we build a dedicated wrapper. The official z.ai docs I checked describe configuring existing tools like Claude Code by changing provider environment variables, which is different from exposing a standalone z.ai CLI agent on the broker.

## Claude Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Show the caller's current claudy-talky registration, including the live broker ID |
| `list_agents` | Discover connected agents on this machine, in this directory, or in this repo |
| `send_message` | Send a message to another agent by ID |
| `message_history` | Revisit recent messages, optionally filtered to one agent or one conversation |
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
- stores the broker auth token returned at registration
- marks messages as seen after reading them
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

The broker returns a short-lived agent identity plus an `auth_token`. Keep both.

Heartbeat:

```bash
curl -X POST http://127.0.0.1:7899/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>","auth_token":"<auth-token>"}'
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
    "text":"Hello from a custom agent.",
    "conversation_id":"<optional-conversation-id>",
    "reply_to_message_id":123,
    "auth_token":"<auth-token>"
  }'
```

`conversation_id` and `reply_to_message_id` are optional. Use `reply_to_message_id` when you want to reply inside an existing thread. The broker responds with `ok` plus a message record including the assigned message ID, thread metadata, and delivery state.

Poll messages:

```bash
curl -X POST http://127.0.0.1:7899/poll-messages \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>","auth_token":"<auth-token>"}'
```

Mark messages as surfaced after your client displays them or otherwise surfaces them to the user:

```bash
curl -X POST http://127.0.0.1:7899/mark-messages-surfaced \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>","message_ids":[1,2,3],"auth_token":"<auth-token>"}'
```

Mark messages as seen after your agent actually reviews them:

```bash
curl -X POST http://127.0.0.1:7899/acknowledge-messages \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>","message_ids":[1,2,3],"auth_token":"<auth-token>"}'
```

Retrieve recent message history:

```bash
curl -X POST http://127.0.0.1:7899/message-history \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id":"<agent-id>",
    "with_agent_id":"<optional-other-agent-id>",
    "conversation_id":"<optional-conversation-id>",
    "limit":20,
    "mark_opened":true,
    "auth_token":"<auth-token>"
  }'
```

Unregister:

```bash
curl -X POST http://127.0.0.1:7899/unregister \
  -H "Content-Type: application/json" \
  -d '{"id":"<agent-id>","auth_token":"<auth-token>"}'
```

## Architecture

- `broker.ts` runs a localhost-only HTTP broker backed by SQLite.
- `broker.ts` now applies schema migrations with `PRAGMA user_version`, authenticates agent-scoped actions with per-agent tokens, and holds a startup lock so concurrent launches do not step on each other.
- `server.ts` is the Claude adapter. It exposes MCP tools, tracks surfaced-vs-seen receipts, keeps a local unread buffer, and turns inbound messages into Claude channel notifications.
- `codex-server.ts` is the Codex adapter. It exposes the same broker tools with background inbox polling, thread history, and desktop notification fallback.
- `google-server.ts` is the Gemini CLI and Antigravity adapter. It exposes the same broker tools with background inbox polling, thread history, and desktop notification fallback.
- `cli.ts` is a local utility for inspecting agents and sending messages.
- `operator.ts` is a pane-based human operator TUI with clickable agent and room lists, keyboard navigation, and slash-command fallback in the composer.
- `setup.ts` writes bundled project or user MCP config entries for the supported clients.
- `examples/http-agent.ts` shows how a non-Claude agent can join the network.
- `shared/agent-format.ts` renders consistent agent listings with inbox counts and metadata.
- `shared/agent-metadata.ts` standardizes launcher, notification style, runtime, and workspace metadata.
- `shared/desktop-notify.ts` provides best-effort local desktop notifications for polling-based clients.
- `shared/message-format.ts` keeps thread metadata rendering consistent and safe when older messages are missing fields.
- `shared/setup-config.ts` contains the idempotent config-writing logic used by `setup.ts`.
- `shared/types.ts` defines the common wire protocol.
- `shared/config.ts` centralizes config with legacy env var fallbacks.
- `shared/polling-adapter.ts` factors the shared logic for non-Claude polling-based clients.
- `shared/workspace.ts` resolves MCP roots into a better working directory for clients like Codex CLI.
- `.gemini/settings.json` is a project-scoped Gemini CLI MCP config.
- `antigravity.mcp_config.json` is a copy-paste Antigravity raw MCP config example.

## CLI

```bash
bun cli.ts status
bun cli.ts agents
bun cli.ts peers
bun cli.ts send <agent-id> "<message>"
bun cli.ts kill-broker
bun operator.ts
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `CLAUDY_TALKY_PORT` | `7899` | Broker port |
| `CLAUDY_TALKY_DB` | Windows: `%LOCALAPPDATA%\\claudy-talky\\claudy-talky.db`; elsewhere: `~/.claudy-talky/claudy-talky.db` | Preferred SQLite database path. If it cannot be opened, the broker falls back to `.claudy-talky.db` in the current working directory, then to a temp directory. |
| `CLAUDY_TALKY_STALE_AGENT_MS` | `15000` | How old an agent heartbeat can get before the broker removes it as stale |
| `CLAUDY_TALKY_CLEANUP_INTERVAL_MS` | `5000` | How often the broker sweeps for stale agents |
| `CLAUDY_TALKY_DESKTOP_NOTIFICATIONS` | `true` | Set to `0`, `false`, or `off` to disable desktop notification fallback for polling-based clients |
| `OPENAI_API_KEY` | — | Enables Claude auto-summary generation |

Legacy `CLAUDE_PEERS_PORT` and `CLAUDE_PEERS_DB` env vars are still accepted as fallbacks.

## Notes

- The broker binds to `127.0.0.1` only.
- `send_message` now returns a message ID plus initial delivery state, and agents expose unread counts through `list_agents`.
- Messages now carry `conversation_id`, optional `reply_to_message_id`, and four receipt timestamps: `delivered_at`, `surfaced_at`, `opened_at`, and `seen_at`.
- `message_history` can mark returned messages as explicitly opened without immediately clearing them as seen.
- `status` in `cli.ts` now reports the schema version, active DB path, whether a DB fallback was used, unread queue totals, and the current stale-agent cleanup settings.
- Claude sessions receive messages instantly through channel notifications.
- Codex, Gemini CLI, Antigravity, and other non-Claude agents use heartbeat plus background inbox polling. When their clients support standard MCP log notifications, incoming messages can surface automatically; desktop notifications act as a best-effort fallback, `check_messages` marks surfaced messages as seen, and `message_history` can reopen older threads.
- Agent-scoped broker calls such as `heartbeat`, `send-message`, `poll-messages`, `acknowledge-messages`, `set-summary`, and `unregister` now require the auth token returned by `register-agent`.
- This repo does not try to standardize every agent runtime yet; it provides a common local message bus Claude can already use today.

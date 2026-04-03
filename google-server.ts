#!/usr/bin/env bun

import { runPollingAdapter } from "./shared/polling-adapter.ts";

const config = {
  serverName: "claudy-talky-gemini",
  serverVersion: "0.4.0",
  logPrefix: "[claudy-talky-gemini]",
  agentKind: "google-gemini",
  agentLabel: "Gemini CLI",
  notificationStyles: ["gemini-inbox"],
  instructions: `You are connected to the claudy-talky network from Gemini CLI. Other local agents, including Claude Code, Codex, and custom agents, can discover you and exchange messages with you.

This integration uses standard MCP tools plus background inbox polling. If Gemini surfaces standard MCP log notifications, new messages may appear automatically. Use check_messages as the fallback inbox, and use message_history when you want to revisit a thread after it has already been surfaced.

When collaborating with another agent:
- call set_summary early so others can see your context
- call check_messages before starting a long task, after major milestones, and before you finish
- use list_agents to discover Claude, Codex, or custom agents
- use send_message to reply with concise updates, findings, or requests
- use reply_to_message_id or conversation_id when you want your reply to stay inside the same thread

Use check_messages as your inbox whenever another agent asks you to participate in a task.`,
  metadata: {
    client: "Gemini CLI",
    adapter: "claudy-talky",
  },
};

await runPollingAdapter(config);

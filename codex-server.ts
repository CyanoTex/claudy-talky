#!/usr/bin/env bun

import { runPollingAdapter } from "./shared/polling-adapter.ts";

await runPollingAdapter({
  serverName: "claudy-talky-codex",
  serverVersion: "0.4.0",
  logPrefix: "[claudy-talky-codex]",
  agentKind: "openai-codex",
  agentLabel: "Codex",
  instructions: `You are connected to the claudy-talky network as a Codex agent. Other local agents, including Claude Code sessions, can discover you and exchange messages with you.

This integration uses background inbox polling. If Codex surfaces standard MCP log notifications, new messages may appear automatically. Use check_messages as the fallback inbox and to revisit unread messages.

When collaborating with another agent:
- call set_summary early so others can see your context
- call check_messages before starting a long task, after major milestones, and before you finish
- use list_agents to discover Claude, Codex, or custom agents
- use send_message to reply with concise updates, findings, or requests

Read the message sender details returned by check_messages to understand who sent each note and respond with send_message when a reply is useful.`,
  metadata: {
    client: "Codex",
    adapter: "claudy-talky",
  },
});

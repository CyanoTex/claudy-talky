#!/usr/bin/env bun

import { runPollingAdapter } from "./shared/polling-adapter.ts";

type GoogleClientMode = "gemini" | "antigravity";

function parseClientMode(argv: string[]): GoogleClientMode {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--client") {
      const next = argv[index + 1];
      if (next === "antigravity" || next === "gemini") {
        return next;
      }
    }
  }

  return "gemini";
}

const mode = parseClientMode(process.argv.slice(2));

const config =
  mode === "antigravity"
    ? {
        serverName: "claudy-talky-antigravity",
        serverVersion: "0.4.0",
        logPrefix: "[claudy-talky-antigravity]",
        agentKind: "google-antigravity",
        agentLabel: "Antigravity",
        instructions: `You are connected to the claudy-talky network from Google Antigravity. Other local agents, including Claude Code, Codex, Gemini CLI, and custom agents, can discover you and exchange messages with you.

This integration uses standard MCP tools plus background inbox polling. If Antigravity surfaces standard MCP log notifications, new messages may appear automatically. Use check_messages as the fallback inbox and to revisit unread messages.

When collaborating with another agent:
- call set_summary early so others can see your context
- call check_messages before starting a long task, after major milestones, and before you finish
- use list_agents to discover Claude, Codex, Gemini, or custom agents
- use send_message to reply with concise updates, findings, or requests

Use check_messages as your inbox whenever another agent asks you to participate in a task.`,
        metadata: {
          client: "Antigravity",
          adapter: "claudy-talky",
        },
      }
    : {
        serverName: "claudy-talky-gemini",
        serverVersion: "0.4.0",
        logPrefix: "[claudy-talky-gemini]",
        agentKind: "google-gemini",
        agentLabel: "Gemini CLI",
        instructions: `You are connected to the claudy-talky network from Gemini CLI. Other local agents, including Claude Code, Codex, Antigravity, and custom agents, can discover you and exchange messages with you.

This integration uses standard MCP tools plus background inbox polling. If Gemini surfaces standard MCP log notifications, new messages may appear automatically. Use check_messages as the fallback inbox and to revisit unread messages.

When collaborating with another agent:
- call set_summary early so others can see your context
- call check_messages before starting a long task, after major milestones, and before you finish
- use list_agents to discover Claude, Codex, Antigravity, or custom agents
- use send_message to reply with concise updates, findings, or requests

Use check_messages as your inbox whenever another agent asks you to participate in a task.`,
        metadata: {
          client: "Gemini CLI",
          adapter: "claudy-talky",
        },
      };

await runPollingAdapter(config);

#!/usr/bin/env bun
/**
 * claudy-talky MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per Claude instance).
 * Registers Claude as an agent with the shared broker and exposes tools that
 * let Claude discover and message any other connected agents.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claudy-talky
 *
 * With .mcp.json:
 *   { "claudy-talky": { "command": "bun", "args": ["./server.ts"] } }
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getBrokerPort } from "./shared/config.ts";
import type {
  Agent,
  AgentId,
  PollMessagesResponse,
  RegisterAgentResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import {
  brokerFetch,
  listAgentsCompatible,
  registerAgentCompatible,
} from "./shared/broker-compat.ts";

const BROKER_PORT = getBrokerPort();
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = fileURLToPath(new URL("./broker.ts", import.meta.url));

async function isBrokerAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const processHandle = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });

  processHandle.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }

  throw new Error("Failed to start broker daemon after 6 seconds");
}

function log(message: string) {
  console.error(`[claudy-talky] ${message}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const processHandle = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(processHandle.stdout).text();
    const exitCode = await processHandle.exited;
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

function getTty(): string | null {
  if (process.env.TTY) {
    return process.env.TTY;
  }

  if (process.platform === "win32") {
    return process.env.WT_SESSION ? "windows-terminal" : null;
  }

  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(process.ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function defaultClaudeName(cwd: string): string {
  const leaf = basename(cwd);
  return leaf ? `Claude Code @ ${leaf}` : "Claude Code";
}

function formatAgent(agent: Agent): string {
  const parts = [
    `ID: ${agent.id}`,
    `Name: ${agent.name}`,
    `Kind: ${agent.kind}`,
    `Transport: ${agent.transport}`,
  ];

  if (agent.cwd) {
    parts.push(`CWD: ${agent.cwd}`);
  }
  if (agent.git_root) {
    parts.push(`Repo: ${agent.git_root}`);
  }
  if (agent.capabilities.length > 0) {
    parts.push(`Capabilities: ${agent.capabilities.join(", ")}`);
  }
  if (agent.summary) {
    parts.push(`Summary: ${agent.summary}`);
  }
  if (agent.tty) {
    parts.push(`TTY: ${agent.tty}`);
  }

  const metadataKeys = Object.keys(agent.metadata);
  if (metadataKeys.length > 0) {
    parts.push(`Metadata keys: ${metadataKeys.join(", ")}`);
  }

  parts.push(`Last seen: ${agent.last_seen}`);
  return parts.join("\n  ");
}

let myId: AgentId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "claudy-talky", version: "0.4.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claudy-talky network. Other local agents can see you and send you messages, including Claude Code sessions and non-Claude agents that integrate over HTTP.

IMPORTANT: When you receive a <channel source="claudy-talky" ...> message, RESPOND IMMEDIATELY when a reply is appropriate. Do not wait until your current task is finished. Pause, reply with send_message, then resume your work.

Read the from_id, from_name, from_kind, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_agents: Discover other connected agents on this machine
- send_message: Send a message to another agent by ID
- set_summary: Set a 1-2 sentence summary of what you're working on
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on so other agents have context.`,
  }
);

const LIST_AGENTS_SCHEMA = {
  type: "object" as const,
  properties: {
    scope: {
      type: "string" as const,
      enum: ["machine", "directory", "repo"],
      description:
        'Discovery scope. "machine" lists every connected agent, "directory" limits to the current working directory, and "repo" limits to the current git repository.',
    },
    kind: {
      type: "string" as const,
      description:
        'Optional agent kind filter, such as "claude-code", "openai-codex", or "custom-http-agent".',
    },
    capability: {
      type: "string" as const,
      description:
        'Optional capability filter, such as "messaging", "channel_notifications", or "tool_use".',
    },
  },
  required: ["scope"],
};

const TOOLS = [
  {
    name: "list_agents",
    description:
      "List other connected agents. Returns their ID, name, kind, transport, working directory, repo, and summary.",
    inputSchema: LIST_AGENTS_SCHEMA,
  },
  {
    name: "list_peers",
    description:
      "Deprecated alias for list_agents. Lists other connected agents on this machine.",
    inputSchema: LIST_AGENTS_SCHEMA,
  },
  {
    name: "send_message",
    description:
      "Send a message to another connected agent by ID. Messages are pushed into Claude sessions immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The target agent ID from list_agents",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary of what you are currently working on. This is visible to other agents when they list connected agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other agents. Claude normally receives them automatically via channel notifications.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "list_agents":
    case "list_peers": {
      const {
        scope,
        kind,
        capability,
      } = args as {
        scope: "machine" | "directory" | "repo";
        kind?: string;
        capability?: string;
      };

      try {
        const agents = await listAgentsCompatible(BROKER_URL, {
          scope,
          kind,
          capability,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId ?? undefined,
        });

        if (agents.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other agents found (scope: ${scope}).`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${agents.length} agent(s) (scope: ${scope}):\n\n${agents
                .map(formatAgent)
                .join("\n\n")}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing agents: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>(
          BROKER_URL,
          "/send-message",
          {
            from_id: myId,
            to_id,
            text: message,
          }
        );

        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to send: ${result.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to agent ${to_id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      try {
        await brokerFetch(BROKER_URL, "/set-summary", { id: myId, summary });
        return {
          content: [
            {
              type: "text" as const,
              text: `Summary updated: "${summary}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      try {
        const result = await brokerFetch<PollMessagesResponse>(BROKER_URL, "/poll-messages", {
          id: myId,
        });

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        const agents = await listAgentsCompatible(BROKER_URL, {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const byId = new Map(agents.map((agent) => [agent.id, agent]));

        const lines = result.messages.map((message) => {
          const sender = byId.get(message.from_id);
          const label = sender
            ? `${sender.name} (${sender.kind}, ${message.from_id})`
            : message.from_id;
          return `From ${label} at ${message.sent_at}:\n${message.text}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join(
                "\n\n---\n\n"
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function pollAndPushMessages() {
  if (!myId) {
    return;
  }

  try {
    const result = await brokerFetch<PollMessagesResponse>(BROKER_URL, "/poll-messages", {
      id: myId,
    });

    if (result.messages.length === 0) {
      return;
    }

    const agents = await listAgentsCompatible(BROKER_URL, {
      scope: "machine",
      cwd: myCwd,
      git_root: myGitRoot,
    });
    const byId = new Map(agents.map((agent) => [agent.id, agent]));

    for (const message of result.messages) {
      const sender = byId.get(message.from_id);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.text,
          meta: {
            from_id: message.from_id,
            from_name: sender?.name ?? "",
            from_kind: sender?.kind ?? "",
            from_summary: sender?.summary ?? "",
            from_cwd: sender?.cwd ?? "",
            sent_at: message.sent_at,
          },
        },
      });

      log(
        `Pushed message from ${sender?.name ?? message.from_id}: ${message.text.slice(0, 80)}`
      );
    }
  } catch (error) {
    log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  await ensureBroker();

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });

      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (error) {
      log(
        `Auto-summary failed (non-critical): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  })();

  await Promise.race([summaryPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);

  const registration = await registerAgentCompatible(BROKER_URL, {
    pid: process.pid,
    name: defaultClaudeName(myCwd),
    kind: "claude-code",
    transport: "mcp-channel",
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    capabilities: [
      "messaging",
      "directory_scope",
      "repo_scope",
      "summary",
      "channel_notifications",
    ],
    metadata: {
      client: "Claude Code",
      adapter: "claudy-talky",
    },
  });

  myId = registration.id;
  log(`Registered as agent ${myId}`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (!initialSummary || !myId) {
        return;
      }

      try {
        await brokerFetch(BROKER_URL, "/set-summary", { id: myId, summary: initialSummary });
        log(`Late auto-summary applied: ${initialSummary}`);
      } catch {
        // Best effort.
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    if (!myId) {
      return;
    }

    try {
      await brokerFetch(BROKER_URL, "/heartbeat", { id: myId });
    } catch {
      // Best effort.
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);

    if (myId) {
      try {
        await brokerFetch(BROKER_URL, "/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort.
      }
    }

    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

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
import { buildAgentMetadata } from "./shared/agent-metadata.ts";
import { formatAgent } from "./shared/agent-format.ts";
import {
  appendMessageStateLines,
  conversationIdText,
  replyToMessageIdValue,
} from "./shared/message-format.ts";
import {
  acknowledgeMessagesCompatible,
  brokerFetch,
  listAgentsCompatible,
  markMessagesSurfacedCompatible,
  messageHistoryCompatible,
  registerAgentCompatible,
} from "./shared/broker-compat.ts";
import { getBrokerPort } from "./shared/config.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import {
  isPidAlive,
  shouldWatchParentPid,
} from "./shared/process-lifecycle.ts";
import type {
  Agent,
  AgentId,
  Message,
  PollMessagesResponse,
  SendMessageResponse,
  WhoAmIResponse,
} from "./shared/types.ts";

const BROKER_PORT = getBrokerPort();
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PARENT_WATCH_INTERVAL_MS = 5_000;
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

type BufferedInboxMessage = {
  message: PollMessagesResponse["messages"][number];
  sender: Agent | null;
};

let myId: AgentId | null = null;
let myAuthToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let bufferedInbox: BufferedInboxMessage[] = [];
let inboxSyncPromise: Promise<void> | null = null;
let initialSummary = "";

function withAuth<T extends object>(body: T): T & { auth_token?: string } {
  return myAuthToken ? { ...body, auth_token: myAuthToken } : body;
}

function formatBufferedMessage(entry: BufferedInboxMessage): string {
  const { message, sender } = entry;
  const label = sender
    ? `${sender.name} (${sender.kind}, ${message.from_id})`
    : message.from_id;
  const details = [`Message #${message.id} from ${label} at ${message.sent_at}:`, message.text];
  appendMessageStateLines(details, message);
  return details.join("\n");
}

function formatHistoryMessage(
  message: Message,
  agentsById: Map<AgentId, Agent>,
  selfId: AgentId
): string {
  const otherId = message.from_id === selfId ? message.to_id : message.from_id;
  const otherAgent = agentsById.get(otherId);
  const direction =
    message.from_id === selfId
      ? `You -> ${otherAgent?.name ?? otherId}`
      : `${otherAgent?.name ?? message.from_id} -> you`;
  const details = [`Message #${message.id} ${direction} at ${message.sent_at}:`, message.text];
  appendMessageStateLines(details, message);
  return details.join("\n");
}

function formatWhoAmI(identity: WhoAmIResponse): string {
  return [
    "You are currently registered on claudy-talky as:",
    `- ID: ${identity.id}`,
    `- Name: ${identity.name}`,
    `- Kind: ${identity.kind}`,
    `- Transport: ${identity.transport}`,
    `- CWD: ${identity.cwd ?? "(none)"}`,
    `- Git root: ${identity.git_root ?? "(none)"}`,
    `- TTY: ${identity.tty ?? "(unknown)"}`,
    `- Summary: ${identity.summary || "(empty)"}`,
  ].join("\n");
}

async function listAgentsById(): Promise<Map<AgentId, Agent>> {
  const agents = await listAgentsCompatible(BROKER_URL, {
    scope: "machine",
    cwd: myCwd,
    git_root: myGitRoot,
  });
  return new Map(agents.map((agent) => [agent.id, agent]));
}

const mcp = new Server(
  { name: "claudy-talky", version: "0.4.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claudy-talky network. Other local agents can see you and send you messages, including Claude Code sessions and non-Claude agents that integrate over HTTP.

IMPORTANT: When you receive a <channel source="claudy-talky" ...> message, RESPOND IMMEDIATELY when a reply is appropriate. Do not wait until your current task is finished. Pause, reply with send_message, then resume your work.

Read the from_id, from_name, from_kind, from_summary, and from_cwd attributes to understand who sent the message. Channel metadata also includes message_id, conversation_id, and reply_to_message_id. Reply by calling send_message with their from_id, and use reply_to_message_id or conversation_id when you want to stay in the same thread.

Available tools:
- whoami: Show your current claudy-talky registration, including your live broker ID
- list_agents: Discover other connected agents on this machine
- send_message: Send a message to another agent by ID
- message_history: Revisit recent messages or a specific conversation
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
        'Optional capability filter, such as "messaging", "channel_notifications", "message_receipts", or "tool_use".',
    },
  },
  required: ["scope"],
};

const TOOLS = [
  {
    name: "whoami",
    description:
      "Show your current claudy-talky registration details, including your live broker ID.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_agents",
    description:
      "List other connected agents. Returns their ID, name, kind, transport, working directory, repo, inbox counts, and summary.",
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
        conversation_id: {
          type: "string" as const,
          description:
            "Optional conversation ID to continue an existing thread without replying to a specific message.",
        },
        reply_to_message_id: {
          type: "number" as const,
          description:
            "Optional message ID to reply to. This keeps the reply inside the original conversation automatically.",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "message_history",
    description:
      "Show recent messages from your inbox history. Filter by agent ID or conversation ID to revisit a thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        with_agent_id: {
          type: "string" as const,
          description: "Optional other agent ID to limit history to one participant.",
        },
        conversation_id: {
          type: "string" as const,
          description: "Optional conversation ID to limit history to one thread.",
        },
        limit: {
          type: "number" as const,
          description: "Maximum number of messages to return. Defaults to 20.",
        },
      },
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
    case "whoami": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      const identity: WhoAmIResponse = {
        id: myId,
        name: defaultClaudeName(myCwd),
        kind: "claude-code",
        transport: "mcp-channel",
        cwd: myCwd,
        git_root: myGitRoot,
        tty: getTty(),
        summary: initialSummary,
      };

      try {
        const byId = await listAgentsById();
        const registered = byId.get(myId);
        if (registered) {
          identity.name = registered.name;
          identity.kind = registered.kind;
          identity.transport = registered.transport;
          identity.cwd = registered.cwd;
          identity.git_root = registered.git_root;
          identity.tty = registered.tty;
          identity.summary = registered.summary;
        }
      } catch {
        // Fall back to local process context.
      }

      return {
        content: [{ type: "text" as const, text: formatWhoAmI(identity) }],
      };
    }

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
      const { to_id, message, conversation_id, reply_to_message_id } = args as {
        to_id: string;
        message: string;
        conversation_id?: string;
        reply_to_message_id?: number;
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      try {
        const result = await brokerFetch<SendMessageResponse>(
          BROKER_URL,
          "/send-message",
          withAuth({
            from_id: myId,
            to_id,
            text: message,
            conversation_id,
            reply_to_message_id,
          })
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
              text: `Message sent to agent ${to_id}${result.message ? ` (message #${result.message.id}, conversation ${result.message.conversation_id}${result.message.reply_to_message_id !== null ? `, reply to #${result.message.reply_to_message_id}` : ""})` : ""}`,
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

    case "message_history": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      try {
        const { with_agent_id, conversation_id, limit } = args as {
          with_agent_id?: string;
          conversation_id?: string;
          limit?: number;
        };

        const result = await messageHistoryCompatible(
          BROKER_URL,
          withAuth({
            agent_id: myId,
            with_agent_id,
            conversation_id,
            limit,
            mark_opened: true,
          })
        );

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No matching messages found." }],
          };
        }

        const agentsById = await listAgentsById();
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} message(s):\n\n${result.messages
                .map((message) => formatHistoryMessage(message, agentsById, myId!))
                .join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error loading history: ${error instanceof Error ? error.message : String(error)}`,
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
        await brokerFetch(
          BROKER_URL,
          "/set-summary",
          withAuth({ id: myId, summary })
        );
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
        await syncInbox(false);

        const messages = bufferedInbox;
        bufferedInbox = [];

        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        await acknowledgeMessagesCompatible(BROKER_URL, withAuth({
          id: myId,
          message_ids: messages.map((entry) => entry.message.id),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: `${messages.length} new message(s):\n\n${messages
                .map(formatBufferedMessage)
                .join(
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

async function syncInbox(notifyClient: boolean) {
  if (!myId) {
    return;
  }

  if (inboxSyncPromise) {
    await inboxSyncPromise;
    return;
  }

  inboxSyncPromise = (async () => {
    const result = await brokerFetch<PollMessagesResponse>(
      BROKER_URL,
      "/poll-messages",
      withAuth({
        id: myId!,
      })
    );

    if (result.messages.length === 0) {
      return;
    }

    const byId = await listAgentsById();
    const arrivals = result.messages.map((message) => ({
      message,
      sender: byId.get(message.from_id) ?? null,
    }));

    bufferedInbox.push(...arrivals);

    if (!notifyClient) {
      return;
    }

    for (const entry of arrivals) {
      const conversationId = conversationIdText(entry.message) ?? "";
      const replyToMessageId = replyToMessageIdValue(entry.message);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: entry.message.text,
          meta: {
            message_id: String(entry.message.id),
            from_id: entry.message.from_id,
            from_name: entry.sender?.name ?? "",
            from_kind: entry.sender?.kind ?? "",
            from_summary: entry.sender?.summary ?? "",
            from_cwd: entry.sender?.cwd ?? "",
            sent_at: entry.message.sent_at,
            delivered_at: entry.message.delivered_at ?? "",
            surfaced_at: entry.message.surfaced_at ?? "",
            opened_at: entry.message.opened_at ?? "",
            conversation_id: conversationId,
            reply_to_message_id: replyToMessageId !== null ? String(replyToMessageId) : "",
          },
        },
      });

      log(
        `Pushed message from ${entry.sender?.name ?? entry.message.from_id}: ${entry.message.text.slice(0, 80)}`
      );
    }

    await markMessagesSurfacedCompatible(
      BROKER_URL,
      withAuth({
        id: myId!,
        message_ids: arrivals.map((entry) => entry.message.id),
      })
    );
  })()
    .catch((error) => {
      log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      inboxSyncPromise = null;
    });

  await inboxSyncPromise;
}

async function pollAndPushMessages() {
  if (!myId) {
    return;
  }

  try {
    await syncInbox(true);
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

  await Promise.race([
    summaryPromise,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);

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
      "message_receipts",
      "unread_counts",
      "channel_notifications",
    ],
    metadata: buildAgentMetadata({
      client: "Claude Code",
      adapter: "claudy-talky",
      adapterVersion: "0.4.0",
      notificationStyles: ["claude-channel", "manual-check"],
      workspaceSource: "process-cwd",
      extra: {
        client: "Claude Code",
      },
    }),
  });

  myId = registration.id;
  myAuthToken = registration.auth_token ?? null;
  log(`Registered as agent ${myId}`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (!initialSummary || !myId) {
        return;
      }

      try {
        await brokerFetch(
          BROKER_URL,
          "/set-summary",
          withAuth({
            id: myId,
            summary: initialSummary,
          })
        );
        log(`Late auto-summary applied: ${initialSummary}`);
      } catch {
        // Best effort.
      }
    });
  }

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let parentWatchTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const clearLifecycleHandles = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
      parentWatchTimer = null;
    }

    process.stdin.off("end", handleStdinEnd);
    process.stdin.off("close", handleStdinClose);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };

  const cleanup = async (reason: string) => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    shuttingDown = true;
    cleanupPromise = (async () => {
      log(`Shutting down: ${reason}`);
      clearLifecycleHandles();

      if (myId) {
        try {
          await Promise.race([
            brokerFetch(BROKER_URL, "/unregister", withAuth({ id: myId })),
            Bun.sleep(1500),
          ]);
          log("Unregistered from broker");
        } catch {
          // Best effort.
        }
      }
    })();

    await cleanupPromise;
    process.exit(0);
  };

  const scheduleCleanup = (reason: string) => {
    if (!shuttingDown) {
      void cleanup(reason);
    }
  };

  const handleStdinEnd = () => {
    scheduleCleanup("stdin ended");
  };
  const handleStdinClose = () => {
    scheduleCleanup("stdin closed");
  };
  const handleSigint = () => {
    scheduleCleanup("SIGINT");
  };
  const handleSigterm = () => {
    scheduleCleanup("SIGTERM");
  };

  mcp.onclose = () => {
    scheduleCleanup("MCP transport closed");
  };

  process.stdin.on("end", handleStdinEnd);
  process.stdin.on("close", handleStdinClose);
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  if (shouldWatchParentPid(process.ppid)) {
    const parentPid = process.ppid;
    parentWatchTimer = setInterval(() => {
      if (!isPidAlive(parentPid)) {
        scheduleCleanup(`parent process ${parentPid} exited`);
      }
    }, PARENT_WATCH_INTERVAL_MS);
    parentWatchTimer.unref?.();
  }

  await mcp.connect(transport);
  log("MCP connected");

  pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  heartbeatTimer = setInterval(async () => {
    if (!myId) {
      return;
    }

    try {
      await brokerFetch(BROKER_URL, "/heartbeat", withAuth({ id: myId }));
    } catch {
      // Best effort.
    }
  }, HEARTBEAT_INTERVAL_MS);
}

main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

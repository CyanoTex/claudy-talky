import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getBrokerPort } from "./config.ts";
import type {
  Agent,
  AgentId,
  PollMessagesResponse,
  RegisterAgentResponse,
} from "./types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./summarize.ts";
import {
  brokerFetch,
  listAgentsCompatible,
  registerAgentCompatible,
} from "./broker-compat.ts";

const HEARTBEAT_INTERVAL_MS = 15_000;
const INBOX_POLL_INTERVAL_MS = 2_000;

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
        'Optional agent kind filter, such as "claude-code", "openai-codex", "google-gemini", or "custom-http-agent".',
    },
    capability: {
      type: "string" as const,
      description:
        'Optional agent capability filter, such as "messaging", "manual_message_polling", or "channel_notifications".',
    },
  },
  required: ["scope"],
};

export type PollingAdapterOptions = {
  serverName: string;
  serverVersion: string;
  logPrefix: string;
  agentKind: string;
  agentLabel: string;
  instructions: string;
  agentTransport?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
};

type BufferedInboxMessage = {
  message: PollMessagesResponse["messages"][number];
  sender: Agent | null;
};

async function isBrokerAlive(brokerUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${brokerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createLogger(prefix: string) {
  return (message: string) => {
    console.error(`${prefix} ${message}`);
  };
}

async function ensureBroker(brokerUrl: string, log: (message: string) => void): Promise<void> {
  if (await isBrokerAlive(brokerUrl)) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const brokerScript = fileURLToPath(new URL("../broker.ts", import.meta.url));
  const processHandle = Bun.spawn(["bun", brokerScript], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });

  processHandle.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isBrokerAlive(brokerUrl)) {
      log("Broker started");
      return;
    }
  }

  throw new Error("Failed to start broker daemon after 6 seconds");
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

function defaultAgentName(label: string, cwd: string): string {
  const leaf = basename(cwd);
  return leaf ? `${label} @ ${leaf}` : label;
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

  parts.push(`Last seen: ${agent.last_seen}`);
  return parts.join("\n  ");
}

function formatBufferedMessage(entry: BufferedInboxMessage): string {
  const { message, sender } = entry;
  const label = sender
    ? `${sender.name} (${sender.kind}, ${message.from_id})`
    : message.from_id;
  return `From ${label} at ${message.sent_at}:\n${message.text}`;
}

function formatInboxNotification(entry: BufferedInboxMessage): string {
  const { message, sender } = entry;
  const header = sender
    ? `New claudy-talky message from ${sender.name} (${sender.kind})`
    : `New claudy-talky message from ${message.from_id}`;
  const details: string[] = [header, "", message.text];

  if (sender?.summary) {
    details.push("", `Sender summary: ${sender.summary}`);
  }

  if (sender?.cwd) {
    details.push(`Sender cwd: ${sender.cwd}`);
  }

  details.push('Use `check_messages` if you want to review the unread inbox again.');
  return details.join("\n");
}

export async function runPollingAdapter(options: PollingAdapterOptions): Promise<void> {
  const brokerUrl = `http://127.0.0.1:${getBrokerPort()}`;
  const log = createLogger(options.logPrefix);

  let myId: AgentId | null = null;
  let myCwd = process.cwd();
  let myGitRoot: string | null = null;
  let bufferedInbox: BufferedInboxMessage[] = [];
  let inboxSyncPromise: Promise<void> | null = null;

  const capabilities = [
    "messaging",
    "directory_scope",
    "repo_scope",
    "summary",
    "manual_message_polling",
    ...(options.capabilities ?? []),
  ];

  const tools = [
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
        "Send a message to another connected agent by ID. Use check_messages later to see replies.",
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
        "Check unread messages from other agents. This adapter also polls in the background and may surface standard MCP log notifications when the client supports them.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const mcp = new Server(
    { name: options.serverName, version: options.serverVersion },
    {
      capabilities: {
        logging: {},
        tools: {},
      },
      instructions: options.instructions,
    }
  );

  async function listAgentsById(): Promise<Map<AgentId, Agent>> {
    const agents = await listAgentsCompatible(brokerUrl, {
      scope: "machine",
      cwd: myCwd,
      git_root: myGitRoot,
    });
    return new Map(agents.map((agent) => [agent.id, agent]));
  }

  async function syncInbox(notifyClient: boolean): Promise<void> {
    if (!myId) {
      return;
    }

    if (inboxSyncPromise) {
      await inboxSyncPromise;
      return;
    }

    inboxSyncPromise = (async () => {
      const result = await brokerFetch<PollMessagesResponse>(brokerUrl, "/poll-messages", {
        id: myId!,
      });

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
        await mcp.sendLoggingMessage({
          level: "notice",
          logger: options.serverName,
          data: formatInboxNotification(entry),
        });

        log(
          `Notified inbound message from ${entry.sender?.name ?? entry.message.from_id}: ${entry.message.text.slice(0, 80)}`
        );
      }
    })()
      .catch((error) => {
        log(`Inbox sync error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inboxSyncPromise = null;
      });

    await inboxSyncPromise;
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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
          const agents = await listAgentsCompatible(brokerUrl, {
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
            brokerUrl,
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
          await brokerFetch(brokerUrl, "/set-summary", { id: myId, summary });
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

  await ensureBroker(brokerUrl, log);

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

  const registration = await registerAgentCompatible(brokerUrl, {
    pid: process.pid,
    name: defaultAgentName(options.agentLabel, myCwd),
    kind: options.agentKind,
    transport: options.agentTransport ?? "mcp-stdio",
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    capabilities,
    metadata: options.metadata ?? {},
  });

  myId = registration.id;
  log(`Registered as agent ${myId}`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (!initialSummary || !myId) {
        return;
      }

      try {
        await brokerFetch(brokerUrl, "/set-summary", { id: myId, summary: initialSummary });
        log(`Late auto-summary applied: ${initialSummary}`);
      } catch {
        // Best effort.
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const inboxTimer = setInterval(() => {
    void syncInbox(true);
  }, INBOX_POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(async () => {
    if (!myId) {
      return;
    }

    try {
      await brokerFetch(brokerUrl, "/heartbeat", { id: myId });
    } catch {
      // Best effort.
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(inboxTimer);
    clearInterval(heartbeatTimer);

    if (myId) {
      try {
        await brokerFetch(brokerUrl, "/unregister", { id: myId });
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

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildAgentMetadata } from "./agent-metadata.ts";
import { formatAgent } from "./agent-format.ts";
import {
  formatInboxNotification,
  formatInboxNotificationTitle,
} from "./inbox-notification-format.ts";
import { appendMessageStateLines } from "./message-format.ts";
import { createParticipantDisplay } from "./participant-display.ts";
import {
  formatWorkDetailLines,
  formatWorkListLine,
} from "./work-format.ts";
import {
  acknowledgeMessagesCompatible,
  brokerFetch,
  listAgentsCompatible,
  markMessagesSurfacedCompatible,
  messageHistoryCompatible,
  registerAgentCompatible,
} from "./broker-compat.ts";
import { getBrokerPort } from "./config.ts";
import {
  desktopNotificationsEnabled,
  sendDesktopNotification,
} from "./desktop-notify.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./summarize.ts";
import {
  isPidAlive,
  shouldWatchParentPid,
} from "./process-lifecycle.ts";
import type {
  Agent,
  AgentId,
  AssignWorkResponse,
  GetWorkResponse,
  HandoffWorkResponse,
  ListWorkResponse,
  Message,
  PollMessagesResponse,
  QueueWorkResponse,
  SendMessageResponse,
  UpdateWorkStatusResponse,
  WhoAmIResponse,
} from "./types.ts";
import { resolveWorkspaceCwdFromRootUris } from "./workspace.ts";

const HEARTBEAT_INTERVAL_MS = 15_000;
const INBOX_POLL_INTERVAL_MS = 2_000;
const PARENT_WATCH_INTERVAL_MS = 5_000;

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
        'Optional agent capability filter, such as "messaging", "manual_message_polling", "message_receipts", or "channel_notifications".',
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
  clientVersion?: string | null;
  launcher?: string;
  notificationStyles?: string[];
  enableDesktopNotifications?: boolean;
  metadata?: Record<string, unknown>;
};

type BufferedInboxMessage = {
  message: PollMessagesResponse["messages"][number];
  sender: Agent | null;
  senderLabel: string;
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

async function ensureBroker(
  brokerUrl: string,
  log: (message: string) => void
): Promise<void> {
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
  participantDisplay: (agentId: AgentId) => string,
  myId: AgentId
): string {
  const otherId = message.from_id === myId ? message.to_id : message.from_id;
  const direction =
    message.from_id === myId
      ? `You -> ${participantDisplay(otherId)}`
      : `${participantDisplay(message.from_id)} -> you`;
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

async function resolveWorkspaceCwd(
  mcp: Server,
  fallbackCwd: string,
  log: (message: string) => void
): Promise<string> {
  const capabilities = mcp.getClientCapabilities();
  if (!capabilities?.roots) {
    return fallbackCwd;
  }

  try {
    const result = await mcp.listRoots();
    const resolved = resolveWorkspaceCwdFromRootUris(
      fallbackCwd,
      result.roots.map((root) => root.uri)
    );

    if (resolved !== fallbackCwd) {
      log(`Adjusted CWD from ${fallbackCwd} to MCP root ${resolved}`);
    }

    return resolved;
  } catch (error) {
    log(
      `Root discovery failed (non-critical): ${error instanceof Error ? error.message : String(error)}`
    );
    return fallbackCwd;
  }
}

export async function runPollingAdapter(
  options: PollingAdapterOptions
): Promise<void> {
  const brokerUrl = `http://127.0.0.1:${getBrokerPort()}`;
  const log = createLogger(options.logPrefix);

  let myId: AgentId | null = null;
  let myAuthToken: string | null = null;
  let myCwd = process.cwd();
  let myGitRoot: string | null = null;
  let workspaceSource: "process-cwd" | "mcp-roots" = "process-cwd";
  let bufferedInbox: BufferedInboxMessage[] = [];
  let inboxSyncPromise: Promise<void> | null = null;
  let desktopNotificationWarningLogged = false;
  let initialSummary = "";

  const desktopNotifications =
    options.enableDesktopNotifications ?? desktopNotificationsEnabled();

  const capabilities = [
    "messaging",
    "directory_scope",
    "repo_scope",
    "summary",
    "message_receipts",
    "unread_counts",
    "manual_message_polling",
    ...(desktopNotifications ? ["desktop_notifications"] : []),
    ...(options.capabilities ?? []),
  ];

  const tools = [
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
      name: "list_work",
      description:
        "List current work and handoff items. Filter by status, owner, or conversation when you need to inspect outstanding collaboration state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string" as const,
            enum: ["queued", "assigned", "active", "blocked", "done"],
            description: "Optional work status filter.",
          },
          owner_id: {
            type: "string" as const,
            description: "Optional owner agent ID filter.",
          },
          conversation_id: {
            type: "string" as const,
            description: "Optional conversation ID filter.",
          },
          include_done: {
            type: "boolean" as const,
            description: "Include done work items when no explicit status filter is set.",
          },
          limit: {
            type: "number" as const,
            description: "Maximum number of work items to return. Defaults to 20.",
          },
        },
      },
    },
    {
      name: "queue_work",
      description:
        "Create a queued work item without assigning it to a specific agent yet.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string" as const,
            description: "What needs to be done and why.",
          },
          title: {
            type: "string" as const,
            description: "Optional short title. If omitted, the first summary line is used.",
          },
          conversation_id: {
            type: "string" as const,
            description: "Optional conversation ID to attach the queued work to an existing thread.",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "get_work",
      description:
        "Show the full details and event history for one work item.",
      inputSchema: {
        type: "object" as const,
        properties: {
          work_id: {
            type: "number" as const,
            description: "Work item ID.",
          },
        },
        required: ["work_id"],
      },
    },
    {
      name: "handoff_work",
      description:
        "Create a new handoff item for another agent and notify them in-thread when possible.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to_id: {
            type: "string" as const,
            description: "Target agent ID from list_agents.",
          },
          summary: {
            type: "string" as const,
            description: "What needs to be done and why.",
          },
          title: {
            type: "string" as const,
            description: "Optional short title. If omitted, the first summary line is used.",
          },
          conversation_id: {
            type: "string" as const,
            description: "Optional conversation ID to attach the handoff to an existing thread.",
          },
        },
        required: ["to_id", "summary"],
      },
    },
    {
      name: "assign_work",
      description:
        "Assign a work item to another agent, or omit to_id to return it to the queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          work_id: {
            type: "number" as const,
            description: "Work item ID.",
          },
          to_id: {
            type: "string" as const,
            description: "Optional target agent ID from list_agents. Omit it to return the work to the queue.",
          },
          note: {
            type: "string" as const,
            description: "Optional reassignment note.",
          },
        },
        required: ["work_id"],
      },
    },
    {
      name: "update_work_status",
      description:
        "Update a work item by taking it, blocking it, marking it done, or returning it to active.",
      inputSchema: {
        type: "object" as const,
        properties: {
          work_id: {
            type: "number" as const,
            description: "Work item ID.",
          },
          action: {
            type: "string" as const,
            enum: ["take", "block", "done", "activate"],
            description: "Status transition to apply.",
          },
          note: {
            type: "string" as const,
            description: "Optional note or blocker reason.",
          },
        },
        required: ["work_id", "action"],
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
        "Check unread messages from other agents. This adapter also polls in the background and may surface standard MCP log notifications or desktop notifications when available.",
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

  function withAuth<T extends object>(body: T): T & { auth_token?: string } {
    return myAuthToken ? { ...body, auth_token: myAuthToken } : body;
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
      const result = await brokerFetch<PollMessagesResponse>(
        brokerUrl,
        "/poll-messages",
        withAuth({
          id: myId!,
        })
      );

      if (result.messages.length === 0) {
        return;
      }

      const byId = await listAgentsById();
      const participantDisplay = createParticipantDisplay(byId.values(), {
        selfId: myId,
      });
      const arrivals = result.messages.map((message) => ({
        message,
        sender: byId.get(message.from_id) ?? null,
        senderLabel: participantDisplay(message.from_id),
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

        if (desktopNotifications) {
          const notified = await sendDesktopNotification({
            title: formatInboxNotificationTitle(entry),
            body: entry.message.text,
          });

          if (!notified && !desktopNotificationWarningLogged) {
            log("Desktop notification fallback was unavailable");
            desktopNotificationWarningLogged = true;
          }
        }

        log(
          `Notified inbound message from ${entry.senderLabel}: ${entry.message.text.slice(0, 80)}`
        );
      }

      await markMessagesSurfacedCompatible(
        brokerUrl,
        withAuth({
          id: myId!,
          message_ids: arrivals.map((entry) => entry.message.id),
        })
      );
    })()
      .catch((error) => {
        log(
          `Inbox sync error: ${error instanceof Error ? error.message : String(error)}`
        );
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
      case "whoami": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        const identity: WhoAmIResponse = {
          id: myId,
          name: defaultAgentName(options.agentLabel, myCwd),
          kind: options.agentKind,
          transport: options.agentTransport ?? "mcp-stdio",
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
            brokerUrl,
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
            brokerUrl,
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
          const participantDisplay = createParticipantDisplay(agentsById.values(), {
            selfId: myId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `${result.messages.length} message(s):\n\n${result.messages
                  .map((message) => formatHistoryMessage(message, participantDisplay, myId!))
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

      case "list_work": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { status, owner_id, conversation_id, include_done, limit } = args as {
            status?: "queued" | "assigned" | "active" | "blocked" | "done";
            owner_id?: string;
            conversation_id?: string;
            include_done?: boolean;
            limit?: number;
          };

          const result = await brokerFetch<ListWorkResponse>(
            brokerUrl,
            "/list-work",
            withAuth({
              agent_id: myId,
              status,
              owner_id,
              conversation_id,
              include_done,
              limit,
            })
          );

          if (result.work_items.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No matching work items found." }],
            };
          }

          const agentsById = await listAgentsById();
          const participantDisplay = createParticipantDisplay(agentsById.values(), {
            selfId: myId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `${result.work_items.length} work item(s):\n\n${result.work_items
                  .map((work) => formatWorkListLine(work, participantDisplay))
                  .join("\n")}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error listing work: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "queue_work": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { summary, title, conversation_id } = args as {
            summary: string;
            title?: string;
            conversation_id?: string;
          };

          const result = await brokerFetch<QueueWorkResponse>(
            brokerUrl,
            "/queue-work",
            withAuth({
              agent_id: myId,
              summary,
              title,
              conversation_id,
            })
          );

          if (!result.ok || !result.work) {
            return {
              content: [{ type: "text" as const, text: `Failed to queue work: ${result.error ?? "unknown error"}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text" as const, text: `Queued work #${result.work.id}.` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Error queueing work: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      }

      case "get_work": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { work_id } = args as { work_id: number };
          const result = await brokerFetch<GetWorkResponse>(
            brokerUrl,
            "/get-work",
            withAuth({ agent_id: myId, work_id })
          );

          if (!result.work) {
            return {
              content: [{ type: "text" as const, text: `Work item #${work_id} not found.` }],
              isError: true,
            };
          }

          const agentsById = await listAgentsById();
          const participantDisplay = createParticipantDisplay(agentsById.values(), {
            selfId: myId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: formatWorkDetailLines(
                  result.work,
                  result.events,
                  participantDisplay
                ).join("\n"),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error loading work item: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "handoff_work": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { to_id, summary, title, conversation_id } = args as {
            to_id: string;
            summary: string;
            title?: string;
            conversation_id?: string;
          };

          const result = await brokerFetch<HandoffWorkResponse>(
            brokerUrl,
            "/handoff-work",
            withAuth({
              agent_id: myId,
              to_id,
              summary,
              title,
              conversation_id,
              notify_message: true,
            })
          );

          if (!result.ok || !result.work) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to create handoff: ${result.error ?? "unknown error"}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Created handoff #${result.work.id} for agent ${to_id}${result.notification_message ? ` (message #${result.notification_message.id}, conversation ${result.notification_message.conversation_id})` : ""}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error creating handoff: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "assign_work": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { work_id, to_id, note } = args as {
            work_id: number;
            to_id?: string;
            note?: string;
          };

          const result = await brokerFetch<AssignWorkResponse>(
            brokerUrl,
            "/assign-work",
            withAuth({
              agent_id: myId,
              work_id,
              to_id,
              note,
            })
          );

          if (!result.ok || !result.work) {
            return {
              content: [{ type: "text" as const, text: `Failed to assign work #${work_id}: ${result.error ?? "unknown error"}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text" as const, text: to_id ? `Assigned work #${result.work.id} to agent ${to_id}.` : `Returned work #${result.work.id} to the queue.` }],
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Error assigning work item: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      }

      case "update_work_status": {
        if (!myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }

        try {
          const { work_id, action, note } = args as {
            work_id: number;
            action: "take" | "block" | "done" | "activate";
            note?: string;
          };

          const result = await brokerFetch<UpdateWorkStatusResponse>(
            brokerUrl,
            "/update-work-status",
            withAuth({
              agent_id: myId,
              work_id,
              action,
              note,
            })
          );

          if (!result.ok || !result.work) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to update work #${work_id}: ${result.error ?? "unknown error"}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Updated work #${result.work.id} to ${result.work.status}.`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error updating work item: ${error instanceof Error ? error.message : String(error)}`,
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
            brokerUrl,
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

          await acknowledgeMessagesCompatible(brokerUrl, withAuth({
            id: myId,
            message_ids: messages.map((entry) => entry.message.id),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: `${messages.length} new message(s):\n\n${messages
                  .map(formatBufferedMessage)
                  .join("\n\n---\n\n")}`,
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

  const tty = getTty();

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  myCwd = await resolveWorkspaceCwd(mcp, process.cwd(), log);
  workspaceSource = myCwd === process.cwd() ? "process-cwd" : "mcp-roots";
  myGitRoot = await getGitRoot(myCwd);

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
    metadata: buildAgentMetadata({
      client:
        typeof options.metadata?.client === "string"
          ? options.metadata.client
          : options.agentLabel,
      adapter: "claudy-talky",
      adapterVersion: options.serverVersion,
      clientVersion: options.clientVersion,
      launcher: options.launcher,
      notificationStyles: [
        "manual-check",
        "mcp-logging",
        ...(desktopNotifications ? ["desktop-toast"] : []),
        ...(options.notificationStyles ?? []),
      ],
      workspaceSource,
      extra: options.metadata,
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
          brokerUrl,
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

  const inboxTimer = setInterval(() => {
    void syncInbox(true);
  }, INBOX_POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(async () => {
    if (!myId) {
      return;
    }

    try {
      await brokerFetch(brokerUrl, "/heartbeat", withAuth({ id: myId }));
    } catch {
      // Best effort.
    }
  }, HEARTBEAT_INTERVAL_MS);

  let parentWatchTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  let cleanupPromise: Promise<void> | null = null;

  const clearLifecycleHandles = () => {
    clearInterval(inboxTimer);
    clearInterval(heartbeatTimer);

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
            brokerFetch(brokerUrl, "/unregister", withAuth({ id: myId })),
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
}

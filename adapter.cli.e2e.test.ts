import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import type {
  Agent,
  HandoffWorkResponse,
  Message,
  PollMessagesResponse,
  RegisterAgentResponse,
  SendMessageResponse,
} from "./shared/types.ts";

const port = 22000 + Math.floor(Math.random() * 1000);
const dbPath = join(process.cwd(), `.adapter-cli-e2e-${port}.sqlite`);
const brokerUrl = `http://127.0.0.1:${port}`;

let brokerProcess: ReturnType<typeof Bun.spawn>;

setDefaultTimeout(20_000);

type AdapterConfig = {
  label: string;
  script: string;
  args?: string[];
  kind: string;
  transport: string;
  expectsChannelNotification: boolean;
};

type AdapterSession = {
  client: Client;
  transport: StdioClientTransport;
  notifications: Notification[];
  stderrChunks: string[];
};

const CLI_ADAPTERS: AdapterConfig[] = [
  {
    label: "Claude CLI",
    script: "server.ts",
    kind: "claude-code",
    transport: "mcp-channel",
    expectsChannelNotification: true,
  },
  {
    label: "Codex CLI",
    script: "codex-server.ts",
    kind: "openai-codex",
    transport: "mcp-stdio",
    expectsChannelNotification: false,
  },
  {
    label: "Gemini CLI",
    script: "google-server.ts",
    args: ["--client", "gemini"],
    kind: "google-gemini",
    transport: "mcp-stdio",
    expectsChannelNotification: false,
  },
];

async function waitForBroker(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${brokerUrl}/health`, {
        signal: AbortSignal.timeout(250),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting for the broker to boot.
    }

    await Bun.sleep(100);
  }

  throw new Error("Timed out waiting for broker to start");
}

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${brokerUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function waitFor<T>(
  label: string,
  producer: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  attempts = 60,
  delayMs = 100
): Promise<T> {
  let lastValue: T | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastValue = await producer();
    if (predicate(lastValue)) {
      return lastValue;
    }

    await Bun.sleep(delayMs);
  }

  throw new Error(
    `Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue, null, 2)}`
  );
}

async function listAgents(): Promise<Agent[]> {
  return brokerFetch<Agent[]>("/list-agents", { scope: "machine" });
}

async function waitForAgentByKind(kind: string): Promise<Agent> {
  const agent = await waitFor<Agent | null>(
    `agent kind ${kind}`,
    async () => (await listAgents()).find((agent) => agent.kind === kind) ?? null,
    (agent) => agent !== null
  );
  return agent!;
}

async function waitForAgentCount(expectedCount: number): Promise<void> {
  await waitFor(
    `${expectedCount} connected agents`,
    async () => (await listAgents()).length,
    (count) => count === expectedCount
  );
}

function textContent(
  result:
    | { content?: Array<{ type: string; text?: string }> }
    | { toolResult?: unknown }
): string {
  if ("content" in result) {
    return (result.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
  }

  if ("toolResult" in result) {
    return JSON.stringify(result.toolResult ?? "");
  }

  return "";
}

async function spawnAdapter(config: AdapterConfig): Promise<AdapterSession> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [config.script, ...(config.args ?? [])],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDY_TALKY_PORT: String(port),
      CLAUDY_TALKY_STALE_AGENT_MS: "60000",
      CLAUDY_TALKY_CLEANUP_INTERVAL_MS: "5000",
    },
  });

  const client = new Client(
    { name: "claudy-talky-e2e", version: "1.0.0" },
    { capabilities: {} }
  );

  const notifications: Notification[] = [];
  const stderrChunks: string[] = [];

  const stderrStream = transport.stderr;
  stderrStream?.on("data", (chunk) => {
    stderrChunks.push(chunk.toString());
  });

  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };

  await client.connect(transport);

  return {
    client,
    transport,
    notifications,
    stderrChunks,
  };
}

async function closeAdapter(
  session: AdapterSession,
  expectedRemainingAgents = 0
): Promise<void> {
  await session.client.close();
  await waitForAgentCount(expectedRemainingAgents);
}

type HelperAgent = RegisterAgentResponse & {
  name: string;
};

async function registerHelperAgent(name: string): Promise<HelperAgent> {
  const registration = await brokerFetch<RegisterAgentResponse>("/register-agent", {
    pid: process.pid,
    name,
    kind: "test-helper",
    transport: "test-helper",
    cwd: process.cwd(),
    summary: "CLI adapter E2E helper",
    capabilities: ["messaging"],
    metadata: {
      client: "E2E helper",
      adapter: "test",
    },
  });

  return {
    ...registration,
    name,
  };
}

async function unregisterHelperAgent(helper: HelperAgent): Promise<void> {
  await brokerFetch("/unregister", {
    id: helper.id,
    auth_token: helper.auth_token,
  });
}

async function waitForHelperMessage(helper: HelperAgent): Promise<Message> {
  const message = await waitFor<Message | null>(
    `message for helper ${helper.id}`,
    async () => {
      const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
        id: helper.id,
        auth_token: helper.auth_token,
      });
      return result.messages.at(0) ?? null;
    },
    (entry) => entry !== null
  );
  return message!;
}

async function sendFromHelper(
  helper: HelperAgent,
  toId: string,
  text: string,
  options?: {
    conversation_id?: string;
    reply_to_message_id?: number;
  }
): Promise<Message> {
  const result = await brokerFetch<SendMessageResponse>("/send-message", {
    from_id: helper.id,
    to_id: toId,
    text,
    conversation_id: options?.conversation_id,
    reply_to_message_id: options?.reply_to_message_id,
    auth_token: helper.auth_token,
  });

  if (!result.ok || !result.message) {
    throw new Error(`Helper send failed: ${result.error ?? "missing message"}`);
  }

  return result.message;
}

async function waitForToolText(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  expectedSubstring: string
): Promise<string> {
  return waitFor(
    `${toolName} output containing ${expectedSubstring}`,
    async () => {
      const result = await client.callTool({ name: toolName, arguments: args });
      return textContent(result);
    },
    (text) => text.includes(expectedSubstring),
    40,
    150
  );
}

beforeAll(async () => {
  brokerProcess = Bun.spawn(["bun", "broker.ts"], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      CLAUDY_TALKY_PORT: String(port),
      CLAUDY_TALKY_DB: dbPath,
      CLAUDY_TALKY_STALE_AGENT_MS: "60000",
      CLAUDY_TALKY_CLEANUP_INTERVAL_MS: "5000",
    },
  });

  await waitForBroker();
});

afterAll(async () => {
  try {
    await brokerFetch("/shutdown", {});
  } catch {
    // Best effort.
  }

  await brokerProcess.exited;

  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${dbPath}${suffix}`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!existsSync(path)) {
        break;
      }

      try {
        rmSync(path, { force: true });
        break;
      } catch (error) {
        if (attempt === 9) {
          throw error;
        }

        await Bun.sleep(100);
      }
    }
  }
});

for (const config of CLI_ADAPTERS) {
  test(`${config.label} adapter works over stdio MCP`, async () => {
    const session = await spawnAdapter(config);
    const helper = await registerHelperAgent(
      `${config.label} helper ${Math.random().toString(36).slice(2, 8)}`
    );

    try {
      const adapterAgent = await waitForAgentByKind(config.kind);

      const tools = await session.client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            "whoami",
            "list_agents",
            "send_message",
            "message_history",
            "queue_work",
            "list_work",
            "get_work",
            "handoff_work",
            "assign_work",
            "update_work_status",
            "set_summary",
            "check_messages",
          ])
        );

      const whoAmI = textContent(
        await session.client.callTool({ name: "whoami", arguments: {} })
      );
      expect(whoAmI).toContain(`Kind: ${config.kind}`);
      expect(whoAmI).toContain(`Transport: ${config.transport}`);

      const summary = `${config.label} end-to-end summary`;
      const setSummary = textContent(
        await session.client.callTool({
          name: "set_summary",
          arguments: { summary },
        })
      );
      expect(setSummary).toContain(summary);

      const updatedWhoAmI = await waitForToolText(
        session.client,
        "whoami",
        {},
        `Summary: ${summary}`
      );
      expect(updatedWhoAmI).toContain(`Summary: ${summary}`);

      const listAgentsText = textContent(
        await session.client.callTool({
          name: "list_agents",
          arguments: { scope: "machine" },
        })
      );
      expect(listAgentsText).toContain(helper.name);

      const outboundText = `${config.label} outbound ${Date.now()}`;
      const sendResult = textContent(
        await session.client.callTool({
          name: "send_message",
          arguments: {
            to_id: helper.id,
            message: outboundText,
          },
        })
      );
      expect(sendResult).toContain(`Message sent to agent ${helper.id}`);

      const outboundMessage = await waitForHelperMessage(helper);
      expect(outboundMessage.from_id).toBe(adapterAgent.id);
      expect(outboundMessage.text).toBe(outboundText);

      const inboundText = `${config.label} inbound ${Date.now()}`;
      const inboundMessage = await sendFromHelper(helper, adapterAgent.id, inboundText, {
        conversation_id: outboundMessage.conversation_id,
        reply_to_message_id: outboundMessage.id,
      });

      if (config.expectsChannelNotification) {
        const notification = await waitFor<Notification | null>(
          `${config.label} channel notification`,
          () =>
            session.notifications.find(
              (entry) => entry.method === "notifications/claude/channel"
            ) ?? null,
          (entry) => entry !== null,
          40,
          150
        );
        expect(notification).not.toBeNull();

        const params = (notification!.params ?? {}) as Record<string, unknown>;
        const meta = (params.meta ?? {}) as Record<string, unknown>;

        expect(params.content).toBe(inboundText);
        expect(meta.from_id).toBe(helper.id);
        expect(meta.conversation_id).toBe(outboundMessage.conversation_id);
        expect(meta.reply_to_message_id).toBe(String(outboundMessage.id));
      }

      const inboxText = await waitForToolText(
        session.client,
        "check_messages",
        {},
        inboundText
      );
      expect(inboxText).toContain(inboundText);
      expect(inboxText).toContain(helper.id);

      const historyText = await waitForToolText(
        session.client,
        "message_history",
        { conversation_id: outboundMessage.conversation_id, limit: 10 },
        inboundText
      );
      expect(historyText).toContain(outboundText);
      expect(historyText).toContain(inboundText);
      expect(historyText).toContain(outboundMessage.conversation_id);

      expect(inboundMessage.conversation_id).toBe(outboundMessage.conversation_id);
      expect(inboundMessage.reply_to_message_id).toBe(outboundMessage.id);

      const workSummary = `${config.label} work ${Date.now()}`;
      const queuedSummary = `${config.label} queued ${Date.now()}`;
      const queueText = textContent(
        await session.client.callTool({
          name: "queue_work",
          arguments: {
            summary: queuedSummary,
            conversation_id: outboundMessage.conversation_id,
          },
        })
      );
      expect(queueText).toContain("Queued work #");

      const queuedListText = await waitForToolText(
        session.client,
        "list_work",
        { status: "queued", limit: 20 },
        queuedSummary
      );
      const queuedWorkIdMatch = queuedListText.match(/#(\d+)/);
      expect(queuedWorkIdMatch).not.toBeNull();
      const queuedWorkId = Number(queuedWorkIdMatch?.[1]);
      expect(Number.isInteger(queuedWorkId)).toBe(true);

      const assignQueuedText = textContent(
        await session.client.callTool({
          name: "assign_work",
          arguments: {
            work_id: queuedWorkId,
            to_id: helper.id,
            note: "assign from queue in e2e",
          },
        })
      );
      expect(assignQueuedText).toContain(`Assigned work #${queuedWorkId} to agent ${helper.id}.`);

      const handoffText = textContent(
        await session.client.callTool({
          name: "handoff_work",
          arguments: {
            to_id: helper.id,
            summary: workSummary,
            conversation_id: outboundMessage.conversation_id,
          },
        })
      );
      expect(handoffText).toContain("Created handoff #");

      const handoffMessage = await waitForHelperMessage(helper);
      expect(handoffMessage.text).toContain(workSummary);
      expect(handoffMessage.conversation_id).toBe(outboundMessage.conversation_id);

      const workListText = await waitForToolText(
        session.client,
        "list_work",
        { owner_id: helper.id, include_done: true, limit: 20 },
        workSummary
      );
      const workIdMatch = workListText.match(/#(\d+)/);
      expect(workIdMatch).not.toBeNull();
      const workId = Number(workIdMatch?.[1]);
      expect(Number.isInteger(workId)).toBe(true);

      const workDetailText = await waitForToolText(
        session.client,
        "get_work",
        { work_id: workId },
        workSummary
      );
      expect(workDetailText).toContain(`Work #${workId}`);

      const rejectedDoneText = textContent(
        await session.client.callTool({
          name: "update_work_status",
          arguments: {
            work_id: workId,
            action: "done",
            note: "completed in e2e",
          },
        })
      );
      expect(rejectedDoneText).toContain(`Failed to update work #${workId}:`);
      expect(rejectedDoneText).toContain(helper.id);

      const adapterOwnedSummary = `${config.label} owned ${Date.now()}`;
      const adapterOwnedWork = await brokerFetch<HandoffWorkResponse>("/handoff-work", {
        agent_id: helper.id,
        to_id: adapterAgent.id,
        summary: adapterOwnedSummary,
        conversation_id: outboundMessage.conversation_id,
        notify_message: false,
        auth_token: helper.auth_token,
      });

      expect(adapterOwnedWork.ok).toBe(true);
      expect(adapterOwnedWork.work?.owner_id).toBe(adapterAgent.id);

      const adapterWorkId = adapterOwnedWork.work?.id;
      expect(typeof adapterWorkId).toBe("number");

      const workTakeText = textContent(
        await session.client.callTool({
          name: "update_work_status",
          arguments: {
            work_id: adapterWorkId,
            action: "take",
          },
        })
      );
      expect(workTakeText).toContain(`Updated work #${adapterWorkId} to active.`);

      const workDoneText = textContent(
        await session.client.callTool({
          name: "update_work_status",
          arguments: {
            work_id: adapterWorkId,
            action: "done",
            note: "completed in e2e",
          },
        })
      );
      expect(workDoneText).toContain(`Updated work #${adapterWorkId} to done.`);
    } catch (error) {
      const stderrText = session.stderrChunks.join("");
      throw new Error(
        `${config.label} adapter E2E test failed: ${error instanceof Error ? error.message : String(error)}\n${stderrText}`
      );
    } finally {
      await unregisterHelperAgent(helper);
      await closeAdapter(session, 0);
    }
  }, { timeout: 20_000 });
}

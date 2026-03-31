import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);
const dbPath = join(process.cwd(), `.broker-test-${port}.sqlite`);
const brokerUrl = `http://127.0.0.1:${port}`;

let brokerProcess: ReturnType<typeof Bun.spawn>;

async function waitForBroker() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
    signal: AbortSignal.timeout(2000),
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
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
      CLAUDY_TALKY_STALE_AGENT_MS: "10000",
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
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
});

test("registers agents, tracks threaded history, and separates surfaced from seen receipts", async () => {
  const claude = await brokerFetch<{ id: string; auth_token?: string }>(
    "/register-agent",
    {
    name: "Claude Code @ app",
    kind: "claude-code",
    transport: "mcp-channel",
    cwd: "C:/repo/app",
    git_root: "C:/repo",
    capabilities: ["messaging", "channel_notifications", "message_receipts"],
    summary: "Working on the main app.",
    }
  );

  const custom = await brokerFetch<{ id: string; auth_token?: string }>(
    "/register-agent",
    {
    name: "Echo Bot",
    kind: "custom-http-agent",
    transport: "http-poll",
    capabilities: ["messaging", "polling", "unread_counts"],
    summary: "Replies to every message.",
    }
  );

  expect(typeof claude.auth_token).toBe("string");
  expect(typeof custom.auth_token).toBe("string");

  const initialAgents = await brokerFetch<
    Array<{
      id: string;
      unread_count: number;
      undelivered_count: number;
      delivered_unseen_count: number;
    }>
  >("/list-agents", {
    scope: "machine",
  });

  expect(initialAgents).toHaveLength(2);
  expect(initialAgents.every((agent) => agent.unread_count === 0)).toBe(true);

  const legacyPeers = await brokerFetch<
    Array<{ id: string; name: string; kind: string }>
  >("/list-peers", {
    scope: "machine",
  });

  expect(legacyPeers).toHaveLength(2);
  expect(legacyPeers.some((agent) => agent.name === "Echo Bot")).toBe(true);

  const filteredAgents = await brokerFetch<
    Array<{ id: string; name: string; kind: string }>
  >("/list-agents", {
    scope: "machine",
    kind: "custom-http-agent",
    capability: "polling",
  });

  expect(filteredAgents).toHaveLength(1);
  expect(filteredAgents[0]?.id).toBe(custom.id);

  const sent = await brokerFetch<{
    ok: boolean;
    message?: {
      id: number;
      from_id: string;
      to_id: string;
      conversation_id: string;
      reply_to_message_id: number | null;
      delivered: boolean;
      delivered_at: string | null;
      surfaced_at: string | null;
      seen_at: string | null;
    };
  }>("/send-message", {
    from_id: claude.id,
    to_id: custom.id,
    text: "Can you confirm receipt?",
    auth_token: claude.auth_token,
  });

  expect(sent.ok).toBe(true);
  expect(sent.message?.from_id).toBe(claude.id);
  expect(sent.message?.to_id).toBe(custom.id);
  expect(sent.message?.conversation_id).toMatch(/^conv-/);
  expect(sent.message?.reply_to_message_id).toBeNull();
  expect(sent.message?.delivered).toBe(false);
  expect(sent.message?.delivered_at).toBeNull();
  expect(sent.message?.surfaced_at).toBeNull();
  expect(sent.message?.seen_at).toBeNull();

  const queuedAgents = await brokerFetch<
    Array<{
      id: string;
      unread_count: number;
      undelivered_count: number;
      delivered_unseen_count: number;
      surfaced_unseen_count: number;
    }>
  >("/list-agents", {
    scope: "machine",
  });

  const queuedCustom = queuedAgents.find((agent) => agent.id === custom.id);
  expect(queuedCustom?.unread_count).toBe(1);
  expect(queuedCustom?.undelivered_count).toBe(1);
  expect(queuedCustom?.delivered_unseen_count).toBe(0);
  expect(queuedCustom?.surfaced_unseen_count).toBe(0);

  const polled = await brokerFetch<{
    messages: Array<{
      id: number;
      from_id: string;
      to_id: string;
      text: string;
      conversation_id: string;
      reply_to_message_id: number | null;
      delivered: boolean;
      delivered_at: string | null;
      surfaced_at: string | null;
      seen_at: string | null;
    }>;
  }>("/poll-messages", {
    id: custom.id,
    auth_token: custom.auth_token,
  });

  expect(polled.messages).toHaveLength(1);
  expect(polled.messages[0]?.id).toBe(sent.message?.id);
  expect(polled.messages[0]?.from_id).toBe(claude.id);
  expect(polled.messages[0]?.to_id).toBe(custom.id);
  expect(polled.messages[0]?.text).toBe("Can you confirm receipt?");
  expect(polled.messages[0]?.conversation_id).toBe(sent.message?.conversation_id);
  expect(polled.messages[0]?.reply_to_message_id).toBeNull();
  expect(polled.messages[0]?.delivered).toBe(true);
  expect(polled.messages[0]?.delivered_at).not.toBeNull();
  expect(polled.messages[0]?.surfaced_at).toBeNull();
  expect(polled.messages[0]?.seen_at).toBeNull();

  const deliveredAgents = await brokerFetch<
    Array<{
      id: string;
      unread_count: number;
      undelivered_count: number;
      delivered_unseen_count: number;
      surfaced_unseen_count: number;
    }>
  >("/list-agents", {
    scope: "machine",
  });

  const deliveredCustom = deliveredAgents.find((agent) => agent.id === custom.id);
  expect(deliveredCustom?.unread_count).toBe(1);
  expect(deliveredCustom?.undelivered_count).toBe(0);
  expect(deliveredCustom?.delivered_unseen_count).toBe(1);
  expect(deliveredCustom?.surfaced_unseen_count).toBe(0);

  const surfaced = await brokerFetch<{ ok: boolean; updated: number }>(
    "/mark-messages-surfaced",
    {
      id: custom.id,
      message_ids: [sent.message?.id],
      auth_token: custom.auth_token,
    }
  );

  expect(surfaced.ok).toBe(true);
  expect(surfaced.updated).toBe(1);

  const surfacedAgents = await brokerFetch<
    Array<{
      id: string;
      unread_count: number;
      undelivered_count: number;
      delivered_unseen_count: number;
      surfaced_unseen_count: number;
    }>
  >("/list-agents", {
    scope: "machine",
  });

  const surfacedCustom = surfacedAgents.find((agent) => agent.id === custom.id);
  expect(surfacedCustom?.unread_count).toBe(1);
  expect(surfacedCustom?.delivered_unseen_count).toBe(1);
  expect(surfacedCustom?.surfaced_unseen_count).toBe(1);

  const acknowledged = await brokerFetch<{ ok: boolean; updated: number }>(
    "/acknowledge-messages",
    {
      id: custom.id,
      message_ids: [sent.message?.id],
      auth_token: custom.auth_token,
    }
  );

  expect(acknowledged.ok).toBe(true);
  expect(acknowledged.updated).toBe(1);

  const clearedAgents = await brokerFetch<
    Array<{
      id: string;
      unread_count: number;
      undelivered_count: number;
      delivered_unseen_count: number;
      surfaced_unseen_count: number;
    }>
  >("/list-agents", {
    scope: "machine",
  });

  const clearedCustom = clearedAgents.find((agent) => agent.id === custom.id);
  expect(clearedCustom?.unread_count).toBe(0);
  expect(clearedCustom?.undelivered_count).toBe(0);
  expect(clearedCustom?.delivered_unseen_count).toBe(0);
  expect(clearedCustom?.surfaced_unseen_count).toBe(0);

  const reply = await brokerFetch<{
    ok: boolean;
    message?: {
      id: number;
      conversation_id: string;
      reply_to_message_id: number | null;
      delivered: boolean;
    };
  }>("/send-message", {
    from_id: custom.id,
    to_id: claude.id,
    text: "Confirmed. Threading looks good on my side.",
    reply_to_message_id: sent.message?.id,
    auth_token: custom.auth_token,
  });

  expect(reply.ok).toBe(true);
  expect(reply.message?.conversation_id).toBe(sent.message?.conversation_id);
  expect(reply.message?.reply_to_message_id).toBe(sent.message?.id);
  expect(reply.message?.delivered).toBe(false);

  const history = await brokerFetch<{
    messages: Array<{
      id: number;
      from_id: string;
      to_id: string;
      conversation_id: string;
      reply_to_message_id: number | null;
      text: string;
    }>;
  }>("/message-history", {
    agent_id: claude.id,
    with_agent_id: custom.id,
    auth_token: claude.auth_token,
  });

  expect(history.messages).toHaveLength(2);
  expect(history.messages[0]?.id).toBe(sent.message?.id);
  expect(history.messages[0]?.conversation_id).toBe(sent.message?.conversation_id);
  expect(history.messages[1]?.id).toBe(reply.message?.id);
  expect(history.messages[1]?.conversation_id).toBe(sent.message?.conversation_id);
  expect(history.messages[1]?.reply_to_message_id).toBe(sent.message?.id);
  expect(history.messages[1]?.text).toContain("Threading looks good");

  const claudePoll = await brokerFetch<{
    messages: Array<{
      id: number;
      conversation_id: string;
      reply_to_message_id: number | null;
    }>;
  }>("/poll-messages", {
    id: claude.id,
    auth_token: claude.auth_token,
  });

  expect(claudePoll.messages).toHaveLength(1);
  expect(claudePoll.messages[0]?.id).toBe(reply.message?.id);
  expect(claudePoll.messages[0]?.conversation_id).toBe(sent.message?.conversation_id);
  expect(claudePoll.messages[0]?.reply_to_message_id).toBe(sent.message?.id);

  const claudeSurfaced = await brokerFetch<{ ok: boolean; updated: number }>(
    "/mark-messages-surfaced",
    {
      id: claude.id,
      message_ids: [reply.message?.id],
      auth_token: claude.auth_token,
    }
  );

  expect(claudeSurfaced.ok).toBe(true);
  expect(claudeSurfaced.updated).toBe(1);

  const claudeAcknowledged = await brokerFetch<{ ok: boolean; updated: number }>(
    "/acknowledge-messages",
    {
      id: claude.id,
      message_ids: [reply.message?.id],
      auth_token: claude.auth_token,
    }
  );

  expect(claudeAcknowledged.ok).toBe(true);
  expect(claudeAcknowledged.updated).toBe(1);

  const health = await brokerFetch<{
    status: string;
    unread_messages: number;
    undelivered_messages: number;
    surfaced_unseen_messages: number;
    schema_version: number;
  }>("/health");

  expect(health.status).toBe("ok");
  expect(health.unread_messages).toBe(0);
  expect(health.undelivered_messages).toBe(0);
  expect(health.surfaced_unseen_messages).toBe(0);
  expect(health.schema_version).toBe(4);
});

test("rejects spoofed agent actions without the correct auth token", async () => {
  const sender = await brokerFetch<{ id: string; auth_token?: string }>(
    "/register-agent",
    {
      name: "Secure Sender",
      kind: "custom-http-agent",
      transport: "http-poll",
    }
  );

  const target = await brokerFetch<{ id: string; auth_token?: string }>(
    "/register-agent",
    {
      name: "Secure Target",
      kind: "custom-http-agent",
      transport: "http-poll",
    }
  );

  const response = await fetch(`${brokerUrl}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_id: sender.id,
      to_id: target.id,
      text: "This should fail",
      auth_token: "definitely-wrong",
    }),
    signal: AbortSignal.timeout(2000),
  });

  expect(response.status).toBe(403);
  const payload = (await response.json()) as { error?: string };
  expect(payload.error).toContain("invalid auth token");
});

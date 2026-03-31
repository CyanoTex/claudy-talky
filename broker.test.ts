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

test("registers agents, supports legacy listing, and delivers messages", async () => {
  const claude = await brokerFetch<{ id: string }>("/register-agent", {
    name: "Claude Code @ app",
    kind: "claude-code",
    transport: "mcp-channel",
    cwd: "C:/repo/app",
    git_root: "C:/repo",
    capabilities: ["messaging", "channel_notifications"],
    summary: "Working on the main app.",
  });

  const custom = await brokerFetch<{ id: string }>("/register-agent", {
    name: "Echo Bot",
    kind: "custom-http-agent",
    transport: "http-poll",
    capabilities: ["messaging", "polling"],
    summary: "Replies to every message.",
  });

  const agents = await brokerFetch<
    Array<{ id: string; name: string; kind: string; capabilities: string[] }>
  >("/list-agents", {
    scope: "machine",
  });

  expect(agents).toHaveLength(2);
  expect(agents.map((agent) => agent.id).sort()).toEqual(
    [claude.id, custom.id].sort()
  );

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

  await brokerFetch<{ ok: boolean }>("/send-message", {
    from_id: claude.id,
    to_id: custom.id,
    text: "Can you confirm receipt?",
  });

  const polled = await brokerFetch<{
    messages: Array<{ from_id: string; to_id: string; text: string }>;
  }>("/poll-messages", {
    id: custom.id,
  });

  expect(polled.messages).toHaveLength(1);
  expect(polled.messages[0]?.from_id).toBe(claude.id);
  expect(polled.messages[0]?.to_id).toBe(custom.id);
  expect(polled.messages[0]?.text).toBe("Can you confirm receipt?");
});

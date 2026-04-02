import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = 21000 + Math.floor(Math.random() * 1000);
const dbPath = join(process.cwd(), `.broker-stale-${port}.sqlite`);
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
      CLAUDY_TALKY_STALE_AGENT_MS: "500",
      CLAUDY_TALKY_CLEANUP_INTERVAL_MS: "100",
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

test("removes pid-backed agents when their heartbeat goes stale", async () => {
  const registered = await brokerFetch<{ id: string; auth_token?: string }>(
    "/register-agent",
    {
      name: "Stale PID Agent",
      kind: "custom-http-agent",
      transport: "http-poll",
      pid: process.pid,
      summary: "Used to verify stale cleanup.",
    }
  );

  expect(typeof registered.id).toBe("string");

  let agents: Array<{ id: string }> = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    agents = await brokerFetch<Array<{ id: string }>>("/list-agents", {
      scope: "machine",
    });

    if (!agents.some((agent) => agent.id === registered.id)) {
      break;
    }

    await Bun.sleep(100);
  }

  expect(agents.some((agent) => agent.id === registered.id)).toBe(false);
});

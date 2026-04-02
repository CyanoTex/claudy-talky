import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = 21000 + Math.floor(Math.random() * 1000);
const dbPath = join(process.cwd(), `.server-lifecycle-test-${port}.sqlite`);
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

async function waitForAgentCount(expectedCount: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const agents = await brokerFetch<Array<{ id: string }>>("/list-agents", {
      scope: "machine",
    });
    if (agents.length === expectedCount) {
      return;
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${expectedCount} agent(s)`);
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
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
});

test("Claude adapter exits and unregisters when stdio closes", async () => {
  const serverProcess = Bun.spawn(["bun", "server.ts"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDY_TALKY_PORT: String(port),
    },
  });

  try {
    await waitForAgentCount(1);

    serverProcess.stdin.end();

    const exited = await Promise.race([
      serverProcess.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);

    if (!exited) {
      const stderrText = await new Response(serverProcess.stderr).text();
      throw new Error(
        `server.ts did not exit after stdin closed.\n${stderrText}`
      );
    }

    await waitForAgentCount(0);
    expect(await serverProcess.exited).toBe(0);
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await serverProcess.exited;
    }
  }
});

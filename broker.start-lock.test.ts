import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getBrokerLockPath } from "./shared/config.ts";

const port = 20000 + Math.floor(Math.random() * 1000);
const dbPath = join(process.cwd(), `.broker-lock-${port}.sqlite`);
const brokerUrl = `http://127.0.0.1:${port}`;
const lockPath = getBrokerLockPath(port);

let primaryBroker: ReturnType<typeof Bun.spawn>;

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
  primaryBroker = Bun.spawn(["bun", "broker.ts"], {
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

  await primaryBroker.exited;

  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }

  rmSync(lockPath, { force: true });
});

test("exits quickly when another broker already owns the startup lock", async () => {
  const competingBroker = Bun.spawn(["bun", "broker.ts"], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDY_TALKY_PORT: String(port),
      CLAUDY_TALKY_DB: dbPath,
      CLAUDY_TALKY_STALE_AGENT_MS: "10000",
    },
  });

  const exitCode = await Promise.race([
    competingBroker.exited,
    Bun.sleep(3000).then(() => {
      throw new Error("Competing broker did not exit");
    }),
  ]);

  const stderr = await new Response(competingBroker.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("startup lock");
  expect(existsSync(lockPath)).toBe(true);

  const health = await brokerFetch<{
    status: string;
    schema_version: number;
  }>("/health");

  expect(health.status).toBe("ok");
  expect(health.schema_version).toBe(4);

  const lockContents = readFileSync(lockPath, "utf8");
  expect(lockContents).toContain(`"port":${port}`);
});

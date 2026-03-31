import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = 19000 + Math.floor(Math.random() * 1000);
const brokerUrl = `http://127.0.0.1:${port}`;
const repoRoot = process.cwd();
const fixtureDir = join(process.cwd(), `.broker-fallback-${port}`);
const badDbPath = join(fixtureDir, "not-a-db");
const fallbackDbPath = join(fixtureDir, ".claudy-talky.db");

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
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(badDbPath, { recursive: true });

  brokerProcess = Bun.spawn(["bun", join(repoRoot, "broker.ts")], {
    cwd: fixtureDir,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      CLAUDY_TALKY_PORT: String(port),
      CLAUDY_TALKY_DB: badDbPath,
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

  rmSync(fixtureDir, { recursive: true, force: true });
});

test("falls back to a workspace database when the configured db path cannot be opened", async () => {
  const health = await brokerFetch<{
    status: string;
    db_path: string;
    primary_db_path: string;
    db_fallback: boolean;
  }>("/health");

  expect(health.status).toBe("ok");
  expect(health.primary_db_path).toBe(badDbPath);
  expect(health.db_fallback).toBe(true);
  expect(health.db_path).toBe(fallbackDbPath);
  expect(existsSync(fallbackDbPath)).toBe(true);
});

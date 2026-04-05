import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7899;
const DEFAULT_STALE_AGENT_MS = 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5_000;

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getHomeDir(): string {
  const home = firstEnv("HOME", "USERPROFILE") ?? homedir();
  return home && home.trim().length > 0 ? home : process.cwd();
}

function getDefaultDbPath(): string {
  if (process.platform === "win32") {
    const baseDir =
      firstEnv("LOCALAPPDATA", "APPDATA", "USERPROFILE") ?? getHomeDir();
    return join(baseDir, "claudy-talky", "claudy-talky.db");
  }

  return join(getHomeDir(), ".claudy-talky", "claudy-talky.db");
}

export function getBrokerPort(): number {
  return parseIntEnv(
    firstEnv("CLAUDY_TALKY_PORT", "CLAUDE_PEERS_PORT"),
    DEFAULT_PORT
  );
}

export function getDbPath(): string {
  return firstEnv("CLAUDY_TALKY_DB", "CLAUDE_PEERS_DB") ?? getDefaultDbPath();
}

export function getDbFallbackPaths(cwd = process.cwd()): string[] {
  const candidates = [
    getDbPath(),
    join(cwd, ".claudy-talky.db"),
    join(tmpdir(), "claudy-talky", `claudy-talky-${getBrokerPort()}.db`),
  ];

  return Array.from(
    new Set(candidates.filter((value) => value && value.trim().length > 0))
  );
}

export function getBrokerLockPath(port = getBrokerPort()): string {
  return join(tmpdir(), "claudy-talky", `broker-${port}.lock`);
}

export function getStaleAgentMs(): number {
  return parseIntEnv(
    firstEnv("CLAUDY_TALKY_STALE_AGENT_MS"),
    DEFAULT_STALE_AGENT_MS
  );
}

export function getCleanupIntervalMs(): number {
  return Math.max(
    1_000,
    parseIntEnv(
      firstEnv("CLAUDY_TALKY_CLEANUP_INTERVAL_MS"),
      DEFAULT_CLEANUP_INTERVAL_MS
    )
  );
}

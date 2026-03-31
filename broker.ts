#!/usr/bin/env bun
/**
 * claudy-talky broker daemon
 *
 * A singleton HTTP server on localhost backed by SQLite.
 * Tracks all registered agents and routes messages between them.
 *
 * Claude Code connects through the MCP server, but any agent that can make
 * local HTTP requests can register, heartbeat, poll, and exchange messages.
 *
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getBrokerPort, getDbPath, getStaleAgentMs } from "./shared/config.ts";
import type {
  Agent,
  HeartbeatRequest,
  ListAgentsRequest,
  Message,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterAgentRequest,
  RegisterAgentResponse,
  SendMessageRequest,
  SetSummaryRequest,
} from "./shared/types.ts";

const PORT = getBrokerPort();
const DB_PATH = getDbPath();
const STALE_AGENT_MS = getStaleAgentMs();

type AgentRow = {
  id: string;
  pid: number | null;
  name: string;
  kind: string;
  transport: string;
  cwd: string | null;
  git_root: string | null;
  tty: string | null;
  summary: string;
  capabilities: string;
  metadata: string;
  registered_at: string;
  last_seen: string;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- Database setup ---

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    pid INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    transport TEXT NOT NULL,
    cwd TEXT,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES agents(id),
    FOREIGN KEY (to_id) REFERENCES agents(id)
  )
`);

// --- Helpers ---

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value: unknown): string | null {
  const text = normalizeText(value);
  return text.length > 0 ? text : null;
}

function normalizePid(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const capabilities: string[] = [];

  for (const item of value) {
    const capability = normalizeText(item);
    if (!capability || seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    capabilities.push(capability);
  }

  return capabilities;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key.trim().length > 0)
  );
}

function parseJsonArray(value: string): string[] {
  try {
    return normalizeCapabilities(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    return normalizeMetadata(JSON.parse(value));
  } catch {
    return {};
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    pid: row.pid ?? null,
    cwd: row.cwd ?? null,
    git_root: row.git_root ?? null,
    tty: row.tty ?? null,
    capabilities: parseJsonArray(row.capabilities),
    metadata: parseJsonObject(row.metadata),
  };
}

function deriveDefaultName(kind: string, cwd: string | null): string {
  if (cwd) {
    const leaf = cwd.split(/[\\/]/).filter(Boolean).at(-1);
    if (leaf) {
      return `${kind} @ ${leaf}`;
    }
  }

  return kind;
}

function removeAgent(id: string) {
  deleteAgent.run(id);
  deleteMessagesForAgent.run(id, id);
}

function isAgentAlive(agent: Agent): boolean {
  if (agent.pid !== null) {
    try {
      process.kill(agent.pid, 0);
      return true;
    } catch {
      removeAgent(agent.id);
      return false;
    }
  }

  const lastSeen = Date.parse(agent.last_seen);
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen <= STALE_AGENT_MS) {
    return true;
  }

  removeAgent(agent.id);
  return false;
}

// --- Prepared statements ---

const insertAgent = db.prepare(`
  INSERT INTO agents (
    id, pid, name, kind, transport, cwd, git_root, tty, summary,
    capabilities, metadata, registered_at, last_seen
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE agents SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE agents SET summary = ? WHERE id = ?
`);

const deleteAgent = db.prepare(`
  DELETE FROM agents WHERE id = ?
`);

const deleteMessagesForAgent = db.prepare(`
  DELETE FROM messages WHERE to_id = ? OR from_id = ?
`);

const selectAllAgentRows = db.prepare(`
  SELECT * FROM agents
`);

const selectAgentRowsByDirectory = db.prepare(`
  SELECT * FROM agents WHERE cwd = ?
`);

const selectAgentRowsByGitRoot = db.prepare(`
  SELECT * FROM agents WHERE git_root = ?
`);

const selectAgentRowById = db.prepare(`
  SELECT * FROM agents WHERE id = ?
`);

const selectAgentIdByPid = db.prepare(`
  SELECT id FROM agents WHERE pid = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate agent ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Clean up stale agents on startup and periodically.
function cleanStaleAgents() {
  const rows = selectAllAgentRows.all() as AgentRow[];
  for (const row of rows) {
    isAgentAlive(toAgent(row));
  }
}

cleanStaleAgents();
setInterval(cleanStaleAgents, 30_000);

// --- Request handlers ---

function handleRegister(body: RegisterAgentRequest): RegisterAgentResponse {
  const now = new Date().toISOString();
  const kind = normalizeText(body.kind) || "agent";
  const transport = normalizeText(body.transport) || "http";
  const pid = normalizePid(body.pid);
  const cwd = normalizeOptionalText(body.cwd);
  const gitRoot = normalizeOptionalText(body.git_root);
  const tty = normalizeOptionalText(body.tty);
  const summary = normalizeText(body.summary);
  const capabilities = normalizeCapabilities(body.capabilities);
  const metadata = normalizeMetadata(body.metadata);
  const name = normalizeText(body.name) || deriveDefaultName(kind, cwd);
  const id = generateId();

  if (pid !== null) {
    const existing = selectAgentIdByPid.get(pid) as { id: string } | null;
    if (existing) {
      removeAgent(existing.id);
    }
  }

  insertAgent.run(
    id,
    pid,
    name,
    kind,
    transport,
    cwd,
    gitRoot,
    tty,
    summary,
    JSON.stringify(capabilities),
    JSON.stringify(metadata),
    now,
    now
  );

  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(normalizeText(body.summary), body.id);
}

function handleListAgents(body: ListAgentsRequest): Agent[] {
  let rows: AgentRow[];

  switch (body.scope) {
    case "directory":
      rows = body.cwd
        ? (selectAgentRowsByDirectory.all(body.cwd) as AgentRow[])
        : [];
      break;
    case "repo":
      rows = body.git_root
        ? (selectAgentRowsByGitRoot.all(body.git_root) as AgentRow[])
        : body.cwd
          ? (selectAgentRowsByDirectory.all(body.cwd) as AgentRow[])
          : [];
      break;
    case "machine":
    default:
      rows = selectAllAgentRows.all() as AgentRow[];
      break;
  }

  let agents = rows.map(toAgent);

  if (body.exclude_id) {
    agents = agents.filter((agent) => agent.id !== body.exclude_id);
  }

  if (body.kind) {
    agents = agents.filter((agent) => agent.kind === body.kind);
  }

  if (body.capability) {
    agents = agents.filter((agent) =>
      agent.capabilities.includes(body.capability as string)
    );
  }

  return agents
    .filter(isAgentAlive)
    .sort(
      (left, right) =>
        right.last_seen.localeCompare(left.last_seen) ||
        left.name.localeCompare(right.name)
    );
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = selectAgentRowById.get(body.to_id) as AgentRow | null;
  if (!target) {
    return { ok: false, error: `Agent ${body.to_id} not found` };
  }

  insertMessage.run(
    body.from_id,
    body.to_id,
    normalizeText(body.text),
    new Date().toISOString()
  );

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  for (const message of messages) {
    markDelivered.run(message.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  removeAgent(body.id);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== "POST") {
      if (path === "/health") {
        const agents = handleListAgents({ scope: "machine" }).length;
        return jsonResponse({ status: "ok", agents, peers: agents });
      }

      return new Response("claudy-talky broker", {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
        case "/register-agent":
          return jsonResponse(handleRegister(body as RegisterAgentRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return jsonResponse({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return jsonResponse({ ok: true });
        case "/list-peers":
        case "/list-agents":
          return jsonResponse(handleListAgents(body as ListAgentsRequest));
        case "/send-message":
          return jsonResponse(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return jsonResponse(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return jsonResponse({ ok: true });
        case "/shutdown":
          setTimeout(() => process.exit(0), 50);
          return jsonResponse({ ok: true });
        default:
          return jsonResponse({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, { status: 500 });
    }
  },
});

console.error(
  `[claudy-talky broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`
);

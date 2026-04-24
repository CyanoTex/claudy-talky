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
import {
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  getBrokerLockPath,
  getBrokerPort,
  getCleanupIntervalMs,
  getDbFallbackPaths,
  getDbPath,
  getStaleAgentMs,
} from "./shared/config.ts";
import type {
  AcknowledgeMessagesRequest,
  AcknowledgeMessagesResponse,
  Agent,
  BrokerHealthResponse,
  HeartbeatRequest,
  ListAgentsRequest,
  MarkMessagesSurfacedRequest,
  MarkMessagesSurfacedResponse,
  Message,
  MessageHistoryRequest,
  MessageHistoryResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  QueueWorkRequest,
  QueueWorkResponse,
  AssignWorkRequest,
  AssignWorkResponse,
  ListWorkRequest,
  ListWorkResponse,
  GetWorkRequest,
  GetWorkResponse,
  RemoveAgentAdminRequest,
  RemoveAgentAdminResponse,
  RegisterAgentRequest,
  RegisterAgentResponse,
  HandoffWorkRequest,
  HandoffWorkResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetSummaryRequest,
  UpdateWorkStatusRequest,
  UpdateWorkStatusResponse,
  UnregisterRequest,
  WorkEvent,
  WorkEventKind,
  WorkItem,
  WorkStatus,
} from "./shared/types.ts";

const PORT = getBrokerPort();
const PRIMARY_DB_PATH = getDbPath();
const LOCK_PATH = getBrokerLockPath(PORT);
const STALE_AGENT_MS = getStaleAgentMs();
const CLEANUP_INTERVAL_MS = getCleanupIntervalMs();
const LATEST_SCHEMA_VERSION = 6;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

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
  auth_token: string;
  registered_at: string;
  last_seen: string;
};

type AgentAuthRow = {
  id: string;
  auth_token: string;
};

type MessageRow = {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  conversation_id: string;
  reply_to_message_id: number | null;
  delivered: number;
  delivered_at: string | null;
  surfaced_at: string | null;
  opened_at: string | null;
  seen_at: string | null;
};

type AgentCountRow = {
  agent_id: string;
  unread_count: number | bigint | null;
  undelivered_count: number | bigint | null;
  delivered_unseen_count: number | bigint | null;
  surfaced_unseen_count: number | bigint | null;
};

type MessageTotalsRow = {
  unread_messages: number | bigint | null;
  undelivered_messages: number | bigint | null;
  surfaced_unseen_messages: number | bigint | null;
};

type WorkItemRow = {
  id: number;
  title: string;
  summary: string;
  conversation_id: string | null;
  created_by_id: string;
  owner_id: string | null;
  status: string;
  blocker_note: string | null;
  created_at: string;
  updated_at: string;
};

type WorkEventRow = {
  id: number;
  work_id: number;
  actor_id: string;
  kind: string;
  from_owner_id: string | null;
  to_owner_id: string | null;
  status: string | null;
  note: string | null;
  created_at: string;
};

class BrokerRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BrokerRequestError";
    this.status = status;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function log(message: string) {
  console.error(`[claudy-talky broker] ${message}`);
}

function normalizeCount(value: unknown): number {
  const count = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockOwnerPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(payload.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function acquireStartupLock(lockPath: string): { release: () => void } {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          port: PORT,
        })
      );

      let released = false;
      return {
        release: () => {
          if (released) {
            return;
          }

          released = true;
          try {
            rmSync(lockPath, { force: true });
          } catch {
            // Best effort.
          }
        },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";

      if (code !== "EEXIST") {
        throw error;
      }

      const ownerPid = readLockOwnerPid(lockPath);
      if (ownerPid !== null && isPidAlive(ownerPid)) {
        throw new Error(`broker startup lock is held by pid ${ownerPid}`);
      }

      try {
        rmSync(lockPath, { force: true });
      } catch {
        // If removal fails, the next attempt will surface the real error.
      }
    }
  }

  throw new Error("broker startup lock could not be acquired");
}

const startupLock = acquireStartupLock(LOCK_PATH);
let startupLockReleased = false;

function releaseStartupLock() {
  if (startupLockReleased) {
    return;
  }

  startupLockReleased = true;
  startupLock.release();
}

process.once("exit", releaseStartupLock);
process.once("SIGINT", releaseStartupLock);
process.once("SIGTERM", releaseStartupLock);

function openDatabase() {
  const candidates = getDbFallbackPaths();
  let firstError: unknown = null;

  for (const [index, dbPath] of candidates.entries()) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const database = new Database(dbPath);

      if (index > 0) {
        log(`using fallback database path ${dbPath} (primary: ${PRIMARY_DB_PATH})`);
      }

      return {
        db: database,
        dbPath,
        dbFallback: index > 0,
      };
    } catch (error) {
      firstError ??= error;
      log(
        `failed to open database at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw firstError instanceof Error
    ? firstError
    : new Error("Failed to open any claudy-talky database path");
}

const { db, dbPath: DB_PATH, dbFallback: DB_FALLBACK } = openDatabase();

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

function tableExists(name: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    )
    .get(name) as { name: string } | null;
  return row !== null;
}

function columnExists(table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function runMigration(version: number, name: string, migrate: () => void) {
  log(`applying schema migration ${version}: ${name}`);
  db.run("BEGIN IMMEDIATE");

  try {
    migrate();
    db.run(`PRAGMA user_version = ${version}`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function getSchemaVersion(): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number | bigint }
    | undefined;
  return normalizeCount(row?.user_version);
}

function generateAuthToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function generateConversationId(): string {
  return `conv-${crypto.randomUUID().replaceAll("-", "")}`;
}

function backfillMissingAgentAuthTokens() {
  if (!tableExists("agents") || !columnExists("agents", "auth_token")) {
    return;
  }

  const rows = db
    .prepare("SELECT id FROM agents WHERE auth_token IS NULL OR auth_token = ''")
    .all() as Array<{ id: string }>;

  const update = db.prepare("UPDATE agents SET auth_token = ? WHERE id = ?");
  for (const row of rows) {
    update.run(generateAuthToken(), row.id);
  }
}

function applyMigrations() {
  let version = getSchemaVersion();

  if (version < 1) {
    runMigration(1, "create base tables", () => {
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
    });

    version = 1;
  }

  if (version < 2) {
    runMigration(2, "add message delivery timestamps", () => {
      if (!columnExists("messages", "delivered_at")) {
        db.run("ALTER TABLE messages ADD COLUMN delivered_at TEXT");
      }

      if (!columnExists("messages", "seen_at")) {
        db.run("ALTER TABLE messages ADD COLUMN seen_at TEXT");
      }

      db.run(`
        UPDATE messages
        SET delivered_at = COALESCE(delivered_at, sent_at)
        WHERE delivered = 1 AND delivered_at IS NULL
      `);
    });

    version = 2;
  }

  if (version < 3) {
    runMigration(3, "add agent auth tokens", () => {
      if (!columnExists("agents", "auth_token")) {
        db.run("ALTER TABLE agents ADD COLUMN auth_token TEXT NOT NULL DEFAULT ''");
      }

      backfillMissingAgentAuthTokens();
    });

    version = 3;
  }

  if (version < 4) {
    runMigration(4, "add conversation metadata and surfaced receipts", () => {
      if (!columnExists("messages", "conversation_id")) {
        db.run("ALTER TABLE messages ADD COLUMN conversation_id TEXT");
      }

      if (!columnExists("messages", "reply_to_message_id")) {
        db.run("ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER");
      }

      if (!columnExists("messages", "surfaced_at")) {
        db.run("ALTER TABLE messages ADD COLUMN surfaced_at TEXT");
      }

      db.run(`
        UPDATE messages
        SET conversation_id = COALESCE(NULLIF(conversation_id, ''), 'legacy-' || id)
        WHERE conversation_id IS NULL OR conversation_id = ''
      `);

      db.run(`
        UPDATE messages
        SET surfaced_at = COALESCE(surfaced_at, seen_at)
        WHERE seen_at IS NOT NULL AND surfaced_at IS NULL
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_messages_recipient_delivery
        ON messages (to_id, delivered, sent_at, id)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages (conversation_id, sent_at, id)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_messages_history
        ON messages (from_id, to_id, sent_at, id)
      `);
    });

    version = 4;
  }

  if (version < 5) {
    runMigration(5, "add explicit opened receipts", () => {
      if (!columnExists("messages", "opened_at")) {
        db.run("ALTER TABLE messages ADD COLUMN opened_at TEXT");
      }

      db.run(`
        UPDATE messages
        SET opened_at = COALESCE(opened_at, seen_at)
        WHERE seen_at IS NOT NULL AND opened_at IS NULL
      `);
    });

    version = 5;
  }

  if (version < 6) {
    runMigration(6, "add work items and handoff events", () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS work_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          conversation_id TEXT,
          created_by_id TEXT NOT NULL,
          owner_id TEXT,
          status TEXT NOT NULL,
          blocker_note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (created_by_id) REFERENCES agents(id),
          FOREIGN KEY (owner_id) REFERENCES agents(id)
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS work_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_id INTEGER NOT NULL,
          actor_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          from_owner_id TEXT,
          to_owner_id TEXT,
          status TEXT,
          note TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (work_id) REFERENCES work_items(id),
          FOREIGN KEY (actor_id) REFERENCES agents(id)
        )
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_work_items_owner_status
        ON work_items (owner_id, status, updated_at, id)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_work_items_conversation
        ON work_items (conversation_id, updated_at, id)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_work_events_work
        ON work_events (work_id, created_at, id)
      `);
    });

    version = 6;
  }

  if (version !== LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Unexpected schema version after migration: ${version} (expected ${LATEST_SCHEMA_VERSION})`
    );
  }
}

applyMigrations();

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

function normalizeMessageIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<number>();
  const ids: number[] = [];

  for (const item of value) {
    const id = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function normalizeReplyToMessageId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return false;
}

function normalizeHistoryLimit(value: unknown): number {
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(limit, MAX_HISTORY_LIMIT);
}

function normalizeWorkId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeWorkStatus(value: unknown): WorkStatus | null {
  const status = normalizeText(value).toLowerCase();
  switch (status) {
    case "queued":
    case "assigned":
    case "active":
    case "blocked":
    case "done":
      return status;
    default:
      return null;
  }
}

function normalizeWorkAction(
  value: unknown
): UpdateWorkStatusRequest["action"] | null {
  const action = normalizeText(value).toLowerCase();
  switch (action) {
    case "take":
    case "block":
    case "done":
    case "activate":
      return action;
    default:
      return null;
  }
}

function deriveWorkTitle(summary: string, rawTitle: unknown): string {
  const explicitTitle = normalizeText(rawTitle);
  if (explicitTitle) {
    return explicitTitle.slice(0, 120);
  }

  const firstLine = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return (firstLine ?? summary).slice(0, 120);
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

function getAgentCountsMap(): Map<string, AgentCountRow> {
  const rows = selectMessageCountsByAgent.all() as AgentCountRow[];
  return new Map(rows.map((row) => [row.agent_id, row]));
}

function toAgent(row: AgentRow, counts?: AgentCountRow): Agent {
  return {
    id: row.id,
    pid: row.pid ?? null,
    name: row.name,
    kind: row.kind,
    transport: row.transport,
    cwd: row.cwd ?? null,
    git_root: row.git_root ?? null,
    tty: row.tty ?? null,
    summary: row.summary,
    capabilities: parseJsonArray(row.capabilities),
    metadata: parseJsonObject(row.metadata),
    unread_count: normalizeCount(counts?.unread_count),
    undelivered_count: normalizeCount(counts?.undelivered_count),
    delivered_unseen_count: normalizeCount(counts?.delivered_unseen_count),
    surfaced_unseen_count: normalizeCount(counts?.surfaced_unseen_count),
    registered_at: row.registered_at,
    last_seen: row.last_seen,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    text: row.text,
    sent_at: row.sent_at,
    conversation_id: row.conversation_id,
    reply_to_message_id: row.reply_to_message_id ?? null,
    delivered: row.delivered === 1,
    delivered_at: row.delivered_at ?? null,
    surfaced_at: row.surfaced_at ?? null,
    opened_at: row.opened_at ?? null,
    seen_at: row.seen_at ?? null,
  };
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    conversation_id: row.conversation_id ?? null,
    created_by_id: row.created_by_id,
    owner_id: row.owner_id ?? null,
    status: normalizeWorkStatus(row.status) ?? "assigned",
    blocker_note: row.blocker_note ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toWorkEvent(row: WorkEventRow): WorkEvent {
  return {
    id: row.id,
    work_id: row.work_id,
    actor_id: row.actor_id,
    kind: (normalizeText(row.kind) as WorkEventKind) || "status",
    from_owner_id: row.from_owner_id ?? null,
    to_owner_id: row.to_owner_id ?? null,
    status: row.status ? normalizeWorkStatus(row.status) : null,
    note: row.note ?? null,
    created_at: row.created_at,
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
}

function metadataTextField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function metadataIntegerField(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function findSessionDuplicateAgentId(
  agents: Agent[],
  candidate: {
    pid: number | null;
    name: string;
    kind: string;
    transport: string;
    cwd: string | null;
    git_root: string | null;
    tty: string | null;
    metadata: Record<string, unknown>;
  }
): string | null {
  const parentPid = metadataIntegerField(candidate.metadata, "parent_pid");
  if (parentPid === null) {
    return null;
  }

  const candidateClient = metadataTextField(candidate.metadata, "client");
  const candidateLauncher = metadataTextField(candidate.metadata, "launcher");

  for (const agent of agents) {
    const agentParentPid = metadataIntegerField(agent.metadata, "parent_pid");
    if (agentParentPid === null || agentParentPid !== parentPid) {
      continue;
    }
    if (agent.kind !== candidate.kind || agent.transport !== candidate.transport) {
      continue;
    }
    if ((agent.cwd ?? null) !== candidate.cwd || (agent.git_root ?? null) !== candidate.git_root) {
      continue;
    }
    if ((agent.tty ?? null) !== candidate.tty) {
      continue;
    }
    if (agent.name !== candidate.name) {
      continue;
    }
    if (metadataTextField(agent.metadata, "client") !== candidateClient) {
      continue;
    }
    if (metadataTextField(agent.metadata, "launcher") !== candidateLauncher) {
      continue;
    }
    if (candidate.pid !== null && agent.pid === candidate.pid) {
      continue;
    }
    return agent.id;
  }

  return null;
}

function requireAgentAuth(id: string, authToken: unknown): AgentAuthRow {
  const agent = selectAgentAuthById.get(id) as AgentAuthRow | null;
  if (!agent) {
    throw new BrokerRequestError(404, `Agent ${id} not found`);
  }

  const token = normalizeText(authToken);
  if (!token) {
    throw new BrokerRequestError(401, `Agent ${id} is missing an auth token`);
  }

  if (agent.auth_token !== token) {
    throw new BrokerRequestError(403, `Agent ${id} supplied an invalid auth token`);
  }

  return agent;
}

function requireAuthedAgentRow(id: string, authToken: unknown): AgentRow {
  requireAgentAuth(id, authToken);
  const row = selectAgentRowById.get(id) as AgentRow | null;
  if (!row) {
    throw new BrokerRequestError(404, `Agent ${id} not found`);
  }
  return row;
}

function hasAgentCapability(row: AgentRow, capability: string): boolean {
  return parseJsonArray(row.capabilities).includes(capability);
}

function isWorkAdminAgent(row: AgentRow): boolean {
  return row.kind === "human-operator" || hasAgentCapability(row, "work_admin");
}

function isAgentFresh(agent: Agent): boolean {
  const lastSeen = Date.parse(agent.last_seen);
  return Number.isFinite(lastSeen) && Date.now() - lastSeen <= STALE_AGENT_MS;
}

function isAgentAlive(agent: Agent): boolean {
  if (agent.pid !== null) {
    if (!isPidAlive(agent.pid)) {
      removeAgent(agent.id);
      return false;
    }

    if (isAgentFresh(agent)) {
      return true;
    }

    log(
      `removing stale agent ${agent.id} (${agent.name}) because pid ${agent.pid} is alive but last_seen is older than ${STALE_AGENT_MS}ms`
    );
    removeAgent(agent.id);
    return false;
  }

  if (isAgentFresh(agent)) {
    return true;
  }

  log(
    `removing stale heartbeat-only agent ${agent.id} (${agent.name}) because last_seen is older than ${STALE_AGENT_MS}ms`
  );
  removeAgent(agent.id);
  return false;
}
 
const insertAgent = db.prepare(`
  INSERT INTO agents (
    id, pid, name, kind, transport, cwd, git_root, tty, summary,
    capabilities, metadata, auth_token, registered_at, last_seen
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const selectAgentAuthById = db.prepare(`
  SELECT id, auth_token FROM agents WHERE id = ?
`);

const selectAgentIdByPid = db.prepare(`
  SELECT id FROM agents WHERE pid = ?
`);

const selectMessageRowById = db.prepare(`
  SELECT * FROM messages WHERE id = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (
    from_id, to_id, text, sent_at, conversation_id, reply_to_message_id,
    delivered, delivered_at, surfaced_at, opened_at, seen_at
  )
  VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC, id ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages
  SET delivered = 1, delivered_at = COALESCE(delivered_at, ?)
  WHERE id = ?
`);

const markSurfaced = db.prepare(`
  UPDATE messages
  SET surfaced_at = COALESCE(surfaced_at, ?)
  WHERE id = ? AND to_id = ?
`);

const markOpened = db.prepare(`
  UPDATE messages
  SET
    surfaced_at = COALESCE(surfaced_at, ?),
    opened_at = COALESCE(opened_at, ?)
  WHERE id = ? AND to_id = ?
`);

const markSeen = db.prepare(`
  UPDATE messages
  SET
    surfaced_at = COALESCE(surfaced_at, ?),
    opened_at = COALESCE(opened_at, ?),
    seen_at = COALESCE(seen_at, ?)
  WHERE id = ? AND to_id = ?
`);

const selectMessageCountsByAgent = db.prepare(`
  SELECT
    to_id AS agent_id,
    COALESCE(SUM(CASE WHEN seen_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count,
    COALESCE(SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END), 0) AS undelivered_count,
    COALESCE(SUM(CASE WHEN delivered = 1 AND seen_at IS NULL THEN 1 ELSE 0 END), 0) AS delivered_unseen_count,
    COALESCE(SUM(CASE WHEN surfaced_at IS NOT NULL AND seen_at IS NULL THEN 1 ELSE 0 END), 0) AS surfaced_unseen_count
  FROM messages
  GROUP BY to_id
`);

const selectMessageTotals = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN seen_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_messages,
    COALESCE(SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END), 0) AS undelivered_messages,
    COALESCE(SUM(CASE WHEN surfaced_at IS NOT NULL AND seen_at IS NULL THEN 1 ELSE 0 END), 0) AS surfaced_unseen_messages
  FROM messages
`);

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (
    title, summary, conversation_id, created_by_id, owner_id,
    status, blocker_note, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateWorkItem = db.prepare(`
  UPDATE work_items
  SET owner_id = ?, status = ?, blocker_note = ?, updated_at = ?
  WHERE id = ?
`);

const selectWorkRowById = db.prepare(`
  SELECT * FROM work_items WHERE id = ?
`);

const selectAllWorkRows = db.prepare(`
  SELECT * FROM work_items ORDER BY updated_at DESC, id DESC
`);

const insertWorkEvent = db.prepare(`
  INSERT INTO work_events (
    work_id, actor_id, kind, from_owner_id, to_owner_id, status, note, created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectWorkEventRowsByWorkId = db.prepare(`
  SELECT * FROM work_events WHERE work_id = ? ORDER BY created_at ASC, id ASC
`);

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function cleanStaleAgents() {
  const rows = selectAllAgentRows.all() as AgentRow[];
  for (const row of rows) {
    isAgentAlive(toAgent(row));
  }
}

cleanStaleAgents();
setInterval(cleanStaleAgents, CLEANUP_INTERVAL_MS);

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
  const authToken = generateAuthToken();

  if (pid !== null) {
    const existing = selectAgentIdByPid.get(pid) as { id: string } | null;
    if (existing) {
      removeAgent(existing.id);
    }
  }

  const sessionDuplicateId = findSessionDuplicateAgentId(
    (selectAllAgentRows.all() as AgentRow[]).map((row) => toAgent(row)),
    {
      pid,
      name,
      kind,
      transport,
      cwd,
      git_root: gitRoot,
      tty,
      metadata,
    }
  );
  if (sessionDuplicateId) {
    removeAgent(sessionDuplicateId);
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
    authToken,
    now,
    now
  );

  return { id, auth_token: authToken };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  requireAgentAuth(body.id, body.auth_token);
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  requireAgentAuth(body.id, body.auth_token);
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

  const counts = getAgentCountsMap();
  let agents = rows.map((row) => toAgent(row, counts.get(row.id)));

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

function insertStoredMessage(params: {
  from_id: string;
  to_id: string;
  text: string;
  conversation_id?: string | null;
  reply_to_message_id?: number | null;
}): SendMessageResponse {
  const target = selectAgentRowById.get(params.to_id) as AgentRow | null;
  if (!target) {
    return { ok: false, error: `Agent ${params.to_id} not found` };
  }

  const text = normalizeText(params.text);
  if (!text) {
    return { ok: false, error: "Message text cannot be empty" };
  }

  const replyToMessageId = normalizeReplyToMessageId(params.reply_to_message_id);
  let conversationId = normalizeText(params.conversation_id);

  if (replyToMessageId !== null) {
    const parent = selectMessageRowById.get(replyToMessageId) as MessageRow | null;
    if (!parent) {
      return { ok: false, error: `Reply target message ${replyToMessageId} not found` };
    }

    const participants = new Set([parent.from_id, parent.to_id]);
    if (!participants.has(params.from_id) || !participants.has(params.to_id)) {
      return {
        ok: false,
        error: "Reply participants must match the original conversation",
      };
    }

    if (conversationId && conversationId !== parent.conversation_id) {
      return {
        ok: false,
        error: "conversation_id does not match the reply target conversation",
      };
    }

    conversationId = parent.conversation_id;
  }

  if (!conversationId) {
    conversationId = generateConversationId();
  }

  const sentAt = new Date().toISOString();
  const result = insertMessage.run(
    params.from_id,
    params.to_id,
    text,
    sentAt,
    conversationId,
    replyToMessageId
  );
  const id = normalizeCount(result.lastInsertRowid);

  return {
    ok: true,
    message: {
      id,
      from_id: params.from_id,
      to_id: params.to_id,
      text,
      sent_at: sentAt,
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
      delivered: false,
      delivered_at: null,
      surfaced_at: null,
      opened_at: null,
      seen_at: null,
    },
  };
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  requireAgentAuth(body.from_id, body.auth_token);
  return insertStoredMessage(body);
}

function handleQueueWork(body: QueueWorkRequest): QueueWorkResponse {
  requireAgentAuth(body.agent_id, body.auth_token);

  const summary = normalizeText(body.summary);
  if (!summary) {
    return { ok: false, error: "Work summary cannot be empty" };
  }

  const conversationId = normalizeOptionalText(body.conversation_id);
  const title = deriveWorkTitle(summary, body.title);
  const now = new Date().toISOString();

  const result = insertWorkItem.run(
    title,
    summary,
    conversationId,
    body.agent_id,
    null,
    "queued",
    null,
    now,
    now
  );
  const workId = normalizeCount(result.lastInsertRowid);

  const eventResult = insertWorkEvent.run(
    workId,
    body.agent_id,
    "queue",
    null,
    null,
    "queued",
    summary,
    now
  );

  const work = toWorkItem(selectWorkRowById.get(workId) as WorkItemRow);
  const eventId = normalizeCount(eventResult.lastInsertRowid);
  const event = toWorkEvent(
    (selectWorkEventRowsByWorkId.all(workId) as WorkEventRow[]).find(
      (row) => row.id === eventId
    ) as WorkEventRow
  );

  return { ok: true, work, event };
}

function handleHandoffWork(body: HandoffWorkRequest): HandoffWorkResponse {
  requireAgentAuth(body.agent_id, body.auth_token);

  const target = selectAgentRowById.get(body.to_id) as AgentRow | null;
  if (!target) {
    return { ok: false, error: `Agent ${body.to_id} not found` };
  }

  const summary = normalizeText(body.summary);
  if (!summary) {
    return { ok: false, error: "Work summary cannot be empty" };
  }

  const notifyMessage =
    body.notify_message === undefined ? true : normalizeBoolean(body.notify_message);
  const conversationId =
    normalizeOptionalText(body.conversation_id) ??
    (notifyMessage ? generateConversationId() : null);
  const title = deriveWorkTitle(summary, body.title);
  const now = new Date().toISOString();

  const result = insertWorkItem.run(
    title,
    summary,
    conversationId,
    body.agent_id,
    body.to_id,
    "assigned",
    null,
    now,
    now
  );
  const workId = normalizeCount(result.lastInsertRowid);

  const eventResult = insertWorkEvent.run(
    workId,
    body.agent_id,
    "handoff",
    null,
    body.to_id,
    "assigned",
    summary,
    now
  );

  const work = toWorkItem(
    selectWorkRowById.get(workId) as WorkItemRow
  );
  const eventId = normalizeCount(eventResult.lastInsertRowid);
  const event = toWorkEvent(
    (selectWorkEventRowsByWorkId.all(workId) as WorkEventRow[]).find(
      (row) => row.id === eventId
    ) as WorkEventRow
  );

  let notificationMessage: Message | undefined;
  if (notifyMessage) {
    const sendResult = insertStoredMessage({
      from_id: body.agent_id,
      to_id: body.to_id,
      text: `Handoff #${work.id}: ${work.title}\n${work.summary}`,
      conversation_id: conversationId,
    });

    if (!sendResult.ok || !sendResult.message) {
      return {
        ok: false,
        error: sendResult.error ?? "Failed to send handoff notification",
      };
    }

    notificationMessage = sendResult.message;
  }

  return {
    ok: true,
    work,
    event,
    notification_message: notificationMessage,
  };
}

function handleAssignWork(body: AssignWorkRequest): AssignWorkResponse {
  const actor = requireAuthedAgentRow(body.agent_id, body.auth_token);
  const workId = normalizeWorkId(body.work_id);
  if (workId <= 0) {
    return { ok: false, error: "work_id must be a positive integer" };
  }

  const workRow = selectWorkRowById.get(workId) as WorkItemRow | null;
  if (!workRow) {
    return { ok: false, error: `Work item #${workId} not found` };
  }

  const currentWork = toWorkItem(workRow);
  const targetId = normalizeOptionalText(body.to_id);
  const note = normalizeOptionalText(body.note);
  const isAdmin = isWorkAdminAgent(actor);

  if (
    !isAdmin &&
    currentWork.owner_id !== actor.id &&
    !(currentWork.owner_id === null && currentWork.created_by_id === actor.id)
  ) {
    return {
      ok: false,
      error: `Work item #${workId} is owned by ${currentWork.owner_id ?? "the queue"}. Only the owner, queue creator, or a work admin can reassign it.`,
    };
  }

  if (targetId) {
    const target = selectAgentRowById.get(targetId) as AgentRow | null;
    if (!target) {
      return { ok: false, error: `Agent ${targetId} not found` };
    }
  }

  const nextOwnerId = targetId;
  const nextStatus: WorkStatus = targetId ? "assigned" : "queued";
  const blockerNote = null;
  const now = new Date().toISOString();
  const eventKind: WorkEventKind = targetId ? "assign" : "queue";

  updateWorkItem.run(nextOwnerId, nextStatus, blockerNote, now, workId);
  const eventInsert = insertWorkEvent.run(
    workId,
    actor.id,
    eventKind,
    currentWork.owner_id,
    nextOwnerId,
    nextStatus,
    note,
    now
  );

  const updatedWork = toWorkItem(selectWorkRowById.get(workId) as WorkItemRow);
  const eventId = normalizeCount(eventInsert.lastInsertRowid);
  const updatedEvent = toWorkEvent(
    (selectWorkEventRowsByWorkId.all(workId) as WorkEventRow[]).find(
      (row) => row.id === eventId
    ) as WorkEventRow
  );

  return {
    ok: true,
    work: updatedWork,
    event: updatedEvent,
  };
}

function handleListWork(body: ListWorkRequest): ListWorkResponse {
  requireAgentAuth(body.agent_id, body.auth_token);

  const rows = selectAllWorkRows.all() as WorkItemRow[];
  const requestedStatus = body.status ? normalizeWorkStatus(body.status) : null;
  const requestedOwnerId = normalizeOptionalText(body.owner_id);
  const requestedConversationId = normalizeOptionalText(body.conversation_id);
  const includeDone = normalizeBoolean(body.include_done);
  const limit = normalizeHistoryLimit(body.limit);

  const filtered = rows
    .map(toWorkItem)
    .filter((work) => {
      if (requestedStatus && work.status !== requestedStatus) {
        return false;
      }
      if (requestedOwnerId && work.owner_id !== requestedOwnerId) {
        return false;
      }
      if (requestedConversationId && work.conversation_id !== requestedConversationId) {
        return false;
      }
      if (!includeDone && !requestedStatus && work.status === "done") {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (left.status === "queued" && right.status === "queued") {
        return left.id - right.id;
      }
      return 0;
    })
    .slice(0, limit);

  return { work_items: filtered };
}

function handleGetWork(body: GetWorkRequest): GetWorkResponse {
  requireAgentAuth(body.agent_id, body.auth_token);

  const workId = normalizeWorkId(body.work_id);
  if (workId <= 0) {
    throw new BrokerRequestError(400, "work_id must be a positive integer");
  }

  const workRow = selectWorkRowById.get(workId) as WorkItemRow | null;
  if (!workRow) {
    return { work: null, events: [] };
  }

  const eventRows = selectWorkEventRowsByWorkId.all(workId) as WorkEventRow[];
  return {
    work: toWorkItem(workRow),
    events: eventRows.map(toWorkEvent),
  };
}

function handleUpdateWorkStatus(
  body: UpdateWorkStatusRequest
): UpdateWorkStatusResponse {
  const actor = requireAuthedAgentRow(body.agent_id, body.auth_token);
  const isAdmin = isWorkAdminAgent(actor);

  const workId = normalizeWorkId(body.work_id);
  if (workId <= 0) {
    return { ok: false, error: "work_id must be a positive integer" };
  }

  const action = normalizeWorkAction(body.action);
  if (!action) {
    return { ok: false, error: "Unknown work action" };
  }

  const workRow = selectWorkRowById.get(workId) as WorkItemRow | null;
  if (!workRow) {
    return { ok: false, error: `Work item #${workId} not found` };
  }

  const note = normalizeOptionalText(body.note);
  const now = new Date().toISOString();
  const currentWork = toWorkItem(workRow);

  let nextOwnerId = currentWork.owner_id;
  let nextStatus: WorkStatus = currentWork.status;
  let blockerNote = currentWork.blocker_note;
  let eventKind: WorkEventKind = "status";

  switch (action) {
    case "take":
      if (!isAdmin && currentWork.owner_id !== null && currentWork.owner_id !== body.agent_id) {
        return {
          ok: false,
          error: `Work item #${workId} is owned by ${currentWork.owner_id}. Only the current owner can take it.`,
        };
      }
      nextOwnerId = body.agent_id;
      nextStatus = "active";
      blockerNote = null;
      eventKind = "take";
      break;
    case "block":
      if (!isAdmin && currentWork.owner_id === null) {
        return {
          ok: false,
          error: `Work item #${workId} is unassigned. Take it before blocking it.`,
        };
      }
      if (!isAdmin && currentWork.owner_id !== body.agent_id) {
        return {
          ok: false,
          error: `Work item #${workId} is owned by ${currentWork.owner_id}. Only the current owner can block it.`,
        };
      }
      nextStatus = "blocked";
      blockerNote = note;
      eventKind = "block";
      break;
    case "done":
      if (!isAdmin && currentWork.owner_id === null) {
        return {
          ok: false,
          error: `Work item #${workId} is unassigned. Take it before completing it.`,
        };
      }
      if (!isAdmin && currentWork.owner_id !== body.agent_id) {
        return {
          ok: false,
          error: `Work item #${workId} is owned by ${currentWork.owner_id}. Only the current owner can mark it done.`,
        };
      }
      nextStatus = "done";
      blockerNote = null;
      eventKind = "done";
      break;
    case "activate":
      if (!isAdmin && currentWork.owner_id === null) {
        return {
          ok: false,
          error: `Work item #${workId} is unassigned. Take it before activating it.`,
        };
      }
      if (!isAdmin && currentWork.owner_id !== body.agent_id) {
        return {
          ok: false,
          error: `Work item #${workId} is owned by ${currentWork.owner_id}. Only the current owner can reactivate it.`,
        };
      }
      nextStatus = "active";
      blockerNote = null;
      eventKind = "status";
      break;
  }

  updateWorkItem.run(nextOwnerId, nextStatus, blockerNote, now, workId);
  const eventInsert = insertWorkEvent.run(
    workId,
    body.agent_id,
    eventKind,
    currentWork.owner_id,
    nextOwnerId,
    nextStatus,
    note,
    now
  );

  const updatedWork = toWorkItem(selectWorkRowById.get(workId) as WorkItemRow);
  const eventId = normalizeCount(eventInsert.lastInsertRowid);
  const updatedEvent = toWorkEvent(
    (selectWorkEventRowsByWorkId.all(workId) as WorkEventRow[]).find(
      (row) => row.id === eventId
    ) as WorkEventRow
  );

  return {
    ok: true,
    work: updatedWork,
    event: updatedEvent,
  };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  requireAgentAuth(body.id, body.auth_token);

  const rows = selectUndelivered.all(body.id) as MessageRow[];
  if (rows.length === 0) {
    return { messages: [] };
  }

  const deliveredAt = new Date().toISOString();
  const messages = rows.map((row) => {
    markDelivered.run(deliveredAt, row.id);

    return toMessage({
      ...row,
      delivered: 1,
      delivered_at: row.delivered_at ?? deliveredAt,
    });
  });

  return { messages };
}

function handleMarkMessagesSurfaced(
  body: MarkMessagesSurfacedRequest
): MarkMessagesSurfacedResponse {
  requireAgentAuth(body.id, body.auth_token);

  const ids = normalizeMessageIds(body.message_ids);
  if (ids.length === 0) {
    return { ok: true, updated: 0 };
  }

  const surfacedAt = new Date().toISOString();
  let updated = 0;

  for (const id of ids) {
    const result = markSurfaced.run(surfacedAt, id, body.id);
    updated += normalizeCount(result.changes);
  }

  return { ok: true, updated };
}

function handleAcknowledgeMessages(
  body: AcknowledgeMessagesRequest
): AcknowledgeMessagesResponse {
  requireAgentAuth(body.id, body.auth_token);

  const ids = normalizeMessageIds(body.message_ids);
  if (ids.length === 0) {
    return { ok: true, updated: 0 };
  }

  const seenAt = new Date().toISOString();
  let updated = 0;

  for (const id of ids) {
    const result = markSeen.run(seenAt, seenAt, seenAt, id, body.id);
    updated += normalizeCount(result.changes);
  }

  return { ok: true, updated };
}

function handleMessageHistory(
  body: MessageHistoryRequest
): MessageHistoryResponse {
  requireAgentAuth(body.agent_id, body.auth_token);

  const params: Array<string | number> = [body.agent_id, body.agent_id];
  const clauses = ["(from_id = ? OR to_id = ?)"];

  const withAgentId = normalizeOptionalText(body.with_agent_id);
  if (withAgentId) {
    clauses.push("(from_id = ? OR to_id = ?)");
    params.push(withAgentId, withAgentId);
  }

  const conversationId = normalizeOptionalText(body.conversation_id);
  if (conversationId) {
    clauses.push("conversation_id = ?");
    params.push(conversationId);
  }

  params.push(normalizeHistoryLimit(body.limit));

  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${clauses.join(
        " AND "
      )} ORDER BY sent_at DESC, id DESC LIMIT ?`
    )
    .all(...params) as MessageRow[];

  const shouldMarkOpened = normalizeBoolean(body.mark_opened);
  if (shouldMarkOpened) {
    const openedAt = new Date().toISOString();
    for (const row of rows) {
      if (row.to_id !== body.agent_id) {
        continue;
      }

      const result = markOpened.run(openedAt, openedAt, row.id, body.agent_id);
      if (normalizeCount(result.changes) > 0) {
        row.surfaced_at = row.surfaced_at ?? openedAt;
        row.opened_at = row.opened_at ?? openedAt;
      }
    }
  }

  return {
    messages: rows.reverse().map(toMessage),
  };
}

function handleUnregister(body: UnregisterRequest): void {
  requireAgentAuth(body.id, body.auth_token);
  removeAgent(body.id);
}

function handleRemoveAgentAdmin(
  body: RemoveAgentAdminRequest
): RemoveAgentAdminResponse {
  const actor = requireAuthedAgentRow(body.agent_id, body.auth_token);
  if (!isWorkAdminAgent(actor)) {
    throw new BrokerRequestError(403, `Agent ${body.agent_id} is not allowed to remove agents`);
  }

  const targetId = normalizeText(body.target_id);
  const existing = selectAgentRowById.get(targetId) as AgentRow | null;
  if (!existing) {
    return { ok: true, removed: false };
  }

  removeAgent(targetId);
  return { ok: true, removed: true };
}

function handleHealth(): BrokerHealthResponse {
  const totals = (selectMessageTotals.get() as MessageTotalsRow | null) ?? {
    unread_messages: 0,
    undelivered_messages: 0,
    surfaced_unseen_messages: 0,
  };
  const agents = handleListAgents({ scope: "machine" }).length;

  return {
    status: "ok",
    agents,
    peers: agents,
    unread_messages: normalizeCount(totals.unread_messages),
    undelivered_messages: normalizeCount(totals.undelivered_messages),
    surfaced_unseen_messages: normalizeCount(totals.surfaced_unseen_messages),
    db_path: DB_PATH,
    primary_db_path: PRIMARY_DB_PATH,
    db_fallback: DB_FALLBACK,
    schema_version: getSchemaVersion(),
    stale_agent_ms: STALE_AGENT_MS,
    cleanup_interval_ms: CLEANUP_INTERVAL_MS,
  };
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
        return jsonResponse(handleHealth());
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
        case "/queue-work":
          return jsonResponse(handleQueueWork(body as QueueWorkRequest));
        case "/poll-messages":
          return jsonResponse(handlePollMessages(body as PollMessagesRequest));
        case "/mark-messages-surfaced":
          return jsonResponse(
            handleMarkMessagesSurfaced(body as MarkMessagesSurfacedRequest)
          );
        case "/acknowledge-messages":
          return jsonResponse(
            handleAcknowledgeMessages(body as AcknowledgeMessagesRequest)
          );
        case "/message-history":
          return jsonResponse(handleMessageHistory(body as MessageHistoryRequest));
        case "/handoff-work":
          return jsonResponse(handleHandoffWork(body as HandoffWorkRequest));
        case "/assign-work":
          return jsonResponse(handleAssignWork(body as AssignWorkRequest));
        case "/list-work":
          return jsonResponse(handleListWork(body as ListWorkRequest));
        case "/get-work":
          return jsonResponse(handleGetWork(body as GetWorkRequest));
        case "/update-work-status":
          return jsonResponse(handleUpdateWorkStatus(body as UpdateWorkStatusRequest));
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return jsonResponse({ ok: true });
        case "/admin-remove-agent":
          return jsonResponse(
            handleRemoveAgentAdmin(body as RemoveAgentAdminRequest)
          );
        case "/shutdown":
          setTimeout(() => process.exit(0), 50);
          return jsonResponse({ ok: true });
        default:
          return jsonResponse({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      if (error instanceof BrokerRequestError) {
        return jsonResponse({ error: error.message }, { status: error.status });
      }

      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, { status: 500 });
    }
  },
});

log(
  `listening on 127.0.0.1:${PORT} (db: ${DB_PATH}${DB_FALLBACK ? `; fallback from ${PRIMARY_DB_PATH}` : ""}, schema: ${LATEST_SCHEMA_VERSION}, lock: ${LOCK_PATH})`
);

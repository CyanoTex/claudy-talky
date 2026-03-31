import { basename } from "node:path";
import type {
  Agent,
  ListAgentsRequest,
  RegisterAgentRequest,
  RegisterAgentResponse,
} from "./types.ts";

type LegacyPeer = {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
};

class BrokerApiError extends Error {
  status: number;
  path: string;

  constructor(path: string, status: number, message: string) {
    super(`Broker error (${path}): ${status} ${message}`);
    this.name = "BrokerApiError";
    this.status = status;
    this.path = path;
  }
}

function leafName(cwd: string | null | undefined): string | null {
  if (!cwd) {
    return null;
  }

  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

function toAgent(entry: Agent | LegacyPeer): Agent {
  if ("name" in entry && "kind" in entry && "transport" in entry) {
    return {
      ...entry,
      capabilities: entry.capabilities ?? [],
      metadata: entry.metadata ?? {},
      pid: entry.pid ?? null,
      cwd: entry.cwd ?? null,
      git_root: entry.git_root ?? null,
      tty: entry.tty ?? null,
    };
  }

  const leaf = leafName(entry.cwd);

  return {
    id: entry.id,
    pid: entry.pid ?? null,
    name: leaf ? `Claude Code @ ${leaf}` : `Claude Code ${entry.id}`,
    kind: "claude-code",
    transport: "legacy-broker",
    cwd: entry.cwd ?? null,
    git_root: entry.git_root ?? null,
    tty: entry.tty ?? null,
    summary: entry.summary ?? "",
    capabilities: ["messaging", "directory_scope", "repo_scope", "summary"],
    metadata: { legacyBroker: true },
    registered_at: entry.registered_at,
    last_seen: entry.last_seen,
  };
}

export async function brokerFetch<T>(
  brokerUrl: string,
  path: string,
  body: unknown
): Promise<T> {
  const response = await fetch(`${brokerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new BrokerApiError(path, response.status, message);
  }

  return response.json() as Promise<T>;
}

export async function registerAgentCompatible(
  brokerUrl: string,
  body: RegisterAgentRequest
): Promise<RegisterAgentResponse> {
  try {
    return await brokerFetch<RegisterAgentResponse>(brokerUrl, "/register-agent", body);
  } catch (error) {
    if (!(error instanceof BrokerApiError) || error.status !== 404) {
      throw error;
    }

    const legacyBody = {
      pid: body.pid ?? process.pid,
      cwd: body.cwd ?? process.cwd(),
      git_root: body.git_root ?? null,
      tty: body.tty ?? null,
      summary: body.summary ?? "",
    };

    return brokerFetch<RegisterAgentResponse>(brokerUrl, "/register", legacyBody);
  }
}

export async function listAgentsCompatible(
  brokerUrl: string,
  body: ListAgentsRequest
): Promise<Agent[]> {
  try {
    const agents = await brokerFetch<Array<Agent | LegacyPeer>>(brokerUrl, "/list-agents", body);
    return agents.map(toAgent);
  } catch (error) {
    if (!(error instanceof BrokerApiError) || error.status !== 404) {
      throw error;
    }

    const peers = await brokerFetch<LegacyPeer[]>(brokerUrl, "/list-peers", body);
    let agents = peers.map(toAgent);

    if (body.kind) {
      agents = agents.filter((agent) => agent.kind === body.kind);
    }

    if (body.capability) {
      agents = agents.filter((agent) => agent.capabilities.includes(body.capability as string));
    }

    return agents;
  }
}

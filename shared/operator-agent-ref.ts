import { basename } from "node:path";
import type { Agent } from "./types.ts";

const DUPLICATE_AGENT_MAX_AGE_DELTA_MS = 10_000;

export type AgentRefRecord = {
  agent: Agent;
  ref: string;
  baseRef: string;
  kindLabel: string;
  workspaceLabel: string | null;
  searchTerms: string[];
};

type ResolutionSuccess = {
  ok: true;
  record: AgentRefRecord;
};

type ResolutionFailure = {
  ok: false;
  error: string;
};

export type AgentSelectorResolution = ResolutionSuccess | ResolutionFailure;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function slug(value: string | null | undefined): string | null {
  const normalized = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function workspaceLabel(agent: Agent): string | null {
  const source = agent.git_root ?? agent.cwd;
  if (!source) {
    return null;
  }

  return slug(basename(source));
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "claude-code":
      return "claude";
    case "openai-codex":
      return "codex";
    case "google-gemini":
      return "gemini";
    case "google-antigravity":
      return "antigravity";
    case "human-operator":
      return "operator";
    default:
      return slug(kind) ?? "agent";
  }
}

function duplicateIdentityKey(agent: Agent): string {
  const client = typeof agent.metadata.client === "string" ? normalizeText(agent.metadata.client) : "";
  const launcher = typeof agent.metadata.launcher === "string" ? normalizeText(agent.metadata.launcher) : "";
  return [
    normalizeText(agent.name),
    normalizeText(agent.kind),
    normalizeText(agent.transport),
    normalizeText(agent.cwd),
    normalizeText(agent.git_root),
    normalizeText(agent.tty),
    client,
    launcher,
  ].join("|");
}

function agentLastSeenMs(agent: Agent): number {
  const parsed = Date.parse(agent.last_seen);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function filterLikelyStaleDuplicateAgents(agents: Agent[]): Agent[] {
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = duplicateIdentityKey(agent);
    const grouped = groups.get(key);
    if (grouped) grouped.push(agent);
    else groups.set(key, [agent]);
  }

  const visible: Agent[] = [];
  for (const grouped of groups.values()) {
    if (grouped.length === 1) {
      visible.push(grouped[0]!);
      continue;
    }

    const ordered = [...grouped].sort((left, right) => agentLastSeenMs(right) - agentLastSeenMs(left));
    const newestSeen = agentLastSeenMs(ordered[0]!);
    const kept = ordered.filter((agent) => {
      const delta = newestSeen - agentLastSeenMs(agent);
      return delta <= DUPLICATE_AGENT_MAX_AGE_DELTA_MS;
    });
    visible.push(...(kept.length > 0 ? kept : [ordered[0]!]));
  }

  return visible;
}

function buildSearchTerms(
  agent: Agent,
  ref: string,
  baseRef: string,
  shortKind: string,
  workspace: string | null
): string[] {
  const terms = new Set<string>([
    normalizeText(agent.id),
    normalizeText(agent.name),
    normalizeText(agent.kind),
    normalizeText(ref),
    normalizeText(baseRef),
    shortKind,
  ]);

  if (workspace) {
    terms.add(workspace);
    terms.add(`${shortKind}:${workspace}`);
    terms.add(`${workspace}:${shortKind}`);
    terms.add(`${shortKind} ${workspace}`);
    terms.add(`${workspace} ${shortKind}`);
  }

  const client =
    typeof agent.metadata.client === "string" ? normalizeText(agent.metadata.client) : "";
  if (client) {
    terms.add(client);
  }

  return Array.from(terms).filter(Boolean);
}

export function buildAgentRefRecords(agents: Agent[]): AgentRefRecord[] {
  const orderedAgents = [...agents].sort((left, right) => {
    const leftBase = `${kindLabel(left.kind)}:${workspaceLabel(left) ?? ""}:${left.name}:${left.id}`;
    const rightBase = `${kindLabel(right.kind)}:${workspaceLabel(right) ?? ""}:${right.name}:${right.id}`;
    return leftBase.localeCompare(rightBase);
  });

  const counts = new Map<string, number>();
  const refs: AgentRefRecord[] = [];

  for (const agent of orderedAgents) {
    const shortKind = kindLabel(agent.kind);
    const workspace = workspaceLabel(agent);
    const baseRef = workspace ? `${shortKind}:${workspace}` : shortKind;
    const nextCount = (counts.get(baseRef) ?? 0) + 1;
    counts.set(baseRef, nextCount);

    const ref = nextCount === 1 ? baseRef : `${baseRef}#${nextCount}`;
    refs.push({
      agent,
      ref,
      baseRef,
      kindLabel: shortKind,
      workspaceLabel: workspace,
      searchTerms: buildSearchTerms(agent, ref, baseRef, shortKind, workspace),
    });
  }

  return refs;
}

function matchExact(records: AgentRefRecord[], selector: string): AgentRefRecord[] {
  const normalized = normalizeText(selector);
  return records.filter((record) => record.searchTerms.includes(normalized));
}

function matchContains(records: AgentRefRecord[], selector: string): AgentRefRecord[] {
  const normalized = normalizeText(selector);
  return records.filter((record) =>
    record.searchTerms.some((term) => term.includes(normalized))
  );
}

function formatCandidate(record: AgentRefRecord): string {
  return `${record.ref} (${record.agent.name})`;
}

export function resolveAgentSelector(
  records: AgentRefRecord[],
  selector: string
): AgentSelectorResolution {
  const normalized = normalizeText(selector);
  if (!normalized) {
    return { ok: false, error: "Missing agent selector." };
  }

  const exactMatches = matchExact(records, normalized);
  if (exactMatches.length === 1) {
    return { ok: true, record: exactMatches[0]! };
  }

  if (exactMatches.length > 1) {
    return {
      ok: false,
      error: `Selector "${selector}" is ambiguous. Try one of: ${exactMatches.map(formatCandidate).join(", ")}`,
    };
  }

  const containsMatches = matchContains(records, normalized);
  if (containsMatches.length === 1) {
    return { ok: true, record: containsMatches[0]! };
  }

  if (containsMatches.length > 1) {
    return {
      ok: false,
      error: `Selector "${selector}" matched multiple agents. Try one of: ${containsMatches.map(formatCandidate).join(", ")}`,
    };
  }

  return {
    ok: false,
    error: `No live agent matched "${selector}". Use /agents to inspect available refs.`,
  };
}

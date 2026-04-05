import type { Agent, AgentId } from "./types.ts";

type ParticipantDisplayOptions = {
  selfId?: AgentId | null;
  selfLabel?: string;
  includeSelfId?: boolean;
};

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function displayName(agent: Agent): string {
  const name = agent.name.trim();
  return name.length > 0 ? name : agent.id;
}

export function createParticipantDisplay(
  agents: Iterable<Agent>,
  options: ParticipantDisplayOptions = {}
): (agentId: AgentId) => string {
  const agentsById = new Map<AgentId, Agent>();
  const nameCounts = new Map<string, number>();

  for (const agent of agents) {
    agentsById.set(agent.id, agent);
    const key = normalizeName(agent.name);
    if (!key) {
      continue;
    }
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const selfId = options.selfId ?? null;
  const selfLabel = options.selfLabel?.trim() || "You";

  return (agentId: AgentId): string => {
    if (selfId && agentId === selfId) {
      return options.includeSelfId ? `${selfLabel} (${agentId})` : selfLabel;
    }

    const agent = agentsById.get(agentId);
    if (!agent) {
      return agentId;
    }

    const name = displayName(agent);
    const key = normalizeName(agent.name);
    if (key && (nameCounts.get(key) ?? 0) > 1) {
      return `${name} (${agent.id})`;
    }

    return name;
  };
}

import type { Message } from "./types.ts";

export function resolveRoomParticipantIds(
  messages: Message[],
  myId: string,
  liveAgentIds: Iterable<string>
): string[] {
  const historicalParticipants = Array.from(
    new Set(messages.flatMap((message) => [message.from_id, message.to_id]))
  ).filter((agentId) => agentId !== myId);

  if (historicalParticipants.length === 0) {
    return [];
  }

  const liveAgentIdSet = new Set(liveAgentIds);
  const liveParticipants = historicalParticipants.filter((agentId) =>
    liveAgentIdSet.has(agentId)
  );

  return liveParticipants.length > 0 ? liveParticipants : historicalParticipants;
}

import type { AgentId, WorkEvent, WorkItem } from "./types.ts";

export function workLabel(work: WorkItem): string {
  return `#${work.id} ${work.status}`;
}

export function formatWorkListLine(
  work: WorkItem,
  participantDisplay: (agentId: AgentId) => string
): string {
  const owner =
    work.status === "queued"
      ? "queue"
      : work.owner_id !== null
        ? participantDisplay(work.owner_id)
        : "unassigned";
  return `${workLabel(work)} ${owner} ${work.title}`;
}

export function formatWorkDetailLines(
  work: WorkItem,
  events: WorkEvent[],
  participantDisplay: (agentId: AgentId) => string
): string[] {
  const lines = [
    `Work #${work.id}`,
    `Title: ${work.title}`,
    `Status: ${work.status}`,
    `Created by: ${participantDisplay(work.created_by_id)}`,
    `Owner: ${
      work.status === "queued"
        ? "queue"
        : work.owner_id !== null
          ? participantDisplay(work.owner_id)
          : "unassigned"
    }`,
    `Conversation: ${work.conversation_id ?? "(none)"}`,
    `Created: ${work.created_at}`,
    `Updated: ${work.updated_at}`,
  ];

  if (work.blocker_note) {
    lines.push(`Blocker: ${work.blocker_note}`);
  }

  lines.push("", "Summary:");
  lines.push(...work.summary.split(/\r?\n/));

  if (events.length > 0) {
    lines.push("", "Events:");
    for (const event of events) {
      const actor = participantDisplay(event.actor_id);
      const ownerMove =
        event.to_owner_id !== null
          ? ` -> ${participantDisplay(event.to_owner_id)}`
          : "";
      const note = event.note ? ` | ${event.note}` : "";
      const status = event.status ? ` | ${event.status}` : "";
      lines.push(
        `- [${event.created_at}] ${actor} ${event.kind}${ownerMove}${status}${note}`
      );
    }
  }

  return lines;
}

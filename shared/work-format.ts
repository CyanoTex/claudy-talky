import type { AgentId, WorkEvent, WorkItem } from "./types.ts";

const MAX_LIST_NOTE_LENGTH = 80;

export interface WorkNotificationSummary {
  id: number;
  conversation_id: string;
}

export interface FormatWorkActionResultOptions {
  notificationMessage?: WorkNotificationSummary;
}

export function workLabel(work: WorkItem): string {
  return `#${work.id} ${work.status}`;
}

function parseTimestamp(timestamp: string): Date | null {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAge(timestamp: string, now = new Date()): string {
  const date = parseTimestamp(timestamp);
  if (!date) {
    return "unknown age";
  }

  const elapsedMs = Math.max(0, now.getTime() - date.getTime());
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function truncateInline(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function workOwnerLabel(
  work: WorkItem,
  participantDisplay: (agentId: AgentId) => string
): string {
  if (work.status === "queued") {
    return "queue";
  }
  return work.owner_id !== null ? participantDisplay(work.owner_id) : "unassigned";
}

function workNextStep(work: WorkItem): string {
  switch (work.status) {
    case "queued":
      return "use update_work_status with action take to claim it";
    case "assigned":
      return "owner can take it when work starts";
    case "active":
      return "owner should block it or mark it done when ready";
    case "blocked":
      return "resolve the blocker, then activate or reassign it";
    case "done":
      return "no action needed";
  }
}

export function formatWorkActionResult(
  actionSummary: string,
  work: WorkItem,
  participantDisplay: (agentId: AgentId) => string,
  options: FormatWorkActionResultOptions = {},
  now = new Date()
): string {
  const lines = [
    actionSummary,
    formatWorkListLine(work, participantDisplay, now),
    `Next: ${workNextStep(work)}`,
  ];

  if (options.notificationMessage) {
    lines.push(
      `Notification: message #${options.notificationMessage.id} in ${options.notificationMessage.conversation_id}`
    );
  }

  return lines.join("\n");
}

export function formatWorkListLine(
  work: WorkItem,
  participantDisplay: (agentId: AgentId) => string,
  now = new Date()
): string {
  const metadata = [
    `owner=${workOwnerLabel(work, participantDisplay)}`,
    `updated=${formatAge(work.updated_at, now)}`,
  ];

  if (work.conversation_id) {
    metadata.push(`conversation=${work.conversation_id}`);
  }

  if (work.blocker_note) {
    metadata.push(
      `blocker="${truncateInline(work.blocker_note, MAX_LIST_NOTE_LENGTH)}"`
    );
  }

  return `${workLabel(work)} ${work.title} (${metadata.join(", ")})`;
}

export function formatWorkDetailLines(
  work: WorkItem,
  events: WorkEvent[],
  participantDisplay: (agentId: AgentId) => string,
  now = new Date()
): string[] {
  const lines = [
    `Work #${work.id}`,
    `Title: ${work.title}`,
    `Status: ${work.status}`,
    `Created by: ${participantDisplay(work.created_by_id)}`,
    `Owner: ${workOwnerLabel(work, participantDisplay)}`,
    `Conversation: ${work.conversation_id ?? "(none)"}`,
    `Created: ${work.created_at} (${formatAge(work.created_at, now)})`,
    `Updated: ${work.updated_at} (${formatAge(work.updated_at, now)})`,
    `Next: ${workNextStep(work)}`,
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
        `- [${event.created_at} (${formatAge(event.created_at, now)})] ${actor} ${event.kind}${ownerMove}${status}${note}`
      );
    }
  }

  return lines;
}

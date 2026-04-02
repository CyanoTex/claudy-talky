import type { Message } from "./types.ts";

export type PendingUnreadEntry = {
  messageId: number;
  fromId: string;
  conversationId: string;
};

export function addPendingUnreadEntries(
  current: Map<number, PendingUnreadEntry>,
  entries: PendingUnreadEntry[]
): Map<number, PendingUnreadEntry> {
  if (entries.length === 0) {
    return current;
  }

  const next = new Map(current);
  for (const entry of entries) {
    next.set(entry.messageId, entry);
  }
  return next;
}

export function clearPendingUnreadForMessages(
  current: Map<number, PendingUnreadEntry>,
  myId: string,
  messages: Message[]
): Map<number, PendingUnreadEntry> {
  if (current.size === 0 || messages.length === 0) {
    return current;
  }

  const next = new Map(current);
  for (const message of messages) {
    if (message.to_id !== myId || message.from_id === myId) {
      continue;
    }
    next.delete(message.id);
  }
  return next;
}

export function countPendingUnreadByAgent(
  current: Map<number, PendingUnreadEntry>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of current.values()) {
    counts.set(entry.fromId, (counts.get(entry.fromId) ?? 0) + 1);
  }
  return counts;
}

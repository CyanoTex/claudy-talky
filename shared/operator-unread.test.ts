import { expect, test } from "bun:test";
import {
  addPendingUnreadEntries,
  clearPendingUnreadForAgent,
  clearPendingUnreadForConversation,
  clearPendingUnreadForMessages,
  countPendingUnreadByAgent,
  type PendingUnreadEntry,
} from "./operator-unread.ts";
import type { Message } from "./types.ts";

function entry(messageId: number, fromId: string, conversationId: string): PendingUnreadEntry {
  return { messageId, fromId, conversationId };
}

function message(id: number): Message {
  return {
    id,
    from_id: "claude",
    to_id: "operator",
    text: `message-${id}`,
    sent_at: "2026-04-02T15:00:00.000Z",
    conversation_id: "conv-1",
    reply_to_message_id: null,
    delivered: true,
    delivered_at: null,
    surfaced_at: null,
    opened_at: null,
    seen_at: null,
  };
}

test("counts unread entries by sender", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    entry(1, "claude", "conv-1"),
    entry(2, "claude", "conv-2"),
    entry(3, "codex", "conv-3"),
  ]);

  expect(countPendingUnreadByAgent(pending)).toEqual(new Map([
    ["claude", 2],
    ["codex", 1],
  ]));
});

test("clears all unread entries for an opened DM", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    entry(1, "claude", "conv-a"),
    entry(2, "claude", "conv-b"),
    entry(3, "codex", "conv-c"),
  ]);

  expect(clearPendingUnreadForAgent(pending, "claude")).toEqual(new Map([
    [3, entry(3, "codex", "conv-c")],
  ]));
});

test("clears unread entries for an opened room conversation", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    entry(1, "claude", "room-team"),
    entry(2, "codex", "room-team"),
    entry(3, "gemini", "conv-dm"),
  ]);

  expect(clearPendingUnreadForConversation(pending, "room-team")).toEqual(new Map([
    [3, entry(3, "gemini", "conv-dm")],
  ]));
});

test("clears specific unread entries from loaded history", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    entry(1, "claude", "conv-a"),
    entry(2, "codex", "conv-b"),
  ]);

  expect(clearPendingUnreadForMessages(pending, [message(2)])).toEqual(new Map([
    [1, entry(1, "claude", "conv-a")],
  ]));
});

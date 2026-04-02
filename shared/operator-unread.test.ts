import { expect, test } from "bun:test";
import {
  addPendingUnreadEntries,
  clearPendingUnreadForMessages,
  countPendingUnreadByAgent,
} from "./operator-unread.ts";
import type { Message } from "./types.ts";

function message(overrides: Partial<Message>): Message {
  return {
    id: 1,
    from_id: "from",
    to_id: "me",
    text: "hello",
    sent_at: "2026-04-02T00:00:00.000Z",
    conversation_id: "conv-1",
    reply_to_message_id: null,
    delivered: true,
    delivered_at: null,
    surfaced_at: null,
    opened_at: null,
    seen_at: null,
    ...overrides,
  };
}

test("counts pending unread messages by sender", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    { messageId: 1, fromId: "claude", conversationId: "conv-a" },
    { messageId: 2, fromId: "claude", conversationId: "conv-a" },
    { messageId: 3, fromId: "codex", conversationId: "conv-b" },
  ]);

  expect(countPendingUnreadByAgent(pending)).toEqual(
    new Map([
      ["claude", 2],
      ["codex", 1],
    ])
  );
});

test("clears only inbound unread messages that are present in opened history", () => {
  const pending = addPendingUnreadEntries(new Map(), [
    { messageId: 1, fromId: "claude", conversationId: "conv-a" },
    { messageId: 2, fromId: "claude", conversationId: "conv-b" },
    { messageId: 3, fromId: "codex", conversationId: "conv-c" },
  ]);

  const next = clearPendingUnreadForMessages(pending, "me", [
    message({ id: 2, from_id: "claude", to_id: "me", conversation_id: "conv-b" }),
    message({ id: 99, from_id: "me", to_id: "claude", conversation_id: "conv-b" }),
  ]);

  expect(Array.from(next.keys())).toEqual([1, 3]);
  expect(countPendingUnreadByAgent(next)).toEqual(
    new Map([
      ["claude", 1],
      ["codex", 1],
    ])
  );
});

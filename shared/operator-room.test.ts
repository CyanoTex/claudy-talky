import { expect, test } from "bun:test";
import { resolveRoomParticipantIds } from "./operator-room.ts";
import type { Message } from "./types.ts";

function message(
  id: number,
  from_id: string,
  to_id: string,
  conversation_id = "conv-1"
): Message {
  return {
    id,
    from_id,
    to_id,
    text: `message-${id}`,
    sent_at: `2026-04-02T12:00:0${id}.000Z`,
    conversation_id,
    reply_to_message_id: null,
    delivered: true,
    delivered_at: null,
    surfaced_at: null,
    opened_at: null,
    seen_at: null,
  };
}

test("prefers currently online room participants when rebuilding from history", () => {
  const messages = [
    message(1, "me", "claude"),
    message(2, "claude", "codex"),
    message(3, "antigravity", "me"),
  ];

  expect(resolveRoomParticipantIds(messages, "me", ["claude", "codex"])).toEqual([
    "claude",
    "codex",
  ]);
});

test("falls back to historical participants when no preferred live participants exist", () => {
  const messages = [
    message(1, "me", "claude"),
    message(2, "claude", "antigravity"),
    message(3, "gemini", "me"),
  ];

  expect(resolveRoomParticipantIds(messages, "me", [])).toEqual([
    "claude",
    "antigravity",
    "gemini",
  ]);
});

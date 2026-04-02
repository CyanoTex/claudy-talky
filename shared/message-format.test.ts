import { expect, test } from "bun:test";
import { appendMessageStateLines, conversationIdText } from "./message-format.ts";
import type { Message } from "./types.ts";

test("conversationIdText ignores missing conversation IDs", () => {
  const value = conversationIdText({ conversation_id: undefined as unknown as string });
  expect(value).toBeNull();
});

test("appendMessageStateLines omits undefined thread fields", () => {
  const lines: string[] = [];

  appendMessageStateLines(lines, {
    conversation_id: undefined,
    reply_to_message_id: undefined,
    delivered_at: "2026-04-02T12:00:00.000Z",
    surfaced_at: null,
    opened_at: null,
    seen_at: null,
  } as Partial<Message>);

  expect(lines).toEqual(["Delivered to inbox at 2026-04-02T12:00:00.000Z"]);
});

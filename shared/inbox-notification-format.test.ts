import { expect, test } from "bun:test";
import {
  formatInboxNotification,
  formatInboxNotificationTitle,
  type InboxNotificationEntry,
} from "./inbox-notification-format.ts";

function entry(
  overrides: Partial<InboxNotificationEntry> = {}
): InboxNotificationEntry {
  return {
    message: {
      id: 42,
      from_id: "codex-a",
      text: "Need the investigation report forwarded.",
      conversation_id: "conv-123",
      reply_to_message_id: 7,
      delivered_at: "2026-04-05T02:00:00.000Z",
    },
    sender: {
      kind: "openai-codex",
      summary: "Tracing claude-mem investigation routing",
      cwd: "C:/src/claudy-talky",
    },
    senderLabel: "Codex @ claudy-talky (codex-a)",
    ...overrides,
  };
}

test("formats duplicate sender labels in inbox notifications", () => {
  const text = formatInboxNotification(entry());

  expect(text).toContain(
    "New claudy-talky message from Codex @ claudy-talky (codex-a) (openai-codex)"
  );
  expect(text).toContain("Sender summary: Tracing claude-mem investigation routing");
  expect(text).toContain("Sender cwd: C:/src/claudy-talky");
  expect(text).toContain("Conversation: conv-123");
  expect(text).toContain("Reply to message #7");
});

test("uses the duplicate-aware sender label in desktop notification titles", () => {
  expect(formatInboxNotificationTitle(entry())).toBe(
    "claudy-talky: Codex @ claudy-talky (codex-a)"
  );
});

test("falls back to the sender id when agent details are unavailable", () => {
  const text = formatInboxNotification(
    entry({
      sender: null,
      senderLabel: "unknown-agent",
      message: {
        id: 43,
        from_id: "unknown-agent",
        text: "Fallback path",
        conversation_id: "conv-456",
        reply_to_message_id: null,
        delivered_at: null,
      },
    })
  );

  expect(text).toContain("New claudy-talky message from unknown-agent");
  expect(text).not.toContain("Sender summary:");
  expect(text).not.toContain("Sender cwd:");
  expect(formatInboxNotificationTitle(entry({ sender: null, senderLabel: "unknown-agent" }))).toBe(
    "claudy-talky: unknown-agent"
  );
});

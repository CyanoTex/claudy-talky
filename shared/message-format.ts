import type { Message } from "./types.ts";

export function conversationIdText(
  message: Pick<Message, "conversation_id">
): string | null {
  const value = message.conversation_id;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function replyToMessageIdValue(
  message: Pick<Message, "reply_to_message_id">
): number | null {
  const value = message.reply_to_message_id;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

export function appendMessageStateLines(
  lines: string[],
  message: Partial<Message>
): void {
  const conversationId = conversationIdText(
    message as Pick<Message, "conversation_id">
  );
  if (conversationId) {
    lines.push(`Conversation: ${conversationId}`);
  }

  const replyToMessageId = replyToMessageIdValue(
    message as Pick<Message, "reply_to_message_id">
  );
  if (replyToMessageId !== null) {
    lines.push(`Reply to message #${replyToMessageId}`);
  }

  if (message.delivered_at) {
    lines.push(`Delivered to inbox at ${message.delivered_at}`);
  }

  if (message.surfaced_at) {
    lines.push(`Surfaced to client at ${message.surfaced_at}`);
  }

  if (message.opened_at) {
    lines.push(`Opened in inbox/history at ${message.opened_at}`);
  }

  if (message.seen_at) {
    lines.push(`Marked seen at ${message.seen_at}`);
  }
}

import {
  conversationIdText,
  replyToMessageIdValue,
} from "./message-format.ts";
import type { Agent, Message } from "./types.ts";

export type InboxNotificationEntry = {
  message: Pick<
    Message,
    | "id"
    | "from_id"
    | "text"
    | "conversation_id"
    | "reply_to_message_id"
    | "delivered_at"
  >;
  sender: Pick<Agent, "kind" | "summary" | "cwd"> | null;
  senderLabel: string;
};

export function formatInboxNotification(entry: InboxNotificationEntry): string {
  const { message, sender, senderLabel } = entry;
  const header = sender
    ? `New claudy-talky message from ${senderLabel} (${sender.kind})`
    : `New claudy-talky message from ${senderLabel}`;
  const details: string[] = [header, "", message.text];

  details.push("", `Message ID: ${message.id}`);
  const conversationId = conversationIdText(message);
  if (conversationId) {
    details.push("", `Conversation: ${conversationId}`);
  }

  const replyToMessageId = replyToMessageIdValue(message);
  if (replyToMessageId !== null) {
    details.push(`Reply to message #${replyToMessageId}`);
  }

  if (sender?.summary) {
    details.push("", `Sender summary: ${sender.summary}`);
  }

  if (sender?.cwd) {
    details.push(`Sender cwd: ${sender.cwd}`);
  }

  if (message.delivered_at) {
    details.push(`Delivered to your inbox at: ${message.delivered_at}`);
  }

  details.push(
    'Use `check_messages` to mark unread notes as seen, or `message_history` to revisit the thread later.'
  );
  return details.join("\n");
}

export function formatInboxNotificationTitle(
  entry: Pick<InboxNotificationEntry, "senderLabel">
): string {
  return `claudy-talky: ${entry.senderLabel}`;
}

import type { Agent } from "./types.ts";

function metadataText(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataList(
  metadata: Record<string, unknown>,
  key: string
): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function formatAgent(agent: Agent): string {
  const parts = [
    `ID: ${agent.id}`,
    `Name: ${agent.name}`,
    `Kind: ${agent.kind}`,
    `Transport: ${agent.transport}`,
  ];

  if (agent.cwd) {
    parts.push(`CWD: ${agent.cwd}`);
  }
  if (agent.git_root) {
    parts.push(`Repo: ${agent.git_root}`);
  }
  if (agent.capabilities.length > 0) {
    parts.push(`Capabilities: ${agent.capabilities.join(", ")}`);
  }
  if (agent.summary) {
    parts.push(`Summary: ${agent.summary}`);
  }
  if (agent.tty) {
    parts.push(`TTY: ${agent.tty}`);
  }

  if (
    agent.unread_count > 0 ||
    agent.surfaced_unseen_count > 0 ||
    agent.delivered_unseen_count > 0 ||
    agent.undelivered_count > 0
  ) {
    const inboxParts = [`${agent.unread_count} unread total`];
    if (agent.surfaced_unseen_count > 0) {
      inboxParts.push(`${agent.surfaced_unseen_count} surfaced`);
    }
    if (agent.delivered_unseen_count > 0) {
      inboxParts.push(`${agent.delivered_unseen_count} delivered`);
    }
    if (agent.undelivered_count > 0) {
      inboxParts.push(`${agent.undelivered_count} pending delivery`);
    }
    parts.push(`Inbox: ${inboxParts.join(", ")}`);
  }

  const client = metadataText(agent.metadata, "client");
  const clientVersion = metadataText(agent.metadata, "client_version");
  const launcher = metadataText(agent.metadata, "launcher");
  const adapter = metadataText(agent.metadata, "adapter");
  const adapterVersion = metadataText(agent.metadata, "adapter_version");
  const workspaceSource = metadataText(agent.metadata, "workspace_source");
  const notificationStyles = metadataList(agent.metadata, "notification_styles");

  if (client) {
    parts.push(
      `Client: ${client}${clientVersion ? ` ${clientVersion}` : ""}${adapter ? ` via ${adapter}${adapterVersion ? ` ${adapterVersion}` : ""}` : ""}`
    );
  }
  if (launcher) {
    parts.push(`Launcher: ${launcher}`);
  }
  if (notificationStyles.length > 0) {
    parts.push(`Notifications: ${notificationStyles.join(", ")}`);
  }
  if (workspaceSource) {
    parts.push(`Workspace source: ${workspaceSource}`);
  }

  parts.push(`Last seen: ${agent.last_seen}`);
  return parts.join("\n  ");
}

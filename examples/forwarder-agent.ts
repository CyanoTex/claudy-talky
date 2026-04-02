#!/usr/bin/env bun

import { cwd, exit } from "node:process";
import { getBrokerPort } from "../shared/config.ts";
import {
  brokerFetch,
  listAgentsCompatible,
  registerAgentCompatible,
} from "../shared/broker-compat.ts";
import type {
  Agent,
  AcknowledgeMessagesResponse,
  PollMessagesResponse,
  SendMessageResponse,
  UnregisterRequest,
} from "../shared/types.ts";

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const AGENT_NAME = process.env.AGENT_NAME ?? "Claudy-Talky Codex";
const AGENT_KIND = process.env.AGENT_KIND ?? "codex-forwarder";
const AGENT_SUMMARY =
  process.env.AGENT_SUMMARY ?? "Forward claudy-talky issues to me";
const TARGET_KIND = process.env.TARGET_KIND ?? "openai-codex";
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;

let agentId: string | null = null;
let authToken: string | null = null;
let repoCwd = cwd();
const forwardedIds = new Set<number>();

function log(message: string) {
  console.log(`[${AGENT_NAME}] ${message}`);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return brokerFetch<T>(BROKER_URL, path, body);
}

async function register() {
  const registration = await registerAgentCompatible(BROKER_URL, {
    name: AGENT_NAME,
    kind: AGENT_KIND,
    transport: "http-poll",
    cwd: repoCwd,
    summary: AGENT_SUMMARY,
    capabilities: [
      "messaging",
      "polling",
      "heartbeat",
      "message_receipts",
      "repo_scope",
      "summary",
    ],
    metadata: {
      client: AGENT_NAME,
      adapter: "claudy-talky-forwarder",
      adapter_version: "0.4.0",
      notification_styles: ["manual-check"],
      runtime: `bun-${Bun.version}`,
      parent_pid: process.ppid,
      target_kind: TARGET_KIND,
    },
  });

  agentId = registration.id;
  authToken = registration.auth_token ?? null;
  log(`Registered as ${agentId}`);
}

async function heartbeat() {
  if (!agentId) {
    return;
  }

  await post("/heartbeat", {
    id: agentId,
    auth_token: authToken ?? undefined,
  });
}

async function listTargets(): Promise<Agent[]> {
  if (!agentId) {
    return [];
  }

  const agents = await listAgentsCompatible(BROKER_URL, {
    scope: "repo",
    cwd: repoCwd,
    kind: TARGET_KIND,
    exclude_id: agentId,
  });

  return agents.filter((agent) => agent.id !== agentId);
}

async function listVisibleAgents(): Promise<Map<string, Agent>> {
  if (!agentId) {
    return new Map();
  }

  const agents = await listAgentsCompatible(BROKER_URL, {
    scope: "repo",
    cwd: repoCwd,
    exclude_id: agentId,
  });

  return new Map(agents.map((agent) => [agent.id, agent]));
}

async function acknowledge(messageIds: number[]) {
  if (!agentId || messageIds.length === 0) {
    return;
  }

  await post<AcknowledgeMessagesResponse>("/acknowledge-messages", {
    id: agentId,
    message_ids: messageIds,
    auth_token: authToken ?? undefined,
  });
}

function forwardText(sender: Agent | undefined, originalText: string): string {
  const senderLabel = sender ? `${sender.name} (${sender.id})` : "unknown sender";
  return `Forwarded from ${senderLabel}:\n\n${originalText}`;
}

async function forwardMessage(
  messageId: number,
  fromId: string,
  text: string,
  agentMap: Map<string, Agent>
): Promise<boolean> {
  if (!agentId) {
    return false;
  }

  const sender = agentMap.get(fromId);
  if (sender?.kind === TARGET_KIND) {
    log(`Ignoring message #${messageId} from ${sender.name} to avoid forwarding loops.`);
    return true;
  }

  const targets = await listTargets();
  if (targets.length === 0) {
    log(`No live ${TARGET_KIND} targets for message #${messageId}; leaving it queued.`);
    return false;
  }

  const payload = forwardText(sender, text);
  const results = await Promise.allSettled(
    targets.map((target) =>
      post<SendMessageResponse>("/send-message", {
        from_id: agentId,
        to_id: target.id,
        text: payload,
        auth_token: authToken ?? undefined,
      })
    )
  );

  let sentCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.ok) {
      sentCount += 1;
    }
  }

  if (sentCount === 0) {
    log(`Forwarding message #${messageId} failed for all ${targets.length} target(s).`);
    return false;
  }

  log(`Forwarded message #${messageId} to ${sentCount} ${TARGET_KIND} target(s).`);
  return true;
}

async function poll() {
  if (!agentId) {
    return;
  }

  const response = await post<PollMessagesResponse>("/poll-messages", {
    id: agentId,
    auth_token: authToken ?? undefined,
  });

  if (response.messages.length === 0) {
    return;
  }

  const agentMap = await listVisibleAgents();
  const acknowledged: number[] = [];

  for (const message of response.messages) {
    if (forwardedIds.has(message.id)) {
      acknowledged.push(message.id);
      continue;
    }

    const forwarded = await forwardMessage(
      message.id,
      message.from_id,
      message.text,
      agentMap
    );

    if (!forwarded) {
      continue;
    }

    forwardedIds.add(message.id);
    acknowledged.push(message.id);
  }

  await acknowledge(acknowledged);
}

async function unregister() {
  if (!agentId) {
    return;
  }

  try {
    await post<{ ok: boolean }>("/unregister", {
      id: agentId,
      auth_token: authToken ?? undefined,
    } satisfies UnregisterRequest);
    log("Unregistered");
  } catch {
    // Best effort.
  }
}

async function main() {
  await register();

  const pollTimer = setInterval(() => {
    poll().catch((error) =>
      log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  }, POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) =>
      log(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    await unregister();
    exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});

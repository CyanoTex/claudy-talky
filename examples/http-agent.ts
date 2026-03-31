#!/usr/bin/env bun
/**
 * Example non-Claude agent for claudy-talky.
 *
 * This agent connects over plain HTTP, heartbeats, polls for messages,
 * and replies with a simple acknowledgement. It demonstrates the minimum
 * contract needed for any local agent runtime to join the network.
 *
 * Usage:
 *   AGENT_NAME="Echo Bot" bun examples/http-agent.ts
 */

import { getBrokerPort } from "../shared/config.ts";

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const AGENT_NAME = process.env.AGENT_NAME ?? "Echo Bot";
const AGENT_KIND = process.env.AGENT_KIND ?? "custom-http-agent";
const AGENT_SUMMARY =
  process.env.AGENT_SUMMARY ??
  "A simple HTTP agent that acknowledges every message it receives.";

let agentId: string | null = null;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function log(message: string) {
  console.log(`[${AGENT_NAME}] ${message}`);
}

async function register() {
  const registration = await brokerFetch<{ id: string }>("/register-agent", {
    name: AGENT_NAME,
    kind: AGENT_KIND,
    transport: "http-poll",
    summary: AGENT_SUMMARY,
    capabilities: ["messaging", "polling", "heartbeat"],
    metadata: {
      example: true,
      runtime: `bun-${Bun.version}`,
    },
  });

  agentId = registration.id;
  log(`Registered as ${agentId}`);
}

async function heartbeat() {
  if (!agentId) {
    return;
  }

  await brokerFetch("/heartbeat", { id: agentId });
}

async function poll() {
  if (!agentId) {
    return;
  }

  const result = await brokerFetch<{
    messages: Array<{ from_id: string; text: string; sent_at: string }>;
  }>("/poll-messages", {
    id: agentId,
  });

  for (const message of result.messages) {
    log(`Received from ${message.from_id} at ${message.sent_at}: ${message.text}`);

    try {
      await brokerFetch("/send-message", {
        from_id: agentId,
        to_id: message.from_id,
        text: `${AGENT_NAME} received: ${message.text}`,
      });
    } catch (error) {
      log(
        `Reply failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function unregister() {
  if (!agentId) {
    return;
  }

  try {
    await brokerFetch("/unregister", { id: agentId });
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
  }, 1000);

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) =>
      log(
        `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }, 15_000);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    await unregister();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

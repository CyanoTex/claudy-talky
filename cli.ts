#!/usr/bin/env bun
/**
 * claudy-talky CLI
 *
 * Utility commands for managing the broker and inspecting connected agents.
 *
 * Usage:
 *   bun cli.ts status            Show broker status and connected agents
 *   bun cli.ts agents            List all agents
 *   bun cli.ts peers             Alias for agents
 *   bun cli.ts send <id> <msg>   Send a message to an agent
 *   bun cli.ts kill-broker       Stop the broker daemon
 */

import { getBrokerPort } from "./shared/config.ts";

type Agent = {
  id: string;
  name: string;
  kind: string;
  transport: string;
  pid: number | null;
  cwd: string | null;
  git_root: string | null;
  tty: string | null;
  summary: string;
  capabilities: string[];
  last_seen: string;
};

const BROKER_PORT = getBrokerPort();
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const options: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};

  const response = await fetch(`${BROKER_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(3000),
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function printAgent(agent: Agent) {
  console.log(`${agent.id}  ${agent.name}`);
  console.log(`  Kind: ${agent.kind}`);
  console.log(`  Transport: ${agent.transport}`);
  if (agent.pid !== null) {
    console.log(`  PID: ${agent.pid}`);
  }
  if (agent.cwd) {
    console.log(`  CWD: ${agent.cwd}`);
  }
  if (agent.summary) {
    console.log(`  Summary: ${agent.summary}`);
  }
  if (agent.capabilities.length > 0) {
    console.log(`  Capabilities: ${agent.capabilities.join(", ")}`);
  }
  console.log(`  Last seen: ${agent.last_seen}`);
}

const command = process.argv[2];

switch (command) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; agents: number }>("/health");
      console.log(`Broker: ${health.status} (${health.agents} agent(s) connected)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.agents > 0) {
        const agents = await brokerFetch<Agent[]>("/list-agents", {
          scope: "machine",
        });

        console.log("\nAgents:");
        for (const agent of agents) {
          printAgent(agent);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "agents":
  case "peers": {
    try {
      const agents = await brokerFetch<Agent[]>("/list-agents", {
        scope: "machine",
      });

      if (agents.length === 0) {
        console.log("No agents connected.");
      } else {
        for (const agent of agents) {
          printAgent(agent);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const message = process.argv.slice(4).join(" ");

    if (!toId || !message) {
      console.error("Usage: bun cli.ts send <agent-id> <message>");
      process.exit(1);
    }

    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>(
        "/send-message",
        {
          from_id: "cli",
          to_id: toId,
          text: message,
        }
      );

      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      await brokerFetch<{ ok: boolean }>("/shutdown", {});
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claudy-talky CLI

Usage:
  bun cli.ts status            Show broker status and connected agents
  bun cli.ts agents            List all agents
  bun cli.ts peers             Alias for agents
  bun cli.ts send <id> <msg>   Send a message to an agent
  bun cli.ts kill-broker       Stop the broker daemon`);
}

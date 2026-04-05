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
 *   bun cli.ts enable-channel    Show how to enable instant message delivery
 */

import { formatAgent } from "./shared/agent-format.ts";
import { getBrokerPort } from "./shared/config.ts";
import type {
  Agent,
  BrokerHealthResponse,
  RegisterAgentResponse,
  SendMessageResponse,
  UnregisterRequest,
} from "./shared/types.ts";

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
  console.log(formatAgent(agent));
}

async function registerCliAgent(): Promise<RegisterAgentResponse> {
  return brokerFetch<RegisterAgentResponse>("/register-agent", {
    name: "claudy-talky CLI",
    kind: "cli-client",
    transport: "cli",
    summary: "Ephemeral CLI operator session.",
    capabilities: ["messaging", "ephemeral"],
    metadata: {
      client: "claudy-talky CLI",
      adapter: "claudy-talky",
      notification_styles: ["stdout"],
    },
  });
}

const command = process.argv[2];

switch (command) {
  case "status": {
    try {
      const health = await brokerFetch<BrokerHealthResponse>("/health");
      console.log(`Broker: ${health.status} (${health.agents} agent(s) connected)`);
      console.log(`URL: ${BROKER_URL}`);
      console.log(`Schema: v${health.schema_version}`);
      console.log(`DB: ${health.db_path}${health.db_fallback ? ` (fallback from ${health.primary_db_path})` : ""}`);
      console.log(
        `Cleanup: stale after ${health.stale_agent_ms}ms, sweep every ${health.cleanup_interval_ms}ms`
      );
      console.log(
        `Messages: ${health.unread_messages} unread, ${health.undelivered_messages} pending delivery`
      );

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

    let cliAgent: RegisterAgentResponse | null = null;

    try {
      cliAgent = await registerCliAgent();
      const result = await brokerFetch<SendMessageResponse>("/send-message", {
        from_id: cliAgent.id,
        to_id: toId,
        text: message,
        auth_token: cliAgent.auth_token,
      });

      if (result.ok) {
        console.log(
          `Message sent to ${toId}${result.message ? ` (message #${result.message.id})` : ""}`
        );
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (cliAgent) {
        try {
          await brokerFetch<{ ok: boolean }>("/unregister", {
            id: cliAgent.id,
            auth_token: cliAgent.auth_token,
          } satisfies UnregisterRequest);
        } catch {
          // Best effort.
        }
      }
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

  case "enable-channel": {
    const channelFlag = "--dangerously-load-development-channels";
    const channelTarget = "plugin:claudy-talky@claudy-talky-marketplace";

    console.log(`Channel activation for claudy-talky

Claude Code's channel protocol enables instant message delivery —
messages from other agents interrupt your session as they arrive,
without waiting for check_messages.

The claudy-talky marketplace plugin already declares channel support,
but channels are a research preview feature and must be enabled per
session via a CLI flag.

Launch Claude Code with:

  claude ${channelFlag} ${channelTarget}

If you installed claudy-talky via 'claude mcp add' instead of the
marketplace, use:

  claude ${channelFlag} server:claudy-talky

To make this your default, add a shell alias:

  alias claude-talky='claude ${channelFlag} ${channelTarget}'

Note: There is no persistent channel config in settings.json yet.
This flag must be passed on every launch until channels graduate
from research preview.`);
    break;
  }

  default:
    console.log(`claudy-talky CLI

Usage:
  bun cli.ts status            Show broker status and connected agents
  bun cli.ts agents            List all agents
  bun cli.ts peers             Alias for agents
  bun cli.ts send <id> <msg>   Send a message to an agent
  bun cli.ts kill-broker       Stop the broker daemon
  bun cli.ts enable-channel    Show how to enable instant message delivery`);
}

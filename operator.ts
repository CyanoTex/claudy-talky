#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { basename } from "node:path";
import { cwd, exit, stdin, stdout } from "node:process";
import {
  acknowledgeMessagesCompatible,
  brokerFetch,
  listAgentsCompatible,
  messageHistoryCompatible,
  registerAgentCompatible,
} from "./shared/broker-compat.ts";
import { getBrokerPort } from "./shared/config.ts";
import { appendMessageStateLines } from "./shared/message-format.ts";
import {
  buildAgentRefRecords,
  resolveAgentSelector,
  type AgentRefRecord,
} from "./shared/operator-agent-ref.ts";
import {
  operatorHelpText,
  parseOperatorInput,
  type OperatorCommand,
} from "./shared/operator-command.ts";
import type {
  Agent,
  Message,
  MessageHistoryRequest,
  PollMessagesResponse,
  SendMessageResponse,
  UnregisterRequest,
} from "./shared/types.ts";

type OperatorRoom = {
  name: string;
  conversationId: string;
  participantIds: string[];
};

type OperatorContext =
  | { kind: "none" }
  | { kind: "dm"; agentId: string }
  | { kind: "room"; conversationId: string };

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const ROOM_HISTORY_SCAN_LIMIT = 100;

let myId = "";
let authToken: string | undefined;
let agentCache = new Map<string, Agent>();
let agentRefRecords: AgentRefRecord[] = [];
const roomsByConversationId = new Map<string, OperatorRoom>();
const dmConversationByAgentId = new Map<string, string>();
let currentContext: OperatorContext = { kind: "none" };
let lastIncomingSenderId: string | null = null;
let shuttingDown = false;
let pollInFlight = false;

const rl = createInterface({
  input: stdin,
  output: stdout,
  terminal: true,
});

function nowText(): string {
  return new Date().toISOString();
}

function promptLabel(): string {
  if (currentContext.kind === "dm") {
    return `dm:${participantRef(currentContext.agentId) ?? currentContext.agentId}> `;
  }

  if (currentContext.kind === "room") {
    const room = roomsByConversationId.get(currentContext.conversationId);
    return `room:${room?.name ?? currentContext.conversationId}> `;
  }

  return "operator> ";
}

function refreshPrompt(): void {
  rl.setPrompt(promptLabel());
  rl.prompt(true);
}

function printBlock(lines: string[]): void {
  console.log(lines.join("\n"));
  refreshPrompt();
}

function printInfo(message: string): void {
  printBlock([message]);
}

function compactAgent(agent: Agent): string {
  const record = agentRefRecords.find((entry) => entry.agent.id === agent.id);
  const unreadParts: string[] = [];
  if (agent.unread_count > 0) {
    unreadParts.push(`${agent.unread_count} unread`);
  }
  if (agent.undelivered_count > 0) {
    unreadParts.push(`${agent.undelivered_count} pending`);
  }
  if (agent.surfaced_unseen_count > 0) {
    unreadParts.push(`${agent.surfaced_unseen_count} surfaced`);
  }

  const parts = [
    record?.ref ?? agent.id,
    "|",
    agent.name,
    `[${agent.kind}]`,
    `(id:${agent.id})`,
  ];
  if (unreadParts.length > 0) {
    parts.push(`{${unreadParts.join(", ")}}`);
  }
  if (agent.summary) {
    parts.push(`- ${agent.summary}`);
  }
  return parts.join(" ");
}

function roomConversationId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `room-${slug || "chat"}-${suffix}`;
}

function participantName(agentId: string): string {
  return agentCache.get(agentId)?.name ?? agentId;
}

function participantRef(agentId: string): string | null {
  return agentRefRecords.find((record) => record.agent.id === agentId)?.ref ?? null;
}

function participantDisplay(agentId: string): string {
  const ref = participantRef(agentId);
  const name = participantName(agentId);
  return ref ? `${ref} | ${name}` : name;
}

function roomForConversation(conversationId: string): OperatorRoom | undefined {
  return roomsByConversationId.get(conversationId);
}

function rememberDmConversation(agentId: string, conversationId: string | null | undefined): void {
  if (!conversationId) {
    return;
  }

  dmConversationByAgentId.set(agentId, conversationId);
}

function noteMessageConversation(message: Message): void {
  if (message.from_id === myId && message.to_id !== myId) {
    rememberDmConversation(message.to_id, message.conversation_id);
    return;
  }

  if (message.to_id === myId && message.from_id !== myId) {
    lastIncomingSenderId = message.from_id;
    rememberDmConversation(message.from_id, message.conversation_id);
  }
}

function formatMessageForHistory(message: Message): string {
  const room = roomForConversation(message.conversation_id);
  const lines = [
    `[${message.sent_at}] #${message.id} ${participantDisplay(message.from_id)} -> ${participantDisplay(message.to_id)}${
      room ? ` [room:${room.name}]` : ""
    }`,
    ...message.text.split(/\r?\n/).map((line) => `  ${line}`),
  ];

  appendMessageStateLines(lines, message);
  return lines.join("\n");
}

function formatIncomingMessage(message: Message): string {
  const room = roomForConversation(message.conversation_id);
  const header = room
    ? `[${nowText()}] room:${room.name} ${participantDisplay(message.from_id)} -> you (#${message.id})`
    : `[${nowText()}] ${participantDisplay(message.from_id)} -> you (#${message.id})`;

  return [header, ...message.text.split(/\r?\n/).map((line) => `  ${line}`)].join("\n");
}

async function refreshAgents(): Promise<Agent[]> {
  const agents = await listAgentsCompatible(BROKER_URL, {
    scope: "machine",
    exclude_id: myId || undefined,
  });

  agentCache = new Map(agents.map((agent) => [agent.id, agent]));
  agentRefRecords = buildAgentRefRecords(agents);
  return agents;
}

async function registerOperator(): Promise<void> {
  const workspaceName = basename(cwd()) || "workspace";
  const response = await registerAgentCompatible(BROKER_URL, {
    name: `Human Operator @ ${workspaceName}`,
    kind: "human-operator",
    transport: "cli-chat",
    cwd: cwd(),
    summary: "Interactive human operator session.",
    capabilities: ["messaging", "message_history", "operator_console"],
    metadata: {
      client: "claudy-talky Operator",
      launcher: "bun",
      adapter: "claudy-talky",
      workspace_source: "process.cwd",
      notification_styles: ["stdout"],
    },
  });

  myId = response.id;
  authToken = response.auth_token;
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  return brokerFetch<T>(BROKER_URL, path, body);
}

async function sendDirectMessage(agentId: string, text: string): Promise<void> {
  const conversationId = dmConversationByAgentId.get(agentId);
  const result = await brokerPost<SendMessageResponse>("/send-message", {
    from_id: myId,
    to_id: agentId,
    text,
    conversation_id: conversationId,
    auth_token: authToken,
  });

  if (!result.ok || !result.message) {
    throw new Error(result.error ?? `Failed to send message to ${agentId}`);
  }

  rememberDmConversation(agentId, result.message.conversation_id);

  printBlock([
    `[${result.message.sent_at}] you -> ${participantDisplay(agentId)} (#${result.message.id})`,
    ...text.split(/\r?\n/).map((line) => `  ${line}`),
  ]);
}

async function sendRoomMessage(room: OperatorRoom, text: string): Promise<void> {
  const liveAgents = await refreshAgents();
  const liveIds = new Set(liveAgents.map((agent) => agent.id));
  const targets = room.participantIds.filter((agentId) => liveIds.has(agentId));
  const skipped = room.participantIds.filter((agentId) => !liveIds.has(agentId));

  if (targets.length === 0) {
    throw new Error(`Room ${room.name} has no live participants`);
  }

  const settled = await Promise.allSettled(
    targets.map((agentId) =>
      brokerPost<SendMessageResponse>("/send-message", {
        from_id: myId,
        to_id: agentId,
        text,
        conversation_id: room.conversationId,
        auth_token: authToken,
      })
    )
  );

  const sentIds: number[] = [];
  const failures: string[] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const targetId = targets[index];
    if (outcome?.status === "fulfilled" && outcome.value.ok && outcome.value.message) {
      sentIds.push(outcome.value.message.id);
      continue;
    }

    if (outcome?.status === "fulfilled") {
      failures.push(`${targetId}: ${outcome.value.error ?? "send failed"}`);
      continue;
    }

    failures.push(`${targetId}: ${outcome?.reason instanceof Error ? outcome.reason.message : String(outcome?.reason)}`);
  }

  const lines = [
    `[${nowText()}] you -> room:${room.name} (${targets.length} participant(s))${
      sentIds.length > 0 ? ` [messages ${sentIds.map((id) => `#${id}`).join(", ")}]` : ""
    }`,
    ...text.split(/\r?\n/).map((line) => `  ${line}`),
  ];

  if (skipped.length > 0) {
    lines.push(`Skipped offline participants: ${skipped.map(participantDisplay).join(", ")}`);
  }
  if (failures.length > 0) {
    lines.push(`Send failures: ${failures.join(" | ")}`);
  }

  printBlock(lines);
}

async function sendInCurrentContext(text: string): Promise<void> {
  if (currentContext.kind === "none") {
    throw new Error("No active context. Use /dm or /room create|use first.");
  }

  if (currentContext.kind === "dm") {
    await sendDirectMessage(currentContext.agentId, text);
    return;
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  if (!room) {
    throw new Error(`Room ${currentContext.conversationId} is not available in this session`);
  }

  await sendRoomMessage(room, text);
}

async function showAgents(): Promise<void> {
  const agents = await refreshAgents();
  if (agents.length === 0) {
    printInfo("No other agents connected.");
    return;
  }

  const lines = ["Agents:"];
  for (const agent of agents.sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`- ${compactAgent(agent)}`);
  }
  printBlock(lines);
}

async function switchDm(agentSelector: string): Promise<void> {
  await refreshAgents();
  const resolution = resolveAgentSelector(agentRefRecords, agentSelector);
  if (!resolution.ok) {
    throw new Error(resolution.error);
  }
  const target = resolution.record.agent;

  const history = await messageHistoryCompatible(BROKER_URL, {
    agent_id: myId,
    with_agent_id: target.id,
    limit: 1,
    auth_token: authToken,
  });

  if (history.messages[0]?.conversation_id) {
    rememberDmConversation(target.id, history.messages[0].conversation_id);
  }

  currentContext = { kind: "dm", agentId: target.id };
  printInfo(`DM context: ${resolution.record.ref} | ${target.name} (${target.id})`);
}

async function switchReplyContext(): Promise<void> {
  if (!lastIncomingSenderId) {
    throw new Error("No inbound sender to reply to yet.");
  }

  await switchDm(lastIncomingSenderId);
}

async function resolveRoomParticipants(selectors: string[]): Promise<string[]> {
  await refreshAgents();
  if (selectors.includes("all")) {
    return agentRefRecords.map((record) => record.agent.id);
  }

  const resolvedIds: string[] = [];
  for (const selector of selectors) {
    const resolution = resolveAgentSelector(agentRefRecords, selector);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }

    if (resolution.record.agent.id !== myId) {
      resolvedIds.push(resolution.record.agent.id);
    }
  }

  return Array.from(new Set(resolvedIds));
}

async function createRoom(name: string, selectors: string[]): Promise<void> {
  const participantIds = await resolveRoomParticipants(selectors);
  if (participantIds.length === 0) {
    throw new Error("Room needs at least one live participant");
  }

  const room: OperatorRoom = {
    name,
    conversationId: roomConversationId(name),
    participantIds,
  };

  roomsByConversationId.set(room.conversationId, room);
  currentContext = { kind: "room", conversationId: room.conversationId };

  printBlock([
    `Room created: ${room.name}`,
    `Conversation: ${room.conversationId}`,
    `Participants: ${room.participantIds.map(participantDisplay).join(", ")}`,
  ]);
}

async function loadRoomFromHistory(conversationId: string): Promise<OperatorRoom | null> {
  const history = await messageHistoryCompatible(BROKER_URL, {
    agent_id: myId,
    conversation_id: conversationId,
    limit: ROOM_HISTORY_SCAN_LIMIT,
    mark_opened: true,
    auth_token: authToken,
  });

  if (history.messages.length === 0) {
    return null;
  }

  const participantIds = Array.from(
    new Set(
      history.messages.flatMap((message) => [message.from_id, message.to_id])
    )
  ).filter((agentId) => agentId !== myId);

  if (participantIds.length === 0) {
    return null;
  }

  const room: OperatorRoom = {
    name: conversationId,
    conversationId,
    participantIds,
  };

  roomsByConversationId.set(conversationId, room);
  return room;
}

async function useRoom(roomRef: string): Promise<void> {
  const directMatch = Array.from(roomsByConversationId.values()).find(
    (room) => room.name === roomRef || room.conversationId === roomRef
  );
  const room = directMatch ?? (await loadRoomFromHistory(roomRef));

  if (!room) {
    throw new Error(`Room ${roomRef} is not known in this session and has no visible history`);
  }

  currentContext = { kind: "room", conversationId: room.conversationId };
  printInfo(`Room context: ${room.name} (${room.conversationId})`);
}

function showRooms(): void {
  const rooms = Array.from(roomsByConversationId.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  if (rooms.length === 0) {
    printInfo("No rooms in this operator session.");
    return;
  }

  const lines = ["Rooms:"];
  for (const room of rooms) {
    const active =
      currentContext.kind === "room" &&
      currentContext.conversationId === room.conversationId
        ? "*"
        : "-";
    lines.push(
      `${active} ${room.name} (${room.conversationId}) [${room.participantIds.length} participant(s)]`
    );
  }
  printBlock(lines);
}

function showParticipants(): void {
  if (currentContext.kind === "none") {
    printInfo("No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const agent = agentCache.get(currentContext.agentId);
    printBlock([
      "Participants:",
      `- you (${myId})`,
      `- ${participantRef(currentContext.agentId) ?? currentContext.agentId} | ${agent?.name ?? currentContext.agentId} (${currentContext.agentId})`,
    ]);
    return;
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  if (!room) {
    printInfo("Current room context is not available.");
    return;
  }

  const lines = [
    `Participants for room:${room.name}:`,
    `- you (${myId})`,
  ];
  for (const participantId of room.participantIds) {
    lines.push(`- ${participantDisplay(participantId)} (${participantId})`);
  }
  printBlock(lines);
}

function showContext(): void {
  if (currentContext.kind === "none") {
    printInfo("No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const conversationId = dmConversationByAgentId.get(currentContext.agentId);
    printBlock([
      "Current context:",
      `Type: DM`,
      `Agent: ${participantDisplay(currentContext.agentId)} (${currentContext.agentId})`,
      `Conversation: ${conversationId ?? "(new conversation on next send)"}`,
    ]);
    return;
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  printBlock([
    "Current context:",
    `Type: room`,
    `Name: ${room?.name ?? currentContext.conversationId}`,
    `Conversation: ${currentContext.conversationId}`,
    `Participants: ${room?.participantIds.map(participantDisplay).join(", ") ?? "(unknown)"}`,
  ]);
}

function leaveContext(): void {
  if (currentContext.kind === "none") {
    printInfo("No active context.");
    return;
  }

  currentContext = { kind: "none" };
  printInfo("Context cleared.");
}

async function showHistory(limit: number): Promise<void> {
  if (currentContext.kind === "none") {
    throw new Error("No active context. Use /dm or /room create|use first.");
  }

  const request: MessageHistoryRequest = {
    agent_id: myId,
    limit,
    mark_opened: true,
    auth_token: authToken,
  };

  if (currentContext.kind === "dm") {
    request.with_agent_id = currentContext.agentId;
  } else {
    request.conversation_id = currentContext.conversationId;
  }

  const history = await messageHistoryCompatible(BROKER_URL, request);
  if (history.messages.length === 0) {
    printInfo("No messages found for the current context.");
    return;
  }

  const messages = [...history.messages].reverse();
  console.log(messages.map(formatMessageForHistory).join("\n\n"));
  refreshPrompt();
}

async function pollInbox(): Promise<void> {
  if (pollInFlight || !myId || shuttingDown) {
    return;
  }

  pollInFlight = true;
  try {
    const response = await brokerPost<PollMessagesResponse>("/poll-messages", {
      id: myId,
      auth_token: authToken,
    });

    if (response.messages.length === 0) {
      return;
    }

    await refreshAgents();

    for (const message of response.messages) {
      noteMessageConversation(message);
      console.log(formatIncomingMessage(message));
    }

    await acknowledgeMessagesCompatible(BROKER_URL, {
      id: myId,
      message_ids: response.messages.map((message) => message.id),
      auth_token: authToken,
    });
  } catch (error) {
    printInfo(
      `Inbox poll failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    pollInFlight = false;
    refreshPrompt();
  }
}

async function heartbeat(): Promise<void> {
  if (!myId || shuttingDown) {
    return;
  }

  await brokerPost("/heartbeat", {
    id: myId,
    auth_token: authToken,
  });
}

async function runCommand(command: OperatorCommand): Promise<void> {
  switch (command.kind) {
    case "help":
      printInfo(operatorHelpText());
      return;
    case "quit":
      await shutdown(0);
      return;
    case "leave":
      leaveContext();
      return;
    case "reply":
      await switchReplyContext();
      return;
    case "agents":
      await showAgents();
      return;
    case "rooms":
      showRooms();
      return;
    case "participants":
      showParticipants();
      return;
    case "context":
      showContext();
      return;
    case "history":
      await showHistory(command.limit);
      return;
    case "dm":
      await switchDm(command.agentSelector);
      if (command.text) {
        await sendInCurrentContext(command.text);
      }
      return;
    case "room-create":
      await createRoom(command.name, command.selectors);
      return;
    case "room-use":
      await useRoom(command.roomRef);
      return;
    case "send":
      await sendInCurrentContext(command.text);
      return;
    case "error":
      printInfo(command.message);
      return;
    default: {
      const neverReached: never = command;
      throw new Error(`Unhandled command: ${String(neverReached)}`);
    }
  }
}

async function shutdown(code: number): Promise<never> {
  if (shuttingDown) {
    exit(code);
  }

  shuttingDown = true;
  rl.close();

  if (myId) {
    try {
      await brokerPost<{ ok: boolean }>("/unregister", {
        id: myId,
        auth_token: authToken,
      } satisfies UnregisterRequest);
    } catch {
      // Best effort.
    }
  }

  exit(code);
}

async function main(): Promise<void> {
  await registerOperator();
  await refreshAgents();

  printBlock([
    `Connected to ${BROKER_URL} as ${myId}.`,
    "Use /agents to inspect live refs, /dm <ref-or-name> to chat one-to-one, and /room create <name> all to open a group thread.",
    operatorHelpText(),
  ]);

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      printInfo(
        `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, HEARTBEAT_INTERVAL_MS);

  const pollTimer = setInterval(() => {
    void pollInbox();
  }, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  rl.on("line", (line) => {
    void runCommand(parseOperatorInput(line)).catch((error) => {
      printInfo(`Error: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  rl.on("close", () => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    if (!shuttingDown) {
      void shutdown(0);
    }
  });

  refreshPrompt();
}

try {
  await main();
} catch (error) {
  console.error(
    `Operator startup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  exit(1);
}

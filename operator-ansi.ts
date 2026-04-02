#!/usr/bin/env bun

import readline from "node:readline";
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

type FocusPane = "actions" | "agents" | "rooms" | "thread" | "composer";
type NoticeLevel = "info" | "warn" | "error";
type ThreadDetailMode = "minimal" | "compact" | "verbose";
type Keypress = {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  name?: string;
  sequence?: string;
};
type ModalState = {
  title: string;
  lines: string[];
  scroll: number;
};
type LayoutBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type OperatorAction = {
  label: string;
  shortcut: string;
  handler: () => void | Promise<void>;
};

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const ROOM_HISTORY_SCAN_LIMIT = 100;
const DEFAULT_THREAD_HISTORY_LIMIT = 60;

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_STEADY_BAR = "\x1b[6 q";
const RESET = "\x1b[0m";

let myId = "";
let authToken: string | undefined;
let agentCache = new Map<string, Agent>();
let agentRefRecords: AgentRefRecord[] = [];
const roomsByConversationId = new Map<string, OperatorRoom>();
const dmConversationByAgentId = new Map<string, string>();
let currentContext: OperatorContext = { kind: "none" };
let currentMessages: Message[] = [];
let currentHistoryLimit = DEFAULT_THREAD_HISTORY_LIMIT;
let lastIncomingSenderId: string | null = null;
let lastNotice = "Ready.";
let lastNoticeLevel: NoticeLevel = "info";
let activePane: FocusPane = "agents";
let selectedAgentIds: string[] = [];
let selectedRoomConversationIds: string[] = [];
let selectedAgentIndex = 0;
let selectedRoomIndex = 0;
let shuttingDown = false;
let pollInFlight = false;
let modalState: ModalState | null = null;
let composerValue = "";
let composerCursorIndex = 0;
let composerScrollOffset = 0;
let threadDetailMode: ThreadDetailMode = "minimal";
let lastRenderedThreadSignature = "";
let threadScrollOffset = 0;
let selectedActionIndex = 0;
let statusBarHint = "Tab cycles panes. Left/Right moves Actions. Type in composer. Enter submits or opens.";

const actions: OperatorAction[] = [
  { label: "DM selected", shortcut: "D", handler: () => openSelectedAgent() },
  { label: "Open room", shortcut: "O", handler: () => openSelectedRoom() },
  { label: "Reply", shortcut: "R", handler: () => switchReplyContext() },
  { label: "Leave", shortcut: "L", handler: () => leaveContext() },
  { label: "Refresh", shortcut: "F5", handler: () => fullRefresh() },
  { label: "Help", shortcut: "H", handler: () => showHelp() },
];

function nowText(): string {
  return new Date().toISOString();
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
  if (conversationId) {
    dmConversationByAgentId.set(agentId, conversationId);
  }
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

function sortMessagesChronologically(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => {
    const sentAtDelta = left.sent_at.localeCompare(right.sent_at);
    if (sentAtDelta !== 0) {
      return sentAtDelta;
    }
    return left.id - right.id;
  });
}

function cycleThreadDetailMode(): void {
  threadDetailMode =
    threadDetailMode === "minimal"
      ? "compact"
      : threadDetailMode === "compact"
        ? "verbose"
        : "minimal";
}

function formatThreadTimestamp(sentAt: string): string {
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) {
    return sentAt;
  }
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function minimalSpeakerLabel(message: Message): string {
  if (message.from_id === myId) {
    return "Me";
  }

  if (currentContext.kind === "dm") {
    return participantName(currentContext.agentId);
  }

  return participantName(message.from_id);
}

function formatMessageForThread(message: Message): string {
  if (threadDetailMode === "minimal") {
    return [
      `[${formatThreadTimestamp(message.sent_at)}] ${minimalSpeakerLabel(message)}`,
      ...message.text.split(/\r?\n/),
    ].join("\n");
  }

  const room = roomForConversation(message.conversation_id);
  const header = `[${message.sent_at}] #${message.id} ${participantDisplay(message.from_id)} -> ${participantDisplay(message.to_id)}${
    room ? ` [room:${room.name}]` : ""
  }`;
  const lines = [
    header,
    ...message.text.split(/\r?\n/).map((line) => `  ${line}`),
  ];
  if (message.reply_to_message_id && threadDetailMode === "compact") {
    lines.push(`  Reply to #${message.reply_to_message_id}`);
  }
  if (threadDetailMode === "verbose") {
    appendMessageStateLines(lines, message);
  }
  return lines.join("\n");
}

function formatAgentListItem(agent: Agent): string {
  const ref = participantRef(agent.id) ?? agent.id;
  const unread =
    agent.unread_count > 0
      ? ` [${agent.unread_count}]`
      : agent.surfaced_unseen_count > 0
        ? ` [${agent.surfaced_unseen_count}*]`
        : "";
  return `${ref}${unread} ${agent.name}`;
}

function formatRoomListItem(room: OperatorRoom): string {
  const active =
    currentContext.kind === "room" &&
    currentContext.conversationId === room.conversationId
      ? "* "
      : "";
  return `${active}${room.name} (${room.participantIds.length})`;
}

function contextLabel(): string {
  if (currentContext.kind === "dm") {
    return `DM ${participantDisplay(currentContext.agentId)}`;
  }
  if (currentContext.kind === "room") {
    const room = roomsByConversationId.get(currentContext.conversationId);
    return `Room ${room?.name ?? currentContext.conversationId}`;
  }
  return "No active context";
}

function setNotice(message: string, level: NoticeLevel = "info"): void {
  lastNotice = message;
  lastNoticeLevel = level;
}

function showError(message: string): void {
  setNotice(message, "error");
  renderAll();
}

function fullWidthChars(input: string): string[] {
  return Array.from(input);
}

function clipText(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const chars = fullWidthChars(input);
  if (chars.length <= width) {
    return chars.join("");
  }
  if (width === 1) {
    return "…";
  }
  return `${chars.slice(0, width - 1).join("")}…`;
}

function padText(input: string, width: number): string {
  const clipped = clipText(input, width);
  const current = fullWidthChars(clipped).length;
  return current >= width ? clipped : clipped + " ".repeat(width - current);
}

function wrapLine(input: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  const raw = input.length === 0 ? [""] : input.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of raw) {
    const wordChars = fullWidthChars(word);
    if (wordChars.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let start = 0; start < wordChars.length; start += width) {
        lines.push(wordChars.slice(start, start + width).join(""));
      }
      continue;
    }

    if (!current) {
      current = word;
      continue;
    }

    const next = `${current} ${word}`;
    if (fullWidthChars(next).length <= width) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current || lines.length === 0) {
    lines.push(current);
  }

  return lines;
}

function wrapText(input: string, width: number): string[] {
  return input.split(/\r?\n/).flatMap((line) => wrapLine(line, width));
}

function makeCanvas(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array(width).fill(" "));
}

function putText(canvas: string[][], x: number, y: number, text: string, width?: number): void {
  if (y < 0 || y >= canvas.length) {
    return;
  }
  const row = canvas[y]!;
  const chars = fullWidthChars(width === undefined ? text : clipText(text, width));
  for (let index = 0; index < chars.length; index += 1) {
    const col = x + index;
    if (col < 0 || col >= row.length) {
      break;
    }
    row[col] = chars[index]!;
  }
}

function drawBox(canvas: string[][], box: LayoutBox, label: string): void {
  if (box.width < 2 || box.height < 2) {
    return;
  }

  const x2 = box.x + box.width - 1;
  const y2 = box.y + box.height - 1;
  for (let x = box.x + 1; x < x2; x += 1) {
    putText(canvas, x, box.y, "─");
    putText(canvas, x, y2, "─");
  }
  for (let y = box.y + 1; y < y2; y += 1) {
    putText(canvas, box.x, y, "│");
    putText(canvas, x2, y, "│");
  }
  putText(canvas, box.x, box.y, "┌");
  putText(canvas, x2, box.y, "┐");
  putText(canvas, box.x, y2, "└");
  putText(canvas, x2, y2, "┘");
  if (label) {
    putText(canvas, box.x + 2, box.y, ` ${clipText(label, Math.max(0, box.width - 4))} `);
  }
}

function fillBox(canvas: string[][], box: LayoutBox, lines: string[]): void {
  const innerWidth = Math.max(0, box.width - 2);
  const innerHeight = Math.max(0, box.height - 2);
  for (let row = 0; row < innerHeight; row += 1) {
    const line = padText(lines[row] ?? "", innerWidth);
    putText(canvas, box.x + 1, box.y + 1 + row, line, innerWidth);
  }
}

function renderAgentListLines(height: number): string[] {
  const previousSelected = selectedAgentIds[selectedAgentIndex] ?? null;
  const agents = [...agentCache.values()].sort((left, right) => {
    const unreadDelta = right.unread_count - left.unread_count;
    if (unreadDelta !== 0) {
      return unreadDelta;
    }
    return left.name.localeCompare(right.name);
  });

  selectedAgentIds = agents.map((agent) => agent.id);
  if (agents.length === 0) {
    selectedAgentIndex = 0;
    return ["(no agents online)"];
  }

  const preferredId =
    currentContext.kind === "dm"
      ? currentContext.agentId
      : previousSelected;
  const preferredIndex = preferredId ? selectedAgentIds.indexOf(preferredId) : -1;
  const currentIndex = preferredIndex >= 0 ? preferredIndex : selectedAgentIndex;
  selectedAgentIndex = Math.max(0, Math.min(currentIndex, selectedAgentIds.length - 1));

  return agents
    .map((agent, index) => {
      const marker = index === selectedAgentIndex ? (activePane === "agents" ? ">" : "*") : " ";
      return `${marker} ${formatAgentListItem(agent)}`;
    })
    .slice(0, height);
}

function renderRoomListLines(height: number): string[] {
  const previousSelected = selectedRoomConversationIds[selectedRoomIndex] ?? null;
  const rooms = [...roomsByConversationId.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  selectedRoomConversationIds = rooms.map((room) => room.conversationId);
  if (rooms.length === 0) {
    selectedRoomIndex = 0;
    return ["(no rooms yet)"];
  }

  const preferredId =
    currentContext.kind === "room"
      ? currentContext.conversationId
      : previousSelected;
  const preferredIndex = preferredId ? selectedRoomConversationIds.indexOf(preferredId) : -1;
  const currentIndex = preferredIndex >= 0 ? preferredIndex : selectedRoomIndex;
  selectedRoomIndex = Math.max(0, Math.min(currentIndex, selectedRoomConversationIds.length - 1));

  return rooms
    .map((room, index) => {
      const marker = index === selectedRoomIndex ? (activePane === "rooms" ? ">" : "*") : " ";
      return `${marker} ${formatRoomListItem(room)}`;
    })
    .slice(0, height);
}

function threadHeaderLines(): string[] {
  if (currentContext.kind === "none") {
    return [
      "No active context.",
      "",
      "Select an agent to open a DM, create a room with /room create, or use /msg <agent> <text>.",
    ];
  }

  if (currentContext.kind === "dm") {
    const agent = agentCache.get(currentContext.agentId);
    const conversationId = dmConversationByAgentId.get(currentContext.agentId);
    return [
      `DM with ${participantDisplay(currentContext.agentId)}`,
      `Conversation: ${conversationId ?? "(new conversation on next send)"}`,
      `Summary: ${agent?.summary ?? "(none)"}`,
    ];
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  return [
    `Room ${room?.name ?? currentContext.conversationId}`,
    `Conversation: ${currentContext.conversationId}`,
    `Participants: ${room?.participantIds.map(participantDisplay).join(", ") ?? "(unknown)"}`,
  ];
}

function threadBodyLines(width: number): string[] {
  if (currentContext.kind === "none") {
    return [
      "Ready.",
      "",
      "Quick actions:",
      "- Select an agent and press Enter to open a DM",
      "- Select a room and press Enter to reopen it",
      "- Use /reply to jump to the last inbound sender",
      "- Use /leave to clear the current context",
    ];
  }

  if (currentMessages.length === 0) {
    return ["No messages in the current context."];
  }

  const orderedMessages = sortMessagesChronologically(currentMessages);
  const content = orderedMessages.map(formatMessageForThread).join("\n\n");
  lastRenderedThreadSignature = content;
  return wrapText(content, width);
}

function currentModalLines(width: number): string[] {
  if (!modalState) {
    return [];
  }
  return modalState.lines.flatMap((line) => wrapText(line, width));
}

function setModal(title: string, content: string): void {
  modalState = {
    title,
    lines: `${content}\n\nEsc, Enter, or q to close`.split(/\r?\n/),
    scroll: 0,
  };
  renderAll();
}

function closeModal(): void {
  if (!modalState) {
    return;
  }
  modalState = null;
  renderAll();
}

function renderActionsLine(width: number): string {
  const parts = actions.map((action, index) => {
    const selected = index === selectedActionIndex;
    return selected && activePane === "actions"
      ? `[${action.shortcut}] ${action.label}`
      : ` ${action.shortcut}  ${action.label}`;
  });
  return padText(parts.join("   "), width);
}

function topLineText(width: number): string {
  return padText(
    `claudy-talky operator | you ${myId || "(registering)"} | ${contextLabel()} | ${agentCache.size} agent(s) online`,
    width
  );
}

function noticeLineText(width: number): string {
  const prefix =
    lastNoticeLevel === "error" ? "ERROR: "
      : lastNoticeLevel === "warn" ? "WARN: "
      : "";
  return padText(`${prefix}${lastNotice}`, width);
}

function hintLineText(width: number): string {
  return padText(`${statusBarHint} [v] details: ${threadDetailMode}.`, width);
}

function currentTerminalSize(): { width: number; height: number } {
  return {
    width: Math.max(stdout.columns ?? 120, 80),
    height: Math.max(stdout.rows ?? 40, 24),
  };
}

function layoutForTerminal(width: number, height: number): {
  agents: LayoutBox;
  rooms: LayoutBox;
  threadHeader: LayoutBox;
  messages: LayoutBox;
  composer: LayoutBox;
} {
  const topRows = 4;
  const composerHeight = 3;
  const bodyTop = topRows;
  const bodyHeight = Math.max(8, height - topRows - composerHeight);
  const leftWidth = Math.max(28, Math.floor(width * 0.3));
  const rightWidth = width - leftWidth;
  const agentsHeight = Math.max(8, Math.floor(bodyHeight * 0.58));
  const roomsHeight = bodyHeight - agentsHeight;
  const threadHeaderHeight = 4;

  return {
    agents: { x: 0, y: bodyTop, width: leftWidth, height: agentsHeight },
    rooms: { x: 0, y: bodyTop + agentsHeight, width: leftWidth, height: roomsHeight },
    threadHeader: { x: leftWidth, y: bodyTop, width: rightWidth, height: threadHeaderHeight },
    messages: {
      x: leftWidth,
      y: bodyTop + threadHeaderHeight,
      width: rightWidth,
      height: bodyHeight - threadHeaderHeight,
    },
    composer: { x: 0, y: height - composerHeight, width, height: composerHeight },
  };
}

function syncComposerViewport(visibleWidth: number): void {
  const chars = fullWidthChars(composerValue);
  composerCursorIndex = Math.max(0, Math.min(composerCursorIndex, chars.length));
  const maxVisibleChars = Math.max(1, visibleWidth - 1);

  if (chars.length <= maxVisibleChars) {
    composerScrollOffset = 0;
    return;
  }

  const maxScroll = chars.length - maxVisibleChars;
  composerScrollOffset = Math.max(0, Math.min(composerScrollOffset, maxScroll));
  if (composerCursorIndex < composerScrollOffset) {
    composerScrollOffset = composerCursorIndex;
  } else if (composerCursorIndex > composerScrollOffset + maxVisibleChars) {
    composerScrollOffset = composerCursorIndex - maxVisibleChars;
  }
}

function renderComposerLine(visibleWidth: number): { text: string; cursorOffset: number } {
  const chars = fullWidthChars(composerValue);
  syncComposerViewport(visibleWidth);
  const maxVisibleChars = Math.max(1, visibleWidth - 1);
  const visibleChars = chars.slice(
    composerScrollOffset,
    composerScrollOffset + maxVisibleChars
  );
  return {
    text: visibleChars.join(""),
    cursorOffset: Math.min(composerCursorIndex - composerScrollOffset, maxVisibleChars),
  };
}

function setComposerDraft(value: string, cursorIndex?: number): void {
  composerValue = value;
  const chars = fullWidthChars(value);
  composerCursorIndex =
    cursorIndex === undefined ? chars.length : Math.max(0, Math.min(cursorIndex, chars.length));
  composerScrollOffset = 0;
}

function clearComposerDraft(): void {
  composerValue = "";
  composerCursorIndex = 0;
  composerScrollOffset = 0;
}

function insertComposerText(text: string): void {
  const chars = fullWidthChars(composerValue);
  const insertChars = fullWidthChars(text);
  composerCursorIndex = Math.max(0, Math.min(composerCursorIndex, chars.length));
  chars.splice(composerCursorIndex, 0, ...insertChars);
  composerValue = chars.join("");
  composerCursorIndex += insertChars.length;
}

function deleteComposerBackward(): void {
  const chars = fullWidthChars(composerValue);
  composerCursorIndex = Math.max(0, Math.min(composerCursorIndex, chars.length));
  if (composerCursorIndex === 0) {
    return;
  }
  chars.splice(composerCursorIndex - 1, 1);
  composerValue = chars.join("");
  composerCursorIndex -= 1;
}

function deleteComposerForward(): void {
  const chars = fullWidthChars(composerValue);
  composerCursorIndex = Math.max(0, Math.min(composerCursorIndex, chars.length));
  if (composerCursorIndex >= chars.length) {
    return;
  }
  chars.splice(composerCursorIndex, 1);
  composerValue = chars.join("");
}

function moveComposerCursor(delta: number): void {
  const chars = fullWidthChars(composerValue);
  composerCursorIndex = Math.max(0, Math.min(composerCursorIndex + delta, chars.length));
}

function moveComposerCursorToStart(): void {
  composerCursorIndex = 0;
}

function moveComposerCursorToEnd(): void {
  composerCursorIndex = fullWidthChars(composerValue).length;
}

function renderAll(): void {
  const { width, height } = currentTerminalSize();
  const layout = layoutForTerminal(width, height);
  const canvas = makeCanvas(width, height);

  putText(canvas, 0, 0, topLineText(width), width);
  putText(canvas, 0, 1, noticeLineText(width), width);
  putText(canvas, 0, 2, renderActionsLine(width), width);
  putText(canvas, 0, 3, hintLineText(width), width);

  drawBox(canvas, layout.agents, `${activePane === "agents" ? "*" : ""} Agents`);
  drawBox(canvas, layout.rooms, `${activePane === "rooms" ? "*" : ""} Rooms`);
  drawBox(canvas, layout.threadHeader, `${activePane === "thread" ? "*" : ""} Thread`);
  drawBox(canvas, layout.messages, `${activePane === "thread" ? "*" : ""} Messages`);
  drawBox(
    canvas,
    layout.composer,
    `${activePane === "composer" ? "*" : ""} Composer | ${contextLabel()}${activePane === "composer" ? " | editing" : ""}`
  );

  fillBox(canvas, layout.agents, renderAgentListLines(layout.agents.height - 2));
  fillBox(canvas, layout.rooms, renderRoomListLines(layout.rooms.height - 2));
  fillBox(canvas, layout.threadHeader, threadHeaderLines());

  const messageWidth = Math.max(1, layout.messages.width - 2);
  const wrappedThreadLines = threadBodyLines(messageWidth);
  const messageVisibleHeight = Math.max(1, layout.messages.height - 2);
  const maxThreadScroll = Math.max(0, wrappedThreadLines.length - messageVisibleHeight);
  threadScrollOffset = Math.max(0, Math.min(threadScrollOffset, maxThreadScroll));
  const messageStart = Math.max(0, wrappedThreadLines.length - messageVisibleHeight - threadScrollOffset);
  fillBox(
    canvas,
    layout.messages,
    wrappedThreadLines.slice(messageStart, messageStart + messageVisibleHeight)
  );

  const composerLine = renderComposerLine(Math.max(1, layout.composer.width - 4));
  putText(canvas, layout.composer.x + 1, layout.composer.y + 1, "> ");
  putText(
    canvas,
    layout.composer.x + 3,
    layout.composer.y + 1,
    padText(composerLine.text, Math.max(1, layout.composer.width - 4)),
    Math.max(1, layout.composer.width - 4)
  );

  if (modalState) {
    const modalWidth = Math.max(40, Math.floor(width * 0.72));
    const modalHeight = Math.max(10, Math.floor(height * 0.66));
    const modalBox: LayoutBox = {
      x: Math.max(0, Math.floor((width - modalWidth) / 2)),
      y: Math.max(0, Math.floor((height - modalHeight) / 2)),
      width: Math.min(width, modalWidth),
      height: Math.min(height, modalHeight),
    };
    drawBox(canvas, modalBox, modalState.title);
    const modalLines = currentModalLines(Math.max(1, modalBox.width - 2));
    const visibleHeight = Math.max(1, modalBox.height - 2);
    const maxScroll = Math.max(0, modalLines.length - visibleHeight);
    modalState.scroll = Math.max(0, Math.min(modalState.scroll, maxScroll));
    fillBox(canvas, modalBox, modalLines.slice(modalState.scroll, modalState.scroll + visibleHeight));
  }

  const lines = canvas.map((row) => row.join("").slice(0, width));
  let output = `${ALT_SCREEN_ON}${CURSOR_STEADY_BAR}${CLEAR_SCREEN}${CURSOR_HOME}${lines.join("\n")}`;
  if (activePane === "composer" && !modalState) {
    const cursorRow = layout.composer.y + 1;
    const maxCursorOffset = Math.max(0, layout.composer.width - 5);
    const cursorCol = layout.composer.x + 3 + Math.min(composerLine.cursorOffset, maxCursorOffset);
    output += `\x1b[${cursorRow + 1};${cursorCol + 1}H${SHOW_CURSOR}`;
  } else {
    output += HIDE_CURSOR;
  }
  output += RESET;
  stdout.write(output);
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  return brokerFetch<T>(BROKER_URL, path, body);
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
    transport: "cli-ansi",
    cwd: cwd(),
    summary: "Interactive human operator ANSI session.",
    capabilities: ["messaging", "message_history", "operator_console"],
    metadata: {
      client: "claudy-talky Operator ANSI",
      launcher: "bun",
      adapter: "claudy-talky",
      workspace_source: "process.cwd",
      notification_styles: ["ansi", "stdout"],
    },
  });

  myId = response.id;
  authToken = response.auth_token;
}

function currentContextRequest(limit: number): MessageHistoryRequest {
  const request: MessageHistoryRequest = {
    agent_id: myId,
    limit,
    mark_opened: true,
    auth_token: authToken,
  };

  if (currentContext.kind === "dm") {
    request.with_agent_id = currentContext.agentId;
  } else if (currentContext.kind === "room") {
    request.conversation_id = currentContext.conversationId;
  }

  return request;
}

async function loadCurrentHistory(limit = currentHistoryLimit): Promise<void> {
  currentHistoryLimit = limit;

  if (currentContext.kind === "none") {
    currentMessages = [];
    threadScrollOffset = 0;
    renderAll();
    return;
  }

  const history = await messageHistoryCompatible(BROKER_URL, currentContextRequest(limit));
  currentMessages = sortMessagesChronologically(history.messages);
  threadScrollOffset = 0;
  await refreshAgents();
  renderAll();
}

async function fullRefresh(): Promise<void> {
  await refreshAgents();
  await loadCurrentHistory();
  setNotice("Refreshed agents and current thread.");
  renderAll();
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
  setNotice(`Sent message #${result.message.id} to ${participantDisplay(agentId)}.`);

  if (currentContext.kind === "dm" && currentContext.agentId === agentId) {
    currentMessages = sortMessagesChronologically([...currentMessages, result.message]);
    threadScrollOffset = 0;
  }

  await refreshAgents();
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

  const sentMessages: Message[] = [];
  const failures: string[] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const targetId = targets[index];
    if (outcome?.status === "fulfilled" && outcome.value.ok && outcome.value.message) {
      sentMessages.push(outcome.value.message);
      continue;
    }

    if (outcome?.status === "fulfilled") {
      failures.push(`${targetId}: ${outcome.value.error ?? "send failed"}`);
      continue;
    }

    failures.push(
      `${targetId}: ${outcome?.reason instanceof Error ? outcome.reason.message : String(outcome?.reason)}`
    );
  }

  if (currentContext.kind === "room" && currentContext.conversationId === room.conversationId) {
    currentMessages = sortMessagesChronologically([...currentMessages, ...sentMessages]);
    threadScrollOffset = 0;
  }

  if (failures.length > 0) {
    setNotice(
      `Room send completed with ${failures.length} failure(s). ${skipped.length > 0 ? `${skipped.length} offline.` : ""}`.trim(),
      "warn"
    );
  } else {
    setNotice(
      `Sent ${sentMessages.length} room message(s) to ${targets.length} participant(s).`
    );
  }

  await refreshAgents();
}

async function sendInCurrentContext(text: string): Promise<void> {
  if (currentContext.kind === "none") {
    throw new Error("No active context. Select an agent or room first.");
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

async function switchDmById(agentId: string): Promise<void> {
  await refreshAgents();
  const target = agentCache.get(agentId);
  if (!target) {
    throw new Error(`Agent ${agentId} is no longer online.`);
  }

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
  setNotice(`Opened DM with ${participantDisplay(target.id)}.`);
  await loadCurrentHistory(DEFAULT_THREAD_HISTORY_LIMIT);
  activePane = "composer";
  renderAll();
}

async function switchDm(agentSelector: string): Promise<void> {
  await refreshAgents();
  const resolution = resolveAgentSelector(agentRefRecords, agentSelector);
  if (!resolution.ok) {
    throw new Error(resolution.error);
  }

  await switchDmById(resolution.record.agent.id);
}

async function switchReplyContext(): Promise<void> {
  if (!lastIncomingSenderId) {
    throw new Error("No inbound sender to reply to yet.");
  }
  await switchDmById(lastIncomingSenderId);
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
    throw new Error("Room needs at least one live participant.");
  }

  const room: OperatorRoom = {
    name,
    conversationId: roomConversationId(name),
    participantIds,
  };

  roomsByConversationId.set(room.conversationId, room);
  currentContext = { kind: "room", conversationId: room.conversationId };
  currentMessages = [];
  threadScrollOffset = 0;
  setNotice(`Created room ${room.name} with ${room.participantIds.length} participant(s).`);
  activePane = "composer";
  renderAll();
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
    new Set(history.messages.flatMap((message) => [message.from_id, message.to_id]))
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
  const directMatch = [...roomsByConversationId.values()].find(
    (room) => room.name === roomRef || room.conversationId === roomRef
  );
  const room = directMatch ?? (await loadRoomFromHistory(roomRef));

  if (!room) {
    throw new Error(`Room ${roomRef} is not known in this session and has no visible history.`);
  }

  currentContext = { kind: "room", conversationId: room.conversationId };
  setNotice(`Opened room ${room.name}.`);
  await loadCurrentHistory(DEFAULT_THREAD_HISTORY_LIMIT);
  activePane = "composer";
  renderAll();
}

function leaveContext(): void {
  if (currentContext.kind === "none") {
    setNotice("No active context.", "warn");
    renderAll();
    return;
  }

  currentContext = { kind: "none" };
  currentMessages = [];
  threadScrollOffset = 0;
  setNotice("Context cleared.");
  activePane = "agents";
  renderAll();
}

function showParticipants(): void {
  if (currentContext.kind === "none") {
    setModal("Participants", "No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const agent = agentCache.get(currentContext.agentId);
    setModal(
      "Participants",
      [
        "Participants:",
        `- you (${myId})`,
        `- ${participantRef(currentContext.agentId) ?? currentContext.agentId} | ${agent?.name ?? currentContext.agentId} (${currentContext.agentId})`,
      ].join("\n")
    );
    return;
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  const lines = [
    `Participants for room:${room?.name ?? currentContext.conversationId}:`,
    `- you (${myId})`,
  ];
  for (const participantId of room?.participantIds ?? []) {
    lines.push(`- ${participantDisplay(participantId)} (${participantId})`);
  }
  setModal("Participants", lines.join("\n"));
}

function showContext(): void {
  if (currentContext.kind === "none") {
    setModal("Current Context", "No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const conversationId = dmConversationByAgentId.get(currentContext.agentId);
    setModal(
      "Current Context",
      [
        "Type: DM",
        `Agent: ${participantDisplay(currentContext.agentId)} (${currentContext.agentId})`,
        `Conversation: ${conversationId ?? "(new conversation on next send)"}`,
      ].join("\n")
    );
    return;
  }

  const room = roomsByConversationId.get(currentContext.conversationId);
  setModal(
    "Current Context",
    [
      "Type: room",
      `Name: ${room?.name ?? currentContext.conversationId}`,
      `Conversation: ${currentContext.conversationId}`,
      `Participants: ${room?.participantIds.map(participantDisplay).join(", ") ?? "(unknown)"}`,
    ].join("\n")
  );
}

function showHelp(): void {
  setModal("Help", operatorHelpText());
}

async function showHistory(limit: number): Promise<void> {
  if (currentContext.kind === "none") {
    throw new Error("No active context. Select an agent or room first.");
  }

  await loadCurrentHistory(limit);
  setNotice(`Loaded ${limit} message(s) for the current context.`);
  renderAll();
}

function messageBelongsToCurrentContext(message: Message): boolean {
  if (currentContext.kind === "none") {
    return false;
  }

  if (currentContext.kind === "room") {
    return message.conversation_id === currentContext.conversationId;
  }

  return (
    (message.from_id === currentContext.agentId && message.to_id === myId) ||
    (message.from_id === myId && message.to_id === currentContext.agentId)
  );
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

    for (const message of response.messages) {
      noteMessageConversation(message);
    }

    await acknowledgeMessagesCompatible(BROKER_URL, {
      id: myId,
      message_ids: response.messages.map((message) => message.id),
      auth_token: authToken,
    });

    await refreshAgents();

    const affectsCurrentContext = response.messages.some(messageBelongsToCurrentContext);
    const newest = response.messages.at(-1);
    if (newest) {
      setNotice(`Inbound message from ${participantDisplay(newest.from_id)} (#${newest.id}).`);
    }

    if (affectsCurrentContext) {
      await loadCurrentHistory();
    } else {
      renderAll();
    }
  } catch (error) {
    showError(`Inbox poll failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pollInFlight = false;
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

async function openSelectedAgent(): Promise<void> {
  const selectedId = selectedAgentIds[selectedAgentIndex];
  if (!selectedId) {
    setNotice("No live agent selected.", "warn");
    renderAll();
    return;
  }
  await switchDmById(selectedId);
}

async function openSelectedRoom(): Promise<void> {
  const selectedConversationId = selectedRoomConversationIds[selectedRoomIndex];
  if (!selectedConversationId) {
    setNotice("No room selected.", "warn");
    renderAll();
    return;
  }
  await useRoom(selectedConversationId);
}

async function runCommand(command: OperatorCommand): Promise<void> {
  switch (command.kind) {
    case "help":
      showHelp();
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
    case "details":
      if (command.mode) {
        threadDetailMode = command.mode;
      } else {
        cycleThreadDetailMode();
      }
      setNotice(`Message details: ${threadDetailMode}.`);
      renderAll();
      return;
    case "agents":
      await refreshAgents();
      setNotice("Agents refreshed.");
      activePane = "agents";
      renderAll();
      return;
    case "rooms":
      setNotice("Rooms pane focused.");
      activePane = "rooms";
      renderAll();
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
      setNotice(command.message, "error");
      renderAll();
      return;
    default: {
      const neverReached: never = command;
      throw new Error(`Unhandled command: ${String(neverReached)}`);
    }
  }
}

async function handleComposerSubmit(rawValue: string): Promise<void> {
  const value = rawValue.trim();
  clearComposerDraft();

  if (!value) {
    setNotice("Composer cleared.", "warn");
    activePane = "composer";
    renderAll();
    return;
  }

  await runCommand(parseOperatorInput(value));
  activePane = "composer";
  renderAll();
}

function cleanupTerminal(): void {
  try {
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }
  stdout.write(`${RESET}${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
}

async function shutdown(code: number): Promise<never> {
  if (shuttingDown) {
    cleanupTerminal();
    exit(code);
  }

  shuttingDown = true;

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

  cleanupTerminal();
  exit(code);
}

function cycleFocus(direction: 1 | -1): void {
  const panes: FocusPane[] = ["actions", "agents", "rooms", "thread", "composer"];
  const currentIndex = panes.indexOf(activePane);
  const nextIndex = (currentIndex + direction + panes.length) % panes.length;
  activePane = panes[nextIndex]!;
  if (activePane === "actions") {
    setNotice("Actions focused. Use Left/Right to choose an action and Enter to run it.");
  }
  renderAll();
}

async function invokeSelectedAction(): Promise<void> {
  const action = actions[selectedActionIndex];
  if (!action) {
    return;
  }

  try {
    await Promise.resolve(action.handler());
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function handleModalKey(key: Keypress): boolean {
  if (!modalState) {
    return false;
  }

  if (key.name === "escape" || key.name === "enter" || key.name === "q") {
    closeModal();
    return true;
  }

  const { width, height } = currentTerminalSize();
  const modalWidth = Math.max(40, Math.floor(width * 0.72));
  const modalHeight = Math.max(10, Math.floor(height * 0.66));
  const visibleHeight = Math.max(1, modalHeight - 2);
  const modalLines = currentModalLines(Math.max(1, modalWidth - 2));
  const maxScroll = Math.max(0, modalLines.length - visibleHeight);

  if (key.name === "up") {
    modalState.scroll = Math.max(0, modalState.scroll - 1);
    renderAll();
    return true;
  }

  if (key.name === "down") {
    modalState.scroll = Math.min(maxScroll, modalState.scroll + 1);
    renderAll();
    return true;
  }

  if (key.name === "pageup") {
    modalState.scroll = Math.max(0, modalState.scroll - visibleHeight);
    renderAll();
    return true;
  }

  if (key.name === "pagedown") {
    modalState.scroll = Math.min(maxScroll, modalState.scroll + visibleHeight);
    renderAll();
    return true;
  }

  return true;
}

function isPrintable(ch: string | undefined, key: Keypress): boolean {
  return typeof ch === "string" && ch.length > 0 && !key.ctrl && !key.meta;
}

async function handleKeypress(ch: string, key: Keypress): Promise<void> {
  if (handleModalKey(key)) {
    return;
  }

  if (key.ctrl && key.name === "c") {
    await shutdown(0);
    return;
  }

  if (key.name === "tab") {
    cycleFocus(key.shift ? -1 : 1);
    return;
  }

  if (key.name === "f5") {
    await fullRefresh();
    return;
  }

  if (key.ctrl && key.name === "r") {
    await switchReplyContext();
    return;
  }

  if (key.ctrl && key.name === "l") {
    leaveContext();
    return;
  }

  if (key.ctrl && key.name === "a") {
    activePane = "actions";
    setNotice("Actions focused. Use Left/Right to choose an action and Enter to run it.");
    renderAll();
    return;
  }

  if (activePane !== "composer") {
    if (key.name === "a") {
      activePane = "agents";
      renderAll();
      return;
    }
    if (key.name === "r") {
      activePane = "rooms";
      renderAll();
      return;
    }
    if (key.name === "m") {
      activePane = "composer";
      renderAll();
      return;
    }
    if (key.name === "x") {
      activePane = "actions";
      renderAll();
      return;
    }
    if (key.name === "h") {
      showHelp();
      return;
    }
    if (key.name === "v") {
      cycleThreadDetailMode();
      setNotice(`Message details: ${threadDetailMode}.`);
      renderAll();
      return;
    }
    if (key.name === "/" && !key.ctrl && !key.meta) {
      setComposerDraft("/", 1);
      activePane = "composer";
      renderAll();
      return;
    }
  }

  if (activePane === "actions") {
    if (key.name === "left") {
      selectedActionIndex =
        (selectedActionIndex + actions.length - 1) % actions.length;
      renderAll();
      return;
    }
    if (key.name === "right") {
      selectedActionIndex = (selectedActionIndex + 1) % actions.length;
      renderAll();
      return;
    }
    if (key.name === "enter") {
      await invokeSelectedAction();
      return;
    }
  }

  if (activePane === "agents") {
    if (key.name === "up") {
      selectedAgentIndex = Math.max(0, selectedAgentIndex - 1);
      renderAll();
      return;
    }
    if (key.name === "down") {
      selectedAgentIndex = Math.min(Math.max(0, selectedAgentIds.length - 1), selectedAgentIndex + 1);
      renderAll();
      return;
    }
    if (key.name === "enter") {
      await openSelectedAgent();
      return;
    }
  }

  if (activePane === "rooms") {
    if (key.name === "up") {
      selectedRoomIndex = Math.max(0, selectedRoomIndex - 1);
      renderAll();
      return;
    }
    if (key.name === "down") {
      selectedRoomIndex = Math.min(Math.max(0, selectedRoomConversationIds.length - 1), selectedRoomIndex + 1);
      renderAll();
      return;
    }
    if (key.name === "enter") {
      await openSelectedRoom();
      return;
    }
  }

  if (activePane === "thread") {
    const { width, height } = currentTerminalSize();
    const layout = layoutForTerminal(width, height);
    const visibleHeight = Math.max(1, layout.messages.height - 2);
    const maxScroll = Math.max(0, threadBodyLines(Math.max(1, layout.messages.width - 2)).length - visibleHeight);
    if (key.name === "up") {
      threadScrollOffset = Math.min(maxScroll, threadScrollOffset + 1);
      renderAll();
      return;
    }
    if (key.name === "down") {
      threadScrollOffset = Math.max(0, threadScrollOffset - 1);
      renderAll();
      return;
    }
    if (key.name === "pageup") {
      threadScrollOffset = Math.min(maxScroll, threadScrollOffset + visibleHeight);
      renderAll();
      return;
    }
    if (key.name === "pagedown") {
      threadScrollOffset = Math.max(0, threadScrollOffset - visibleHeight);
      renderAll();
      return;
    }
  }

  if (activePane === "composer") {
    if (key.name === "escape") {
      clearComposerDraft();
      activePane = "agents";
      renderAll();
      return;
    }
    if (key.name === "left") {
      moveComposerCursor(-1);
      renderAll();
      return;
    }
    if (key.name === "right") {
      moveComposerCursor(1);
      renderAll();
      return;
    }
    if (key.name === "home") {
      moveComposerCursorToStart();
      renderAll();
      return;
    }
    if (key.name === "end") {
      moveComposerCursorToEnd();
      renderAll();
      return;
    }
    if (key.name === "backspace") {
      deleteComposerBackward();
      renderAll();
      return;
    }
    if (key.name === "delete") {
      deleteComposerForward();
      renderAll();
      return;
    }
    if (key.name === "enter") {
      await handleComposerSubmit(composerValue);
      return;
    }
  }

  if (isPrintable(ch, key)) {
    if (activePane !== "composer") {
      activePane = "composer";
    }
    insertComposerText(ch);
    renderAll();
  }
}

async function main(): Promise<void> {
  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  await registerOperator();
  await refreshAgents();

  setNotice(`Connected to ${BROKER_URL} as ${myId}.`);
  renderAll();

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      showError(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  const pollTimer = setInterval(() => {
    void pollInbox();
  }, POLL_INTERVAL_MS);

  stdin.on("keypress", (nextCh, nextKey) => {
    void handleKeypress(nextCh, nextKey).catch((error) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });

  stdout.on("resize", () => {
    renderAll();
  });

  process.on("SIGINT", () => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    void shutdown(0);
  });
}

try {
  await main();
} catch (error) {
  cleanupTerminal();
  console.error(
    `Operator startup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  exit(1);
}

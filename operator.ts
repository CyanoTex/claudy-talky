#!/usr/bin/env bun

import blessedModule from "neo-neo-blessed";
import { basename } from "node:path";
import { cwd, exit } from "node:process";
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

const blessed = blessedModule as any;

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
type OperatorAction = {
  label: string;
  shortcut: string;
  handler: () => void | Promise<void>;
  box?: any;
};

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const ROOM_HISTORY_SCAN_LIMIT = 100;
const DEFAULT_THREAD_HISTORY_LIMIT = 60;

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
let shuttingDown = false;
let pollInFlight = false;
let helpModalOpen = false;
let modalReturnFocus: { focus: () => void } | null = null;
let composerEditing = false;
let composerValue = "";
let swallowNextComposerKeypress = false;
let selectedActionIndex = 0;
let threadDetailMode: "minimal" | "compact" | "verbose" = "minimal";
let lastRenderedThreadSignature = "";

const screen = blessed.screen({
  smartCSR: true,
  dockBorders: true,
  fullUnicode: true,
  autoPadding: false,
  warnings: false,
  title: "claudy-talky operator",
});

const originalHideCursor = screen.program.hideCursor.bind(screen.program);

const titleBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: {
    fg: "white",
    bg: "blue",
  },
});

const noticeBar = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: {
    fg: "black",
    bg: "cyan",
  },
});

const actionBar = blessed.box({
  parent: screen,
  top: 2,
  left: 0,
  width: "100%",
  height: 3,
  border: "line",
  label: " Actions ",
  style: {
    border: {
      fg: "blue",
    },
  },
});

const actionHint = blessed.box({
  parent: actionBar,
  top: 1,
  left: 1,
  width: "100%-2",
  height: 1,
  tags: true,
  style: {
    fg: "white",
  },
});

const actionStrip = blessed.box({
  parent: actionBar,
  top: 0,
  left: 1,
  width: "100%-2",
  height: 1,
  mouse: true,
  keys: true,
  style: {
    bg: "black",
  },
});

const leftPane = blessed.box({
  parent: screen,
  top: 5,
  left: 0,
  width: "30%",
  bottom: 3,
});

const rightPane = blessed.box({
  parent: screen,
  top: 5,
  left: "30%",
  width: "70%",
  bottom: 3,
});

const agentsList = blessed.list({
  parent: leftPane,
  label: " Agents ",
  top: 0,
  left: 0,
  width: "100%",
  height: "58%",
  border: "line",
  mouse: true,
  keys: true,
  vi: true,
  items: ["(no agents online)"],
  tags: false,
  scrollbar: {
    ch: " ",
    track: {
      bg: "gray",
    },
    style: {
      inverse: true,
    },
  },
  style: {
    border: {
      fg: "blue",
    },
    selected: {
      bg: "cyan",
      fg: "black",
      bold: true,
    },
    item: {
      hover: {
        bg: "blue",
      },
    },
  },
});

const roomsList = blessed.list({
  parent: leftPane,
  label: " Rooms ",
  top: "58%",
  left: 0,
  width: "100%",
  height: "42%",
  border: "line",
  mouse: true,
  keys: true,
  vi: true,
  items: ["(no rooms yet)"],
  tags: false,
  scrollbar: {
    ch: " ",
    track: {
      bg: "gray",
    },
    style: {
      inverse: true,
    },
  },
  style: {
    border: {
      fg: "blue",
    },
    selected: {
      bg: "cyan",
      fg: "black",
      bold: true,
    },
    item: {
      hover: {
        bg: "blue",
      },
    },
  },
});

const threadHeader = blessed.box({
  parent: rightPane,
  label: " Thread ",
  top: 0,
  left: 0,
  width: "100%",
  height: 4,
  border: "line",
  tags: true,
  style: {
    border: {
      fg: "blue",
    },
  },
});

const threadBox = blessed.scrollablebox({
  parent: rightPane,
  top: 4,
  left: 0,
  width: "100%",
  bottom: 0,
  border: "line",
  label: " Messages ",
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: false,
  scrollbar: {
    ch: " ",
    track: {
      bg: "gray",
    },
    style: {
      inverse: true,
    },
  },
  style: {
    border: {
      fg: "blue",
    },
  },
});

const composer = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: "line",
  label: " Composer ",
  mouse: true,
  keys: true,
  tags: false,
  style: {
    border: {
      fg: "green",
    },
    focus: {
      border: {
        fg: "yellow",
      },
    },
  },
});

const modal = blessed.scrollablebox({
  parent: screen,
  hidden: true,
  top: "center",
  left: "center",
  width: "78%",
  height: "70%",
  border: "line",
  label: " Details ",
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: false,
  padding: {
    left: 1,
    right: 1,
    top: 0,
    bottom: 0,
  },
  scrollbar: {
    ch: " ",
    track: {
      bg: "gray",
    },
    style: {
      inverse: true,
    },
  },
  style: {
    fg: "white",
    bg: "black",
    border: {
      fg: "yellow",
    },
  },
});

const actionCommands: OperatorAction[] = [
  { label: "DM selected", shortcut: "D", handler: () => openSelectedAgent() },
  { label: "Open room", shortcut: "O", handler: () => openSelectedRoom() },
  { label: "Reply", shortcut: "R", handler: () => switchReplyContext() },
  { label: "Leave", shortcut: "L", handler: () => leaveContext() },
  { label: "Refresh", shortcut: "F5", handler: () => fullRefresh() },
  { label: "Help", shortcut: "H", handler: () => showHelp() },
];

let actionLeft = 0;
for (const [index, action] of actionCommands.entries()) {
  const content = `[${action.shortcut}] ${action.label}`;
  const box = blessed.box({
    parent: actionStrip,
    top: 0,
    left: actionLeft,
    width: content.length + 2,
    height: 1,
    mouse: true,
    tags: false,
    content: ` ${content} `,
    style: {
      fg: "black",
      bg: "white",
      bold: true,
    },
  });

  box.on("click", () => {
    selectedActionIndex = index;
    focusPane("actions");
    void invokeSelectedAction();
  });

  action.box = box;
  actionLeft += content.length + 3;
}

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

function noticeColor(level: NoticeLevel): string {
  switch (level) {
    case "error":
      return "red";
    case "warn":
      return "yellow";
    default:
      return "cyan";
  }
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

function focusElementForPane(pane: FocusPane): { focus: () => void } {
  switch (pane) {
    case "actions":
      return actionStrip;
    case "agents":
      return agentsList;
    case "rooms":
      return roomsList;
    case "thread":
      return threadBox;
    case "composer":
      return composer;
  }
}

function focusPane(pane: FocusPane): void {
  activePane = pane;
  composerEditing = pane === "composer";
  focusElementForPane(pane).focus();
  if (pane === "actions") {
    setNotice("Actions focused. Use Left/Right to choose an action and Enter to run it.");
  }
  renderAll();
}

function isComposerFocused(): boolean {
  return activePane === "composer" || screen.focused === composer;
}

function cycleFocus(direction: 1 | -1): void {
  const panes: FocusPane[] = ["actions", "agents", "rooms", "thread", "composer"];
  const currentIndex = panes.indexOf(activePane);
  const nextIndex = (currentIndex + direction + panes.length) % panes.length;
  focusPane(panes[nextIndex]!);
}

function renderActions(): void {
  actionCommands.forEach((action, index) => {
    const box = action.box;
    if (!box) {
      return;
    }

    const isSelected = index === selectedActionIndex;
    const isFocused = activePane === "actions" && isSelected;
    box.setContent(` [${action.shortcut}] ${action.label} `);
    box.style.fg = isFocused ? "black" : isSelected ? "white" : "black";
    box.style.bg = isFocused ? "yellow" : isSelected ? "blue" : "white";
    box.style.bold = true;
  });
}

function renderPaneChrome(): void {
  actionBar.style.border.fg = activePane === "actions" ? "yellow" : "blue";
  agentsList.style.border.fg = activePane === "agents" ? "yellow" : "blue";
  roomsList.style.border.fg = activePane === "rooms" ? "yellow" : "blue";
  threadHeader.style.border.fg = activePane === "thread" ? "yellow" : "blue";
  threadBox.style.border.fg = activePane === "thread" ? "yellow" : "blue";
  composer.style.border.fg = activePane === "composer" ? "yellow" : "green";
}

function closeModal(): void {
  if (!helpModalOpen) {
    return;
  }

  helpModalOpen = false;
  modal.hide();
  (modalReturnFocus ?? focusElementForPane(activePane)).focus();
  renderAll();
}

function showModal(title: string, content: string): void {
  modal.setLabel(` ${title} `);
  modal.setContent(`${content}\n\nEsc, Enter, or q to close`);
  modal.scrollTo(0);
  modalReturnFocus = focusElementForPane(activePane);
  helpModalOpen = true;
  modal.show();
  modal.focus();
  renderAll();
}

function renderTitleBar(): void {
  const liveAgents = agentCache.size;
  titleBar.setContent(
    ` claudy-talky operator | you ${myId || "(registering)"} | ${contextLabel()} | ${liveAgents} agent(s) online `
  );
  noticeBar.style.bg = noticeColor(lastNoticeLevel);
  noticeBar.style.fg = lastNoticeLevel === "warn" ? "black" : "white";
  noticeBar.setContent(` ${lastNotice}`);
  actionHint.setContent(
    `Tab cycles panes. Use Left/Right + Enter on Actions. Type directly in the composer. [V] details: ${threadDetailMode}.`
  );
}

function renderAgents(): void {
  const previousSelected = selectedAgentIds[agentsList.selected] ?? null;
  const agents = [...agentCache.values()].sort((left, right) => {
    const unreadDelta = right.unread_count - left.unread_count;
    if (unreadDelta !== 0) {
      return unreadDelta;
    }

    return left.name.localeCompare(right.name);
  });

  selectedAgentIds = agents.map((agent) => agent.id);
  if (agents.length === 0) {
    agentsList.setItems(["(no agents online)"]);
    agentsList.select(0);
    return;
  }

  agentsList.setItems(agents.map(formatAgentListItem));

  const preferredId =
    currentContext.kind === "dm"
      ? currentContext.agentId
      : previousSelected;
  const preferredIndex = preferredId ? selectedAgentIds.indexOf(preferredId) : -1;
  agentsList.select(preferredIndex >= 0 ? preferredIndex : 0);
}

function renderRooms(): void {
  const previousSelected = selectedRoomConversationIds[roomsList.selected] ?? null;
  const rooms = [...roomsByConversationId.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  selectedRoomConversationIds = rooms.map((room) => room.conversationId);
  if (rooms.length === 0) {
    roomsList.setItems(["(no rooms yet)"]);
    roomsList.select(0);
    return;
  }

  roomsList.setItems(rooms.map(formatRoomListItem));

  const preferredConversationId =
    currentContext.kind === "room"
      ? currentContext.conversationId
      : previousSelected;
  const preferredIndex = preferredConversationId
    ? selectedRoomConversationIds.indexOf(preferredConversationId)
    : -1;
  roomsList.select(preferredIndex >= 0 ? preferredIndex : 0);
}

function renderThread(): void {
  if (currentContext.kind === "none") {
    lastRenderedThreadSignature = "";
    threadHeader.setContent(
      "No active context.\n\nSelect an agent to open a DM, create a room with `/room create`, or use `/msg <agent> <text>`."
    );
    threadBox.setContent(
      [
        "Ready.",
        "",
        "Quick actions:",
        "- Click an agent row or press Enter on one to open a DM",
        "- Click a room row or press Enter to reopen it",
        "- Use `/reply` to jump to the last inbound sender",
        "- Use `/leave` to clear the current context",
      ].join("\n")
    );
    threadBox.scrollTo(0);
    return;
  }

  if (currentContext.kind === "dm") {
    const agent = agentCache.get(currentContext.agentId);
    const conversationId = dmConversationByAgentId.get(currentContext.agentId);
    threadHeader.setContent(
      `DM with ${participantDisplay(currentContext.agentId)}\nConversation: ${conversationId ?? "(new conversation on next send)"}\nSummary: ${agent?.summary ?? "(none)"}`
    );
  } else {
    const room = roomsByConversationId.get(currentContext.conversationId);
    threadHeader.setContent(
      `Room ${room?.name ?? currentContext.conversationId}\nConversation: ${currentContext.conversationId}\nParticipants: ${room?.participantIds.map(participantDisplay).join(", ") ?? "(unknown)"}`
    );
  }

  if (currentMessages.length === 0) {
    lastRenderedThreadSignature = "";
    threadBox.setContent("No messages in the current context.");
    threadBox.scrollTo(0);
    return;
  }

  const orderedMessages = sortMessagesChronologically(currentMessages);
  const content = orderedMessages.map(formatMessageForThread).join("\n\n");
  if (content !== lastRenderedThreadSignature) {
    threadBox.setContent(content);
    threadBox.setScrollPerc(100);
    lastRenderedThreadSignature = content;
  }
}

function renderComposer(): void {
  const prompt = "> ";
  const innerWidth =
    typeof composer.width === "number" && typeof composer.ileft === "number" && typeof composer.iright === "number"
      ? Math.max(8, composer.width - composer.ileft - composer.iright - prompt.length - 1)
      : 80;
  const visibleValue =
    composerValue.length > innerWidth
      ? composerValue.slice(composerValue.length - innerWidth)
      : composerValue;

  composer.setLabel(
    ` Composer | ${contextLabel()}${composerEditing ? " | editing" : ""} `
  );
  composer.setContent(`${prompt}${visibleValue}`);
}

function syncComposerCursor(): void {
  if (!isComposerFocused()) {
    originalHideCursor();
    return;
  }

  const coords = composer._getCoords?.();
  if (!coords) {
    originalHideCursor();
    return;
  }

  const prompt = "> ";
  const innerWidth =
    typeof composer.width === "number" && typeof composer.ileft === "number" && typeof composer.iright === "number"
      ? Math.max(8, composer.width - composer.ileft - composer.iright - prompt.length - 1)
      : 80;
  const visibleLength = Math.min(composerValue.length, innerWidth);
  const cursorX = coords.xi + composer.ileft + prompt.length + visibleLength;
  const cursorY = coords.yi + composer.itop;

  screen.program.cursorShape?.("line", false);
  screen.program.cup(cursorY, cursorX);
  screen.program.showCursor();
}

function renderAll(): void {
  renderActions();
  renderPaneChrome();
  renderTitleBar();
  renderAgents();
  renderRooms();
  renderThread();
  renderComposer();
  screen.render();
  syncComposerCursor();
}

function moveSelectedAction(direction: 1 | -1): void {
  selectedActionIndex =
    (selectedActionIndex + direction + actionCommands.length) % actionCommands.length;
  if (activePane !== "actions") {
    activePane = "actions";
  }
  renderAll();
}

async function invokeSelectedAction(): Promise<void> {
  const action = actionCommands[selectedActionIndex];
  if (!action) {
    return;
  }

  try {
    await Promise.resolve(action.handler());
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
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
    transport: "cli-tui",
    cwd: cwd(),
    summary: "Interactive human operator TUI session.",
    capabilities: ["messaging", "message_history", "operator_console", "mouse_ui"],
    metadata: {
      client: "claudy-talky Operator",
      launcher: "bun",
      adapter: "claudy-talky",
      workspace_source: "process.cwd",
      notification_styles: ["tui", "stdout"],
    },
  });

  myId = response.id;
  authToken = response.auth_token;
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  return brokerFetch<T>(BROKER_URL, path, body);
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
    renderAll();
    return;
  }

  const history = await messageHistoryCompatible(BROKER_URL, currentContextRequest(limit));
  currentMessages = sortMessagesChronologically(history.messages);
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
  }

  await refreshAgents();
  renderAll();
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
  renderAll();
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
  focusPane("composer");
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
  setNotice(`Created room ${room.name} with ${room.participantIds.length} participant(s).`);
  renderAll();
  focusPane("composer");
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
  focusPane("composer");
}

function leaveContext(): void {
  if (currentContext.kind === "none") {
    setNotice("No active context.", "warn");
    renderAll();
    return;
  }

  currentContext = { kind: "none" };
  currentMessages = [];
  setNotice("Context cleared.");
  renderAll();
  focusPane("agents");
}

function showParticipants(): void {
  if (currentContext.kind === "none") {
    showModal("Participants", "No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const agent = agentCache.get(currentContext.agentId);
    showModal(
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
  showModal("Participants", lines.join("\n"));
}

function showContext(): void {
  if (currentContext.kind === "none") {
    showModal("Current Context", "No active context.");
    return;
  }

  if (currentContext.kind === "dm") {
    const conversationId = dmConversationByAgentId.get(currentContext.agentId);
    showModal(
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
  showModal(
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
  showModal("Help", operatorHelpText());
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
  const selectedId = selectedAgentIds[agentsList.selected];
  if (!selectedId) {
    setNotice("No live agent selected.", "warn");
    renderAll();
    return;
  }

  await switchDmById(selectedId);
}

async function openSelectedRoom(): Promise<void> {
  const selectedConversationId = selectedRoomConversationIds[roomsList.selected];
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
      renderAll();
      focusPane("agents");
      return;
    case "rooms":
      setNotice("Rooms pane focused.");
      renderAll();
      focusPane("rooms");
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
  composerValue = "";
  renderAll();

  if (!value) {
    setNotice("Composer cleared.", "warn");
    renderAll();
    focusPane("composer");
    return;
  }

  await runCommand(parseOperatorInput(value));
  focusPane("composer");
}

async function shutdown(code: number): Promise<never> {
  if (shuttingDown) {
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

  screen.program.cursorReset?.();
  screen.program.showCursor();
  screen.destroy();
  exit(code);
}

function wireFocusTracking(): void {
  actionStrip.on("focus", () => {
    activePane = "actions";
    composerEditing = false;
    renderAll();
  });
  agentsList.on("focus", () => {
    activePane = "agents";
    composerEditing = false;
    renderAll();
  });
  roomsList.on("focus", () => {
    activePane = "rooms";
    composerEditing = false;
    renderAll();
  });
  threadBox.on("focus", () => {
    activePane = "thread";
    composerEditing = false;
    renderAll();
  });
  composer.on("focus", () => {
    activePane = "composer";
    composerEditing = true;
    renderAll();
  });
}

function wireKeyboardShortcuts(): void {
  screen.key(["C-c"], () => {
    void shutdown(0);
  });

  screen.key(["tab"], () => {
    if (helpModalOpen) {
      return;
    }

    cycleFocus(1);
  });

  screen.key(["S-tab"], () => {
    if (helpModalOpen) {
      return;
    }

    cycleFocus(-1);
  });

  screen.key(["left"], () => {
    if (helpModalOpen || activePane !== "actions") {
      return;
    }

    moveSelectedAction(-1);
  });

  screen.key(["right"], () => {
    if (helpModalOpen || activePane !== "actions") {
      return;
    }

    moveSelectedAction(1);
  });

  screen.key(["enter"], () => {
    if (helpModalOpen || activePane !== "actions") {
      return;
    }

    void invokeSelectedAction();
  });

  screen.key(["/"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }

    composerValue = "/";
    swallowNextComposerKeypress = true;
    focusPane("composer");
  });

  screen.key(["C-r"], () => {
    if (helpModalOpen) {
      return;
    }

    void switchReplyContext().catch((error) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });

  screen.key(["C-l"], () => {
    if (helpModalOpen) {
      closeModal();
      return;
    }

    leaveContext();
  });

  screen.key(["f5"], () => {
    if (helpModalOpen) {
      return;
    }

    void fullRefresh().catch((error) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });

  screen.key(["a"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }
    focusPane("agents");
  });

  screen.key(["r"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }
    focusPane("rooms");
  });

  screen.key(["m"], () => {
    if (helpModalOpen) {
      return;
    }
    focusPane("composer");
  });

  screen.key(["C-a"], () => {
    if (helpModalOpen) {
      return;
    }
    focusPane("actions");
  });

  screen.key(["x"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }
    focusPane("actions");
  });

  screen.key(["h"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }
    showHelp();
  });

  screen.key(["v"], () => {
    if (helpModalOpen || isComposerFocused()) {
      return;
    }

    cycleThreadDetailMode();
    setNotice(`Message details: ${threadDetailMode}.`);
    renderAll();
  });

  modal.key(["escape", "enter", "q"], () => {
    closeModal();
  });

  screen.on("keypress", (ch: string, key: { ctrl?: boolean; meta?: boolean; name?: string }) => {
    if (helpModalOpen || !isComposerFocused()) {
      return;
    }

    if (swallowNextComposerKeypress) {
      swallowNextComposerKeypress = false;
      renderAll();
      return;
    }

    if (key.ctrl && key.name === "a") {
      focusPane("actions");
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (key.name === "escape") {
      composerValue = "";
      composerEditing = false;
      focusPane("agents");
      return;
    }

    if (key.name === "backspace") {
      composerValue = composerValue.slice(0, -1);
      renderAll();
      return;
    }

    if (key.name === "enter") {
      void handleComposerSubmit(composerValue).catch((error) => {
        showError(error instanceof Error ? error.message : String(error));
        focusPane("composer");
      });
      return;
    }

    if (key.name === "tab") {
      cycleFocus(1);
      return;
    }

    if (key.name === "linefeed") {
      return;
    }

    if (typeof ch === "string" && ch.length > 0) {
      composerValue += ch;
      renderAll();
    }
  });
}

function wireInteractions(): void {
  agentsList.on("select", () => {
    void openSelectedAgent().catch((error) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });

  roomsList.on("select", () => {
    void openSelectedRoom().catch((error) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });

  composer.on("click", () => {
    focusPane("composer");
  });
}

async function main(): Promise<void> {
  await registerOperator();
  await refreshAgents();

  setNotice(`Connected to ${BROKER_URL} as ${myId}.`);
  wireFocusTracking();
  wireKeyboardShortcuts();
  wireInteractions();

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      showError(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  const pollTimer = setInterval(() => {
    void pollInbox();
  }, POLL_INTERVAL_MS);

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

  renderAll();
  focusPane("agents");
}

try {
  await main();
} catch (error) {
  console.error(
    `Operator startup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  exit(1);
}

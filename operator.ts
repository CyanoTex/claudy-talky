#!/usr/bin/env bun

import React, {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
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
  filterLikelyStaleDuplicateAgents,
  resolveAgentSelector,
  type AgentRefRecord,
} from "./shared/operator-agent-ref.ts";
import { parseOperatorInput, type OperatorCommand } from "./shared/operator-command.ts";
import { resolveRoomParticipantIds } from "./shared/operator-room.ts";
import {
  formatWorkDetailLines,
  formatWorkListLine,
} from "./shared/work-format.ts";
import type {
  Agent,
  AssignWorkResponse,
  GetWorkResponse,
  HandoffWorkResponse,
  ListWorkResponse,
  Message,
  MessageHistoryRequest,
  PollMessagesResponse,
  QueueWorkResponse,
  RemoveAgentAdminResponse,
  SendMessageResponse,
  UpdateWorkStatusResponse,
  UnregisterRequest,
} from "./shared/types.ts";

type OperatorRoom = { name: string; conversationId: string; participantIds: string[] };
type OperatorContext = { kind: "none" } | { kind: "dm"; agentId: string } | { kind: "room"; conversationId: string };
type FocusPane = "actions" | "agents" | "rooms" | "thread" | "composer";
type NoticeLevel = "info" | "warn" | "error";
type ThreadMode = "minimal" | "compact" | "verbose";
type DetailPanel = { title: string; lines: string[] } | null;

type State = {
  myId: string;
  authToken?: string;
  agentCache: Map<string, Agent>;
  agentRefs: AgentRefRecord[];
  rooms: Map<string, OperatorRoom>;
  dmConversations: Map<string, string>;
  currentContext: OperatorContext;
  currentMessages: Message[];
  currentLimit: number;
  selectedAgentId: string | null;
  selectedRoomId: string | null;
  lastIncomingSenderId: string | null;
  lastNotice: string;
  lastNoticeLevel: NoticeLevel;
  activePane: FocusPane;
  selectedActionIndex: number;
  composerValue: string;
  detailPanel: DetailPanel;
  threadMode: ThreadMode;
  threadScrollOffset: number;
  pollInFlight: boolean;
  shuttingDown: boolean;
};

const BROKER_URL = `http://127.0.0.1:${getBrokerPort()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const ROOM_HISTORY_SCAN_LIMIT = 100;
const DEFAULT_THREAD_HISTORY_LIMIT = 60;

const initialState: State = {
  myId: "",
  authToken: undefined,
  agentCache: new Map(),
  agentRefs: [],
  rooms: new Map(),
  dmConversations: new Map(),
  currentContext: { kind: "none" },
  currentMessages: [],
  currentLimit: DEFAULT_THREAD_HISTORY_LIMIT,
  selectedAgentId: null,
  selectedRoomId: null,
  lastIncomingSenderId: null,
  lastNotice: "Starting Ink remake…",
  lastNoticeLevel: "info",
  activePane: "agents",
  selectedActionIndex: 0,
  composerValue: "",
  detailPanel: null,
  threadMode: "minimal",
  threadScrollOffset: 0,
  pollInFlight: false,
  shuttingDown: false,
};

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id);
}

function roomConversationId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `room-${slug || "chat"}-${crypto.randomUUID().slice(0, 8)}`;
}

function truncate(text: string, width: number): string {
  const chars = Array.from(text);
  if (width <= 0) return "";
  if (chars.length <= width) return text;
  return width === 1 ? chars[0] ?? "" : `${chars.slice(0, width - 1).join("")}…`;
}

function wrapBlock(lines: string[], width: number): string[] {
  if (width <= 0) return [""];
  return lines.flatMap((line) => {
    const chars = Array.from(line);
    if (chars.length === 0) return [""];
    const wrapped: string[] = [];
    for (let i = 0; i < chars.length; i += width) wrapped.push(chars.slice(i, i + width).join(""));
    return wrapped;
  });
}

function windowAround<T>(items: T[], selectedIndex: number, count: number): T[] {
  if (count <= 0) return [];
  const idx = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  const maxStart = Math.max(0, items.length - count);
  const start = Math.max(0, Math.min(idx - Math.floor(count / 2), maxStart));
  return items.slice(start, start + count);
}

function helpLines(): string[] {
  return [
    "Slash commands: /help /leave /agents /rooms /reply /details [minimal|compact|verbose]",
    "/tasks",
    "/queue <summary> /queue-work <summary>",
    "/handoff <agent> <summary> /handoff-work <agent> <summary>",
    "/assign <work-id> <agent> [note] /assign-work <work-id> <agent> [note] /requeue <work-id> [note]",
    "/work [open|all|mine|queued|assigned|active|blocked|done|<id>] /list-work ... /get-work <work-id>",
    "/take <work-id> /block <work-id> <reason> /done <work-id> [note] /activate <work-id> [note]",
    "/update-work-status <work-id> <take|block|done|activate> [note]",
    "/dm <agent> [message] /msg <agent> <message>",
    "/room create <name> <agent...|all> /room use <name-or-conversation-id>",
    "/participants /context /history [limit] /quit /exit",
    "",
    "Keyboard: Tab cycles actions, agents, rooms, thread, and composer. Enter opens or submits.",
    "Esc leaves composer. Ctrl+A focuses actions. Ctrl+C exits.",
    "d opens selected DM, o opens selected room, Ctrl+R replies, l leaves context, f refreshes",
    "a focuses agents, r focuses rooms, t focuses thread, m focuses composer, h opens help, v cycles detail mode",
  ];
}

const ACTION_ITEMS = [
  { label: "DM selected", shortcut: "D" },
  { label: "Open room", shortcut: "O" },
  { label: "Reply", shortcut: "R" },
  { label: "Leave", shortcut: "L" },
  { label: "Refresh", shortcut: "F" },
  { label: "Tasks", shortcut: "T" },
  { label: "Remove agent", shortcut: "X" },
  { label: "Help", shortcut: "H" },
] as const;

function buildThreadContentLines(
  state: State,
  participantDisplay: (agentId: string) => string,
  participantName: (agentId: string) => string
): string[] {
  if (state.detailPanel) return state.detailPanel.lines;
  if (state.currentContext.kind === "none") {
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
  if (state.currentMessages.length === 0) return ["No messages in the current context."];
  return sortMessages(state.currentMessages).flatMap((message, index) => {
    const block =
      state.threadMode === "minimal"
        ? [
            `[${message.sent_at.slice(0, 19).replace("T", " ")}] ${
              message.from_id === state.myId
                ? "Me"
                : state.currentContext.kind === "dm"
                  ? participantName(state.currentContext.agentId)
                  : participantName(message.from_id)
            }`,
            ...message.text.split(/\r?\n/),
          ]
        : (() => {
            const lines = [
              `[${message.sent_at}] #${message.id} ${participantDisplay(message.from_id)} -> ${participantDisplay(message.to_id)}`,
              ...message.text.split(/\r?\n/).map((line) => `  ${line}`),
            ];
            if (message.reply_to_message_id && state.threadMode === "compact") lines.push(`  Reply to #${message.reply_to_message_id}`);
            if (state.threadMode === "verbose") appendMessageStateLines(lines, message);
            return lines;
          })();
    return [...(index > 0 ? [""] : []), ...block];
  });
}

function Panel(props: {
  title: string;
  focused: boolean;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  lines: { text: string; selected?: boolean; color?: "blue" | "cyan" | "green" | "magenta" | "red" | "white" | "yellow"; dim?: boolean }[];
}): ReactElement {
  const borderColor = props.focused ? "yellow" : "blue";
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor, paddingX: 1, width: props.width, height: props.height, flexGrow: props.flexGrow },
    h(Text, { color: borderColor, bold: true }, props.title),
    ...props.lines.map((line, index) =>
      h(Text, { key: `${props.title}-${index}`, inverse: line.selected, color: line.color, dimColor: line.dim }, line.text)
    ),
    h(Box, { flexGrow: 1 })
  );
}

function sortedAgents(state: State): Agent[] {
  return [...state.agentCache.values()].sort((left, right) => {
    const unreadDelta = right.unread_count - left.unread_count;
    if (unreadDelta !== 0) return unreadDelta;
    return left.name.localeCompare(right.name);
  });
}

function sortedRooms(state: State): OperatorRoom[] {
  return [...state.rooms.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function currentConversationId(state: State): string | null {
  if (state.currentContext.kind === "room") {
    return state.currentContext.conversationId;
  }

  if (state.currentContext.kind === "dm") {
    return state.dmConversations.get(state.currentContext.agentId) ?? null;
  }

  return null;
}

function App(): ReactElement {
  const { exit: appExit } = useApp();
  const [state, setState] = useState<State>(initialState);
  const stateRef = useRef(state);
  const [size, setSize] = useState({ columns: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 });

  const updateState = useCallback((updater: (prev: State) => State) => {
    setState((prev) => {
      const next = updater(prev);
      stateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const onResize = () => setSize({ columns: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const setNotice = useCallback((message: string, level: NoticeLevel = "info") => {
    updateState((prev) => ({ ...prev, lastNotice: message, lastNoticeLevel: level }));
  }, [updateState]);

  const participantName = useCallback((agentId: string) => stateRef.current.agentCache.get(agentId)?.name ?? agentId, []);
  const participantRef = useCallback((agentId: string) => stateRef.current.agentRefs.find((record) => record.agent.id === agentId)?.ref ?? null, []);
  const participantDisplay = useCallback((agentId: string) => {
    const ref = participantRef(agentId);
    const name = participantName(agentId);
    return ref ? `${ref} | ${name}` : name;
  }, [participantName, participantRef]);

  const brokerPost = useCallback(async <T,>(path: string, body: unknown) => brokerFetch<T>(BROKER_URL, path, body), []);

  const refreshAgents = useCallback(async (): Promise<Agent[]> => {
    const current = stateRef.current;
    const fetchedAgents = await listAgentsCompatible(BROKER_URL, { scope: "machine", exclude_id: current.myId || undefined });
    const agents = filterLikelyStaleDuplicateAgents(fetchedAgents);
    const agentCache = new Map(agents.map((agent) => [agent.id, agent]));
    const agentRefs = buildAgentRefRecords(agents);
    updateState((prev) => ({
      ...prev,
      agentCache,
      agentRefs,
      selectedAgentId:
        agents.some((agent) => agent.id === (prev.currentContext.kind === "dm" ? prev.currentContext.agentId : prev.selectedAgentId))
          ? (prev.currentContext.kind === "dm" ? prev.currentContext.agentId : prev.selectedAgentId)
          : agents[0]?.id ?? null,
    }));
    return agents;
  }, [updateState]);

  const rememberDmConversation = useCallback((agentId: string, conversationId: string | null | undefined) => {
    if (!conversationId) return;
    updateState((prev) => {
      const next = new Map(prev.dmConversations);
      next.set(agentId, conversationId);
      return { ...prev, dmConversations: next };
    });
  }, [updateState]);

  const loadCurrentHistory = useCallback(async (limit = stateRef.current.currentLimit): Promise<void> => {
    const current = stateRef.current;
    if (current.currentContext.kind === "none") {
      updateState((prev) => ({ ...prev, currentMessages: [], currentLimit: limit, detailPanel: null, threadScrollOffset: 0 }));
      return;
    }
    const request: MessageHistoryRequest = { agent_id: current.myId, limit, mark_opened: true, auth_token: current.authToken };
    if (current.currentContext.kind === "dm") request.with_agent_id = current.currentContext.agentId;
    else request.conversation_id = current.currentContext.conversationId;
    const history = await messageHistoryCompatible(BROKER_URL, request);
    await refreshAgents();
    updateState((prev) => ({ ...prev, currentMessages: sortMessages(history.messages), currentLimit: limit, detailPanel: null, threadScrollOffset: 0 }));
  }, [refreshAgents, updateState]);

  const showDetail = useCallback((title: string, lines: string[]) => {
    updateState((prev) => ({ ...prev, detailPanel: { title, lines }, activePane: "thread", threadScrollOffset: 0 }));
  }, [updateState]);

  const sendDirectMessage = useCallback(async (agentId: string, text: string): Promise<void> => {
    const current = stateRef.current;
    const result = await brokerPost<SendMessageResponse>("/send-message", {
      from_id: current.myId,
      to_id: agentId,
      text,
      conversation_id: current.dmConversations.get(agentId),
      auth_token: current.authToken,
    });
    if (!result.ok || !result.message) throw new Error(result.error ?? `Failed to send message to ${agentId}`);
    const sentMessage = result.message;
    rememberDmConversation(agentId, sentMessage.conversation_id);
    updateState((prev) => ({
      ...prev,
      currentMessages:
        prev.currentContext.kind === "dm" && prev.currentContext.agentId === agentId
          ? sortMessages([...prev.currentMessages, sentMessage])
          : prev.currentMessages,
    }));
    setNotice(`Sent message #${sentMessage.id} to ${participantDisplay(agentId)}.`);
    await refreshAgents();
  }, [brokerPost, participantDisplay, refreshAgents, rememberDmConversation, setNotice, updateState]);

  const sendRoomMessage = useCallback(async (room: OperatorRoom, text: string): Promise<void> => {
    const liveAgents = await refreshAgents();
    const liveIds = new Set(liveAgents.map((agent) => agent.id));
    const targets = room.participantIds.filter((id) => liveIds.has(id));
    if (targets.length === 0) throw new Error(`Room ${room.name} has no live participants`);
    const current = stateRef.current;
    const settled = await Promise.allSettled(targets.map((agentId) =>
      brokerPost<SendMessageResponse>("/send-message", {
        from_id: current.myId,
        to_id: agentId,
        text,
        conversation_id: room.conversationId,
        auth_token: current.authToken,
      })
    ));
    const sentMessages: Message[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value.ok && outcome.value.message) {
        sentMessages.push(outcome.value.message);
      }
    }
    updateState((prev) => ({
      ...prev,
      currentMessages:
        prev.currentContext.kind === "room" && prev.currentContext.conversationId === room.conversationId
          ? sortMessages([...prev.currentMessages, ...sentMessages])
          : prev.currentMessages,
    }));
    setNotice(`Sent ${sentMessages.length} room message(s) to ${targets.length} participant(s).`);
  }, [brokerPost, refreshAgents, setNotice, updateState]);

  const sendInCurrentContext = useCallback(async (text: string) => {
    const current = stateRef.current;
    if (current.currentContext.kind === "none") throw new Error("No active context. Select an agent or room first.");
    if (current.currentContext.kind === "dm") return sendDirectMessage(current.currentContext.agentId, text);
    const room = current.rooms.get(current.currentContext.conversationId);
    if (!room) throw new Error(`Room ${current.currentContext.conversationId} is not available in this session`);
    return sendRoomMessage(room, text);
  }, [sendDirectMessage, sendRoomMessage]);

  const switchDmById = useCallback(async (agentId: string) => {
    if (!agentId) throw new Error("No live agent selected.");
    await refreshAgents();
    const current = stateRef.current;
    const target = current.agentCache.get(agentId);
    if (!target) throw new Error(`Agent ${agentId} is no longer online.`);
    const history = await messageHistoryCompatible(BROKER_URL, { agent_id: current.myId, with_agent_id: target.id, limit: 1, auth_token: current.authToken });
    rememberDmConversation(target.id, history.messages[0]?.conversation_id);
    updateState((prev) => ({
      ...prev,
      currentContext: { kind: "dm", agentId: target.id },
      selectedAgentId: target.id,
      activePane: "composer",
      detailPanel: null,
      threadScrollOffset: 0,
    }));
    setNotice(`Opened DM with ${participantDisplay(target.id)}.`);
    await loadCurrentHistory(DEFAULT_THREAD_HISTORY_LIMIT);
  }, [loadCurrentHistory, participantDisplay, refreshAgents, rememberDmConversation, setNotice, updateState]);

  const switchDm = useCallback(async (selector: string) => {
    await refreshAgents();
    const resolution = resolveAgentSelector(stateRef.current.agentRefs, selector);
    if (!resolution.ok) throw new Error(resolution.error);
    await switchDmById(resolution.record.agent.id);
  }, [refreshAgents, switchDmById]);

  const switchReplyContext = useCallback(async () => {
    if (!stateRef.current.lastIncomingSenderId) throw new Error("No inbound sender to reply to yet.");
    await switchDmById(stateRef.current.lastIncomingSenderId);
  }, [switchDmById]);

  const resolveRoomParticipants = useCallback(async (selectors: string[]) => {
    await refreshAgents();
    if (selectors.includes("all")) return stateRef.current.agentRefs.map((record) => record.agent.id);
    const ids: string[] = [];
    for (const selector of selectors) {
      const resolution = resolveAgentSelector(stateRef.current.agentRefs, selector);
      if (!resolution.ok) throw new Error(resolution.error);
      if (resolution.record.agent.id !== stateRef.current.myId) ids.push(resolution.record.agent.id);
    }
    return Array.from(new Set(ids));
  }, [refreshAgents]);

  const createRoom = useCallback(async (name: string, selectors: string[]) => {
    const participantIds = await resolveRoomParticipants(selectors);
    if (participantIds.length === 0) throw new Error("Room needs at least one live participant.");
    const room = { name, conversationId: roomConversationId(name), participantIds };
    updateState((prev) => {
      const rooms = new Map(prev.rooms);
      rooms.set(room.conversationId, room);
      return {
        ...prev,
        rooms,
        currentContext: { kind: "room", conversationId: room.conversationId },
        selectedRoomId: room.conversationId,
        activePane: "composer",
        currentMessages: [],
        detailPanel: null,
        threadScrollOffset: 0,
      };
    });
    setNotice(`Created room ${room.name} with ${room.participantIds.length} participant(s).`);
  }, [resolveRoomParticipants, setNotice, updateState]);

  const loadRoomFromHistory = useCallback(async (conversationId: string) => {
    const current = stateRef.current;
    const history = await messageHistoryCompatible(BROKER_URL, {
      agent_id: current.myId,
      conversation_id: conversationId,
      limit: ROOM_HISTORY_SCAN_LIMIT,
      mark_opened: true,
      auth_token: current.authToken,
    });
    if (history.messages.length === 0) return null;
    await refreshAgents();
    const participantIds = resolveRoomParticipantIds(history.messages, stateRef.current.myId, stateRef.current.agentCache.keys());
    if (participantIds.length === 0) return null;
    const room = { name: conversationId, conversationId, participantIds };
    updateState((prev) => {
      const rooms = new Map(prev.rooms);
      rooms.set(conversationId, room);
      return { ...prev, rooms };
    });
    return room;
  }, [refreshAgents, updateState]);

  const useRoom = useCallback(async (roomRef: string) => {
    if (!roomRef) throw new Error("No room selected.");
    const direct = [...stateRef.current.rooms.values()].find((room) => room.name === roomRef || room.conversationId === roomRef);
    const room = direct ?? (await loadRoomFromHistory(roomRef));
    if (!room) throw new Error(`Room ${roomRef} is not known in this session and has no visible history.`);
    updateState((prev) => ({
      ...prev,
      currentContext: { kind: "room", conversationId: room.conversationId },
      selectedRoomId: room.conversationId,
      activePane: "composer",
      detailPanel: null,
      threadScrollOffset: 0,
    }));
    setNotice(`Opened room ${room.name}.`);
    await loadCurrentHistory(DEFAULT_THREAD_HISTORY_LIMIT);
  }, [loadCurrentHistory, loadRoomFromHistory, setNotice, updateState]);

  const leaveContext = useCallback(() => {
    if (stateRef.current.currentContext.kind === "none") return setNotice("No active context.", "warn");
    updateState((prev) => ({ ...prev, currentContext: { kind: "none" }, currentMessages: [], activePane: "agents", detailPanel: null, threadScrollOffset: 0 }));
    setNotice("Context cleared.");
  }, [setNotice, updateState]);

  const showParticipants = useCallback(() => {
    const current = stateRef.current;
    if (current.currentContext.kind === "none") return showDetail("Participants", ["No active context."]);
    if (current.currentContext.kind === "dm") {
      const agent = current.agentCache.get(current.currentContext.agentId);
      return showDetail("Participants", [
        "Participants:",
        `- you (${current.myId})`,
        `- ${participantRef(current.currentContext.agentId) ?? current.currentContext.agentId} | ${agent?.name ?? current.currentContext.agentId} (${current.currentContext.agentId})`,
      ]);
    }
    const room = current.rooms.get(current.currentContext.conversationId);
    return showDetail("Participants", [
      `Participants for room:${room?.name ?? current.currentContext.conversationId}:`,
      `- you (${current.myId})`,
      ...(room?.participantIds ?? []).map((id) => `- ${participantDisplay(id)} (${id})`),
    ]);
  }, [participantDisplay, participantRef, showDetail]);

  const showContext = useCallback(() => {
    const current = stateRef.current;
    if (current.currentContext.kind === "none") return showDetail("Current Context", ["No active context."]);
    if (current.currentContext.kind === "dm") {
      return showDetail("Current Context", [
        "Type: DM",
        `Agent: ${participantDisplay(current.currentContext.agentId)} (${current.currentContext.agentId})`,
        `Conversation: ${current.dmConversations.get(current.currentContext.agentId) ?? "(new conversation on next send)"}`,
      ]);
    }
    const room = current.rooms.get(current.currentContext.conversationId);
    return showDetail("Current Context", [
      "Type: room",
      `Name: ${room?.name ?? current.currentContext.conversationId}`,
      `Conversation: ${current.currentContext.conversationId}`,
      `Participants: ${room?.participantIds.map((id) => participantDisplay(id)).join(", ") ?? "(unknown)"}`,
    ]);
  }, [participantDisplay, showDetail]);

  const showHistory = useCallback(async (limit: number) => {
    if (stateRef.current.currentContext.kind === "none") throw new Error("No active context. Select an agent or room first.");
    await loadCurrentHistory(limit);
    setNotice(`Loaded ${limit} message(s) for the current context.`);
  }, [loadCurrentHistory, setNotice]);

  const showWorkList = useCallback(async (
    filter: "open" | "all" | "mine" | "queued" | "assigned" | "active" | "blocked" | "done"
  ) => {
    const current = stateRef.current;
    const request: Record<string, unknown> = {
      agent_id: current.myId,
      auth_token: current.authToken,
      limit: 50,
    };

    switch (filter) {
      case "mine":
        request.owner_id = current.myId;
        break;
      case "queued":
      case "assigned":
      case "active":
      case "blocked":
      case "done":
        request.status = filter;
        break;
      case "all":
        request.include_done = true;
        break;
      case "open":
      default:
        request.include_done = false;
        break;
    }

    const result = await brokerPost<ListWorkResponse>("/list-work", request);
    const lines =
      result.work_items.length === 0
        ? ["No work items found."]
        : result.work_items.map((work) => `- ${formatWorkListLine(work, participantDisplay)}`);

    showDetail(`Work (${filter})`, lines);
  }, [brokerPost, participantDisplay, showDetail]);

  const showTasksOverview = useCallback(async () => {
    const current = stateRef.current;
    const result = await brokerPost<ListWorkResponse>("/list-work", {
      agent_id: current.myId,
      include_done: false,
      limit: 100,
      auth_token: current.authToken,
    });

    const sections: Array<{ title: string; items: typeof result.work_items }> = [
      { title: "Queued", items: result.work_items.filter((work) => work.status === "queued") },
      { title: "Assigned", items: result.work_items.filter((work) => work.status === "assigned") },
      { title: "Active", items: result.work_items.filter((work) => work.status === "active") },
      { title: "Blocked", items: result.work_items.filter((work) => work.status === "blocked") },
    ];

    const lines: string[] = [
      "Quick commands:",
      "- /work <id> or /get-work <id>",
      "- /take <id>",
      "- /assign <id> <agent> [note]",
      "- /requeue <id> [note]",
      "- /block <id> <reason>",
      "- /done <id> [note]",
    ];

    const total = sections.reduce((count, section) => count + section.items.length, 0);
    if (total === 0) {
      lines.push("", "No active tasks.");
    } else {
      for (const section of sections) {
        if (section.items.length === 0) {
          continue;
        }
        lines.push("", `${section.title}:`);
        for (const work of section.items) {
          lines.push(`- ${formatWorkListLine(work, participantDisplay)}`);
        }
      }
    }

    showDetail("Tasks", lines);
  }, [brokerPost, participantDisplay, showDetail]);

  const queueWork = useCallback(async (summary: string) => {
    const current = stateRef.current;
    const result = await brokerPost<QueueWorkResponse>("/queue-work", {
      agent_id: current.myId,
      summary,
      conversation_id: currentConversationId(current),
      auth_token: current.authToken,
    });

    if (!result.ok || !result.work) {
      throw new Error(result.error ?? "Failed to queue work.");
    }

    setNotice(`Queued work #${result.work.id}.`);
    await refreshAgents();
  }, [brokerPost, refreshAgents, setNotice]);

  const showWorkDetail = useCallback(async (workId: number) => {
    const current = stateRef.current;
    const result = await brokerPost<GetWorkResponse>("/get-work", {
      agent_id: current.myId,
      work_id: workId,
      auth_token: current.authToken,
    });

    if (!result.work) {
      throw new Error(`Work item #${workId} not found.`);
    }

    showDetail(
      `Work #${workId}`,
      formatWorkDetailLines(result.work, result.events, participantDisplay)
    );
  }, [brokerPost, participantDisplay, showDetail]);

  const handoffWork = useCallback(async (selector: string, summary: string) => {
    await refreshAgents();
    const resolution = resolveAgentSelector(stateRef.current.agentRefs, selector);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }

    const current = stateRef.current;
    const result = await brokerPost<HandoffWorkResponse>("/handoff-work", {
      agent_id: current.myId,
      to_id: resolution.record.agent.id,
      summary,
      conversation_id: currentConversationId(current),
      notify_message: true,
      auth_token: current.authToken,
    });

    if (!result.ok || !result.work) {
      throw new Error(result.error ?? "Failed to create handoff.");
    }

    rememberDmConversation(resolution.record.agent.id, result.work.conversation_id);

    const activeConversationId = currentConversationId(stateRef.current);
    if (
      stateRef.current.currentContext.kind === "dm" &&
      stateRef.current.currentContext.agentId === resolution.record.agent.id
    ) {
      await loadCurrentHistory();
    } else if (
      stateRef.current.currentContext.kind === "room" &&
      activeConversationId !== null &&
      result.work.conversation_id === activeConversationId
    ) {
      await loadCurrentHistory();
    } else {
      await refreshAgents();
    }

    setNotice(
      `Created handoff #${result.work.id} for ${participantDisplay(resolution.record.agent.id)}.`
    );
  }, [brokerPost, loadCurrentHistory, participantDisplay, refreshAgents, rememberDmConversation, setNotice]);

  const assignWork = useCallback(async (
    workId: number,
    selector: string | null,
    note?: string
  ) => {
    const current = stateRef.current;
    let targetId: string | null = null;

    if (selector) {
      await refreshAgents();
      const resolution = resolveAgentSelector(stateRef.current.agentRefs, selector);
      if (!resolution.ok) {
        throw new Error(resolution.error);
      }
      targetId = resolution.record.agent.id;
    }

    const result = await brokerPost<AssignWorkResponse>("/assign-work", {
      agent_id: current.myId,
      work_id: workId,
      to_id: targetId,
      note,
      auth_token: current.authToken,
    });

    if (!result.ok || !result.work) {
      throw new Error(result.error ?? `Failed to update assignment for work #${workId}.`);
    }

    if (stateRef.current.detailPanel?.title === `Work #${workId}`) {
      await showWorkDetail(workId);
    } else {
      await refreshAgents();
    }

    setNotice(
      targetId
        ? `Assigned work #${workId} to ${participantDisplay(targetId)}.`
        : `Returned work #${workId} to the queue.`
    );
  }, [brokerPost, participantDisplay, refreshAgents, setNotice, showWorkDetail]);

  const updateWorkStatus = useCallback(async (
    workId: number,
    action: "take" | "block" | "done" | "activate",
    note?: string
  ) => {
    const current = stateRef.current;
    const result = await brokerPost<UpdateWorkStatusResponse>("/update-work-status", {
      agent_id: current.myId,
      work_id: workId,
      action,
      note,
      auth_token: current.authToken,
    });

    if (!result.ok || !result.work) {
      throw new Error(result.error ?? `Failed to ${action} work #${workId}.`);
    }

    setNotice(`Updated work #${result.work.id} to ${result.work.status}.`);

    if (stateRef.current.detailPanel?.title === `Work #${workId}`) {
      await showWorkDetail(workId);
    }
  }, [brokerPost, setNotice, showWorkDetail]);

  const fullRefresh = useCallback(async () => {
    if (stateRef.current.currentContext.kind === "none") await refreshAgents();
    else await loadCurrentHistory();
    setNotice("Refreshed agents and current thread.");
  }, [loadCurrentHistory, refreshAgents, setNotice]);

  const removeAgentFromBroker = useCallback(async (agentId: string) => {
    if (!agentId) throw new Error("No live agent selected.");
    const label = participantDisplay(agentId);
    const response = await brokerPost<RemoveAgentAdminResponse>("/admin-remove-agent", { id: agentId });
    if (!response.ok) {
      throw new Error(`Failed to remove ${label} from broker.`);
    }

    if (!response.removed) {
      setNotice(`${label} was already gone.`, "warn");
      await refreshAgents();
      return;
    }

    updateState((prev) => {
      const nextAgentCache = new Map(prev.agentCache);
      nextAgentCache.delete(agentId);

      const nextAgentRefs = prev.agentRefs.filter((record) => record.agent.id !== agentId);
      const nextRooms = new Map(
        [...prev.rooms.entries()].map(([conversationId, room]) => [
          conversationId,
          { ...room, participantIds: room.participantIds.filter((id) => id !== agentId) },
        ])
      );
      const nextDmConversations = new Map(prev.dmConversations);
      nextDmConversations.delete(agentId);

      const nextState: State = {
        ...prev,
        agentCache: nextAgentCache,
        agentRefs: nextAgentRefs,
        rooms: nextRooms,
        dmConversations: nextDmConversations,
        selectedAgentId:
          prev.selectedAgentId === agentId
            ? nextAgentRefs[0]?.agent.id ?? null
            : prev.selectedAgentId,
      };

      if (prev.currentContext.kind === "dm" && prev.currentContext.agentId === agentId) {
        nextState.currentContext = { kind: "none" };
        nextState.currentMessages = [];
        nextState.activePane = "agents";
        nextState.detailPanel = null;
        nextState.threadScrollOffset = 0;
      }

      return nextState;
    });

    setNotice(`Removed ${label} from broker.`);
  }, [brokerPost, participantDisplay, refreshAgents, setNotice, updateState]);

  const shutdown = useCallback(async (code: number) => {
    if (stateRef.current.shuttingDown) {
      process.exitCode = code;
      appExit();
      return;
    }
    updateState((prev) => ({ ...prev, shuttingDown: true }));
    try {
      if (stateRef.current.myId) {
        await brokerPost<{ ok: boolean }>("/unregister", {
          id: stateRef.current.myId,
          auth_token: stateRef.current.authToken,
        } satisfies UnregisterRequest);
      }
    } catch {
      // Best effort.
    } finally {
      process.exitCode = code;
      appExit();
    }
  }, [appExit, brokerPost, updateState]);

  const invokeSelectedAction = useCallback(async () => {
    const action = ACTION_ITEMS[stateRef.current.selectedActionIndex];
    if (!action) return;
    switch (action.shortcut) {
      case "D":
        await switchDmById(stateRef.current.selectedAgentId ?? "");
        return;
      case "O":
        await useRoom(stateRef.current.selectedRoomId ?? "");
        return;
      case "R":
        await switchReplyContext();
        return;
      case "L":
        leaveContext();
        return;
      case "F":
        await fullRefresh();
        return;
      case "T":
        await showTasksOverview();
        return;
      case "X":
        await removeAgentFromBroker(stateRef.current.selectedAgentId ?? "");
        return;
      case "H":
        showDetail("Help", helpLines());
        return;
    }
  }, [fullRefresh, leaveContext, removeAgentFromBroker, showDetail, switchDmById, switchReplyContext, useRoom]);

  const runCommand = useCallback(async (command: OperatorCommand) => {
    switch (command.kind) {
      case "help": showDetail("Help", helpLines()); return;
      case "quit": await shutdown(0); return;
      case "leave": leaveContext(); return;
      case "reply": await switchReplyContext(); return;
      case "tasks": await showTasksOverview(); return;
      case "queue": await queueWork(command.summary); return;
      case "handoff": await handoffWork(command.agentSelector, command.summary); return;
      case "assign": await assignWork(command.workId, command.agentSelector, command.note); return;
      case "requeue": await assignWork(command.workId, null, command.note); return;
      case "work-list": await showWorkList(command.filter); return;
      case "work-open": await showWorkDetail(command.workId); return;
      case "take": await updateWorkStatus(command.workId, "take"); return;
      case "block": await updateWorkStatus(command.workId, "block", command.reason); return;
      case "done": await updateWorkStatus(command.workId, "done", command.note); return;
      case "activate": await updateWorkStatus(command.workId, "activate", command.note); return;
      case "details":
        updateState((prev) => ({ ...prev, threadMode: command.mode ?? (prev.threadMode === "minimal" ? "compact" : prev.threadMode === "compact" ? "verbose" : "minimal") }));
        return;
      case "remove-agent": {
        await refreshAgents();
        const resolution = resolveAgentSelector(stateRef.current.agentRefs, command.agentSelector);
        if (!resolution.ok) throw new Error(resolution.error);
        await removeAgentFromBroker(resolution.record.agent.id);
        return;
      }
      case "agents": await refreshAgents(); updateState((prev) => ({ ...prev, activePane: "agents" })); return;
      case "rooms": updateState((prev) => ({ ...prev, activePane: "rooms" })); return;
      case "participants": showParticipants(); return;
      case "context": showContext(); return;
      case "history": await showHistory(command.limit); return;
      case "dm": await switchDm(command.agentSelector); if (command.text) await sendInCurrentContext(command.text); return;
      case "room-create": await createRoom(command.name, command.selectors); return;
      case "room-use": await useRoom(command.roomRef); return;
      case "send": await sendInCurrentContext(command.text); return;
      case "error": setNotice(command.message, "error"); return;
      default: {
        const neverReached: never = command;
        throw new Error(`Unhandled command: ${String(neverReached)}`);
      }
    }
  }, [assignWork, createRoom, handoffWork, leaveContext, queueWork, refreshAgents, removeAgentFromBroker, sendInCurrentContext, setNotice, showContext, showHistory, showParticipants, showDetail, showTasksOverview, showWorkDetail, showWorkList, shutdown, switchDm, switchReplyContext, updateState, updateWorkStatus, useRoom]);

  const handleSubmit = useCallback(async (rawValue: string) => {
    const value = rawValue.trim();
    updateState((prev) => ({ ...prev, composerValue: "" }));
    if (!value) return setNotice("Composer cleared.", "warn");
    await runCommand(parseOperatorInput(value));
    updateState((prev) => ({ ...prev, activePane: "composer" }));
  }, [runCommand, setNotice, updateState]);

  const pollInbox = useCallback(async () => {
    const current = stateRef.current;
    if (current.pollInFlight || !current.myId || current.shuttingDown) return;
    updateState((prev) => ({ ...prev, pollInFlight: true }));
    try {
      const response = await brokerPost<PollMessagesResponse>("/poll-messages", { id: current.myId, auth_token: current.authToken });
      if (response.messages.length === 0) return;
      for (const message of response.messages) {
        if (message.from_id === stateRef.current.myId && message.to_id !== stateRef.current.myId) rememberDmConversation(message.to_id, message.conversation_id);
        if (message.to_id === stateRef.current.myId && message.from_id !== stateRef.current.myId) {
          updateState((prev) => ({ ...prev, lastIncomingSenderId: message.from_id }));
          rememberDmConversation(message.from_id, message.conversation_id);
        }
      }
      const ctx = stateRef.current.currentContext;
      const affectsCurrent =
        ctx.kind === "room"
          ? response.messages.some((message) => message.conversation_id === ctx.conversationId)
          : ctx.kind === "dm"
            ? response.messages.some((message) =>
                (message.from_id === ctx.agentId && message.to_id === stateRef.current.myId) ||
                (message.from_id === stateRef.current.myId && message.to_id === ctx.agentId))
            : false;
      const newest = response.messages.at(-1);
      if (newest) setNotice(`Inbound message from ${participantDisplay(newest.from_id)} (#${newest.id}).`);
      if (affectsCurrent) await loadCurrentHistory();
      else await refreshAgents();
      await acknowledgeMessagesCompatible(BROKER_URL, {
        id: stateRef.current.myId,
        message_ids: response.messages.map((message) => message.id),
        auth_token: stateRef.current.authToken,
      });
    } catch (error) {
      setNotice(`Inbox poll failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      updateState((prev) => ({ ...prev, pollInFlight: false }));
    }
  }, [acknowledgeMessagesCompatible, brokerPost, loadCurrentHistory, participantDisplay, refreshAgents, rememberDmConversation, setNotice, updateState]);

  const heartbeat = useCallback(async () => {
    if (!stateRef.current.myId || stateRef.current.shuttingDown) return;
    await brokerPost("/heartbeat", { id: stateRef.current.myId, auth_token: stateRef.current.authToken });
  }, [brokerPost]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const workspaceName = basename(cwd()) || "workspace";
        const response = await registerAgentCompatible(BROKER_URL, {
          name: `Human Operator @ ${workspaceName}`,
          kind: "human-operator",
          transport: "ink-tui",
          cwd: cwd(),
          summary: "Interactive human operator Ink session.",
          capabilities: ["messaging", "message_history", "operator_console", "work_admin"],
          metadata: { client: "claudy-talky Operator Remake", launcher: "bun", adapter: "claudy-talky", ui: "ink", parent_pid: process.ppid },
        });
        if (cancelled) return;
        updateState((prev) => ({ ...prev, myId: response.id, authToken: response.auth_token, lastNotice: `Connected to ${BROKER_URL} as ${response.id}.` }));
        await refreshAgents();
      } catch (error) {
        if (!cancelled) setNotice(`Startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAgents, setNotice, updateState]);

  useEffect(() => {
    if (!state.myId || state.shuttingDown) return;
    const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => setNotice(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, "error")), HEARTBEAT_INTERVAL_MS);
    const pollTimer = setInterval(() => void pollInbox(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
    };
  }, [heartbeat, pollInbox, setNotice, state.myId, state.shuttingDown]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return void shutdown(0);
    if (input === "\u001b[15~") return void fullRefresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    if (input === "\u001b[21~") return void shutdown(0);
    if (key.tab) {
      const panes: FocusPane[] = ["actions", "agents", "rooms", "thread", "composer"];
      const index = panes.indexOf(stateRef.current.activePane);
      return updateState((prev) => ({ ...prev, activePane: panes[(index + (key.shift ? -1 : 1) + panes.length) % panes.length]! }));
    }
    if (key.escape) {
      if (stateRef.current.activePane === "composer") return updateState((prev) => ({ ...prev, activePane: "agents" }));
      if (stateRef.current.detailPanel) return updateState((prev) => ({ ...prev, detailPanel: null }));
      return;
    }
    if (key.ctrl && input.toLowerCase() === "a") return updateState((prev) => ({ ...prev, activePane: "actions" }));
    if (input === "/" && stateRef.current.activePane !== "composer") return updateState((prev) => ({ ...prev, activePane: "composer", composerValue: "/" }));
    if (stateRef.current.activePane === "composer") return;
    if (key.ctrl && input.toLowerCase() === "r") return void switchReplyContext().catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    if (input === "d") return void switchDmById(stateRef.current.selectedAgentId ?? "").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    if (input === "o") return void useRoom(stateRef.current.selectedRoomId ?? "").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    if (input === "l") return leaveContext();
    if (input === "f") return void fullRefresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    if (input === "h") return showDetail("Help", helpLines());
    if (input === "v") return updateState((prev) => ({ ...prev, threadMode: prev.threadMode === "minimal" ? "compact" : prev.threadMode === "compact" ? "verbose" : "minimal" }));
    if (input === "a") return updateState((prev) => ({ ...prev, activePane: "agents" }));
    if (input === "r") return updateState((prev) => ({ ...prev, activePane: "rooms" }));
    if (input === "t") return updateState((prev) => ({ ...prev, activePane: "thread" }));
    if (input === "m") return updateState((prev) => ({ ...prev, activePane: "composer" }));
    if (stateRef.current.activePane === "actions") {
      if (key.leftArrow || input === "h") {
        return updateState((prev) => ({ ...prev, selectedActionIndex: (prev.selectedActionIndex - 1 + ACTION_ITEMS.length) % ACTION_ITEMS.length }));
      }
      if (key.rightArrow || input === "l") {
        return updateState((prev) => ({ ...prev, selectedActionIndex: (prev.selectedActionIndex + 1) % ACTION_ITEMS.length }));
      }
      if (key.return) return void invokeSelectedAction().catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
      return;
    }
    if (stateRef.current.activePane === "agents") {
      const rows = sortedAgents(stateRef.current);
      if (rows.length === 0) return;
      const currentIndex = Math.max(0, rows.findIndex((row) => row.id === stateRef.current.selectedAgentId));
      if (key.upArrow || input === "k") return updateState((prev) => ({ ...prev, selectedAgentId: rows[Math.max(0, currentIndex - 1)]!.id }));
      if (key.downArrow || input === "j") return updateState((prev) => ({ ...prev, selectedAgentId: rows[Math.min(rows.length - 1, currentIndex + 1)]!.id }));
      if (input === "x") return void removeAgentFromBroker(stateRef.current.selectedAgentId ?? "").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
      if (key.return) return void switchDmById(stateRef.current.selectedAgentId ?? "").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    }
    if (stateRef.current.activePane === "rooms") {
      const rows = sortedRooms(stateRef.current);
      if (rows.length === 0) return;
      const currentIndex = Math.max(0, rows.findIndex((row) => row.conversationId === stateRef.current.selectedRoomId));
      if (key.upArrow || input === "k") return updateState((prev) => ({ ...prev, selectedRoomId: rows[Math.max(0, currentIndex - 1)]!.conversationId }));
      if (key.downArrow || input === "j") return updateState((prev) => ({ ...prev, selectedRoomId: rows[Math.min(rows.length - 1, currentIndex + 1)]!.conversationId }));
      if (key.return) return void useRoom(stateRef.current.selectedRoomId ?? "").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
    }
    if (stateRef.current.activePane === "thread") {
      const wrapped = wrapBlock(buildThreadContentLines(stateRef.current, participantDisplay, participantName), Math.max(20, size.columns - layout.leftWidth - 4));
      const viewport = Math.max(1, layout.messagesHeight - 3);
      const maxOffset = Math.max(0, wrapped.length - viewport);
      if (key.upArrow || input === "k") return updateState((prev) => ({ ...prev, threadScrollOffset: Math.min(maxOffset, prev.threadScrollOffset + 1) }));
      if (key.downArrow || input === "j") return updateState((prev) => ({ ...prev, threadScrollOffset: Math.max(0, prev.threadScrollOffset - 1) }));
    }
  });

  const layout = useMemo(() => {
    const bodyHeight = Math.max(10, size.rows - 7);
    const leftWidth = Math.max(28, Math.min(Math.floor(size.columns * 0.3), size.columns - 40));
    const agentsHeight = Math.max(6, Math.floor(bodyHeight * 0.56));
    return { leftWidth, agentsHeight, roomsHeight: Math.max(4, bodyHeight - agentsHeight), messagesHeight: Math.max(8, bodyHeight - 4), listWidth: Math.max(8, leftWidth - 4), threadWidth: Math.max(20, size.columns - leftWidth - 4) };
  }, [size]);

  const agentRows = useMemo(() => {
    const rows = sortedAgents(state);
    const index = Math.max(0, rows.findIndex((row) => row.id === state.selectedAgentId));
    const visibleRows: { id: string; text: string; selected: boolean }[] =
      rows.length === 0
        ? [{ id: "", text: "(no agents online)", selected: false }]
        : windowAround(
            rows.map((agent) => ({
              id: agent.id,
              text: `${participantRef(agent.id) ?? agent.id}${agent.unread_count > 0 ? ` [${agent.unread_count}]` : ""} ${agent.name}`,
              selected: agent.id === state.selectedAgentId,
            })),
            index,
            Math.max(1, layout.agentsHeight - 3)
          );
    return visibleRows.map((row) => ({ text: truncate(row.text, layout.listWidth), selected: row.selected, dim: !row.id }));
  }, [layout.agentsHeight, layout.listWidth, participantRef, state]);

  const roomRows = useMemo(() => {
    const rows = sortedRooms(state);
    const index = Math.max(0, rows.findIndex((row) => row.conversationId === state.selectedRoomId));
    const visibleRows: OperatorRoom[] =
      rows.length === 0
        ? [{ conversationId: "", name: "(no rooms yet)", participantIds: [] }]
        : windowAround(rows, index, Math.max(1, layout.roomsHeight - 3));
    return visibleRows.map((room) => ({
      text: truncate(`${room.name}${room.participantIds.length > 0 ? ` (${room.participantIds.length})` : ""}`, layout.listWidth),
      selected: room.conversationId === state.selectedRoomId,
      dim: room.conversationId === "",
    }));
  }, [layout.listWidth, layout.roomsHeight, state]);

  const threadTitle = state.detailPanel ? state.detailPanel.title : state.currentContext.kind === "dm" ? `DM with ${participantDisplay(state.currentContext.agentId)}` : state.currentContext.kind === "room" ? `Room ${state.rooms.get(state.currentContext.conversationId)?.name ?? state.currentContext.conversationId}` : "No active context";
  const threadHeaderLines = state.detailPanel
    ? []
    : state.currentContext.kind === "dm"
      ? [`Summary: ${state.agentCache.get(state.currentContext.agentId)?.summary ?? "(none)"}`]
      : state.currentContext.kind === "room"
        ? [`Participants: ${state.rooms.get(state.currentContext.conversationId)?.participantIds.map((id) => participantDisplay(id)).join(", ") ?? "(unknown)"}`]
        : ["Select an agent to open a DM or type /help."];
  const threadContent = buildThreadContentLines(state, participantDisplay, participantName);
  const wrappedThreadLines = wrapBlock(threadContent, layout.threadWidth);
  const threadViewport = Math.max(1, layout.messagesHeight - 3);
  const maxThreadOffset = Math.max(0, wrappedThreadLines.length - threadViewport);
  const clampedThreadOffset = Math.min(state.threadScrollOffset, maxThreadOffset);
  const threadEnd = Math.max(0, wrappedThreadLines.length - clampedThreadOffset);
  const threadStart = Math.max(0, threadEnd - threadViewport);
  const visibleThreadLines = wrappedThreadLines.slice(threadStart, threadEnd).map((line) => ({ text: truncate(line, layout.threadWidth) }));

  if (size.columns < 80 || size.rows < 20) return h(Box, { flexDirection: "column" }, h(Text, { color: "red" }, `Terminal too small: ${size.columns}x${size.rows}`));

  const composerTitle =
    `Composer | ${
      state.currentContext.kind === "none"
        ? "No active context"
        : state.currentContext.kind === "dm"
          ? `DM ${participantDisplay(state.currentContext.agentId)}`
          : `Room ${state.rooms.get(state.currentContext.conversationId)?.name ?? state.currentContext.conversationId}`
    }${state.activePane === "composer" ? " | editing" : ""}`;

  const actionStrip = ACTION_ITEMS.map((action, index) => {
    const selected = state.activePane === "actions" && state.selectedActionIndex === index;
    const label = `[${action.shortcut}] ${action.label}`;
    return selected
      ? h(Text, { key: action.shortcut, inverse: true, color: "black", backgroundColor: "white" }, ` ${label} `)
      : h(Text, { key: action.shortcut, color: "gray" }, ` ${label} `);
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { backgroundColor: "blue", color: "white" }, truncate(`claudy-talky remake | you ${state.myId || "(registering)"} | ${state.currentContext.kind === "none" ? "No active context" : state.currentContext.kind === "dm" ? `DM ${participantDisplay(state.currentContext.agentId)}` : `Room ${state.rooms.get(state.currentContext.conversationId)?.name ?? state.currentContext.conversationId}`} | ${state.agentCache.size} agent(s) online`, size.columns)),
    h(Text, { color: state.lastNoticeLevel === "error" ? "red" : state.lastNoticeLevel === "warn" ? "yellow" : "cyan" }, truncate(state.lastNotice, size.columns)),
    h(Box, { flexDirection: "row", gap: 1 }, ...actionStrip),
    h(Text, { dimColor: true }, truncate("Tab cycles panes. Ctrl+A focuses actions. Enter opens or submits. Esc leaves composer. Ctrl+C exits.", size.columns)),
    h(Box, { flexDirection: "row", height: Math.max(10, size.rows - 7) },
      h(Box, { flexDirection: "column", width: layout.leftWidth },
        h(Panel, { title: state.activePane === "agents" ? "[Agents]" : "Agents", focused: state.activePane === "agents", height: layout.agentsHeight, lines: agentRows }),
        h(Panel, { title: state.activePane === "rooms" ? "[Rooms]" : "Rooms", focused: state.activePane === "rooms", height: layout.roomsHeight, lines: roomRows }),
      ),
      h(Box, { flexDirection: "column", flexGrow: 1 },
        h(Panel, { title: state.activePane === "thread" ? `[${threadTitle}]` : threadTitle, focused: state.activePane === "thread", height: 4, lines: wrapBlock(threadHeaderLines, layout.threadWidth).slice(0, 2).map((line) => ({ text: truncate(line, layout.threadWidth) })) }),
        h(Panel, { title: `Messages (${state.detailPanel ? state.detailPanel.title : state.threadMode})${clampedThreadOffset > 0 ? ` +${clampedThreadOffset}` : ""}`, focused: state.activePane === "thread", flexGrow: 1, lines: visibleThreadLines }),
      ),
    ),
    h(Box, { flexDirection: "column" },
      h(Text, { color: state.activePane === "composer" ? "yellow" : "green", bold: true }, truncate(composerTitle, size.columns)),
      h(Box, { borderStyle: "round", borderColor: state.activePane === "composer" ? "yellow" : "green", paddingX: 1, height: 3, flexDirection: "row" },
        h(Text, { bold: true }, "> "),
        h(Box, { flexGrow: 1 },
          h(TextInput, {
            value: state.composerValue,
            onChange: (value: string) => updateState((prev) => ({ ...prev, composerValue: value })),
            onSubmit: (value: string) => void handleSubmit(value).catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error")),
            focus: state.activePane === "composer",
            showCursor: state.activePane === "composer",
            placeholder: state.currentContext.kind === "none" ? "Select an agent or room, or type /help" : "Type a message or slash command",
          }),
        ),
      ),
    ),
  );
}

const instance = render(h(App));

process.on("SIGINT", () => {
  instance.unmount();
  exit(0);
});

process.on("SIGTERM", () => {
  instance.unmount();
  exit(0);
});

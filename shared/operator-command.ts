export type OperatorCommand =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "leave" }
  | { kind: "reply" }
  | { kind: "handoff"; agentSelector: string; summary: string }
  | { kind: "queue"; summary: string }
  | { kind: "assign"; workId: number; agentSelector: string; note?: string }
  | { kind: "requeue"; workId: number; note?: string }
  | { kind: "work-list"; filter: "open" | "all" | "mine" | "queued" | "assigned" | "active" | "blocked" | "done" }
  | { kind: "work-open"; workId: number }
  | { kind: "take"; workId: number }
  | { kind: "block"; workId: number; reason: string }
  | { kind: "done"; workId: number; note?: string }
  | { kind: "activate"; workId: number; note?: string }
  | { kind: "details"; mode?: "minimal" | "compact" | "verbose" }
  | { kind: "agents" }
  | { kind: "rooms" }
  | { kind: "participants" }
  | { kind: "context" }
  | { kind: "history"; limit: number }
  | { kind: "remove-agent"; agentSelector: string }
  | { kind: "dm"; agentSelector: string; text?: string }
  | { kind: "room-create"; name: string; selectors: string[] }
  | { kind: "room-use"; roomRef: string }
  | { kind: "send"; text: string }
  | { kind: "error"; message: string };

const DEFAULT_HISTORY_LIMIT = 20;

function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escapeNext = false;

  for (const character of input) {
    if (escapeNext) {
      current += character;
      escapeNext = false;
      continue;
    }

    if (character === "\\") {
      escapeNext = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escapeNext || quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseOperatorInput(line: string): OperatorCommand {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "error", message: "Empty input." };
  }

  if (!trimmed.startsWith("/")) {
    return { kind: "send", text: trimmed };
  }

  const parts = tokenize(trimmed.slice(1));
  if (!parts) {
    return { kind: "error", message: "Unterminated quote in command." };
  }

  if (parts.length === 0) {
    return { kind: "error", message: "Missing command." };
  }

  const [command, subcommand, ...rest] = parts;

  switch (command) {
    case "help":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "leave":
    case "back":
      return { kind: "leave" };
    case "reply":
      return { kind: "reply" };
    case "handoff":
    case "handoff-work":
      return subcommand && rest.length > 0
        ? {
            kind: "handoff",
            agentSelector: subcommand,
            summary: rest.join(" "),
          }
        : { kind: "error", message: "Usage: /handoff <agent-ref-or-name> <summary>" };
    case "queue":
    case "queue-work":
      return subcommand
        ? { kind: "queue", summary: [subcommand, ...rest].join(" ") }
        : { kind: "error", message: "Usage: /queue <summary>" };
    case "assign":
    case "assign-work": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      const [agentSelector, ...noteParts] = rest;
      return Number.isInteger(workId) && workId > 0 && agentSelector
        ? {
            kind: "assign",
            workId,
            agentSelector,
            note: noteParts.length > 0 ? noteParts.join(" ") : undefined,
          }
        : { kind: "error", message: "Usage: /assign <work-id> <agent-ref-or-name> [note]" };
    }
    case "requeue": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "requeue", workId, note: rest.length > 0 ? rest.join(" ") : undefined }
        : { kind: "error", message: "Usage: /requeue <work-id> [note]" };
    }
    case "work":
    case "list-work": {
      if (!subcommand) {
        return { kind: "work-list", filter: "open" };
      }

      if (["open", "all", "mine", "queued", "assigned", "active", "blocked", "done"].includes(subcommand)) {
        return {
          kind: "work-list",
          filter: subcommand as "open" | "all" | "mine" | "queued" | "assigned" | "active" | "blocked" | "done",
        };
      }

      const workId = Number.parseInt(subcommand, 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "work-open", workId }
        : { kind: "error", message: "Usage: /work [open|all|mine|queued|assigned|active|blocked|done|<id>] | /list-work [open|all|mine|queued|assigned|active|blocked|done|<id>]" };
    }
    case "get-work": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "work-open", workId }
        : { kind: "error", message: "Usage: /get-work <work-id>" };
    }
    case "take": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "take", workId }
        : { kind: "error", message: "Usage: /take <work-id>" };
    }
    case "block": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0 && rest.length > 0
        ? { kind: "block", workId, reason: rest.join(" ") }
        : { kind: "error", message: "Usage: /block <work-id> <reason>" };
    }
    case "done": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "done", workId, note: rest.length > 0 ? rest.join(" ") : undefined }
        : { kind: "error", message: "Usage: /done <work-id> [note]" };
    }
    case "activate": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      return Number.isInteger(workId) && workId > 0
        ? { kind: "activate", workId, note: rest.length > 0 ? rest.join(" ") : undefined }
        : { kind: "error", message: "Usage: /activate <work-id> [note]" };
    }
    case "update-work-status": {
      const workId = Number.parseInt(subcommand ?? "", 10);
      const action = rest[0];
      const note = rest.slice(1).join(" ");
      if (!Number.isInteger(workId) || workId <= 0 || !action) {
        return {
          kind: "error",
          message: "Usage: /update-work-status <work-id> <take|block|done|activate> [note]",
        };
      }

      switch (action) {
        case "take":
          return { kind: "take", workId };
        case "block":
          return note
            ? { kind: "block", workId, reason: note }
            : { kind: "error", message: "Usage: /block <work-id> <reason>" };
        case "done":
          return { kind: "done", workId, note: note || undefined };
        case "activate":
          return { kind: "activate", workId, note: note || undefined };
        default:
          return {
            kind: "error",
            message: "Usage: /update-work-status <work-id> <take|block|done|activate> [note]",
          };
      }
    }
    case "details":
      if (!subcommand) {
        return { kind: "details" };
      }
      return subcommand === "minimal" || subcommand === "compact" || subcommand === "verbose"
        ? { kind: "details", mode: subcommand }
        : { kind: "error", message: "Usage: /details [minimal|compact|verbose]" };
    case "agents":
      return { kind: "agents" };
    case "rooms":
      return { kind: "rooms" };
    case "participants":
      return { kind: "participants" };
    case "context":
      return { kind: "context" };
    case "history": {
      const rawLimit = subcommand;
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : DEFAULT_HISTORY_LIMIT;
      return Number.isInteger(limit) && limit > 0
        ? { kind: "history", limit }
        : { kind: "error", message: "Usage: /history [limit]" };
    }
    case "remove-agent":
    case "drop-agent":
      return subcommand
        ? { kind: "remove-agent", agentSelector: subcommand }
        : { kind: "error", message: "Usage: /remove-agent <agent-ref-or-name>" };
    case "dm":
      return subcommand
        ? {
            kind: "dm",
            agentSelector: subcommand,
            text: rest.length > 0 ? rest.join(" ") : undefined,
          }
        : { kind: "error", message: "Usage: /dm <agent-ref-or-name>" };
    case "msg":
      return subcommand && rest.length > 0
        ? {
            kind: "dm",
            agentSelector: subcommand,
            text: rest.join(" "),
          }
        : { kind: "error", message: "Usage: /msg <agent-ref-or-name> <message>" };
    case "room":
      if (subcommand === "create") {
        const [name, ...selectors] = rest;
        return name && selectors.length > 0
          ? { kind: "room-create", name, selectors }
          : {
              kind: "error",
              message: "Usage: /room create <name> <agent-ref-or-name...|all>",
            };
      }

      if (subcommand === "use") {
        const [roomRef] = rest;
        return roomRef
          ? { kind: "room-use", roomRef }
          : { kind: "error", message: "Usage: /room use <name-or-conversation-id>" };
      }

      return {
        kind: "error",
        message: "Usage: /room create <name> <agent-ref-or-name...|all> | /room use <name-or-conversation-id>",
      };
    default:
      return { kind: "error", message: `Unknown command: /${command}` };
  }
}

export function operatorHelpText(): string {
return `Slash commands:
/help
/leave
/agents
/queue <summary>
/queue-work <summary>
/handoff <agent-ref-or-name> <summary>
/handoff-work <agent-ref-or-name> <summary>
/assign <work-id> <agent-ref-or-name> [note]
/assign-work <work-id> <agent-ref-or-name> [note]
/requeue <work-id> [note]
/work [open|all|mine|queued|assigned|active|blocked|done|<id>]
/list-work [open|all|mine|queued|assigned|active|blocked|done|<id>]
/get-work <work-id>
/take <work-id>
/block <work-id> <reason>
/done <work-id> [note]
/activate <work-id> [note]
/update-work-status <work-id> <take|block|done|activate> [note]
/reply
/details [minimal|compact|verbose]
/dm <agent-ref-or-name> [message]
/msg <agent-ref-or-name> <message>
/room create <name> <agent-ref-or-name...|all>
/room use <name-or-conversation-id>
/rooms
/participants
/history [limit]
/context
/remove-agent <agent-ref-or-name>
/quit
/exit

Plain text sends to the current DM or room.

Keyboard:
Tab / Shift+Tab cycle panes
Ctrl+A jumps straight to the Actions strip
Left / Right move across the Actions strip
Enter runs the selected Action or sends the composer text
Esc leaves edit mode and preserves the current draft
F10 quits immediately
d opens the selected agent DM
x removes the selected agent from the broker
o opens the selected room
r replies to the last inbound sender
l clears the current context
v cycles minimal, compact, and verbose message details

Use refs from /agents, for example: /dm codex, /dm claude:claudy-talky Ping, /msg "Codex @ claudy-talky" "Need a quick status?"`;
}

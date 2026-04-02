export type OperatorCommand =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "leave" }
  | { kind: "reply" }
  | { kind: "details"; mode?: "minimal" | "compact" | "verbose" }
  | { kind: "agents" }
  | { kind: "rooms" }
  | { kind: "participants" }
  | { kind: "context" }
  | { kind: "history"; limit: number }
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
/quit

Plain text sends to the current DM or room.

Keyboard:
Tab / Shift+Tab cycle panes
Left / Right move across the Actions strip
Enter runs the selected Action or sends the composer text
Esc clears the composer and leaves edit mode
Ctrl+A jumps straight to the Actions strip
x jumps to the Actions strip
v cycles minimal, compact, and verbose message details

Use refs from /agents, for example: /dm codex, /dm claude:claudy-talky Ping, /msg "Codex @ claudy-talky" "Need a quick status?"`;
}

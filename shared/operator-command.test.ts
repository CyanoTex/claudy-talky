import { expect, test } from "bun:test";
import {
  operatorHelpText,
  parseOperatorInput,
} from "./operator-command.ts";

test("parses DM and room slash commands", () => {
  expect(parseOperatorInput("/dm abc123")).toEqual({
    kind: "dm",
    agentSelector: "abc123",
    text: undefined,
  });

  expect(parseOperatorInput("/dm abc123 ping now")).toEqual({
    kind: "dm",
    agentSelector: "abc123",
    text: "ping now",
  });

  expect(parseOperatorInput("/msg abc123 ping now")).toEqual({
    kind: "dm",
    agentSelector: "abc123",
    text: "ping now",
  });

  expect(parseOperatorInput("/reply")).toEqual({
    kind: "reply",
  });

  expect(parseOperatorInput("/details")).toEqual({
    kind: "details",
  });

  expect(parseOperatorInput("/details minimal")).toEqual({
    kind: "details",
    mode: "minimal",
  });

  expect(parseOperatorInput("/details verbose")).toEqual({
    kind: "details",
    mode: "verbose",
  });

  expect(parseOperatorInput("/leave")).toEqual({
    kind: "leave",
  });

  expect(parseOperatorInput("/back")).toEqual({
    kind: "leave",
  });

  expect(parseOperatorInput("/room create everyone all")).toEqual({
    kind: "room-create",
    name: "everyone",
    selectors: ["all"],
  });

  expect(parseOperatorInput("/room use room-everyone-1234")).toEqual({
    kind: "room-use",
    roomRef: "room-everyone-1234",
  });
});

test("supports quoted agent refs and room names", () => {
  expect(parseOperatorInput('/dm "Codex @ claudy-talky"')).toEqual({
    kind: "dm",
    agentSelector: "Codex @ claudy-talky",
    text: undefined,
  });

  expect(parseOperatorInput('/dm "Codex @ claudy-talky" "Need status"')).toEqual({
    kind: "dm",
    agentSelector: "Codex @ claudy-talky",
    text: "Need status",
  });

  expect(parseOperatorInput('/room create "team sync" "Codex @ claudy-talky" gemini')).toEqual({
    kind: "room-create",
    name: "team sync",
    selectors: ["Codex @ claudy-talky", "gemini"],
  });
});

test("parses plain text as send in the current context", () => {
  expect(parseOperatorInput("ping the room")).toEqual({
    kind: "send",
    text: "ping the room",
  });
});

test("rejects invalid room and history usage", () => {
  expect(parseOperatorInput("/history nope")).toEqual({
    kind: "error",
    message: "Usage: /history [limit]",
  });

  expect(parseOperatorInput("/details loud")).toEqual({
    kind: "error",
    message: "Usage: /details [minimal|compact|verbose]",
  });

  expect(parseOperatorInput("/msg claude")).toEqual({
    kind: "error",
    message: "Usage: /msg <agent-ref-or-name> <message>",
  });

  expect(parseOperatorInput("/room create")).toEqual({
    kind: "error",
    message: "Usage: /room create <name> <agent-ref-or-name...|all>",
  });
});

test("help text documents the operator slash commands", () => {
  expect(operatorHelpText()).toContain("/dm <agent-ref-or-name> [message]");
  expect(operatorHelpText()).toContain("/msg <agent-ref-or-name> <message>");
  expect(operatorHelpText()).toContain("/leave");
  expect(operatorHelpText()).toContain("/reply");
  expect(operatorHelpText()).toContain("/details [minimal|compact|verbose]");
  expect(operatorHelpText()).toContain("v cycles minimal, compact, and verbose message details");
  expect(operatorHelpText()).toContain('/msg "Codex @ claudy-talky" "Need a quick status?"');
  expect(operatorHelpText()).toContain("Plain text sends to the current DM or room.");
});

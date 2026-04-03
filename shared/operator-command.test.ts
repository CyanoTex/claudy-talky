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

  expect(parseOperatorInput("/tasks")).toEqual({
    kind: "tasks",
  });

  expect(parseOperatorInput("/handoff codex Fix operator scroll UX")).toEqual({
    kind: "handoff",
    agentSelector: "codex",
    summary: "Fix operator scroll UX",
  });

  expect(parseOperatorInput("/handoff-work codex Fix operator scroll UX")).toEqual({
    kind: "handoff",
    agentSelector: "codex",
    summary: "Fix operator scroll UX",
  });

  expect(parseOperatorInput("/queue Investigate flaky queue behavior")).toEqual({
    kind: "queue",
    summary: "Investigate flaky queue behavior",
  });

  expect(parseOperatorInput("/queue-work Investigate flaky queue behavior")).toEqual({
    kind: "queue",
    summary: "Investigate flaky queue behavior",
  });

  expect(parseOperatorInput("/work")).toEqual({
    kind: "work-list",
    filter: "open",
  });

  expect(parseOperatorInput("/work mine")).toEqual({
    kind: "work-list",
    filter: "mine",
  });

  expect(parseOperatorInput("/list-work blocked")).toEqual({
    kind: "work-list",
    filter: "blocked",
  });

  expect(parseOperatorInput("/work queued")).toEqual({
    kind: "work-list",
    filter: "queued",
  });

  expect(parseOperatorInput("/work 12")).toEqual({
    kind: "work-open",
    workId: 12,
  });

  expect(parseOperatorInput("/get-work 12")).toEqual({
    kind: "work-open",
    workId: 12,
  });

  expect(parseOperatorInput("/take 12")).toEqual({
    kind: "take",
    workId: 12,
  });

  expect(parseOperatorInput("/block 12 waiting on repro steps")).toEqual({
    kind: "block",
    workId: 12,
    reason: "waiting on repro steps",
  });

  expect(parseOperatorInput("/done 12 shipped")).toEqual({
    kind: "done",
    workId: 12,
    note: "shipped",
  });

  expect(parseOperatorInput("/activate 12 resumed")).toEqual({
    kind: "activate",
    workId: 12,
    note: "resumed",
  });

  expect(parseOperatorInput("/update-work-status 12 take")).toEqual({
    kind: "take",
    workId: 12,
  });

  expect(parseOperatorInput("/update-work-status 12 block waiting on logs")).toEqual({
    kind: "block",
    workId: 12,
    reason: "waiting on logs",
  });

  expect(parseOperatorInput("/update-work-status 12 done shipped")).toEqual({
    kind: "done",
    workId: 12,
    note: "shipped",
  });

  expect(parseOperatorInput("/update-work-status 12 activate resumed")).toEqual({
    kind: "activate",
    workId: 12,
    note: "resumed",
  });

  expect(parseOperatorInput("/assign 12 codex")).toEqual({
    kind: "assign",
    workId: 12,
    agentSelector: "codex",
    note: undefined,
  });

  expect(parseOperatorInput("/assign-work 12 codex hand off after triage")).toEqual({
    kind: "assign",
    workId: 12,
    agentSelector: "codex",
    note: "hand off after triage",
  });

  expect(parseOperatorInput("/requeue 12 waiting for pickup")).toEqual({
    kind: "requeue",
    workId: 12,
    note: "waiting for pickup",
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

  expect(parseOperatorInput("/remove-agent gemini:docs")).toEqual({
    kind: "remove-agent",
    agentSelector: "gemini:docs",
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

  expect(parseOperatorInput("/handoff codex")).toEqual({
    kind: "error",
    message: "Usage: /handoff <agent-ref-or-name> <summary>",
  });

  expect(parseOperatorInput("/queue")).toEqual({
    kind: "error",
    message: "Usage: /queue <summary>",
  });

  expect(parseOperatorInput("/work unknown")).toEqual({
    kind: "error",
    message: "Usage: /work [open|all|mine|queued|assigned|active|blocked|done|<id>] | /list-work [open|all|mine|queued|assigned|active|blocked|done|<id>]",
  });

  expect(parseOperatorInput("/take nope")).toEqual({
    kind: "error",
    message: "Usage: /take <work-id>",
  });

  expect(parseOperatorInput("/block 7")).toEqual({
    kind: "error",
    message: "Usage: /block <work-id> <reason>",
  });

  expect(parseOperatorInput("/done nope")).toEqual({
    kind: "error",
    message: "Usage: /done <work-id> [note]",
  });

  expect(parseOperatorInput("/get-work nope")).toEqual({
    kind: "error",
    message: "Usage: /get-work <work-id>",
  });

  expect(parseOperatorInput("/activate nope")).toEqual({
    kind: "error",
    message: "Usage: /activate <work-id> [note]",
  });

  expect(parseOperatorInput("/assign 12")).toEqual({
    kind: "error",
    message: "Usage: /assign <work-id> <agent-ref-or-name> [note]",
  });

  expect(parseOperatorInput("/requeue nope")).toEqual({
    kind: "error",
    message: "Usage: /requeue <work-id> [note]",
  });

  expect(parseOperatorInput("/update-work-status 12")).toEqual({
    kind: "error",
    message: "Usage: /update-work-status <work-id> <take|block|done|activate> [note]",
  });

  expect(parseOperatorInput("/update-work-status 12 nope")).toEqual({
    kind: "error",
    message: "Usage: /update-work-status <work-id> <take|block|done|activate> [note]",
  });

  expect(parseOperatorInput("/details loud")).toEqual({
    kind: "error",
    message: "Usage: /details [minimal|compact|verbose]",
  });

  expect(parseOperatorInput("/msg claude")).toEqual({
    kind: "error",
    message: "Usage: /msg <agent-ref-or-name> <message>",
  });

  expect(parseOperatorInput("/remove-agent")).toEqual({
    kind: "error",
    message: "Usage: /remove-agent <agent-ref-or-name>",
  });

  expect(parseOperatorInput("/room create")).toEqual({
    kind: "error",
    message: "Usage: /room create <name> <agent-ref-or-name...|all>",
  });
});

test("help text documents the operator slash commands", () => {
  expect(operatorHelpText()).toContain("/tasks");
  expect(operatorHelpText()).toContain("/handoff <agent-ref-or-name> <summary>");
  expect(operatorHelpText()).toContain("/handoff-work <agent-ref-or-name> <summary>");
  expect(operatorHelpText()).toContain("/queue <summary>");
  expect(operatorHelpText()).toContain("/queue-work <summary>");
  expect(operatorHelpText()).toContain("/assign <work-id> <agent-ref-or-name> [note]");
  expect(operatorHelpText()).toContain("/assign-work <work-id> <agent-ref-or-name> [note]");
  expect(operatorHelpText()).toContain("/requeue <work-id> [note]");
  expect(operatorHelpText()).toContain("/work [open|all|mine|queued|assigned|active|blocked|done|<id>]");
  expect(operatorHelpText()).toContain("/list-work [open|all|mine|queued|assigned|active|blocked|done|<id>]");
  expect(operatorHelpText()).toContain("/get-work <work-id>");
  expect(operatorHelpText()).toContain("/take <work-id>");
  expect(operatorHelpText()).toContain("/block <work-id> <reason>");
  expect(operatorHelpText()).toContain("/done <work-id> [note]");
  expect(operatorHelpText()).toContain("/activate <work-id> [note]");
  expect(operatorHelpText()).toContain("/update-work-status <work-id> <take|block|done|activate> [note]");
  expect(operatorHelpText()).toContain("/dm <agent-ref-or-name> [message]");
  expect(operatorHelpText()).toContain("/msg <agent-ref-or-name> <message>");
  expect(operatorHelpText()).toContain("/leave");
  expect(operatorHelpText()).toContain("/reply");
  expect(operatorHelpText()).toContain("/details [minimal|compact|verbose]");
  expect(operatorHelpText()).toContain("/remove-agent <agent-ref-or-name>");
  expect(operatorHelpText()).toContain("Esc leaves edit mode and preserves the current draft");
  expect(operatorHelpText()).toContain("F10 quits immediately");
  expect(operatorHelpText()).toContain("x removes the selected agent from the broker");
  expect(operatorHelpText()).toContain("v cycles minimal, compact, and verbose message details");
  expect(operatorHelpText()).toContain('/msg "Codex @ claudy-talky" "Need a quick status?"');
  expect(operatorHelpText()).toContain("Plain text sends to the current DM or room.");
});

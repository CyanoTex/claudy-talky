import { expect, test } from "bun:test";
import { createParticipantDisplay } from "./participant-display.ts";
import type { Agent } from "./types.ts";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    pid: null,
    name: "Claude Code @ docs",
    kind: "claude-code",
    transport: "mcp-channel",
    cwd: "C:/workspace/docs",
    git_root: "C:/workspace/docs",
    tty: null,
    summary: "",
    capabilities: ["messaging"],
    metadata: {},
    unread_count: 0,
    undelivered_count: 0,
    delivered_unseen_count: 0,
    surfaced_unseen_count: 0,
    registered_at: "2026-01-01T00:00:00.000Z",
    last_seen: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("keeps unique live names short", () => {
  const display = createParticipantDisplay([
    agent({ id: "claude-1", name: "Claude Code @ docs" }),
    agent({ id: "codex-1", name: "Codex @ claudy-talky", kind: "openai-codex" }),
  ]);

  expect(display("claude-1")).toBe("Claude Code @ docs");
  expect(display("codex-1")).toBe("Codex @ claudy-talky");
});

test("appends broker ids when multiple live agents share the same name", () => {
  const display = createParticipantDisplay([
    agent({ id: "codex-a", name: "Codex @ claudy-talky", kind: "openai-codex" }),
    agent({ id: "codex-b", name: "Codex @ claudy-talky", kind: "openai-codex" }),
  ]);

  expect(display("codex-a")).toBe("Codex @ claudy-talky (codex-a)");
  expect(display("codex-b")).toBe("Codex @ claudy-talky (codex-b)");
});

test("keeps the current session readable as You", () => {
  const display = createParticipantDisplay(
    [
      agent({ id: "codex-a", name: "Codex @ claudy-talky", kind: "openai-codex" }),
      agent({ id: "codex-b", name: "Codex @ claudy-talky", kind: "openai-codex" }),
    ],
    { selfId: "codex-a" }
  );

  expect(display("codex-a")).toBe("You");
  expect(display("codex-b")).toBe("Codex @ claudy-talky (codex-b)");
});

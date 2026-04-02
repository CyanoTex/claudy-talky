import { expect, test } from "bun:test";
import { buildAgentRefRecords, filterLikelyStaleDuplicateAgents, resolveAgentSelector } from "./operator-agent-ref.ts";
import type { Agent } from "./types.ts";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    pid: null,
    name: "Codex @ claudy-talky",
    kind: "openai-codex",
    transport: "mcp-stdio",
    cwd: "C:/src/claudy-talky",
    git_root: "C:/src/claudy-talky",
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

test("builds stable refs from kind and workspace", () => {
  const records = buildAgentRefRecords([
    agent({ id: "codex-1" }),
    agent({
      id: "claude-1",
      name: "Claude @ claudy-talky",
      kind: "claude-code",
    }),
  ]);

  expect(records.map((record) => record.ref)).toEqual([
    "claude:claudy-talky",
    "codex:claudy-talky",
  ]);
});

test("disambiguates duplicate refs with numeric suffixes", () => {
  const records = buildAgentRefRecords([
    agent({ id: "codex-1" }),
    agent({ id: "codex-2", name: "Codex secondary @ claudy-talky" }),
  ]);

  expect(records.map((record) => record.ref)).toEqual([
    "codex:claudy-talky",
    "codex:claudy-talky#2",
  ]);
});

test("resolves selectors by ref, kind alias, and full name", () => {
  const records = buildAgentRefRecords([
    agent({ id: "codex-1" }),
    agent({
      id: "gemini-1",
      name: "Gemini @ docs",
      kind: "google-gemini",
      cwd: "C:/src/docs",
      git_root: "C:/src/docs",
    }),
  ]);

  expect(resolveAgentSelector(records, "codex")).toEqual({
    ok: true,
    record: records[0]!,
  });
  expect(resolveAgentSelector(records, "gemini:docs")).toEqual({
    ok: true,
    record: records[1]!,
  });
  expect(resolveAgentSelector(records, "Codex @ claudy-talky")).toEqual({
    ok: true,
    record: records[0]!,
  });
});

test("reports ambiguous selectors with suggested refs", () => {
  const records = buildAgentRefRecords([
    agent({ id: "codex-1" }),
    agent({
      id: "codex-2",
      name: "Codex @ docs",
      cwd: "C:/src/docs",
      git_root: "C:/src/docs",
    }),
  ]);

  const result = resolveAgentSelector(records, "codex");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("codex:claudy-talky");
    expect(result.error).toContain("codex:docs");
  }
});

test("hides older duplicate agent registrations once they drift past the freshness window", () => {
  const newest = agent({
    id: "ag-new",
    name: "Antigravity @ Antigravity",
    kind: "google-antigravity",
    transport: "mcp-stdio",
    cwd: "C:/Users/Cyano/AppData/Local/Programs/Antigravity",
    git_root: null,
    metadata: { client: "Antigravity", launcher: "vscode" },
    last_seen: "2026-04-02T14:35:10.000Z",
  });
  const staleDuplicate = agent({
    id: "ag-old",
    name: "Antigravity @ Antigravity",
    kind: "google-antigravity",
    transport: "mcp-stdio",
    cwd: "C:/Users/Cyano/AppData/Local/Programs/Antigravity",
    git_root: null,
    metadata: { client: "Antigravity", launcher: "vscode" },
    last_seen: "2026-04-02T14:34:58.000Z",
  });

  expect(filterLikelyStaleDuplicateAgents([staleDuplicate, newest]).map((entry) => entry.id)).toEqual([
    "ag-new",
  ]);
});

test("keeps near-simultaneous duplicate registrations visible", () => {
  const first = agent({
    id: "codex-1",
    last_seen: "2026-04-02T14:35:10.000Z",
  });
  const second = agent({
    id: "codex-2",
    last_seen: "2026-04-02T14:35:04.000Z",
  });

  expect(filterLikelyStaleDuplicateAgents([first, second]).map((entry) => entry.id)).toEqual([
    "codex-1",
    "codex-2",
  ]);
});

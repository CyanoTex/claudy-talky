import { expect, test } from "bun:test";

import {
  formatWorkActionResult,
  formatWorkDetailLines,
  formatWorkListLine,
} from "./work-format.ts";
import type { AgentId, WorkEvent, WorkItem } from "./types.ts";

const now = new Date("2026-04-24T12:00:00.000Z");

function display(agentId: AgentId): string {
  return {
    creator: "Creator",
    codex: "Codex",
  }[agentId] ?? agentId;
}

function work(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 12,
    title: "Tighten task output",
    summary: "Make work items easier to scan.",
    conversation_id: "conv-123",
    created_by_id: "creator",
    owner_id: "codex",
    status: "blocked",
    blocker_note: "Waiting on a very long reproduction note that should stay readable in a compact list output.",
    created_at: "2026-04-24T09:00:00.000Z",
    updated_at: "2026-04-24T11:45:00.000Z",
    ...overrides,
  };
}

test("formatWorkListLine includes scan-friendly metadata", () => {
  expect(formatWorkListLine(work(), display, now)).toBe(
    '#12 blocked Tighten task output (owner=Codex, updated=15m ago, conversation=conv-123, blocker="Waiting on a very long reproduction note that should stay readable in a compa...")'
  );
});

test("formatWorkListLine shows queued ownership explicitly", () => {
  expect(
    formatWorkListLine(
      work({
        status: "queued",
        owner_id: null,
        blocker_note: null,
        conversation_id: null,
        updated_at: "2026-04-24T11:59:30.000Z",
      }),
      display,
      now
    )
  ).toBe("#12 queued Tighten task output (owner=queue, updated=just now)");
});

test("formatWorkDetailLines includes relative timing and next step", () => {
  const events: WorkEvent[] = [
    {
      id: 1,
      work_id: 12,
      actor_id: "creator",
      kind: "handoff",
      from_owner_id: null,
      to_owner_id: "codex",
      status: "assigned",
      note: "Please take this.",
      created_at: "2026-04-24T10:00:00.000Z",
    },
  ];

  expect(formatWorkDetailLines(work(), events, display, now)).toEqual([
    "Work #12",
    "Title: Tighten task output",
    "Status: blocked",
    "Created by: Creator",
    "Owner: Codex",
    "Conversation: conv-123",
    "Created: 2026-04-24T09:00:00.000Z (3h ago)",
    "Updated: 2026-04-24T11:45:00.000Z (15m ago)",
    "Next: resolve the blocker, then activate or reassign it",
    "Blocker: Waiting on a very long reproduction note that should stay readable in a compact list output.",
    "",
    "Summary:",
    "Make work items easier to scan.",
    "",
    "Events:",
    "- [2026-04-24T10:00:00.000Z (2h ago)] Creator handoff -> Codex | assigned | Please take this.",
  ]);
});

test("formatWorkActionResult summarizes the new state and notification", () => {
  expect(
    formatWorkActionResult(
      "Created handoff #12 for Codex.",
      work({
        status: "assigned",
        blocker_note: null,
      }),
      display,
      {
        notificationMessage: {
          id: 44,
          conversation_id: "conv-123",
        },
      },
      now
    )
  ).toBe(
    [
      "Created handoff #12 for Codex.",
      "#12 assigned Tighten task output (owner=Codex, updated=15m ago, conversation=conv-123)",
      "Next: owner can take it when work starts",
      "Notification: message #44 in conv-123",
    ].join("\n")
  );
});

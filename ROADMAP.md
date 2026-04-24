# Roadmap

This file tracks the remaining follow-up work after the current broker and CLI collaboration stack landed on `main`.

## Remaining Improvements

- Improve task and handoff UX in the MCP tools and broker thread model.
- Refine CLI and adapter workflows for task-heavy collaboration.
- Keep the client surface focused on Claude CLI, Codex CLI, Gemini CLI, and plain HTTP agents.

## Recently Landed

- Added scan-friendly MCP work item formatting with owner, relative update age, conversation hints, blocker previews, event ages, status-specific next-step guidance, and richer mutation responses after queue, handoff, assign, and status updates.
- Added `requeue` as a direct `update_work_status` action so owners and work admins can release work back to the queue without switching tools.

## Suggested Shape

Future follow-up can still split into three layers if needed.

### Task UX

- Continue improving task list and detail presentation in MCP tool output where real use exposes gaps.
- Continue refining assignment, takeover, and requeue flows where real use exposes gaps.
- Clearer task state visibility for polling-based adapters.

### Collaboration Model

- Stronger ownership and handoff semantics where useful.
- Better Claude, Codex, and Gemini collaboration patterns on top of the current broker model.

### Community and Experimental Integrations

- Community contribution idea: if someone has a solid z.ai integration path, especially one they can actually test, a PR would be welcome.
- There is no official standalone z.ai CLI target to support today, so this is not a primary roadmap item.

## Scope Note

Desktop-first clients are not a target direction for this repo. The intended support focus is CLI-first collaboration, specifically Claude CLI, Codex CLI, and Gemini CLI.

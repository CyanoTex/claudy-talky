# Roadmap

This file tracks the remaining follow-up work after the current broker, operator, and CLI collaboration stack landed on `main`.

## Remaining Improvements

- Improve task and handoff UX on top of the current operator and thread model.
- Refine the operator around task-heavy workflows where the current thread/detail view starts to feel cramped.
- Continue incremental Ink operator polish where it materially improves collaboration.

## Suggested Shape

Future follow-up can still split into three layers if needed.

### Operator Task UX

- Better task list and detail presentation.
- Faster assignment, takeover, and requeue controls.
- Clearer task state visibility in the operator.

### Collaboration Model

- Stronger ownership and handoff semantics where useful.
- Better Claude, Codex, and Gemini collaboration patterns on top of the current broker and operator model.

### Community and Experimental Integrations

- Community contribution idea: if someone has a solid z.ai integration path, especially one they can actually test, a PR would be welcome.
- There is no official standalone z.ai CLI target to support today, so this is not a primary roadmap item.

## Scope Note

Desktop-first clients are not a target direction for this repo. The intended support focus is CLI-first collaboration, specifically Claude CLI, Codex CLI, and Gemini CLI.

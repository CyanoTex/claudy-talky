# Repository Guidelines

`CLAUDE.md` takes precedence over this file. Use this document for the short Codex- and agent-facing workflow.

## Project Layout
- Root entrypoints: `broker.ts`, `server.ts`, `codex-server.ts`, `google-server.ts`, `cli.ts`, and `setup.ts`.
- Use `operator.ts` as the default Ink-based operator entrypoint.
- Shared broker, protocol, formatting, and setup code lives in `shared/`.
- Example integrations live in `examples/`.
- Tests live at the repo root and under `shared/`; follow existing names such as `broker.test.ts` and `shared/operator-command.test.ts`.
- Remaining repo-level follow-up work lives in `ROADMAP.md`.

## Setup Commands
- Install dependencies with `bun install`.
- Start the broker: `bun run broker`
- Start the Claude adapter: `bun server.ts`
- Start the Codex adapter: `bun codex-server.ts`
- Start the Gemini adapter: `bun google-server.ts`
- Start the current operator: `bun run operator`
- List connected agents: `bun cli.ts agents`

## Code Style
- Use TypeScript with ESM imports and 2-space indentation.
- Prefer small functions and explicit request or response types.
- Reuse helpers from `shared/` before adding new protocol or formatting logic.
- Keep filenames descriptive and lowercase, for example `operator.ts` and `broker.start-lock.test.ts`.

## Testing Instructions
- Run `bun test`.
- Run `bun x tsc --noEmit`.
- Add or update a focused test file for each broker, parser, lifecycle, or shared-helper change, following existing names such as `broker.test.ts` or `shared/operator-command.test.ts`.
- Prefer regression tests tied to the exact behavior you changed.

## Workflow Rules
- Use multi-phase plans for non-trivial work. This is non-negotiable.
- Split large changes into clear phases such as investigation, implementation, verification, and cleanup.
- Treat Claude CLI, Codex CLI, and Gemini CLI as the supported client matrix. Do not reintroduce desktop-only integrations.
- Open PRs only when the branch has a coherent scope; use a draft PR for exploratory or incomplete work.

## PR Instructions
- Use short imperative commit subjects, for example `Tighten ANSI operator controls`.
- Keep each commit scoped to one change set.
- PR once, review twice: do one self-review for code correctness and one pass for user-facing behavior, docs, and regressions before asking for merge.
- `main` is protected. Work on a branch and merge through a PR; do not plan on direct pushes.
- In each PR, include summary, rationale, user impact, and verification commands.
- Stage files explicitly and exclude runtime artifacts such as the local SQLite database, broker log files, and local shortcut files.

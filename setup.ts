#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  expandSetupSelection,
  renderSetupWrite,
  resolveSetupPath,
  setupDirname,
  setupUsage,
  type SetupClient,
  type SetupScope,
} from "./shared/setup-config.ts";

type ParsedArgs = {
  clients: SetupClient[];
  scope: SetupScope;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "install") {
    throw new Error(setupUsage());
  }

  const clients: SetupClient[] = [];
  let scope: SetupScope = "project";

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scope") {
      const next = argv[index + 1];
      if (next === "project" || next === "user") {
        scope = next;
        index += 1;
        continue;
      }

      throw new Error("--scope must be either project or user");
    }

    if (
      value === "cli" ||
      value === "all" ||
      value === "claude" ||
      value === "codex" ||
      value === "gemini"
    ) {
      clients.push(...expandSetupSelection(value));
      continue;
    }

    throw new Error(`Unknown client: ${value}`);
  }

  if (clients.length === 0) {
    throw new Error("You must specify at least one client or use `all`.");
  }

  return {
    clients: Array.from(new Set(clients)),
    scope,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  for (const client of parsed.clients) {
    const { path } = resolveSetupPath(client, parsed.scope, repoRoot);
    const existingText = existsSync(path) ? readFileSync(path, "utf8") : "";
    const targetPath = renderSetupWrite(
      client,
      parsed.scope,
      repoRoot,
      existingText
    );

    mkdirSync(setupDirname(targetPath.path), { recursive: true });
    writeFileSync(targetPath.path, targetPath.contents, "utf8");

    console.log(`Wrote ${client} config: ${targetPath.path}`);
    if (targetPath.note) {
      console.log(`Note: ${targetPath.note}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

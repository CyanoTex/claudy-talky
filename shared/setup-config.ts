import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SetupClient = "claude" | "codex" | "gemini";
export type SetupScope = "project" | "user";
export type SetupSelection = SetupClient | "cli" | "all";

export type SetupWrite = {
  client: SetupClient;
  path: string;
  contents: string;
  note?: string;
};

const CODEX_START_MARKER = "# claudy-talky:start";
const CODEX_END_MARKER = "# claudy-talky:end";

function defaultHomeDir(): string {
  return process.env.CLAUDY_TALKY_SETUP_HOME ?? homedir();
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function ensureJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function resolveSetupPath(
  client: SetupClient,
  scope: SetupScope,
  repoRoot: string,
  homeDir = defaultHomeDir()
): { path: string; note?: string } {
  if (scope === "project") {
    switch (client) {
      case "claude":
        return { path: join(repoRoot, ".mcp.json") };
      case "codex":
        return { path: join(repoRoot, ".codex", "config.toml") };
      case "gemini":
        return { path: join(repoRoot, ".gemini", "settings.json") };
    }
  }

  switch (client) {
    case "claude":
      return {
        path: join(repoRoot, ".mcp.json"),
        note:
          "Claude user-scoped config is not written automatically; updated the project .mcp.json instead.",
      };
    case "codex":
      return { path: join(homeDir, ".codex", "config.toml") };
    case "gemini":
      return { path: join(homeDir, ".gemini", "settings.json") };
  }
}

function claudeEntry(scope: SetupScope): Record<string, unknown> {
  return {
    command: "bun",
    args: [scope === "project" ? "./server.ts" : portablePath(join(process.cwd(), "server.ts"))],
  };
}

function geminiEntry(scope: SetupScope, repoRoot: string): Record<string, unknown> {
  return {
    command: "bun",
    args: [scope === "project" ? "./google-server.ts" : portablePath(join(repoRoot, "google-server.ts"))],
    cwd: scope === "project" ? "." : repoRoot,
    timeout: 600000,
    trust: false,
  };
}

function jsonConfigWithServer(
  existingText: string,
  serverName: string,
  entry: Record<string, unknown>
): string {
  let root: Record<string, unknown> = {};

  if (existingText.trim().length > 0) {
    root = ensureJsonObject(JSON.parse(existingText));
  }

  const mcpServers = ensureJsonObject(root.mcpServers);
  mcpServers[serverName] = entry;
  root.mcpServers = mcpServers;

  return `${JSON.stringify(root, null, 2)}\n`;
}

function renderCodexBlock(scope: SetupScope, repoRoot: string): string {
  const scriptPath =
    scope === "project"
      ? "./codex-server.ts"
      : portablePath(join(repoRoot, "codex-server.ts"));

  return `${CODEX_START_MARKER}
[mcp_servers."claudy-talky"]
command = "bun"
args = ["${scriptPath}"]
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true
${CODEX_END_MARKER}
`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertCodexConfig(
  existingText: string,
  scope: SetupScope,
  repoRoot: string
): string {
  const block = renderCodexBlock(scope, repoRoot).trimEnd();
  if (existingText.trim().length === 0) {
    return `${block}\n`;
  }

  const markerPattern = new RegExp(
    `${escapeRegExp(CODEX_START_MARKER)}[\\s\\S]*?${escapeRegExp(CODEX_END_MARKER)}`,
    "m"
  );
  if (markerPattern.test(existingText)) {
    return `${existingText.replace(markerPattern, block).trimEnd()}\n`;
  }

  const lines = existingText.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => line.trim() === '[mcp_servers."claudy-talky"]'
  );
  if (headerIndex >= 0) {
    let endIndex = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      if (lines[index]?.startsWith("[") && lines[index]?.trim().length) {
        endIndex = index;
        break;
      }
    }

    const before = lines.slice(0, headerIndex).join("\n").trimEnd();
    const after = lines.slice(endIndex).join("\n").trimStart();
    if (before && after) {
      return `${before}\n\n${block}\n\n${after}\n`;
    }
    if (before) {
      return `${before}\n\n${block}\n`;
    }
    if (after) {
      return `${block}\n\n${after}\n`;
    }
    return `${block}\n`;
  }

  return `${existingText.trimEnd()}\n\n${block}\n`;
}

export function renderSetupWrite(
  client: SetupClient,
  scope: SetupScope,
  repoRoot: string,
  existingText: string,
  homeDir = defaultHomeDir()
): SetupWrite {
  const target = resolveSetupPath(client, scope, repoRoot, homeDir);

  switch (client) {
    case "claude":
      return {
        client,
        path: target.path,
        note: target.note,
        contents: jsonConfigWithServer(
          existingText,
          "claudy-talky",
          claudeEntry(scope === "project" ? "project" : "user")
        ),
      };
    case "codex":
      return {
        client,
        path: target.path,
        note: target.note,
        contents: upsertCodexConfig(existingText, scope, repoRoot),
      };
    case "gemini":
      return {
        client,
        path: target.path,
        note: target.note,
        contents: jsonConfigWithServer(
          existingText,
          "claudy-talky-gemini",
          geminiEntry(scope, repoRoot)
        ),
      };
  }
}

export function expandSetupSelection(selection: SetupSelection): SetupClient[] {
  switch (selection) {
    case "cli":
      return ["claude", "codex", "gemini"];
    case "all":
      return ["claude", "codex", "gemini"];
    default:
      return [selection];
  }
}

export function setupUsage(scriptName = "bun setup.ts"): string {
  return `${scriptName} install <client...> [--scope project|user]

Clients:
  cli
  claude
  codex
  gemini
  all

Examples:
  ${scriptName} install cli --scope user
  ${scriptName} install all --scope user`;
}

export function setupDirname(path: string): string {
  return dirname(path);
}

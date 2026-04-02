import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  expandSetupSelection,
  renderSetupWrite,
  resolveSetupPath,
  upsertCodexConfig,
} from "./setup-config.ts";

const repoRoot = "C:/src/claudy-talky";
const homeDir = "C:/Users/Cyano";

test("expandSetupSelection prefers CLI clients for the cli preset", () => {
  expect(expandSetupSelection("cli")).toEqual(["claude", "codex", "gemini"]);
  expect(expandSetupSelection("all")).toEqual([
    "claude",
    "codex",
    "gemini",
    "antigravity",
  ]);
});

test("upsertCodexConfig adds a claudy-talky block to empty config", () => {
  const result = upsertCodexConfig("", "user", repoRoot);

  expect(result).toContain('[mcp_servers."claudy-talky"]');
  expect(result).toContain('args = ["C:/src/claudy-talky/codex-server.ts"]');
});

test("upsertCodexConfig replaces an existing claudy-talky block", () => {
  const existing = `[mcp_servers."claudy-talky"]
command = "bun"
args = ["./old.ts"]
enabled = false

[mcp_servers."something-else"]
command = "bun"
args = ["./other.ts"]
`;

  const result = upsertCodexConfig(existing, "project", repoRoot);

  expect(result).toContain('args = ["./codex-server.ts"]');
  expect(result).toContain('[mcp_servers."something-else"]');
  expect(result).not.toContain('./old.ts');
});

test("renderSetupWrite builds a user-scoped Gemini config with absolute paths", () => {
  const write = renderSetupWrite("gemini", "user", repoRoot, "", homeDir);

  expect(write.path).toBe(join(homeDir, ".gemini", "settings.json"));
  expect(write.contents).toContain('"claudy-talky-gemini"');
  expect(write.contents).toContain('"C:/src/claudy-talky/google-server.ts"');
});

test("resolveSetupPath keeps Claude on project config even in user scope", () => {
  const target = resolveSetupPath("claude", "user", repoRoot, homeDir);

  expect(target.path).toBe(join(repoRoot, ".mcp.json"));
  expect(target.note).toContain("project .mcp.json");
});

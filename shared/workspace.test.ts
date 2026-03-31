import { expect, test } from "bun:test";
import { resolveWorkspaceCwdFromRootUris } from "./workspace.ts";

const repoRoot =
  process.platform === "win32" ? "C:\\src\\claudy-talky" : "/tmp/claudy-talky";
const repoSubdir =
  process.platform === "win32"
    ? "C:\\src\\claudy-talky\\shared"
    : "/tmp/claudy-talky/shared";
const unrelatedCwd =
  process.platform === "win32" ? "C:\\Windows\\System32" : "/tmp";
const repoRootUri =
  process.platform === "win32"
    ? "file:///C:/src/claudy-talky"
    : "file:///tmp/claudy-talky";

test("keeps an existing repo subdirectory cwd when it is already under an MCP root", () => {
  const result = resolveWorkspaceCwdFromRootUris(repoSubdir, [repoRootUri]);

  expect(result).toBe(repoSubdir);
});

test("falls back to the first MCP root when the process cwd is unrelated", () => {
  const result = resolveWorkspaceCwdFromRootUris(unrelatedCwd, [repoRootUri]);

  expect(result).toBe(repoRoot);
});

test("ignores non-file roots and keeps the fallback cwd when no file roots exist", () => {
  const result = resolveWorkspaceCwdFromRootUris(unrelatedCwd, [
    "https://example.com/root",
  ]);

  expect(result).toBe(unrelatedCwd);
});

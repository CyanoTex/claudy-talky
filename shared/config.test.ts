import { afterEach, expect, test } from "bun:test";
import { getStaleAgentMs } from "./config.ts";

const originalStaleAgentMs = process.env.CLAUDY_TALKY_STALE_AGENT_MS;

afterEach(() => {
  if (originalStaleAgentMs === undefined) {
    delete process.env.CLAUDY_TALKY_STALE_AGENT_MS;
    return;
  }

  process.env.CLAUDY_TALKY_STALE_AGENT_MS = originalStaleAgentMs;
});

test("getStaleAgentMs defaults to a 60 second stale window", () => {
  delete process.env.CLAUDY_TALKY_STALE_AGENT_MS;

  expect(getStaleAgentMs()).toBe(60_000);
});

test("getStaleAgentMs honors CLAUDY_TALKY_STALE_AGENT_MS overrides", () => {
  process.env.CLAUDY_TALKY_STALE_AGENT_MS = "15000";

  expect(getStaleAgentMs()).toBe(15_000);
});

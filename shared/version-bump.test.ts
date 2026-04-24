import { expect, test } from "bun:test";

import {
  assertValidVersion,
  updateVersionFile,
} from "./version-bump.ts";

test("updateVersionFile updates package.json version", () => {
  const result = updateVersionFile(
    "packageJson",
    JSON.stringify({ name: "claudy-talky", version: "0.4.0" }),
    "0.4.1"
  );

  expect(result.previousVersion).toBe("0.4.0");
  expect(result.nextVersion).toBe("0.4.1");
  expect(JSON.parse(result.contents)).toEqual({
    name: "claudy-talky",
    version: "0.4.1",
  });
});

test("updateVersionFile updates Claude plugin version", () => {
  const result = updateVersionFile(
    "claudePluginJson",
    JSON.stringify({ name: "claudy-talky", version: "0.4.0" }),
    "0.4.1"
  );

  expect(result.path).toBe(".claude-plugin/plugin.json");
  expect(JSON.parse(result.contents).version).toBe("0.4.1");
});

test("updateVersionFile updates Claude marketplace metadata version", () => {
  const result = updateVersionFile(
    "claudeMarketplaceJson",
    JSON.stringify({
      name: "claudy-talky-marketplace",
      metadata: { version: "0.4.0" },
    }),
    "0.4.1"
  );

  expect(result.path).toBe(".claude-plugin/marketplace.json");
  expect(JSON.parse(result.contents).metadata.version).toBe("0.4.1");
});

test("assertValidVersion rejects non-semver input", () => {
  expect(() => assertValidVersion("next")).toThrow("Version must be semver-like");
  expect(() => assertValidVersion("1.2")).toThrow("Version must be semver-like");
});


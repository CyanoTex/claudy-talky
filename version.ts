#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  VERSION_FILE_PATHS,
  assertValidVersion,
  updateVersionFile,
  type VersionFileKind,
} from "./shared/version-bump.ts";

const version = process.argv[2];

if (!version) {
  console.error("Usage: bun version.ts <version>");
  process.exit(1);
}

try {
  assertValidVersion(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const updateOrder = Object.keys(VERSION_FILE_PATHS) as VersionFileKind[];

for (const kind of updateOrder) {
  const relativePath = VERSION_FILE_PATHS[kind];
  const absolutePath = resolve(process.cwd(), relativePath);
  const contents = await readFile(absolutePath, "utf8");
  const update = updateVersionFile(kind, contents, version);

  if (update.contents !== contents) {
    await writeFile(absolutePath, update.contents);
  }

  console.log(`${update.path}: ${update.previousVersion} -> ${update.nextVersion}`);
}


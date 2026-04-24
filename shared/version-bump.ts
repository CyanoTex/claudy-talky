export const VERSION_FILE_PATHS = {
  packageJson: "package.json",
  claudePluginJson: ".claude-plugin/plugin.json",
  claudeMarketplaceJson: ".claude-plugin/marketplace.json",
} as const;

export type VersionFileKind = keyof typeof VERSION_FILE_PATHS;

export interface VersionUpdate {
  kind: VersionFileKind;
  path: string;
  previousVersion: string;
  nextVersion: string;
  contents: string;
}

export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

export function assertValidVersion(version: string): void {
  if (!isValidVersion(version)) {
    throw new Error(`Version must be semver-like, for example 0.4.1. Received: ${version}`);
  }
}

function parseJsonObject(contents: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringifyJson(contents: Record<string, unknown>): string {
  return `${JSON.stringify(contents, null, 2)}\n`;
}

function updateTopLevelVersion(
  kind: VersionFileKind,
  path: string,
  contents: string,
  version: string
): VersionUpdate {
  const document = parseJsonObject(contents, path);
  const previousVersion = document.version;
  if (typeof previousVersion !== "string") {
    throw new Error(`${path} must contain a top-level string version`);
  }

  document.version = version;

  return {
    kind,
    path,
    previousVersion,
    nextVersion: version,
    contents: stringifyJson(document),
  };
}

function updateMarketplaceVersion(
  contents: string,
  version: string
): VersionUpdate {
  const path = VERSION_FILE_PATHS.claudeMarketplaceJson;
  const document = parseJsonObject(contents, path);
  const metadata = document.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${path} must contain a metadata object`);
  }

  const metadataObject = metadata as Record<string, unknown>;
  const previousVersion = metadataObject.version;
  if (typeof previousVersion !== "string") {
    throw new Error(`${path} must contain a metadata.version string`);
  }

  metadataObject.version = version;

  return {
    kind: "claudeMarketplaceJson",
    path,
    previousVersion,
    nextVersion: version,
    contents: stringifyJson(document),
  };
}

export function updateVersionFile(
  kind: VersionFileKind,
  contents: string,
  version: string
): VersionUpdate {
  assertValidVersion(version);

  switch (kind) {
    case "packageJson":
      return updateTopLevelVersion(kind, VERSION_FILE_PATHS.packageJson, contents, version);
    case "claudePluginJson":
      return updateTopLevelVersion(kind, VERSION_FILE_PATHS.claudePluginJson, contents, version);
    case "claudeMarketplaceJson":
      return updateMarketplaceVersion(contents, version);
  }
}


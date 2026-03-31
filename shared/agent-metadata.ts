export type WorkspaceSource = "process-cwd" | "mcp-roots";

type AgentMetadataOptions = {
  client: string;
  adapter: string;
  adapterVersion: string;
  clientVersion?: string | null;
  launcher?: string;
  notificationStyles?: string[];
  workspaceSource?: WorkspaceSource;
  extra?: Record<string, unknown>;
};

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length > 0 ? text : null;
}

function normalizeNotificationStyles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const styles: string[] = [];

  for (const item of value) {
    const style = normalizeText(typeof item === "string" ? item : null);
    if (!style || seen.has(style)) {
      continue;
    }

    seen.add(style);
    styles.push(style);
  }

  return styles;
}

export function detectLauncherType(explicit?: string): string {
  const preferred = normalizeText(explicit);
  if (preferred) {
    return preferred;
  }

  if (process.env.VSCODE_PID) {
    return "vscode";
  }

  if (process.env.WT_SESSION) {
    return "windows-terminal";
  }

  const termProgram = normalizeText(process.env.TERM_PROGRAM);
  if (termProgram) {
    return termProgram.toLowerCase();
  }

  const terminalEmulator = normalizeText(process.env.TERMINAL_EMULATOR);
  if (terminalEmulator) {
    return terminalEmulator.toLowerCase();
  }

  if (process.env.SSH_TTY) {
    return "ssh";
  }

  return process.platform === "win32" ? "windows-stdio" : "stdio";
}

export function buildAgentMetadata(
  options: AgentMetadataOptions
): Record<string, unknown> {
  const extra = options.extra ?? {};
  const notificationStyles = normalizeNotificationStyles([
    ...normalizeNotificationStyles(extra.notification_styles),
    ...(options.notificationStyles ?? []),
  ]);

  const metadata: Record<string, unknown> = {
    ...extra,
    client: options.client,
    adapter: options.adapter,
    adapter_version: options.adapterVersion,
    launcher: detectLauncherType(options.launcher),
    workspace_source: options.workspaceSource ?? "process-cwd",
    platform: process.platform,
    runtime: "bun",
    runtime_version: Bun.version,
  };

  const clientVersion = normalizeText(options.clientVersion);
  if (clientVersion) {
    metadata.client_version = clientVersion;
  }

  if (notificationStyles.length > 0) {
    metadata.notification_styles = notificationStyles;
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }

      if (typeof value === "string") {
        return value.trim().length > 0;
      }

      if (Array.isArray(value)) {
        return value.length > 0;
      }

      return true;
    })
  );
}

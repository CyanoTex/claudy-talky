import { fileURLToPath } from "node:url";

function normalizePath(path: string): string {
  const replaced = process.platform === "win32" ? path.replace(/\//g, "\\") : path;
  const trimmed = replaced.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) {
    return replaced;
  }
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isSubpath(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);

  if (normalizedPath === normalizedRoot) {
    return true;
  }

  const separator = process.platform === "win32" ? "\\" : "/";
  return normalizedPath.startsWith(`${normalizedRoot}${separator}`);
}

export function resolveWorkspaceCwdFromRootUris(
  fallbackCwd: string,
  rootUris: string[]
): string {
  const fileRoots = rootUris.flatMap((uri) => {
    try {
      return uri.startsWith("file:") ? [fileURLToPath(uri)] : [];
    } catch {
      return [];
    }
  });

  if (fileRoots.length === 0) {
    return fallbackCwd;
  }

  if (fileRoots.some((root) => isSubpath(fallbackCwd, root))) {
    return fallbackCwd;
  }

  return fileRoots[0]!;
}

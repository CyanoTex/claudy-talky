export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return code === "EPERM";
  }
}

export function shouldWatchParentPid(pid: number | null | undefined): boolean {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

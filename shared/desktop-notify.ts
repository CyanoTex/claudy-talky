type DesktopNotification = {
  title: string;
  body: string;
};

function normalizeText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function powershellQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function applescriptQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function desktopNotificationsEnabled(): boolean {
  const raw = process.env.CLAUDY_TALKY_DESKTOP_NOTIFICATIONS?.trim().toLowerCase();
  if (!raw) {
    return true;
  }

  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

export async function sendDesktopNotification(
  notification: DesktopNotification
): Promise<boolean> {
  if (!desktopNotificationsEnabled()) {
    return false;
  }

  const title = normalizeText(notification.title, 80) || "claudy-talky";
  const body = normalizeText(notification.body, 240) || "New claudy-talky message";

  try {
    let processHandle: ReturnType<typeof Bun.spawn>;

    switch (process.platform) {
      case "darwin":
        processHandle = Bun.spawn(
          [
            "osascript",
            "-e",
            `display notification "${applescriptQuote(body)}" with title "${applescriptQuote(title)}"`,
          ],
          {
            stdio: ["ignore", "ignore", "ignore"],
          }
        );
        break;
      case "linux":
        processHandle = Bun.spawn(["notify-send", title, body], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        break;
      case "win32": {
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = '${powershellQuote(title)}'
$notify.BalloonTipText = '${powershellQuote(body)}'
$notify.Visible = $true
$notify.ShowBalloonTip(5000)
Start-Sleep -Milliseconds 5500
$notify.Dispose()
`;

        processHandle = Bun.spawn(
          [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            encodePowerShell(script),
          ],
          {
            stdio: ["ignore", "ignore", "ignore"],
            windowsHide: true,
          }
        );
        break;
      }
      default:
        return false;
    }

    processHandle.unref();
    return true;
  } catch {
    return false;
  }
}

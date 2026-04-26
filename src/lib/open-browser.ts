/**
 * Cross-platform best-effort browser launcher.
 *
 * We can't depend on the `open` npm package because adding a runtime
 * dep for a single shell-out is overkill. The OS-native commands work
 * everywhere we ship: `open` on macOS, `xdg-open` on Linux, `start` on
 * Windows.
 *
 * Returns whether the launch was attempted successfully. We don't
 * actually know if the browser opened (the user might be over SSH,
 * in a container, or have no graphical environment), so the caller
 * MUST always also print the URL so the user can open it manually.
 */
import { spawn } from 'child_process';

export function tryOpenBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      // `start` is a cmd.exe builtin, not a standalone binary. The
      // empty-string first arg is a Windows-ism: `start ""` treats the
      // URL as the target instead of a window title.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else {
      // Linux / FreeBSD / etc.
      cmd = 'xdg-open';
      args = [url];
    }

    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // We don't await — child fires-and-forgets. If the binary doesn't
    // exist, spawn emits an `error` event asynchronously; we swallow
    // it because the caller is also showing the URL in the tool result.
    child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

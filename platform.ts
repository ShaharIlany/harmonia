// What differs between the Mac, Windows and Linux, in one place: opening files, folders and links, a console window for
// sign-ins, stopping a process tree, where the app's data lives, and where Slack tokens are kept. The rest of the code
// asks for these by name and doesn't look at the platform itself.
import type { Subprocess } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Slack tokens go in the Keychain on the Mac, and in a private file elsewhere. */
export const usesKeychain = isMac;

/** The per-user app data folder: Application Support on the Mac, %APPDATA% on Windows, $XDG_DATA_HOME elsewhere. */
export const supportDir =
  process.platform === "win32"
    ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : process.platform === "darwin"
      ? join(homedir(), "Library/Application Support")
      : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));

/** Runs a command and returns its exit code and what it printed. */
export const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { code: p.exitCode, out };
};

/** Opens a file in its default app, or shows it in the Finder. */
const openOrReveal = async (path: string, reveal: boolean) => {
  // explorer.exe exits with 1 even when it worked, so its exit code says nothing.
  if (isWindows) return run(reveal ? ["explorer.exe", `/select,${path}`] : ["explorer.exe", path]).then(() => ({ code: 0, out: "" }), () => ({ code: 1, out: "" }));
  if (process.platform !== "darwin") return run(["xdg-open", reveal ? join(path, "..") : path]).catch(() => ({ code: 1, out: "" }));
  return run(reveal ? ["open", "-R", path] : ["open", path]);
};

/** Opens a file in its default app. */
export const openPath = (path: string) => openOrReveal(path, false);

/** Shows a file in the file manager (the Finder, Explorer; the folder it is in elsewhere). */
export const revealPath = (path: string) => openOrReveal(path, true);

/** Opens a URL, folder or file with whatever the system has for it (`open` on the Mac). */
export const openUrl = (target: string) =>
  isWindows
    ? // The shell's own handler, which goes through no command line to quote (cmd's `start` would read & and % in a URL).
      run(["rundll32.exe", "url.dll,FileProtocolHandler", target]).catch(() => ({ code: 1, out: "" }))
    : process.platform === "darwin"
      ? run(["open", target])
      : run(["xdg-open", target]).catch(() => ({ code: 1, out: "" }));

/** Opens a folder in the file manager. */
export const openFolder = (path: string) => (isWindows ? openPath(path) : openUrl(path));

/** Opens a URL in Chrome, on the Mac. Elsewhere it reports a failure, so the caller falls back to openUrl. */
export const openInChrome = (url: string) =>
  isWindows ? Promise.resolve({ code: 1, out: "" }) : run(["open", "-a", "Google Chrome", url]).catch(() => ({ code: 1, out: "" }));

/**
 * Runs a command in a new Terminal window (a console window on Windows), for sign-ins and installs that need you.
 * On Windows the command line is built here, quoted for cmd, and passed as it is.
 */
export const runInTerminal = (argv: string[]) => {
  if (!isWindows) {
    const cmd = argv.join(" ");
    return run(["osascript", "-e", `tell application "Terminal" to do script "${cmd.replace(/(["\\])/g, "\\$1")}"`, "-e", `tell application "Terminal" to activate`]);
  }
  const line = argv.map((a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
  const p = Bun.spawn(["cmd.exe", "/d", "/s", "/c", `"start "Harmonia" cmd.exe /k ${line}"`], { stdout: "ignore", stderr: "ignore", windowsVerbatimArguments: true } as any);
  return p.exited.then((code) => ({ code, out: "" }));
};

/** Every process under pid: its children, theirs, and so on. */
function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const line of Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n")) {
    const [p, parent] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(p);
  }
  const all: number[] = [];
  const walk = (p: number) => kids.get(p)?.forEach((k) => (all.push(k), walk(k)));
  walk(pid);
  return all;
}

/**
 * Stops a run and what it started. Never throws: it is also called from timers. Windows has no `ps`, but taskkill /T ends
 * the whole tree. Elsewhere Claude Code ends its own shells; anything still up after that is stopped too.
 */
export function stopProcessTree(proc: Subprocess) {
  if (isWindows) {
    try {
      if (Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]).exitCode === 0) return;
    } catch {} // no taskkill: fall back to the process itself
    try {
      proc.kill();
    } catch {}
    return;
  }
  let started: number[] = [];
  try {
    started = descendants(proc.pid);
  } catch {} // best effort: the run itself is still killed
  try {
    proc.kill();
  } catch {}
  setTimeout(() => {
    for (const p of started) {
      try {
        process.kill(p);
      } catch {} // already gone
    }
  }, 3000);
}

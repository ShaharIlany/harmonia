// Keeps teammates out of the folders macOS protects (Desktop, Documents, Music, Photos, iCloud Drive…). Every
// `claude` the app starts runs inside a macOS sandbox profile that allows everything except those folders, so a wide
// search (find ~, grep -r ~/Library) gets "Operation not permitted" instead of a permission prompt for Harmonia.
//
// Allowed anyway: folders listed in settings.json "protectedAllow" (read on every run, no restart needed), and the
// channel's own folder when it's inside one. "protectedGuard": false turns it off.
//
// A sandboxed process can't start a sandbox of its own: Chrome needs --no-sandbox (Playwright passes it by default),
// and `swift build` needs --disable-sandbox.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA } from "./paths";

const HOME = homedir();
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Off limits: read, write and look inside. */
const PROTECTED = [
  "Desktop", "Documents", "Downloads", "Music", "Pictures", "Movies",
  "Library/Mobile Documents", // iCloud Drive
  "Library/CloudStorage", // Dropbox, OneDrive, Google Drive
  "Library/Mail", "Library/Messages", "Library/Safari", "Library/Calendars", "Library/Application Support/AddressBook",
  "Library/Group Containers", // apps' shared data (Notes, Reminders, Office, Slack, WhatsApp…)
  "Library/Containers", // other apps' data
  "Library/Photos", // the Photos library of what's shared with you (Messages)
  "Library/Application Support/com.apple.TCC",
].map((p) => join(HOME, p)).concat(
  "/Volumes", // removable and network drives
  "/System/Volumes/Data/home", "/Network", // network folders macOS mounts on demand (/home, autofs)
);

/** Teammates may move things into the Trash, but not look inside it. */
const NO_LOOKING = [join(HOME, ".Trash")];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
/** In a folder macOS protects: even looking at what's in it can bring up a permission prompt for Harmonia. */
export const isProtected = (p: string) => PROTECTED.concat(NO_LOOKING).some((d) => inside(p, d));
const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

function settings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The folders a run may use anyway: settings.json "protectedAllow" plus the channel's folder. */
export function allowed(cwd: string): string[] {
  const list = settings().protectedAllow;
  const extra = Array.isArray(list) ? list.filter((p) => typeof p === "string" && p.trim()) : [];
  return [...extra.map((p: string) => real(p.replace(/^~(?=\/|$)/, HOME))), real(cwd)].filter(isProtected);
}

/** The sandbox profile: everything, minus the protected folders, plus what's allowed. Later rules win. */
export function profile(cwd: string): string {
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${quote(p)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* ${sub(PROTECTED)})`,
    `(deny file-read-data ${sub(NO_LOOKING)})`,
    // The folders themselves can still be seen (ls ~ doesn't print errors), just not what's in them.
    `(allow file-read-metadata ${PROTECTED.map((p) => `(literal ${quote(p)})`).join(" ")})`,
    ...(allowed(cwd).length ? [`(allow file-read* file-write* ${sub(allowed(cwd))})`] : []),
  ].join("\n");
}

/** Whether runs are sandboxed on this machine: on the Mac, unless settings.json turns it off. Windows and Linux have none. */
export const sandboxActive = () => settings().protectedGuard !== false && existsSync(SANDBOX_EXEC);

/** Wraps a command in the sandbox, unless it's turned off. */
export function guarded(cmd: string[], cwd: string): string[] {
  if (!sandboxActive()) return cmd;
  return [SANDBOX_EXEC, "-p", profile(cwd), ...cmd];
}

/** Told to every teammate, so a blocked folder isn't a mystery. */
export const PROTECTED_NOTE =
  "Folders macOS protects (Desktop, Documents, Downloads, Music, Pictures, Movies, iCloud Drive, cloud drives, Mail, " +
  "Messages, other apps' data, /Volumes) are blocked for you and answer \"Operation not permitted\". Don't search them, " +
  "your home folder or / as a whole. If a task needs one, say which folder and ask the user to add it to " +
  "\"protectedAllow\" in Harmonia's settings.json. Chrome needs --no-sandbox here (Playwright does it by default).";

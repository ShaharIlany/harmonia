// Claude's projects: the folders your Claude Code sessions run in. The Code tab in the Claude app groups its sessions
// by them, and `claude` files every session under its folder in ~/.claude/projects. A channel's project is its folder:
// the teammates' jobs run there, so their sessions show up under that project in Claude.
//
// Both lists are read: the Claude app's own session records (each keeps the folder it started in, a worktree's repo
// rather than the worktree) and ~/.claude/projects (sessions started with `claude` in a terminal too). Throwaway
// folders are left out (temporary and scratch folders, Harmonia's own), and so are folders that are gone. A folder
// macOS protects (Documents, Desktop…) isn't looked at, since that alone can bring up a permission prompt.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DATA, TEAM_AGENTS } from "./paths";
import { isProtected } from "./sandbox";

export type Project = { path: string; name: string; lastAt: number };

const HOME = homedir();
const APP_SESSIONS = join(HOME, "Library/Application Support/Claude/claude-code-sessions");
const CLI_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), "projects");
const FRESH_FOR = 30_000; // ms the list is kept before it's read again
const HEAD = 8_192; // bytes read from the start of an app session record: the folder is near the top
const CLI_HEAD = 65_536; // bytes read from a terminal session's log, to find a line that says where it ran
const SKIP = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", join(HOME, "Library"), join(HOME, ".claude"), DATA, TEAM_AGENTS];

let cache: { at: number; list: Project[] } | undefined;

/** Your Claude projects, the most recently used first. */
export function claudeProjects(): Project[] {
  if (cache && Date.now() - cache.at < FRESH_FOR) return cache.list;
  const last = new Map<string, number>();
  const used = (folder: string | undefined, at: number) => {
    if (!folder?.startsWith("/")) return;
    // A session in a worktree (<repo>/.claude/worktrees/<name>) belongs to the repo's project.
    const path = folder.replace(/\/\.claude\/worktrees\/.*$/, "").replace(/(.)\/+$/, "$1");
    last.set(path, Math.max(last.get(path) ?? 0, at));
  };

  // The Claude app: <account>/<org>/local_<id>.json, one per Code session.
  for (const account of list(APP_SESSIONS))
    for (const org of list(join(APP_SESSIONS, account)))
      for (const f of list(join(APP_SESSIONS, account, org))) {
        if (!/^local_.*\.json$/.test(f)) continue;
        const file = join(APP_SESSIONS, account, org, f);
        const head = readHead(file, HEAD);
        used(field(head, "originCwd") ?? field(head, "cwd"), Number(head.match(/"lastActivityAt":(\d+)/)?.[1]) || mtime(file));
      }

  // claude in a terminal (and the app's sessions again): ~/.claude/projects/<folder as a name>/<session>.jsonl.
  for (const dir of list(CLI_PROJECTS)) {
    const logs = list(join(CLI_PROJECTS, dir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ file: join(CLI_PROJECTS, dir, f), at: mtime(join(CLI_PROJECTS, dir, f)) }))
      .sort((a, b) => b.at - a.at);
    if (logs[0]) used(field(readHead(logs[0].file, CLI_HEAD), "cwd"), logs[0].at);
  }

  const projects = [...last]
    .filter(([path]) => keep(path))
    .map(([path, lastAt]) => ({ path, name: basename(path) || path, lastAt }))
    .sort((a, b) => b.lastAt - a.lastAt);
  cache = { at: Date.now(), list: projects };
  return projects;
}

/** A folder you'd pick for a channel: not a temporary or internal one, and still there. */
function keep(path: string): boolean {
  if (path === "/" || SKIP.some((d) => path === d || path.startsWith(d + "/"))) return false;
  if (isProtected(path)) return true; // looking would ask macOS for permission: it's taken as it is
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Any folder as a project, named after it (a channel's folder that isn't one Claude knows). */
export const projectOf = (path: string): Project => ({ path, name: basename(path) || path, lastAt: 0 });

/** A folder as you'd say it: ~/GitRepos/app. */
export const tilde = (path: string) => (path === HOME || path.startsWith(HOME + "/") ? "~" + path.slice(HOME.length) : path);

/** Where a project lives, for telling two of the same name apart: ~/GitRepos. */
export const parentOf = (path: string) => tilde(dirname(path));

const list = (dir: string): string[] => {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
};

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** The first `bytes` of a file, as text. */
function readHead(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A string field's value in JSON text, found without parsing the whole thing (the records are large). */
function field(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!m) return;
  try {
    return JSON.parse(m[1]);
  } catch {
    return;
  }
}

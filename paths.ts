// Where things live, both for `bun server.ts` in the repo and for the compiled server inside Harmonia.app.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setting } from "./env";
import teamDefaults from "./team.json" with { type: "file" };

/**
 * True inside the compiled binary, where the sources live in Bun's embedded file system: /$bunfs/… on the Mac and
 * Linux, B:\\~BUN\\… on Windows.
 */
export const COMPILED = import.meta.dir.startsWith("/$bunfs") || /^[a-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir);

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/** The per-user app data folder: Application Support on the Mac, %APPDATA% on Windows, $XDG_DATA_HOME elsewhere. */
const SUPPORT =
  process.platform === "win32"
    ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : process.platform === "darwin"
      ? join(homedir(), "Library/Application Support")
      : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));

/** Channels, messages, sessions and team.json. The app keeps them in Application Support. */
export const DATA = setting("DATA") ?? (COMPILED ? join(SUPPORT, "Harmonia") : join(import.meta.dir, "data"));
// Team Chat was only ever a Mac app.
if (COMPILED && !setting("DATA") && process.platform === "darwin") moveFromTeamChat();
mkdirSync(DATA, { recursive: true });

/**
 * The app was called Team Chat. Its data folder moves to the new name once, and the old name stays behind as a link to
 * it, so a build from before the rename (kept in previous/) still finds everything. Mozart's sessions move with it:
 * Claude Code files a session under the folder it ran in, and Mozart runs in the data folder's mozart/.
 */
function moveFromTeamChat() {
  const old = join(SUPPORT, "Team Chat");
  const hasChannels = (dir: string) => existsSync(join(dir, "channels.json"));
  try {
    if (!existsSync(old) || lstatSync(old).isSymbolicLink() || !hasChannels(old)) return;
    if (existsSync(DATA)) {
      // Something made the new folder first (a run from the repo, the install script's settings): if it has no
      // channels yet, it goes to the Trash and Team Chat's folder takes its place.
      if (hasChannels(DATA)) return;
      renameSync(DATA, join(homedir(), ".Trash", `Harmonia ${new Date().toISOString().replace(/[:.]/g, "-")}`));
    }
    renameSync(old, DATA);
    symlinkSync("Harmonia", old);
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    const key = (dir: string) => join(projects, dir.replace(/[^a-zA-Z0-9]/g, "-"));
    const [from, to] = [key(join(old, "mozart")), key(join(DATA, "mozart"))];
    if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
    console.log(`Moved ${old} to ${DATA}`);
  } catch (e) {
    console.error(`Couldn't move ${old} to ${DATA}: ${(e as Error).message}`);
  }
}

/** Optional `settings.json` in the data folder: teamAgentsDir, defaultCwd, clickupWorkspace, clickupTaskPrefix. */
export const SETTINGS: Record<string, any> = readJson(join(DATA, "settings.json"));
const settings = SETTINGS;

/** The Claude Code project that holds the six chat sessions. */
export const TEAM_AGENTS: string =
  process.env.TEAM_AGENTS_DIR ?? settings.teamAgentsDir ?? join(homedir(), "TeamAgents");

/** The ClickUp workspace id, so a task like ABC-123 links to app.clickup.com/t/<workspace>/ABC-123. */
export const CLICKUP_WORKSPACE: string = process.env.CLICKUP_WORKSPACE ?? settings.clickupWorkspace ?? "";

/** The workspace's custom task id prefix ("ABC" for ABC-123). Without it, ids in messages aren't linked. */
export const CLICKUP_TASK_PREFIX: string = String(process.env.CLICKUP_TASK_PREFIX ?? settings.clickupTaskPrefix ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Default working folder for new channels. */
export const DEFAULT_CWD: string = setting("CWD") ?? settings.defaultCwd ?? homedir();

/** The roster (names, avatars, chat models). Starts as a copy of the bundled team.json. */
export const TEAM_FILE = join(DATA, "team.json");
if (!existsSync(TEAM_FILE)) writeFileSync(TEAM_FILE, readFileSync(teamDefaults, "utf8"));
/** The bundled roster, for fields an older team.json doesn't have yet. */
export const TEAM_DEFAULTS: Record<string, any>[] = JSON.parse(readFileSync(teamDefaults, "utf8"));

/** How a chat session starts the job-tools MCP server. */
export const jobToolsCommand = (): string[] =>
  COMPILED ? [process.execPath, "--job-tools"] : [process.execPath, join(import.meta.dir, "job-tools.ts")];

/** Where the channels' Mozart sessions run (Claude Code files them under this folder, apart from the teammates'). */
export const MOZART_DIR = join(DATA, "mozart");
mkdirSync(MOZART_DIR, { recursive: true });

// Laya (the old local router) is gone: drop its model cache (~1.4 GB) and log once.
for (const old of [join(DATA, "laya"), join(DATA, "laya.log")]) {
  try {
    if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  } catch {}
}

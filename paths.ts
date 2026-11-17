// Where things live, both for `bun server.ts` in the repo and for the compiled server inside Team Chat.app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import teamDefaults from "./team.json" with { type: "file" };

/** True inside the compiled binary, where the sources live in Bun's embedded file system. */
export const COMPILED = import.meta.dir.startsWith("/$bunfs");

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/** Channels, messages, sessions and team.json. The app keeps them in Application Support. */
export const DATA = process.env.TEAM_CHAT_DATA ?? (COMPILED ? join(homedir(), "Library/Application Support/Team Chat") : join(import.meta.dir, "data"));
mkdirSync(DATA, { recursive: true });

/** Optional `settings.json` in the data folder: teamAgentsDir, defaultCwd, clickupWorkspace, clickupTaskPrefix. */
const settings = readJson(join(DATA, "settings.json"));

/** The Claude Code project that holds the six chat sessions. */
export const TEAM_AGENTS: string =
  process.env.TEAM_AGENTS_DIR ?? settings.teamAgentsDir ?? join(homedir(), "TeamAgents");

/** The ClickUp workspace id, so a task like ABC-123 links to app.clickup.com/t/<workspace>/ABC-123. */
export const CLICKUP_WORKSPACE: string = process.env.CLICKUP_WORKSPACE ?? settings.clickupWorkspace ?? "";

/** The workspace's custom task id prefix ("ABC" for ABC-123). Without it, ids in messages aren't linked. */
export const CLICKUP_TASK_PREFIX: string = String(process.env.CLICKUP_TASK_PREFIX ?? settings.clickupTaskPrefix ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Default working folder for new channels. */
export const DEFAULT_CWD: string = process.env.TEAM_CHAT_CWD ?? settings.defaultCwd ?? homedir();

/** The roster (names, avatars, chat models). Starts as a copy of the bundled team.json. */
export const TEAM_FILE = join(DATA, "team.json");
if (!existsSync(TEAM_FILE)) writeFileSync(TEAM_FILE, readFileSync(teamDefaults, "utf8"));
/** The bundled roster, for fields an older team.json doesn't have yet. */
export const TEAM_DEFAULTS: Record<string, any>[] = JSON.parse(readFileSync(teamDefaults, "utf8"));

/** How a chat session starts the job-tools MCP server. */
export const jobToolsCommand = (): string[] =>
  COMPILED ? [process.execPath, "--job-tools"] : [process.execPath, join(import.meta.dir, "job-tools.ts")];

/**
 * The router's local model (Laya): a Python runtime and laya's packages built by macapp/build.sh into build/laya,
 * and copied into the app's Resources. The model files download once into Application Support.
 */
const LAYA_DIR = process.env.TEAM_CHAT_LAYA_DIR ?? (COMPILED ? join(dirname(process.execPath), "laya") : join(import.meta.dir, "build/laya"));
export const LAYA = {
  python: join(LAYA_DIR, "python/bin/python3"),
  packages: join(LAYA_DIR, "site-packages"),
  script: COMPILED ? join(LAYA_DIR, "laya-router.py") : join(import.meta.dir, "laya-router.py"),
  models: join(homedir(), "Library/Application Support/Team Chat/laya/hf"),
  log: join(DATA, "laya.log"),
};

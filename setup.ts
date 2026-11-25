// The setup check (what's missing before the team can work) and the settings page's reading and saving of
// settings.json. Both back the "Setup check" page (public/setup-page.js).
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentFile, readAgent } from "./agents";
import { DATA, DEFAULT_CWD, SETTINGS, TEAM_AGENTS } from "./paths";
import { ROSTER } from "./roster";
import { CLAUDE } from "./runner";
import type { UpdateStatus } from "./updates";

export type Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Not needed to use Harmonia: shown as information, never as a failure. */
  info?: boolean;
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Writable means a file can really be made there (permission bits lie on Windows). */
function writable(dir: string): boolean {
  const probe = join(dir, `.harmonia-write-test-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const OS = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "this system";

export async function setupChecks(cliAuth: () => Promise<any>, update: UpdateStatus): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => void checks.push(c);

  // the claude program, and whether it's signed in
  const found = existsSync(CLAUDE) || !!Bun.which(CLAUDE);
  add({
    id: "claude",
    label: "Claude Code is installed",
    ok: found,
    detail: found ? CLAUDE : `There's no claude program at ${CLAUDE}.`,
    fix: found ? undefined : "Install Claude Code (https://claude.com/claude-code), then check again.",
  });
  if (found) {
    const auth: any = await cliAuth().catch(() => ({ loggedIn: false }));
    add({
      id: "signin",
      label: "Claude Code is signed in",
      ok: !!auth.loggedIn,
      detail: auth.loggedIn ? `Signed in${auth.email ? ` as ${auth.email}` : ""}.` : auth.error || "Not signed in.",
      fix: auth.loggedIn ? undefined : "Open a terminal and run: claude auth login",
    });
  }

  // each teammate's agent file
  const agentsDir = dirname(agentFile("x"));
  const missing: string[] = [];
  for (const t of ROSTER) {
    try {
      readAgent(t.id);
    } catch {
      missing.push(`${t.name} (${t.id}.md)`);
    }
  }
  add({
    id: "agents",
    label: "Every teammate has an agent file",
    ok: !missing.length,
    detail: missing.length ? `Missing or unreadable in ${agentsDir}: ${missing.join(", ")}.` : `All ${ROSTER.length} are in ${agentsDir}.`,
    fix: missing.length ? `Copy the .md files from Harmonia's agents folder into ${agentsDir}.` : undefined,
  });

  // folders
  for (const [id, label, dir, key] of [
    ["team-agents", "The TeamAgents folder is writable", TEAM_AGENTS, "teamAgentsDir"],
    ["data", "The data folder is writable", DATA, ""],
  ] as const) {
    const ok = isDir(dir) && writable(dir);
    add({
      id,
      label,
      ok,
      detail: ok ? dir : `${dir} ${isDir(dir) ? "can't be written to" : "doesn't exist"}.`,
      fix: ok ? undefined : key ? `Make the folder, or pick another one in Settings below (${key}).` : "Check the folder's permissions.",
    });
  }
  const cwdOk = isDir(DEFAULT_CWD);
  add({
    id: "cwd",
    label: "The default working folder exists",
    ok: cwdOk,
    detail: cwdOk ? DEFAULT_CWD : `${DEFAULT_CWD} doesn't exist.`,
    fix: cwdOk ? undefined : "Pick a folder that exists in Settings below (defaultCwd).",
  });

  // platform features: information, not failures
  const mac = process.platform === "darwin";
  const guard = mac && existsSync("/usr/bin/sandbox-exec") && liveSettings().protectedGuard !== false;
  add({
    id: "sandbox",
    label: "Sandbox for teammates",
    ok: guard,
    info: true,
    detail: guard
      ? "On: teammates can't open Desktop, Documents, Downloads and the other folders macOS protects."
      : mac
        ? "Off (protectedGuard is false): teammates can reach every folder you can."
        : `No sandbox on ${OS}: teammates can reach every folder you can.`,
  });
  add({
    id: "voice",
    label: "Voice transcription",
    ok: mac,
    info: true,
    detail: mac ? "On: voice notes from Slack are turned into text on this Mac." : `Off (it needs macOS): on ${OS}, voice notes reach the teammates as audio they can't read.`,
  });
  add({
    id: "tokens",
    label: "Where Slack's tokens are kept",
    ok: mac,
    info: true,
    detail: mac ? "In the Keychain." : `In a private file in the data folder (slack-secrets.json) that only you can read; ${OS} has no Keychain here.`,
  });
  add({
    id: "updates",
    label: "Self-update",
    ok: update.state !== "off",
    info: true,
    detail: update.state !== "off" ? "On: Harmonia looks for a new version every 30 minutes." : `Off: ${(update.detail || "This isn't an installed Mac app.").replace(/\.?$/, ".")} Update by hand (git pull, or a new download).`,
  });
  return checks;
}

// ---------- settings.json ----------

const FILE = join(DATA, "settings.json");

/** What's in the file now. Throws when it's there but isn't a JSON object, so a save never overwrites a hand edit gone wrong. */
function fileSettings(): Record<string, any> {
  if (!existsSync(FILE)) return {};
  const v = JSON.parse(readFileSync(FILE, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("it isn't an object");
  return v;
}
const liveSettings = () => {
  try {
    return fileSettings();
  } catch {
    return {};
  }
};

type Spec = { type: "dir" | "string" | "bool" | "list"; live?: boolean; env?: string; hint: string };
/** The documented keys. `live`: read again on every run (sandbox.ts), so a change needs no restart. */
export const SETTING_SPECS: Record<string, Spec> = {
  teamAgentsDir: { type: "dir", env: "TEAM_AGENTS_DIR", hint: "The folder of the Claude Code project that holds the six chat sessions. Default: ~/TeamAgents." },
  defaultCwd: { type: "dir", env: "HARMONIA_CWD", hint: "The working folder new channels start in. Default: your home folder." },
  clickupWorkspace: { type: "string", env: "CLICKUP_WORKSPACE", hint: "Your ClickUp workspace id, so a task like ABC-123 links to its page." },
  clickupTaskPrefix: { type: "string", env: "CLICKUP_TASK_PREFIX", hint: "Your ClickUp custom task id prefix (ABC for ABC-123). Without it, task ids in messages aren't linked." },
  protectedAllow: { type: "list", live: true, hint: "Folders macOS protects that teammates may use anyway, one per line (like ~/Downloads). Mac only." },
  protectedGuard: { type: "bool", live: true, hint: "On (the default): teammates can't open the folders macOS protects. Off turns that sandbox off. Mac only." },
  autoUpdate: { type: "bool", hint: "On (the default): Harmonia installs updates by itself at a quiet moment. Off: it only shows that one is there." },
  updateFrom: { type: "string", hint: "Where updates come from: release (the default: the repo's latest GitHub release) or source (the branch's latest commit, built here)." },
  updateBranch: { type: "string", hint: "With updateFrom source: the branch to follow. Default: the one the app was built from." },
  updateRepo: { type: "string", hint: "The GitHub repo to update from, as owner/name. Default: the repo the app was built from." },
  voiceLanguages: { type: "list", hint: "The languages voice notes are heard in, one per line (like he-IL and en-US). Default: the Mac's preferred languages." },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The saved values, what each key means, and the keys whose saved value isn't what the server started with. */
export function readSettings() {
  let values: Record<string, any> = {};
  let error: string | undefined;
  try {
    values = fileSettings();
  } catch (e) {
    error = `settings.json can't be read (${(e as Error).message}). Fix it by hand before saving here.`;
  }
  return {
    file: FILE,
    values: Object.fromEntries(Object.keys(SETTING_SPECS).map((k) => [k, values[k]])),
    specs: SETTING_SPECS,
    // an environment variable beats the file, so the file's value does nothing while it's set
    envSet: Object.keys(SETTING_SPECS).filter((k) => SETTING_SPECS[k].env && process.env[SETTING_SPECS[k].env!] !== undefined),
    pending: Object.keys(SETTING_SPECS).filter((k) => !SETTING_SPECS[k].live && !same(values[k], SETTINGS[k])),
    error,
  };
}

/** Checks the new values, merges them into settings.json (other keys stay as they are) and says which need a restart. */
export function saveSettings(body: any): { error: string } | { restart: string[]; saved: ReturnType<typeof readSettings> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send an object of settings." };
  const patch: Record<string, any> = {};
  for (const [key, v] of Object.entries(body)) {
    const spec = SETTING_SPECS[key];
    if (!spec) return { error: `${key} isn't a setting.` };
    // null or an empty value takes the key out, so its default applies again
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) {
      patch[key] = undefined;
      continue;
    }
    if (spec.type === "bool") {
      if (typeof v !== "boolean") return { error: `${key} must be true or false.` };
    } else if (spec.type === "list") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { error: `${key} must be a list of text.` };
    } else if (typeof v !== "string") return { error: `${key} must be text.` };
    if (spec.type === "dir" && !isDir(v as string)) return { error: `${key}: the folder ${v} doesn't exist.` };
    if (key === "updateFrom" && v !== "release" && v !== "source") return { error: `updateFrom must be "release" or "source".` };
    patch[key] = spec.type === "list" ? (v as string[]).map((x) => x.trim()).filter(Boolean) : spec.type === "bool" ? v : (v as string).trim();
  }
  let all: Record<string, any>;
  try {
    all = fileSettings();
  } catch (e) {
    return { error: `settings.json can't be read (${(e as Error).message}); fix it by hand first.` };
  }
  for (const [k, v] of Object.entries(patch)) v === undefined ? delete all[k] : (all[k] = v);
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, FILE);
  const saved = readSettings();
  return { restart: saved.pending, saved };
}

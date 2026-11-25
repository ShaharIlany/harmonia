// The Slack tokens: in the Keychain on the Mac, in a private file elsewhere. Harmonia's own bot and app-level tokens,
// and each teammate's app's. Also `readJson`, which reads slack.json and the private file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../paths";
import { usesKeychain } from "../platform";

const KEYCHAIN_SERVICE = "Harmonia Slack";
/** Off the Mac there's no Keychain (a run from the repo on Linux): the tokens go here, readable only by you. */
const SECRETS_FILE = join(DATA, "slack-secrets.json");

export const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

const clip = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);

async function run(cmd: string[], timeoutMs: number) {
  const spawn = () => {
    try {
      return Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    } catch {
      return undefined;
    }
  };
  const p = spawn();
  if (!p) return { code: -1, out: "", err: `${cmd[0]} not found` };
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  return { code: p.exitCode ?? -1, out: out.trim(), err };
}

const keychain = (args: string[]) => run(["security", ...args], 15_000);

type Secrets = { teamId?: string; bot?: string; app?: string; mates?: Record<string, string>; mateApps?: Record<string, string> };

export async function saveTokens(teamId: string, bot: string, app: string): Promise<string | undefined> {
  if (!usesKeychain) {
    const was = readJson<Secrets>(SECRETS_FILE, {});
    const same = was.teamId === teamId;
    writeFileSync(SECRETS_FILE, JSON.stringify({ teamId, bot, app, ...(same && was.mates && { mates: was.mates }), ...(same && was.mateApps && { mateApps: was.mateApps }) }), { mode: 0o600 });
    return;
  }
  for (const [kind, token] of [["bot", bot], ["app", app]]) {
    const r = await keychain(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`, "-w", token]);
    if (r.code !== 0) return `Couldn't save the Slack tokens in the Keychain: ${clip(r.err)}`;
  }
}

export async function readTokens(teamId: string): Promise<{ bot: string; app: string } | undefined> {
  if (!usesKeychain) {
    const s = readJson<{ teamId?: string; bot?: string; app?: string }>(SECRETS_FILE, {});
    return s.teamId === teamId && s.bot && s.app ? { bot: s.bot, app: s.app } : undefined;
  }
  const [bot, app] = await Promise.all(["bot", "app"].map((kind) => keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`, "-w"])));
  return bot.code === 0 && app.code === 0 && bot.out && app.out ? { bot: bot.out, app: app.out } : undefined;
}

export async function deleteTokens(teamId: string, mates: string[] = []) {
  if (!usesKeychain) {
    writeFileSync(SECRETS_FILE, "{}", { mode: 0o600 });
    return;
  }
  const kinds = ["bot", "app", ...mates.flatMap((id) => [`mate:${id}`, `mate-app:${id}`])];
  for (const kind of kinds) await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`]);
}

/**
 * A teammate's own app's tokens: its bot token ("bot", in the Keychain as "<team>:mate:<teammate id>") and its
 * app-level token for your DM with it ("app", as "<team>:mate-app:<teammate id>").
 */
type MateKind = "bot" | "app";
const mateAccount = (teamId: string, id: string, kind: MateKind) => `${teamId}:${kind === "app" ? "mate-app" : "mate"}:${id}`;
const mateField = (kind: MateKind) => (kind === "app" ? "mateApps" : "mates") as "mates" | "mateApps";

export async function saveMateToken(teamId: string, id: string, token: string, kind: MateKind = "bot"): Promise<string | undefined> {
  if (!usesKeychain) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    if (s.teamId !== teamId) return "Harmonia's own Slack tokens are missing. Remove the connection and connect again.";
    writeFileSync(SECRETS_FILE, JSON.stringify({ ...s, [mateField(kind)]: { ...s[mateField(kind)], [id]: token } }), { mode: 0o600 });
    return;
  }
  const r = await keychain(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", mateAccount(teamId, id, kind), "-w", token]);
  if (r.code !== 0) return `Couldn't save the token in the Keychain: ${clip(r.err)}`;
}

export async function readMateToken(teamId: string, id: string, kind: MateKind = "bot"): Promise<string | undefined> {
  if (!usesKeychain) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    return s.teamId === teamId ? s[mateField(kind)]?.[id] : undefined;
  }
  const r = await keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", mateAccount(teamId, id, kind), "-w"]);
  return r.code === 0 && r.out ? r.out : undefined;
}

export async function deleteMateToken(teamId: string, id: string, kind: MateKind = "bot") {
  if (!usesKeychain) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    const field = s[mateField(kind)];
    if (field?.[id] === undefined) return;
    delete field[id];
    writeFileSync(SECRETS_FILE, JSON.stringify(s), { mode: 0o600 });
    return;
  }
  await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", mateAccount(teamId, id, kind)]);
}

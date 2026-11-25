// Runs a branch (or this checkout) as a second Harmonia next to the one you use, so a change can be tried before it's
// merged. The installed app stays as it is: the candidate has its own port, its own copy of your data and, unless you
// ask for it, no Slack and no updates.
//
//   bun candidate.ts [ref]            run `ref` (a branch, tag or commit; none = this checkout as it is right now)
//   bun candidate.ts [ref] --stub     the same with canned teammates and no Claude runs
//   bun candidate.ts [ref] --refresh  copy your data again first (the candidate's own changes are thrown away)
//   bun candidate.ts [ref] --port N   a port of your choice (default: the first free one from 4749)
//   bun candidate.ts [ref] --from DIR copy the data from DIR instead of the installed app's folder
//   bun candidate.ts list             the candidates there are
//   bun candidate.ts restore [ref]    put your teammates' agent files and memories back as they were before its last run
//   bun candidate.ts clean [ref]      delete it (its worktree and data)
//
// What's kept apart: the data folder (channels, messages, sessions, settings), the port, and the git worktree (the
// branch is checked out in its own folder, so your checkout isn't touched). What isn't copied: slack.json and
// slack-secrets.json (so the candidate can't join your Slack: Socket Mode would split your messages between the two),
// and the update source and downloads.
//
// What can't be kept apart: the teammates' agent files and memories live in ~/.claude (agents.ts), and a channel's
// working folder is your real folder. The candidate's teammates can change both. The agent files and memories are
// copied aside before each run and compared after it; `restore` puts them back.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const HERE = import.meta.dir;
const ROOT = process.env.HARMONIA_CANDIDATES ?? join(homedir(), ".harmonia-candidates");
const CLAUDE_HOME = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
const AGENT_DIRS = ["agents", "agent-memory"]; // under CLAUDE_HOME: agents.ts's AGENTS_DIR and MEMORY_ROOT
const SKIP_DATA = ["slack.json", "slack-secrets.json", "source", "previous", "download", "update.log"];
const FIRST_PORT = 4749;

/** The installed app's data folder, as paths.ts finds it. */
const stableData = () =>
  process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Harmonia")
    : process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/Harmonia")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "harmonia");

const fail = (msg: string): never => {
  console.error(`candidate: ${msg}`);
  process.exit(1);
};

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  args.splice(i, 1);
  return true;
};
const option = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
};
const stub = flag("--stub");
const refresh = flag("--refresh");
const portArg = option("--port");
const fromArg = option("--from");
const command = ["list", "restore", "clean"].includes(args[0] ?? "") ? args.shift()! : "run";
const ref = args[0];
if (args.length > 1) fail(`unexpected: ${args.slice(1).join(" ")}`);

/** A folder name for a candidate: the ref, or the current branch for "this checkout". */
const nameFor = () => {
  const label = ref ?? `checkout-${git(HERE, "rev-parse", "--abbrev-ref", "HEAD").out || "here"}`;
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
};

/** Every file under `dir` → a hash of its bytes, by path relative to `dir`. */
function fingerprint(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.set(relative(dir, p).replace(/\\/g, "/"), createHash("sha1").update(readFileSync(p)).digest("hex"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const agentSnapshot = (name: string) => join(ROOT, name, "agents-before");

function snapshotAgents(name: string) {
  const dest = agentSnapshot(name);
  rmSync(dest, { recursive: true, force: true });
  for (const d of AGENT_DIRS) if (existsSync(join(CLAUDE_HOME, d))) cpSync(join(CLAUDE_HOME, d), join(dest, d), { recursive: true });
  mkdirSync(dest, { recursive: true });
}

/** Files under the agent folders that changed since the snapshot: added, changed or removed. */
function agentChanges(name: string) {
  const before = fingerprint(agentSnapshot(name));
  const now = new Map<string, string>();
  for (const d of AGENT_DIRS) for (const [f, h] of fingerprint(join(CLAUDE_HOME, d))) now.set(`${d}/${f}`, h);
  const changes: string[] = [];
  for (const [f, h] of now) if (!before.has(f)) changes.push(`+ ${f}`);
  else if (before.get(f) !== h) changes.push(`~ ${f}`);
  for (const f of before.keys()) if (!now.has(f)) changes.push(`- ${f}`);
  return changes;
}

function restoreAgents(name: string) {
  const snap = agentSnapshot(name);
  if (!existsSync(snap)) fail(`no snapshot for "${name}": it hasn't run yet`);
  for (const d of AGENT_DIRS) {
    rmSync(join(CLAUDE_HOME, d), { recursive: true, force: true });
    if (existsSync(join(snap, d))) cpSync(join(snap, d), join(CLAUDE_HOME, d), { recursive: true });
  }
}

function copyData(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  if (existsSync(from)) {
    for (const e of readdirSync(from)) if (!SKIP_DATA.includes(e)) cpSync(join(from, e), join(to, e), { recursive: true });
  } else console.log(`No data at ${from}: starting with an empty candidate.`);
  // No updates: a candidate is the branch you gave it, whatever the installed app is following.
  const file = join(to, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  writeFileSync(file, JSON.stringify({ ...settings, autoUpdate: false }, null, 2));
}

const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });

async function pickPort() {
  if (portArg) {
    const p = Number(portArg);
    if (!Number.isInteger(p) || p < 1 || p > 65535) fail(`not a port: ${portArg}`);
    if (!(await portFree(p))) fail(`port ${p} is taken`);
    return p;
  }
  for (let p = FIRST_PORT; p < FIRST_PORT + 50; p++) if (await portFree(p)) return p;
  return fail("no free port found");
}

/** The folder to run from: this checkout, or a worktree of `ref` that's made once and moved on to the ref after that. */
function treeFor(name: string): string {
  if (!ref) return HERE;
  const tree = join(ROOT, name, "tree");
  const known = git(HERE, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const remote = known.ok ? known : git(HERE, "rev-parse", "--verify", "--quiet", `origin/${ref}^{commit}`);
  if (!remote.ok) fail(`"${ref}" isn't a branch, tag or commit here (git fetch it first?)`);
  const sha = remote.out;
  if (existsSync(tree)) {
    const r = git(tree, "checkout", "--detach", sha);
    if (!r.ok) fail(`couldn't move ${tree} to ${ref}: ${r.err}`);
  } else {
    mkdirSync(join(ROOT, name), { recursive: true });
    const r = git(HERE, "worktree", "add", "--detach", tree, sha);
    if (!r.ok) fail(`couldn't make a worktree: ${r.err}`);
  }
  return tree;
}

async function run() {
  const name = nameFor();
  const tree = treeFor(name);
  const data = join(ROOT, name, "data");
  const from = resolve(fromArg ?? stableData());
  if (resolve(data) === from) fail("the candidate's data folder is the source");
  if (refresh || !existsSync(data)) {
    copyData(from, data);
    console.log(`Copied your data from ${from}`);
  }
  snapshotAgents(name);
  const port = await pickPort();
  const commit = git(tree, "rev-parse", "--short", "HEAD").out;
  const dirty = git(tree, "status", "--porcelain").out ? " + uncommitted changes" : "";
  console.log(`\nHarmonia candidate "${name}" at ${commit}${dirty}\n  http://localhost:${port}\n  data: ${data}\n  Ctrl+C stops it.\n`);

  const child = spawn("bun", ["server.ts"], {
    cwd: tree,
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), HARMONIA_DATA: data, ...(stub && { HARMONIA_STUB: "1" }) },
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>((done) => child.on("exit", () => done()));

  const changes = stub ? [] : agentChanges(name);
  if (changes.length) {
    console.log(`\nThe candidate changed your teammates' agent files or memories (${changes.length}):`);
    for (const c of changes.slice(0, 30)) console.log(`  ${c}`);
    if (changes.length > 30) console.log(`  … and ${changes.length - 30} more`);
    console.log(`Undo them with: bun candidate.ts restore${ref ? ` ${ref}` : ""}`);
  } else console.log("\nYour teammates' agent files and memories are as they were.");
}

function list() {
  if (!existsSync(ROOT)) return console.log("No candidates yet.");
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    if (!statSync(dir).isDirectory()) continue;
    const tree = join(dir, "tree");
    const at = existsSync(tree) ? git(tree, "rev-parse", "--short", "HEAD").out : "this checkout";
    console.log(`${name}  (${at})  ${dir}`);
  }
}

function clean() {
  const name = nameFor();
  const dir = join(ROOT, name);
  if (!existsSync(dir)) fail(`no candidate "${name}"`);
  const tree = join(dir, "tree");
  if (existsSync(tree)) git(HERE, "worktree", "remove", "--force", tree);
  rmSync(dir, { recursive: true, force: true });
  git(HERE, "worktree", "prune");
  console.log(`Removed ${name}`);
}

if (command === "list") list();
else if (command === "clean") clean();
else if (command === "restore") {
  restoreAgents(nameFor());
  console.log("Agent files and memories put back as they were before the last run.");
} else await run();

// Over-the-air updates from git. The installed app knows the commit it was built from (build.json, written by
// macapp/build.sh). Every 30 minutes it fetches its branch into a clone of its own (the data folder's `source/`),
// and when the branch has moved on, it builds the new commit there with the same build.sh, in the background.
// The new build is swapped in at a quiet moment (nothing working, and you haven't sent anything for a while), and the
// app reopens itself on it. Or right away (still waiting for teammates to finish) with "Restart to update".
//
// settings.json: "updateRepo" and "updateBranch" (default: the repo and branch the app was built from),
// "autoUpdate" (default true: build and install on their own; false: only show that an update is there).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPILED, DATA, SETTINGS } from "./paths";

export type UpdateStatus = {
  state: "off" | "idle" | "checking" | "available" | "building" | "ready" | "waiting" | "installing" | "failed";
  current?: string; // the running build's commit
  latest?: string; // the branch's commit
  commits?: string[]; // what's new: "abc1234 subject", newest first
  detail?: string; // the step, the error, or why updates are off
  checkedAt?: number;
  auto: boolean;
};

const RESOURCES = dirname(process.execPath);
const APP = dirname(dirname(RESOURCES)); // …/Team Chat.app
const SOURCE = join(DATA, "source");
const LOG = join(DATA, "update.log");
const CHECK_EVERY = 30 * 60_000;
/** Auto-install waits until you haven't sent anything for this long. */
const QUIET = 10 * 60_000;

type Build = { commit: string; repo: string; branch: string; builtAt: string; dirty?: boolean };
const build: Build | undefined = (() => {
  if (!COMPILED) return;
  try {
    return JSON.parse(readFileSync(join(RESOURCES, "build.json"), "utf8"));
  } catch {}
})();
const repo: string = SETTINGS.updateRepo ?? build?.repo ?? "";
const branch: string = SETTINGS.updateBranch ?? build?.branch ?? "main";
const auto: boolean = SETTINGS.autoUpdate ?? true;

let status: UpdateStatus = { state: "off", auto, current: build?.commit };
let onStatus: (s: UpdateStatus) => void = () => {};
let busyCount: () => number = () => 0;
let lastActivity = Date.now();
let installWhenIdle = false;
let failedBuild: string | undefined; // a commit that didn't build: automatic updates skip it until the branch moves on
let job: Promise<void> | undefined;

export const updateStatus = () => status;
/** The page calls this on anything you send, so an automatic install never lands while you're typing away. */
export const noteActivity = () => void (lastActivity = Date.now());

function set(s: Partial<UpdateStatus>) {
  status = { ...status, ...s, auto };
  onStatus(status);
}
const log = (line: string) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

async function sh(cmd: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) {
    log(`$ ${cmd.join(" ")}\n${out}${err}`);
    throw new Error(`${cmd[0] === "git" ? `git ${cmd[1]}` : cmd.join(" ")} failed: ${(err || out).trim().split("\n").pop()}`);
  }
  return out.trim();
}
const git = (...args: string[]) => sh(["git", "-C", SOURCE, ...args]);

export function startUpdates(o: { notify: (s: UpdateStatus) => void; busy: () => number }) {
  onStatus = o.notify;
  busyCount = o.busy;
  if (process.env.TEAM_CHAT_STUB) return;
  if (!build) return set({ state: "off", detail: COMPILED ? "This build has no build.json." : "Running from source: update with git." });
  if (!repo) return set({ state: "off", detail: "The build has no git remote. Set updateRepo in settings.json." });
  set({ state: "idle" });
  setTimeout(() => checkForUpdates(), 60_000);
  setInterval(() => checkForUpdates(), CHECK_EVERY);
  setInterval(maybeInstall, 30_000);
}

/** Fetches the branch and works out what's new. With auto updates on, starts building it. */
export function checkForUpdates(): Promise<void> {
  if (status.state === "off" || job) return job ?? Promise.resolve();
  job = (async () => {
    const before = status.state;
    if (before !== "ready" && before !== "waiting") set({ state: "checking", detail: undefined });
    try {
      if (!existsSync(join(SOURCE, ".git"))) await sh(["git", "clone", "--quiet", "--branch", branch, repo, SOURCE]);
      else {
        await git("remote", "set-url", "origin", repo);
        await git("fetch", "--quiet", "origin", branch);
      }
      const latest = await git("rev-parse", "FETCH_HEAD").catch(() => git("rev-parse", "HEAD"));
      const current = build!.commit;
      const known = await git("cat-file", "-e", `${current}^{commit}`).then(() => true, () => false);
      const upToDate = latest === current || (known && (await git("merge-base", "--is-ancestor", latest, current).then(() => true, () => false)));
      if (upToDate || !known) {
        // Not known: a build from a commit that was never pushed. It isn't behind anything we can see.
        if (before === "ready" || before === "waiting") return set({ state: before, checkedAt: Date.now() });
        return set({ state: "idle", latest, commits: [], checkedAt: Date.now(), detail: known ? undefined : "This build's commit isn't on the branch." });
      }
      const commits = (await git("log", "--format=%h %s", "-n", "15", `${current}..${latest}`)).split("\n").filter(Boolean);
      if ((before === "ready" || before === "waiting") && status.latest === latest) return set({ checkedAt: Date.now() });
      set({ state: "available", latest, commits, checkedAt: Date.now(), detail: undefined });
      if (auto && failedBuild !== latest) await buildLatest();
    } catch (e) {
      set({ state: "failed", detail: (e as Error).message, checkedAt: Date.now() });
    }
  })().finally(() => (job = undefined));
  return job;
}

/** Builds the fetched commit in the clone, next to the running app. Nothing is replaced yet. */
async function buildLatest() {
  const latest = status.latest!;
  set({ state: "building", detail: "checking out" });
  await git("checkout", "--quiet", "--force", "--detach", latest);
  await git("clean", "-fdq", "-e", "build/");
  rmSync(join(SOURCE, "build", "Team Chat.app"), { recursive: true, force: true });
  set({ state: "building", detail: "building the app" });
  log(`building ${latest}`);
  // Laya's Python (~800 MB) is cloned from this app instead of reinstalled, when the version matches.
  await sh(["/bin/bash", "macapp/build.sh"], SOURCE, { TEAM_CHAT_LAYA_SEED: join(RESOURCES, "laya"), TEAM_CHAT_REPO: repo, TEAM_CHAT_BRANCH: branch }).catch(
    (e) => {
      failedBuild = latest;
      throw e;
    },
  );
  const built = JSON.parse(readFileSync(join(SOURCE, "build", "Team Chat.app", "Contents", "Resources", "build.json"), "utf8"));
  if (built.commit !== latest) throw new Error(`built ${built.commit}, expected ${latest}`);
  log(`built ${latest}`);
  set({ state: "ready", detail: undefined });
}

/** "Update" on the page: build now if it isn't built, then install as soon as nobody is working. */
export async function applyUpdate(): Promise<string | undefined> {
  if (job) await job;
  if (status.state === "failed" && !status.commits?.length) await checkForUpdates();
  if (status.state === "available" || (status.state === "failed" && status.commits?.length)) {
    job = buildLatest()
      .catch((e) => set({ state: "failed", detail: (e as Error).message }))
      .finally(() => (job = undefined));
    await job;
  }
  if (status.state !== "ready" && status.state !== "waiting") return status.detail ?? "There's no update to install.";
  installWhenIdle = true;
  maybeInstall();
}

function maybeInstall() {
  if (status.state !== "ready" && status.state !== "waiting") return;
  const busy = busyCount();
  const quiet = Date.now() - lastActivity > QUIET;
  if (!installWhenIdle && !(auto && quiet)) return;
  if (busy > 0) return set({ state: "waiting", detail: `${busy} teammate${busy === 1 ? " is" : "s or jobs are"} still working` });
  install();
}

/** Exit code that tells the app shell (macapp/main.swift) to quit and open itself again: the new build. */
export const RELAUNCH_EXIT = 75;

/**
 * Swaps the build while this one still runs (macOS keeps a running app going when its bundle is moved), then exits
 * with RELAUNCH_EXIT. The app shell quits and reopens itself through LaunchServices. Nothing can outlive the app to do
 * it instead: macOS ends every process an app started, even launchd jobs, when the app quits.
 * The old build is kept in the data folder's `previous/`, to go back by hand.
 */
async function install() {
  set({ state: "installing", detail: "restarting" });
  const fresh = join(SOURCE, "build", "Team Chat.app");
  const prevDir = join(DATA, "previous");
  const prev = join(prevDir, "Team Chat.app");
  try {
    if (!existsSync(join(fresh, "Contents", "MacOS", "Team Chat"))) throw new Error("the new build isn't there");
    rmSync(prevDir, { recursive: true, force: true });
    mkdirSync(prevDir, { recursive: true });
    renameSync(APP, prev);
    try {
      // A clone on APFS: instant, and no extra space for Laya's ~800 MB.
      await sh(["cp", "-cR", fresh, APP]).catch(() => sh(["ditto", fresh, APP]));
    } catch (e) {
      rmSync(APP, { recursive: true, force: true });
      renameSync(prev, APP);
      throw e;
    }
  } catch (e) {
    installWhenIdle = false;
    log(`install failed: ${(e as Error).message}`);
    return set({ state: "failed", detail: `Couldn't install the update: ${(e as Error).message}` });
  }
  log(`installed ${status.latest} into ${APP}; relaunching`);
  setTimeout(() => process.exit(RELAUNCH_EXIT), 300);
}

// Over-the-air updates. The installed app knows what it is (build.json, written by macapp/build.sh): a release's
// version, or the commit it was built from. Every 30 minutes it looks for something newer, gets it in the background,
// and swaps it in at a quiet moment (nothing working, and you haven't sent anything for a while); the app reopens
// itself on it. Or right away with "Restart to update": what's working is picked up again after the restart
// (server.ts's beforeRestart, Team.closeForRestart and resumeAfterRestart).
//
// Two sources (settings.json "updateFrom"):
//   "release" (default)  the repo's latest GitHub release (.github/workflows/release.yml builds one per version tag):
//                        download the zip, check its SHA-256, sign it ad hoc.
//   "source"             the branch's latest commit: fetched into a clone of its own (the data folder's `source/`)
//                        and built there with the same build.sh. Needs git, bun and Xcode's command line tools.
//
// settings.json: "updateRepo" (default: the repo the app was built from), "updateBranch" (source only),
// "autoUpdate" (default true: get and install on their own; false: only show that an update is there).
//
// Windows (the app installed by winapp/installer.iss: Harmonia.exe, the window, next to harmonia-server.exe) updates
// from releases only: it downloads Harmonia-windows-x64.zip, checks it, and swaps its files in place. A running .exe
// can be renamed but not overwritten, so each file is renamed to `<name>.old` and the new one copied in; the window
// sees the server exit with RELAUNCH_EXIT and opens the new Harmonia.exe.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPILED, DATA, SETTINGS } from "./paths";
import { setting } from "./env";

export type UpdateStatus = {
  state: "off" | "idle" | "checking" | "available" | "building" | "ready" | "waiting" | "installing" | "failed";
  from: "release" | "source";
  current?: string; // the running build's commit
  latest?: string; // the branch's commit, or the release's tag
  version?: string; // the running build's release version
  latestVersion?: string; // the latest release's version
  commits?: string[]; // what's new: "abc1234 subject", newest first
  detail?: string; // the step, the error, or why updates are off
  checkedAt?: number;
  auto: boolean;
};

const WIN = process.platform === "win32";
const RESOURCES = dirname(process.execPath);
const APP = WIN ? RESOURCES : dirname(dirname(RESOURCES)); // …/Harmonia.app, or the install folder on Windows
const SOURCE = join(DATA, "source");
/** The build before the last update, to go back by hand. */
const PREVIOUS = join(DATA, "previous");
const LOG = join(DATA, "update.log");
const CHECK_EVERY = 30 * 60_000;
/** Auto-install waits until you haven't sent anything for this long. */
const QUIET = 10 * 60_000;

type Build = { version?: string; commit: string; repo: string; branch: string; builtAt: string; dirty?: boolean };
const build: Build | undefined = (() => {
  if (!COMPILED) return;
  try {
    return JSON.parse(readFileSync(join(RESOURCES, "build.json"), "utf8"));
  } catch {}
})();
const repo: string = SETTINGS.updateRepo ?? build?.repo ?? "";
const branch: string = SETTINGS.updateBranch ?? build?.branch ?? "main";
const auto: boolean = SETTINGS.autoUpdate ?? true;
const from: "release" | "source" = SETTINGS.updateFrom === "source" && !WIN ? "source" : "release";
/** "owner/name" from a GitHub URL or the setting itself. */
const slug = repo.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? (/^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : "");
const API = setting("RELEASES_API") ?? "https://api.github.com";
const APP_ASSET = WIN ? "Harmonia-windows-x64.zip" : "Harmonia-arm64.zip";
const DOWNLOAD = join(DATA, "download");
/** Where the next build waits until it's installed: the clone's build, or the unpacked release. */
const fresh = () =>
  from === "release" ? join(DOWNLOAD, WIN ? "Harmonia-windows-x64" : "Harmonia.app") : join(SOURCE, "build", "Harmonia.app");

let status: UpdateStatus = { state: "off", from, auto, current: build?.commit, version: build?.version || undefined };
let onStatus: (s: UpdateStatus) => void = () => {};
let busyCount: () => number = () => 0;
let beforeRestart: () => void = () => {};
let lastActivity = Date.now();
let installNow = false; // you asked for it: install without waiting for the teammates
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

export function startUpdates(o: { notify: (s: UpdateStatus) => void; busy: () => number; beforeRestart?: () => void }) {
  onStatus = o.notify;
  busyCount = o.busy;
  beforeRestart = o.beforeRestart ?? (() => {});
  if (setting("STUB")) return;
  if (!build) return set({ state: "off", detail: COMPILED ? "This build has no build.json." : "Running from source: update with git." });
  if (!repo) return set({ state: "off", detail: "The build has no git remote. Set updateRepo in settings.json." });
  if (from === "release" && !slug) return set({ state: "off", detail: `Releases come from GitHub, and ${repo} isn't a GitHub repo. Set updateRepo, or "updateFrom": "source".` });
  if (WIN && !existsSync(join(APP, "Harmonia.exe"))) return set({ state: "off", detail: "This is the bare server, without the Harmonia window to restart it. Install Harmonia with its setup program, or update by hand." });
  if (WIN) cleanOld();
  // Installing would clear previous/, this very app. (Builds before 2.1.12 moved the whole bundle there, and macOS
  // finds an app it reopens at login by its file, so it could reopen this backup instead of the new build.)
  if (dirname(APP) === PREVIOUS) return set({ state: "off", detail: `This is the backup copy of Harmonia (${APP}). Quit it and open Harmonia from your Applications folder.` });
  set({ state: "idle" });
  setTimeout(() => checkForUpdates(), 60_000);
  setInterval(() => checkForUpdates(), CHECK_EVERY);
  setInterval(maybeInstall, 30_000);
}

/** Fetches the branch and works out what's new. With auto updates on, starts building it. */
export function checkForUpdates(): Promise<void> {
  if (status.state === "off" || job) return job ?? Promise.resolve();
  if (from === "release") return checkRelease();
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
  rmSync(join(SOURCE, "build", "Harmonia.app"), { recursive: true, force: true });
  set({ state: "building", detail: "building the app" });
  log(`building ${latest}`);
  await sh(["/bin/bash", "macapp/build.sh"], SOURCE, { HARMONIA_REPO: repo, HARMONIA_BRANCH: branch }).catch(
    (e) => {
      failedBuild = latest;
      throw e;
    },
  );
  const built = JSON.parse(readFileSync(join(SOURCE, "build", "Harmonia.app", "Contents", "Resources", "build.json"), "utf8"));
  if (built.commit !== latest) throw new Error(`built ${built.commit}, expected ${latest}`);
  log(`built ${latest}`);
  set({ state: "ready", detail: undefined });
}

/** "Update" on the page: build now if it isn't built, then install right away. */
export async function applyUpdate(): Promise<string | undefined> {
  if (job) await job;
  if (status.state === "failed" && !status.latest) await checkForUpdates();
  if (status.state === "available" || (status.state === "failed" && status.latest)) {
    job = (from === "release" ? getRelease() : buildLatest())
      .catch((e) => set({ state: "failed", detail: (e as Error).message }))
      .finally(() => (job = undefined));
    await job;
  }
  if (status.state !== "ready" && status.state !== "waiting") return status.detail ?? "There's no update to install.";
  installNow = true;
  maybeInstall();
}

function maybeInstall() {
  if (status.state !== "ready" && status.state !== "waiting") return;
  const busy = busyCount();
  const quiet = Date.now() - lastActivity > QUIET;
  if (!installNow && !(auto && quiet)) return;
  // On its own, it waits for the teammates to finish. Asked for, it goes now, and their work picks up after the restart.
  if (!installNow && busy > 0) return set({ state: "waiting", detail: `${busy} teammate${busy === 1 ? " is" : "s or jobs are"} still working` });
  install();
}

/** Exit code that tells the app shell (macapp/main.swift) to quit and open itself again: the new build. */
export const RELAUNCH_EXIT = 75;

// ---------- Restarting for settings ----------
// Settings that need a restart (the settings page) restart the same build the way an update does: RELAUNCH_EXIT, and
// the app shell opens Harmonia again. Unlike "Restart to update" it never cuts anyone off: it waits until no teammate
// and no job is working.

/** Why this run can't restart itself, if it can't: only the app shell can open Harmonia again. */
export function cantRestart(): string | undefined {
  if (!build) return COMPILED ? "This build has no build.json." : "Harmonia is running from source here: stop it and start it again.";
  if (WIN && !existsSync(join(APP, "Harmonia.exe"))) return "This is the bare server, without the Harmonia window to start it again: stop it and start it again.";
}
let restartAsked = false;
let restartTimer: ReturnType<typeof setInterval> | undefined;
export const restartPending = () => restartAsked;
/** "Restart now": right away when nobody is working, else as soon as nobody is. An error message if it can't. */
export function restartWhenIdle(): string | undefined {
  const why = cantRestart();
  if (why) return why;
  restartAsked = true;
  restartTimer ??= setInterval(maybeRestart, 5_000);
  maybeRestart();
}
function maybeRestart() {
  if (!restartAsked || busyCount() > 0 || status.state === "installing") return;
  restartAsked = false;
  log("restarting for settings");
  try {
    beforeRestart();
  } catch (e) {
    log(`saving running work failed: ${(e as Error).message}`);
  }
  setTimeout(() => process.exit(RELAUNCH_EXIT), 300);
}

/**
 * Swaps the build while this one still runs (macOS keeps a running app going when its files are moved), then exits
 * with RELAUNCH_EXIT. The app shell quits and reopens itself through LaunchServices. Nothing can outlive the app to do
 * it instead: macOS ends every process an app started, even launchd jobs, when the app quits.
 *
 * Only Harmonia.app's Contents move; the Harmonia.app folder itself stays put. macOS remembers an app it reopens at
 * login (and a login item, and the Dock) by its file, and follows that file wherever it goes: moving the whole bundle
 * to previous/ made a restart reopen the old build from there.
 * The old build is kept in the data folder's `previous/`, to go back by hand.
 */
async function install() {
  if (WIN) return installWindows();
  set({ state: "installing", detail: "restarting" });
  const next = fresh();
  const contents = join(APP, "Contents");
  const kept = join(PREVIOUS, "Harmonia.app", "Contents");
  try {
    if (!existsSync(join(next, "Contents", "MacOS", "Harmonia"))) throw new Error("the new build isn't there");
    if (dirname(APP) === PREVIOUS) throw new Error("this is the backup copy in previous/");
    rmSync(PREVIOUS, { recursive: true, force: true });
    mkdirSync(dirname(kept), { recursive: true });
    renameSync(contents, kept);
    try {
      // A clone on APFS: instant, and no extra space.
      await sh(["cp", "-cR", join(next, "Contents"), contents]).catch(() => sh(["ditto", join(next, "Contents"), contents]));
    } catch (e) {
      rmSync(contents, { recursive: true, force: true });
      renameSync(kept, contents);
      throw e;
    }
  } catch (e) {
    installNow = false;
    log(`install failed: ${(e as Error).message}`);
    return set({ state: "failed", detail: `Couldn't install the update: ${(e as Error).message}` });
  }
  // LaunchServices keeps what it read from the old Info.plist until it's told the app changed.
  await sh([LSREGISTER, "-f", APP]).catch(() => {});
  log(`installed ${status.latestVersion ?? status.latest} into ${APP}; relaunching`);
  try {
    beforeRestart();
  } catch (e) {
    log(`saving running work failed: ${(e as Error).message}`);
  }
  setTimeout(() => process.exit(RELAUNCH_EXIT), 300);
}

/** The files of an install, swapped in place. The old ones stay beside them as `<name>.old` until the next start. */
async function installWindows() {
  set({ state: "installing", detail: "restarting" });
  const next = fresh();
  const done: string[] = [];
  try {
    for (const f of ["Harmonia.exe", "harmonia-server.exe", "build.json"])
      if (!existsSync(join(next, f))) throw new Error(`the new build has no ${f}`);
    cleanOld();
    for (const e of readdirSync(next, { withFileTypes: true })) {
      if (!e.isFile()) continue; // starter-agents/ and the like are for a fresh install
      const dest = join(APP, e.name);
      if (existsSync(dest)) renameSync(dest, `${dest}.old`);
      done.push(dest);
      copyFileSync(join(next, e.name), dest);
    }
  } catch (e) {
    for (const dest of done.reverse()) {
      try {
        rmSync(dest, { force: true });
        if (existsSync(`${dest}.old`)) renameSync(`${dest}.old`, dest);
      } catch {}
    }
    installNow = false;
    log(`install failed: ${(e as Error).message}`);
    return set({ state: "failed", detail: `Couldn't install the update: ${(e as Error).message}` });
  }
  log(`installed ${status.latestVersion ?? status.latest} into ${APP}; relaunching`);
  try {
    beforeRestart();
  } catch (e) {
    log(`saving running work failed: ${(e as Error).message}`);
  }
  setTimeout(() => process.exit(RELAUNCH_EXIT), 300);
}

/** The previous build's files, left by the last update. The ones still running can't go yet; they go next time. */
function cleanOld() {
  try {
    for (const f of readdirSync(APP)) if (f.endsWith(".old")) rmSync(join(APP, f), { force: true });
  } catch {}
}
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// ---------- Releases ----------

type Asset = { name: string; browser_download_url: string; size: number };
type Release = { tag_name: string; name?: string; body?: string; html_url?: string; assets: Asset[] };

/** 1.10.0 > 1.9.2. A build without a version (made from source) is older than any release. */
const newer = (a: string, b?: string) => {
  const pa = a.split(".").map(Number), pb = (b || "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function github(path: string): Promise<any> {
  const r = await fetch(`${API}/repos/${slug}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "harmonia-updater" } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
}

function checkRelease(): Promise<void> {
  job = (async () => {
    const before = status.state;
    if (before !== "ready" && before !== "waiting") set({ state: "checking", detail: undefined });
    try {
      const rel: Release | undefined = await github("/releases/latest");
      if (!rel) return set({ state: "idle", checkedAt: Date.now(), detail: "No releases yet." });
      const v = rel.tag_name.replace(/^v/, "");
      if (!newer(v, build!.version)) {
        if (before === "ready" || before === "waiting") return set({ state: before, checkedAt: Date.now() });
        return set({ state: "idle", latest: rel.tag_name, latestVersion: v, commits: [], checkedAt: Date.now(), detail: undefined });
      }
      if ((before === "ready" || before === "waiting") && status.latestVersion === v) return set({ checkedAt: Date.now() });
      // A release without this platform's app (one still uploading, or made before Windows builds) isn't a failure.
      if (!rel.assets.some((a) => a.name === APP_ASSET)) {
        if (before === "ready" || before === "waiting") return set({ state: before, checkedAt: Date.now() });
        return set({ state: "idle", latest: undefined, latestVersion: undefined, commits: [], checkedAt: Date.now(), detail: `${rel.tag_name} has no ${APP_ASSET}.` });
      }
      // What's new: the release notes' bullet lines ("* Teammates text like people by @x in #12").
      const commits = (rel.body ?? "").split("\n").filter((l) => /^\s*[*-] /.test(l)).map((l) => l.replace(/^\s*[*-] /, "").replace(/ by @\S+ in \S+$/, "")).slice(0, 15);
      set({ state: "available", latest: rel.tag_name, latestVersion: v, commits: commits.length ? commits : [`${rel.tag_name}`], checkedAt: Date.now(), detail: undefined });
      if (auto && failedBuild !== rel.tag_name) await getRelease(rel);
    } catch (e) {
      set({ state: "failed", detail: (e as Error).message, checkedAt: Date.now() });
    }
  })().finally(() => (job = undefined));
  return job;
}

/** Downloads a file and checks it against the SHA-256 published next to it (`<name>.sha256`). */
async function download(assets: Asset[], name: string, to: string) {
  const asset = assets.find((a) => a.name === name);
  const sum = assets.find((a) => a.name === `${name}.sha256`);
  if (!asset || !sum) throw new Error(`the release has no ${name}${asset ? ".sha256" : ""}`);
  const expected = (await (await fetch(sum.browser_download_url, { signal: AbortSignal.timeout(60_000) })).text()).trim().split(/\s+/)[0];
  const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`downloading ${name} failed (${r.status})`);
  // Streamed to the file chunk by chunk (Bun.write(path, response) stalled inside the server).
  const w = Bun.file(to).writer();
  for await (const chunk of r.body) w.write(chunk);
  await w.end();
  const actual = await new Promise<string>((ok, no) => {
    const h = createHash("sha256");
    createReadStream(to).on("data", (c) => h.update(c)).on("end", () => ok(h.digest("hex"))).on("error", no);
  });
  if (!/^[0-9a-f]{64}$/i.test(expected) || actual !== expected.toLowerCase()) throw new Error(`${name} doesn't match its checksum`);
}

/** Gets the latest release ready next to the running app: unpacked and signed. Nothing is replaced yet. */
async function getRelease(rel?: Release) {
  try {
    rel ??= await github(`/releases/tags/${status.latest}`);
    if (!rel) throw new Error(`release ${status.latest} is gone`);
    const v = rel.tag_name.replace(/^v/, "");
    rmSync(DOWNLOAD, { recursive: true, force: true });
    mkdirSync(DOWNLOAD, { recursive: true });
    set({ state: "building", detail: `downloading ${rel.tag_name}` });
    const zip = join(DOWNLOAD, APP_ASSET);
    await download(rel.assets, APP_ASSET, zip);
    set({ state: "building", detail: "unpacking" });
    // Windows 10 and 11 ship bsdtar, which reads zips. (Not just `tar`: Git's GNU tar may come first on the PATH.)
    if (WIN) await sh([join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe"), "-xf", zip, "-C", DOWNLOAD]);
    else await sh(["ditto", "-x", "-k", zip, DOWNLOAD]);
    rmSync(zip);
    const next = fresh();
    const got: Build = JSON.parse(readFileSync(WIN ? join(next, "build.json") : join(next, "Contents", "Resources", "build.json"), "utf8"));
    if (got.version !== v) throw new Error(`the download is version ${got.version}, not ${v}`);
    if (!WIN) {
      // Files the app downloads itself aren't quarantined; clear it anyway, then sign the whole app again (ad hoc).
      await sh(["xattr", "-dr", "com.apple.quarantine", next]).catch(() => {});
      await sh(["codesign", "--force", "--deep", "--sign", "-", next]);
    }
    log(`downloaded ${rel.tag_name}`);
    set({ state: "ready", detail: undefined });
  } catch (e) {
    failedBuild = status.latest;
    log(`release ${status.latest} failed: ${(e as Error).message}`);
    throw e;
  }
}

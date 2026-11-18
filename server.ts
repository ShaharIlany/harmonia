import { existsSync, mkdirSync, statSync } from "node:fs";
import indexHtml from "./public/index.html" with { type: "file" };
import appJs from "./public/app.js" with { type: "file" };
import agentPageJs from "./public/agent-page.js" with { type: "file" };
import markdownJs from "./public/markdown.js" with { type: "file" };
import styleCss from "./public/style.css" with { type: "file" };
import type { ServerWebSocket } from "bun";
import { EFFORTS, MODELS, deleteMemory, listMemories, memoryDir, readAgent, readMemory, validMemoryName, writeAgent, writeMemory } from "./agents";
import { CHAT_EFFORTS, CHAT_MODELS, ROSTER, USER_NAME, teammate, updateTeammate } from "./roster";
import { CLAUDE, onUsage, probeUsage, type Usage } from "./runner";
import { CHANNEL_STATUSES, channels, createChannel, messages } from "./store";
import { CLICKUP_TASK_PREFIX, CLICKUP_WORKSPACE } from "./paths";
import { layaStatus, startLaya, stopLaya, type LayaStatus } from "./laya";
import { applyUpdate, checkForUpdates, noteActivity, startUpdates, updateStatus, type UpdateStatus } from "./updates";
import { DEFAULT_CWD, TEAM_AGENTS, Team, allChannels, jobTitle, type Event } from "./team";

const PORT = Number(process.env.PORT ?? 4747);
// The page's files, embedded in the compiled app.
const PUBLIC: Record<string, string> = {
  "index.html": indexHtml,
  "app.js": appJs,
  "agent-page.js": agentPageJs,
  "markdown.js": markdownJs,
  "style.css": styleCss,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only this page may drive the team: the agents can edit files and run commands.
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const sockets = new Set<ServerWebSocket<unknown>>();
const broadcast = (e: Event | { type: "roster"; roster: typeof ROSTER } | { type: "usage"; usage: Usage } | { type: "laya"; laya: LayaStatus } | { type: "update"; update: UpdateStatus }) => {
  const data = JSON.stringify(e);
  for (const s of sockets) s.send(data);
};
mkdirSync(TEAM_AGENTS, { recursive: true });
const team = new Team(broadcast, `http://127.0.0.1:${PORT}`);

if (!channels.size) createChannel("general", DEFAULT_CWD);

// The router's local model starts with the server and stops with it.
startLaya((laya) => broadcast({ type: "laya", laya }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopLaya(), process.exit(0)));
process.on("exit", stopLaya);

// Over-the-air updates from git (updates.ts). An install waits until no teammate or job is working.
const working = () => team.sessions().filter((s) => s.busyIn).length + allChannels().reduce((n, c) => n + c.jobs.filter((j) => j.status === "running").length, 0);
startUpdates({ notify: (update) => broadcast({ type: "update", update }), busy: working });

// Plan usage (5-hour and weekly windows): every run reports it, and a tiny probe fills it in when nothing ran lately.
let usage: Usage | undefined;
onUsage((u) => {
  usage = u;
  broadcast({ type: "usage", usage: u });
});
let probing: Promise<void> | undefined;
function refreshUsage(maxAgeMs: number) {
  if (probing || (usage && Date.now() - usage.at < maxAgeMs)) return;
  probing = probeUsage(TEAM_AGENTS).catch(() => {}).finally(() => (probing = undefined));
}
refreshUsage(0);

const json = (data: unknown, status = 200) => Response.json(data, { status });
const state = () => ({
  user: USER_NAME,
  roster: ROSTER,
  models: MODELS,
  efforts: EFFORTS,
  chatModels: Object.fromEntries(Object.entries(CHAT_MODELS).map(([id, m]) => [id, m.label])),
  chatEfforts: CHAT_EFFORTS,
  teamAgents: TEAM_AGENTS,
  clickupWorkspace: CLICKUP_WORKSPACE,
  clickupTaskPrefix: CLICKUP_TASK_PREFIX,
  laya: layaStatus(),
  update: updateStatus(),
  usage,
  sessions: team.sessions(),
  defaultCwd: DEFAULT_CWD,
  stub: !!process.env.TEAM_CHAT_STUB,
  channels: allChannels(),
  activity: Object.fromEntries(allChannels().map((c) => [c.id, team.activityFor(c.id)])),
});

function agentDetails(id: string) {
  const t = teammate(id)!;
  const jobs = allChannels()
    .flatMap((c) => c.jobs.filter((j) => j.agentId === id).map((j) => ({ channelId: c.id, ...j, sessionTitle: jobTitle(c, id, j.title) })))
    .sort((x, y) => Number(y.status === "running") - Number(x.status === "running") || y.startedAt - x.startedAt)
    .slice(0, 20);
  return { ...t, ...readAgent(id), memoryDir: memoryDir(id), memories: listMemories(id), session: team.sessions().find((s) => s.agentId === id), jobs };
}

// ---------- Mac helpers ----------

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { code: p.exitCode, out };
};

/** Opens a CLI session in the Claude desktop app (it imports the session by id). */
const openInClaude = (sessionId: string) => run(["open", `claude://resume?session=${sessionId}`]);

let authCache: { at: number; value: unknown } | undefined;
async function cliAuth(fresh = false) {
  if (!fresh && authCache && Date.now() - authCache.at < 20_000) return authCache.value;
  const { out } = await run([CLAUDE, "auth", "status", "--json"]);
  let value: any;
  try {
    const s = JSON.parse(out);
    value = { loggedIn: !!s.loggedIn, method: s.authMethod, expiresAt: s.loginExpiresAt ?? null, email: s.email ?? s.account?.email ?? null };
  } catch {
    value = { loggedIn: false, error: out.trim().slice(0, 200) || "claude auth status failed" };
  }
  authCache = { at: Date.now(), value };
  return value;
}

/** Opens Terminal on `claude auth login`, which hands off to the browser sign-in. */
function startCliLogin() {
  authCache = undefined;
  const cmd = `${CLAUDE.replace(/(["\\])/g, "\\$1")} auth login --claudeai`;
  return run(["osascript", "-e", `tell application "Terminal" to do script "${cmd}"`, "-e", `tell application "Terminal" to activate`]);
}

// ---------- HTTP ----------

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  websocket: {
    open: (ws) => void sockets.add(ws),
    close: (ws) => void sockets.delete(ws),
    message: () => {},
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/ws") {
      if (!ORIGINS.has(req.headers.get("origin") ?? "")) return new Response("forbidden", { status: 403 });
      return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // A chat session's job tools (job-tools.ts) call back here, with a token that's only good for that turn.
    const turn = p.match(/^\/api\/turn\/([0-9a-f-]{36})\/(start_job|check_jobs|stop_job)$/);
    if (turn && req.method === "POST") {
      const r = team.turnTool(turn[1], turn[2], await req.json().catch(() => ({})));
      return r.error ? json({ error: r.error }, 403) : json({ text: r.text });
    }

    if (p.startsWith("/api/")) {
      if (req.method !== "GET") {
        if (!ORIGINS.has(req.headers.get("origin") ?? "") || !req.headers.get("content-type")?.includes("application/json"))
          return json({ error: "forbidden" }, 403);
      }
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const post = req.method === "POST";

      if (p === "/api/state") return json(state());

      if (p === "/api/update/check" && post) {
        await checkForUpdates();
        return json(updateStatus());
      }
      if (p === "/api/update/apply" && post) {
        const err = await applyUpdate();
        return err ? json({ error: err }, 409) : json(updateStatus());
      }
      // Anything else you do on the page holds back an automatic install for a while.
      if (post && p !== "/api/usage") noteActivity();

      // The page asks when it's shown again; a probe runs only if no run reported usage in the last 5 minutes.
      if (p === "/api/usage" && post) {
        refreshUsage(5 * 60_000);
        return json({ usage });
      }

      if (p === "/api/cli-auth" && !post) return json(await cliAuth(url.searchParams.has("fresh")));
      if (p === "/api/cli-auth/login" && post) {
        const r = await startCliLogin();
        return r.code === 0 ? json({ ok: true }) : json({ error: "Couldn't open Terminal." }, 500);
      }

      if (p === "/api/channels" && post) {
        const name = String(body.name ?? "").trim();
        const cwd = String(body.cwd ?? "").trim() || DEFAULT_CWD;
        if (!name) return json({ error: "Give the channel a name." }, 400);
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return json({ error: `No such folder: ${cwd}` }, 400);
        const ch = createChannel(name, cwd);
        broadcast({ type: "channel", channel: ch });
        return json(ch);
      }

      // ----- Teammate settings -----
      const a = p.match(/^\/api\/agents\/([a-z0-9_-]+)(?:\/memories\/([^/]+)|\/(open-session|reset-session))?$/);
      if (a) {
        const id = a[1];
        if (!teammate(id)) return json({ error: "No such teammate." }, 404);
        if (a[3] === "open-session" && post) {
          const sid = team.sessions().find((s) => s.agentId === id)?.sessionId;
          if (!sid || !UUID.test(sid)) return json({ error: "No session yet: it starts on the first message to them." }, 404);
          const r = await openInClaude(sid);
          return r.code === 0 ? json({ ok: true }) : json({ error: "Couldn't open the Claude app." }, 500);
        }
        if (a[3] === "reset-session" && post) {
          const err = team.resetSession(id);
          return err ? json({ error: err }, 409) : json(agentDetails(id));
        }
        if (a[3]) return json({ error: "not found" }, 404);
        const file = a[2] && decodeURIComponent(a[2]);
        if (file !== undefined) {
          if (!validMemoryName(file)) return json({ error: "Memory files are named like notes.md." }, 400);
          if (!post) {
            try {
              return json({ name: file, content: readMemory(id, file) });
            } catch {
              return json({ error: "No such memory." }, 404);
            }
          }
          if (body.delete) deleteMemory(id, file);
          else writeMemory(id, file, String(body.content ?? ""));
          return json(agentDetails(id));
        }
        if (!post) return json(agentDetails(id));
        const profile = {
          ...(body.name !== undefined && { name: String(body.name).trim() }),
          ...(body.avatar !== undefined && { avatar: String(body.avatar) }),
          ...(body.role !== undefined && { role: String(body.role) }),
          ...(body.color !== undefined && { color: String(body.color) }),
          ...(body.chatModel !== undefined && { chatModel: String(body.chatModel) }),
          ...(body.chatEffort !== undefined && { chatEffort: String(body.chatEffort) }),
          ...(body.routing !== undefined && { routing: String(body.routing) }),
        };
        const err =
          (Object.keys(profile).length ? updateTeammate(id, profile) : undefined) ??
          writeAgent(id, {
            ...(body.model !== undefined && { model: String(body.model) }),
            ...(body.effort !== undefined && { effort: String(body.effort) }),
            ...(body.instructions !== undefined && { instructions: String(body.instructions) }),
          });
        if (err) return json({ error: err }, 400);
        broadcast({ type: "roster", roster: ROSTER });
        return json(agentDetails(id));
      }

      // ----- Channels -----
      const m = p.match(/^\/api\/channels\/([^/]+)\/(messages|stop|stop-job|permission|tools|open-session|retry|status|task|open-task)$/);
      const ch = m && channels.get(m[1]);
      if (!m || !ch) return json({ error: "not found" }, 404);

      if (m[2] === "messages" && !post) return json(messages.get(ch.id) ?? []);
      if (m[2] === "status" && post) {
        const status = body.status || undefined;
        if (status !== undefined && !CHANNEL_STATUSES.includes(status)) return json({ error: "Unknown status." }, 400);
        const err = team.setStatus(ch, status);
        return err ? json({ error: err }, 409) : json(ch);
      }
      if (m[2] === "task" && post) {
        const err = team.setTask(ch, String(body.task ?? ""));
        return err ? json({ error: err }, 400) : json(ch);
      }
      if (m[2] === "open-task" && post) {
        // Only the channel's own task link, and only ClickUp, in Chrome (or the default browser without it).
        if (!ch.task || !ch.task.url.startsWith("https://app.clickup.com/")) return json({ error: "This channel has no ClickUp task." }, 404);
        let r = await run(["open", "-a", "Google Chrome", ch.task.url]);
        if (r.code !== 0) r = await run(["open", ch.task.url]);
        return r.code === 0 ? json({ ok: true }) : json({ error: "Couldn't open the task." }, 500);
      }
      if (ch.status === "archived" && post && m[2] !== "open-session") return json({ error: `#${ch.name} is archived. Unarchive it to post.` }, 409);
      if (m[2] === "messages" && post) {
        const text = String(body.text ?? "").trim();
        if (!text) return json({ error: "empty" }, 400);
        team.userMessage(ch, text, body.replyTo ? String(body.replyTo) : undefined);
        return json({ ok: true });
      }
      if (m[2] === "stop" && post) {
        team.stop(ch, String(body.agentId));
        return json({ ok: true });
      }
      if (m[2] === "permission" && post) {
        const decision = body.decision;
        if (!["once", "always", "denied"].includes(decision)) return json({ error: "bad decision" }, 400);
        team.decide(ch, String(body.messageId), decision);
        return json({ ok: true });
      }
      if (m[2] === "tools" && post) {
        if (!["approved", "denied"].includes(body.decision)) return json({ error: "bad decision" }, 400);
        const err = team.decideTools(ch, String(body.messageId), body.decision);
        return err ? json({ error: err }, 409) : json({ ok: true });
      }
      if (m[2] === "retry" && post) {
        team.retry(ch, String(body.messageId));
        return json({ ok: true });
      }
      if (m[2] === "stop-job" && post) return json({ message: team.stopJob(ch, String(body.jobId)) });
      if (m[2] === "open-session" && post) {
        const sid = team.jobSession(ch, String(body.jobId));
        if (!sid || !UUID.test(sid)) return json({ error: "That session doesn't exist yet." }, 404);
        const r = await openInClaude(sid);
        return r.code === 0 ? json({ ok: true }) : json({ error: "Couldn't open the Claude app." }, 500);
      }
      return json({ error: "not found" }, 404);
    }

    const file = PUBLIC[p === "/" ? "index.html" : p.slice(1)];
    if (!file) return new Response("not found", { status: 404 });
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
    return new Response(Bun.file(file), { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" } });
  },
});

console.log(`Team chat on http://localhost:${PORT}${process.env.TEAM_CHAT_STUB ? " (stub teammates)" : ""}`);

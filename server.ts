import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import indexHtml from "./public/index.html" with { type: "file" };
import appJs from "./public/app.js" with { type: "file" };
import agentPageJs from "./public/agent-page.js" with { type: "file" };
import slackPageJs from "./public/slack-page.js" with { type: "file" };
import markdownJs from "./public/markdown.js" with { type: "file" };
import styleCss from "./public/style.css" with { type: "file" };
import type { ServerWebSocket } from "bun";
import { EFFORTS, MODELS, deleteMemory, listMemories, memoryDir, readAgent, readMemory, validMemoryName, writeAgent, writeMemory } from "./agents";
import { CHAT_EFFORTS, CHAT_MODELS, ROSTER, USER_NAME, teammate, updateTeammate } from "./roster";
import { CLAUDE, onUsage, probeUsage, type Usage } from "./runner";
import { CHANNEL_STATUSES, channels, createChannel, dmOf, messages, saveMessages, type Channel, type ChannelStatus, type Message } from "./store";
import { CLICKUP_TASK_PREFIX, CLICKUP_WORKSPACE } from "./paths";
import { setting } from "./env";
import { applyUpdate, checkForUpdates, noteActivity, startUpdates, updateStatus, type UpdateStatus } from "./updates";
import { DEFAULT_CWD, TEAM_AGENTS, Team, allChannels, jobTitle, type Event } from "./team";
import { SlackBridge, type SlackEvent } from "./slack";
import { claudeProjects } from "./projects";
import { INLINE_IMAGE, MAX_FILE, attachmentPath, dropUnsent, fileSize, findAttachment, saveAttachment, stage, takeStaged } from "./attachments";

const PORT = Number(process.env.PORT ?? 4747);
// The page's files, embedded in the compiled app.
const PUBLIC: Record<string, string> = {
  "index.html": indexHtml,
  "app.js": appJs,
  "agent-page.js": agentPageJs,
  "slack-page.js": slackPageJs,
  "markdown.js": markdownJs,
  "style.css": styleCss,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only this page may drive the team: the agents can edit files and run commands.
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const sockets = new Set<ServerWebSocket<unknown>>();
let toSlack: ((e: Event) => void) | undefined; // the Slack bridge (below) follows every channel event
const broadcast = (e: Event | SlackEvent | { type: "roster"; roster: typeof ROSTER } | { type: "usage"; usage: Usage } | { type: "appUpdate"; update: UpdateStatus }) => {
  const data = JSON.stringify(e);
  for (const s of sockets) s.send(data);
  if ("channelId" in e || e.type === "channel") toSlack?.(e as Event); // "channel": its status and task, in Slack's topic
};
mkdirSync(TEAM_AGENTS, { recursive: true });
const team = new Team(broadcast, `http://127.0.0.1:${PORT}`);

/** Your reaction on a message (one at a time, like a teammate's), or none. From the page, or from Slack. */
function setReaction(ch: Channel, msg: Message, emoji: string | undefined) {
  msg.meta ??= {};
  msg.meta.reactions = [...(msg.meta.reactions ?? []).filter((x) => x.by !== "user"), ...(emoji ? [{ by: "user", emoji }] : [])];
  saveMessages(ch.id);
  broadcast({ type: "update", channelId: ch.id, message: msg });
}

// Slack (slack.ts): one Slack app the teammates talk through, your DM with it, and linked channels and group DMs.
const slack = new SlackBridge({
  emit: broadcast,
  post: (ch, text, from) => team.userMessage(ch, text, from.replyTo, { via: "slack", slack: from.slack, files: from.files, voice: from.voice }),
  guest: (ch, name, text, slackId, ref, files, voice) => team.guestMessage(ch, name, text, slackId, ref, files, voice),
  note: (ch, text) => void team.post(ch, { author: "system", text, meta: { via: "slack" } }),
  react: setReaction,
  feedback: (ch, messageId, text) => team.feedback(ch, messageId, text, { via: "slack" }),
  decideTools: (ch, messageId, decision) => team.decideTools(ch, messageId, decision),
  decide: (ch, messageId, decision) => team.decide(ch, messageId, decision),
  openSession: (ch, jobId) => openJobSession(ch, jobId),
  channelCreated: (channel) => broadcast({ type: "channel", channel }),
  channelChanged: (channel) => broadcast({ type: "channel", channel }),
  setStatus: (ch, status) => setStatus(ch, status),
  answering: (channelId, agentId) => team.answering(channelId, agentId).answers,
  log: (event, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })),
});
toSlack = (e) => slack.onEvent(e);
slack.start();

/** A channel's status, from the page or from Slack. Slack follows: an archived channel leaves it, an unarchived one gets a new Slack channel. */
function setStatus(ch: Channel, status: ChannelStatus | undefined): string | undefined {
  const before = ch.status;
  const err = team.setStatus(ch, status);
  if (!err) slack.statusChanged(ch, before);
  return err;
}

if (!channels.size) createChannel("general", DEFAULT_CWD);
dropUnsent(messages);

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (slack.stop(), process.exit(0)));

// Over-the-air updates (updates.ts). "Restart to update" restarts now: whatever is working is written down first and
// picked up again by the next build. An automatic install waits until no teammate or job is working.
const working = () => team.sessions().filter((s) => s.busyIn).length + allChannels().reduce((n, c) => n + c.jobs.filter((j) => j.status === "running").length, 0);
startUpdates({ notify: (update) => broadcast({ type: "appUpdate", update }), busy: working, beforeRestart: () => team.closeForRestart() });
team.resumeAfterRestart();

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
/** The chat list's line under each channel: its latest message, clipped. */
const preview = (id: string) => {
  const m = (messages.get(id) ?? []).findLast((x: Message) => x.kind !== "status");
  const meta = { ...(m?.meta?.jobId && { jobId: m.meta.jobId }), ...(m?.meta?.files?.length && { files: m.meta.files.map((f) => ({ name: f.name, type: f.type })) }) };
  return m && { id: m.id, author: m.author, kind: m.kind ?? "text", text: m.text.slice(0, 200), ts: m.ts, meta: Object.keys(meta).length ? meta : undefined };
};
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
  update: updateStatus(),
  usage,
  sessions: team.sessions(),
  slack: slack.status(),
  slackLinks: slack.linkViews(),
  defaultCwd: DEFAULT_CWD,
  stub: !!setting("STUB"),
  channels: allChannels(),
  previews: Object.fromEntries(allChannels().map((c) => [c.id, preview(c.id)])),
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

/** Opens a file in its default app, or shows it in the Finder. */
const openFile = async (path: string, reveal: boolean) => {
  if (process.platform !== "darwin") return run(["xdg-open", reveal ? join(path, "..") : path]).catch(() => ({ code: 1, out: "" }));
  return run(reveal ? ["open", "-R", path] : ["open", path]);
};

/**
 * A file attached to a message, for the page (a picture's thumbnail). Only pictures show as they are; anything else
 * downloads, and nothing in a file runs as the page (an HTML or SVG file someone attached in Slack, say).
 */
function serveFile(path: string, name: string, type: string) {
  const inline = INLINE_IMAGE.test(type);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": inline ? type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/** Opens a CLI session in the Claude desktop app (it imports the session by id). */
const openInClaude = (sessionId: string) => run(["open", `claude://resume?session=${sessionId}`]);

/** A job's session in the Claude app (the page's button, and View in Claude in Slack). An error, if it couldn't. */
async function openJobSession(ch: Channel, jobId: string): Promise<string | undefined> {
  const sid = team.jobSession(ch, jobId);
  if (!sid || !UUID.test(sid)) return "That session doesn't exist yet.";
  return (await openInClaude(sid)).code === 0 ? undefined : "Couldn't open the Claude app.";
}

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

/** Runs a command in a new Terminal window, for sign-ins and installs that need you. */
const inTerminal = (cmd: string) =>
  run(["osascript", "-e", `tell application "Terminal" to do script "${cmd.replace(/(["\\])/g, "\\$1")}"`, "-e", `tell application "Terminal" to activate`]);

/** Opens Terminal on `claude auth login`, which hands off to the browser sign-in. */
function startCliLogin() {
  authCache = undefined;
  return inTerminal(`${CLAUDE} auth login --claudeai`);
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
    const turn = p.match(/^\/api\/turn\/([0-9a-f-]{36})\/(start_job|check_jobs|stop_job|request_tool)$/);
    if (turn && req.method === "POST") {
      const r = team.turnTool(turn[1], turn[2], await req.json().catch(() => ({})));
      return r.error ? json({ error: r.error }, 403) : json({ text: r.text });
    }

    // A file you attach in the composer: its bytes as the body (application/octet-stream, which no other site can send
    // here without asking first), its name and type in headers. It waits for the message (attachments.ts).
    const up = p.match(/^\/api\/channels\/([^/]+)\/upload$/);
    if (up && req.method === "POST") {
      if (!ORIGINS.has(req.headers.get("origin") ?? "") || !req.headers.get("content-type")?.includes("application/octet-stream")) return json({ error: "forbidden" }, 403);
      const ch = channels.get(up[1]);
      if (!ch) return json({ error: "not found" }, 404);
      if (ch.status === "archived") return json({ error: `#${ch.name} is archived. Unarchive it to post.` }, 409);
      const size = Number(req.headers.get("content-length") ?? NaN);
      if (size > MAX_FILE) return json({ error: `That file is ${fileSize(size)}. Files are up to ${fileSize(MAX_FILE)}.` }, 413);
      let name = "file";
      try {
        name = decodeURIComponent(req.headers.get("x-file-name") ?? "") || name;
      } catch {}
      try {
        const file = await saveAttachment(ch.id, name, req.headers.get("x-file-type") ?? undefined, req.body);
        stage(ch.id, file);
        noteActivity();
        return json(file);
      } catch (e) {
        return json({ error: `Couldn't keep ${name}: ${(e as Error).message}` }, 400);
      }
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

      // ----- Slack -----
      const slackState = () => ({ slack: slack.status(), links: slack.linkViews() });
      if (p === "/api/slack" && !post) return json(slackState());
      const sa = p.match(/^\/api\/slack\/(connect|enabled|remove|repair|unlink|check)$/);
      if (sa && post) {
        let err: string | undefined;
        try {
          if (sa[1] === "connect") err = await slack.connectApp(String(body.botToken ?? ""), String(body.appToken ?? ""));
          else if (sa[1] === "enabled") err = slack.setEnabled(Boolean(body.enabled));
          else if (sa[1] === "repair") err = slack.repair();
          else if (sa[1] === "unlink") err = slack.unlink(String(body.conversationId ?? ""));
          else if (sa[1] === "check") err = await slack.checkScopes();
          else err = await slack.remove();
        } catch (e) {
          err = (e as Error).message;
        }
        return err ? json({ error: err, ...slackState() }, 400) : json(slackState());
      }
      // The teammates' own Slack apps: make them (with a configuration token), connect one (its bot token), forget one,
      // and let you DM one (its app-level token), or stop.
      const sm = p.match(/^\/api\/slack\/teammates\/(make|connect|forget|dms|dms-off)$/);
      if (sm && post) {
        let err: string | undefined;
        try {
          const icons = body.icons && typeof body.icons === "object" ? Object.fromEntries(Object.entries(body.icons).map(([k, v]) => [k, String(v)])) : {};
          if (sm[1] === "make") err = await slack.makeMateApps(String(body.configToken ?? ""), icons);
          else if (sm[1] === "connect") err = await slack.connectMate(String(body.id ?? ""), String(body.botToken ?? ""));
          else if (sm[1] === "dms") err = await slack.connectMateDms(String(body.id ?? ""), String(body.appToken ?? ""));
          else if (sm[1] === "dms-off") err = await slack.stopMateDms(String(body.id ?? ""));
          else err = await slack.forgetMate(String(body.id ?? ""));
        } catch (e) {
          err = (e as Error).message;
        }
        return err ? json({ error: err, ...slackState() }, 400) : json(slackState());
      }

      // Your Claude projects (projects.ts), offered as a new channel's folder.
      if (p === "/api/projects") return json(claudeProjects());

      if (p === "/api/channels" && post) {
        const name = String(body.name ?? "").trim();
        const cwd = String(body.cwd ?? "").trim() || DEFAULT_CWD;
        if (!name) return json({ error: "Give the channel a name." }, 400);
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return json({ error: `No such folder: ${cwd}` }, 400);
        const ch = createChannel(name, cwd);
        broadcast({ type: "channel", channel: ch });
        slack.channelAdded(ch); // a private Slack channel for it, when Slack is connected
        return json(ch);
      }

      // Your DM with a teammate: made the first time you open it.
      const dm = p.match(/^\/api\/dms\/([a-z0-9_-]+)$/);
      if (dm && post) {
        if (!teammate(dm[1])) return json({ error: "No such teammate." }, 404);
        let ch = dmOf(dm[1]);
        if (!ch) {
          ch = createChannel(`dm ${dm[1]}`, DEFAULT_CWD, dm[1]);
          broadcast({ type: "channel", channel: ch });
          slack.channelAdded(ch); // linked to your Slack DM with the teammate's own app, when it takes DMs
        }
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
      // A file on a message: shown (a picture), opened in its app, or shown in the Finder.
      const f = p.match(/^\/api\/channels\/([^/]+)\/files\/([0-9a-f]{12})(?:\/(open|reveal))?$/);
      const fch = f && channels.get(f[1]);
      if (f) {
        const file = fch && findAttachment(fch.id, messages.get(fch.id) ?? [], f[2]);
        const path = file && attachmentPath(fch!.id, file);
        if (!file || !path || !existsSync(path)) return json({ error: "That file is gone." }, 404);
        if (!f[3] && !post) return serveFile(path, file.name, file.type);
        if (!f[3] || !post) return json({ error: "not found" }, 404);
        const r = await openFile(path, f[3] === "reveal");
        return r.code === 0 ? json({ ok: true }) : json({ error: `Couldn't open ${file.name}.` }, 500);
      }

      const m = p.match(/^\/api\/channels\/([^/]+)\/(messages|stop|stop-job|permission|tools|open-session|retry|status|task|open-task|open-folder|react|feedback)$/);
      const ch = m && channels.get(m[1]);
      if (!m || !ch) return json({ error: "not found" }, 404);

      if (m[2] === "messages" && !post) return json(messages.get(ch.id) ?? []);
      if (m[2] === "status" && post) {
        const status = body.status || undefined;
        if (status !== undefined && !CHANNEL_STATUSES.includes(status)) return json({ error: "Unknown status." }, 400);
        const err = setStatus(ch, status);
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
      if (m[2] === "open-folder" && post) {
        if (!existsSync(ch.cwd)) return json({ error: `The folder is gone: ${ch.cwd}` }, 404);
        const r = await run(["open", ch.cwd]);
        return r.code === 0 ? json({ ok: true }) : json({ error: "Couldn't open the folder." }, 500);
      }
      if (ch.status === "archived" && post && m[2] !== "open-session") return json({ error: `#${ch.name} is archived. Unarchive it to post.` }, 409);
      if (m[2] === "messages" && post) {
        const text = String(body.text ?? "").trim();
        const files = takeStaged(ch.id, body.files);
        if (typeof files === "string") return json({ error: files }, 400);
        if (!text && !files.length) return json({ error: "empty" }, 400);
        team.userMessage(ch, text, body.replyTo ? String(body.replyTo) : undefined, { files });
        return json({ ok: true });
      }
      // Your emoji on a message, like a teammate's. The same emoji again takes it off.
      if (m[2] === "feedback" && post) {
        const text = String(body.text ?? "").trim();
        if (!text) return json({ error: "Write your feedback first." }, 400);
        if (text.length > 4000) return json({ error: "Feedback is up to 4000 characters." }, 400);
        const err = team.feedback(ch, String(body.messageId ?? ""), text);
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      if (m[2] === "react" && post) {
        const msg = (messages.get(ch.id) ?? []).find((x) => x.id === String(body.messageId));
        const emoji = String(body.emoji ?? "");
        if (!msg) return json({ error: "No such message." }, 404);
        if (!emoji || emoji.length > 16 || /[\w\s<>]/.test(emoji)) return json({ error: "That isn't an emoji." }, 400);
        const mine = msg.meta?.reactions?.find((x) => x.by === "user");
        setReaction(ch, msg, mine?.emoji === emoji ? undefined : emoji);
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
        const err = await openJobSession(ch, String(body.jobId));
        return err ? json({ error: err }, 500) : json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    const file = PUBLIC[p === "/" ? "index.html" : p.slice(1)];
    if (!file) return new Response("not found", { status: 404 });
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
    return new Response(Bun.file(file), { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" } });
  },
});

console.log(`Harmonia on http://localhost:${PORT}${setting("STUB") ? " (stub teammates)" : ""}`);

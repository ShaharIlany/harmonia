import { readFileSync } from "node:fs";
import { join } from "node:path";
import chatRulesFile from "./chat-rules.md" with { type: "file" };
import jobRulesFile from "./job-rules.md" with { type: "file" };
import feedbackRulesFile from "./feedback-rules.md" with { type: "file" };
import { CLICKUP_TASK_PREFIX, CLICKUP_WORKSPACE, DATA, DEFAULT_CWD, TEAM_AGENTS, jobToolsCommand } from "./paths";
import { setting } from "./env";
import { addTools, agentFile, memoryDir, readAgent } from "./agents";
import { resolveTools, suggestTools } from "./tool-catalog";
import { ROSTER, TRIAGE, USER_NAME, addressedAtStart, handoffs, mentions, nameOf, teammate } from "./roster";
import { decide } from "./mozart";
import { chatToolsFor, quickAnswer, runAgent, type Run, type RunResult } from "./runner";
import {
  addMessage,
  agentSessions,
  channels,
  firstChatSessions,
  messages,
  saveAgentSessions,
  saveChannels,
  saveMessages,
  type AgentSession,
  type Channel,
  type ChannelStatus,
  type Job,
  type Message,
  type SlackRef,
} from "./store";

/** How often a running job posts a status update in its channel (minutes; HARMONIA_STATUS_MINUTES). */
const STATUS_EVERY_MS = Number(setting("STATUS_MINUTES") ?? 5) * 60_000;
/** Agent turns allowed after one user message before the chat pauses (stops ping-pong). */
const MAX_TURNS_PER_USER_MESSAGE = 8;
const STUB = !!setting("STUB");

// TEAM_AGENTS: the Claude Code project that holds the six chat sessions. Claude Code files a session (and its
// prompt cache) under the folder it started in, so every chat turn runs there, whatever the channel. Jobs run in
// the channel's folder.
export { DEFAULT_CWD, TEAM_AGENTS };

export type SessionView = AgentSession & {
  agentId: string;
  title: string;
  busyIn?: string; // channel id it's answering in
  activity?: string;
  queue: string[]; // channel ids waiting for it
};

export type Event =
  | { type: "message"; channelId: string; message: Message }
  | { type: "update"; channelId: string; message: Message }
  | { type: "activity"; channelId: string; agentId: string; status: string | null }
  | { type: "channel"; channel: Channel }
  | { type: "job"; channelId: string; job: Job }
  | { type: "sessions"; sessions: SessionView[] };

type Emit = (e: Event) => void;

const RULES = { chat: readFileSync(chatRulesFile, "utf8"), job: readFileSync(jobRulesFile, "utf8"), feedback: readFileSync(feedbackRulesFile, "utf8") };
/** Fills {{key}} placeholders in one pass, so text put in is never filled again. Unknown keys stay as they are. */
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all);
const roster = (agentId: string) => ROSTER.map((r) => `- ${r.name} (@${r.name}): ${r.role}${r.id === agentId ? " (you)" : ""}`).join("\n");

/** The chat session's whole system prompt. Nothing in it is per channel or per turn, so the cached prefix stays put. */
export function chatPrompt(agentId: string) {
  const t = teammate(agentId)!;
  return RULES.chat
    .replaceAll("{{user}}", USER_NAME)
    .replaceAll("{{name}}", t.name)
    .replaceAll("{{role}}", t.role)
    .replaceAll("{{roster}}", roster(agentId))
    .replaceAll("{{instructions}}", readAgent(agentId).instructions.trim());
}

function jobPrompt(ch: Channel, agentId: string) {
  return RULES.job
    .replaceAll("{{user}}", USER_NAME)
    .replaceAll("{{name}}", nameOf(agentId))
    .replaceAll("{{channel}}", ch.name)
    .replaceAll("{{cwd}}", ch.cwd);
}

/** How sessions are titled in Claude Code: the tag says which teammate it is. */
export const chatTitle = (agentId: string) => `[${nameOf(agentId)}] Harmonia chat`;
export const jobTitle = (ch: Channel, agentId: string, title: string) => `[${nameOf(agentId)}] #${ch.name} · ${title}`;

const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
/** What a teammate answers when a turn needs nothing from it (chat-rules.md, "Is it your turn?"). */
const NO_REPLY = /^`?\(?no reply\)?`?\.?$/i;
/** A hold-on line ("checking") shows only if the turn is still going this long after it was written. */
const HOLD_ON_AFTER = 3000;

/** A reply that's only an emoji or three ("👍", "✅🙏"): shown as a reaction, not as a message. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

/** A reply split into WhatsApp-style bubbles at lines with only `---` (never inside a code block). */
export function bubbles(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const l of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^\s*---\s*$/.test(l)) {
      out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(l);
  }
  out.push(cur.join("\n"));
  return out.map((b) => b.trim()).filter(Boolean);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…(cut)" : s);

function line(m: Message): string {
  if (m.kind === "permission") {
    const p = m.meta!.permission!;
    const verdict = { pending: "is waiting on", once: "allowed once", always: "allowed for this channel", denied: "denied" }[p.status];
    return `[${time(m.ts)}] (event) ${USER_NAME} ${verdict}: ${nameOf(p.agentId)}${p.jobId ? `'s job ${p.jobId}` : ""} wants ${p.rule}`;
  }
  if (m.kind === "tools") {
    const r = m.meta!.toolRequest!;
    const verdict = { pending: "hasn't decided yet on", approved: "approved", denied: "denied" }[r.status];
    return `[${time(m.ts)}] (event) ${USER_NAME} ${verdict} ${nameOf(r.agentId)}'s request for ${r.tools.map((t) => t.name).join(", ")}`;
  }
  if (m.kind === "job") return `[${time(m.ts)}] (event) ${nameOf(m.author)} ${m.text}`;
  if (m.author === "system") return `[${time(m.ts)}] (event) ${m.text}`;
  if (m.author === "guest") return `[${time(m.ts)}] ${m.meta?.guest?.name ?? "Someone"} (in ${m.meta?.via === "teams" ? "Teams" : "Slack"}): ${m.text}`;
  const re = m.meta?.replyTo;
  const quote = re && m.meta?.feedbackFor ? ` (feedback for ${nameOf(m.meta.feedbackFor)} on its message "${re.text.replace(/\s+/g, " ").slice(0, 200)}")` : re ? ` (replying to ${re.author === "user" ? "their own" : `${nameOf(re.author)}'s`} message "${re.text.replace(/\s+/g, " ").slice(0, 200)}")` : "";
  return `[${time(m.ts)}] ${nameOf(m.author)}${quote}: ${m.text}`;
}

// First start with TeamAgents chat sessions: they're new, so each teammate re-reads each channel's recent messages.
if (firstChatSessions) {
  for (const c of channels.values()) c.lastSeen = {};
  saveAgentSessions();
  saveChannels();
}

type Turn = { channelId: string; agentId: string; tools: ChatTools };
type ChatTools = { startJob(input: any): string; checkJobs(): string; stopJob(jobId: string): string; requestTool(input: any): string };

export class Team {
  private busy = new Map<string, { channelId: string; stop: () => void; activity?: string }>(); // teammate id → its chat turn
  private queue = new Map<string, string[]>(); // teammate id → channels waiting for its chat session
  private again = new Set<string>(); // `${channelId}:${agentId}`: new messages came in while it answered there
  private events = new Map<string, string[]>(); // `${channelId}:${agentId}` → job reports etc. for the next turn
  private turnsLeft = new Map<string, number>();
  private activity = new Map<string, string>(); // `${channelId}:${agentId}` → typing-bar status
  private turns = new Map<string, Turn>(); // per-turn token → the turn its job tools act for
  private jobRuns = new Map<string, Run>(); // `${channelId}:${jobId}`
  private stopping = new Set<string>();

  constructor(
    private emit: Emit,
    private serverUrl: string,
  ) {}

  activityFor(channelId: string) {
    return [...this.activity].filter(([k]) => k.startsWith(channelId + ":")).map(([k, status]) => ({ agentId: k.split(":")[1], status }));
  }

  sessions(): SessionView[] {
    return ROSTER.map((t) => {
      const b = this.busy.get(t.id);
      const s = agentSessions[t.id] ?? { sessionId: "", createdAt: 0, turns: 0, cost: 0, cacheRead: 0, inputTotal: 0 };
      return { ...s, agentId: t.id, title: chatTitle(t.id), busyIn: b?.channelId, activity: b?.activity, queue: this.queue.get(t.id) ?? [] };
    });
  }

  private emitSessions() {
    this.emit({ type: "sessions", sessions: this.sessions() });
  }

  post(ch: Channel, m: Omit<Message, "id" | "ts">) {
    const msg = addMessage(ch.id, m);
    this.emit({ type: "message", channelId: ch.id, message: msg });
    return msg;
  }

  private emitJob(ch: Channel, job: Job) {
    this.emit({ type: "job", channelId: ch.id, job });
  }

  private setActivity(ch: Channel, agentId: string, status: string | null) {
    const key = `${ch.id}:${agentId}`;
    if (status) this.activity.set(key, status);
    else if (!this.activity.delete(key)) return;
    this.emit({ type: "activity", channelId: ch.id, agentId, status });
  }

  /** Tags a channel (or clears its tag). Archiving is refused while a teammate or job is still working there. */
  setStatus(ch: Channel, status: ChannelStatus | undefined): string | undefined {
    if (status === "archived" && ch.status !== "archived") {
      const chatting = [...this.busy].filter(([, b]) => b.channelId === ch.id).map(([id]) => nameOf(id));
      const jobs = ch.jobs.filter((j) => j.status === "running").map((j) => `${nameOf(j.agentId)}'s job ${j.id}`);
      const working = [...chatting, ...jobs];
      if (working.length) return `${working.join(", ")} ${working.length > 1 ? "are" : "is"} still working in #${ch.name}. Stop ${working.length > 1 ? "them" : "it"} or wait, then archive.`;
      for (const [agentId, q] of this.queue) {
        if (q.includes(ch.id)) q.splice(q.indexOf(ch.id), 1);
        this.setActivity(ch, agentId, null);
      }
      for (const key of [...this.events.keys()]) if (key.startsWith(ch.id + ":")) this.events.delete(key);
      ch.waitingOn = undefined;
    }
    if (status) Object.assign(ch, { status, statusAt: Date.now() });
    else {
      delete ch.status;
      delete ch.statusAt;
    }
    saveChannels();
    this.emit({ type: "channel", channel: ch });
    this.emitSessions();
  }

  /** Tags a channel with a ClickUp task ("ABC-123", "123" with a task prefix set, or a task URL), or clears it with "". */
  setTask(ch: Channel, input: string): string | undefined {
    const text = input.trim();
    if (!text) delete ch.task;
    else {
      const task = parseTask(text);
      if (!task) return `Type a task id like ${CLICKUP_TASK_PREFIX || "ABC"}-123, or paste the task's ClickUp link.`;
      ch.task = task;
    }
    saveChannels();
    this.emit({ type: "channel", channel: ch });
  }

  // ---------- From the user ----------

  private coordinating = new Map<string, Promise<unknown>>(); // channel id → its Mozart decisions, one at a time

  /**
   * A message from you: typed here, or in a linked Slack conversation (`via: "slack"`, and where it is there). An
   * @mention, "Name, …" or a reply to a teammate's message goes straight to that teammate; anything else, the
   * channel's Mozart decides.
   */
  userMessage(ch: Channel, text: string, replyToId?: string, from: { via?: "slack"; slack?: SlackRef } = {}): Message {
    const target = replyToId ? messages.get(ch.id)?.find((m) => m.id === replyToId) : undefined;
    const replyTo = target && { id: target.id, author: target.author, text: replyText(target).slice(0, 300) };
    const meta = { ...(replyTo && { replyTo }), ...(from.via && { via: from.via }), ...(from.slack && { slack: from.slack }) };
    const msg = this.post(ch, { author: "user", text, ...(Object.keys(meta).length && { meta }) });
    const named = mentions(text).filter((id) => id !== "user");
    // A reply to a teammate's message goes to that teammate (no Mozart), unless the reply names someone.
    const atStart = addressedAtStart(text) ?? (target && teammate(target.author) ? target.author : undefined);
    const waitingOn = ch.waitingOn;
    ch.waitingOn = undefined;
    saveChannels();
    this.turnsLeft.set(ch.id, MAX_TURNS_PER_USER_MESSAGE);
    if (named.length || atStart) {
      for (const id of named.length ? named : [atStart!]) this.wake(ch, id);
      return msg;
    }
    this.coordinate(ch, msg, waitingOn);
    return msg;
  }

  /**
   * Someone else's message in a linked Slack conversation. It's context for the teammates and Mozart (they read it
   * with the rest of the channel), but it never wakes anyone: the teammates work for you.
   */
  guestMessage(ch: Channel, name: string, text: string, slackId?: string, slack?: SlackRef) {
    return this.post(ch, { author: "guest", text, meta: { guest: { name: name.slice(0, 80) || "Someone", ...(slackId && { slackId }) }, via: "slack", ...(slack && { slack }) } });
  }

  /** The channel's Mozart decides who answers `msg`, after any decision still running there. Nothing shows meanwhile. */
  private coordinate(ch: Channel, msg: Message, waitingOn?: string) {
    const prev = this.coordinating.get(ch.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (ch.status === "archived") return;
      const d = await decide({ ch, all: messages.get(ch.id) ?? [], msg, line, waitingOn }).catch((e) => ({
        to: msg.author === "user" ? [waitingOn ?? TRIAGE] : [],
        why: `Mozart failed: ${String(e).slice(0, 80)}`,
        by: "rule" as const,
      }));
      // A teammate's message that nobody needs to answer keeps no note: that's the usual case.
      if (msg.author === "user" || d.to.length) {
        msg.meta = { ...msg.meta, routedTo: d.to, routeWhy: d.by === "mozart" ? `Mozart: ${d.why}` : d.why };
        saveMessages(ch.id);
        this.emit({ type: "update", channelId: ch.id, message: msg });
      }
      for (const id of d.to) this.wake(ch, id);
    });
    this.coordinating.set(ch.id, next);
    next.finally(() => this.coordinating.get(ch.id) === next && this.coordinating.delete(ch.id));
  }

  decide(ch: Channel, messageId: string, decision: "once" | "always" | "denied") {
    const msg = messages.get(ch.id)?.find((m) => m.id === messageId);
    const p = msg?.meta?.permission;
    if (!msg || !p || p.status !== "pending") return;
    p.status = decision;
    saveMessages(ch.id);
    this.emit({ type: "update", channelId: ch.id, message: msg });
    if (decision === "always" && !ch.allowedTools.includes(p.rule)) ch.allowedTools.push(p.rule);
    saveChannels();

    const job = p.jobId ? ch.jobs.find((j) => j.id === p.jobId) : undefined;
    if (job) {
      if (decision === "denied") {
        job.status = "stopped";
        job.endedAt = Date.now();
        this.emitJob(ch, job);
        this.queueEvent(ch, job.agentId, `${USER_NAME} denied ${p.rule}, so job ${job.id} "${job.title}" stopped.`);
        return this.wake(ch, job.agentId);
      }
      if (decision === "once") job.allowed.push(p.rule);
      return this.runJob(ch, job, `${USER_NAME} allowed ${p.rule}. Continue the job from where you stopped.`, true);
    }
    if (decision === "denied") return;
    this.turnsLeft.set(ch.id, MAX_TURNS_PER_USER_MESSAGE);
    this.wake(ch, p.agentId);
  }

  /** Approve or deny a teammate's request for tools. Approved tools go into its agent file: its chat and its jobs. */
  decideTools(ch: Channel, messageId: string, decision: "approved" | "denied"): string | undefined {
    const msg = messages.get(ch.id)?.find((m) => m.id === messageId);
    const r = msg?.meta?.toolRequest;
    if (!msg || !r) return "That request is gone.";
    if (r.status !== "pending") return "Already decided.";
    if (decision === "approved") {
      try {
        addTools(r.agentId, r.tools.flatMap((t) => t.grants));
      } catch (err) {
        return `Couldn't update ${nameOf(r.agentId)}'s tools: ${String(err)}`;
      }
    }
    r.status = decision;
    saveMessages(ch.id);
    this.emit({ type: "update", channelId: ch.id, message: msg });
    const names = r.tools.map((t) => t.name).join(", ");
    this.queueEvent(
      ch,
      r.agentId,
      decision === "approved"
        ? `${USER_NAME} approved ${names}. You have ${r.tools.length > 1 ? "them" : "it"} now, here and in your jobs. Carry on with what you needed ${r.tools.length > 1 ? "them" : "it"} for.`
        : `${USER_NAME} denied ${names}. Do without ${r.tools.length > 1 ? "them" : "it"}, or ask what they'd prefer.`,
    );
    this.turnsLeft.set(ch.id, Math.max(this.turnsLeft.get(ch.id) ?? 0, MAX_TURNS_PER_USER_MESSAGE));
    this.wake(ch, r.agentId);
  }

  /** "Try again" on an error message: rerun that teammate on everything since its last good reply. */
  retry(ch: Channel, messageId: string) {
    const all = messages.get(ch.id) ?? [];
    const i = all.findIndex((m) => m.id === messageId);
    const err = all[i];
    if (!err || err.kind !== "error" || !teammate(err.author) || err.meta?.retried) return;
    err.meta = { ...err.meta, retried: true };
    saveMessages(ch.id);
    this.emit({ type: "update", channelId: ch.id, message: err });
    const agentId = err.author;
    let j = i - 1;
    while (j >= 0 && !(all[j].author === agentId && all[j].kind !== "error")) j--;
    if (j >= 0 && ch.lastSeen[agentId] !== undefined) ch.lastSeen[agentId] = Math.min(ch.lastSeen[agentId], j + 1);
    saveChannels();
    this.turnsLeft.set(ch.id, MAX_TURNS_PER_USER_MESSAGE);
    this.wake(ch, agentId);
  }

  stop(ch: Channel, agentId: string) {
    const b = this.busy.get(agentId);
    if (b?.channelId === ch.id) return b.stop();
    const q = this.queue.get(agentId);
    if (q?.includes(ch.id)) {
      q.splice(q.indexOf(ch.id), 1);
      this.setActivity(ch, agentId, null);
      this.emitSessions();
    }
  }

  /** Forget the teammate's chat session: its next turn starts a new one and re-reads each channel. Jobs are untouched. */
  resetSession(agentId: string): string | undefined {
    if (this.busy.has(agentId)) return `${nameOf(agentId)} is in the middle of a reply. Try again when it's done.`;
    delete agentSessions[agentId];
    for (const c of channels.values()) delete c.lastSeen[agentId];
    saveAgentSessions();
    saveChannels();
    this.emitSessions();
  }

  // ---------- Chat turns (the six TeamAgents sessions) ----------

  private queueEvent(ch: Channel, agentId: string, text: string) {
    const key = `${ch.id}:${agentId}`;
    this.events.set(key, [...(this.events.get(key) ?? []), `[${time(Date.now())}] (event) ${text}`]);
    this.turnsLeft.set(ch.id, Math.max(this.turnsLeft.get(ch.id) ?? 0, 2));
  }

  /** Asks a teammate to read a channel and reply. A teammate busy in another channel gets to it after that turn. */
  private wake(ch: Channel, agentId: string) {
    if (ch.status === "archived") return;
    const b = this.busy.get(agentId);
    if (b) {
      if (b.channelId === ch.id) this.again.add(`${ch.id}:${agentId}`);
      else {
        const q = this.queue.get(agentId) ?? [];
        if (!q.includes(ch.id)) q.push(ch.id);
        this.queue.set(agentId, q);
        this.setActivity(ch, agentId, `busy in #${channels.get(b.channelId)?.name ?? "another channel"}, then here`);
        this.emitSessions();
      }
      return;
    }
    if (!this.start(ch, agentId)) this.next(agentId);
  }

  /** The next channel waiting for this teammate, if any. */
  private next(agentId: string) {
    const q = this.queue.get(agentId) ?? [];
    while (q.length && !this.busy.has(agentId)) {
      const ch = channels.get(q.shift()!);
      if (ch && this.start(ch, agentId)) break;
    }
    this.emitSessions();
  }

  /** One turn of the teammate's chat session for this channel. False when there was nothing to do. */
  private start(ch: Channel, agentId: string): boolean {
    const key = `${ch.id}:${agentId}`;
    const left = this.turnsLeft.get(ch.id) ?? 0;
    if (left <= 0) {
      this.setActivity(ch, agentId, null);
      this.post(ch, { author: "system", text: `Paused after ${MAX_TURNS_PER_USER_MESSAGE} turns. Reply to keep the team going.` });
      return false;
    }
    const all = messages.get(ch.id) ?? [];
    const seen = ch.lastSeen[agentId];
    // Its own messages are skipped, except permission cards: the user's decision on them is news.
    const fresh = all.slice(seen ?? Math.max(0, all.length - 30)).filter((m) => (m.author !== agentId || m.kind === "permission") && m.kind !== "status");
    const events = this.events.get(key) ?? [];
    if (!fresh.length && !events.length) {
      this.setActivity(ch, agentId, null);
      return false;
    }
    this.events.delete(key);
    this.turnsLeft.set(ch.id, left - 1);
    ch.lastSeen[agentId] = all.length;
    saveChannels();
    this.emit({ type: "channel", channel: ch }); // read ticks on the user's messages
    // What an emoji-only reply reacts to: the latest message it read from someone else.
    const target = fresh.findLast((m) => m.author !== agentId && m.author !== "system" && m.kind !== "job" && m.kind !== "status")?.id;

    const where = `#${ch.name} (folder ${ch.cwd}${ch.task ? `, ClickUp task ${ch.task.id}: ${ch.task.url}` : ""})`;
    const intro = seen === undefined ? `You're new in ${where}. Recent messages there:` : `New in ${where} since you last read it:`;
    const lines = [...fresh.map(line), ...events];
    const prompt = `${intro}\n${lines.join("\n")}\n\nWrite your next message in #${ch.name}, or (no reply) if nothing here is waiting on you.`;

    const had = agentSessions[agentId];
    const resume = !!had;
    const session: AgentSession = had ?? { sessionId: crypto.randomUUID(), createdAt: Date.now(), turns: 0, cost: 0, cacheRead: 0, inputTotal: 0 };
    agentSessions[agentId] = session;

    // The job tools reach back through a token that's only good for this turn.
    const token = crypto.randomUUID();
    const tools = this.chatTools(ch, agentId);
    this.turns.set(token, { channelId: ch.id, agentId, tools });
    const t = teammate(agentId)!;

    let stopped = false;
    let said: string | undefined; // the turn's latest words, not yet followed by a tool call
    let holding: ReturnType<typeof setTimeout> | undefined; // the turn's one hold-on line, waiting to go out
    const busy: { channelId: string; stop: () => void; activity?: string } = { channelId: ch.id, stop: () => {}, activity: "thinking" };
    this.busy.set(agentId, busy);
    this.setActivity(ch, agentId, "typing");
    this.emitSessions();

    // Stub mode: a message that asks for a job gets one, as a real chat session would.
    const last = lines[lines.length - 1] ?? "";
    if (STUB && /\bjob\b/i.test(last) && !last.includes("(event)")) tools.startJob({ title: "Stub job", brief: last });
    if (STUB && /\bneed a tool\b/i.test(last) && !last.includes("(event)")) tools.requestTool({ tools: ["clickup_delete_task"], reason: "Stub: to delete the duplicate task." });

    const run = runAgent({
      agentId,
      cwd: TEAM_AGENTS,
      prompt,
      sessionId: session.sessionId,
      resume,
      title: chatTitle(agentId),
      allowedTools: [],
      systemPrompt: chatPrompt(agentId),
      chat: {
        model: t.chatModel,
        effort: t.chatEffort,
        tools: chatToolsFor(readAgent(agentId).tools),
        mcpConfig: JSON.stringify({
          mcpServers: {
            team: { command: jobToolsCommand()[0], args: jobToolsCommand().slice(1), env: { HARMONIA_URL: this.serverUrl, HARMONIA_TURN: token } },
          },
        }),
      },
      onActivity: (s) => {
        const status = /start_job/.test(s) ? "starting a job" : /check_jobs/.test(s) ? "checking jobs" : /stop_job/.test(s) ? "stopping a job" : /request_tool/.test(s) ? "asking for a tool" : s;
        busy.activity = status;
        this.setActivity(ch, agentId, status);
        this.emitSessions();
      },
      // Words right before a tool call ("checking", "hold on") are a hold-on line. Only the first one in a turn, and only
      // if the answer is still not there 3 seconds later: a quick answer comes alone.
      onText: (text) => void (said = text),
      onTool: () => {
        const text = said?.trim().split("\n")[0];
        said = undefined;
        if (holding || !text || NO_REPLY.test(text) || EMOJI_ONLY.test(text)) return;
        holding = setTimeout(() => {
          if (!stopped && this.busy.get(agentId) === busy) this.post(ch, { author: agentId, text, meta: { interim: true } });
        }, HOLD_ON_AFTER);
      },
    });
    busy.stop = () => ((stopped = true), run.stop());

    run.done
      .catch((e): RunResult => ({ text: String(e), sessionId: session.sessionId, isError: true, denials: [] }))
      .then((r) => {
        clearTimeout(holding);
        this.turns.delete(token);
        this.busy.delete(agentId);
        this.setActivity(ch, agentId, null);
        const lost = r.isError && resume && /no conversation found/i.test(r.text);
        if (r.isError && (!resume || lost)) delete agentSessions[agentId]; // the next turn starts a new session
        else
          Object.assign(session, {
            lastAt: Date.now(),
            turns: session.turns + 1,
            cost: session.cost + (r.cost ?? 0),
            context: r.context ?? session.context,
            cacheRead: session.cacheRead + (r.cacheRead ?? 0),
            inputTotal: session.inputTotal + (r.inputTotal ?? 0),
          });
        saveAgentSessions();
        if (r.isError) {
          // The turn never happened: what it should have read is still unread (Try again re-reads it).
          if (seen === undefined || lost) delete ch.lastSeen[agentId];
          else ch.lastSeen[agentId] = seen;
          if (events.length) this.events.set(key, [...events, ...(this.events.get(key) ?? [])]);
          saveChannels();
        }
        if (lost) {
          // Its session file is gone (deleted, or another machine): start over in a new one.
          this.turnsLeft.set(ch.id, (this.turnsLeft.get(ch.id) ?? 0) + 1);
          this.again.add(key);
        } else if (!stopped) this.afterReply(ch, agentId, r, target);
        // Other channels that waited go first, then this one again if more came in meanwhile.
        if (this.again.delete(key) || this.events.has(key)) {
          const q = this.queue.get(agentId) ?? [];
          if (!q.includes(ch.id)) q.push(ch.id);
          this.queue.set(agentId, q);
        }
        this.next(agentId);
      });
    return true;
  }

  private afterReply(ch: Channel, agentId: string, r: RunResult, target?: string) {
    // "(no reply)": the teammate read the channel and decided it isn't its turn. Nothing is posted or woken.
    if (!r.isError && NO_REPLY.test(r.text.trim())) return;
    // Only an emoji: a reaction on the message it answers, like WhatsApp. Nobody is woken.
    if (!r.isError && EMOJI_ONLY.test(r.text.trim())) return target ? this.react(ch, target, agentId, r.text.trim()) : undefined;
    const cached = r.inputTotal ? r.cacheRead! / r.inputTotal : undefined;
    if (r.isError) this.post(ch, { author: agentId, kind: "error", text: r.text || "The run failed." });
    else if (r.text) {
      const parts = bubbles(r.text);
      const { first, after } = this.postBubbles(ch, agentId, parts, { cost: r.cost, tokens: r.tokens, cached });
      const asksUser = mentions(r.text).includes("user");
      // A question to the user makes the user's next plain message go to this teammate.
      if (asksUser) ch.waitingOn = agentId;
      // Handoffs (@Name) go straight out, unless the mention is part of the question to the user. Otherwise the
      // channel's Mozart decides whether anyone follows up, once all the bubbles are out. A question to the user
      // waits for the user.
      const to = handoffs(r.text).filter((id) => id !== agentId);
      for (const id of to) this.wake(ch, id);
      if (first && !to.length && !asksUser && (this.turnsLeft.get(ch.id) ?? 0) > 0) setTimeout(() => this.coordinate(ch, first), after);
    }
    saveChannels();
    this.emit({ type: "channel", channel: ch });
  }

  /**
   * The first bubble goes out now; each next one after a short "typing" pause, timed to its length. Returns the first
   * bubble and when the last one is out (ms from now).
   */
  private postBubbles(ch: Channel, agentId: string, parts: string[], meta: Message["meta"]): { first?: Message; after: number } {
    if (!parts.length) return { after: 0 };
    const first = this.post(ch, { author: agentId, text: parts[0], meta });
    let at = 0;
    for (const part of parts.slice(1)) {
      setTimeout(() => this.busy.has(agentId) || this.setActivity(ch, agentId, "typing"), at + 100);
      at += Math.min(1500, Math.max(600, part.length * 15));
      setTimeout(() => {
        if (!this.busy.has(agentId)) this.setActivity(ch, agentId, null);
        this.post(ch, { author: agentId, text: part });
      }, at);
    }
    return { first, after: at + 50 };
  }

  /** A teammate's emoji on a message. One reaction per teammate per message; a new one replaces it. */
  private react(ch: Channel, messageId: string, agentId: string, emoji: string) {
    const msg = (messages.get(ch.id) ?? []).find((m) => m.id === messageId);
    if (!msg) return;
    msg.meta ??= {};
    msg.meta.reactions = [...(msg.meta.reactions ?? []).filter((x) => x.by !== agentId), { by: agentId, emoji }];
    saveMessages(ch.id);
    this.emit({ type: "update", channelId: ch.id, message: msg });
  }

  /** A job tool call from a chat session, by its turn token. */
  turnTool(token: string, tool: string, input: any): { text?: string; error?: string } {
    const turn = this.turns.get(token);
    if (!turn) return { error: "This turn is over." };
    try {
      if (tool === "start_job") {
        if (typeof input?.title !== "string" || typeof input?.brief !== "string" || !input.brief.trim()) return { text: "start_job needs a title and a brief." };
        return { text: turn.tools.startJob(input) };
      }
      if (tool === "check_jobs") return { text: turn.tools.checkJobs() };
      if (tool === "stop_job") return { text: turn.tools.stopJob(String(input?.job_id ?? "")) };
      if (tool === "request_tool") return { text: turn.tools.requestTool(input) };
      return { error: `Unknown tool ${tool}.` };
    } catch (err) {
      return { text: `The tool failed: ${String(err)}` };
    }
  }

  // ---------- Jobs (their own Claude Code sessions, in the channel's folder) ----------

  private chatTools(ch: Channel, agentId: string): ChatTools {
    return {
      startJob: (input) => this.startJob(ch, agentId, input),
      checkJobs: () => {
        const list = ch.jobs.filter((j) => j.kind === "job").slice(-15);
        if (!list.length) return "No jobs in this channel yet.";
        return list.map((j) => `${j.id} · ${nameOf(j.agentId)} · ${j.status}${j.activity ? ` (${j.activity})` : ""} · ${j.title}`).join("\n");
      },
      stopJob: (jobId) => this.stopJob(ch, jobId),
      requestTool: (input) => this.requestTool(ch, agentId, input),
    };
  }

  private requestTool(ch: Channel, agentId: string, input: { tools?: unknown; reason?: unknown }): string {
    const names = (Array.isArray(input?.tools) ? input.tools : [input?.tools]).filter((x) => typeof x === "string") as string[];
    const reason = String(input?.reason ?? "").trim();
    if (!names.length || !reason) return "request_tool needs tools (a list of names) and a reason.";
    const { found, unknown } = resolveTools(names);
    if (unknown.length)
      return unknown
        .map((u) => {
          const like = suggestTools(u);
          return `There's no tool called ${u}.${like.length ? ` Did you mean: ${like.join(", ")}?` : ""}`;
        })
        .join("\n") + "\nNothing was asked. Fix the names and call request_tool again.";
    const have = new Set(readAgent(agentId).tools);
    const missing = have.size ? found.filter((t) => !t.grants.every((g) => have.has(g))) : [];
    if (!missing.length) return `You already have ${found.map((t) => t.name).join(", ")}. If it isn't in your tool list, load it with ToolSearch.`;
    const pending = (messages.get(ch.id) ?? []).find(
      (m) => m.meta?.toolRequest?.status === "pending" && m.meta.toolRequest.agentId === agentId && missing.every((t) => m.meta!.toolRequest!.tools.some((x) => x.name === t.name)),
    );
    if (pending) return "That request is already waiting on the user's card in this channel.";
    this.post(ch, { author: agentId, kind: "tools", text: "", meta: { toolRequest: { agentId, tools: missing, reason: reason.slice(0, 400), status: "pending" } } });
    return `Asked ${USER_NAME}: a card with Approve / Deny for ${missing.map((t) => t.name).join(", ")} is in #${ch.name}. Their answer reaches you as an event. Don't ask again in your message; say in a line what you'll do once it's approved, or (no reply).`;
  }

  stopJob(ch: Channel, jobId: string): string {
    const run = this.jobRuns.get(`${ch.id}:${jobId}`);
    if (!run) return `Job ${jobId} isn't running.`;
    this.stopping.add(`${ch.id}:${jobId}`);
    run.stop();
    return `Stopping job ${jobId}.`;
  }

  /**
   * The user's feedback on a teammate's message: posted in the channel as a reply to it, then a job where that
   * teammate reviews how its rules led to the message and amends its own instructions (feedback-rules.md).
   */
  /** `from.via`: given in Slack (a DM after a ⚠️), so the bridge keeps it out of the Slack conversation. */
  feedback(ch: Channel, messageId: string, text: string, from: { via?: "slack" } = {}): string | undefined {
    const all = messages.get(ch.id) ?? [];
    const i = all.findIndex((m) => m.id === messageId);
    const target = all[i];
    if (!target || !teammate(target.author)) return "Feedback goes on a teammate's message.";
    const agentId = target.author;
    const job = target.meta?.jobId ? ch.jobs.find((j) => j.id === target.meta!.jobId) : undefined;
    this.post(ch, {
      author: "user",
      text,
      meta: { replyTo: { id: target.id, author: agentId, text: replyText(target).slice(0, 300) }, feedbackFor: agentId, ...(from.via && { via: from.via }) },
    });
    const t = teammate(agentId)!;
    const prompt = fill(RULES.feedback, {
      user: USER_NAME,
      what: job ? `your job ${job.id} "${job.title}"` : "one of your messages",
      channel: ch.name,
      feedback: text,
      time: new Date(target.ts).toISOString(),
      message: line(target),
      job: job
        ? `\nThe job: brief\n<brief>\n${clip(job.brief, 4000)}\n</brief>\nreport\n<report>\n${clip(job.report ?? "(none yet)", 6000)}\n</report>\nIts whole run is Claude Code session ${job.sessionId} (~/.claude/projects/*/${job.sessionId}.jsonl).\n`
        : "",
      messagesFile: join(DATA, "messages", `${ch.id}.json`),
      history: all.slice(Math.max(0, i - 40), i + 1).map(line).join("\n"),
      agentFile: agentFile(agentId),
      memoryDir: memoryDir(agentId),
      chatRules: fill(RULES.chat, { user: USER_NAME, name: t.name, role: t.role, roster: roster(agentId) }),
      jobRules: jobPrompt(ch, agentId),
    });
    const title = `Feedback: ${text.replace(/\s+/g, " ").slice(0, 60)}`;
    this.startJob(ch, agentId, { title, brief: text, feedback: true }, prompt);
  }

  /** `prompt` is what the job is told when it differs from the brief shown on its card (feedback jobs). */
  private startJob(ch: Channel, agentId: string, input: { title: string; brief: string; continue_job?: string; feedback?: boolean }, prompt?: string): string {
    const prev = input.continue_job ? ch.jobs.find((j) => j.id === input.continue_job && j.agentId === agentId && j.kind === "job") : undefined;
    if (input.continue_job && !prev) return `There's no job ${input.continue_job} of yours to continue.`;
    if (prev?.status === "running") return `Job ${prev.id} is still running.`;
    const job: Job = {
      id: `j${ch.nextJob++}`,
      kind: "job",
      agentId,
      sessionId: prev?.sessionId ?? crypto.randomUUID(),
      title: input.title.trim().slice(0, 80) || "Job",
      brief: input.brief.trim(),
      status: "running",
      startedAt: Date.now(),
      cost: 0,
      allowed: [...(prev?.allowed ?? [])],
      ...(input.feedback && { feedback: true }),
    };
    ch.jobs.push(job);
    if (ch.jobs.length > 200) ch.jobs.splice(0, ch.jobs.length - 200);
    this.emitJob(ch, job); // before the card, so the page can draw it
    this.post(ch, { author: agentId, kind: "job", text: `started job ${job.id}: ${job.title}`, meta: { jobId: job.id } });
    this.runJob(ch, job, prompt ?? job.brief, !!prev);
    return `Started job ${job.id}. Its report comes back to you here when it finishes.`;
  }

  private runJob(ch: Channel, job: Job, prompt: string, resume: boolean) {
    const key = `${ch.id}:${job.id}`;
    Object.assign(job, { status: "running", activity: "starting", endedAt: undefined });
    saveChannels();
    this.emitJob(ch, job);

    const run = runAgent({
      agentId: job.agentId,
      cwd: ch.cwd,
      prompt,
      sessionId: job.sessionId,
      resume,
      title: jobTitle(ch, job.agentId, job.title),
      allowedTools: [...ch.allowedTools, ...job.allowed],
      systemPrompt: jobPrompt(ch, job.agentId),
      onActivity: (s) => {
        job.activity = s;
        this.emitJob(ch, job);
      },
      onText: (t) => {
        job.lastText = t;
        this.logStep(job, `said: ${t}`);
      },
      onTool: (name, input) => this.logStep(job, `ran ${name.replace(/^mcp__.*?__/, "")}: ${JSON.stringify(input)}`),
      onToolResult: (text, isError) => this.logStep(job, `${isError ? "error" : "result"}: ${text}`),
    });
    this.jobRuns.set(key, run);

    // While it runs, the job reports in every few minutes, under its teammate's name.
    const ticker = setInterval(() => this.postJobStatus(ch, job), STATUS_EVERY_MS);

    run.done
      .catch((e): RunResult => ({ text: String(e), sessionId: job.sessionId, isError: true, denials: [] }))
      .then((r) => {
        clearInterval(ticker);
        this.jobLogs.delete(job);
        this.jobRuns.delete(key);
        const stopped = this.stopping.delete(key);
        job.cost += r.cost ?? 0;
        job.activity = undefined;
        job.endedAt = Date.now();
        job.report = r.text;
        job.status = stopped ? "stopped" : r.isError ? "failed" : r.denials.length ? "blocked" : "done";
        saveChannels();
        this.emitJob(ch, job);

        for (const d of r.denials) {
          this.post(ch, {
            author: job.agentId,
            kind: "permission",
            text: "",
            meta: { permission: { agentId: job.agentId, jobId: job.id, tool: d.tool, rule: d.rule, summary: d.summary, status: "pending" } },
          });
        }
        if (job.status === "done" || job.status === "failed") {
          this.queueEvent(ch, job.agentId, `Your job ${job.id} "${job.title}" ${job.status === "done" ? "finished" : "failed"}. Its report:\n${clip(r.text, 8000)}`);
          this.wake(ch, job.agentId);
        }
      });
  }

  /** Recent steps of each running job (narration, tool calls, results), for its status updates. */
  private jobLogs = new Map<Job, string[]>();
  private summarizing = new Set<Job>();

  private logStep(job: Job, step: string) {
    const log = this.jobLogs.get(job) ?? [];
    const flat = step.replace(/\s+/g, " ").trim();
    log.push(flat.length > 600 ? flat.slice(0, 599) + "…" : flat);
    if (log.length > 60) log.splice(0, log.length - 60);
    this.jobLogs.set(job, log);
  }

  /**
   * Every few minutes a running job reports in under its teammate's name: what's happening and what it's waiting for.
   * A one-shot Haiku call reads the job's recent steps and writes it; the chat session isn't involved.
   */
  private async postJobStatus(ch: Channel, job: Job) {
    if (job.status !== "running" || ch.status === "archived" || this.summarizing.has(job)) return;
    this.summarizing.add(job);
    try {
      const minutes = Math.round((Date.now() - job.startedAt) / 60_000);
      const t = teammate(job.agentId)!;
      const system = [
        `You write a short status update for ${USER_NAME} about a job that ${t.name} (${t.role}) is running for them.`,
        `Write as ${t.name}, in the first person, in the language of the brief.`,
        "2 to 4 short markdown lines, no heading, no preamble, no sign-off:",
        "- what's happening right now, in plain words (not tool names);",
        "- what's done so far, if anything worth saying;",
        "- what we're waiting for (a build, a deploy, a test run, a query, someone's answer) and, if the log shows it, roughly how long.",
        "If the job is stuck, failing or retrying the same thing, say so plainly.",
        "Only state what the log shows. Don't invent results.",
      ].join("\n");
      const prompt = [
        `Job ${job.id}: ${job.title}`,
        `Running for ${minutes} min, in ${ch.cwd}.`,
        "",
        "Brief:",
        job.brief.length > 2000 ? job.brief.slice(0, 2000) + "…" : job.brief,
        "",
        "Recent steps, oldest first:",
        ...(this.jobLogs.get(job) ?? ["(nothing yet)"]).slice(-30).map((x) => `- ${x}`),
        "",
        `Right now: ${job.activity ?? "thinking"}`,
      ].join("\n");
      let summary = await quickAnswer(system, prompt, ch.cwd);
      if (job.status !== "running") return; // it finished meanwhile; its report says the rest
      if (!summary) {
        // No summary (the call failed): fall back to the job's own latest words and current step.
        const said = (job.lastText ?? "").replace(/\s+/g, " ").trim();
        summary = [said && `> ${said.length > 300 ? said.slice(0, 299) + "…" : said}`, job.activity && `Now: \`${job.activity.replace(/`/g, "'")}\``]
          .filter(Boolean)
          .join("\n");
      }
      this.post(ch, { author: job.agentId, kind: "status", text: `⏳ **${job.id}** · ${job.title} · ${minutes} min\n${summary}`, meta: { jobId: job.id } });
    } finally {
      this.summarizing.delete(job);
    }
  }

  jobSession(ch: Channel, jobId: string) {
    return ch.jobs.find((j) => j.id === jobId)?.sessionId;
  }
}

/** What a reply quotes from a message: its text, or what the card is. */
function replyText(m: Message): string {
  if (m.kind === "job") return m.text;
  if (m.kind === "permission") return `asks to use ${m.meta?.permission?.tool}`;
  if (m.kind === "tools") return `asks for ${m.meta?.toolRequest?.tools.map((t) => t.name).join(", ")}`;
  return m.text;
}

/** "ABC-123", "123" (→ ABC-123 when the task prefix is ABC), "1amkz0hxp0q" (an internal id) or a ClickUp task link. */
export function parseTask(text: string): { id: string; url: string } | undefined {
  const byCustomId = (id: string) => ({ id, url: `https://app.clickup.com/t/${CLICKUP_WORKSPACE ? CLICKUP_WORKSPACE + "/" : ""}${id}` });
  const link = text.match(/^https:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9-]+)\/?(?:[?#].*)?$/);
  if (link) return { id: /^[A-Za-z]+-\d+$/.test(link[1]) ? link[1].toUpperCase() : link[1], url: text };
  if (/^[A-Za-z]+-\d+$/.test(text)) return byCustomId(text.toUpperCase());
  if (/^\d+$/.test(text) && CLICKUP_TASK_PREFIX) return byCustomId(`${CLICKUP_TASK_PREFIX}-${text}`);
  if (/^[a-z0-9]{7,12}$/.test(text)) return { id: text, url: `https://app.clickup.com/t/${text}` };
}

export const allChannels = () => [...channels.values()].sort((a, b) => a.createdAt - b.createdAt);

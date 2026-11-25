import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths";
import type { Attachment } from "./attachments";

export type Message = {
  id: string;
  ts: number;
  author: string; // "user" | teammate id | "system" | "guest" (someone else in a linked Slack conversation: context, never wakes anyone)
  text: string;
  kind?: "text" | "permission" | "error" | "job" | "status" | "tools";
  meta?: {
    guest?: { name: string; slackId?: string; aadId?: string }; // author "guest": who wrote it (aadId: in Microsoft Teams, before the Slack bridge)
    via?: "slack" | "teams"; // written in Slack (so the bridge doesn't send it back there), or in Microsoft Teams before it
    slack?: SlackRef; // the same message in the linked Slack conversation (for replies, reactions and cards there)
    replyTo?: { id: string; author: string; text: string }; // user messages: the message this one answers (text clipped)
    answers?: string; // teammate messages: the message its turn was woken for (Slack puts it in that message's thread)
    files?: Attachment[]; // files attached to it (attachments.ts): yours, from the app or Slack, or a guest's in Slack
    voice?: { language: string }; // a voice note from Slack: its text is what was said, in this language (voice.ts)
    interim?: boolean; // a teammate's "checking…" line before it used a tool; no notification
    reactions?: { by: string; emoji: string }[]; // a teammate's emoji-only reply lands here, on the message it answered
    toolRequest?: {
      agentId: string;
      tools: { name: string; grants: string[] }[]; // grants: the names that go in the agent's allowlist
      reason: string;
      status: "pending" | "approved" | "denied";
    };
    cost?: number;
    tokens?: number;
    cached?: number; // share of the turn's input read from the prompt cache (0–1)
    routedTo?: string[]; // the teammates Mozart (or a rule) woke after this message; [] = nobody
    routeReact?: string[]; // user messages: the teammates Mozart had react to it instead of answering (meta.reactions)
    feedbackFor?: string; // user messages: feedback for this teammate on the replyTo message (it amends its rules)
    routeWhy?: string;
    jobId?: string; // kind "job": the card for that job
    retried?: boolean; // kind "error": Try again was used
    permission?: {
      agentId: string;
      jobId?: string; // set when a job (not the chat itself) was blocked
      tool: string;
      rule: string;
      summary: string;
      status: "pending" | "once" | "always" | "denied";
    };
  };
};

/** A message in Slack: its conversation, its ts, and the thread it's in (the thread's first message), if any. */
export type SlackRef = { channel: string; ts: string; thread?: string };

/** A job: a Claude Code session a teammate started for real work. Chat-mode runs from before 2026-11-17 are kind "chat". */
export type Job = {
  id: string;
  kind: "job" | "chat";
  agentId: string;
  sessionId: string;
  title: string;
  brief: string;
  status: "running" | "done" | "failed" | "stopped" | "blocked";
  startedAt: number;
  endedAt?: number;
  activity?: string;
  lastText?: string; // the job's latest narration, for its status updates
  cost: number;
  report?: string;
  allowed: string[]; // permission rules granted to this job
  feedback?: boolean; // a feedback job: the teammate amending its own rules (its title quotes the feedback)
  size?: "small"; // runs at a smaller model and effort; kept when the job is resumed or continued
  baseline?: number; // input tokens of its first API call: what a job carries before it has done anything
};

export const CHANNEL_STATUSES = ["inProgress", "waiting", "later", "archived"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export type Channel = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  sessions?: Record<string, string>; // unused since the chat sessions moved to TeamAgents
  lastSeen: Record<string, number>; // teammate id → message count when it last read this channel
  allowedTools: string[]; // "Always in this channel" permission rules
  waitingOn?: string; // teammate that asked the user a question
  task?: { id: string; url: string }; // the ClickUp task this channel is about
  status?: ChannelStatus; // your tag for the channel; "archived" makes it read-only and nobody is woken in it
  statusAt?: number;
  archivedAt?: number; // older builds: same as status "archived"
  jobs: Job[];
  nextJob: number;
  mozart?: MozartSession; // the channel's coordinator (mozart.ts)
  dm?: string; // a DM with this teammate: only it is here, only it is woken, and Mozart stays out
};

/** A channel's Mozart: its own Haiku session, which reads the channel and decides who answers each message. */
export type MozartSession = {
  sessionId: string;
  createdAt: number;
  seen: number; // message count when it last read the channel
  turns: number;
  context?: number; // tokens in its conversation after the last turn
  cost: number;
};

/** A teammate's chat session in the TeamAgents project, shared by every channel. */
export type AgentSession = {
  sessionId: string;
  createdAt: number;
  lastAt?: number;
  turns: number;
  cost: number; // Claude Code's cost estimate, summed
  context?: number; // tokens in the conversation after the last turn
  cacheRead: number; // input tokens read from the prompt cache, summed
  inputTotal: number; // all input tokens (fresh + cache write + cache read), summed
};


const MSG_DIR = join(DATA, "messages");
const SESSIONS = join(DATA, "chat-sessions.json");
mkdirSync(MSG_DIR, { recursive: true });

/**
 * Reads a JSON file. A missing file gives the fallback. A file that exists but can't be parsed (a crash cut a save short)
 * is copied aside as `<name>.corrupt-<time>` and never overwritten with the fallback silently: `fatal` files stop the
 * server with a message, the others load as the fallback and log a line.
 */
const readJson = <T>(path: string, fallback: T, fatal = false): T => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const copy = `${path}.corrupt-${Date.now()}`;
    try {
      copyFileSync(path, copy);
    } catch {}
    if (fatal) {
      console.error(
        `
Harmonia can't start: ${path} is damaged (${(e as Error).message}).
` +
          `A copy of it is at ${copy}.
` +
          `Repair the file, or delete it to start without it, then start Harmonia again.
`,
      );
      process.exit(1);
    }
    console.error(`[store] ${path} is damaged (${(e as Error).message}); a copy is at ${copy}. Loading it as empty.`);
    return fallback;
  }
};

/** A save that a crash cut short leaves `<name>.tmp` next to the real file: it is never read, so just remove it. */
for (const dir of [DATA, MSG_DIR]) {
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json.tmp")) try { unlinkSync(join(dir, f)); } catch {}
  }
}

export const channels = new Map<string, Channel>(
  readJson<Channel[]>(join(DATA, "channels.json"), [], true).map((c) => {
    c.jobs ??= [];
    if (c.archivedAt && !c.status) Object.assign(c, { status: "archived", statusAt: c.archivedAt });
    delete c.archivedAt;
    c.nextJob ??= 1;
    // A job can't still be running after a restart: its process went with the old server. (After an update's restart,
    // Team.resumeAfterRestart starts the ones that were running again.)
    for (const j of c.jobs) if (j.status === "running") Object.assign(j, { status: "stopped", activity: undefined, endedAt: Date.now() });
    return [c.id, c];
  }),
);
export const messages = new Map<string, Message[]>();
/** True on the first start with TeamAgents chat sessions: every channel is then unread for every teammate. */
export const firstChatSessions = !existsSync(SESSIONS);
export const agentSessions: Record<string, AgentSession> = readJson(SESSIONS, {}, true);
for (const f of readdirSync(MSG_DIR)) {
  if (f.endsWith(".json")) messages.set(f.slice(0, -5), readJson<Message[]>(join(MSG_DIR, f), []));
}

// One write at a time per file, latest content wins. A save goes to `<name>.tmp` and is renamed over the file, so a crash
// leaves either the old file or the new one, never half of one.
const queues = new Map<string, Promise<unknown>>();
async function atomicWrite(path: string, text: string) {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, text);
  // On Windows the rename can fail for a moment when something else (antivirus, a sync client) has the file open.
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 20 * attempt));
    }
  }
}
function write(path: string, data: () => unknown) {
  const next = (queues.get(path) ?? Promise.resolve())
    .then(() => atomicWrite(path, JSON.stringify(data(), null, 1)))
    .catch((e) => console.error(`[store] saving ${path} failed:`, e));
  queues.set(path, next);
}

export const saveAgentSessions = () => write(SESSIONS, () => agentSessions);
export const saveChannels = () => write(join(DATA, "channels.json"), () => [...channels.values()]);
export const saveMessages = (channelId: string) =>
  write(join(MSG_DIR, `${channelId}.json`), () => messages.get(channelId) ?? []);

export function createChannel(name: string, cwd: string, dm?: string): Channel {
  const slug = name.toLowerCase().replace(/[^\p{L}\d]+/gu, "-").replace(/^-|-$/g, "") || "channel";
  const ch: Channel = {
    id: `${slug}-${crypto.randomUUID().slice(0, 6)}`,
    name: slug,
    cwd,
    createdAt: Date.now(),
    lastSeen: {},
    allowedTools: [],
    jobs: [],
    nextJob: 1,
    ...(dm && { dm }),
  };
  channels.set(ch.id, ch);
  messages.set(ch.id, []);
  saveChannels();
  saveMessages(ch.id);
  return ch;
}

/** Your DM with a teammate, if you have one. */
export const dmOf = (agentId: string): Channel | undefined => [...channels.values()].find((c) => c.dm === agentId);

export function addMessage(channelId: string, m: Omit<Message, "id" | "ts">): Message {
  const msg: Message = { id: crypto.randomUUID(), ts: Date.now(), ...m };
  const list = messages.get(channelId) ?? [];
  list.push(msg);
  messages.set(channelId, list);
  saveMessages(channelId);
  return msg;
}

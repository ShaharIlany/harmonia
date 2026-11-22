import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
    files?: Attachment[]; // files attached to it (attachments.ts): yours, from the app or Slack, or a guest's in Slack
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

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

export const channels = new Map<string, Channel>(
  readJson<Channel[]>(join(DATA, "channels.json"), []).map((c) => {
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
export const agentSessions: Record<string, AgentSession> = readJson(SESSIONS, {});
for (const f of readdirSync(MSG_DIR)) {
  if (f.endsWith(".json")) messages.set(f.slice(0, -5), readJson<Message[]>(join(MSG_DIR, f), []));
}

// One write at a time per file, latest content wins.
const queues = new Map<string, Promise<unknown>>();
function write(path: string, data: () => unknown) {
  const next = (queues.get(path) ?? Promise.resolve()).then(() => Bun.write(path, JSON.stringify(data(), null, 1)));
  queues.set(path, next);
}

export const saveAgentSessions = () => write(SESSIONS, () => agentSessions);
export const saveChannels = () => write(join(DATA, "channels.json"), () => [...channels.values()]);
export const saveMessages = (channelId: string) =>
  write(join(MSG_DIR, `${channelId}.json`), () => messages.get(channelId) ?? []);

export function createChannel(name: string, cwd: string): Channel {
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
  };
  channels.set(ch.id, ch);
  messages.set(ch.id, []);
  saveChannels();
  saveMessages(ch.id);
  return ch;
}

export function addMessage(channelId: string, m: Omit<Message, "id" | "ts">): Message {
  const msg: Message = { id: crypto.randomUUID(), ts: Date.now(), ...m };
  const list = messages.get(channelId) ?? [];
  list.push(msg);
  messages.set(channelId, list);
  saveMessages(channelId);
  return msg;
}

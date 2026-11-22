/**
 * A Harmonia channel's marks in its Slack channel. Slack has no badges on channels, and apps can't sort channels into
 * sidebar sections, so the status (In progress, Waiting for response, For later) and the ClickUp task go in the
 * channel's topic (the line next to its name), and the task is also a bookmark under the header, one click from the
 * task. Only in Slack channels Harmonia made: one you brought Harmonia into keeps its own topic and bookmarks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths";
import { channels, type Channel, type ChannelStatus } from "./store";
import { SlackError } from "./slack-socket";

const FILE = join(DATA, "slack-marks.json");
const SETTLE = 2_000; // a status picked and changed again right away goes out once
const RETRY = 60_000; // after Slack had a hiccup

/** The status in a topic: the emoji's color is the status dot's in the app. */
export const STATUS_MARKS: Partial<Record<ChannelStatus, string>> = {
  inProgress: "🔵 In progress",
  waiting: "🟠 Waiting for response",
  later: "🟣 For later",
};

/** What the topic says for a channel: "🔵 In progress · ClickUp ABC-123", or "" with no status and no task. */
export function topicOf(ch: Pick<Channel, "status" | "task">): string {
  const status = ch.status && STATUS_MARKS[ch.status];
  return [status, ch.task && `ClickUp ${ch.task.id}`].filter(Boolean).join(" · ");
}

type Bookmark = { title: string; link: string };

/** What Harmonia put in a Slack channel. */
type Marks = {
  ours?: boolean; // Harmonia made it (asked Slack once)
  topic?: string; // the topic Harmonia last set
  bookmark?: Bookmark & { id: string }; // the task's bookmark
};

type Deps = {
  api: (method: string, params: Record<string, unknown>) => Promise<any>;
  on: () => boolean; // Slack is connected
  links: () => { conversationId: string; channelId: string; kind: string }[];
  botUserId: () => string | undefined;
  canBookmark: () => boolean; // the bot token has bookmarks:write
  log: (event: string, fields?: Record<string, unknown>) => void;
};

export class ChannelMarks {
  private marks: Record<string, Marks>; // Slack conversation id → what Harmonia put there
  private wanted = new Map<string, string>(); // conversation → the marks last sent for (or being sent), so a read tick sends nothing
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private work: Promise<unknown> = Promise.resolve(); // one Slack change at a time

  constructor(private deps: Deps) {
    try {
      this.marks = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      this.marks = {};
    }
  }

  /** A Harmonia channel changed (its status, task, or just read ticks): its Slack channel follows, once picks settle. */
  changed(ch: Channel) {
    const link = this.linkOf(ch.id);
    if (!link || !this.deps.on() || this.wanted.get(link) === this.want(ch)) return;
    this.wanted.set(link, this.want(ch));
    clearTimeout(this.timers.get(link));
    this.timers.set(
      link,
      setTimeout(() => {
        this.timers.delete(link);
        this.send(link, ch.id);
      }, SETTLE),
    );
  }

  /** Every linked channel: once connected (marks changed while Harmonia was off), and when the app gets new scopes. */
  all() {
    if (!this.deps.on()) return;
    const linked = new Set(this.deps.links().map((l) => l.conversationId));
    const gone = Object.keys(this.marks).filter((id) => !linked.has(id));
    for (const id of gone) delete this.marks[id];
    if (gone.length) this.save();
    for (const ch of channels.values()) this.changed(ch);
  }

  /** The Slack channel (public or private) a Harmonia channel is linked to. DMs and group DMs have no topic to keep. */
  private linkOf(channelId: string): string | undefined {
    return this.deps.links().find((l) => l.channelId === channelId && (l.kind === "channel" || l.kind === "private"))?.conversationId;
  }

  /** What a channel's Slack marks should be, as one string to compare. An archived channel leaves Slack instead. */
  private want(ch: Channel): string {
    if (ch.status === "archived") return "archived";
    return JSON.stringify([topicOf(ch), this.deps.canBookmark() ? (ch.task ?? null) : "no scope"]);
  }

  private send(conversation: string, channelId: string) {
    this.work = this.work
      .then(() => this.sync(conversation, channelId))
      .catch((e) => {
        this.deps.log("slack.marks_failed", { conversation, channelId, error: e?.message });
        // Refused (the workspace locks topics, say): again when the marks change. A hiccup: again in a minute.
        if (e instanceof SlackError && !isRetryable(e)) return;
        this.wanted.delete(conversation);
        const ch = channels.get(channelId);
        if (ch) setTimeout(() => this.changed(ch), RETRY);
      });
  }

  private async sync(conversation: string, channelId: string) {
    const ch = channels.get(channelId);
    if (!ch || ch.status === "archived" || this.linkOf(channelId) !== conversation || !this.deps.on()) return;
    const m: Marks = this.marks[conversation] ?? {};
    const topic = topicOf(ch);
    const bookmarks = this.deps.canBookmark();
    const task: Bookmark | undefined = bookmarks && ch.task ? { title: `ClickUp ${ch.task.id}`, link: ch.task.url } : undefined;
    if (!topic && !m.topic && !task && !m.bookmark) return; // nothing there, nothing to put there
    if (m.ours === undefined) {
      const info = await this.deps.api("conversations.info", { channel: conversation });
      m.ours = Boolean(info.channel?.creator) && info.channel.creator === this.deps.botUserId();
      this.marks[conversation] = m;
      this.save();
    }
    if (!m.ours) return;
    if (topic !== (m.topic ?? "")) {
      await this.deps.api("conversations.setTopic", { channel: conversation, topic });
      m.topic = topic || undefined;
      this.save();
      this.deps.log("slack.topic_set", { conversation, channelId, topic });
    }
    if (bookmarks) await this.bookmark(conversation, m, task);
  }

  /** The task's bookmark: added, changed, or taken off. One taken off in Slack is added again only when the task changes. */
  private async bookmark(conversation: string, m: Marks, want: Bookmark | undefined) {
    const have = m.bookmark;
    if (have && want && have.title === want.title && have.link === want.link) return;
    if (have && !want) {
      await this.deps.api("bookmarks.remove", { channel_id: conversation, bookmark_id: have.id }).catch(gone);
      delete m.bookmark;
      return this.save();
    }
    if (!want) return;
    let made: any;
    if (have) made = await this.deps.api("bookmarks.edit", { channel_id: conversation, bookmark_id: have.id, ...want }).catch(gone);
    made ??= await this.deps.api("bookmarks.add", { channel_id: conversation, type: "link", ...want });
    m.bookmark = { id: String(made.bookmark?.id ?? have?.id), ...want };
    this.save();
    this.deps.log("slack.bookmark_set", { conversation, title: want.title });
  }

  private save() {
    writeFileSync(FILE, JSON.stringify(this.marks, null, 1));
  }
}

/** A bookmark someone already took off in Slack: there's nothing to change or remove. */
const gone = (e: unknown) => {
  if (e instanceof SlackError && ["not_found", "bookmark_not_found", "invalid_bookmark_id"].includes(e.code)) return undefined;
  throw e;
};

function isRetryable(e: SlackError) {
  return e.code.startsWith("http_5") || ["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(e.code);
}

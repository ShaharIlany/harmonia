// Slack. One Slack app, "Harmonia", is the bridge: the teammates talk through it, each under its own name and emoji
// (chat:write.customize), and the channel's Mozart decides who answers, as it does in the app.
//
// Your DM with the app mirrors the channel #slack here. A Slack channel (public or private) or group DM the app is in
// is linked to a Harmonia channel the first time you write there. What you write lands in the linked channel as
// your message; other people's messages land too, as context, but never wake a teammate: the teammates work for you
// and can read your mail. What happens in the channel goes back to Slack: the teammates' answers, job starts, errors,
// and what you type in the app. While a teammate works on your Slack message, it carries 👀.
//
// Every message is kept with its Slack ts (meta.slack), so Slack's own gestures work: a thread reply is a reply to that
// message here (it wakes that teammate), and the answers follow you into the thread; your reaction on a message is
// your reaction here; ⚠️ on a teammate's message gets you a DM asking how it could be better, and your answer (a
// thread reply, or the box behind its button) is feedback, as ✎ gives it in the app. A teammate's request for a tool
// (a connector) or a permission comes with buttons, and the card says what you decided, here or there.
//
// `@Harmonia new channel <name>` (or `new private channel <name>`) creates a Slack channel with you and anyone you
// @mention in it (conversations.create and conversations.invite: no admin needed) and a linked channel here.
//
// The app is made from a manifest (CREATE_LINK) and connects over Socket Mode (slack-socket.ts): nothing listens on the
// internet. The Slack user who sends the app the pairing code from the Slack page is the only one who wakes the
// teammates.
//
// Kept in the data folder: slack.json (the workspace, the app, who it works for, the linked conversations). The bot
// token and the app-level token are in the Keychain.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DEFAULT_CWD } from "./paths";
import { USER_NAME, nameOf, teammate } from "./roster";
import { channels, createChannel, messages, saveMessages, type Channel, type Message, type SlackRef } from "./store";
import type { Event } from "./team";
import { SlackError, SlackSocket, isAuthError, slackAuth, slackCall, type Envelope, type SocketState } from "./slack-socket";

const FILE = join(DATA, "slack.json");
const KEYCHAIN_SERVICE = "Harmonia Slack";
/** Off the Mac there's no Keychain (a run from the repo on Linux): the tokens go here, readable only by you. */
const SECRETS_FILE = join(DATA, "slack-secrets.json");
const SEND_RETRIES = [2_000, 5_000, 15_000];
const WORKING = "eyes"; // the reaction on your Slack message while a teammate works on it
const MARKDOWN_BLOCK_MAX = 12_000; // Slack's limit for a markdown block
const TEXT_MAX = 39_000; // chat.postMessage truncates text past 40,000 characters
const PAIR_TRIES = 5; // wrong pairing codes one Slack user may send before the app stops listening to them
const FEEDBACK = "warning"; // ⚠️: your reaction that asks for feedback on a teammate's message
const FEEDBACK_VIEW = "harmonia:feedback"; // the feedback box (a modal)
const ASKS_KEPT = 50; // feedback questions whose thread replies still count as feedback

/** The app's name in Slack. The commands are written to it: `@Harmonia new channel …`. */
export const APP_NAME = "Harmonia";
const USER_LOOK = { name: `${USER_NAME} (in Harmonia)`, avatar: "👤" };

/**
 * What the app may do, as bot scopes: read and write in the conversations it's in, post under the teammates' names,
 * create channels and invite you to them, react (👀) and read your reactions, and look up people by id or email.
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
];
export const BOT_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim", "member_joined_channel", "reaction_added", "reaction_removed"];

/** The Slack app manifest: Socket Mode on, a bot you can DM, buttons and boxes (interactivity), and the scopes and events above. */
export function manifest() {
  return {
    display_information: {
      name: APP_NAME,
      description: "Your Harmonia teammates in Slack",
      long_description:
        "Connects Slack to Harmonia, a local group chat with Claude Code teammates. Write in a linked channel or a DM and the teammate whose work it is answers, under their own name. Only the person who paired the app can wake the teammates. It connects out over Socket Mode, so nothing listens on the internet.",
      background_color: "#24292f",
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: APP_NAME, always_online: true },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** Opens Slack's "create an app" page with the manifest filled in. */
export const CREATE_LINK = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest()))}`;

type Config = {
  teamId: string;
  teamName?: string;
  teamUrl?: string;
  appId?: string;
  botId?: string;
  botUserId: string; // the app's bot user: its own messages are skipped, @mentions of it are commands
  ownerId?: string; // the only Slack user who wakes the teammates (whoever sent the pairing code)
  ownerName?: string;
  pairCode?: string; // while nobody is paired
  scopes?: string[]; // what the bot token was granted, last time Slack was asked
  enabled: boolean;
  createdAt: number;
};

/** A ⚠️ question in your DM: thread replies to it are feedback on that message. */
type Ask = { channelId: string; messageId: string; at: number };

/** A Slack conversation linked to a Harmonia channel. */
export type Link = {
  conversationId: string; // C… (a channel), G… (private, or an older group), D… (your DM with the app)
  kind: "dm" | "channel" | "private" | "group";
  channelId: string; // the Harmonia channel
  name?: string;
  createdAt: number;
};

export type SlackView = {
  rev: number; // goes up with every change, so the page never takes an older view over a newer one
  configured: boolean;
  enabled: boolean;
  state: SocketState["state"] | "off";
  detail?: string;
  team?: string;
  teamUrl?: string;
  appLink?: string; // the app's settings at api.slack.com
  paired: boolean;
  ownerName?: string;
  pairCode?: string;
  missingScopes: string[]; // the app was made from an older manifest: update it
  createLink: string;
};

export type LinkView = { conversationId: string; kind: Link["kind"]; channelId: string; name?: string; url?: string };

export type SlackEvent = { type: "slack"; slack: SlackView; links: LinkView[] };

type Look = { name: string; avatar: string };
/** What a Slack message says: the teammates' Markdown, or the app's own mrkdwn text with blocks (cards, buttons). */
type Content = { markdown: string } | { text: string; blocks: unknown[] };

type Deps = {
  emit: (e: SlackEvent) => void;
  /** Posts as you in a channel, exactly like typing it there (from Slack): maybe a reply to a message there. */
  post: (ch: Channel, text: string, from: { replyTo?: string; slack: SlackRef }) => Message;
  /** Someone else's message in a linked Slack conversation: context only. */
  guest: (ch: Channel, name: string, text: string, slackId: string | undefined, slack: SlackRef) => void;
  /** A note in a channel (from Slack, so it isn't sent back there). */
  note: (ch: Channel, text: string) => void;
  /** Your reaction on a message (undefined takes it off), from Slack. */
  react: (ch: Channel, m: Message, emoji: string | undefined) => void;
  /** Your feedback on a teammate's message, as ✎ gives it (given in Slack, so it stays out of the Slack conversation). */
  feedback: (ch: Channel, messageId: string, text: string) => string | undefined;
  /** Approve / Deny on a teammate's tool request. */
  decideTools: (ch: Channel, messageId: string, decision: "approved" | "denied") => string | undefined;
  /** Allow once / always / Deny on a permission card. */
  decide: (ch: Channel, messageId: string, decision: "once" | "always" | "denied") => void;
  /** Tells the page about a channel the bridge created. */
  channelCreated: (ch: Channel) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

/** Message subtypes that are still someone writing: a thread reply sent to the channel too, a file with a caption, /me. */
const WRITTEN = new Set(["thread_broadcast", "file_share", "me_message"]);

export class SlackBridge {
  private config?: Config;
  private links: Record<string, Link>;
  private socket?: SlackSocket;
  private botToken = "";
  private failed?: string; // the tokens couldn't be read
  private seen = new Set<string>(); // messages already taken in (Slack redelivers when an ack is late)
  private names = new Map<string, string>(); // Slack user id → the name they go by
  private pairTries = new Map<string, number>();
  private working = new Map<string, Set<string>>(); // Harmonia channel id → teammates working there
  private lastIn = new Map<string, string>(); // Harmonia channel id → ts of your latest Slack message there
  private watching = new Map<string, { channel: string; ts: string }>(); // Harmonia channel id → the message with 👀
  private reacted = new Set<string>();
  private threads = new Map<string, string>(); // Harmonia channel id → the Slack thread the conversation is in now
  private cardsDone = new Set<string>(); // cards whose Slack message already says what was decided
  private asks: Record<string, Ask>; // ts of a ⚠️ question in your DM → the message it's about
  private sending: Promise<void> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve(); // Slack messages are taken in one at a time, in order
  private rev = 0;

  constructor(private deps: Deps) {
    const saved = readJson<{ config?: Config; links?: Record<string, Link>; asks?: Record<string, Ask> }>(FILE, {});
    this.config = saved.config;
    this.links = saved.links ?? {};
    this.asks = saved.asks ?? {};
  }

  /** Connects, when the app is set up and on. */
  start() {
    if (this.config?.enabled) void this.connect();
  }

  stop() {
    this.socket?.stop();
    this.socket = undefined;
  }

  status(): SlackView {
    const c = this.config;
    const s: { state: SlackView["state"]; detail?: string } = !c?.enabled
      ? { state: "off" }
      : this.failed
        ? { state: "failed", detail: this.failed }
        : (this.socket?.state ?? { state: "connecting" });
    return {
      rev: this.rev,
      configured: Boolean(c),
      enabled: Boolean(c?.enabled),
      state: s.state,
      detail: s.detail,
      team: c?.teamName,
      teamUrl: c?.teamUrl,
      appLink: c?.appId ? `https://api.slack.com/apps/${c.appId}` : undefined,
      paired: Boolean(c?.ownerId),
      ownerName: c?.ownerName,
      pairCode: c && !c.ownerId ? c.pairCode : undefined,
      missingScopes: c?.scopes ? BOT_SCOPES.filter((s) => !c.scopes!.includes(s)) : [],
      createLink: CREATE_LINK,
    };
  }

  linkViews(): LinkView[] {
    const team = this.config?.teamId;
    return Object.values(this.links).map((l) => ({
      conversationId: l.conversationId,
      kind: l.kind,
      channelId: l.channelId,
      name: l.name,
      url: team ? `https://app.slack.com/client/${team}/${l.conversationId}` : undefined,
    }));
  }

  changed = () => {
    this.rev++;
    this.deps.emit({ type: "slack", slack: this.status(), links: this.linkViews() });
  };

  private save() {
    writeFileSync(FILE, JSON.stringify({ config: this.config, links: this.links, asks: this.asks }, null, 1), { mode: 0o600 });
  }

  // ---------- Setup ----------

  /** Checks both tokens with Slack, keeps them in the Keychain, and connects. Returns an error to show. */
  async connectApp(botToken: string, appToken: string): Promise<string | undefined> {
    botToken = botToken.trim();
    appToken = appToken.trim();
    if (!botToken.startsWith("xoxb-")) return "The bot token starts with xoxb-. It's under OAuth & Permissions → Bot User OAuth Token, once the app is installed.";
    if (!appToken.startsWith("xapp-")) return "The app-level token starts with xapp-. Make one under Basic Information → App-Level Tokens, with the connections:write scope.";
    let auth: any;
    try {
      auth = await slackAuth(botToken);
    } catch (e: any) {
      return `Slack didn't accept the bot token: ${e.message}`;
    }
    try {
      await slackCall(appToken, "apps.connections.open");
    } catch (e: any) {
      if (e instanceof SlackError && e.code === "missing_scope") return "The app-level token needs the connections:write scope. Make a new one with it.";
      return `Slack didn't accept the app-level token: ${e.message}${isAuthError(e) ? "" : ". Is Socket Mode on for the app?"}`;
    }
    const bot = auth.bot_id ? await slackCall(botToken, "bots.info", { bot: auth.bot_id }).then((j) => j.bot ?? {}, () => ({})) : {};
    const err = await saveTokens(String(auth.team_id), botToken, appToken);
    if (err) return err;
    const was = this.config;
    const same = was?.teamId === auth.team_id;
    if (was && !same) {
      await deleteTokens(was.teamId);
      this.links = {}; // another workspace's conversations mean nothing here
    }
    this.config = {
      teamId: String(auth.team_id),
      teamName: auth.team,
      teamUrl: auth.url,
      appId: bot.app_id,
      botId: auth.bot_id,
      botUserId: String(auth.user_id),
      ownerId: same ? was?.ownerId : undefined,
      ownerName: same ? was?.ownerName : undefined,
      pairCode: same && was?.ownerId ? undefined : newPairCode(),
      scopes: auth.scopes,
      enabled: true,
      createdAt: same ? was!.createdAt : Date.now(),
    };
    this.save();
    await this.connect();
    this.deps.log("slack.app_connected", { team: auth.team_id, app: bot.app_id });
  }

  /** Asks Slack again what the bot token may do (after you updated the app's manifest and reinstalled it). */
  async checkScopes(): Promise<string | undefined> {
    if (!this.config) return "Slack isn't set up.";
    if (!this.botToken) return "Slack isn't connected.";
    try {
      const auth = await slackAuth(this.botToken);
      if (JSON.stringify(auth.scopes) === JSON.stringify(this.config.scopes)) return;
      this.config.scopes = auth.scopes;
      this.save();
      this.changed();
    } catch (e: any) {
      return `Couldn't ask Slack: ${e.message}`;
    }
  }

  setEnabled(enabled: boolean): string | undefined {
    if (!this.config) return "Slack isn't set up.";
    this.config.enabled = enabled;
    this.save();
    if (enabled) void this.connect();
    else {
      this.stop();
      this.changed();
    }
  }

  /** Forgets the app here: its tokens leave the Keychain, and the links go. The app stays in Slack until you delete it there. */
  async remove(): Promise<string | undefined> {
    if (!this.config) return "Slack isn't set up.";
    this.stop();
    await deleteTokens(this.config.teamId);
    this.botToken = "";
    this.config = undefined;
    this.links = {};
    this.save();
    this.changed();
  }

  /** Forgets who the app works for (if anyone): a new pairing code, for the next person who sends it, and fresh tries for everyone. */
  repair(): string | undefined {
    if (!this.config) return "Slack isn't set up.";
    this.config.ownerId = this.config.ownerName = undefined;
    this.config.pairCode = newPairCode();
    this.pairTries.clear();
    this.save();
    this.changed();
  }

  /** Stops mirroring a Slack conversation. Both sides keep their messages. */
  unlink(conversationId: string): string | undefined {
    const l = this.links[conversationId];
    if (!l) return "That Slack conversation isn't linked.";
    void this.stopWatching(l.channelId);
    this.working.delete(l.channelId);
    this.lastIn.delete(l.channelId);
    delete this.links[conversationId];
    this.save();
    this.changed();
  }

  private async connect() {
    const c = this.config;
    if (!c) return;
    this.stop();
    const tokens = await readTokens(c.teamId);
    if (!tokens) {
      this.failed = "The Slack tokens are missing from the Keychain. Remove the connection and connect again.";
      return this.changed();
    }
    this.failed = undefined;
    this.botToken = tokens.bot;
    this.socket = new SlackSocket(
      tokens.app,
      (e) => void this.onEnvelope(e).catch((err) => this.deps.log("slack.event_failed", { error: err?.message })),
      () => this.changed(),
      (event, fields) => this.deps.log(event, fields),
    );
    this.socket.start();
    this.changed();
    void this.checkScopes();
  }

  private api(method: string, params: Record<string, unknown> = {}) {
    if (!this.botToken) return Promise.reject(new SlackError("not_connected", "Slack isn't connected"));
    return slackCall(this.botToken, method, params);
  }

  // ---------- Slack → Harmonia ----------

  private async onEnvelope(env: Envelope) {
    // A button or a box: right away, since a box has to open within 3 s of the click.
    if (env.type === "interactive") return this.interactive(env.payload ?? {});
    if (env.type !== "events_api") return;
    const ev = env.payload?.event;
    if (ev?.type === "member_joined_channel") return this.joined(ev);
    const handle =
      ev?.type === "message" ? () => this.message(ev) : ev?.type === "reaction_added" || ev?.type === "reaction_removed" ? () => this.reaction(ev, ev.type === "reaction_added") : undefined;
    if (!handle) return;
    // One at a time: two quick messages in a new conversation link it once, and everything lands in the order sent.
    const next = this.inbound.then(handle);
    this.inbound = next.catch(() => {});
    return next;
  }

  /** The app was added to a channel: it says what it does there. (Not in one it just made: that one gets a welcome.) */
  private async joined(ev: any) {
    if (!this.config || ev.user !== this.config.botUserId) return;
    await Bun.sleep(3_000); // a channel the app is creating is linked by then
    if (this.links[ev.channel]) return;
    this.say(
      ev.channel,
      `Hi, I'm ${APP_NAME} :musical_score:. I connect this channel to Harmonia: when ${USER_NAME} writes here, Mozart picks the teammate who answers (or start with @Leo to ask Leo). Write *@${APP_NAME} help* for what I can do.`,
    );
  }

  private async message(ev: any) {
    const c = this.config;
    if (!c || !ev.channel || !ev.ts) return;
    if (ev.subtype && !WRITTEN.has(ev.subtype)) return; // edits, deletions, joins, other apps
    if (ev.bot_id || !ev.user || ev.user === c.botUserId) return;
    const key = `${ev.channel}:${ev.ts}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);

    const raw = String(ev.text ?? "");
    const dm = ev.channel_type === "im";
    if (!c.ownerId) return dm ? this.pair(ev, raw) : undefined;
    const yours = ev.user === c.ownerId;
    if (dm && !yours) {
      this.deps.log("slack.message_refused", { user: ev.user });
      return this.say(ev.channel, `Sorry, I only work for ${USER_NAME}.`);
    }
    // A reply in a thread: in your DM under a ⚠️ question it's feedback; anywhere else, a reply to the thread's message.
    const thread = ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : undefined;
    const ask = dm && yours && thread ? this.asks[thread] : undefined;
    if (ask) return this.feedbackReply(ev, raw, ask, thread!);
    if (yours && (dm || mentions(raw, c.botUserId))) {
      const cmd = parseCommand(commandText(raw));
      if (cmd) return this.command(ev, raw, cmd);
    }

    let link = this.links[ev.channel];
    if (!link) {
      if (!yours) return; // someone else's conversation: nothing to link until you write there
      link = await this.autoLink(ev);
    }
    const ch = channels.get(link.channelId);
    if (!ch) {
      delete this.links[ev.channel];
      this.save();
      this.changed();
      return yours ? this.say(ev.channel, "Its Harmonia channel is gone. Write again to link this conversation to a new one.") : undefined;
    }
    const files = (ev.files ?? []).map((f: any) => f.name || f.title).filter(Boolean);
    let text = await this.chatText(raw);
    if (files.length) text = [text, `(attached in Slack: ${files.join(", ")})`].filter(Boolean).join("\n");
    if (!text) return yours ? this.say(ev.channel, "I can only read text for now.", thread) : undefined;
    const ref: SlackRef = { channel: ev.channel, ts: String(ev.ts), ...(thread && { thread }) };
    if (!yours) return this.deps.guest(ch, await this.nameOf(ev.user), text, ev.user, ref);
    if (ch.status === "archived") return this.say(ev.channel, `#${ch.name} is archived in Harmonia. Unarchive it there and write again.`, thread);
    // The answers go where you wrote: into the thread, or the channel itself.
    if (thread) this.threads.set(ch.id, thread);
    else this.threads.delete(ch.id);
    this.lastIn.set(ch.id, ref.ts);
    this.deps.post(ch, text, { replyTo: thread ? this.bySlack(ch.id, ev.channel, thread)?.id : undefined, slack: ref });
  }

  /** The message here that is `ts` in a Slack conversation. */
  private bySlack(channelId: string, conversation: string, ts: string): Message | undefined {
    return (messages.get(channelId) ?? []).findLast((m) => m.meta?.slack?.ts === ts && m.meta.slack.channel === conversation);
  }

  // ---------- Your reactions, and ⚠️ feedback ----------

  /** Your reaction on a message in a linked conversation is your reaction on it here. ⚠️ on a teammate's also asks for feedback. */
  private async reaction(ev: any, added: boolean) {
    const c = this.config;
    const item = ev.item;
    if (!c?.ownerId || ev.user !== c.ownerId || item?.type !== "message") return;
    const link = this.links[item.channel];
    const ch = link && channels.get(link.channelId);
    const m = ch && this.bySlack(ch.id, item.channel, String(item.ts));
    if (!ch || !m) return;
    const emoji = emojiOf(String(ev.reaction));
    if (added) {
      this.deps.react(ch, m, emoji);
      if (bareName(String(ev.reaction)) === FEEDBACK && teammate(m.author)) await this.askFeedback(ch, link, m);
    } else if (m.meta?.reactions?.some((x) => x.by === "user" && x.emoji === emoji)) this.deps.react(ch, m, undefined);
  }

  /** A DM asking how a teammate's message can be improved: its thread replies, or the box behind its button, are feedback. */
  private async askFeedback(ch: Channel, link: Link, m: Message) {
    const dm = await this.api("conversations.open", { users: this.config!.ownerId }).then(
      (j) => String(j.channel.id),
      (e) => void this.deps.log("slack.feedback_dm_failed", { error: e.message }),
    );
    if (!dm) return;
    const name = escapeSlack(nameOf(m.author));
    const text = [
      `:warning: How can *${name}*'s message ${link.conversationId === dm ? "here" : `in <#${link.conversationId}>`} be improved?`,
      quote(relayText(m) ?? m.text),
      `Reply in this thread, or press *Write feedback*. ${name} works out how its rules led to that message and amends them, like ✎ in Harmonia.`,
    ].join("\n");
    const blocks = [section(text), { type: "actions", elements: [button("Write feedback", `${FEEDBACK_VIEW}:open`, target(ch, m), "primary")] }];
    const r = await this.queue(() => this.api("chat.postMessage", { channel: dm, text, blocks, unfurl_links: false }), dm);
    if (!r?.ts) return;
    this.asks[String(r.ts)] = { channelId: ch.id, messageId: m.id, at: Date.now() };
    for (const [ts] of Object.entries(this.asks).sort(([, a], [, b]) => b.at - a.at).slice(ASKS_KEPT)) delete this.asks[ts];
    this.save();
    this.deps.log("slack.feedback_asked", { channelId: ch.id, messageId: m.id });
  }

  private async feedbackReply(ev: any, raw: string, ask: Ask, thread: string) {
    const text = await this.chatText(raw);
    this.say(ev.channel, text ? this.giveFeedback(ask.channelId, ask.messageId, text) : "I can only read text for now.", thread);
  }

  /** Feedback on a teammate's message, as ✎ gives it in the app. Returns what to tell you. */
  private giveFeedback(channelId: string, messageId: string, text: string): string {
    const ch = channels.get(channelId);
    const m = ch && messages.get(ch.id)?.find((x) => x.id === messageId);
    if (!ch || !m) return "That message is gone from Harmonia.";
    if (ch.status === "archived") return `#${ch.name} is archived in Harmonia. Unarchive it there, then try again.`;
    if (text.length > 4000) return "Feedback is up to 4000 characters.";
    const err = this.deps.feedback(ch, messageId, text);
    return err ? `Couldn't send it: ${err}` : `:white_check_mark: Sent to ${escapeSlack(nameOf(m.author))}. It's amending its rules: its job shows in #${escapeSlack(ch.name)}.`;
  }

  // ---------- Buttons and boxes ----------

  private async interactive(p: any) {
    const c = this.config;
    if (!c) return;
    const user = p.user?.id;
    if (p.type === "view_submission" && p.view?.callback_id === FEEDBACK_VIEW) {
      if (user !== c.ownerId) return;
      const at = parse(p.view.private_metadata);
      const text = String(p.view.state?.values?.feedback?.text?.value ?? "").trim();
      if (!text) return;
      const said = this.giveFeedback(at.c, at.m, text);
      if (at.dm) this.say(at.dm, said, at.ts);
      return;
    }
    if (p.type !== "block_actions") return;
    const where = p.channel?.id ?? p.container?.channel_id;
    for (const a of p.actions ?? []) {
      const [ns, kind, choice] = String(a.action_id ?? "").split(":");
      if (ns !== "harmonia") continue;
      if (user !== c.ownerId) {
        this.ephemeral(where, user, `Only ${USER_NAME} can do that.`);
        continue;
      }
      const t = parse(a.value);
      const ch = channels.get(t.c);
      if (!ch) {
        this.ephemeral(where, user, "That channel is gone from Harmonia.");
        continue;
      }
      if (kind === "feedback") {
        await this.openFeedback(p.trigger_id, ch, t.m, { dm: where, ts: p.message?.ts ?? p.container?.message_ts });
        continue;
      }
      if (ch.status === "archived") {
        this.ephemeral(where, user, `#${ch.name} is archived in Harmonia. Unarchive it there first.`);
        continue;
      }
      let err: string | undefined;
      if (kind === "tools" && (choice === "approved" || choice === "denied")) err = this.deps.decideTools(ch, t.m, choice);
      else if (kind === "perm" && (choice === "once" || choice === "always" || choice === "denied")) {
        const m = messages.get(ch.id)?.find((x) => x.id === t.m);
        if (!m?.meta?.permission) err = "That request is gone.";
        else if (m.meta.permission.status !== "pending") err = "Already decided.";
        else this.deps.decide(ch, t.m, choice);
      } else continue;
      if (err) this.ephemeral(where, user, err);
      this.deps.log("slack.decided", { kind, choice, error: err });
    }
  }

  /** The feedback box, like ✎'s in the app. */
  private async openFeedback(trigger: string, ch: Channel, messageId: string, origin: { dm?: string; ts?: string }) {
    const m = messages.get(ch.id)?.find((x) => x.id === messageId);
    if (!m || !teammate(m.author)) return this.ephemeral(origin.dm, this.config?.ownerId, "That message is gone from Harmonia.");
    const name = nameOf(m.author);
    try {
      await this.api("views.open", {
        trigger_id: trigger,
        view: {
          type: "modal",
          callback_id: FEEDBACK_VIEW,
          private_metadata: JSON.stringify({ c: ch.id, m: m.id, ...origin }),
          title: plain(`Feedback for ${name}`.slice(0, 24)),
          submit: plain("Send"),
          close: plain("Cancel"),
          blocks: [
            section(`*${escapeSlack(name)}* in #${escapeSlack(ch.name)}:\n${quote(relayText(m) ?? m.text)}`),
            {
              type: "input",
              block_id: "feedback",
              label: plain("How can it be improved?"),
              hint: plain(`${name} works out how its rules led to this message and amends them.`),
              element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 4000, focus_on_load: true },
            },
          ],
        },
      });
    } catch (e: any) {
      this.deps.log("slack.feedback_box_failed", { error: e.message });
      if (origin.dm) this.say(origin.dm, `Couldn't open the box (${e.code ?? e.message}). Reply in this thread instead.`, origin.ts);
    }
  }

  /** A note only `user` sees, in that conversation. */
  private ephemeral(channel: string | undefined, user: string | undefined, text: string) {
    if (channel && user) void this.queue(() => this.api("chat.postEphemeral", { channel, user, text }), channel);
  }

  /** Nobody is paired yet: the first person to DM the pairing code becomes the one the teammates work for. */
  private async pair(ev: any, raw: string) {
    const c = this.config!;
    const tries = this.pairTries.get(ev.user) ?? 0;
    if (tries >= PAIR_TRIES) return;
    if (!c.pairCode || !new RegExp(`(^|\\D)${c.pairCode}(\\D|$)`).test(raw)) {
      this.pairTries.set(ev.user, tries + 1);
      return this.say(ev.channel, "I don't know who I work for yet. Send me the pairing code from Harmonia's Slack page (the Slack bridge light at the bottom left).");
    }
    c.ownerId = ev.user;
    c.ownerName = await this.nameOf(ev.user);
    c.pairCode = undefined;
    this.pairTries.clear();
    this.save();
    this.changed();
    this.deps.log("slack.paired", { user: ev.user });
    const link = this.links[ev.channel] ?? (await this.autoLink(ev));
    const ch = channels.get(link.channelId);
    this.say(
      ev.channel,
      [
        `Paired :white_check_mark: I work for you now, ${USER_NAME}. This DM is *#${ch?.name ?? "slack"}* in Harmonia: write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.`,
        `To bring the team to a channel, \`/invite @${APP_NAME}\` there and write. Or ask me: *new channel <name>*. *help* lists what I can do.`,
      ].join("\n"),
    );
  }

  /** A new Harmonia channel for a Slack conversation you wrote in. */
  private async autoLink(ev: any): Promise<Link> {
    const kind: Link["kind"] = ev.channel_type === "im" ? "dm" : ev.channel_type === "mpim" ? "group" : ev.channel_type === "group" ? "private" : "channel";
    let name: string | undefined;
    if (kind === "channel" || kind === "private") name = await this.api("conversations.info", { channel: ev.channel }).then((j) => j.channel?.name, () => undefined);
    const ch = createChannel(kind === "dm" ? "slack" : kind === "group" ? "slack group dm" : `slack ${name ?? "channel"}`, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const link: Link = { conversationId: ev.channel, kind, channelId: ch.id, name, createdAt: Date.now() };
    this.links[link.conversationId] = link;
    this.save();
    this.deps.note(ch, `Linked to Slack: ${kind === "dm" ? `your DM with @${APP_NAME}` : kind === "group" ? "a group DM" : `#${name ?? "a channel"}`}${this.config?.teamName ? ` in ${this.config.teamName}` : ""}.`);
    this.changed();
    this.deps.log("slack.linked", { conversation: link.conversationId, channelId: ch.id, kind });
    return link;
  }

  /** The message as the teammates read it: Slack's markup as text, people as @Name, the app's own @mention dropped. */
  private async chatText(raw: string): Promise<string> {
    const me = this.config?.botUserId;
    for (const [, id] of raw.matchAll(USER_MENTION)) if (id !== me) await this.nameOf(id);
    return slackToText(raw, (id) => (id === me ? "" : `@${this.names.get(id) ?? id}`));
  }

  /** The name a Slack user goes by: their display name, else their full name. */
  private async nameOf(id: string): Promise<string> {
    const known = this.names.get(id);
    if (known) return known;
    try {
      const u = (await this.api("users.info", { user: id })).user ?? {};
      const name = String(u.profile?.display_name || u.real_name || u.name || id).slice(0, 80);
      this.names.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  // ---------- Commands ----------

  private async command(ev: any, raw: string, cmd: Command) {
    if (cmd.kind === "help") {
      const at = ev.channel_type === "im" ? "" : `@${APP_NAME} `;
      return this.say(
        ev.channel,
        [
          `*${APP_NAME}* :musical_score: connects Slack to your teammates in Harmonia. Write as usual and Mozart picks who answers, or start with @Leo to ask Leo.`,
          `• *${at}new channel <name>*: a new channel with you in it, linked to a new Harmonia channel. @mention people to invite them too.`,
          `• *${at}new private channel <name>*: the same, but only the people in it see it.`,
          `• \`/invite @${APP_NAME}\` in any channel: it's linked the first time you write there.`,
          `• *${at}help*: this.`,
        ].join("\n"),
      );
    }
    const err = await this.newChannel(ev, raw, cmd);
    if (err) this.say(ev.channel, `Couldn't create it: ${err}`);
  }

  /** People named in a command: @mentions (not the app) and email addresses, as Slack user ids. */
  private async people(raw: string): Promise<{ ids: string[]; unknown: string[] }> {
    const me = this.config?.botUserId;
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const [, id] of raw.matchAll(USER_MENTION)) if (id !== me) ids.add(id);
    for (const email of slackToText(raw).match(EMAIL) ?? []) {
      try {
        ids.add((await this.api("users.lookupByEmail", { email })).user.id);
      } catch {
        unknown.push(email);
      }
    }
    return { ids: [...ids].filter((id) => id !== this.config?.ownerId), unknown };
  }

  /** `new channel` / `new private channel`: a Slack channel with you (and anyone named) in it, linked to a new Harmonia channel. */
  private async newChannel(ev: any, raw: string, cmd: Extract<Command, { kind: "newChannel" }>): Promise<string | undefined> {
    const c = this.config!;
    const name = slackChannelName(cmd.name);
    if (!name) return `give it a name: *@${APP_NAME} new ${cmd.private ? "private " : ""}channel <name>*.`;
    const people = await this.people(raw);
    if (people.unknown.length) return `there's nobody in this workspace with the email ${people.unknown.join(", ")}.`;
    let made: any;
    try {
      made = (await this.api("conversations.create", { name, is_private: cmd.private })).channel;
    } catch (e: any) {
      if (e.code === "name_taken") return `there's already a channel called #${name}. Pick another name, or \`/invite @${APP_NAME}\` there.`;
      if (e.code === "restricted_action") return "this workspace doesn't let apps create channels. Make the channel yourself and `/invite` me there.";
      return e.message;
    }
    let inviteError: string | undefined;
    try {
      await this.api("conversations.invite", { channel: made.id, users: [c.ownerId, ...people.ids].join(",") });
    } catch (e: any) {
      if (e.code !== "already_in_channel") inviteError = e.message;
    }
    const ch = createChannel(name, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const link: Link = { conversationId: String(made.id), kind: cmd.private ? "private" : "channel", channelId: ch.id, name, createdAt: Date.now() };
    this.links[link.conversationId] = link;
    this.save();
    this.changed();
    this.postAs(undefined, link.conversationId, {
      markdown: `This channel is **#${ch.name}** in Harmonia. Write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.${cmd.private ? " Only the people in it see it." : ""}`,
    });
    this.deps.note(ch, `Created from Slack: the ${cmd.private ? "private " : ""}channel #${name}, linked to this channel.`);
    if (inviteError) this.deps.note(ch, `Couldn't invite everyone to #${name} in Slack: ${inviteError}`);
    this.say(ev.channel, `Created <#${made.id}>, linked to *#${ch.name}* in Harmonia.${inviteError ? ` I couldn't invite everyone: ${inviteError}` : ""}`);
    this.deps.log("slack.channel_created", { conversation: link.conversationId, channelId: ch.id, private: cmd.private });
  }

  // ---------- Harmonia → Slack ----------

  /** Every server event: what happens in a linked channel goes to its Slack conversation. */
  onEvent(e: Event) {
    if (!this.config?.enabled || !this.botToken || !("channelId" in e)) return;
    const link = Object.values(this.links).find((l) => l.channelId === e.channelId);
    const ch = link && channels.get(link.channelId);
    if (!link || !ch) return;
    if (e.type === "activity") return this.activity(link, e.agentId, e.status);
    if (e.type === "update") return this.updated(link, ch, e.message);
    if (e.type !== "message") return;
    const m = e.message;
    if (m.meta?.via === "slack" || m.author === "guest") return;
    const ref = { channelId: ch.id, message: m };
    if (m.author === "user") {
      // Typed in the app. A reply to a message that's in Slack goes into its thread, and the answers follow.
      const to = m.meta?.replyTo && messages.get(ch.id)?.find((x) => x.id === m.meta!.replyTo!.id)?.meta?.slack;
      const root = to && to.channel === link.conversationId ? (to.thread ?? to.ts) : undefined;
      if (root) this.threads.set(ch.id, root);
      else this.threads.delete(ch.id);
      this.lastIn.delete(ch.id); // you're writing in the app now: 👀 goes on nothing in Slack
      return this.postAs(USER_LOOK, link.conversationId, { markdown: m.text }, { thread: root, ref });
    }
    const thread = this.threads.get(ch.id);
    if (m.author === "system") return this.postAs(undefined, link.conversationId, { markdown: `_${m.text}_` }, { thread, ref });
    const t = teammate(m.author);
    if (!t) return;
    const text = relayText(m, ch);
    const content: Content | undefined = card(m, ch) ?? (text ? { markdown: text } : undefined);
    if (content) this.postAs(t, link.conversationId, content, { thread, ref });
  }

  /** A message changed: a teammate's emoji on yours, or a card that's decided now (here or by its buttons). */
  private updated(link: Link, ch: Channel, m: Message) {
    this.reactions(link, m);
    const decided = m.kind === "tools" ? m.meta?.toolRequest?.status !== "pending" : m.kind === "permission" ? m.meta?.permission?.status !== "pending" : false;
    if (!decided || this.cardsDone.has(m.id)) return;
    this.cardsDone.add(m.id);
    void this.queue(async () => {
      const at = m.meta?.slack; // read now: the card itself may have been posted only just before
      const c = card(m, ch);
      if (at && c) await this.api("chat.update", { channel: at.channel, ts: at.ts, ...c });
    }, link.conversationId);
  }

  /** 👀 on your latest Slack message while any teammate works in the channel. */
  private activity(link: Link, agentId: string, status: string | null) {
    if (!teammate(agentId)) return;
    const set = this.working.get(link.channelId) ?? new Set<string>();
    const before = set.size;
    if (status) set.add(agentId);
    else set.delete(agentId);
    this.working.set(link.channelId, set);
    if (!before && set.size) {
      const ts = this.lastIn.get(link.channelId);
      if (!ts) return;
      this.watching.set(link.channelId, { channel: link.conversationId, ts });
      void this.queue(() => this.api("reactions.add", { channel: link.conversationId, timestamp: ts, name: WORKING }).catch(ignore("already_reacted")), link.conversationId);
    } else if (before && !set.size) void this.stopWatching(link.channelId);
  }

  private stopWatching(channelId: string) {
    const w = this.watching.get(channelId);
    this.watching.delete(channelId);
    if (w) return this.queue(() => this.api("reactions.remove", { channel: w.channel, timestamp: w.ts, name: WORKING }).catch(ignore("no_reaction")), w.channel);
  }

  /** A teammate's emoji-only answer lands as a reaction on your message here; in Slack it's a message under its name. */
  private reactions(link: Link, m: Message) {
    if (m.author !== "user") return;
    for (const x of m.meta?.reactions ?? []) {
      const key = `${m.id}:${x.by}:${x.emoji}`;
      const t = teammate(x.by);
      if (!t || this.reacted.has(key)) continue;
      this.reacted.add(key);
      this.postAs(t, link.conversationId, { markdown: x.emoji }, { thread: this.threads.get(link.channelId) });
    }
  }

  /**
   * A message in Slack under a teammate's name and emoji (chat:write.customize), or as the app itself (`look`
   * undefined), in a thread or not. The teammates write Markdown: it goes in a markdown block, with a mrkdwn copy as
   * the notification text. `ref`: the message here, which keeps the Slack ts (for replies, reactions and its card).
   */
  private postAs(look: Look | undefined, channel: string, content: Content, opts: { thread?: string; ref?: { channelId: string; message: Message } } = {}) {
    const icon = look && slackEmoji(look.avatar);
    const md = "markdown" in content ? content.markdown : undefined;
    const params: Record<string, unknown> = {
      channel,
      ...(md === undefined
        ? { text: (content as { text: string }).text.slice(0, TEXT_MAX), blocks: (content as { blocks: unknown[] }).blocks }
        : { text: mrkdwn(md).slice(0, TEXT_MAX), ...(md.length <= MARKDOWN_BLOCK_MAX && { blocks: [{ type: "markdown", text: md }] }) }),
      ...(opts.thread && { thread_ts: opts.thread }),
      unfurl_links: false,
      unfurl_media: false,
      ...(look && { username: icon ? look.name : `${look.avatar} ${look.name}`.trim(), ...(icon && { icon_emoji: `:${icon}:` }) }),
    };
    return this.queue(async () => {
      let r: any;
      try {
        r = await this.api("chat.postMessage", params);
      } catch (e) {
        // A workspace or client that won't take the markdown block gets the mrkdwn text alone.
        if (!(e instanceof SlackError && e.code === "invalid_blocks" && md !== undefined && params.blocks)) throw e;
        delete params.blocks;
        r = await this.api("chat.postMessage", params);
      }
      if (opts.ref && r?.ts) {
        (opts.ref.message.meta ??= {}).slack = { channel, ts: String(r.ts), ...(opts.thread && { thread: opts.thread }) };
        saveMessages(opts.ref.channelId);
      }
    }, channel);
  }

  /** The app's own words, in Slack's mrkdwn (in a thread when `thread` is set). */
  private say(channel: string, text: string, thread?: string) {
    return this.queue(() => this.api("chat.postMessage", { channel, text, unfurl_links: false, ...(thread && { thread_ts: thread }) }), channel);
  }

  /**
   * One call at a time, so messages arrive in order; a failed one is retried a few times unless Slack said no for good.
   * Resolves with what the call returned, or undefined when it failed.
   */
  private queue<T>(fn: () => Promise<T>, where: string): Promise<T | undefined> {
    const run = this.sending.then(async () => {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (err: any) {
          if (i >= SEND_RETRIES.length || !retryable(err)) {
            this.deps.log("slack.send_failed", { channel: where, error: err?.message });
            return undefined;
          }
          await Bun.sleep(SEND_RETRIES[i]);
        }
      }
    });
    this.sending = run.then(() => {});
    return run;
  }
}

// ---------- Helpers ----------

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const mentions = (raw: string, userId: string) => raw.includes(`<@${userId}>`) || raw.includes(`<@${userId}|`);

/** Takes one Slack error as success (already reacted, nothing to take off); anything else still fails. */
const ignore = (code: string) => (e: unknown) => {
  if (!(e instanceof SlackError && e.code === code)) throw e;
};

/** Network trouble and Slack's own hiccups are worth another try; "not_in_channel" and the like aren't. */
function retryable(e: unknown) {
  if (!(e instanceof SlackError)) return true;
  return e.code.startsWith("http_5") || ["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(e.code);
}

const newPairCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

const parse = (json: unknown): Record<string, any> => {
  try {
    return JSON.parse(String(json ?? "{}")) ?? {};
  } catch {
    return {};
  }
};

// Block Kit pieces.
const plain = (text: string) => ({ type: "plain_text", text });
const section = (mrkdwnText: string) => ({ type: "section", text: { type: "mrkdwn", text: mrkdwnText.slice(0, 3000) } });
const button = (label: string, action_id: string, value: string, style?: "primary" | "danger") => ({ type: "button", text: plain(label.slice(0, 75)), action_id, value, ...(style && { style }) });
/** What a button acts on: a message in a Harmonia channel. */
const target = (ch: Channel, m: Message) => JSON.stringify({ c: ch.id, m: m.id });

/** Text as a Slack quote: its first lines, clipped. */
function quote(text: string): string {
  const t = text.trim();
  return escapeSlack(t.length > 500 ? t.slice(0, 499) + "…" : t)
    .split("\n")
    .slice(0, 12)
    .map((l) => `>${l}`)
    .join("\n");
}

/**
 * A teammate's tool request (a connector it lacks) or permission card, as a Slack message: Approve / Deny (or Allow
 * once / always / Deny) buttons while it's pending, what was decided once it isn't. Undefined for anything else.
 */
export function card(m: Message, ch: Channel): { text: string; blocks: unknown[] } | undefined {
  const name = escapeSlack(nameOf(m.author));
  const value = target(ch, m);
  const r = m.kind === "tools" ? m.meta?.toolRequest : undefined;
  if (r) {
    const one = r.tools.length === 1;
    const text = `:toolbox: *${name}* asks for ${one ? "a new tool" : "new tools"}: ${r.tools.map((t) => `\`${escapeSlack(t.name)}\``).join(", ")}${r.reason ? `\n${quote(r.reason)}` : ""}`;
    const done = r.status === "approved" ? `:white_check_mark: Approved: ${name} has ${one ? "it" : "them"} from now on` : r.status === "denied" ? ":no_entry_sign: Denied" : undefined;
    return decided(text, done, [button("Approve", "harmonia:tools:approved", value, "primary"), button("Deny", "harmonia:tools:denied", value)]);
  }
  const p = m.kind === "permission" ? m.meta?.permission : undefined;
  if (p) {
    const text = `:closed_lock_with_key: *${name}*${p.jobId ? `'s job ${escapeSlack(p.jobId)}` : ""} wants to use ${escapeSlack(p.tool)}\n\`${escapeSlack(p.summary)}\``;
    const done = { pending: undefined, once: ":white_check_mark: Allowed once", always: `:white_check_mark: Allowed in #${escapeSlack(ch.name)}`, denied: ":no_entry_sign: Denied" }[p.status];
    return decided(text, done, [
      button("Allow once", "harmonia:perm:once", value, "primary"),
      button(`Always in #${ch.name}`, "harmonia:perm:always", value),
      button("Deny", "harmonia:perm:denied", value),
    ]);
  }
}

const decided = (text: string, done: string | undefined, buttons: unknown[]) => ({
  text: done ? `${text}\n${done}` : text,
  blocks: [section(text), done ? { type: "context", elements: [{ type: "mrkdwn", text: done }] } : { type: "actions", elements: buttons }],
});

export type Command = { kind: "help" } | { kind: "newChannel"; name: string; private: boolean };

/** A command as typed: Slack's markup as text, without any @mentions (the app's, or the people to invite). */
export const commandText = (raw: string) => slackToText(raw.replace(/<@[^>]+>/g, " "));

/**
 * The app's commands: "new channel <name>" (also "create channel …"), "new private channel <name>" (also "new group
 * chat …", "new chat …") and "help". In a channel they only count when the app was @mentioned; in your DM with it,
 * always. Emails and a trailing "with" (the people to invite) aren't part of the name.
 */
export function parseCommand(text: string): Command | undefined {
  const t = text.trim().replace(/^\/+/, "");
  const m = t.match(/^(?:new|create|add|make)[\s-]?(private[\s-]?channel|channel|group[\s-]?chat|chat)\b[\s:]*(.*)$/is);
  if (m) {
    const name = m[2].replace(EMAIL, " ").replace(/(?:[\s,&]|\bwith\b|\band\b)+$/i, "");
    return { kind: "newChannel", private: !/^channel$/i.test(m[1]), name: name.trim().replace(/^["“'#]+|["”']+$/g, "").trim() };
  }
  if (/^(help|\?|commands)$/i.test(t)) return { kind: "help" };
}

/** A Slack channel name: lowercase letters, numbers, hyphens and underscores, at most 80 characters. */
export function slackChannelName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 80)
    .replace(/[-_]+$/, "");
}

/**
 * What a Harmonia message says in Slack (under its teammate's name), or undefined when it stays in the app. A feedback
 * job's card doesn't quote the feedback (its title does): you may have given it in a DM, and the channel may be shared.
 */
export function relayText(m: Message, ch?: Channel): string | undefined {
  if (m.author === "user" || m.author === "guest") return undefined;
  if (m.author === "system") return `_${m.text}_`;
  const name = nameOf(m.author);
  switch (m.kind ?? "text") {
    case "text":
      return m.text.trim() ? m.text : undefined;
    case "job": {
      const job = ch?.jobs.find((j) => j.id === m.meta?.jobId);
      return job?.feedback ? `🛠️ ${name} is amending its rules from ${USER_NAME}'s feedback (job ${job.id})` : `🛠️ ${name} ${m.text}`;
    }
    case "error":
      return `⚠️ ${m.text}`;
    case "permission":
      return `🔐 ${name} is waiting for ${USER_NAME}'s OK in Harmonia: ${m.meta?.permission?.summary ?? m.text}`;
    case "tools":
      return `🧰 ${name} asks for more tools in Harmonia: ${m.meta?.toolRequest?.reason ?? m.text}`;
    default:
      return undefined; // job status updates stay in the app
  }
}

/**
 * Slack's markup as plain text: <@U…> through `user` (Slack ids, by default), <#C…|name> as #name, links as their
 * label (and the address when the label is something else), @here and friends, and &amp; &lt; &gt; decoded.
 */
export function slackToText(text = "", user: (id: string) => string = (id) => `@${id}`): string {
  return text
    .replace(USER_MENTION, (_, id) => user(id))
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<(mailto:)?([^|>]+)\|([^>]+)>/g, (_, mailto, url, label) => (mailto || url.includes(label) ? label : `${label} (${url})`))
    .replace(/<(?:mailto:)?([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** & < > as Slack wants them in text. A > that starts a line stays: it's a quote. */
const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(?<!^[ \t]*)>/gm, "&gt;");

/**
 * Markdown (what the teammates write) as Slack's mrkdwn, for the notification text and when a markdown block won't do:
 * **bold** and headings as *bold*, *italic* as _italic_, ~~struck~~ as ~struck~, [label](url) as <url|label>, list
 * dashes as bullets. Code stays as it is.
 */
export function mrkdwn(md: string): string {
  const prose = (s: string) =>
    escapeSlack(s)
      .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
      .replace(/!?\[([^\]\n]+)\]\(((?:https?|mailto):[^\s)]+)\)/g, "<$2|$1>")
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "\u0001$1\u0001")
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `\u0001${a ?? b}\u0001`)
      .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, "$1_$2_")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/\u0001/g, "*");
  const inline = (s: string) =>
    s
      .split(/(`[^`\n]+`)/g)
      .map((p, i) => (i % 2 ? escapeSlack(p) : prose(p)))
      .join("");
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((p, i) => (i % 2 ? escapeSlack(p) : inline(p)))
    .join("");
}

/** Skin tones and variation selectors off, so 👨🏻‍🎨 and 👨‍🎨 find the same Slack emoji. */
const bare = (e: string) => e.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");

/** Slack's names for emoji a teammate might have as its avatar (icon_emoji takes a name, not the emoji). */
const AVATAR_NAMES: Record<string, string> = {
    "🎼": "musical_score", "👤": "bust_in_silhouette", "🤖": "robot_face",
    "🧙": "mage", "🧙‍♂️": "male_mage", "🧙‍♀️": "female_mage",
    "🧑‍🎨": "artist", "👨‍🎨": "male-artist", "👩‍🎨": "female-artist",
    "🧑‍💻": "technologist", "👨‍💻": "male-technologist", "👩‍💻": "female-technologist",
    "🕵️": "sleuth_or_spy", "🕵️‍♂️": "male-detective", "🕵️‍♀️": "female-detective",
    "🧑‍🔬": "scientist", "👨‍🔬": "male-scientist", "👩‍🔬": "female-scientist",
    "🧑‍💼": "office_worker", "👨‍💼": "male-office-worker", "👩‍💼": "female-office-worker",
    "🧑‍🏫": "teacher", "👨‍🏫": "male-teacher", "👩‍🏫": "female-teacher",
    "🧑‍🔧": "mechanic", "👨‍🔧": "male-mechanic", "👩‍🔧": "female-mechanic",
    "🧑‍⚕️": "health_worker", "👨‍⚕️": "male-doctor", "👩‍⚕️": "female-doctor",
    "🧑‍🚀": "astronaut", "👨‍🚀": "male-astronaut", "👩‍🚀": "female-astronaut",
    "🧑‍🍳": "cook", "👨‍🍳": "male-cook", "👩‍🍳": "female-cook",
    "🧑‍⚖️": "judge", "👨‍⚖️": "male-judge", "👩‍⚖️": "female-judge",
    "🧑‍🎤": "singer", "👨‍🎤": "male-singer", "👩‍🎤": "female-singer",
    "🦸": "superhero", "🦸‍♂️": "male_superhero", "🦸‍♀️": "female_superhero",
    "🥷": "ninja", "👷": "construction_worker", "🧝": "elf", "🧚": "fairy", "🧛": "vampire",
    "🧑": "adult", "👨": "man", "👩": "woman", "🧔": "bearded_person", "👦": "boy", "👧": "girl",
    "🐱": "cat", "🐶": "dog", "🦊": "fox_face", "🦉": "owl", "🐼": "panda_face", "🦁": "lion_face", "🐯": "tiger",
    "🐻": "bear", "🐸": "frog", "🐙": "octopus", "🦄": "unicorn_face", "🐝": "bee", "🐢": "turtle",
    "🧠": "brain", "🔍": "mag", "🛠️": "hammer_and_wrench", "📅": "date", "📝": "memo", "💡": "bulb", "🚀": "rocket",
    "⭐": "star", "🔥": "fire", "🎨": "art", "🧪": "test_tube", "📊": "bar_chart", "💼": "briefcase", "🎯": "dart",
    "🧩": "jigsaw", "👻": "ghost", "👽": "alien", "😎": "sunglasses", "🤓": "nerd_face", "🙂": "slightly_smiling_face",
};
const SLACK_EMOJI = new Map(Object.entries(AVATAR_NAMES).map(([emoji, name]) => [bare(emoji), name]));

/** The Slack emoji name for an avatar, when there's one. */
export const slackEmoji = (avatar: string) => SLACK_EMOJI.get(bare(avatar.trim()));

/** The emoji behind Slack's names for the reactions people use most (and the avatars above). */
const REACTION_EMOJI = new Map<string, string>([
  ...Object.entries(AVATAR_NAMES).map(([emoji, name]) => [name, emoji] as [string, string]),
  ...Object.entries({
    "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", ok_hand: "👌", clap: "👏", raised_hands: "🙌", pray: "🙏",
    muscle: "💪", wave: "👋", point_up: "☝️", point_up_2: "👆", point_down: "👇", point_left: "👈", point_right: "👉",
    crossed_fingers: "🤞", hand_with_index_and_middle_fingers_crossed: "🤞", v: "✌️", handshake: "🤝", open_hands: "👐",
    raised_hand: "✋", hand: "✋", writing_hand: "✍️", eyes: "👀", brain: "🧠",
    heart: "❤️", orange_heart: "🧡", yellow_heart: "💛", green_heart: "💚", blue_heart: "💙", purple_heart: "💜",
    black_heart: "🖤", white_heart: "🤍", broken_heart: "💔", two_hearts: "💕", sparkling_heart: "💖", heart_eyes: "😍",
    smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", satisfied: "😆", joy: "😂", rolling_on_the_floor_laughing: "🤣",
    sweat_smile: "😅", blush: "😊", wink: "😉", upside_down_face: "🙃", relieved: "😌", innocent: "😇", star_struck: "🤩",
    "star-struck": "🤩", partying_face: "🥳", hugging_face: "🤗", thinking_face: "🤔", face_with_monocle: "🧐",
    face_with_raised_eyebrow: "🤨", raised_eyebrow: "🤨", neutral_face: "😐", expressionless: "😑", no_mouth: "😶",
    face_with_rolling_eyes: "🙄", smirk: "😏", grimacing: "😬", confused: "😕", worried: "😟", slightly_frowning_face: "🙁",
    disappointed: "😞", pensive: "😔", cry: "😢", sob: "😭", scream: "😱", fearful: "😨", cold_sweat: "😰", sweat: "😓",
    flushed: "😳", exploding_head: "🤯", rage: "😡", angry: "😠", triumph: "😤", sleeping: "😴", sleepy: "😪", mask: "😷",
    zipper_mouth_face: "🤐", shushing_face: "🤫", face_palm: "🤦", facepalm: "🤦", shrug: "🤷", skull: "💀", poop: "💩",
    hankey: "💩", clown_face: "🤡", see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊",
    "100": "💯", sparkles: "✨", star2: "🌟", dizzy: "💫", zap: "⚡", boom: "💥", collision: "💥", tada: "🎉",
    confetti_ball: "🎊", balloon: "🎈", gift: "🎁", trophy: "🏆", sports_medal: "🏅", first_place_medal: "🥇",
    pencil2: "✏️", pencil: "📝", pushpin: "📌", round_pushpin: "📍", paperclip: "📎", link: "🔗", lock: "🔒", unlock: "🔓",
    key: "🔑", wrench: "🔧", hammer: "🔨", gear: "⚙️", bug: "🐛", chart_with_upwards_trend: "📈",
    chart_with_downwards_trend: "📉", calendar: "📆", spiral_calendar_pad: "🗓️", alarm_clock: "⏰", hourglass: "⌛",
    hourglass_flowing_sand: "⏳", stopwatch: "⏱️", white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️",
    x: "❌", heavy_multiplication_x: "✖️", negative_squared_cross_mark: "❎", warning: "⚠️", no_entry: "⛔",
    no_entry_sign: "🚫", octagonal_sign: "🛑", stop_sign: "🛑", exclamation: "❗", heavy_exclamation_mark: "❗",
    question: "❓", grey_question: "❔", grey_exclamation: "❕", bangbang: "‼️", interrobang: "⁉️", heavy_plus_sign: "➕",
    heavy_minus_sign: "➖", arrow_up: "⬆️", arrow_down: "⬇️", arrow_right: "➡️", arrow_left: "⬅️", arrows_counterclockwise: "🔄",
    repeat: "🔁", recycle: "♻️", red_circle: "🔴", large_orange_circle: "🟠", large_yellow_circle: "🟡",
    large_green_circle: "🟢", large_blue_circle: "🔵", large_purple_circle: "🟣", white_circle: "⚪", black_circle: "⚫",
    speech_balloon: "💬", thought_balloon: "💭", email: "📧", envelope: "✉️", inbox_tray: "📥", outbox_tray: "📤",
    package: "📦", coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻", clinking_glasses: "🥂", pizza: "🍕", cake: "🍰",
    birthday: "🎂", cookie: "🍪", popcorn: "🍿", sunny: "☀️", rainbow: "🌈", cloud: "☁️", snowflake: "❄️", umbrella: "☔",
    earth_americas: "🌎", musical_note: "🎵", notes: "🎶", camera: "📷", computer: "💻", keyboard: "⌨️", iphone: "📱",
    moneybag: "💰", dollar: "💵", money_with_wings: "💸", shield: "🛡️", crown: "👑", gem: "💎", rose: "🌹", seedling: "🌱",
    herb: "🌿", four_leaf_clover: "🍀", cactus: "🌵", turtle: "🐢", snail: "🐌", sloth: "🦥", ok: "🆗", new: "🆕", cool: "🆒",
    sos: "🆘", up: "🆙", soon: "🔜", top: "🔝", heavy_dollar_sign: "💲", hammer_and_wrench: "🛠️", date: "📅", memo: "📝",
  }),
]);

/** A reaction's name without its skin tone ("+1::skin-tone-3" → "+1"). */
const bareName = (name: string) => name.replace(/::skin-tone-\d$/, "");

/** The emoji for a Slack reaction name (with its skin tone, for a one-character emoji), or :name: for one it doesn't know (a custom emoji). */
export function emojiOf(name: string): string {
  const base = REACTION_EMOJI.get(bareName(name));
  if (!base) return `:${bareName(name)}:`;
  const tone = name.match(/::skin-tone-([2-6])$/);
  const single = base.replace(/\uFE0F/g, "");
  return tone && [...single].length === 1 ? single + String.fromCodePoint(0x1f3fb + Number(tone[1]) - 2) : base;
}

// ---------- The tokens: the Keychain on the Mac, a private file elsewhere ----------

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
const onMac = process.platform === "darwin";

async function saveTokens(teamId: string, bot: string, app: string): Promise<string | undefined> {
  if (!onMac) {
    writeFileSync(SECRETS_FILE, JSON.stringify({ teamId, bot, app }), { mode: 0o600 });
    return;
  }
  for (const [kind, token] of [["bot", bot], ["app", app]]) {
    const r = await keychain(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`, "-w", token]);
    if (r.code !== 0) return `Couldn't save the Slack tokens in the Keychain: ${clip(r.err)}`;
  }
}

async function readTokens(teamId: string): Promise<{ bot: string; app: string } | undefined> {
  if (!onMac) {
    const s = readJson<{ teamId?: string; bot?: string; app?: string }>(SECRETS_FILE, {});
    return s.teamId === teamId && s.bot && s.app ? { bot: s.bot, app: s.app } : undefined;
  }
  const [bot, app] = await Promise.all(["bot", "app"].map((kind) => keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`, "-w"])));
  return bot.code === 0 && app.code === 0 && bot.out && app.out ? { bot: bot.out, app: app.out } : undefined;
}

async function deleteTokens(teamId: string) {
  if (!onMac) {
    writeFileSync(SECRETS_FILE, "{}", { mode: 0o600 });
    return;
  }
  for (const kind of ["bot", "app"]) await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`]);
}

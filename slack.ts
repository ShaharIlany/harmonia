// Slack. One Slack app, "Harmonia", is the bridge: the teammates talk through it, each under its own name and emoji
// (chat:write.customize), and the channel's Mozart decides who answers, as it does in the app.
//
// Your DM with the app mirrors the channel #slack here. A Slack channel (public or private) or group DM the app is in
// is linked to a Harmonia channel the first time you write there. What you write lands in the linked channel as
// your message; other people's messages land too, as context, but never wake a teammate: the teammates work for you
// and can read your mail. What happens in the channel goes back to Slack: the teammates' answers, job starts, errors,
// anything waiting for your OK, and what you type in the app. While a teammate works on your Slack message, it
// carries 👀. Answers are new messages in the channel, not thread replies.
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
import { channels, createChannel, type Channel, type Message } from "./store";
import type { Event } from "./team";
import { SlackError, SlackSocket, isAuthError, slackCall, type Envelope, type SocketState } from "./slack-socket";

const FILE = join(DATA, "slack.json");
const KEYCHAIN_SERVICE = "Harmonia Slack";
/** Off the Mac there's no Keychain (a run from the repo on Linux): the tokens go here, readable only by you. */
const SECRETS_FILE = join(DATA, "slack-secrets.json");
const SEND_RETRIES = [2_000, 5_000, 15_000];
const WORKING = "eyes"; // the reaction on your Slack message while a teammate works on it
const MARKDOWN_BLOCK_MAX = 12_000; // Slack's limit for a markdown block
const TEXT_MAX = 39_000; // chat.postMessage truncates text past 40,000 characters
const PAIR_TRIES = 5; // wrong pairing codes one Slack user may send before the app stops listening to them

/** The app's name in Slack. The commands are written to it: `@Harmonia new channel …`. */
export const APP_NAME = "Harmonia";
const APP_LOOK = { name: APP_NAME, avatar: "🎼" };

/**
 * What the app may do, as bot scopes: read and write in the conversations it's in, post under the teammates' names,
 * create channels and invite you to them, react (👀), and look up people by id or email.
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
  "reactions:write",
  "users:read",
  "users:read.email",
];
export const BOT_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim", "member_joined_channel"];

/** The Slack app manifest: Socket Mode on, a bot you can DM, and the scopes and events above. */
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
      interactivity: { is_enabled: false },
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
  enabled: boolean;
  createdAt: number;
};

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
  createLink: string;
};

export type LinkView = { conversationId: string; kind: Link["kind"]; channelId: string; name?: string; url?: string };

export type SlackEvent = { type: "slack"; slack: SlackView; links: LinkView[] };

type Look = { name: string; avatar: string };

type Deps = {
  emit: (e: SlackEvent) => void;
  /** Posts as you in a channel, exactly like typing it there (from Slack). */
  post: (ch: Channel, text: string) => void;
  /** Someone else's message in a linked Slack conversation: context only. */
  guest: (ch: Channel, name: string, text: string, slackId?: string) => void;
  /** A note in a channel (from Slack, so it isn't sent back there). */
  note: (ch: Channel, text: string) => void;
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
  private sending: Promise<void> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve(); // Slack messages are taken in one at a time, in order
  private rev = 0;

  constructor(private deps: Deps) {
    const saved = readJson<{ config?: Config; links?: Record<string, Link> }>(FILE, {});
    this.config = saved.config;
    this.links = saved.links ?? {};
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
    writeFileSync(FILE, JSON.stringify({ config: this.config, links: this.links }, null, 1), { mode: 0o600 });
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
      auth = await slackCall(botToken, "auth.test");
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
      enabled: true,
      createdAt: same ? was!.createdAt : Date.now(),
    };
    this.save();
    await this.connect();
    this.deps.log("slack.app_connected", { team: auth.team_id, app: bot.app_id });
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
  }

  private api(method: string, params: Record<string, unknown> = {}) {
    if (!this.botToken) return Promise.reject(new SlackError("not_connected", "Slack isn't connected"));
    return slackCall(this.botToken, method, params);
  }

  // ---------- Slack → Harmonia ----------

  private async onEnvelope(env: Envelope) {
    if (env.type !== "events_api") return;
    const ev = env.payload?.event;
    if (ev?.type === "member_joined_channel") return this.joined(ev);
    if (ev?.type !== "message") return;
    // One at a time: two quick messages in a new conversation link it once, and land in the order they were sent.
    const next = this.inbound.then(() => this.message(ev));
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
    if (!text) return yours ? this.say(ev.channel, "I can only read text for now.") : undefined;
    if (!yours) return this.deps.guest(ch, await this.nameOf(ev.user), text, ev.user);
    if (ch.status === "archived") return this.say(ev.channel, `#${ch.name} is archived in Harmonia. Unarchive it there and write again.`);
    this.lastIn.set(ch.id, ev.ts);
    this.deps.post(ch, text);
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
    this.postAs(
      undefined,
      link.conversationId,
      `This channel is **#${ch.name}** in Harmonia. Write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.${cmd.private ? " Only the people in it see it." : ""}`,
    );
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
    if (!link) return;
    if (e.type === "activity") return this.activity(link, e.agentId, e.status);
    if (e.type === "update") return this.reactions(link, e.message);
    if (e.type !== "message") return;
    const m = e.message;
    if (m.meta?.via === "slack" || m.author === "guest") return;
    if (m.author === "user") {
      this.lastIn.delete(link.channelId); // you're writing in the app now: 👀 goes on nothing in Slack
      return this.postAs({ name: `${USER_NAME} (in Harmonia)`, avatar: "👤" }, link.conversationId, m.text);
    }
    if (m.author === "system") return this.postAs(undefined, link.conversationId, `_${m.text}_`);
    const t = teammate(m.author);
    const text = t && relayText(m);
    if (t && text) this.postAs(t, link.conversationId, text);
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
      this.postAs(t, link.conversationId, x.emoji);
    }
  }

  /**
   * A message in Slack under a teammate's name and emoji (chat:write.customize), or as the app itself (`look`
   * undefined). The teammates write Markdown: it goes in a markdown block, with a mrkdwn copy as the notification text.
   */
  private postAs(look: Look | undefined, channel: string, markdown: string) {
    const icon = look && slackEmoji(look.avatar);
    const params: Record<string, unknown> = {
      channel,
      text: mrkdwn(markdown).slice(0, TEXT_MAX),
      unfurl_links: false,
      unfurl_media: false,
      ...(look && { username: icon ? look.name : `${look.avatar} ${look.name}`.trim(), ...(icon && { icon_emoji: `:${icon}:` }) }),
      ...(markdown.length <= MARKDOWN_BLOCK_MAX && { blocks: [{ type: "markdown", text: markdown }] }),
    };
    return this.queue(async () => {
      try {
        await this.api("chat.postMessage", params);
      } catch (e) {
        // A workspace or client that won't take the markdown block gets the mrkdwn text alone.
        if (!(e instanceof SlackError && e.code === "invalid_blocks" && params.blocks)) throw e;
        delete params.blocks;
        await this.api("chat.postMessage", params);
      }
    }, channel);
  }

  /** The app's own words, in Slack's mrkdwn. */
  private say(channel: string, text: string) {
    return this.queue(() => this.api("chat.postMessage", { channel, text, unfurl_links: false }), channel);
  }

  /** One call at a time, so messages arrive in order; a failed one is retried a few times unless Slack said no for good. */
  private queue(fn: () => Promise<unknown>, where: string): Promise<void> {
    this.sending = this.sending.then(async () => {
      for (let i = 0; ; i++) {
        try {
          await fn();
          return;
        } catch (err: any) {
          if (i >= SEND_RETRIES.length || !retryable(err)) return this.deps.log("slack.send_failed", { channel: where, error: err?.message });
          await Bun.sleep(SEND_RETRIES[i]);
        }
      }
    });
    return this.sending;
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

/** What a Harmonia message says in Slack (under its teammate's name), or undefined when it stays in the app. */
export function relayText(m: Message): string | undefined {
  if (m.author === "user" || m.author === "guest") return undefined;
  if (m.author === "system") return `_${m.text}_`;
  const name = nameOf(m.author);
  switch (m.kind ?? "text") {
    case "text":
      return m.text.trim() ? m.text : undefined;
    case "job":
      return `🛠️ ${name} ${m.text}`;
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
const SLACK_EMOJI = new Map(
  Object.entries({
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
  }).map(([emoji, name]) => [bare(emoji), name]),
);

/** The Slack emoji name for an avatar, when there's one. */
export const slackEmoji = (avatar: string) => SLACK_EMOJI.get(bare(avatar.trim()));

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

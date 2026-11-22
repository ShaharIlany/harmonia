// Slack. One Slack app, "Harmonia", is the bridge: the teammates talk through it, each under its own name and emoji
// (chat:write.customize), and the channel's Mozart decides who answers, as it does in the app.
//
// Your DM with the app mirrors the channel #slack here. A Slack channel (public or private) or group DM the app is in
// is linked to a Harmonia channel the first time you write there. What you write lands in the linked channel as
// your message; other people's messages land too, as context, but never wake a teammate: the teammates work for you
// and can read your mail. What happens in the channel goes back to Slack: the teammates' answers, job starts, errors,
// and what you type in the app. While a teammate works on your Slack message, a "typing…" message from it says so,
// deleted once its answer is out (the answer is a new message, so Slack notifies you of it).
//
// Every message is kept with its Slack ts (meta.slack), so Slack's own gestures work: a thread reply is a reply to that
// message here (it wakes that teammate), and the answers follow you into the thread; your reaction on a message is
// your reaction here; ⚠️ on a teammate's message gets you a DM asking how it could be better, and your answer (a
// thread reply, or the box behind its button) is feedback, as ✎ gives it in the app. A teammate's request for a tool
// (a connector) or a permission comes with buttons, and the card says what you decided, here or there.
//
// Files go both ways. One attached to a Slack message (yours, or someone else's in a linked channel) is fetched
// (files:read) into the channel's attachments here, so the teammates can open it. One you attach in the app goes to
// Slack (files:write) in a message from the app, with your words as its comment and your name at the top: Slack posts
// a file message itself, so it can't carry your name and picture the way chat:write.customize does.
//
// `@Harmonia new channel <name>` (or `new private channel <name>`) creates a Slack channel with you and anyone you
// @mention in it (conversations.create and conversations.invite: no admin needed) and a linked channel here.
// `@Harmonia status <status>` sets the linked channel's status, and `@Harmonia archive` archives it.
//
// Every channel you have going here has a Slack channel. One you make in the app gets a private Slack channel with you
// and the teammates' bots in it. One you archive leaves Slack: a Slack channel Harmonia made is archived there too
// (Slack doesn't let apps delete channels), and Harmonia leaves one you brought it into, since other people may use it.
// Unarchive it and it gets a new private Slack channel. Your DM with the app and group DMs can't go, so they stay linked.
//
// The app is made from a manifest (CREATE_LINK) and connects over Socket Mode (slack-socket.ts): nothing listens on the
// internet. The Slack user who sends the app the pairing code from the Slack page is the only one who wakes the
// teammates.
//
// Teammates as Slack members: each teammate can have its own small Slack app (a bot that only posts), so it's a real
// member you can @mention in Slack. Harmonia makes them with an app configuration token you generate once
// (apps.manifest.create, apps.icon.set: the token isn't kept); you install each one and paste its bot token. In a
// linked channel, Harmonia invites them and their answers go out from their own bot. Everything still comes in through
// the Harmonia app (an @mention of Emily is "@Emily" to the teammates). Cards with buttons, your DM with Harmonia and
// group DMs stay with Harmonia, posting under the teammate's name.
//
// Kept in the data folder: slack.json (the workspace, the app, who it works for, the linked conversations, the
// teammates' apps). The bot tokens and the app-level token are in the Keychain.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DEFAULT_CWD } from "./paths";
import { ROSTER, USER_NAME, nameOf, teammate, type Teammate } from "./roster";
import { channels, createChannel, messages, saveMessages, type Channel, type ChannelStatus, type Message, type SlackRef } from "./store";
import type { Event } from "./team";
import { SLACK_API, SlackError, SlackSocket, isAuthError, slackAuth, slackCall, slackUpload, type Envelope, type SocketState } from "./slack-socket";
import { MAX_FILE, MAX_FILES, attachmentPath, fileSize, saveAttachment, type Attachment } from "./attachments";

const FILE = join(DATA, "slack.json");
const KEYCHAIN_SERVICE = "Harmonia Slack";
/** Off the Mac there's no Keychain (a run from the repo on Linux): the tokens go here, readable only by you. */
const SECRETS_FILE = join(DATA, "slack-secrets.json");
const SEND_RETRIES = [2_000, 5_000, 15_000];
const TYPING = "_typing…_"; // a teammate's message in Slack while it works on an answer: deleted once the answer is out
const TYPING_AFTER = 1_500; // ms of work before it goes out, so a quick answer (or the next bubble) comes without one
const QUEUED = /^busy in /; // the activity of a teammate still busy in another channel: it isn't typing here yet
const MARKDOWN_BLOCK_MAX = 12_000; // Slack's limit for a markdown block
const TEXT_MAX = 39_000; // chat.postMessage truncates text past 40,000 characters
const PAIR_TRIES = 5; // wrong pairing codes one Slack user may send before the app stops listening to them
const FEEDBACK = "warning"; // ⚠️: your reaction that asks for feedback on a teammate's message
const FEEDBACK_VIEW = "harmonia:feedback"; // the feedback box (a modal)
const ASKS_KEPT = 50; // feedback questions whose thread replies still count as feedback
const FILE_TIMEOUT = 5 * 60_000; // one file's download from Slack, or upload to it
const NAME_TRIES = 20; // #name, #name-2 … #name-20: a Slack channel name for a channel made or unarchived in the app

/** The app's name in Slack. The commands are written to it: `@Harmonia new channel …`. */
export const APP_NAME = "Harmonia";
const USER_LOOK = { name: `${USER_NAME} (in Harmonia)`, avatar: "👤" };

/**
 * What the app may do, as bot scopes: read and write in the conversations it's in, post under the teammates' names,
 * create channels and invite you to them, read your reactions, look up people by id or email, and fetch and send files.
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
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

/** A teammate's own app only posts (under its name and avatar): the Harmonia app hears everything. */
export const MATE_SCOPES = ["chat:write", "chat:write.customize"];

/** The manifest of a teammate's own Slack app: a bot named after it, nothing to DM, no events. */
export function mateManifest(t: Pick<Teammate, "name" | "role" | "color">, socketMode = false) {
  return {
    display_information: {
      name: t.name.slice(0, 35),
      description: `${t.role || "Teammate"}, answering from ${APP_NAME}`.slice(0, 140),
      background_color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#24292f",
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: false, messages_tab_read_only_enabled: false },
      bot_user: { display_name: t.name, always_online: true },
    },
    oauth_config: { scopes: { bot: MATE_SCOPES } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: socketMode, token_rotation_enabled: false },
  };
}

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
  teammates?: Record<string, MateApp>; // teammate id → its own Slack app
};

/** A teammate's own Slack app. Its bot token is in the Keychain once you've installed it and pasted it. */
type MateApp = {
  appId: string;
  name: string; // the name it was made (or last updated) with
  botUserId?: string; // set once connected: its messages are skipped, @mentions of it are "@Name"
  botId?: string;
  iconError?: string; // its icon didn't go up
  createdAt: number;
};

/** A teammate on the Slack page: has it a Slack app of its own, and is it connected? */
export type MateView = {
  id: string;
  name: string;
  avatar: string;
  color: string;
  state: "none" | "created" | "connected" | "failed";
  detail?: string;
  appLink?: string;
  installLink?: string;
  slackName?: string; // the app's name in Slack, when the teammate was renamed since
  gone?: boolean; // no longer on the team
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
  teammates: MateView[];
  making: boolean; // the teammates' apps are being made
};

export type LinkView = { conversationId: string; kind: Link["kind"]; channelId: string; name?: string; url?: string };

export type SlackEvent = { type: "slack"; slack: SlackView; links: LinkView[] };

type Look = { id?: string; name: string; avatar: string };
/** A teammate's "typing…" message: waiting to go out (`timer`), or out (`ts`). `by`: the teammate whose own bot posted it. */
type Typing = { channel: string; ts?: string; by?: string; timer?: ReturnType<typeof setTimeout> };
/** What a Slack message says: the teammates' Markdown, or the app's own mrkdwn text with blocks (cards, buttons). */
type Content = { markdown: string } | { text: string; blocks: unknown[] };

type Deps = {
  emit: (e: SlackEvent) => void;
  /** Posts as you in a channel, exactly like typing it there (from Slack): maybe a reply to a message there, maybe with files. */
  post: (ch: Channel, text: string, from: { replyTo?: string; slack: SlackRef; files?: Attachment[] }) => Message;
  /** Someone else's message in a linked Slack conversation: context only. */
  guest: (ch: Channel, name: string, text: string, slackId: string | undefined, slack: SlackRef, files?: Attachment[]) => void;
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
  /** View in Claude on a job's start: opens its session in the Claude app. An error to show, if it couldn't. */
  openSession: (ch: Channel, jobId: string) => Promise<string | undefined>;
  /** Tells the page about a channel the bridge created. */
  channelCreated: (ch: Channel) => void;
  /** Sets a channel's status (`@Harmonia status`, `@Harmonia archive`), as the page does. An error to show, if it can't. */
  setStatus: (ch: Channel, status: ChannelStatus | undefined) => string | undefined;
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
  private inSlack = new Set<string>(); // Harmonia channels where you last wrote from Slack (not the app)
  private typing = new Map<string, Typing>(); // "channel id:teammate id" → the teammate's typing message there
  private typed: Set<Typing>; // typing messages out in Slack and not deleted yet, kept in slack.json for after a restart
  private reacted = new Set<string>();
  private threads = new Map<string, string>(); // Harmonia channel id → the Slack thread the conversation is in now
  private cardsDone = new Set<string>(); // cards whose Slack message already says what was decided
  private asks: Record<string, Ask>; // ts of a ⚠️ question in your DM → the message it's about
  private sending: Promise<void> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve(); // Slack messages are taken in one at a time, in order
  private rev = 0;
  private mateTokens = new Map<string, string>(); // teammate id → its own app's bot token
  private mateIn = new Set<string>(); // "teammate id:conversation": its bot is in that channel
  private mateProblems = new Map<string, string>(); // teammate id → why its app can't post now
  private making = false; // the teammates' apps are being made
  private channelWork: Promise<unknown> = Promise.resolve(); // Slack channels made and archived for Harmonia's, in order

  constructor(private deps: Deps) {
    const saved = readJson<{ config?: Config; links?: Record<string, Link>; asks?: Record<string, Ask>; typing?: Typing[] }>(FILE, {});
    this.config = saved.config;
    this.links = saved.links ?? {};
    this.asks = saved.asks ?? {};
    this.typed = new Set(saved.typing ?? []);
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
      teammates: c ? this.mateViews() : [],
      making: this.making,
    };
  }

  /** Every teammate (and any app left over from one no longer on the team), and where its own Slack app is at. */
  private mateViews(): MateView[] {
    const apps = this.config?.teammates ?? {};
    const ids = [...ROSTER.map((t) => t.id), ...Object.keys(apps).filter((id) => !teammate(id))];
    return ids.map((id) => {
      const t = teammate(id);
      const a = apps[id];
      const problem = a && this.mateProblems.get(id);
      return {
        id,
        name: t?.name ?? a?.name ?? id,
        avatar: t?.avatar ?? "👤",
        color: t?.color ?? "#6b7280",
        state: !a ? "none" : problem ? "failed" : a.botUserId ? "connected" : "created",
        detail: problem ?? a?.iconError,
        appLink: a && `https://api.slack.com/apps/${a.appId}`,
        installLink: a && `https://api.slack.com/apps/${a.appId}/install-on-team`,
        slackName: a && t && a.name !== t.name ? a.name : undefined,
        gone: !t || undefined,
      };
    });
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
    const typing = [...this.typed].map(({ channel, ts, by }) => ({ channel, ts, by }));
    writeFileSync(FILE, JSON.stringify({ config: this.config, links: this.links, asks: this.asks, ...(typing.length > 0 && { typing }) }, null, 1), { mode: 0o600 });
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
      await deleteTokens(was.teamId, Object.keys(was.teammates ?? {}));
      this.links = {}; // another workspace's conversations mean nothing here
      this.mateTokens.clear();
      this.mateIn.clear();
      this.mateProblems.clear();
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
      teammates: same ? was?.teammates : undefined,
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
    await deleteTokens(this.config.teamId, Object.keys(this.config.teammates ?? {}));
    this.botToken = "";
    this.config = undefined;
    this.links = {};
    this.mateTokens.clear();
    this.mateIn.clear();
    this.mateProblems.clear();
    this.save();
    this.changed();
  }

  // ---------- Teammates as Slack members: an app of their own ----------

  /**
   * Makes a Slack app for every teammate that hasn't one, and brings the others' names, roles and icons up to date,
   * with an app configuration token (api.slack.com/apps → Your App Configuration Tokens). The token isn't kept.
   * `icons`: teammate id → a 512 px PNG of its avatar (base64), drawn by the page.
   */
  async makeMateApps(token: string, icons: Record<string, string> = {}): Promise<string | undefined> {
    const c = this.config;
    if (!c) return "Slack isn't set up.";
    token = token.trim();
    if (/^xoxe-\d/.test(token)) return "That's the refresh token. Copy the access token above it (it starts with xoxe.xoxp-).";
    if (!token.startsWith("xoxe.xoxp-")) return "The configuration token starts with xoxe.xoxp-. Generate one at the top of api.slack.com/apps, under Your App Configuration Tokens.";
    if (this.making) return "Harmonia is already making them.";
    this.making = true;
    this.changed();
    const apps = (c.teammates ??= {});
    const failed: string[] = [];
    try {
      for (const t of ROSTER) {
        let app: MateApp | undefined = apps[t.id];
        try {
          if (app) {
            try {
              await slackCall(token, "apps.manifest.update", { app_id: app.appId, manifest: mateManifest(t) });
            } catch (e) {
              // Gone from Slack, most likely. Left to you: Forget makes room for a new one.
              if (e instanceof SlackError && ["invalid_app_id", "invalid_app", "app_not_found"].includes(e.code))
                throw new SlackError(e.code, `Slack doesn't know its app (${e.code}). If you deleted it there, Forget it here and make it again`);
              throw e;
            }
          } else {
            const made = await createMateApp(token, t);
            app = apps[t.id] = { appId: String(made.app_id), name: t.name, createdAt: Date.now() };
            this.deps.log("slack.teammate_app_made", { teammate: t.id, app: app.appId });
          }
          app.name = t.name;
        } catch (e: any) {
          const stop = configTokenProblem(e);
          if (stop) return stop;
          failed.push(`${t.name} (${e.message})`);
          continue;
        } finally {
          this.save();
          this.changed();
        }
        const png = icons[t.id];
        if (!png) continue;
        try {
          await slackUpload(token, "apps.icon.set", { app_id: app.appId }, { name: `${t.id}.png`, type: "image/png", data: new Uint8Array(Buffer.from(png, "base64")) });
          delete app.iconError;
        } catch (e: any) {
          app.iconError = `Its icon didn't go up (${e.code ?? e.message}): add it in the app's settings, under Basic Information → Display Information.`;
        }
        this.save();
        this.changed();
      }
    } finally {
      this.making = false;
      this.save();
      this.changed();
    }
    if (failed.length) return `Couldn't make every app: ${failed.join("; ")}`;
  }

  /** Checks a teammate's bot token (its own app's, installed), keeps it in the Keychain, and invites it to the linked channels. */
  async connectMate(id: string, token: string): Promise<string | undefined> {
    const c = this.config;
    const app = c?.teammates?.[id];
    const t = teammate(id);
    if (!c || !app || !t) return "Make its Slack app first.";
    token = token.trim();
    if (!token.startsWith("xoxb-")) return `Paste ${t.name}'s Bot User OAuth Token (xoxb-…). It's on its app's Install App page, once it's installed.`;
    let auth: any;
    try {
      auth = await slackAuth(token);
    } catch (e: any) {
      return `Slack didn't accept the token: ${e.message}`;
    }
    if (auth.team_id !== c.teamId) return `That token is for another workspace${auth.team ? ` (${auth.team})` : ""}. Install ${t.name} in ${c.teamName ?? "the workspace Harmonia is in"}.`;
    if (auth.user_id === c.botUserId) return `That's ${APP_NAME}'s own token. Copy the one on ${t.name}'s app's page.`;
    const other = Object.entries(c.teammates!).find(([k, a]) => k !== id && a.botUserId === auth.user_id);
    if (other) return `That's ${nameOf(other[0])}'s token. Copy the one on ${t.name}'s app's page.`;
    const bot = auth.bot_id ? await this.api("bots.info", { bot: auth.bot_id }).then((j) => j.bot ?? {}, () => ({})) : {};
    if (bot.app_id && bot.app_id !== app.appId) return `That token is another app's. Copy the one on ${t.name}'s app's page.`;
    if (auth.scopes && !auth.scopes.includes("chat:write")) return `That token can't post (no chat:write). Copy the Bot User OAuth Token on ${t.name}'s app's page.`;
    const err = await saveMateToken(c.teamId, id, token);
    if (err) return err;
    app.botUserId = String(auth.user_id);
    app.botId = auth.bot_id;
    this.mateTokens.set(id, token);
    this.mateProblems.delete(id);
    for (const key of this.mateIn) if (key.startsWith(`${id}:`)) this.mateIn.delete(key);
    this.save();
    this.changed();
    this.deps.log("slack.teammate_connected", { teammate: id, app: app.appId });
    void this.inviteMates(this.channelLinks(), [id]);
  }

  /** Forgets a teammate's own app here (its token leaves the Keychain). The app stays in Slack until you delete it there. */
  async forgetMate(id: string): Promise<string | undefined> {
    if (!this.config?.teammates?.[id]) return "It has no Slack app here.";
    await this.dropMate(id);
    this.save();
    this.changed();
  }

  private async dropMate(id: string) {
    const c = this.config!;
    await deleteMateToken(c.teamId, id);
    delete c.teammates?.[id];
    this.mateTokens.delete(id);
    this.mateProblems.delete(id);
    for (const key of this.mateIn) if (key.startsWith(`${id}:`)) this.mateIn.delete(key);
  }

  /** The linked channels (public and private): where the teammates' own bots can be. */
  private channelLinks(): string[] {
    return Object.values(this.links)
      .filter((l) => l.kind === "channel" || l.kind === "private")
      .map((l) => l.conversationId);
  }

  /** Invites the teammates' bots (all connected ones, or `ids`) to channels Harmonia is in. */
  private async inviteMates(conversations: string[], ids = [...this.mateTokens.keys()]) {
    for (const conversation of conversations) for (const id of ids) await this.mateJoin(id, conversation);
  }

  /** Makes sure a teammate's bot is in a channel (Harmonia invites it). False when it can't be. */
  private async mateJoin(id: string, conversation: string): Promise<boolean> {
    const user = this.config?.teammates?.[id]?.botUserId;
    if (!user) return false;
    const key = `${id}:${conversation}`;
    if (this.mateIn.has(key)) return true;
    try {
      await this.api("conversations.invite", { channel: conversation, users: user });
    } catch (e: any) {
      if (!(e instanceof SlackError && e.code === "already_in_channel")) {
        this.deps.log("slack.teammate_invite_failed", { teammate: id, conversation, error: e?.message });
        return false;
      }
    }
    this.mateIn.add(key);
    return true;
  }

  /** The token a teammate's answer goes out with in a conversation: its own bot's, in a channel it's (now) in. */
  private async mateToken(id: string | undefined, conversation: string): Promise<string | undefined> {
    const token = id && this.mateTokens.get(id);
    const kind = this.links[conversation]?.kind;
    if (!token || (kind !== "channel" && kind !== "private")) return undefined;
    return (await this.mateJoin(id, conversation)) ? token : undefined;
  }

  /** A teammate's bot couldn't post: Harmonia posts for it this time. A token Slack won't take any more needs you. */
  private mateFailed(id: string, conversation: string, e: any): undefined {
    this.deps.log("slack.teammate_post_failed", { teammate: id, conversation, error: e?.message });
    if (e instanceof SlackError && ["not_in_channel", "channel_not_found"].includes(e.code)) this.mateIn.delete(`${id}:${conversation}`);
    if (isAuthError(e)) {
      this.mateTokens.delete(id);
      this.mateProblems.set(id, `Slack doesn't take its token any more (${e.code}): was it uninstalled? Install it again and paste the new token.`);
      this.changed();
    }
    return undefined;
  }

  /** The teammate whose own bot is this Slack user, by name. */
  private mateName(userId: string): string | undefined {
    const hit = Object.entries(this.config?.teammates ?? {}).find(([, a]) => a.botUserId === userId);
    return hit && nameOf(hit[0]);
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
    for (const key of this.typing.keys()) if (key.startsWith(`${l.channelId}:`)) this.untype(key);
    this.working.delete(l.channelId);
    this.inSlack.delete(l.channelId);
    this.threads.delete(l.channelId);
    for (const key of this.mateIn) if (key.endsWith(`:${conversationId}`)) this.mateIn.delete(key);
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
    this.mateTokens.clear();
    for (const [id, a] of Object.entries(c.teammates ?? {})) {
      if (!a.botUserId) continue;
      const token = await readMateToken(c.teamId, id);
      if (token) this.mateTokens.set(id, token);
      else this.mateProblems.set(id, "Its token is missing from the Keychain. Paste it again (its app's Install App page).");
    }
    // Typing messages an earlier run left in Slack: it stopped before the answers came.
    const live = new Set(this.typing.values());
    for (const t of this.typed) if (!live.has(t)) void this.queue(() => this.deleteTyping(t), t.channel);
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
      // In your DM, "status of the build?" is a question for the teammates, not a status nobody knows.
      if (cmd && !(dm && cmd.kind === "status" && cmd.asked && cmd.status === undefined)) return this.command(ev, raw, cmd, thread);
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
    if (yours && ch.status === "archived")
      return this.say(ev.channel, `#${ch.name} is archived in Harmonia. Unarchive it there (or *${dm ? "" : `@${APP_NAME} `}status in progress* here) and write again.`, thread);
    const got = await this.fetchFiles(ch, Array.isArray(ev.files) ? ev.files : []);
    let text = await this.chatText(raw);
    if (got.missed.length) text = [text, `(attached in Slack, not fetched: ${got.missed.join("; ")})`].filter(Boolean).join("\n");
    if (!text && !got.files.length) return yours ? this.say(ev.channel, "I can only read text and files for now.", thread) : undefined;
    if (yours && got.noScope)
      this.say(ev.channel, `I couldn't fetch your file${got.missed.length > 1 ? "s" : ""} for the teammates: the ${APP_NAME} app needs the files:read scope. Harmonia's Slack page shows how to update it.`, thread);
    const ref: SlackRef = { channel: ev.channel, ts: String(ev.ts), ...(thread && { thread }) };
    if (!yours) return this.deps.guest(ch, await this.nameOf(ev.user), text, ev.user, ref, got.files);
    // The answers go where you wrote: into the thread, or the channel itself.
    if (thread) this.threads.set(ch.id, thread);
    else this.threads.delete(ch.id);
    this.inSlack.add(ch.id);
    this.deps.post(ch, text, { replyTo: thread ? this.bySlack(ch.id, ev.channel, thread)?.id : undefined, slack: ref, files: got.files });
  }

  /**
   * The files on a Slack message, copied into the channel's attachments so the teammates can open them. What couldn't
   * be (a link to Google Drive, a file deleted since, one too big) is named in `missed`, with why. `noScope`: the app
   * was made before it could read files (files:read).
   */
  private async fetchFiles(ch: Channel, list: any[]): Promise<{ files: Attachment[]; missed: string[]; noScope?: boolean }> {
    const files: Attachment[] = [];
    const missed: string[] = [];
    let noScope = false;
    for (let f of list.slice(0, MAX_FILES)) {
      if (!f || typeof f !== "object") continue;
      // Some events carry only the file's id ("check_file_info"): files.info has the rest.
      if (f.id && (f.file_access === "check_file_info" || (!f.url_private && !f.url_private_download && f.mode !== "external"))) {
        try {
          f = (await this.api("files.info", { file: f.id })).file ?? f;
        } catch (e) {
          if (e instanceof SlackError && e.code === "missing_scope") noScope = true;
        }
      }
      const name = String(f.name || f.title || "file");
      const url = f.url_private_download || f.url_private;
      if (f.mode === "external" || f.is_external) missed.push(f.external_url || f.url_private ? `${name} (a link: ${f.external_url || f.url_private})` : name);
      else if (f.mode === "tombstone" || f.mode === "hidden_by_limit") missed.push(`${name} (no longer in Slack)`);
      else if (Number(f.size) > MAX_FILE) missed.push(`${name} (${fileSize(Number(f.size))}, over the ${fileSize(MAX_FILE)} limit)`);
      else if (!url) missed.push(noScope ? `${name} (the Slack app needs files:read)` : name);
      else {
        try {
          files.push({ ...(await this.download(ch.id, String(url), name, f.mimetype)), ...(f.id && { slack: String(f.id) }) });
        } catch (e: any) {
          if (e?.code === "missing_scope") noScope = true;
          missed.push(`${name} (${e?.message ?? e})`);
          this.deps.log("slack.file_fetch_failed", { file: f.id, error: e?.message });
        }
      }
    }
    if (list.length > MAX_FILES) missed.push(`${list.length - MAX_FILES} more file${list.length - MAX_FILES > 1 ? "s" : ""} (up to ${MAX_FILES} on a message)`);
    return { files, missed, noScope };
  }

  /** One file from Slack, with the bot token. Slack's own hosts only: the token goes nowhere else. */
  private async download(channelId: string, url: string, name: string, type?: string): Promise<Attachment> {
    const host = new URL(url).hostname;
    if (!(host === "slack.com" || host.endsWith(".slack.com") || host === new URL(SLACK_API).hostname)) throw new Error(`it's not on Slack (${host})`);
    const r = await fetch(url, { headers: { authorization: `Bearer ${this.botToken}` }, signal: AbortSignal.timeout(FILE_TIMEOUT) });
    // A token without files:read gets HTTP 403 (or Slack's sign-in page instead of the file). Slack is asked again what
    // the token may do, in case the app was updated and reinstalled since the scopes were last checked.
    const signIn = r.ok && /^text\/html/i.test(r.headers.get("content-type") ?? "") && !/html/i.test(type ?? "");
    if (r.status === 401 || r.status === 403 || signIn) {
      await r.body?.cancel().catch(() => {});
      await this.checkScopes();
      const scopes = this.config?.scopes;
      if (scopes && !scopes.includes("files:read")) throw new SlackError("missing_scope", "the Slack app needs files:read");
      throw new Error(signIn ? "Slack sent its sign-in page instead of the file" : `Slack refused it (HTTP ${r.status})`);
    }
    if (!r.ok) throw new Error(`Slack answered HTTP ${r.status}`);
    if (Number(r.headers.get("content-length")) > MAX_FILE) throw new Error(`over the ${fileSize(MAX_FILE)} limit`);
    return saveAttachment(channelId, name, type, r.body);
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
      if (kind === "session") {
        // Opens on the Mac Harmonia runs on, whichever device the button was clicked on. Archived channels too.
        const err = await this.deps.openSession(ch, String(t.j));
        if (err) this.ephemeral(where, user, err);
        this.deps.log("slack.session_opened", { channelId: ch.id, jobId: t.j, error: err });
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
    if (kind === "channel" || kind === "private") void this.inviteMates([link.conversationId]);
    return link;
  }

  /** The message as the teammates read it: Slack's markup as text, people (and teammates' bots) as @Name, the app's own @mention dropped. */
  private async chatText(raw: string): Promise<string> {
    const me = this.config?.botUserId;
    for (const [, id] of raw.matchAll(USER_MENTION)) if (id !== me) await this.nameOf(id);
    return slackToText(raw, (id) => (id === me ? "" : `@${this.mateName(id) ?? this.names.get(id) ?? id}`));
  }

  /** The name a Slack user goes by: their display name, else their full name. A teammate's bot goes by the teammate's name. */
  private async nameOf(id: string): Promise<string> {
    const mate = this.mateName(id);
    if (mate) return mate;
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

  /**
   * Who an @Name can tag in Slack (lowercase name → Slack user id): you (by your Harmonia name and your Slack one), the
   * teammates with a Slack app of their own, and the people seen here. A name two of those people share tags nobody.
   */
  private mentionIds(): Map<string, string> {
    const ids = new Map<string, string>();
    const shared = new Set<string>();
    for (const [id, name] of this.names) {
      const k = name.trim().toLowerCase();
      if (ids.has(k) && ids.get(k) !== id) shared.add(k);
      else if (k && k !== id.toLowerCase()) ids.set(k, id);
    }
    for (const k of shared) ids.delete(k);
    const c = this.config;
    for (const [id, a] of Object.entries(c?.teammates ?? {})) if (a.botUserId && teammate(id)) ids.set(nameOf(id).toLowerCase(), a.botUserId);
    if (c?.ownerId) for (const n of [c.ownerName, USER_NAME]) if (n?.trim()) ids.set(n.trim().toLowerCase(), c.ownerId);
    return ids;
  }

  // ---------- Commands ----------

  private async command(ev: any, raw: string, cmd: Command, thread?: string) {
    const at = ev.channel_type === "im" ? "" : `@${APP_NAME} `;
    if (cmd.kind === "help") {
      return this.say(
        ev.channel,
        [
          `*${APP_NAME}* :musical_score: connects Slack to your teammates in Harmonia. Write as usual and Mozart picks who answers, or start with @Leo to ask Leo.`,
          `• *${at}new channel <name>*: a new channel with you in it, linked to a new Harmonia channel. @mention people to invite them too.`,
          `• *${at}new private channel <name>*: the same, but only the people in it see it.`,
          `• *${at}status <status>*: sets this channel's status in Harmonia: ${STATUS_CHOICES}.`,
          `• *${at}archive*: archives this channel in Harmonia. A Slack channel ${APP_NAME} made is archived too; one you brought me into, I leave.`,
          `• \`/invite @${APP_NAME}\` in any channel: it's linked the first time you write there.`,
          `• *${at}help*: this.`,
        ].join("\n"),
        thread,
      );
    }
    if (cmd.kind === "newChannel") {
      const err = await this.newChannel(ev, raw, cmd);
      if (err) this.say(ev.channel, `Couldn't create it: ${err}`);
      return;
    }
    const link = this.links[ev.channel];
    const ch = link && channels.get(link.channelId);
    if (!ch) return this.say(ev.channel, `This conversation isn't linked to a Harmonia channel yet. Write here first, then try again.`, thread);
    const name = `*#${escapeSlack(ch.name)}*`;
    const status = cmd.kind === "archive" ? "archived" : cmd.status;
    if (status === undefined) {
      const now = ch.status ? `is *${STATUS_LABELS[ch.status]}*` : "has no status";
      const lead = cmd.kind === "status" && cmd.asked ? `I don't know the status "${escapeSlack(cmd.asked)}". ` : "";
      return this.say(ev.channel, `${lead}${name} ${now} in Harmonia. Set it with *${at}status <status>*: ${STATUS_CHOICES}.`, thread);
    }
    if ((ch.status ?? "") === status) return this.say(ev.channel, `${name} ${status ? `is already *${STATUS_LABELS[status]}*` : "has no status already"}.`, thread);
    const err = this.deps.setStatus(ch, status || undefined);
    if (err) return this.say(ev.channel, `Couldn't: ${escapeSlack(err)}`, thread);
    this.deps.log("slack.status_set", { channelId: ch.id, status: status || null });
    // An archived channel's Slack channel says goodbye itself, as it goes. Your DM and group DMs stay.
    if (status === "archived" && (link.kind === "channel" || link.kind === "private")) return;
    if (status === "archived")
      return this.say(ev.channel, `:file_cabinet: ${name} is archived in Harmonia. This ${link.kind === "dm" ? "DM" : "group DM"} stays in Slack: *${at}status in progress* brings it back.`, thread);
    this.say(ev.channel, status ? `:white_check_mark: ${name} is *${STATUS_LABELS[status]}* now.` : `:white_check_mark: ${name} has no status now.`, thread);
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
    // The teammates' own bots come in with the rest of them (inviteMates), not with the people.
    return { ids: [...ids].filter((id) => id !== this.config?.ownerId && !this.mateName(id)), unknown };
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
    const ch = createChannel(name, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const inviteError = await this.adopt(String(made.id), name, ch, cmd.private, people.ids);
    this.deps.note(ch, `Created from Slack: the ${cmd.private ? "private " : ""}channel #${name}, linked to this channel.`);
    if (inviteError) this.deps.note(ch, `Couldn't invite everyone to #${name} in Slack: ${inviteError}`);
    this.say(ev.channel, `Created <#${made.id}>, linked to *#${ch.name}* in Harmonia.${inviteError ? ` I couldn't invite everyone: ${inviteError}` : ""}`);
    this.deps.log("slack.channel_created", { conversation: made.id, channelId: ch.id, private: cmd.private });
  }

  /**
   * A Slack channel Harmonia just made, for `ch`: you (and `people`) invited, linked, the teammates' bots invited, and a
   * welcome (after `lead`, if any). An error, when not everyone could be invited.
   */
  private async adopt(conversation: string, name: string, ch: Channel, isPrivate: boolean, people: string[] = [], lead = ""): Promise<string | undefined> {
    let inviteError: string | undefined;
    try {
      await this.api("conversations.invite", { channel: conversation, users: [this.config!.ownerId, ...people].join(",") });
    } catch (e: any) {
      if (e.code !== "already_in_channel") inviteError = e.message;
    }
    this.links[conversation] = { conversationId: conversation, kind: isPrivate ? "private" : "channel", channelId: ch.id, name, createdAt: Date.now() };
    this.save();
    this.changed();
    this.postAs(undefined, conversation, {
      markdown: `${lead}This channel is **#${ch.name}** in Harmonia. Write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.${isPrivate ? " Only the people in it see it." : ""}`,
    });
    void this.inviteMates([conversation]);
    return inviteError;
  }

  // ---------- Harmonia's channels, in Slack ----------

  /** A channel you made in the app: it gets a private Slack channel, with you and the teammates' bots in it. */
  channelAdded(ch: Channel) {
    this.inOrder(() => this.openFor(ch));
  }

  /** A channel's status changed (in the app, or from Slack): archived, it leaves Slack; unarchived, it gets a new Slack channel. */
  statusChanged(ch: Channel, before: ChannelStatus | undefined) {
    if (before !== "archived" && ch.status === "archived") this.inOrder(() => this.retire(ch));
    else if (before === "archived" && ch.status !== "archived") this.inOrder(() => this.openFor(ch, true));
  }

  /** One channel change at a time: an archive and a quick unarchive land in that order. */
  private inOrder(fn: () => Promise<unknown>) {
    const next = this.channelWork.then(fn).catch((e) => this.deps.log("slack.channel_work_failed", { error: e?.message }));
    this.channelWork = next;
  }

  /**
   * A new private Slack channel for a Harmonia channel that has no Slack conversation: named after it (#name, or
   * #name-2 when that's taken), with you and the teammates' bots in it. Only once the app works for someone: it invites you.
   */
  private async openFor(ch: Channel, unarchived = false) {
    const c = this.config;
    if (!c?.enabled || !this.botToken || !c.ownerId) return;
    if (!channels.has(ch.id) || ch.status === "archived" || Object.values(this.links).some((l) => l.channelId === ch.id)) return;
    const base = slackChannelName(ch.name) || "harmonia";
    let made: any;
    for (let i = 1; !made && i <= NAME_TRIES; i++) {
      const name = i === 1 ? base : `${base.slice(0, 79 - String(i).length)}-${i}`;
      try {
        made = (await this.api("conversations.create", { name, is_private: true })).channel;
      } catch (e: any) {
        if (e instanceof SlackError && e.code === "name_taken") continue;
        this.deps.log("slack.channel_open_failed", { channelId: ch.id, error: e?.message });
        const why = e?.code === "restricted_action" ? "this workspace doesn't let apps create channels" : e?.message;
        return this.deps.note(ch, `Couldn't make a Slack channel for it: ${why}.`);
      }
    }
    if (!made) return this.deps.note(ch, `Couldn't make a Slack channel for it: #${base} and #${base}-2 to #${base}-${NAME_TRIES} are all taken.`);
    const name = String(made.name ?? base);
    const inviteError = await this.adopt(String(made.id), name, ch, true, [], unarchived ? `**#${ch.name}** is back from the archive in Harmonia. ` : "");
    this.deps.note(ch, `${unarchived ? "Unarchived, so it" : "It"} has a private Slack channel now: #${name}${c.teamName ? ` in ${c.teamName}` : ""}.`);
    if (inviteError) this.deps.note(ch, `Couldn't invite you to #${name} in Slack: ${inviteError}`);
    this.deps.log("slack.channel_opened", { conversation: made.id, channelId: ch.id, unarchived });
  }

  /**
   * An archived channel leaves Slack. Slack doesn't let apps delete channels, so a Slack channel Harmonia made is
   * archived (renamed first, so a new one can have its name); one you brought Harmonia into is left, with the teammates'
   * bots, since other people may use it. Either way it's unlinked. Your DM and group DMs can't go: they stay linked.
   */
  private async retire(ch: Channel) {
    const link = Object.values(this.links).find((l) => l.channelId === ch.id && (l.kind === "channel" || l.kind === "private"));
    const c = this.config;
    if (!link || !c?.enabled || !this.botToken || ch.status !== "archived") return;
    const conv = link.conversationId;
    const info = await this.api("conversations.info", { channel: conv }).then(
      (j) => j.channel,
      (e) => (e instanceof SlackError && e.code === "channel_not_found" ? null : undefined),
    );
    if (info === null || info?.is_archived) {
      this.unlink(conv);
      return this.deps.note(ch, `#${link.name ?? "Its Slack channel"} is ${info ? "archived" : "gone"} in Slack already: unlinked. Unarchive it and it gets a new Slack channel.`);
    }
    const ours = info?.creator === c.botUserId;
    await this.say(
      conv,
      ours
        ? `:file_cabinet: *#${escapeSlack(ch.name)}* is archived in Harmonia, so this channel is archived too. Unarchive it in Harmonia and it gets a new channel.`
        : `:file_cabinet: *#${escapeSlack(ch.name)}* is archived in Harmonia, so I'm leaving this channel. Unarchive it in Harmonia and it gets a new private channel.`,
    );
    // Once whatever was still on its way to Slack is there.
    const call = (method: string, params: Record<string, unknown>) =>
      this.queue(() => this.api(method, { channel: conv, ...params }).then(() => "ok" as const, (e) => (retryable(e) ? Promise.reject(e) : (e as SlackError))), conv);
    let gone: string | undefined;
    if (ours) {
      const name = String(info.name ?? link.name ?? "");
      if (name) {
        const r = await call("conversations.rename", { name: `${name.slice(0, 60)}-archived-${new Date().toISOString().slice(0, 10)}` });
        if (r !== "ok") this.deps.log("slack.rename_failed", { conversation: conv, error: r?.message });
      }
      const r = await call("conversations.archive", {});
      if (r === "ok") gone = `#${name || link.name} is archived in Slack too`;
      else this.deps.log("slack.archive_failed", { conversation: conv, error: r?.message });
    }
    if (!gone) {
      for (const a of Object.values(c.teammates ?? {})) if (a.botUserId) await call("conversations.kick", { user: a.botUserId });
      const r = await call("conversations.leave", {});
      gone = r === "ok" ? `${APP_NAME} left #${link.name ?? "its Slack channel"}${ours ? " (Slack didn't let it archive the channel)" : ""}` : undefined;
      if (r !== "ok") this.deps.log("slack.leave_failed", { conversation: conv, error: r?.message });
    }
    this.unlink(conv);
    this.deps.note(ch, gone ? `${gone}. Unarchive it and it gets a new Slack channel.` : `Unlinked from #${link.name ?? "its Slack channel"}, but ${APP_NAME} couldn't archive or leave it there: do it in Slack.`);
    this.deps.log("slack.channel_retired", { conversation: conv, channelId: ch.id, ours, gone: Boolean(gone) });
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
      this.inSlack.delete(ch.id); // you're writing in the app now: no typing messages in Slack
      if (m.meta?.files?.length) return void this.sendFiles(link, ch, m, root);
      return this.postAs(USER_LOOK, link.conversationId, { markdown: m.text }, { thread: root, ref });
    }
    const thread = this.threads.get(ch.id);
    if (m.author === "system") return this.postAs(undefined, link.conversationId, { markdown: `_${m.text}_` }, { thread, ref });
    const t = teammate(m.author);
    if (!t) return;
    const text = relayText(m, ch);
    const content: Content | undefined = card(m, ch) ?? (text ? { markdown: text } : undefined);
    if (content) this.postFor(t, link, content, { thread, ref });
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

  /** A teammate at work in the channel: a typing message from it in Slack (while you're writing there). */
  private activity(link: Link, agentId: string, status: string | null) {
    if (!teammate(agentId)) return;
    const set = this.working.get(link.channelId) ?? new Set<string>();
    this.working.set(link.channelId, set);
    if (status && !QUEUED.test(status)) {
      set.add(agentId);
      return this.typeSoon(link, agentId);
    }
    set.delete(agentId);
    // Its answer, if any, comes right after this and takes the typing message's place (postFor). With no answer, the
    // typing message goes a moment later, unless the teammate is at work here again by then.
    setTimeout(() => this.working.get(link.channelId)?.has(agentId) || this.untype(`${link.channelId}:${agentId}`));
  }

  /** The teammate's typing message, unless it has one: out once it has worked a moment (TYPING_AFTER). */
  private typeSoon(link: Link, agentId: string) {
    const key = `${link.channelId}:${agentId}`;
    if (this.typing.has(key) || !this.inSlack.has(link.channelId)) return;
    const t: Typing = { channel: link.conversationId };
    t.timer = setTimeout(() => {
      t.timer = undefined;
      const look = teammate(agentId);
      if (!look) return;
      const posted = (ts: string, by?: string) => {
        Object.assign(t, { ts, by });
        this.typed.add(t);
        this.save();
      };
      this.postAs(look, t.channel, { markdown: TYPING }, { thread: this.threads.get(link.channelId), posted });
    }, TYPING_AFTER);
    this.typing.set(key, t);
  }

  /** Done with a typing message: one still waiting never goes out, one out (or on its way) is deleted. */
  private untype(key: string) {
    const t = this.typing.get(key);
    if (!t) return;
    this.typing.delete(key);
    if (t.timer) return clearTimeout(t.timer);
    return this.queue(() => this.deleteTyping(t), t.channel);
  }

  /** Deletes a typing message, with the token that posted it. Run in the queue: one that was on its way is out by then. */
  private async deleteTyping(t: Typing) {
    const token = t.by ? this.mateTokens.get(t.by) : this.botToken;
    if (t.ts && token) {
      try {
        await slackCall(token, "chat.delete", { channel: t.channel, ts: t.ts });
      } catch (e: any) {
        if (retryable(e)) throw e; // the queue tries again
        if (!(e instanceof SlackError && e.code === "message_not_found")) this.deps.log("slack.typing_delete_failed", { channel: t.channel, error: e?.message });
      }
    }
    if (this.typed.delete(t)) this.save();
  }

  /**
   * A teammate's message, in place of its typing message: that's deleted once the message is out (not edited into it,
   * so Slack notifies you of the answer). A teammate still at work (a hold-on line) gets a new one under it.
   */
  private postFor(t: Teammate, link: Link, content: Content, opts: { thread?: string; ref?: { channelId: string; message: Message } }) {
    const key = `${link.channelId}:${t.id}`;
    const typing = this.typing.get(key);
    this.typing.delete(key);
    clearTimeout(typing?.timer);
    const sent = this.postAs(t, link.conversationId, content, opts);
    if (typing && !typing.timer) void this.queue(() => this.deleteTyping(typing), typing.channel);
    if (this.working.get(link.channelId)?.has(t.id)) this.typeSoon(link, t.id);
    return sent;
  }

  /** A teammate's emoji-only answer lands as a reaction on your message here; in Slack it's a message under its name. */
  private reactions(link: Link, m: Message) {
    if (m.author !== "user") return;
    for (const x of m.meta?.reactions ?? []) {
      const key = `${m.id}:${x.by}:${x.emoji}`;
      const t = teammate(x.by);
      if (!t || this.reacted.has(key)) continue;
      this.reacted.add(key);
      this.postFor(t, link, { markdown: x.emoji }, { thread: this.threads.get(link.channelId) });
    }
  }

  /**
   * A message in Slack under a teammate's name and avatar (chat:write.customize), or as the app itself (`look`
   * undefined), in a thread or not. The teammates write Markdown: it goes in a markdown block, with a mrkdwn copy as
   * the notification text. `ref`: the message here, which keeps the Slack ts (for replies, reactions and its card).
   * `posted`: told the message's ts once it's out, and the teammate whose own bot posted it (else the Harmonia app did).
   */
  private postAs(
    look: Look | undefined,
    channel: string,
    content: Content,
    opts: { thread?: string; ref?: { channelId: string; message: Message }; posted?: (ts: string, by?: string) => void } = {},
  ) {
    // @Name becomes a real Slack mention, in the block and in the mrkdwn copy (made first: it escapes the <).
    const ids = "markdown" in content ? this.mentionIds() : undefined;
    const md = "markdown" in content ? slackMentions(content.markdown, ids!) : undefined;
    const params: Record<string, unknown> = {
      channel,
      ...(md === undefined
        ? { text: (content as { text: string }).text.slice(0, TEXT_MAX), blocks: (content as { blocks: unknown[] }).blocks }
        : { text: slackMentions(mrkdwn((content as { markdown: string }).markdown), ids!).slice(0, TEXT_MAX), ...(md.length <= MARKDOWN_BLOCK_MAX && { blocks: [{ type: "markdown", text: md }] }) }),
      ...(opts.thread && { thread_ts: opts.thread }),
      unfurl_links: false,
      unfurl_media: false,
    };
    const send = async (token?: string) => {
      const call = () => (token ? slackCall(token, "chat.postMessage", params) : this.api("chat.postMessage", params));
      try {
        return await call();
      } catch (e) {
        // A workspace or client that won't take the markdown block gets the mrkdwn text alone.
        if (!(e instanceof SlackError && e.code === "invalid_blocks" && md !== undefined && params.blocks)) throw e;
        delete params.blocks;
        return call();
      }
    };
    return this.queue(async () => {
      if (look) Object.assign(params, await slackLook(look));
      // A teammate's words (not a card: its buttons answer to the Harmonia app) go out from its own bot, if it has one.
      // A bot taken out of the channel since is invited back for a second go; else Harmonia posts for it.
      let r: any;
      let by: string | undefined;
      for (let i = 0; i < 2 && !r; i++) {
        const mate = md !== undefined ? await this.mateToken(look?.id, channel) : undefined;
        if (!mate) break;
        r = await send(mate).catch((e) => this.mateFailed(look!.id!, channel, e));
        if (r) by = look!.id;
      }
      r ??= await send();
      if (r?.ts) opts.posted?.(String(r.ts), by);
      if (opts.ref && r?.ts) {
        (opts.ref.message.meta ??= {}).slack = { channel, ts: String(r.ts), ...(opts.thread && { thread: opts.thread }) };
        saveMessages(opts.ref.channelId);
      }
    }, channel);
  }

  /**
   * Files you attached in the app, in Slack: each one uploaded (files.getUploadURLExternal, then its bytes), then all
   * shared in one message (files.completeUploadExternal) with your words as its comment. Slack posts that message from
   * the app, so the comment starts with your name. If Slack won't take them (an app made before files:write), your words
   * go as usual with the files' names, and a note here says why.
   */
  private async sendFiles(link: Link, ch: Channel, m: Message, thread?: string) {
    const files = m.meta!.files!;
    const conv = link.conversationId;
    const comment = [`*${escapeSlack(USER_LOOK.name)}*`, m.text.trim() && mrkdwn(m.text)].filter(Boolean).join("\n");
    let refused: unknown;
    const done = await this.queue(async () => {
      try {
        const ids: { id: string; title: string }[] = [];
        for (const f of files) {
          const data = Bun.file(attachmentPath(ch.id, f));
          const up = await this.api("files.getUploadURLExternal", { filename: f.name, length: data.size });
          const r = await fetch(String(up.upload_url), { method: "POST", body: data, signal: AbortSignal.timeout(FILE_TIMEOUT) });
          if (!r.ok) throw new SlackError(`http_${r.status}`, `Slack's upload answered HTTP ${r.status}`);
          ids.push({ id: String(up.file_id), title: f.name });
        }
        const j = await this.api("files.completeUploadExternal", { files: ids, channel_id: conv, initial_comment: comment, ...(thread && { thread_ts: thread }) });
        ids.forEach((x, i) => (files[i].slack = x.id));
        return { ids, first: j.files?.[0] };
      } catch (e) {
        if (retryable(e)) throw e; // the queue tries again
        refused = e;
      }
    }, conv);
    if (!done) {
      const why = refused instanceof SlackError && refused.code === "missing_scope"
        ? `the ${APP_NAME} app needs the files:write scope (the Slack page shows how to update it)`
        : String((refused as Error)?.message ?? "Slack didn't answer");
      this.deps.note(ch, `Couldn't send ${files.map((f) => f.name).join(", ")} to Slack: ${why}.`);
      const names = `_(attached in Harmonia: ${files.map((f) => f.name).join(", ")})_`;
      return this.postAs(USER_LOOK, conv, { markdown: [m.text.trim(), names].filter(Boolean).join("\n\n") }, { thread, ref: { channelId: ch.id, message: m } });
    }
    saveMessages(ch.id);
    // The message's ts (for thread replies and reactions on it in Slack) is in the file's shares, which Slack may fill
    // in only a moment later.
    const shared = (file: any) => (file?.shares?.public?.[conv] ?? file?.shares?.private?.[conv])?.[0]?.ts;
    let ts = shared(done.first);
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      if (ts) break;
      await Bun.sleep(wait);
      ts = shared((await this.api("files.info", { file: done.ids[0].id }).catch(() => ({}))).file);
    }
    if (!ts) return this.deps.log("slack.file_ts_unknown", { channelId: ch.id, file: done.ids[0].id });
    (m.meta ??= {}).slack = { channel: conv, ts: String(ts), ...(thread && { thread }) };
    saveMessages(ch.id);
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
/** Network trouble and Slack's own hiccups are worth another try; "not_in_channel" and the like aren't. */
function retryable(e: unknown) {
  if (!(e instanceof SlackError)) return true;
  return e.code.startsWith("http_5") || ["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(e.code);
}

/** A teammate's Slack app, made from its manifest with an app configuration token. */
async function createMateApp(token: string, t: Teammate): Promise<any> {
  try {
    return await slackCall(token, "apps.manifest.create", { manifest: mateManifest(t) });
  } catch (e) {
    // Some workspaces want every new app on Socket Mode. The teammates' apps don't listen to anything anyway.
    if (!(e instanceof SlackError && e.code === "socket_mode_not_enabled")) throw e;
    return slackCall(token, "apps.manifest.create", { manifest: mateManifest(t, true) });
  }
}

/** What's wrong with the configuration token itself, when that's why a call failed: then there's no point going on. */
function configTokenProblem(e: unknown): string | undefined {
  if (!(e instanceof SlackError)) return;
  if (e.code === "token_expired") return "The configuration token has expired (they last 12 hours). Generate a new one and paste it.";
  if (e.code === "invalid_auth" || e.code === "not_authed" || e.code === "token_revoked") return "Slack didn't accept the configuration token. Generate a new one and paste its access token (xoxe.xoxp-…).";
  if (e.code === "missing_scope" || e.code === "not_allowed_token_type") return "That isn't an app configuration token. Generate one at the top of api.slack.com/apps, under Your App Configuration Tokens.";
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
 * once / always / Deny) buttons while it's pending, what was decided once it isn't. A job's start, with a View in
 * Claude button that opens its session in the Claude app on this Mac. Undefined for anything else.
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
  const job = m.kind === "job" ? ch.jobs.find((j) => j.id === m.meta?.jobId) : undefined;
  if (job) {
    const text = mrkdwn(relayText(m, ch) ?? m.text);
    const open = button("View in Claude", "harmonia:session:open", JSON.stringify({ c: ch.id, j: job.id }));
    return { text, blocks: [section(text), { type: "actions", elements: [open] }] };
  }
}

const decided = (text: string, done: string | undefined, buttons: unknown[]) => ({
  text: done ? `${text}\n${done}` : text,
  blocks: [section(text), done ? { type: "context", elements: [{ type: "mrkdwn", text: done }] } : { type: "actions", elements: buttons }],
});

export type Command =
  | { kind: "help" }
  | { kind: "newChannel"; name: string; private: boolean }
  | { kind: "archive" }
  /** `status` undefined: show it (or, with `asked`, a status nobody knows); "" clears it. */
  | { kind: "status"; status?: ChannelStatus | ""; asked: string };

/** The statuses as the app names them. */
export const STATUS_LABELS: Record<ChannelStatus, string> = { inProgress: "In progress", waiting: "Waiting for response", later: "For later", archived: "Archived" };
const STATUS_CHOICES = "*in progress*, *waiting*, *later*, *archived* or *none*";

/** What you might call each status, letters only: "In progress", "in-progress", "waiting for response", "none". */
const STATUS_WORDS: Record<string, ChannelStatus | ""> = {
  inprogress: "inProgress", progress: "inProgress", active: "inProgress", working: "inProgress",
  waiting: "waiting", wait: "waiting", waitingforresponse: "waiting", waitingforreply: "waiting",
  later: "later", forlater: "later",
  archived: "archived", archive: "archived",
  none: "", nostatus: "", clear: "", channels: "",
};

/** A status as typed, or undefined when it isn't one. */
export function parseStatus(text: string): ChannelStatus | "" | undefined {
  const key = text.toLowerCase().replace(/[^a-z]/g, "");
  return Object.hasOwn(STATUS_WORDS, key) ? STATUS_WORDS[key] : undefined;
}

/** A command as typed: Slack's markup as text, without any @mentions (the app's, or the people to invite). */
export const commandText = (raw: string) => slackToText(raw.replace(/<@[^>]+>/g, " "));

/**
 * The app's commands: "new channel <name>" (also "create channel …"), "new private channel <name>" (also "new group
 * chat …", "new chat …"), "status <status>" (just "status" says what it is), "archive" and "help". In a channel they
 * only count when the app was @mentioned; in your DM with it, always. Emails and a trailing "with" (the people to
 * invite) aren't part of the name.
 */
export function parseCommand(text: string): Command | undefined {
  const t = text.trim().replace(/^\/+/, "");
  const m = t.match(/^(?:new|create|add|make)[\s-]?(private[\s-]?channel|channel|group[\s-]?chat|chat)\b[\s:]*(.*)$/is);
  if (m) {
    const name = m[2].replace(EMAIL, " ").replace(/(?:[\s,&]|\bwith\b|\band\b)+$/i, "");
    return { kind: "newChannel", private: !/^channel$/i.test(m[1]), name: name.trim().replace(/^["“'#]+|["”']+$/g, "").trim() };
  }
  if (/^(help|\?|commands)$/i.test(t)) return { kind: "help" };
  if (/^archive[.!]?$/i.test(t)) return { kind: "archive" };
  const st = t.match(/^status\b[\s:]*(.*?)[.!?]?$/is);
  if (st) {
    const asked = st[1].trim().replace(/^["“']+|["”']+$/g, "");
    return { kind: "status", status: asked ? parseStatus(asked) : undefined, asked };
  }
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
    case "status":
      return m.text; // a running job's update every few minutes: "⏳ j2 · title · 5 min" and what's going on
    case "error":
      return `⚠️ ${m.text}`;
    case "permission":
      return `🔐 ${name} is waiting for ${USER_NAME}'s OK in Harmonia: ${m.meta?.permission?.summary ?? m.text}`;
    case "tools":
      return `🧰 ${name} asks for more tools in Harmonia: ${m.meta?.toolRequest?.reason ?? m.text}`;
    default:
      return undefined;
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

/**
 * @Name as a real Slack mention (<@U…>) for everyone in `ids` (lowercase name → Slack user id), so Slack shows the tag
 * and notifies them. The longest name wins ("@Dana Cohen" over "@Dana"). Code, links and Slack's <…> markup stay as
 * they are, and so do emails and addresses (an @ right after a letter, digit or /).
 */
export function slackMentions(text: string, ids: Map<string, string>): string {
  if (!ids.size || !text.includes("@")) return text;
  const names = [...ids.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const at = new RegExp(`(?<![\\p{L}\\p{N}_@/<|\`])@(${names.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`|<[^<>\n]*>|\[[^\]\n]*\]\([^)\s]*\))/g)
    .map((p, i) => (i % 2 ? p : p.replace(at, (_, name: string) => `<@${ids.get(name.toLowerCase())}>`)))
    .join("");
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

/**
 * Apple's emoji as 64px images, named by their code points (emoji-datasource). An avatar is posted as its picture
 * (icon_url), so it looks as it does in the app, skin tone and all: icon_emoji takes a name, and Slack's names have no
 * skin tone.
 */
const EMOJI_IMAGES = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/";
const EMOJI_LOOKUP_MS = 5_000;
const avatarImages = new Map<string, Promise<string | undefined>>();

/** The image of an avatar emoji, or undefined when the set has none (or it can't be reached right now). */
export function avatarImage(avatar: string): Promise<string | undefined> {
  const a = avatar.trim();
  if (!/\p{Extended_Pictographic}/u.test(a)) return Promise.resolve(undefined);
  let found = avatarImages.get(a);
  if (!found) {
    const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join("-");
    // The set names most emoji fully qualified (with U+FE0F), some without it.
    const names = [...new Set([hex(a), hex(a.replace(/️/g, ""))])];
    found = (async () => {
      let unreachable = false;
      for (const name of names) {
        const url = `${EMOJI_IMAGES}${name}.png`;
        try {
          const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(EMOJI_LOOKUP_MS) });
          if (r.ok) return url;
          if (r.status !== 404) unreachable = true;
        } catch {
          unreachable = true;
        }
      }
      if (unreachable) avatarImages.delete(a); // asked again next time
      return undefined;
    })();
    avatarImages.set(a, found);
  }
  return found;
}

/** The name and avatar a message goes under in Slack: the avatar's picture, else its Slack emoji, else it goes before the name. */
async function slackLook(look: Look): Promise<Record<string, string>> {
  const image = await avatarImage(look.avatar);
  if (image) return { username: look.name, icon_url: image };
  const icon = slackEmoji(look.avatar);
  return icon ? { username: look.name, icon_emoji: `:${icon}:` } : { username: `${look.avatar} ${look.name}`.trim() };
}

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

type Secrets = { teamId?: string; bot?: string; app?: string; mates?: Record<string, string> };

async function saveTokens(teamId: string, bot: string, app: string): Promise<string | undefined> {
  if (!onMac) {
    const was = readJson<Secrets>(SECRETS_FILE, {});
    writeFileSync(SECRETS_FILE, JSON.stringify({ teamId, bot, app, ...(was.teamId === teamId && was.mates && { mates: was.mates }) }), { mode: 0o600 });
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

async function deleteTokens(teamId: string, mates: string[] = []) {
  if (!onMac) {
    writeFileSync(SECRETS_FILE, "{}", { mode: 0o600 });
    return;
  }
  for (const kind of ["bot", "app", ...mates.map((id) => `mate:${id}`)]) await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:${kind}`]);
}

/** A teammate's own bot token: in the Keychain as "<team>:mate:<teammate id>". */
async function saveMateToken(teamId: string, id: string, token: string): Promise<string | undefined> {
  if (!onMac) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    if (s.teamId !== teamId) return "Harmonia's own Slack tokens are missing. Remove the connection and connect again.";
    writeFileSync(SECRETS_FILE, JSON.stringify({ ...s, mates: { ...s.mates, [id]: token } }), { mode: 0o600 });
    return;
  }
  const r = await keychain(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:mate:${id}`, "-w", token]);
  if (r.code !== 0) return `Couldn't save the token in the Keychain: ${clip(r.err)}`;
}

async function readMateToken(teamId: string, id: string): Promise<string | undefined> {
  if (!onMac) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    return s.teamId === teamId ? s.mates?.[id] : undefined;
  }
  const r = await keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:mate:${id}`, "-w"]);
  return r.code === 0 && r.out ? r.out : undefined;
}

async function deleteMateToken(teamId: string, id: string) {
  if (!onMac) {
    const s = readJson<Secrets>(SECRETS_FILE, {});
    if (s.mates?.[id] === undefined) return;
    delete s.mates[id];
    writeFileSync(SECRETS_FILE, JSON.stringify(s), { mode: 0o600 });
    return;
  }
  await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${teamId}:mate:${id}`]);
}

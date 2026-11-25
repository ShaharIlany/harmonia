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
// message here (it wakes that teammate), and the answers to it follow you into the thread (only those: job reports and
// whatever else comes up stay in the conversation); your reaction on a message is
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
// A new Slack channel starts with a project. One Harmonia makes, or one you bring it into, opens with a list of your
// Claude projects (projects.ts: the folders your Claude Code sessions run in). The teammates' bots come in once you
// pick one, and the channel's folder is then that project's, so the teammates' jobs (and their sessions in Claude) are
// there. What you write before that waits, and goes to the teammates once you've picked. The list stays at the top of
// the channel to change it, and `@Harmonia project` brings it up again anywhere.
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
// Teammates as Slack members: each teammate can have its own small Slack app (a bot that only posts and reacts), so
// it's a real member you can @mention in Slack. Harmonia makes them with an app configuration token you generate once
// (apps.manifest.create, apps.icon.set: the token isn't kept); you install each one and paste its bot token. In a
// linked channel, Harmonia invites them and their answers (and their emoji on your messages) go out from their own bot. Everything still comes in through
// the Harmonia app (an @mention of Emily is "@Emily" to the teammates). Cards with buttons, your DM with Harmonia and
// group DMs stay with Harmonia, posting under the teammate's name.
//
// DMs with a teammate: with an app-level token of its own (Socket Mode, like Harmonia's), a teammate's app takes DMs.
// Your DM with Emily's app mirrors your DM with Emily here (a channel with `dm` set: only she is woken there). Its
// messages, reactions and buttons come in over Emily's own socket, and everything in that DM goes out with Emily's bot
// token, since Harmonia's bot isn't in it.
//
// Kept in the data folder: slack.json (the workspace, the app, who it works for, the linked conversations, the
// teammates' apps). The bot tokens and the app-level tokens are in the Keychain.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA, DEFAULT_CWD } from "./paths";
import { ROSTER, USER_NAME, nameOf, teammate, type Teammate } from "./roster";
import { channels, createChannel, dmOf, messages, saveChannels, saveMessages, type Channel, type ChannelStatus, type Message } from "./store";
import type { Event } from "./team";
import { claudeProjects, projectOf, tilde, type Project } from "./projects";
import { SLACK_API, SlackError, SlackSocket, isAuthError, slackAuth, slackCall, slackUpload, socketAppId, type Envelope } from "./slack-socket";
import { MAX_FILE, MAX_FILES, attachmentPath, fileSize, saveAttachment, type Attachment } from "./attachments";
import { ChannelMarks } from "./slack-marks";
import { isVoice, transcribe } from "./voice";
import { APP_NAME, BOT_EVENTS, BOT_SCOPES, CREATE_LINK, MATE_DM_SCOPES, MATE_SCOPES, createMateApp, manifest, mateManifest } from "./slack/manifest";
import type { Ask, Config, Content, Deps, Fetched, Held, Link, LinkView, Look, MateApp, MateView, SlackEvent, SlackView, Typing } from "./slack/types";
import { deleteMateToken, deleteTokens, readJson, readMateToken, readTokens, saveMateToken, saveTokens } from "./slack/tokens";
import { EMAIL, USER_MENTION, escapeSlack, mentions, mrkdwn, quote, relayText, slackChannelName, slackMentions, slackToText } from "./slack/text";
import { STATUS_CHOICES, STATUS_LABELS, commandText, parseCommand, type Command } from "./slack/commands";
import { bareName, emojiOf, reactionName, slackLook } from "./slack/emoji";
import { button, card, decided, plain, projectPicker, section, target } from "./slack/blocks";
import { configTokenProblem, ignore, newPairCode, parse, retryable } from "./slack/helpers";

// The code outside the class lives in slack/: what other files import from here is re-exported.
export { APP_NAME, BOT_EVENTS, BOT_SCOPES, CREATE_LINK, MATE_SCOPES, manifest, mateManifest };
export type { Link, LinkView, MateView, SlackEvent, SlackView };
export { STATUS_LABELS, commandText, parseCommand, parseStatus, type Command } from "./slack/commands";
export { avatarImage, emojiOf, reactionName, slackEmoji } from "./slack/emoji";
export { slackChannelName, relayText, slackToText, slackMentions, mrkdwn } from "./slack/text";
export { card } from "./slack/blocks";

const FILE = join(DATA, "slack.json");
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
const NO_REACT_RETRY = 10 * 60_000; // a teammate's app that couldn't react is tried again after this (reinstalled since?)

const HELD_MAX = 20; // your messages kept for the teammates while a channel waits for its project

const USER_LOOK = { name: `${USER_NAME} (in Harmonia)`, avatar: "👤" };

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
  private cardsDone = new Set<string>(); // cards whose Slack message already says what was decided
  private asks: Record<string, Ask>; // ts of a ⚠️ question in your DM → the message it's about
  private sending: Promise<void> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve(); // Slack messages are taken in one at a time, in order
  private rev = 0;
  private mateTokens = new Map<string, string>(); // teammate id → its own app's bot token
  private mateIn = new Set<string>(); // "teammate id:conversation": its bot is in that channel
  // A channel's status and ClickUp task, in its Slack channel's topic and bookmarks.
  private marks = new ChannelMarks({
    api: (method, params) => this.api(method, params),
    on: () => Boolean(this.config?.enabled && this.botToken),
    links: () => Object.values(this.links),
    botUserId: () => this.config?.botUserId,
    canBookmark: () => Boolean(this.config?.scopes?.includes("bookmarks:write")),
    log: (event, fields) => this.deps.log(event, fields),
  });
  private mateProblems = new Map<string, string>(); // teammate id → why its app can't post now
  private noReact = new Map<string, number>(); // teammate id → when its app turned out to lack reactions:write
  private mateSockets = new Map<string, SlackSocket>(); // teammate id → its app's socket: your DM with it
  private mateScopes = new Map<string, string[]>(); // teammate id → what its bot token may do, last time Slack was asked
  private mateDmProblems = new Map<string, string>(); // teammate id → why its DMs can't be on now
  private mateConvs = new Map<string, string>(); // Slack DM → the teammate whose app it's with (linked or not yet)
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
    for (const s of this.mateSockets.values()) s.stop();
    this.mateSockets.clear();
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
        detail:
          problem ??
          a?.iconError ??
          (this.noReact.has(id)
            ? `Its emoji go out from ${APP_NAME} for now: its app can't react yet. Update the apps above, then reinstall it (App settings → Install App → Reinstall).`
            : undefined),
        appLink: a && `https://api.slack.com/apps/${a.appId}`,
        installLink: a && `https://api.slack.com/apps/${a.appId}/install-on-team`,
        slackName: a && t && a.name !== t.name ? a.name : undefined,
        gone: !t || undefined,
        ...this.dmView(id, a),
      };
    });
  }

  /** Where your DM with a teammate's own app is at. */
  private dmView(id: string, a?: MateApp): Pick<MateView, "dms" | "dmDetail" | "dmMissing" | "dmUrl"> {
    const scopes = this.mateScopes.get(id);
    const missing = scopes && MATE_SCOPES.filter((x) => !scopes.includes(x));
    const link = Object.values(this.links).find((l) => l.kind === "mate" && l.mate === id);
    const team = this.config?.teamId;
    const socket = this.mateSockets.get(id)?.state;
    const problem = this.mateDmProblems.get(id);
    return {
      dms: !a?.dms ? "off" : problem ? "failed" : (socket?.state ?? "connecting"),
      dmDetail: problem ?? (socket?.state !== "ready" ? socket?.detail : undefined),
      ...(missing?.length && { dmMissing: missing }),
      ...(link && team && { dmUrl: `https://app.slack.com/client/${team}/${link.conversationId}` }),
    };
  }

  linkViews(): LinkView[] {
    const team = this.config?.teamId;
    return Object.values(this.links).map((l) => ({
      conversationId: l.conversationId,
      kind: l.kind,
      ...(l.mate && { mate: l.mate }),
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

  /** Asks Slack again what the bot tokens may do (after you updated an app's manifest and reinstalled it). */
  async checkScopes(): Promise<string | undefined> {
    if (!this.config) return "Slack isn't set up.";
    if (!this.botToken) return "Slack isn't connected.";
    const mates = await this.checkMateScopes();
    try {
      const auth = await slackAuth(this.botToken);
      if (JSON.stringify(auth.scopes) === JSON.stringify(this.config.scopes)) return mates ? void this.changed() : undefined;
      this.config.scopes = auth.scopes;
      this.save();
      this.changed();
      this.marks.all(); // with bookmarks:write now, the tasks get their bookmarks
    } catch (e: any) {
      return `Couldn't ask Slack: ${e.message}`;
    }
  }

  /** What each teammate's bot token may do now (for its DMs). True when that changed. */
  private async checkMateScopes(): Promise<boolean> {
    let changed = false;
    await Promise.all(
      [...this.mateTokens].map(async ([id, token]) => {
        const scopes = await slackAuth(token).then((a) => a.scopes as string[] | undefined, () => undefined);
        if (!scopes || JSON.stringify(scopes) === JSON.stringify(this.mateScopes.get(id))) return;
        this.mateScopes.set(id, scopes);
        changed = true;
      }),
    );
    return changed;
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
    if (auth.scopes) this.mateScopes.set(id, auth.scopes);
    this.mateProblems.delete(id);
    this.noReact.delete(id);
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
    await this.dropMateDms(id);
    await deleteMateToken(c.teamId, id);
    delete c.teammates?.[id];
    this.mateTokens.delete(id);
    this.mateScopes.delete(id);
    this.mateProblems.delete(id);
    for (const key of this.mateIn) if (key.startsWith(`${id}:`)) this.mateIn.delete(key);
  }

  // ---------- DMs with a teammate: its own app's socket ----------

  /**
   * Lets you DM a teammate's own app in Slack: checks its app-level token (xapp-…, with connections:write) is that app's,
   * keeps it in the Keychain, listens on its socket, and links your DM with it to your DM with the teammate here.
   */
  async connectMateDms(id: string, appToken: string): Promise<string | undefined> {
    const c = this.config;
    const app = c?.teammates?.[id];
    const t = teammate(id);
    if (!c || !app || !t) return "Make its Slack app first.";
    const bot = this.mateTokens.get(id);
    if (!bot || !app.botUserId) return `Connect ${t.name}'s app first: install it and paste its bot token.`;
    appToken = appToken.trim();
    if (!appToken.startsWith("xapp-"))
      return `The app-level token starts with xapp-. In ${t.name}'s app settings: Basic Information → App-Level Tokens → Generate Token and Scopes, with the connections:write scope.`;
    // Its bot token has to be able to read and open DMs: the app was made from the newer manifest and reinstalled.
    await this.checkMateScopes();
    const scopes = this.mateScopes.get(id);
    const lacking = scopes ? MATE_DM_SCOPES.filter((x) => !scopes.includes(x)) : [];
    if (lacking.length)
      return `${t.name}'s app can't take DMs yet: its token is missing ${lacking.join(", ")}. Update the teammates' apps (the configuration token above), then reinstall ${t.name}'s app (App settings → Install App → Reinstall to Workspace) and try again.`;
    // Which app the token is for: Slack names it when a socket opens. Harmonia's own token here would split Harmonia's
    // events between two sockets.
    let appId: string | undefined;
    try {
      appId = await socketAppId(appToken);
    } catch (e: any) {
      if (e instanceof SlackError && e.code === "missing_scope") return "The app-level token needs the connections:write scope. Make a new one with it.";
      if (!(e instanceof SlackError)) return `Slack took the token, but its socket didn't open (${e.message}). Try again in a moment.`;
      return `Slack didn't accept the app-level token: ${e.message}${isAuthError(e) ? "" : `. Is Socket Mode on for ${t.name}'s app? Update the teammates' apps above.`}`;
    }
    if (appId && appId === c.appId) return `That's ${APP_NAME}'s own app-level token. Make one in ${t.name}'s app (App settings → Basic Information → App-Level Tokens).`;
    const other = appId && Object.entries(c.teammates!).find(([k, a]) => k !== id && a.appId === appId);
    if (other) return `That's ${nameOf(other[0])}'s app-level token. Make one in ${t.name}'s app.`;
    if (appId && appId !== app.appId) return `That token is another app's. Make one in ${t.name}'s app (App settings → Basic Information → App-Level Tokens).`;
    if (!appId && appToken === (await readTokens(c.teamId))?.app) return `That's ${APP_NAME}'s own app-level token. Make one in ${t.name}'s app.`;
    const err = await saveMateToken(c.teamId, id, appToken, "app");
    if (err) return err;
    app.dms = true;
    this.mateDmProblems.delete(id);
    this.save();
    this.openMateSocket(id, appToken);
    this.changed();
    this.deps.log("slack.teammate_dms_on", { teammate: id, app: app.appId });
    await this.linkMateDm(id);
  }

  /** You stop DMing a teammate's app: Harmonia stops listening on its socket and forgets its app-level token. */
  async stopMateDms(id: string): Promise<string | undefined> {
    if (!this.config?.teammates?.[id]?.dms) return "Its DMs aren't on.";
    await this.dropMateDms(id);
    this.save();
    this.changed();
  }

  private async dropMateDms(id: string) {
    const c = this.config!;
    this.mateSockets.get(id)?.stop();
    this.mateSockets.delete(id);
    this.mateDmProblems.delete(id);
    const app = c.teammates?.[id];
    if (app?.dms) await deleteMateToken(c.teamId, id, "app");
    if (app) delete app.dms;
    for (const l of Object.values(this.links)) if (l.kind === "mate" && l.mate === id) this.unlink(l.conversationId);
    for (const [conv, mate] of this.mateConvs) if (mate === id) this.mateConvs.delete(conv);
  }

  private openMateSocket(id: string, appToken: string) {
    this.mateSockets.get(id)?.stop();
    const socket = new SlackSocket(
      appToken,
      (e) => void this.onMateEnvelope(id, e).catch((err) => this.deps.log("slack.event_failed", { teammate: id, error: err?.message })),
      () => this.changed(),
      (event, fields) => this.deps.log(event, { teammate: id, ...fields }),
    );
    this.mateSockets.set(id, socket);
    socket.start();
  }

  /**
   * Links your Slack DM with a teammate's app to your DM with it here, when there's one here and nothing links it yet
   * (made in the app, or DMs just turned on). Slack opens (or finds) the DM for its bot.
   */
  private async linkMateDm(id: string) {
    const c = this.config;
    const ch = dmOf(id);
    const token = this.mateTokens.get(id);
    if (!c?.enabled || !c.ownerId || !ch || !token || !this.mateSockets.has(id)) return;
    if (Object.values(this.links).some((l) => l.channelId === ch.id)) return;
    try {
      const conv = String((await slackCall(token, "conversations.open", { users: c.ownerId })).channel.id);
      if (!this.links[conv]) this.linkMate(id, conv);
    } catch (e: any) {
      this.deps.log("slack.teammate_dm_open_failed", { teammate: id, error: e?.message });
    }
  }

  /** Your Slack DM with a teammate's app, linked to your DM with it here (made now if there's none). */
  private linkMate(id: string, conversation: string): Link {
    let ch = dmOf(id);
    if (!ch) {
      ch = createChannel(`dm ${id}`, DEFAULT_CWD, id);
      this.deps.channelCreated(ch);
    }
    // One Slack DM per DM here: an older one lets go.
    for (const l of Object.values(this.links)) if (l.channelId === ch.id && l.conversationId !== conversation) this.unlink(l.conversationId);
    const link: Link = { conversationId: conversation, kind: "mate", mate: id, channelId: ch.id, name: nameOf(id), createdAt: Date.now() };
    this.links[conversation] = link;
    this.mateConvs.set(conversation, id);
    this.save();
    this.changed();
    this.deps.note(ch, `Linked to Slack: your DM with @${nameOf(id)}${this.config?.teamName ? ` in ${this.config.teamName}` : ""}.`);
    this.deps.log("slack.linked", { conversation, channelId: ch.id, kind: "mate", teammate: id });
    return link;
  }

  /** An event from a teammate's own app: your DM with it (messages, your reactions there) and its buttons. */
  private async onMateEnvelope(id: string, env: Envelope) {
    if (env.type === "interactive") return this.interactive(env.payload ?? {}, id);
    if (env.type !== "events_api") return;
    const ev = env.payload?.event;
    // Its bot is in the linked channels too, so it hears reactions there: those are the Harmonia app's.
    const inDm = (conv: unknown) => this.links[String(conv)]?.mate === id;
    const handle =
      ev?.type === "message"
        ? () => this.mateMessage(id, ev)
        : (ev?.type === "reaction_added" || ev?.type === "reaction_removed") && inDm(ev.item?.channel)
          ? () => this.reaction(ev, ev.type === "reaction_added")
          : undefined;
    if (!handle) return;
    const next = this.inbound.then(handle);
    this.inbound = next.catch(() => {});
    return next;
  }

  /** A message in your DM with a teammate's app: yours goes to your DM with it here. Nobody else's wakes it. */
  private async mateMessage(id: string, ev: any) {
    const c = this.config;
    const app = c?.teammates?.[id];
    if (!c || !app || !ev.channel || !ev.ts || ev.channel_type !== "im") return;
    if (ev.subtype && !WRITTEN.has(ev.subtype)) return;
    if (ev.bot_id || !ev.user || ev.user === app.botUserId) return;
    if (!this.firstTime(ev)) return;
    const conv = String(ev.channel);
    this.mateConvs.set(conv, id);
    if (!c.ownerId) return this.say(conv, `I don't know who I work for yet. Pair ${APP_NAME} first: send it the code on Harmonia's Slack page.`);
    if (ev.user !== c.ownerId) {
      this.deps.log("slack.message_refused", { user: ev.user, teammate: id });
      return this.say(conv, `Sorry, I only work for ${USER_NAME}.`);
    }
    if (!teammate(id)) return this.say(conv, `I'm no longer on the team in ${APP_NAME}.`);
    const link = this.links[conv] ?? this.linkMate(id, conv);
    const ch = channels.get(link.channelId) ?? channels.get(this.linkMate(id, conv).channelId);
    if (!ch) return;
    const thread = ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : undefined;
    const got = await this.readIn(ev, ch, String(ev.text ?? ""), true, thread);
    if (got) this.forward(ch, got);
  }

  /** The linked channels (public and private): where the teammates' own bots can be. Not one still waiting for its project. */
  private channelLinks(): string[] {
    return Object.values(this.links)
      .filter((l) => (l.kind === "channel" || l.kind === "private") && !l.awaitingProject)
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

  /**
   * The token a teammate's answer goes out with in a conversation: its own bot's, in a channel it's (now) in. Not in a
   * channel still waiting for its project: the teammates' bots come in once you pick it, and Harmonia posts till then.
   */
  private async mateToken(id: string | undefined, conversation: string): Promise<string | undefined> {
    const token = id && this.mateTokens.get(id);
    const link = this.links[conversation];
    if (!token || (link?.kind !== "channel" && link?.kind !== "private") || link.awaitingProject) return undefined;
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
      // Your DM with its app: its own socket.
      if (!a.dms) continue;
      const appToken = await readMateToken(c.teamId, id, "app");
      if (appToken && token) this.openMateSocket(id, appToken);
      else this.mateDmProblems.set(id, appToken ? "Its bot token is missing: connect it again." : "Its app-level token is missing from the Keychain. Turn its DMs on again.");
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
    void this.checkScopes().then(() => this.marks.all()); // what changed while Harmonia was off
  }

  /** A Web API call with Harmonia's bot token, or `token` (a teammate's, in your DM with its app). */
  private api(method: string, params: Record<string, unknown> = {}, token = this.botToken) {
    if (!token) return Promise.reject(new SlackError("not_connected", "Slack isn't connected"));
    return slackCall(token, method, params);
  }

  /**
   * The bot token that speaks in a Slack conversation: in your DM with a teammate's own app, that app's (Harmonia's bot
   * isn't in it); anywhere else, Harmonia's. Empty when that teammate's token is gone.
   */
  private tokenFor(conversation: string | undefined): string {
    const mate = conversation ? (this.links[conversation]?.mate ?? this.mateConvs.get(conversation)) : undefined;
    return mate ? (this.mateTokens.get(mate) ?? "") : this.botToken;
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

  /**
   * The app was added to a channel. Brought in by you, it links the channel there and then, and asks for its project;
   * by someone else, it says what it does there. (Not in one it just made: that one is linked already.)
   */
  private async joined(ev: any) {
    const c = this.config;
    if (!c || ev.user !== c.botUserId) return;
    await Bun.sleep(3_000); // a channel the app is creating is linked by then
    // In line with the messages: if you write there straight away, the channel is still linked once, list first.
    const next = this.inbound.then(async () => {
      if (this.links[ev.channel]) return;
      if (c.ownerId && ev.inviter === c.ownerId) {
        await this.autoLink({ channel: ev.channel, channel_type: ev.channel_type === "G" ? "group" : "channel" });
        return;
      }
      this.say(
        ev.channel,
        `Hi, I'm ${APP_NAME} :musical_score:. I connect this channel to Harmonia: when ${USER_NAME} writes here, Mozart picks the teammate who answers (or start with @Leo to ask Leo). Write *@${APP_NAME} help* for what I can do.`,
      );
    });
    this.inbound = next.catch(() => {});
    return next;
  }

  private async message(ev: any) {
    const c = this.config;
    if (!c || !ev.channel || !ev.ts) return;
    if (ev.subtype && !WRITTEN.has(ev.subtype)) return; // edits, deletions, joins, other apps
    if (ev.bot_id || !ev.user || ev.user === c.botUserId) return;
    if (!this.firstTime(ev)) return;

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
    const got = await this.readIn(ev, ch, raw, yours, thread);
    if (!got) return;
    if (!yours) return this.deps.guest(ch, await this.nameOf(ev.user), got.text, ev.user, got.slack, got.files, got.voice);
    const waiting = this.links[got.slack.channel];
    if (waiting?.awaitingProject) return this.hold(waiting, ch, got);
    this.forward(ch, got);
  }

  /** A Slack message we haven't taken in yet (Slack redelivers when an ack is late). */
  private firstTime(ev: any): boolean {
    const key = `${ev.channel}:${ev.ts}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  /**
   * A Slack message as it lands here: its text as the teammates read it, and its files fetched. A voice note's words
   * are its text (voice.ts), with the audio still attached. Undefined: nothing to read.
   */
  private async readIn(ev: any, ch: Channel, raw: string, yours: boolean, thread?: string): Promise<Held | undefined> {
    const where = String(ev.channel);
    const token = this.tokenFor(where);
    const got = await this.fetchFiles(ch, Array.isArray(ev.files) ? ev.files : [], token);
    let text = await this.chatText(raw);
    const heard = await this.hear(ch, got.voices, token);
    if (heard.text) text = [text, heard.text].filter(Boolean).join("\n\n");
    if (heard.failed.length) {
      text = [text, `(voice message, not transcribed: ${heard.failed.join("; ")})`].filter(Boolean).join("\n");
      if (yours) this.say(where, `I couldn't make out your voice message: ${heard.failed.join("; ")}. The teammates get the audio file, which they can't listen to.`, thread);
    }
    if (got.missed.length) text = [text, `(attached in Slack, not fetched: ${got.missed.join("; ")})`].filter(Boolean).join("\n");
    if (!text && !got.files.length) return void (yours && this.say(where, "I can only read text and files for now.", thread));
    const mate = this.links[where]?.mate;
    if (yours && got.noScope)
      this.say(where, `I couldn't fetch your file${got.missed.length > 1 ? "s" : ""} for the teammates: ${mate ? `${nameOf(mate)}'s app` : `the ${APP_NAME} app`} needs the files:read scope. Harmonia's Slack page shows how to update it.`, thread);
    return { text, slack: { channel: where, ts: String(ev.ts), ...(thread && { thread }) }, files: got.files, ...(heard.language && { voice: { language: heard.language } }) };
  }

  /** The voice notes on a message as text, one after another, and the language they were spoken in. */
  private async hear(ch: Channel, voices: Fetched["voices"], token: string): Promise<{ text: string; language?: string; failed: string[] }> {
    const said: string[] = [];
    const failed: string[] = [];
    let language: string | undefined;
    for (const v of voices) {
      const started = Date.now();
      const slackCopy = v.mp4 ? () => this.downloadTemp(v.mp4!, token) : undefined;
      const r = await transcribe(attachmentPath(ch.id, v.file), v.file.type, slackCopy);
      if ("text" in r) {
        said.push(r.text);
        language ??= r.language;
        this.deps.log("slack.voice_transcribed", { file: v.file.slack, language: r.language, chars: r.text.length, ms: Date.now() - started });
      } else {
        failed.push(voices.length > 1 ? `${v.file.name}: ${r.error}` : r.error);
        this.deps.log("slack.voice_failed", { file: v.file.slack, type: v.file.type, code: r.code, error: r.error });
      }
    }
    return { text: said.join("\n\n"), language, failed };
  }

  /** A file from Slack into a temporary file, for a moment (Slack's MP4 copy of a voice clip). Slack's own hosts only. */
  private async downloadTemp(url: string, token = this.botToken): Promise<string> {
    const host = new URL(url).hostname;
    if (!(host === "slack.com" || host.endsWith(".slack.com") || host === new URL(SLACK_API).hostname)) throw new Error(`it's not on Slack (${host})`);
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FILE_TIMEOUT) });
    if (!r.ok || /^text\/html/i.test(r.headers.get("content-type") ?? "")) throw new Error(`Slack answered HTTP ${r.status}`);
    const path = join(tmpdir(), `harmonia-voice-${crypto.randomUUID()}.mp4`);
    writeFileSync(path, new Uint8Array(await r.arrayBuffer()));
    return path;
  }

  /** Your message, to the teammates. The answers go where you wrote, into the thread or the channel itself: they answer this message (threadOf). */
  private forward(ch: Channel, h: Held) {
    this.inSlack.add(ch.id);
    const thread = h.slack.thread;
    this.deps.post(ch, h.text, { replyTo: thread ? this.bySlack(ch.id, h.slack.channel, thread)?.id : undefined, slack: h.slack, files: h.files, voice: h.voice });
  }

  /**
   * The files on a Slack message, copied into the channel's attachments so the teammates can open them. What couldn't
   * be (a link to Google Drive, a file deleted since, one too big) is named in `missed`, with why. `noScope`: the app
   * was made before it could read files (files:read).
   */
  private async fetchFiles(ch: Channel, list: any[], token = this.botToken): Promise<Fetched> {
    const files: Attachment[] = [];
    const voices: Fetched["voices"] = [];
    const missed: string[] = [];
    let noScope = false;
    for (let f of list.slice(0, MAX_FILES)) {
      if (!f || typeof f !== "object") continue;
      // Some events carry only the file's id ("check_file_info"): files.info has the rest.
      if (f.id && (f.file_access === "check_file_info" || (!f.url_private && !f.url_private_download && f.mode !== "external"))) {
        try {
          f = (await this.api("files.info", { file: f.id }, token)).file ?? f;
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
          const file: Attachment = { ...(await this.download(ch.id, String(url), name, f.mimetype, token)), ...(f.id && { slack: String(f.id) }) };
          files.push(file);
          // Slack keeps an MP4 of a recorded clip, which dictation can open when the original (WebM) can't be.
          if (isVoice(f)) voices.push({ file, ...(typeof f.mp4 === "string" && { mp4: f.mp4 }) });
        } catch (e: any) {
          if (e?.code === "missing_scope") noScope = true;
          missed.push(`${name} (${e?.message ?? e})`);
          this.deps.log("slack.file_fetch_failed", { file: f.id, error: e?.message });
        }
      }
    }
    if (list.length > MAX_FILES) missed.push(`${list.length - MAX_FILES} more file${list.length - MAX_FILES > 1 ? "s" : ""} (up to ${MAX_FILES} on a message)`);
    return { files, voices, missed, noScope };
  }

  /** One file from Slack, with the bot token (`token`: a teammate's, in your DM with its app). Slack's own hosts only: the token goes nowhere else. */
  private async download(channelId: string, url: string, name: string, type?: string, token = this.botToken): Promise<Attachment> {
    const host = new URL(url).hostname;
    if (!(host === "slack.com" || host.endsWith(".slack.com") || host === new URL(SLACK_API).hostname)) throw new Error(`it's not on Slack (${host})`);
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FILE_TIMEOUT) });
    // A token without files:read gets HTTP 403 (or Slack's sign-in page instead of the file). Slack is asked again what
    // the token may do, in case the app was updated and reinstalled since the scopes were last checked.
    const signIn = r.ok && /^text\/html/i.test(r.headers.get("content-type") ?? "") && !/html/i.test(type ?? "");
    if (r.status === 401 || r.status === 403 || signIn) {
      await r.body?.cancel().catch(() => {});
      await this.checkScopes();
      const mate = token === this.botToken ? undefined : [...this.mateTokens].find(([, t]) => t === token)?.[0];
      const scopes = mate ? this.mateScopes.get(mate) : this.config?.scopes;
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
      `:warning: How can *${name}*'s message ${link.conversationId === dm ? "here" : link.kind === "mate" ? `in your DM with ${escapeSlack(nameOf(link.mate!))}` : `in <#${link.conversationId}>`} be improved?`,
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

  /** A click or a box, from the Harmonia app, or from a teammate's own app (`mate`: a card in your DM with it). */
  private async interactive(p: any, mate?: string) {
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
      if (kind === "project") {
        // In line with your messages: the ones held for the project go to the teammates before anything newer.
        const next = this.inbound.then(() => this.chooseProject(where, a, p.message?.ts ?? p.container?.message_ts));
        this.inbound = next.catch(() => {});
        await next;
        continue;
      }
      const t = parse(a.value);
      const ch = channels.get(t.c);
      if (!ch) {
        this.ephemeral(where, user, "That channel is gone from Harmonia.");
        continue;
      }
      if (kind === "feedback") {
        // The box opens with the token of the app that was clicked: Slack's trigger is that app's.
        await this.openFeedback(p.trigger_id, ch, t.m, { dm: where, ts: p.message?.ts ?? p.container?.message_ts }, mate ? this.mateTokens.get(mate) : undefined);
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
  private async openFeedback(trigger: string, ch: Channel, messageId: string, origin: { dm?: string; ts?: string }, token = this.botToken) {
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
            section(`*${escapeSlack(name)}* ${ch.dm ? "in your DM" : `in #${escapeSlack(ch.name)}`}:\n${quote(relayText(m) ?? m.text)}`),
            {
              type: "input",
              block_id: "feedback",
              label: plain("How can it be improved?"),
              hint: plain(`${name} works out how its rules led to this message and amends them.`),
              element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 4000, focus_on_load: true },
            },
          ],
        },
      }, token);
    } catch (e: any) {
      this.deps.log("slack.feedback_box_failed", { error: e.message });
      if (origin.dm) this.say(origin.dm, `Couldn't open the box (${e.code ?? e.message}). Reply in this thread instead.`, origin.ts);
    }
  }

  /** A note only `user` sees, in that conversation. */
  private ephemeral(channel: string | undefined, user: string | undefined, text: string) {
    if (channel && user) void this.queue(() => this.api("chat.postEphemeral", { channel, user, text }, this.tokenFor(channel)), channel);
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
    // A channel opens with the list of your projects, and the teammates come in once you've picked one.
    if ((kind === "channel" || kind === "private") && !this.askProject(link, ch, { awaiting: true })) void this.inviteMates([link.conversationId]);
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
          `• *${at}task <id or link>*: tags this channel with a ClickUp task (DC-123, 123 or the task's link). *${at}task none* clears it.`,
          `• *${at}project*: this channel's Claude project, the folder the teammates' jobs run in. Pick another to change it.`,
          `• \`/invite @${APP_NAME}\` in any channel: it's linked to a new Harmonia channel, and the teammates join once you pick its project.`,
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
    if (cmd.kind === "project") {
      if (!this.askProject(link, ch, { thread })) this.say(ev.channel, "I found no Claude projects on this Mac. A folder you've worked in with Claude Code is one.", thread);
      return;
    }
    const name = `*#${escapeSlack(ch.name)}*`;
    if (cmd.kind === "task") {
      if (cmd.task === undefined)
        return this.say(ev.channel, `${name} ${ch.task ? `is tagged with <${ch.task.url}|ClickUp ${escapeSlack(ch.task.id)}>` : "has no ClickUp task"}. Set it with *${at}task <id or link>*, or clear it with *${at}task none*.`, thread);
      const err = this.deps.setTask(ch, cmd.task);
      if (err) return this.say(ev.channel, `Couldn't: ${escapeSlack(err)}`, thread);
      this.deps.log("slack.task_set", { channelId: ch.id, task: ch.task?.id ?? null });
      return this.say(ev.channel, ch.task ? `:white_check_mark: ${name} is tagged with <${ch.task.url}|ClickUp ${escapeSlack(ch.task.id)}> now.` : `:white_check_mark: ${name} has no ClickUp task now.`, thread);
    }
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
    const inviteError = await this.adopt(String(made.id), name, ch, cmd.private, people.ids, "", true);
    this.deps.note(ch, `Created from Slack: the ${cmd.private ? "private " : ""}channel #${name}, linked to this channel.`);
    if (inviteError) this.deps.note(ch, `Couldn't invite everyone to #${name} in Slack: ${inviteError}`);
    const pick = this.links[made.id]?.awaitingProject ? " Pick its project there and the teammates join." : "";
    this.say(ev.channel, `Created <#${made.id}>, linked to *#${ch.name}* in Harmonia.${pick}${inviteError ? ` I couldn't invite everyone: ${inviteError}` : ""}`);
    this.deps.log("slack.channel_created", { conversation: made.id, channelId: ch.id, private: cmd.private });
  }

  /**
   * A Slack channel Harmonia just made, for `ch`: you (and `people`) invited, linked, the teammates' bots invited, and a
   * welcome (after `lead`, if any). With `ask`, the list of your projects instead: the teammates come in once you pick.
   * An error, when not everyone could be invited.
   */
  private async adopt(conversation: string, name: string, ch: Channel, isPrivate: boolean, people: string[] = [], lead = "", ask = false): Promise<string | undefined> {
    let inviteError: string | undefined;
    try {
      await this.api("conversations.invite", { channel: conversation, users: [this.config!.ownerId, ...people].join(",") });
    } catch (e: any) {
      if (e.code !== "already_in_channel") inviteError = e.message;
    }
    const link: Link = { conversationId: conversation, kind: isPrivate ? "private" : "channel", channelId: ch.id, name, createdAt: Date.now() };
    this.links[conversation] = link;
    this.save();
    this.changed();
    this.marks.changed(ch); // an unarchived channel's status, in its new Slack channel
    if (ask && this.askProject(link, ch, { awaiting: true })) return inviteError;
    this.postAs(undefined, conversation, {
      markdown: `${lead}This channel is **#${ch.name}** in Harmonia. Write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.${isPrivate ? " Only the people in it see it." : ""}`,
    });
    void this.inviteMates([conversation]);
    return inviteError;
  }

  // ---------- A channel's project ----------

  /**
   * Posts the list of your Claude projects in a linked conversation, with the channel's folder picked. `awaiting`: a new
   * channel, where nothing is picked yet and the teammates come in once you do. False when there's nothing to pick from.
   */
  private askProject(link: Link, ch: Channel, opts: { awaiting?: boolean; thread?: string } = {}): boolean {
    const projects = claudeProjects();
    if (!projects.length) return false;
    if (opts.awaiting) {
      link.awaitingProject = true;
      this.save();
    }
    const list = projectPicker(ch, projects, opts.awaiting ? undefined : ch.cwd);
    const conversation = link.conversationId;
    void this.queue(() => this.api("chat.postMessage", { channel: conversation, ...list, unfurl_links: false, ...(opts.thread && { thread_ts: opts.thread }) }), conversation);
    return true;
  }

  /**
   * You picked a project from the list: its folder becomes the channel's, so the teammates' jobs run there. The list
   * stays, showing it. In a new channel the teammates' bots come in now, and what you wrote meanwhile goes to them.
   */
  private async chooseProject(conversation: string | undefined, a: any, ts: string | undefined) {
    const owner = this.config?.ownerId;
    const link = conversation ? this.links[conversation] : undefined;
    const ch = link && channels.get(link.channelId);
    const listFor = String(a.block_id ?? "").split(":")[1]; // the list's block is "harmonia-project:<channel id>"
    if (!conversation || !link || !ch || (listFor && listFor !== ch.id)) return this.ephemeral(conversation, owner, "That list is for a channel that's gone from Harmonia.");
    if (ch.status === "archived") return this.ephemeral(conversation, owner, `#${ch.name} is archived in Harmonia. Unarchive it there first.`);
    const path = String(a.selected_option?.value ?? "");
    const projects = claudeProjects();
    const project = projects.find((p) => p.path === path) ?? (path && path === ch.cwd ? projectOf(path) : undefined);
    if (!project) return this.ephemeral(conversation, owner, `I can't find that project any more. *@${APP_NAME} project* brings up the list again.`);

    const changed = ch.cwd !== path;
    if (changed) {
      ch.cwd = path;
      saveChannels();
      this.deps.channelChanged(ch);
    }
    if (ts) void this.queue(() => this.api("chat.update", { channel: conversation, ts, ...projectPicker(ch, projects, path) }), conversation);
    const first = Boolean(link.awaitingProject);
    const held = link.held ?? [];
    if (first) {
      delete link.awaitingProject;
      delete link.held;
      this.save();
      this.changed();
    }
    if (changed || first) this.deps.note(ch, `Project: ${project.name} (${tilde(path)}), picked in Slack. The teammates' jobs run there.`);
    this.deps.log("slack.project_picked", { conversation, channelId: ch.id, first, held: held.length });
    if (!first) return;
    this.postAs(undefined, conversation, {
      markdown: `This channel is **#${ch.name}** in Harmonia, for **${project.name}**, and the team is in. Write here and Mozart picks the teammate who answers, or start with @Leo to ask Leo.${link.kind === "private" ? " Only the people in it see it." : ""}`,
    });
    await this.inviteMates([conversation]);
    for (const h of held) this.forward(ch, h);
  }

  /** Your message in a channel still waiting for its project: kept for the teammates, with a word on why nobody answers yet. */
  private hold(link: Link, ch: Channel, h: Held) {
    const held = (link.held ??= []);
    const where = h.slack.thread ?? h.slack.ts;
    if (held.length >= HELD_MAX)
      return this.say(h.slack.channel, `Pick this channel's project first (the list above, or *@${APP_NAME} project*). I keep only your first ${HELD_MAX} messages for the teammates till then.`, where);
    held.push(h);
    this.save();
    this.deps.log("slack.held", { channelId: ch.id, held: held.length });
    if (held.length === 1)
      this.say(h.slack.channel, `Pick this channel's project first, from the list above: the teammates join once you do, and they'll get this then. (*@${APP_NAME} project* brings the list here.)`, where);
  }

  // ---------- Harmonia's channels, in Slack ----------

  /**
   * A channel you made in the app: it gets a private Slack channel, with you and the teammates' bots in it. A DM with a
   * teammate gets your Slack DM with its own app instead, if you can DM it there.
   */
  channelAdded(ch: Channel) {
    if (ch.dm) return this.inOrder(() => this.linkMateDm(ch.dm!));
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
    if (!channels.has(ch.id) || ch.dm || ch.status === "archived" || Object.values(this.links).some((l) => l.channelId === ch.id)) return;
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
    if (e.type === "channel") return this.marks.changed(e.channel); // its status or ClickUp task, in Slack's topic
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
      const root = this.threadOf(link, ch, m);
      this.inSlack.delete(ch.id); // you're writing in the app now: no typing messages in Slack
      if (m.meta?.files?.length) return void this.sendFiles(link, ch, m, root);
      return this.postAs(USER_LOOK, link.conversationId, { markdown: m.text }, { thread: root, ref });
    }
    const thread = this.threadOf(link, ch, m);
    if (m.author === "system") return this.postAs(undefined, link.conversationId, { markdown: `_${m.text}_` }, { thread, ref });
    const t = teammate(m.author);
    if (!t) return;
    const text = relayText(m, ch);
    const content: Content | undefined = card(m, ch) ?? (text ? { markdown: text } : undefined);
    if (content) this.postFor(t, link, content, { thread, ref });
  }

  /**
   * The Slack thread a message goes in, or undefined for the conversation itself. One that's in Slack already stays
   * where it is. Yours, typed in the app as a reply to a message in Slack, goes into that message's thread (or starts
   * one under it). A teammate's goes where the message its turn answers is (meta.answers): a reply in a thread gets its
   * answers in that thread, and everything else (job reports, status updates) goes in the conversation.
   */
  private threadOf(link: Link, ch: Channel, m: Message, depth = 0): string | undefined {
    if (m.meta?.slack) return m.meta.slack.channel === link.conversationId ? m.meta.slack.thread : undefined;
    const find = (id?: string) => (id ? messages.get(ch.id)?.find((x) => x.id === id) : undefined);
    if (m.author === "user") {
      const to = find(m.meta?.replyTo?.id)?.meta?.slack;
      return to && to.channel === link.conversationId ? (to.thread ?? to.ts) : undefined;
    }
    const answered = find(m.meta?.answers);
    return answered && depth < 20 ? this.threadOf(link, ch, answered, depth + 1) : undefined;
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
      if (at && c) await this.api("chat.update", { channel: at.channel, ts: at.ts, ...c }, this.tokenFor(at.channel));
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
      const ch = channels.get(link.channelId);
      const answers = this.deps.answering(link.channelId, agentId);
      const to = ch && answers && messages.get(ch.id)?.find((x) => x.id === answers);
      this.postAs(look, t.channel, { markdown: TYPING }, { thread: ch && to ? this.threadOf(link, ch, to) : undefined, posted });
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

  /**
   * A teammate's emoji on a message (Mozart's reaction instead of a turn on yours, or its emoji-only answer to yours or
   * to another teammate's) is a reaction on it in Slack too. An emoji Slack has no name for goes as a message under its name.
   */
  private reactions(link: Link, m: Message) {
    for (const x of m.meta?.reactions ?? []) {
      const key = `${m.id}:${x.by}:${x.emoji}`;
      const t = teammate(x.by);
      if (!t || this.reacted.has(key)) continue;
      this.reacted.add(key);
      const name = reactionName(x.emoji);
      if (!name) {
        const ch = channels.get(link.channelId);
        this.postFor(t, link, { markdown: x.emoji }, { thread: ch && this.threadOf(link, ch, m) });
        continue;
      }
      void this.queue(async () => {
        const at = m.meta?.slack; // read now: your message may have gone to Slack only just before
        if (at) await this.reactAs(t.id, at.channel, at.ts, name);
      }, link.conversationId);
    }
  }

  /**
   * A teammate's reaction on a Slack message: from its own bot in a channel it's in (its app needs reactions:write),
   * else from the Harmonia app, which is all a DM or group DM allows.
   */
  private async reactAs(id: string, channel: string, ts: string, name: string) {
    const params = { channel, timestamp: ts, name };
    const lacked = this.noReact.get(id);
    const mate = !lacked || Date.now() - lacked > NO_REACT_RETRY ? await this.mateToken(id, channel) : undefined;
    if (mate) {
      try {
        await slackCall(mate, "reactions.add", params).catch(ignore("already_reacted"));
        if (this.noReact.delete(id)) this.changed();
        return;
      } catch (e: any) {
        if (retryable(e)) throw e; // the queue tries again
        if (e instanceof SlackError && e.code === "missing_scope") {
          // An app made before teammates reacted: Harmonia reacts for it, and the Slack page says how to update it.
          if (!this.noReact.has(id)) this.deps.log("slack.teammate_cant_react", { teammate: id });
          this.noReact.set(id, Date.now());
          this.changed();
        } else this.mateFailed(id, channel, e);
      }
    }
    await this.api("reactions.add", params, this.tokenFor(channel)).catch(ignore("already_reacted"));
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
    const send = async (token: string) => {
      const call = () => this.api("chat.postMessage", params, token);
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
      if (!r) {
        // Else Harmonia posts, except in your DM with a teammate's app: everything there goes out from that app.
        const own = this.tokenFor(channel);
        r = await send(own);
        if (r && own !== this.botToken) by = this.links[channel]?.mate ?? this.mateConvs.get(channel);
      }
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
    const token = this.tokenFor(conv);
    const comment = [`*${escapeSlack(USER_LOOK.name)}*`, m.text.trim() && mrkdwn(m.text)].filter(Boolean).join("\n");
    let refused: unknown;
    const done = await this.queue(async () => {
      try {
        const ids: { id: string; title: string }[] = [];
        for (const f of files) {
          const data = Bun.file(attachmentPath(ch.id, f));
          const up = await this.api("files.getUploadURLExternal", { filename: f.name, length: data.size }, token);
          const r = await fetch(String(up.upload_url), { method: "POST", body: data, signal: AbortSignal.timeout(FILE_TIMEOUT) });
          if (!r.ok) throw new SlackError(`http_${r.status}`, `Slack's upload answered HTTP ${r.status}`);
          ids.push({ id: String(up.file_id), title: f.name });
        }
        const j = await this.api("files.completeUploadExternal", { files: ids, channel_id: conv, initial_comment: comment, ...(thread && { thread_ts: thread }) }, token);
        ids.forEach((x, i) => (files[i].slack = x.id));
        return { ids, first: j.files?.[0] };
      } catch (e) {
        if (retryable(e)) throw e; // the queue tries again
        refused = e;
      }
    }, conv);
    if (!done) {
      const why = refused instanceof SlackError && refused.code === "missing_scope"
        ? `${link.mate ? `${nameOf(link.mate)}'s app` : `the ${APP_NAME} app`} needs the files:write scope (the Slack page shows how to update it)`
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
      ts = shared((await this.api("files.info", { file: done.ids[0].id }, token).catch(() => ({}))).file);
    }
    if (!ts) return this.deps.log("slack.file_ts_unknown", { channelId: ch.id, file: done.ids[0].id });
    (m.meta ??= {}).slack = { channel: conv, ts: String(ts), ...(thread && { thread }) };
    saveMessages(ch.id);
  }

  /** The app's own words, in Slack's mrkdwn (in a thread when `thread` is set). In your DM with a teammate's app, that app's. */
  private say(channel: string, text: string, thread?: string) {
    return this.queue(() => this.api("chat.postMessage", { channel, text, unfurl_links: false, ...(thread && { thread_ts: thread }) }, this.tokenFor(channel)), channel);
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

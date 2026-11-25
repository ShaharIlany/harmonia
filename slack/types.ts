// What the Slack bridge keeps and passes around: its saved settings, the views the Slack page gets, the links to
// Slack conversations, and the callbacks the server gives it. Types only, so every part of the bridge can use them.
import type { Attachment } from "../attachments";
import type { Channel, ChannelStatus, Message, SlackRef } from "../store";
import type { SocketState } from "../slack-socket";
import type { Voice } from "../voice";

export type Config = {
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
export type MateApp = {
  appId: string;
  name: string; // the name it was made (or last updated) with
  botUserId?: string; // set once connected: its messages are skipped, @mentions of it are "@Name"
  botId?: string;
  iconError?: string; // its icon didn't go up
  dms?: boolean; // you can DM it: its app-level token is in the Keychain, and Harmonia listens on its socket
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
  dms: SocketState["state"] | "off"; // your DM with its app: off, or how its socket is doing
  dmDetail?: string;
  dmMissing?: string[]; // scopes its bot token lacks for DMs (update the apps, then reinstall it)
  dmUrl?: string; // your DM with it, in Slack
};

/** A ⚠️ question in your DM: thread replies to it are feedback on that message. */
export type Ask = { channelId: string; messageId: string; at: number };

/** A Slack conversation linked to a Harmonia channel. */
export type Link = {
  conversationId: string; // C… (a channel), G… (private, or an older group), D… (your DM with the app, or with a teammate's)
  kind: "dm" | "channel" | "private" | "group" | "mate"; // mate: your DM with a teammate's own app
  mate?: string; // kind "mate": the teammate
  channelId: string; // the Harmonia channel
  name?: string;
  createdAt: number;
  awaitingProject?: boolean; // a new channel whose project you haven't picked yet: no teammates in it so far
  held?: Held[]; // what you wrote there meanwhile, for the teammates once you pick
};

/** Your message in a channel still waiting for its project: it goes to the teammates once you pick one. */
export type Held = { text: string; slack: SlackRef; files?: Attachment[]; voice?: Voice };
/** A Slack message's files, fetched: `voices` are the ones that are voice notes (voice.ts), `missed` what couldn't be. */
export type Fetched = { files: Attachment[]; voices: { file: Attachment; mp4?: string }[]; missed: string[]; noScope?: boolean };

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

export type LinkView = { conversationId: string; kind: Link["kind"]; mate?: string; channelId: string; name?: string; url?: string };

export type SlackEvent = { type: "slack"; slack: SlackView; links: LinkView[] };

export type Look = { id?: string; name: string; avatar: string };
/** A teammate's "typing…" message: waiting to go out (`timer`), or out (`ts`). `by`: the teammate whose own bot posted it. */
export type Typing = { channel: string; ts?: string; by?: string; timer?: ReturnType<typeof setTimeout> };
/** What a Slack message says: the teammates' Markdown, or the app's own mrkdwn text with blocks (cards, buttons). */
export type Content = { markdown: string } | { text: string; blocks: unknown[] };

export type Deps = {
  emit: (e: SlackEvent) => void;
  /** Posts as you in a channel, exactly like typing it there (from Slack): maybe a reply to a message there, maybe with files. */
  post: (ch: Channel, text: string, from: { replyTo?: string; slack: SlackRef; files?: Attachment[]; voice?: Voice }) => Message;
  /** Someone else's message in a linked Slack conversation: context only. */
  guest: (ch: Channel, name: string, text: string, slackId: string | undefined, slack: SlackRef, files?: Attachment[], voice?: Voice) => void;
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
  /** Tells the page about a channel the bridge changed (its project). */
  channelChanged: (ch: Channel) => void;
  /** Sets a channel's status (`@Harmonia status`, `@Harmonia archive`), as the page does. An error to show, if it can't. */
  setStatus: (ch: Channel, status: ChannelStatus | undefined) => string | undefined;
  /** Sets a channel's ClickUp task (`@Harmonia task`), as the page does; "" clears it. An error to show, if it can't. */
  setTask: (ch: Channel, task: string) => string | undefined;
  /** The message a teammate at work in a channel is answering, if any: its typing message goes in that one's thread. */
  answering: (channelId: string, agentId: string) => string | undefined;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

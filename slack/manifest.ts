// The Slack apps' manifests: Harmonia's own app and each teammate's, with the scopes and events they ask for, and the
// link that opens Slack's "create an app" page with one filled in.
import type { Teammate } from "../roster";
import { slackCall } from "../slack-socket";

/** The app's name in Slack. The commands are written to it: `@Harmonia new channel …`. */
export const APP_NAME = "Harmonia";

/**
 * What the app may do, as bot scopes: read and write in the conversations it's in, post under the teammates' names,
 * create channels and invite you to them, read your reactions and react for a teammate without an app of its own, look
 * up people by id or email, fetch and send files, and bookmark a channel's ClickUp task (slack-marks.ts).
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "bookmarks:write",
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

/**
 * A teammate's own app posts (under its name and avatar) and reacts; in channels, the Harmonia app hears everything.
 * Your DM with it is its own: it reads it (im:history), opens it (im:write), sees your reactions and files there, and
 * sends files to it.
 */
export const MATE_SCOPES = ["chat:write", "chat:write.customize", "reactions:write", "im:history", "im:write", "reactions:read", "files:read", "files:write"];
/** What a teammate's app needs for DMs at all: the rest (reactions, files) only work once it has them too. */
export const MATE_DM_SCOPES = ["im:history", "im:write"];
export const MATE_EVENTS = ["message.im", "reaction_added", "reaction_removed"];

/** The manifest of a teammate's own Slack app: a bot named after it, which you can DM once it has an app-level token. */
export function mateManifest(t: Pick<Teammate, "name" | "role" | "color">) {
  return {
    display_information: {
      name: t.name.slice(0, 35),
      description: `${t.role || "Teammate"}, answering from ${APP_NAME}`.slice(0, 140),
      background_color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#24292f",
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: t.name, always_online: true },
    },
    oauth_config: { scopes: { bot: MATE_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: MATE_EVENTS },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** A teammate's Slack app, made from its manifest with an app configuration token. (Socket Mode: you can DM it.) */
export function createMateApp(token: string, t: Teammate): Promise<any> {
  return slackCall(token, "apps.manifest.create", { manifest: mateManifest(t) });
}

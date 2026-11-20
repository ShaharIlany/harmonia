// Microsoft Teams. Every teammate can be a Teams bot, and so can Mozart, the channels' coordinator.
//
// 1:1 chats: your private Teams chat with a teammate's bot mirrors the channel #teams-<id>. What you write there is
// posted as you, addressed to that teammate; what happens in the channel goes back to Teams.
//
// Teams channels and group chats: each one is linked to a Team Chat channel. With the Mozart bot in it (it reads
// every message, by resource-specific consent), everything you write there lands in the linked channel as your
// message, and the channel's Mozart decides who answers, as it does in the app. Other people's messages land too, as
// context, but never wake a teammate: the teammates work for you and can read your mail. Each teammate answers with
// its own bot when it's in that team or chat, else Mozart posts the answer under the teammate's name; Teams shows
// the teammate typing while it works. What you type in the app goes to Teams through Mozart. Without Mozart, a
// teammate's bot still gets the messages that @mention it.
//
// In a Teams channel every answer is a new post, not a reply in the thread you wrote in.
//
// `@Mozart new channel <name>` creates a standard channel in the team (Microsoft Graph, with Mozart's
// Channel.Create.Group consent, which the team's owner grants by adding Mozart: no admin) and a linked channel here.
// Everyone in the team sees it, so for a private place keep the team to yourself. Teammates' bots installed in the team
// are in every standard channel. (Private channels aren't used: bots can't post in them.)
//
// `@Mozart new group chat <name>` (with people you @mention or name by email) creates a Teams group chat instead: only
// its members see it. Through Microsoft Graph, as Mozart's own app: the chat (Chat.Create), then Mozart and every
// teammate's bot installed in it (TeamsAppInstallation.ReadWriteAndConsentForChat.All, with Mozart's consent to read
// the chat), and a linked channel here. Those two are tenant-wide permissions an admin approves once, and the bots must
// be in the organization's app catalog for Graph to install them (AppCatalog.Read.All finds their catalog ids).
//
// Bots are made with Microsoft's Teams CLI (`teams app create --messaging-mode socket`) from the Microsoft Teams page,
// and connect over Socket Mode (teams-socket.ts): nothing listens on the internet. Only the Microsoft Entra user who
// made the bots can wake the teammates.
//
// Kept in the data folder: teams.json (the bots: ids, the paired 1:1 chat, where they're installed) and
// teams-links.json (linked channels and group chats, known teams). Each bot's client secret is in the Keychain.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DEFAULT_CWD } from "./paths";
import { ROSTER, USER_NAME, nameOf, teammate } from "./roster";
import { channels, createChannel, type Channel, type Message } from "./store";
import type { Event } from "./team";
import { TeamsSocket, botTokens, type Activity, type SocketState } from "./teams-socket";

const FILE = join(DATA, "teams.json");
const LINKS_FILE = join(DATA, "teams-links.json");
const KEYCHAIN_SERVICE = "Team Chat Teams bot";
const TYPING_EVERY = 3_000; // Teams clears a bot's typing indicator after a few seconds
const SEND_RETRIES = [2_000, 5_000, 15_000];
const MEMBERS_EVERY = 10 * 60_000; // how often a linked conversation's installed bots are looked up again
const GRAPH = "https://graph.microsoft.com/v1.0";

/** The bot id of the coordinator. Every other bot id is a teammate's id. */
export const MOZART = "mozart";
export const MOZART_LOOK = { id: MOZART, name: "Mozart", avatar: "🎼", color: "#7c3aed", role: "Coordinator" };
/**
 * Mozart's resource-specific consent: read every message in the team's channels and in group chats it's in, create
 * channels, and see which apps (the teammates' bots) are installed there. Granted by whoever adds it to a team or chat.
 */
export const MOZART_RSC = ["ChannelMessage.Read.Group", "ChatMessage.Read.Chat", "Channel.Create.Group", "TeamsAppInstallation.Read.Group", "TeamsAppInstallation.Read.Chat"];
/** Mozart's chat-scoped consent, granted when it installs itself in a chat it made. */
const MOZART_CHAT_RSC = MOZART_RSC.filter((p) => p.endsWith(".Chat"));
/**
 * Microsoft Graph application permissions for Mozart's app, approved once by an admin: create members-only group chats
 * and install apps (with their consent) in them, and find the bots' ids in the organization's app catalog.
 */
export const MOZART_GRAPH = ["Chat.Create", "TeamsAppInstallation.ReadWriteAndConsentForChat.All", "AppCatalog.Read.All"];

export type BotRecord = {
  agentId: string; // a teammate's id, or "mozart"
  botId: string; // the Microsoft Entra app id
  teamsAppId: string;
  tenantId: string;
  ownerAadId?: string; // the only Microsoft Entra user who wakes teammates (set on the first message when unknown)
  channelId?: string; // teammates: the Team Chat channel their 1:1 chat mirrors
  conversationId?: string; // your 1:1 chat with it, once Teams told us about it
  serviceUrl?: string;
  installedIn?: string[]; // teams (their id) and group chats it's in
  rscError?: string; // Mozart: setting its permissions failed
  catalogId?: string; // its id in the organization's app catalog (Graph installs it by this id)
  enabled: boolean;
  createdAt: number;
};

/** A Teams channel or group chat linked to a Team Chat channel. */
export type Link = {
  conversationId: string; // the channel ("19:…@thread.tacv2") or group chat ("19:…@thread.v2"), without ";messageid="
  kind: "channel" | "groupChat";
  channelId: string; // the Team Chat channel
  serviceUrl: string;
  tenantId: string;
  teamId?: string; // channel: its team's id (the conversation id of the team's General channel)
  name?: string;
  createdAt: number;
};

/** A team a bot is in (its name, for the linked conversations list). */
type KnownTeam = { id: string; groupId?: string; name?: string; serviceUrl: string; tenantId: string };

export type BotView = {
  agentId: string;
  botId: string;
  enabled: boolean;
  state: SocketState["state"] | "off";
  detail?: string;
  paired: boolean;
  channelId?: string;
  installLink: string;
  portalLink: string;
  rscError?: string;
};

export type LinkView = { conversationId: string; kind: Link["kind"]; channelId: string; name?: string; team?: string; bots: string[] };

export type CliStatus = {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  username?: string;
  tenantId?: string;
  userObjectId?: string;
  sideloading?: boolean;
  error?: string;
};

export type TeamsEvent = { type: "teams"; teams: BotView[]; links: LinkView[] };

/** What Mozart needs from an admin for `new channel`, and whether it has it. */
export type AdminStatus = {
  granted: string[];
  missing: string[];
  catalog: Record<string, string | null>; // bot id → its catalog id, or null when it isn't in the org's catalog
  consentLink: string; // grants what's configured on the app registration
  permissionsLink: string; // the app registration's API permissions, in the Entra admin center
  error?: string;
};

type Deps = {
  emit: (e: TeamsEvent) => void;
  /** Posts as you in a channel, exactly like typing it there (from Teams). */
  post: (ch: Channel, text: string) => void;
  /** Someone else's message in a linked Teams chat: context only. */
  guest: (ch: Channel, name: string, text: string, aadId?: string) => void;
  /** A note in a channel (from Teams, so it isn't sent back there). */
  note: (ch: Channel, text: string) => void;
  /** Tells the page about a channel the bridge created. */
  channelCreated: (ch: Channel) => void;
  /** Who works in a channel right now. */
  activityFor: (channelId: string) => { agentId: string }[];
  log: (event: string, fields?: Record<string, unknown>) => void;
};

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

/** What a bot looks like: its teammate, or Mozart. */
export const lookOf = (id: string) => (id === MOZART ? MOZART_LOOK : teammate(id));
/** A channel message's conversation id carries ";messageid=<thread root>"; the channel itself is the part before it. */
export const baseId = (conversationId: string) => conversationId.split(";")[0];

export class TeamsBridge {
  private records: Record<string, BotRecord> = readJson(FILE, {});
  private links: Record<string, Link>;
  private knownTeams: Record<string, KnownTeam>;
  private live = new Map<string, LiveBot>();
  private seen = new Set<string>(); // messages already taken in (Mozart and a mentioned bot both get them)
  private typing = new Map<string, ReturnType<typeof setInterval>>(); // `${channelId}:${agentId}` in linked channels
  private membersAt = new Map<string, number>();

  constructor(private deps: Deps) {
    const saved = readJson<{ links?: Record<string, Link>; teams?: Record<string, KnownTeam> }>(LINKS_FILE, {});
    this.links = saved.links ?? {};
    this.knownTeams = saved.teams ?? {};
  }

  /** Connects every enabled bot. */
  start() {
    for (const r of Object.values(this.records)) if (r.enabled) void this.connect(r);
  }

  stop() {
    for (const b of this.live.values()) b.stop();
    this.live.clear();
    for (const t of this.typing.values()) clearInterval(t);
    this.typing.clear();
  }

  status(): BotView[] {
    return Object.values(this.records).map((r) => {
      const s: { state: BotView["state"]; detail?: string } = this.live.get(r.agentId)?.state ?? { state: r.enabled ? "connecting" : "off" };
      return {
        agentId: r.agentId,
        botId: r.botId,
        enabled: r.enabled,
        state: r.enabled ? s.state : "off",
        detail: s.detail,
        paired: Boolean(r.conversationId),
        channelId: r.channelId,
        installLink: `https://teams.microsoft.com/l/app/${r.teamsAppId}?installAppPackage=true&appTenantId=${r.tenantId}`,
        portalLink: `https://dev.teams.microsoft.com/apps/${r.teamsAppId}`,
        rscError: r.rscError,
      };
    });
  }

  linkViews(): LinkView[] {
    return Object.values(this.links).map((l) => ({
      conversationId: l.conversationId,
      kind: l.kind,
      channelId: l.channelId,
      name: l.name,
      team: l.teamId ? this.knownTeams[l.teamId]?.name : undefined,
      bots: Object.values(this.records).filter((r) => r.installedIn?.includes(memberKey(l))).map((r) => r.agentId),
    }));
  }

  changed = () => this.deps.emit({ type: "teams", teams: this.status(), links: this.linkViews() });

  save() {
    writeFileSync(FILE, JSON.stringify(this.records, null, 1), { mode: 0o600 });
  }

  private saveLinks() {
    writeFileSync(LINKS_FILE, JSON.stringify({ links: this.links, teams: this.knownTeams }, null, 1), { mode: 0o600 });
  }

  /** The Microsoft Entra user the teammates work for. */
  owner(): string | undefined {
    return this.records[MOZART]?.ownerAadId ?? Object.values(this.records).find((r) => r.ownerAadId)?.ownerAadId;
  }

  isBot = (aadOrChannelId?: string) => Boolean(aadOrChannelId && /^28:/.test(aadOrChannelId));
  agentForBot = (botChannelId: string) => Object.values(this.records).find((r) => `28:${r.botId}` === botChannelId)?.agentId;

  /** Every server event: 1:1 mirrors and linked channels and chats. */
  onEvent(e: Event) {
    for (const b of this.live.values()) b.onEvent(e);
    if (!("channelId" in e)) return;
    const link = Object.values(this.links).find((l) => l.channelId === e.channelId);
    if (link) this.toShared(link, e);
  }

  // ---------- Setup ----------

  async cliStatus(): Promise<CliStatus> {
    const r = await teamsCli(["status", "--json"], 60_000);
    if (r.missing) return { installed: false };
    try {
      const j = JSON.parse(jsonPart(r.out));
      return {
        installed: true,
        version: j.cliVersion?.current,
        loggedIn: Boolean(j.loggedIn),
        username: j.username,
        tenantId: j.tenantId,
        userObjectId: j.userObjectId,
        sideloading: j.tdp?.sideloading ? Boolean(j.tdp.sideloading.tenant && j.tdp.sideloading.user) : undefined,
      };
    } catch {
      return { installed: true, error: clip(r.err || r.out) || `teams status failed (exit ${r.code})` };
    }
  }

  /** Creates a bot (a teammate's, or Mozart) with the Teams CLI, keeps the secret in the Keychain, and connects it. Returns an error to show. */
  async create(agentId: string, icons: { color: string; outline: string }): Promise<string | undefined> {
    const t = lookOf(agentId);
    if (!t) return "No such teammate.";
    if (this.records[agentId]) return `${t.name} already has a bot.`;
    const cli = await this.cliStatus();
    if (!cli.installed) return "Install the Teams CLI first (step 1).";
    if (!cli.loggedIn) return "Sign in to the Teams CLI first (step 1).";
    const dir = mkdtempSync(join(DATA, "teams-new-"));
    chmodSync(dir, 0o700);
    try {
      const color = join(dir, "color.png");
      const outline = join(dir, "outline.png");
      writeFileSync(color, png(icons.color));
      writeFileSync(outline, png(icons.outline));
      const env = join(dir, "bot.env");
      const r = await teamsCli(
        ["app", "create", "--name", t.name, "--messaging-mode", "socket", "--sign-in-audience", "myOrg", "--env", env, "--color-icon", color, "--outline-icon", outline, "--json"],
        180_000,
      );
      let out: any = {};
      try {
        out = JSON.parse(jsonPart(r.out));
      } catch {}
      const creds = parseEnv(safeRead(env));
      if (!creds.CLIENT_ID || !creds.CLIENT_SECRET || !creds.TENANT_ID) return `teams app create failed: ${clip(r.err || r.out) || `exit ${r.code}`}`;
      const err = await this.add(agentId, { clientId: creds.CLIENT_ID, secret: creds.CLIENT_SECRET, tenantId: creds.TENANT_ID, teamsAppId: out.teamsAppId }, cli);
      if (err) return err;
      this.deps.log("teams.bot_created", { agentId, botId: creds.CLIENT_ID });
      if (out.socketMode === false)
        return `The bot was created, but Socket Mode wasn't turned on: ${out.socketModeError ?? "unknown error"}. Run: teams app update ${out.teamsAppId ?? creds.CLIENT_ID} --messaging-mode socket`;
      if (agentId === MOZART) return this.grantMozart();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Mozart's resource-specific consent (MOZART_RSC), set in its app manifest with the Teams CLI. */
  async grantMozart(): Promise<string | undefined> {
    const r = this.records[MOZART];
    if (!r) return "There's no Mozart bot yet.";
    const out = await teamsCli(["app", "rsc", "set", r.teamsAppId, "--permissions", MOZART_RSC.join(","), "--json"], 120_000);
    r.rscError = out.code === 0 ? undefined : clip(out.err || out.out) || `teams app rsc set failed (exit ${out.code})`;
    this.save();
    this.changed();
    if (r.rscError) return `Mozart's bot is there, but its permissions weren't set: ${r.rscError}. Try "Set permissions" again, or run: teams app rsc set ${r.teamsAppId} --permissions ${MOZART_RSC.join(",")}`;
    this.deps.log("teams.mozart_rsc", { teamsAppId: r.teamsAppId });
  }

  /** Uses a bot you already made (an env file `teams app create --env` wrote: CLIENT_ID, CLIENT_SECRET, TENANT_ID). */
  async importEnv(agentId: string, path: string, teamsAppId?: string): Promise<string | undefined> {
    const t = lookOf(agentId);
    if (!t) return "No such teammate.";
    if (this.records[agentId]) return `${t.name} already has a bot.`;
    const text = safeRead(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (text === undefined) return `Can't read ${path}.`;
    const creds = parseEnv(text);
    if (!creds.CLIENT_ID || !creds.CLIENT_SECRET || !creds.TENANT_ID) return "The file needs CLIENT_ID, CLIENT_SECRET and TENANT_ID.";
    const cli = await this.cliStatus();
    const err = await this.add(agentId, { clientId: creds.CLIENT_ID, secret: creds.CLIENT_SECRET, tenantId: creds.TENANT_ID, teamsAppId: teamsAppId || creds.TEAMS_APP_ID }, cli);
    if (err || agentId !== MOZART) return err;
    return this.grantMozart();
  }

  private async add(agentId: string, c: { clientId: string; secret: string; tenantId: string; teamsAppId?: string }, cli: CliStatus) {
    const saved = await keychain(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", c.clientId, "-w", c.secret]);
    if (saved.code !== 0) return `Couldn't save the bot's secret in the Keychain: ${clip(saved.err)}`;
    const r: BotRecord = {
      agentId,
      botId: c.clientId,
      teamsAppId: c.teamsAppId || c.clientId,
      tenantId: c.tenantId,
      // The CLI's account made the bot; without it, the first person to write to the bot (in its tenant) claims it.
      ownerAadId: (cli.tenantId === c.tenantId ? cli.userObjectId : undefined) ?? this.owner(),
      enabled: true,
      createdAt: Date.now(),
    };
    this.records[agentId] = r;
    this.save();
    await this.connect(r);
  }

  setEnabled(agentId: string, enabled: boolean): string | undefined {
    const r = this.records[agentId];
    if (!r) return "No bot for this teammate.";
    r.enabled = enabled;
    this.save();
    this.live.get(agentId)?.stop();
    this.live.delete(agentId);
    if (enabled) void this.connect(r);
    else this.changed();
  }

  /** Forgets the bot here (and its secret). Its registration stays in Microsoft's Developer Portal. */
  async remove(agentId: string): Promise<string | undefined> {
    const r = this.records[agentId];
    if (!r) return "No bot for this teammate.";
    this.live.get(agentId)?.stop();
    this.live.delete(agentId);
    await keychain(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", r.botId]);
    delete this.records[agentId];
    this.save();
    this.changed();
  }

  /** Stops mirroring a Teams channel or group chat. Both sides keep their messages. */
  unlink(conversationId: string): string | undefined {
    const l = this.links[conversationId];
    if (!l) return "That Teams conversation isn't linked.";
    for (const key of [...this.typing.keys()]) if (key.startsWith(l.channelId + ":")) (clearInterval(this.typing.get(key)), this.typing.delete(key));
    delete this.links[conversationId];
    this.saveLinks();
    this.changed();
  }

  private async connect(r: BotRecord) {
    const secret = await keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", r.botId, "-w"]);
    const bot = new LiveBot(r, secret.code === 0 ? secret.out : "", this, this.deps);
    this.live.get(r.agentId)?.stop();
    this.live.set(r.agentId, bot);
    if (secret.code !== 0) bot.fail("The bot's secret is missing from the Keychain. Remove the bot and add it again.");
    else bot.start();
    this.changed();
  }

  // ---------- Where bots are ----------

  /** A bot was added to (or removed from) a team or group chat, or spoke there. */
  noteInstalled(agentId: string, key: string, installed: boolean) {
    const r = this.records[agentId];
    if (!r) return;
    const had = r.installedIn?.includes(key) ?? false;
    if (had === installed) return;
    r.installedIn = installed ? [...(r.installedIn ?? []), key] : (r.installedIn ?? []).filter((k) => k !== key);
    this.save();
    this.changed();
  }

  noteTeam(a: Activity) {
    const team = a.channelData?.team;
    if (!team?.id || !a.serviceUrl) return;
    const was = this.knownTeams[team.id];
    const next: KnownTeam = {
      id: team.id,
      groupId: team.aadGroupId ?? was?.groupId,
      name: team.name ?? was?.name,
      serviceUrl: a.serviceUrl,
      tenantId: a.conversation?.tenantId ?? a.channelData?.tenant?.id ?? was?.tenantId ?? "",
    };
    if (JSON.stringify(next) === JSON.stringify(was)) return;
    this.knownTeams[team.id] = next;
    this.saveLinks();
  }

  /** Which bots are installed in a linked team or chat, from Microsoft Graph (Mozart's consent), now and then. */
  private async refreshMembers(link: Link) {
    const mozart = this.live.get(MOZART);
    const key = memberKey(link);
    if (!mozart || Date.now() - (this.membersAt.get(key) ?? 0) < MEMBERS_EVERY) return;
    this.membersAt.set(key, Date.now());
    const team = link.teamId ? this.knownTeams[link.teamId] : undefined;
    const path = link.kind === "channel" ? (team?.groupId ? `/teams/${team.groupId}/installedApps` : undefined) : `/chats/${encodeURIComponent(link.conversationId)}/installedApps`;
    if (!path) return;
    try {
      // An uploaded (sideloaded) app gets its own id in Teams; the id in its manifest, which we keep, is its externalId.
      const j = await mozart.graph("GET", `${path}?$expand=teamsApp($select=id,externalId)`);
      const apps = new Set<string>((j.value ?? []).flatMap((x: any) => [x.teamsApp?.externalId, x.teamsApp?.id]).filter(Boolean));
      for (const r of Object.values(this.records)) this.noteInstalled(r.agentId, key, apps.has(r.teamsAppId) || Boolean(r.catalogId && apps.has(r.catalogId)));
      this.deps.log("teams.members", { conversation: link.conversationId, bots: Object.values(this.records).filter((r) => r.installedIn?.includes(key)).map((r) => r.agentId) });
    } catch (err: any) {
      this.deps.log("teams.members_failed", { conversation: link.conversationId, error: err.message });
    }
  }

  private installedIn(agentId: string, link: Link) {
    return Boolean(this.live.get(agentId)?.ready && this.records[agentId]?.installedIn?.includes(memberKey(link)));
  }

  // ---------- Teams channels and group chats → Team Chat ----------

  /** A message (or install) in a Teams channel or group chat, from any bot. */
  async shared(bot: LiveBot, a: Activity) {
    const conv = a.conversation!;
    const key = a.channelData?.team?.id ?? baseId(conv.id);
    this.noteTeam(a);

    if (a.type === "installationUpdate" || a.type === "conversationUpdate") {
      const me = `28:${bot.record.botId}`;
      if (a.type === "installationUpdate") this.noteInstalled(bot.agentId, key, !a.action?.startsWith("remove"));
      if (a.membersAdded?.some((m) => m.id === me)) this.noteInstalled(bot.agentId, key, true);
      if (a.membersRemoved?.some((m) => m.id === me)) this.noteInstalled(bot.agentId, key, false);
      // Its hello, unless it's a chat Mozart just made (that gets a welcome of its own).
      if (bot.agentId === MOZART && a.type === "installationUpdate" && a.action === "add" && !this.links[baseId(conv.id)]) {
        const where = a.channelData?.team ? "this team's channels" : "this chat";
        bot.reply(a, `Hi, I'm Mozart 🎼. I connect ${where} to Team Chat: when ${USER_NAME} writes here, I pick the teammate who answers. ${a.channelData?.team ? "**@Mozart new channel <name>** makes a new channel in this team." : "**@Mozart new channel <name>** makes a new channel in your team."}`);
      }
      return;
    }
    if (a.type !== "message" || this.isBot(a.from?.id)) return;
    this.noteInstalled(bot.agentId, key, true); // it got a message there, so it's in
    // With Mozart here, it takes every message in; a teammate's bot only when there's no Mozart.
    if (bot.agentId !== MOZART && this.live.get(MOZART)?.ready && this.records[MOZART]?.installedIn?.includes(key)) return;
    const dedupe = `${baseId(conv.id)}:${a.id}`;
    if (!a.id || this.seen.has(dedupe)) return;
    this.seen.add(dedupe);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);

    const sender = a.from?.aadObjectId;
    const owner = this.owner();
    const yours = Boolean(sender) && sender === owner;
    const mentionsMozart = (a.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === `28:${this.records[MOZART]?.botId}`);
    const text = this.chatText(a);

    if (yours && (bot.agentId === MOZART || mentionsMozart)) {
      const cmd = parseCommand(commandText(a), mentionsMozart || bot.agentId !== MOZART);
      if (cmd) return this.command(bot, a, cmd);
    }
    const base = baseId(conv.id);
    let link = this.links[base];
    if (!link) {
      if (!yours) return; // someone else's chat: nothing to link until you write there
      link = this.autoLink(a);
    }
    if (link.serviceUrl !== a.serviceUrl && a.serviceUrl) link.serviceUrl = a.serviceUrl;
    this.saveLinks();
    void this.refreshMembers(link);

    const ch = channels.get(link.channelId);
    if (!ch) {
      delete this.links[base];
      this.saveLinks();
      return yours ? bot.reply(a, "Its Team Chat channel is gone. Write again to link this conversation to a new one.") : undefined;
    }
    if (!text) return yours ? bot.reply(a, "I can only read text for now.") : undefined;
    if (!yours) return this.deps.guest(ch, a.from?.name ?? "Someone", text, sender);
    if (ch.status === "archived") return bot.reply(a, `#${ch.name} is archived in Team Chat. Unarchive it there and write again.`);
    this.deps.post(ch, text);
  }

  /** A new Team Chat channel for a Teams channel or group chat you wrote in. */
  private autoLink(a: Activity): Link {
    const conv = a.conversation!;
    const team = a.channelData?.team;
    const kind: Link["kind"] = team ? "channel" : "groupChat";
    const name = kind === "channel" ? (a.channelData?.channel?.name ?? (a.channelData?.channel?.id === team?.id ? "General" : "channel")) : (conv.name ?? "group chat");
    const ch = createChannel(kind === "channel" && team?.name ? `${team.name} ${name}` : `teams ${name}`, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const link: Link = {
      conversationId: baseId(conv.id),
      kind,
      channelId: ch.id,
      serviceUrl: a.serviceUrl!,
      tenantId: conv.tenantId ?? a.channelData?.tenant?.id ?? "",
      teamId: team?.id,
      name,
      createdAt: Date.now(),
    };
    this.links[link.conversationId] = link;
    this.saveLinks();
    this.deps.note(ch, `Linked to Microsoft Teams: ${kind === "channel" ? `${team?.name ? `${team.name} › ` : ""}${name}` : `the group chat "${name}"`}.`);
    this.changed();
    this.deps.log("teams.linked", { conversation: link.conversationId, channelId: ch.id, kind });
    return link;
  }

  /** The message as the teammates read it: Teams' HTML as text, bot mentions as @Name (Mozart's dropped). */
  chatText(a: Activity): string {
    let html = a.text ?? "";
    for (const e of a.entities ?? []) {
      if (e.type !== "mention" || !e.text || !e.mentioned?.id) continue;
      const agentId = this.agentForBot(e.mentioned.id);
      const look = agentId && agentId !== MOZART ? teammate(agentId) : undefined;
      html = html.split(e.text).join(agentId === MOZART ? "" : look ? `@${look.name}` : e.mentioned.name ?? "");
    }
    return plainText(html);
  }

  // ---------- Mozart's commands ----------

  async command(bot: LiveBot, a: Activity, cmd: Command) {
    if (cmd.kind === "help")
      return bot.reply(
        a,
        [
          "**Mozart** 🎼 links Teams to Team Chat. In a linked group chat or channel, write as usual and I pick who answers (or @mention a teammate).",
          "- **@Mozart new channel <name>**: a new channel in the team, linked to a new Team Chat channel. Everyone in the team sees it.",
          "- **@Mozart new group chat <name>**: a members-only group chat with you and the teammates instead. @mention people (or write their email) to add them too. Needs an admin's approval once.",
          "- **@Mozart help**: this.",
        ].join("\n"),
      );
    if (cmd.kind === "newChat") {
      const err = await this.newChat(cmd.name, a);
      if (err) bot.reply(a, `Couldn't create it: ${err}`);
      return;
    }
    const team = a.channelData?.team?.id ? this.knownTeams[a.channelData.team.id] : soleTeam(this.knownTeams);
    if (!team)
      return bot.reply(a, Object.keys(this.knownTeams).length ? "Which team? Ask me in one of that team's channels." : "Add me to a team first, then ask me in one of its channels.");
    const err = await this.newChannel(team, cmd.name, a);
    if (err) bot.reply(a, `Couldn't create the channel: ${err}`);
  }

  /** `new channel`: a standard channel in the team (Graph, Mozart's Channel.Create.Group consent) and a Team Chat channel linked to it. */
  private async newChannel(team: KnownTeam, wanted: string, a: Activity): Promise<string | undefined> {
    const mozart = this.mozartBot();
    if (!mozart) return "Mozart isn't connected.";
    if (!team.groupId) return "Teams didn't say which Microsoft 365 group this team is. Ask me in one of its channels.";
    const displayName = teamsChannelName(wanted);
    if (!displayName) return "Give it a name: @Mozart new channel <name>.";
    let made: any;
    try {
      made = await mozart.graph("POST", `/teams/${team.groupId}/channels`, {
        displayName,
        description: "Linked to Team Chat: teammates answer here.",
        membershipType: "standard",
      });
    } catch (err: any) {
      return /403|Forbidden/i.test(err.message)
        ? `Teams refused (${err.message}). Mozart needs the Channel.Create.Group permission in this team: remove Mozart from the team and add it again, and accept its permissions.`
        : err.message;
    }
    const ch = createChannel(displayName, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const link: Link = {
      conversationId: String(made.id),
      kind: "channel",
      channelId: ch.id,
      serviceUrl: team.serviceUrl,
      tenantId: team.tenantId,
      teamId: team.id,
      name: displayName,
      createdAt: Date.now(),
    };
    this.links[link.conversationId] = link;
    this.saveLinks();
    this.membersAt.delete(memberKey(link));
    await this.refreshMembers(link);
    const bots = Object.values(this.records).filter((r) => r.agentId !== MOZART);
    const inTeam = bots.filter((r) => r.installedIn?.includes(team.id));
    const missing = ROSTER.filter((t) => !inTeam.some((r) => r.agentId === t.id));
    const who = (list: { agentId: string }[]) => list.map((r) => `${teammate(r.agentId)?.avatar ?? ""} ${nameOf(r.agentId)}`.trim()).join(", ");
    const lines = [
      `This channel is **#${ch.name}** in Team Chat. Write here and I'll pick the teammate who answers, or @mention one.`,
      inTeam.length ? `In this team: ${who(inTeam)}.` : "",
      missing.length
        ? `Not in this team yet: ${missing
            .map((t) => {
              const r = bots.find((b) => b.agentId === t.id);
              return r ? `[${t.name}](https://teams.microsoft.com/l/app/${r.teamsAppId}?installAppPackage=true&appTenantId=${r.tenantId})` : `${t.name} (no bot yet)`;
            })
            .join(", ")}. Add them to the team and they're in every standard channel. Until then I answer for them.`
        : "",
    ].filter(Boolean);
    await mozart.send({ type: "message", text: lines.join("\n\n"), textFormat: "markdown" }, { serviceUrl: link.serviceUrl, conversationId: link.conversationId });
    this.deps.note(ch, `Created from Microsoft Teams: ${team.name ? `${team.name} › ` : ""}${displayName}, linked to this channel.`);
    mozart.reply(a, `Created **${displayName}**${made.webUrl ? ` ([open](${made.webUrl}))` : ""}, linked to #${ch.name} in Team Chat.`);
    this.changed();
    this.deps.log("teams.channel_created", { team: team.id, conversation: link.conversationId, channelId: ch.id });
  }

  /** People named in a command: @mentions of people (not bots), by their Entra id, and email addresses. */
  private async people(a: Activity): Promise<{ ids: string[]; unknown: string[] }> {
    const mozart = this.live.get(MOZART)!;
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const e of a.entities ?? []) {
      const id = e.mentioned?.id;
      if (e.type !== "mention" || !id || this.isBot(id)) continue;
      try {
        const m = await mozart.member(a.serviceUrl!, a.conversation!.id, id);
        if (m.aadObjectId) ids.add(m.aadObjectId);
        else unknown.push(e.mentioned?.name ?? id);
      } catch {
        unknown.push(e.mentioned?.name ?? id);
      }
    }
    for (const email of plainText(a.text ?? "").match(EMAIL) ?? []) ids.add(email.toLowerCase());
    return { ids: [...ids].filter((x) => x !== this.owner()), unknown };
  }

  /**
   * `new channel`: a members-only Teams group chat (you, the people named, Mozart and the teammates' bots, all through
   * Graph) linked to a new Team Chat channel.
   */
  private async newChat(wanted: string, a: Activity): Promise<string | undefined> {
    const mozart = this.mozartBot();
    if (!mozart) return "Mozart isn't connected.";
    const owner = this.owner();
    if (!owner) return "I don't know who you are in Microsoft 365 yet. Write to me once in our 1:1 chat.";
    const topic = chatTopic(wanted);
    if (!topic) return "Give it a name: @Mozart new channel <name>.";
    const roles = await mozart.graphRoles(true).catch(() => [] as string[]);
    const missing = MOZART_GRAPH.slice(0, 2).filter((r) => !roles.includes(r));
    if (missing.length) return `Mozart's app needs an admin's approval for ${missing.join(" and ")} first (Team Chat → Microsoft Teams → Channels and group chats).`;
    const people = await this.people(a);
    if (people.unknown.length) return `I couldn't tell who ${people.unknown.join(", ")} ${people.unknown.length > 1 ? "are" : "is"} in Microsoft 365. Write their email instead.`;

    const member = (id: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `${GRAPH}/users('${id.replace(/'/g, "''")}')`, // an Entra id or an email (OData quotes doubled)
    });
    let chat: any;
    try {
      chat = await mozart.graph("POST", "/chats", { chatType: "group", topic, members: [owner, ...people.ids].map(member) });
    } catch (err: any) {
      return err.message;
    }
    const serviceUrl = a.serviceUrl ?? this.records[MOZART]?.serviceUrl ?? "";
    const ch = createChannel(topic, DEFAULT_CWD);
    this.deps.channelCreated(ch);
    const link: Link = { conversationId: String(chat.id), kind: "groupChat", channelId: ch.id, serviceUrl, tenantId: this.records[MOZART]!.tenantId, name: topic, createdAt: Date.now() };
    this.links[link.conversationId] = link;
    this.saveLinks();
    this.changed();

    // Mozart first (with its consent to read the chat), then every teammate's bot.
    const failed: string[] = [];
    for (const r of [this.records[MOZART]!, ...Object.values(this.records).filter((x) => x.agentId !== MOZART)]) {
      const err = await this.install(mozart, r, link.conversationId);
      if (err) failed.push(`${lookOf(r.agentId)?.name ?? r.agentId} (${err})`);
      else this.noteInstalled(r.agentId, link.conversationId, true);
    }
    const noBot = ROSTER.filter((t) => !this.records[t.id]).map((t) => t.name);
    const inIt = Object.values(this.records).filter((r) => r.agentId !== MOZART && r.installedIn?.includes(link.conversationId)).map((r) => `${teammate(r.agentId)?.avatar ?? ""} ${nameOf(r.agentId)}`.trim());
    const lines = [
      `This chat is **#${ch.name}** in Team Chat. Only its members see it. Write here and I'll pick the teammate who answers, or @mention one.`,
      inIt.length ? `Here: ${inIt.join(", ")}.` : "",
      noBot.length ? `No Teams bot yet: ${noBot.join(", ")}. I answer for them.` : "",
    ].filter(Boolean);
    await Bun.sleep(2_000); // a just-installed bot can take a moment to be allowed to post
    await mozart.send({ type: "message", text: lines.join("\n\n"), textFormat: "markdown" }, { serviceUrl, conversationId: link.conversationId });
    this.deps.note(ch, `Created from Microsoft Teams: the group chat "${topic}", linked to this channel. Only its members see it.`);
    if (failed.length) this.deps.note(ch, `Couldn't add to the Teams chat: ${failed.join("; ")}.`);
    mozart.reply(
      a,
      `Created the group chat **${topic}**${chat.webUrl ? ` ([open](${chat.webUrl}))` : ""}, linked to #${ch.name} in Team Chat.${failed.length ? `\n\nCouldn't add: ${failed.join("; ")}.` : ""}`,
    );
    this.deps.log("teams.chat_created", { conversation: link.conversationId, channelId: ch.id, failed: failed.length });
  }

  /** Installs a bot's Teams app in a chat (Graph, by its id in the org's catalog). Returns an error to show. */
  private async install(mozart: LiveBot, r: BotRecord, chatId: string): Promise<string | undefined> {
    const id = await this.catalogId(mozart, r);
    if (!id) return "not in your organization's app catalog";
    try {
      await mozart.graph("POST", `/chats/${encodeURIComponent(chatId)}/installedApps`, {
        "teamsApp@odata.bind": `${GRAPH}/appCatalogs/teamsApps/${id}`,
        ...(r.agentId === MOZART && {
          consentedPermissionSet: { resourceSpecificPermissions: MOZART_CHAT_RSC.map((permissionValue) => ({ permissionValue, permissionType: "Application" })) },
        }),
      });
    } catch (err: any) {
      if (/409/.test(err.message)) return; // already there
      return err.message.replace(/^Microsoft Graph answered /, "");
    }
  }

  /** A bot's id in the organization's app catalog, looked up by its manifest id once and kept. */
  private async catalogId(mozart: LiveBot, r: BotRecord): Promise<string | null> {
    if (r.catalogId) return r.catalogId;
    try {
      const j = await mozart.graph("GET", `/appCatalogs/teamsApps?$filter=${encodeURIComponent(`externalId eq '${r.teamsAppId}'`)}`);
      const id = j.value?.[0]?.id;
      if (!id) return null;
      r.catalogId = id;
      this.save();
      return id;
    } catch {
      return null;
    }
  }

  /** What Mozart has from an admin (its Graph token's roles), and which bots are in the org's catalog. */
  async adminStatus(): Promise<AdminStatus> {
    const r = this.records[MOZART];
    const links = r
      ? {
          consentLink: `https://login.microsoftonline.com/${r.tenantId}/adminconsent?client_id=${r.botId}`,
          permissionsLink: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${r.botId}`,
        }
      : { consentLink: "", permissionsLink: "" };
    const mozart = this.live.get(MOZART);
    if (!r || !mozart?.ready) return { granted: [], missing: MOZART_GRAPH, catalog: {}, ...links, error: r ? "Mozart isn't connected." : "There's no Mozart bot yet." };
    let roles: string[] = [];
    let error: string | undefined;
    try {
      roles = await mozart.graphRoles(true);
    } catch (e: any) {
      error = e.message;
    }
    const catalog: Record<string, string | null> = {};
    if (roles.includes("AppCatalog.Read.All")) for (const b of Object.values(this.records)) catalog[b.agentId] = await this.catalogId(mozart, b);
    return { granted: MOZART_GRAPH.filter((p) => roles.includes(p)), missing: MOZART_GRAPH.filter((p) => !roles.includes(p)), catalog, ...links, error };
  }

  // ---------- Team Chat → linked Teams channels and group chats ----------

  /** Mozart's bot, when it's connected: it speaks for anyone without a bot of their own in a linked conversation. */
  private mozartBot() {
    const m = this.live.get(MOZART);
    return m?.ready ? m : undefined;
  }

  private toShared(link: Link, e: Event) {
    // The channel itself, never a thread in it: in a Teams channel each message is a new post.
    const target = { serviceUrl: link.serviceUrl, conversationId: link.conversationId };
    if (e.type === "activity") {
      if (!teammate(e.agentId)) return;
      const key = `${link.channelId}:${e.agentId}`;
      // Its own bot types when it's there; otherwise Mozart, which posts the answer for it.
      const bot = this.installedIn(e.agentId, link) ? this.live.get(e.agentId) : this.mozartBot();
      if (e.status && bot && !this.typing.has(key)) {
        bot.typeOnce(target);
        this.typing.set(key, setInterval(() => bot.typeOnce(target), TYPING_EVERY));
      } else if (!e.status && this.typing.has(key)) {
        clearInterval(this.typing.get(key));
        this.typing.delete(key);
      }
      return;
    }
    if (e.type !== "message") return;
    const m = e.message;
    if (m.meta?.via === "teams" || m.author === "guest") return;
    const mozart = this.mozartBot();
    if (m.author === "user") return void mozart?.send({ type: "message", text: `**${USER_NAME}** (in Team Chat): ${m.text}`, textFormat: "markdown" }, target);
    if (m.author === "system") return void mozart?.send({ type: "message", text: `_${m.text}_`, textFormat: "markdown" }, target);
    if (!teammate(m.author)) return;
    const own = this.installedIn(m.author, link) ? this.live.get(m.author) : undefined;
    const text = relayText(m, own ? m.author : MOZART);
    if (!text) return;
    if (own) return void own.send({ type: "message", text, textFormat: "markdown" }, target);
    void mozart?.send({ type: "message", text, textFormat: "markdown" }, target);
  }
}

// ---------- One bot ----------

class LiveBot {
  state: SocketState = { state: "connecting" };
  private socket?: TeamsSocket;
  private graphToken?: () => Promise<string>;
  private working = new Set<string>();
  private typing?: ReturnType<typeof setInterval>;
  private sending: Promise<void> = Promise.resolve();
  private reacted = new Set<string>();
  readonly agentId: string;
  private name: string;

  constructor(
    readonly record: BotRecord,
    private secret: string,
    private bridge: TeamsBridge,
    private deps: Deps,
  ) {
    this.agentId = record.agentId;
    this.name = lookOf(record.agentId)?.name ?? record.agentId;
  }

  get ready() {
    return this.state.state === "ready";
  }

  private get mirrors() {
    return this.agentId !== MOZART;
  }

  start() {
    if (this.mirrors) this.channel();
    this.working = new Set(this.record.channelId ? this.deps.activityFor(this.record.channelId).map((a) => a.agentId).filter((id) => teammate(id)) : []);
    const creds = { clientId: this.record.botId, secret: this.secret, tenantId: this.record.tenantId };
    this.graphToken = botTokens(creds, "https://graph.microsoft.com/.default");
    this.socket = new TeamsSocket(
      creds,
      (a) => this.onActivity(a),
      () => {
        this.state = this.socket!.state;
        this.bridge.changed();
      },
      (event, fields) => this.deps.log(event, { agentId: this.agentId, ...fields }),
    );
    this.socket.start();
    this.syncTyping();
  }

  stop() {
    this.socket?.stop();
    clearInterval(this.typing);
    this.typing = undefined;
    this.state = { state: "stopped" };
  }

  fail(detail: string) {
    this.state = { state: "failed", detail };
  }

  /** The Microsoft Graph application permissions an admin granted this bot's app (its token's roles). `fresh`: a new token, after a grant. */
  async graphRoles(fresh = false): Promise<string[]> {
    const creds = { clientId: this.record.botId, secret: this.secret, tenantId: this.record.tenantId };
    if (fresh) this.graphToken = botTokens(creds, "https://graph.microsoft.com/.default");
    if (!this.graphToken) throw new Error("the bot isn't connected");
    const payload = (await this.graphToken()).split(".")[1] ?? "";
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).roles ?? [];
    } catch {
      return [];
    }
  }

  /** A conversation member's details from Teams (their Entra id, for Graph). */
  member(serviceUrl: string, conversationId: string, memberId: string) {
    if (!this.socket) return Promise.reject(new Error("the bot isn't connected"));
    return this.socket.member(serviceUrl, conversationId, memberId);
  }

  /** A Microsoft Graph call as this bot (app-only; Mozart's resource-specific consent applies). */
  async graph(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.graphToken) throw new Error("the bot isn't connected");
    const r = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.graphToken()}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Microsoft Graph answered ${r.status}${j.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : ""}`);
    return j;
  }

  /** The 1:1 chat's mirrored channel, created in the default folder the first time. Undefined while it's archived. */
  private channel(): Channel | undefined {
    const ch = this.record.channelId ? channels.get(this.record.channelId) : undefined;
    if (ch) return ch.status === "archived" ? undefined : ch;
    const made = createChannel(`teams-${this.agentId}`, DEFAULT_CWD);
    this.record.channelId = made.id;
    this.bridge.save();
    this.deps.channelCreated(made);
    return made;
  }

  // ---------- Teams → Team Chat ----------

  private async onActivity(a: Activity) {
    const conv = a.conversation;
    if (!conv) return;
    if (conv.conversationType && conv.conversationType !== "personal") return this.bridge.shared(this, a);
    const sender = a.from?.aadObjectId;
    const owner = this.record.ownerAadId ?? this.bridge.owner();
    const yours = Boolean(sender) && (owner ? sender === owner : conv.tenantId === this.record.tenantId);

    if (a.type === "installationUpdate" || a.type === "conversationUpdate") {
      if (!yours) return;
      if (a.type === "installationUpdate" && a.action?.startsWith("remove")) {
        delete this.record.conversationId;
        this.bridge.save();
        return this.bridge.changed();
      }
      this.pair(a);
      if (a.type === "installationUpdate")
        this.send({
          type: "message",
          text: this.mirrors
            ? `Hi ${USER_NAME} 👋 It's ${this.name}. Write to me here and I'll answer from Team Chat.`
            : `Hi ${USER_NAME} 👋 I'm Mozart 🎼. Add me to a team or group chat and I'll link it to Team Chat. Write **help** for what I can do.`,
        });
      return;
    }
    if (a.type !== "message") return;
    if (!yours) {
      this.deps.log("teams.message_refused", { agentId: this.agentId, sender, tenant: conv.tenantId });
      return this.reply(a, `Sorry, I only work for ${USER_NAME}.`);
    }
    this.pair(a);
    const text = this.bridge.chatText(a);
    if (!text) return this.reply(a, "I can only read text for now.");
    if (!this.mirrors) {
      const cmd = parseCommand(commandText(a), true);
      return cmd ? this.bridge.command(this, a, cmd) : this.reply(a, "Write **help** for what I can do. To talk to the teammates, write in a linked channel or group chat, or to a teammate directly.");
    }
    const ch = this.channel();
    if (!ch) return this.reply(a, `#teams-${this.agentId} is archived in Team Chat. Unarchive it and write again.`);
    this.typeOnce(); // right away; the channel's activity keeps it up while they work
    // Starting with an @name talks to that teammate; anything else is for this bot's teammate.
    this.deps.post(ch, text.startsWith("@") ? text : `@${this.name} ${text}`);
  }

  /** Remembers your 1:1 chat (and claims the bot for you if nobody had). */
  private pair(a: Activity) {
    const changed = this.record.conversationId !== a.conversation!.id || this.record.serviceUrl !== a.serviceUrl || !this.record.ownerAadId;
    if (!changed) return;
    this.record.conversationId = a.conversation!.id;
    this.record.serviceUrl = a.serviceUrl;
    this.record.ownerAadId ??= a.from?.aadObjectId;
    this.bridge.save();
    this.bridge.changed();
  }

  /** An answer in the conversation (and thread) an activity came from. */
  reply(a: Activity, text: string) {
    if (!a.serviceUrl || !a.conversation) return;
    this.send({ type: "message", text, textFormat: "markdown" }, { serviceUrl: a.serviceUrl, conversationId: a.conversation.id });
  }

  // ---------- Team Chat → your 1:1 chat ----------

  onEvent(e: Event) {
    if (!this.mirrors || !("channelId" in e) || e.channelId !== this.record.channelId) return;
    if (e.type === "message") {
      const m = e.message;
      // Your words typed in the app go to Teams too, so the chat there reads whole.
      const text = m.author === "user" ? (m.meta?.via === "teams" ? undefined : `**You** (in Team Chat): ${m.text}`) : relayText(m, this.agentId);
      if (text) this.send({ type: "message", text, textFormat: "markdown" });
    } else if (e.type === "update" && e.message.author === "user") {
      // A teammate's emoji-only answer lands as a reaction on your message; it goes to Teams as a message.
      for (const x of e.message.meta?.reactions ?? []) {
        const key = `${e.message.id}:${x.by}:${x.emoji}`;
        if (x.by === "user" || this.reacted.has(key)) continue;
        this.reacted.add(key);
        this.send({ type: "message", text: x.by === this.agentId ? x.emoji : `**${nameOf(x.by)}:** ${x.emoji}` });
      }
    } else if (e.type === "activity" && teammate(e.agentId)) {
      if (e.status) this.working.add(e.agentId);
      else this.working.delete(e.agentId);
      this.syncTyping();
    }
  }

  /** One send at a time, so bubbles arrive in order; a failed send is retried a few times. Default target: your 1:1 chat. */
  send(activity: Record<string, unknown>, to?: { serviceUrl: string; conversationId: string }): Promise<void> {
    const target = to ?? (this.record.conversationId && this.record.serviceUrl ? { serviceUrl: this.record.serviceUrl, conversationId: this.record.conversationId } : undefined);
    if (!target || !this.socket) return Promise.resolve();
    const socket = this.socket;
    this.sending = this.sending.then(async () => {
      for (let i = 0; ; i++) {
        try {
          return await socket.send(target.serviceUrl, target.conversationId, activity);
        } catch (err: any) {
          // Not in that conversation (removed, or never added): retrying won't help.
          if (i >= SEND_RETRIES.length || /\b(403|404)\b/.test(err.message)) return this.deps.log("teams.send_failed", { agentId: this.agentId, error: err.message });
          await Bun.sleep(SEND_RETRIES[i]);
        }
      }
    });
    return this.sending;
  }

  typeOnce(to?: { serviceUrl: string; conversationId: string }) {
    const target = to ?? (this.record.conversationId && this.record.serviceUrl ? { serviceUrl: this.record.serviceUrl, conversationId: this.record.conversationId } : undefined);
    if (target) this.socket?.send(target.serviceUrl, target.conversationId, { type: "typing" }).catch(() => {});
  }

  private syncTyping() {
    if (this.working.size && !this.typing) {
      this.typeOnce();
      this.typing = setInterval(() => this.typeOnce(), TYPING_EVERY);
    } else if (!this.working.size && this.typing) {
      clearInterval(this.typing);
      this.typing = undefined;
    }
  }
}

// ---------- Helpers ----------

/** The key a bot's presence is kept under: a channel's team, or the group chat itself. */
const memberKey = (l: Link) => l.teamId ?? l.conversationId;

export type Command = { kind: "help" } | { kind: "newChannel"; name: string } | { kind: "newChat"; name: string };

const soleTeam = (teams: Record<string, KnownTeam>) => {
  const all = Object.values(teams);
  return all.length === 1 ? all[0] : undefined;
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A command as typed: Teams' HTML as text, without any @mentions (Mozart's, or the people to add). */
export const commandText = (a: Activity) => plainText((a.text ?? "").replace(/<at>[^<]*<\/at>/gi, " "));

/**
 * Mozart's commands: "new channel <name>" (also "create channel …", "/newchannel …"), "new group chat <name>" (also
 * "new chat …") and "help". In a
 * shared conversation they only count when Mozart was @mentioned (`addressed`), so a sentence that happens to start
 * with "new channel" isn't one. Emails and a trailing "with" (the people to add) aren't part of the name.
 */
export function parseCommand(text: string, addressed: boolean): Command | undefined {
  if (!addressed) return;
  const t = text.trim().replace(/^\/+/, "");
  const m = t.match(/^(?:new|create|add|make)[\s-]?(channel|chat|group[\s-]?chat)\b[\s:]*(.*)$/is);
  if (m) {
    const name = m[2].replace(EMAIL, " ").replace(/(?:[\s,&]|\bwith\b|\band\b)+$/i, "");
    return { kind: /^channel$/i.test(m[1]) ? "newChannel" : "newChat", name: name.trim().replace(/^["“'#]+|["”']+$/g, "").trim() };
  }
  if (/^(help|\?|commands)$/i.test(t)) return { kind: "help" };
}

/** A Teams channel name: at most 50 characters, none of ~ # % & * { } + / \\ : < > ? | ' " and no leading "_" or ".". */
export function teamsChannelName(name: string): string {
  return name
    .replace(/[~#%&*{}+/\\:<>?|'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[_.\s]+/, "")
    .slice(0, 50)
    .trim();
}

/** A group chat's topic: at most 250 characters, and Teams doesn't allow ":" in it. */
export function chatTopic(name: string): string {
  return name.replace(/:/g, " ").replace(/\s+/g, " ").trim().slice(0, 250).trim();
}

/** What a Team Chat message looks like in Teams, or undefined when it stays in the app. `self`: the bot that sends it. */
export function relayText(m: Message, self: string): string | undefined {
  if (m.author === "user" || m.author === "guest") return undefined;
  if (m.author === "system") return `_${m.text}_`;
  const name = nameOf(m.author);
  const prefix = m.author === self ? "" : `**${name}:** `;
  switch (m.kind ?? "text") {
    case "text":
      return m.text.trim() ? prefix + m.text : undefined;
    case "job":
      return `🛠️ ${name} ${m.text}`;
    case "error":
      return `⚠️ ${prefix}${m.text}`;
    case "permission":
      return `🔐 ${name} is waiting for ${USER_NAME}'s OK in Team Chat: ${m.meta?.permission?.summary ?? m.text}`;
    case "tools":
      return `🧰 ${name} asks for more tools in Team Chat: ${m.meta?.toolRequest?.reason ?? m.text}`;
    default:
      return undefined; // job status updates stay in the app
  }
}

/** Teams sends formatted messages as HTML. */
export function plainText(html = ""): string {
  return html
    .replace(/<at>[^<]*<\/at>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
const jsonPart = (s: string) => s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseEnv(text = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** A PNG from a data: URL or base64, checked by its signature. */
function png(data: string): Uint8Array {
  const bytes = Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64");
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("The icon isn't a PNG.");
  return bytes;
}

async function run(cmd: string[], timeoutMs: number, env?: Record<string, string>) {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  } catch {
    return { code: -1, out: "", err: `${cmd[0]} not found`, missing: true };
  }
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
  await p.exited;
  clearTimeout(timer);
  return { code: p.exitCode ?? -1, out, err, missing: false };
}

const teamsCli = (args: string[], timeoutMs: number) => run(["teams", ...args], timeoutMs, { TEAMS_NO_INTERACTIVE: "1", NO_COLOR: "1" });
const keychain = async (args: string[]) => {
  const r = await run(["security", ...args], 15_000);
  return { ...r, out: r.out.trim() };
};

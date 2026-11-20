// Microsoft Teams: any teammate can also be a Teams bot. Your 1:1 Teams chat with the bot mirrors the channel
// #teams-<id>: what you write in Teams is posted there as you, addressed to that teammate, so their chat session
// answers; what the teammates post there goes back to Teams (job starts, errors, and a note when something waits for
// your OK here). Typing shows in Teams while someone works in the channel.
//
// Bots are made with Microsoft's Teams CLI (`teams app create --messaging-mode socket`) from the Microsoft Teams page,
// and connect over Socket Mode (teams-socket.ts): nothing listens on the internet. Only the Microsoft Entra user who
// made the bot can talk to it, and only one-to-one, since the teammates' answers can hold mail and calendar.
//
// Kept in teams.json in the data folder (ids and the paired Teams chat); each bot's client secret is in the Keychain.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DEFAULT_CWD } from "./paths";
import { USER_NAME, nameOf, teammate } from "./roster";
import { channels, createChannel, type Channel, type Message } from "./store";
import type { Event } from "./team";
import { TeamsSocket, type Activity, type SocketState } from "./teams-socket";

const FILE = join(DATA, "teams.json");
const KEYCHAIN_SERVICE = "Team Chat Teams bot";
const TYPING_EVERY = 3_000; // Teams clears a bot's typing indicator after a few seconds
const SEND_RETRIES = [2_000, 5_000, 15_000];

export type BotRecord = {
  agentId: string;
  botId: string; // the Microsoft Entra app id
  teamsAppId: string;
  tenantId: string;
  ownerAadId?: string; // the only Microsoft Entra user it talks to (set on the first message when unknown)
  channelId?: string; // the Team Chat channel it mirrors
  conversationId?: string; // your 1:1 chat with it, once Teams told us about it
  serviceUrl?: string;
  enabled: boolean;
  createdAt: number;
};

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
};

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

export type TeamsEvent = { type: "teams"; teams: BotView[] };

type Deps = {
  emit: (e: TeamsEvent) => void;
  /** Posts as you in a channel, exactly like typing it there. */
  post: (ch: Channel, text: string) => void;
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

export class TeamsBridge {
  private records: Record<string, BotRecord> = readJson(FILE, {});
  private live = new Map<string, LiveBot>();

  constructor(private deps: Deps) {}

  /** Connects every enabled bot. */
  start() {
    for (const r of Object.values(this.records)) if (r.enabled) void this.connect(r);
  }

  stop() {
    for (const b of this.live.values()) b.stop();
    this.live.clear();
  }

  status(): BotView[] {
    return Object.values(this.records).map((r) => {
      const s = this.live.get(r.agentId)?.state ?? (r.enabled ? { state: "connecting" as const } : { state: "off" as const });
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
      };
    });
  }

  changed = () => this.deps.emit({ type: "teams", teams: this.status() });

  save() {
    writeFileSync(FILE, JSON.stringify(this.records, null, 1), { mode: 0o600 });
  }

  /** Every server event; each bot picks its own channel's. */
  onEvent(e: Event) {
    for (const b of this.live.values()) b.onEvent(e);
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

  /** Creates the teammate's bot with the Teams CLI, keeps the secret in the Keychain, and connects it. Returns an error to show. */
  async create(agentId: string, icons: { color: string; outline: string }): Promise<string | undefined> {
    const t = teammate(agentId);
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
      if (out.socketMode === false)
        return `The bot was created, but Socket Mode wasn't turned on: ${out.socketModeError ?? "unknown error"}. Run: teams app update ${out.teamsAppId ?? creds.CLIENT_ID} --messaging-mode socket`;
      this.deps.log("teams.bot_created", { agentId, botId: creds.CLIENT_ID });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Uses a bot you already made (an env file `teams app create --env` wrote: CLIENT_ID, CLIENT_SECRET, TENANT_ID). */
  async importEnv(agentId: string, path: string): Promise<string | undefined> {
    const t = teammate(agentId);
    if (!t) return "No such teammate.";
    if (this.records[agentId]) return `${t.name} already has a bot.`;
    const text = safeRead(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (text === undefined) return `Can't read ${path}.`;
    const creds = parseEnv(text);
    if (!creds.CLIENT_ID || !creds.CLIENT_SECRET || !creds.TENANT_ID) return "The file needs CLIENT_ID, CLIENT_SECRET and TENANT_ID.";
    const cli = await this.cliStatus();
    return this.add(agentId, { clientId: creds.CLIENT_ID, secret: creds.CLIENT_SECRET, tenantId: creds.TENANT_ID }, cli);
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
      ownerAadId: cli.tenantId === c.tenantId ? cli.userObjectId : undefined,
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

  private async connect(r: BotRecord) {
    const secret = await keychain(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", r.botId, "-w"]);
    const bot = new LiveBot(r, secret.code === 0 ? secret.out : "", this, this.deps);
    this.live.get(r.agentId)?.stop();
    this.live.set(r.agentId, bot);
    if (secret.code !== 0) bot.fail("The bot's secret is missing from the Keychain. Remove the bot and add it again.");
    else bot.start();
    this.changed();
  }
}

// ---------- One teammate's bot ----------

class LiveBot {
  state: SocketState = { state: "connecting" };
  private socket?: TeamsSocket;
  private working = new Set<string>();
  private typing?: ReturnType<typeof setInterval>;
  private sending: Promise<void> = Promise.resolve();
  private reacted = new Set<string>();
  private name: string;

  constructor(
    private r: BotRecord,
    private secret: string,
    private bridge: TeamsBridge,
    private deps: Deps,
  ) {
    this.name = nameOf(r.agentId);
  }

  start() {
    this.channel();
    this.working = new Set(this.r.channelId ? this.deps.activityFor(this.r.channelId).map((a) => a.agentId).filter((id) => id !== "router") : []);
    this.socket = new TeamsSocket(
      { clientId: this.r.botId, secret: this.secret, tenantId: this.r.tenantId },
      (a) => this.onActivity(a),
      () => {
        this.state = this.socket!.state;
        this.bridge.changed();
      },
      (event, fields) => this.deps.log(event, { agentId: this.r.agentId, ...fields }),
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

  /** The mirrored channel, created in the default folder the first time. Undefined while it's archived. */
  private channel(): Channel | undefined {
    const ch = this.r.channelId ? channels.get(this.r.channelId) : undefined;
    if (ch) return ch.status === "archived" ? undefined : ch;
    const made = createChannel(`teams-${this.r.agentId}`, DEFAULT_CWD);
    this.r.channelId = made.id;
    this.bridge.save();
    this.deps.channelCreated(made);
    return made;
  }

  // ---------- Teams → Team Chat ----------

  private async onActivity(a: Activity) {
    const conv = a.conversation;
    if (!conv) return;
    const personal = conv.conversationType === "personal";
    const sender = a.from?.aadObjectId;
    const yours = Boolean(sender) && (this.r.ownerAadId ? sender === this.r.ownerAadId : conv.tenantId === this.r.tenantId);

    if (a.type === "installationUpdate" || a.type === "conversationUpdate") {
      if (!personal || !yours) return;
      if (a.type === "installationUpdate" && a.action?.startsWith("remove")) {
        delete this.r.conversationId;
        this.bridge.save();
        return this.bridge.changed();
      }
      this.pair(a);
      if (a.type === "installationUpdate") this.send({ type: "message", text: `Hi ${USER_NAME} 👋 It's ${this.name}. Write to me here and I'll answer from Team Chat.` });
      return;
    }
    if (a.type !== "message") return;
    if (!yours) {
      this.deps.log("teams.message_refused", { agentId: this.r.agentId, sender, tenant: conv.tenantId });
      return this.reply(a, `Sorry, I only work for ${USER_NAME}.`);
    }
    if (!personal) return this.reply(a, `I only talk one-to-one. Open a chat with ${this.name}.`);
    this.pair(a);
    const text = plainText(a.text);
    if (!text) return this.reply(a, "I can only read text for now.");
    const ch = this.channel();
    if (!ch) return this.reply(a, `#teams-${this.r.agentId} is archived in Team Chat. Unarchive it and write again.`);
    this.typeOnce(); // right away; the channel's activity keeps it up while they work
    // Starting with an @name talks to that teammate; anything else is for this bot's teammate.
    this.deps.post(ch, text.startsWith("@") ? text : `@${this.name} ${text}`);
  }

  /** Remembers your 1:1 chat (and claims the bot for you if nobody had). */
  private pair(a: Activity) {
    const changed = this.r.conversationId !== a.conversation!.id || this.r.serviceUrl !== a.serviceUrl || !this.r.ownerAadId;
    if (!changed) return;
    this.r.conversationId = a.conversation!.id;
    this.r.serviceUrl = a.serviceUrl;
    this.r.ownerAadId ??= a.from?.aadObjectId;
    this.bridge.save();
    this.bridge.changed();
  }

  private reply(a: Activity, text: string) {
    if (!a.serviceUrl || !a.conversation) return;
    this.socket?.send(a.serviceUrl, a.conversation.id, { type: "message", text }).catch((err) => this.deps.log("teams.send_failed", { agentId: this.r.agentId, error: err.message }));
  }

  // ---------- Team Chat → Teams ----------

  onEvent(e: Event) {
    if (!("channelId" in e) || e.channelId !== this.r.channelId) return;
    if (e.type === "message") {
      const text = relayText(e.message, this.r.agentId);
      if (text) this.send({ type: "message", text, textFormat: "markdown" });
    } else if (e.type === "update" && e.message.author === "user") {
      // A teammate's emoji-only answer lands as a reaction on your message; it goes to Teams as a message.
      for (const x of e.message.meta?.reactions ?? []) {
        const key = `${e.message.id}:${x.by}:${x.emoji}`;
        if (x.by === "user" || this.reacted.has(key)) continue;
        this.reacted.add(key);
        this.send({ type: "message", text: x.by === this.r.agentId ? x.emoji : `**${nameOf(x.by)}:** ${x.emoji}` });
      }
    } else if (e.type === "activity" && e.agentId !== "router") {
      if (e.status) this.working.add(e.agentId);
      else this.working.delete(e.agentId);
      this.syncTyping();
    }
  }

  /** One send at a time, so bubbles arrive in order; a failed send is retried a few times. */
  private send(activity: Record<string, unknown>) {
    const { conversationId, serviceUrl } = this.r;
    if (!conversationId || !serviceUrl || !this.socket) return;
    const socket = this.socket;
    this.sending = this.sending.then(async () => {
      for (let i = 0; ; i++) {
        try {
          return await socket.send(serviceUrl, conversationId, activity);
        } catch (err: any) {
          if (i >= SEND_RETRIES.length) return this.deps.log("teams.send_failed", { agentId: this.r.agentId, error: err.message });
          await Bun.sleep(SEND_RETRIES[i]);
        }
      }
    });
  }

  private typeOnce() {
    const { conversationId, serviceUrl } = this.r;
    if (conversationId && serviceUrl) this.socket?.send(serviceUrl, conversationId, { type: "typing" }).catch(() => {});
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

/** What a Team Chat message looks like in Teams, or undefined when it stays in the app. */
export function relayText(m: Message, self: string): string | undefined {
  if (m.author === "user") return undefined; // your own words, from Teams or typed here
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
      return `🔐 ${name} is waiting for your OK in Team Chat: ${m.meta?.permission?.summary ?? m.text}`;
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Helpers ----------

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

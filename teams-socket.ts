// Microsoft Teams Socket Mode, without the SDK: the bot dials out to Teams, so it needs no public endpoint or tunnel.
//
//   bot token   client credentials at login.microsoftonline.com/<tenant>, scope api.botframework.com
//   negotiate   POST https://botapi.skype.com/<geo>/v3/websockets/connect → { url, accessToken, expiresIn } (Azure SignalR)
//   socket      the SignalR JSON hub protocol over a WebSocket: Teams sends "SocketReady", then one "Activity"
//               invocation per inbound activity, each answered with an ack frame as the invocation's result
//   rotation    before the token expires, a new connection that replaces the old one (x-ms-socket-replaces-connection-id);
//               the old one closes once the new one is ready
//   sending     plain Bot Connector REST: POST <serviceUrl>/v3/conversations/<id>/activities
//
// This mirrors @microsoft/teams.apps 2.2 (socket-mode/*), protocol version 1. Socket Mode is a Teams preview feature.

const PROTOCOL_VERSION = 1;
const NEGOTIATE_BASE = "https://botapi.skype.com";
/** One socket per geography, like the SDK, so conversations pinned to any of them reach the bot. */
const GEOS = ["amer", "emea", "apac"];
const RS = "\x1e"; // SignalR record separator
const PING_EVERY = 15_000;
const SERVER_TIMEOUT = 30_000;
const READY_TIMEOUT = 30_000;
const REFRESH_MARGIN = 60_000; // renegotiate this long before the socket's token expires
const HANDOFF = 5_000; // the replaced socket stays open this long, for activities already on it
const RETRY_MIN = 1_000;
const RETRY_MAX = 15_000;
const AUTH_RETRY_MIN = 15_000; // refused credentials or Socket Mode access: slower, it rarely fixes itself at once
const AUTH_RETRY_MAX = 5 * 60_000;

export type BotCredentials = { clientId: string; secret: string; tenantId: string };

export type Activity = {
  type: string;
  id?: string;
  action?: string; // installationUpdate: "add" | "remove"
  text?: string;
  serviceUrl?: string;
  from?: { id: string; name?: string; aadObjectId?: string };
  recipient?: { id: string; name?: string };
  conversation?: { id: string; conversationType?: string; tenantId?: string; name?: string; isGroup?: boolean };
  membersAdded?: { id: string }[];
  membersRemoved?: { id: string }[];
  entities?: { type: string; mentioned?: { id: string; name?: string }; text?: string }[];
  /** Teams' extras: the team and channel a channel message is in. */
  channelData?: {
    team?: { id: string; name?: string; aadGroupId?: string };
    channel?: { id: string; name?: string };
    tenant?: { id: string };
    eventType?: string; // conversationUpdate: "teamMemberAdded", "channelCreated", …
  };
};

export type SocketState = { state: "connecting" | "ready" | "failed" | "stopped"; detail?: string };

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** Retrying can't fix it: wrong credentials, or the bot isn't allowed to use Socket Mode. */
export class AuthError extends Error {}

/** An app-only token (Bot Framework by default; Microsoft Graph for creating channels), cached until a minute before it expires. */
export function botTokens(c: BotCredentials, scope = "https://api.botframework.com/.default") {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return (): Promise<string> => {
    if (cached && Date.now() < cached.until) return Promise.resolve(cached.token);
    pending ??= (async () => {
      const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.secret, scope }),
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        const why = `Microsoft sign-in refused the bot: ${j.error ?? `HTTP ${r.status}`}${j.error_description ? ` (${String(j.error_description).split(/\r?\n/)[0]})` : ""}`;
        throw r.status >= 400 && r.status < 500 ? new AuthError(why) : new Error(why);
      }
      cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 };
      return cached.token;
    })().finally(() => (pending = undefined));
    return pending;
  };
}

// ---------- One SignalR connection ----------

type HubEvents = {
  activity: (envelope: unknown) => Promise<unknown>;
  closed: (hub: Hub, why: string, planned: boolean) => void;
};

class Hub {
  connectionId?: string;
  private ws?: WebSocket;
  private buf = "";
  private handshook = false;
  private lastHeard = Date.now();
  private keepAlive?: ReturnType<typeof setInterval>;
  private done = false;
  private ready?: { resolve: () => void; reject: (e: Error) => void };

  constructor(private on: HubEvents) {}

  /** SignalR's negotiate against Azure SignalR (following redirects, like the client library), then the socket. Resolves on SocketReady. */
  async open(url: string, accessToken: string): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
      const q = url.indexOf("?");
      const base = q < 0 ? url : url.slice(0, q);
      const query = q < 0 ? "" : url.slice(q);
      const r = await fetch(`${base.endsWith("/") ? base : base + "/"}negotiate${query}${query ? "&" : "?"}negotiateVersion=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`SignalR negotiate failed: HTTP ${r.status}`);
      if (j.error) throw new Error(`SignalR negotiate failed: ${j.error}`);
      if (j.url) {
        url = j.url;
        accessToken = j.accessToken ?? accessToken;
        continue;
      }
      const id = j.connectionToken ?? j.connectionId;
      return this.connect(`${url.replace(/^http/, "ws")}${url.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`, accessToken);
    }
    throw new Error("SignalR negotiate redirected too many times");
  }

  private connect(wsUrl: string, accessToken: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.close(`no SocketReady within ${READY_TIMEOUT / 1000} s`), READY_TIMEOUT);
      this.ready = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      // Bun's WebSocket takes request headers, like the SignalR client does on Node.
      const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${accessToken}` } } as any);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      ws.onmessage = (e) => this.receive(String(e.data));
      ws.onclose = (e) => this.close(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
      ws.onerror = () => {}; // onclose follows
    });
  }

  private receive(data: string) {
    this.lastHeard = Date.now();
    this.buf += data;
    for (let i = this.buf.indexOf(RS); i >= 0; i = this.buf.indexOf(RS)) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let m: any;
      try {
        m = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!this.handshook) {
        if (m.error) return this.close(`SignalR handshake refused: ${m.error}`);
        this.handshook = true;
        this.keepAlive = setInterval(() => {
          if (Date.now() - this.lastHeard > SERVER_TIMEOUT) return this.close("Teams went quiet (no ping for 30 s)");
          this.send({ type: 6 });
        }, PING_EVERY);
        continue;
      }
      this.handle(m);
    }
  }

  private handle(m: any) {
    if (m.type === 7) return this.close(m.error ? `Teams closed the socket: ${m.error}` : "Teams closed the socket");
    if (m.type !== 1) return; // pings and anything else
    if (m.target === "SocketReady") {
      this.connectionId = m.arguments?.[0]?.connectionId;
      this.complete(m.invocationId, null);
      this.ready?.resolve();
      this.ready = undefined;
    } else if (m.target === "Activity") {
      this.on.activity(m.arguments?.[0]).then(
        (result) => this.complete(m.invocationId, result ?? null),
        (err) => this.complete(m.invocationId, null, String(err?.message ?? err)),
      );
    } else this.complete(m.invocationId, null);
  }

  /** A client result: what Teams awaits for an invocation that carries an id. */
  private complete(invocationId: string | undefined, result: unknown, error?: string) {
    if (invocationId === undefined) return;
    this.send(error ? { type: 3, invocationId, error } : { type: 3, invocationId, result });
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m) + RS);
  }

  close(why: string, planned = false) {
    if (this.done) return;
    this.done = true;
    clearInterval(this.keepAlive);
    try {
      this.ws?.close();
    } catch {}
    this.ready?.reject(new Error(why));
    this.ready = undefined;
    this.on.closed(this, why, planned);
  }
}

// ---------- One geography: keeps a connection up, rotates it before its token expires ----------

class GeoSocket {
  state: SocketState = { state: "connecting" };
  private active?: Hub;
  private retryMs = RETRY_MIN;
  private authRetryMs = AUTH_RETRY_MIN;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private geo: string,
    private bot: { token: () => Promise<string>; dispatch: (envelope: unknown) => Promise<unknown>; changed: () => void; log: Log },
  ) {}

  start() {
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.active?.close("stopped", true);
    this.active = undefined;
    this.set({ state: "stopped" });
  }

  private set(s: SocketState) {
    if (s.state === this.state.state && s.detail === this.state.detail) return;
    this.state = s;
    this.bot.changed();
  }

  private async connect(replacing?: Hub) {
    if (this.stopped) return;
    const hub = new Hub({ activity: this.bot.dispatch, closed: (h, why, planned) => this.closed(h, why, planned) });
    try {
      const neg = await negotiate(this.geo, await this.bot.token(), replacing?.connectionId);
      await hub.open(neg.url, neg.accessToken);
      if (this.stopped) return hub.close("stopped", true);
      const old = this.active;
      this.active = hub;
      this.retryMs = RETRY_MIN;
      this.authRetryMs = AUTH_RETRY_MIN;
      this.set({ state: "ready" });
      if (old) {
        this.bot.log("teams.socket_rotated", { geo: this.geo });
        setTimeout(() => old.close("replaced", true), HANDOFF);
      }
      if (neg.expiresIn > 0) this.later(() => this.connect(hub), Math.max(neg.expiresIn * 1000 - REFRESH_MARGIN, 5_000));
    } catch (err: any) {
      hub.close(String(err?.message ?? err), true);
      if (this.stopped) return;
      if (err instanceof AuthError) {
        // Shown as needing you, but tried again slowly: right after `teams app create`, Socket Mode takes a little
        // while to reach every geography (403 meanwhile), and a fixed secret or permission heals the same way.
        this.active?.close("credentials refused", true);
        this.active = undefined;
        this.set({ state: "failed", detail: err.message });
        this.later(() => this.connect(), this.authBackoff());
        return;
      }
      this.bot.log("teams.socket_retry", { geo: this.geo, why: err?.message, rotating: Boolean(replacing) });
      // A failed rotation keeps the old socket serving until its token runs out; anything else waits and tries again.
      if (!(replacing && this.active === replacing)) this.set({ state: "connecting", detail: err?.message });
      this.later(() => this.connect(replacing && this.active === replacing ? replacing : undefined), this.backoff());
    }
  }

  private closed(hub: Hub, why: string, planned: boolean) {
    if (planned || this.stopped || hub !== this.active) return;
    this.active = undefined;
    this.bot.log("teams.socket_closed", { geo: this.geo, why });
    this.set({ state: "connecting", detail: why });
    this.later(() => this.connect(), this.backoff());
  }

  private later(fn: () => void, ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }

  private backoff() {
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX);
    return ms;
  }

  private authBackoff() {
    const ms = this.authRetryMs;
    this.authRetryMs = Math.min(this.authRetryMs * 2, AUTH_RETRY_MAX);
    return ms;
  }
}

async function negotiate(geo: string, botToken: string, replaces?: string) {
  const r = await fetch(`${NEGOTIATE_BASE}/${geo}/v3/websockets/connect`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, ...(replaces && { "x-ms-socket-replaces-connection-id": replaces }) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 200);
    if (r.status === 401) throw new AuthError(`Teams didn't accept the bot's credentials (HTTP 401). ${body}`.trim());
    if (r.status === 403) throw new AuthError(`This bot isn't allowed to use Socket Mode (HTTP 403). Create it with --messaging-mode socket. ${body}`.trim());
    throw new Error(`Socket Mode negotiate failed: HTTP ${r.status} ${body}`.trim());
  }
  const j: any = await r.json();
  if (!j.url || !j.accessToken) throw new Error("Socket Mode negotiate answered without url/accessToken");
  return { url: String(j.url), accessToken: String(j.accessToken), expiresIn: Number(j.expiresIn ?? 0) };
}

// ---------- A bot: its sockets, inbound activities, and sending ----------

const field = (o: any, name: string) => (o && typeof o === "object" ? (o[name] ?? o[name[0].toUpperCase() + name.slice(1)]) : undefined);
const isActivity = (v: any): v is Activity => v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string";

export class TeamsSocket {
  readonly token: () => Promise<string>;
  private geos: GeoSocket[];

  constructor(
    private creds: BotCredentials,
    private onActivity: (a: Activity) => void | Promise<void>,
    private onChange: () => void,
    private log: Log,
  ) {
    this.token = botTokens(creds);
    const bot = { token: this.token, dispatch: (e: unknown) => this.dispatch(e), changed: () => this.onChange(), log };
    this.geos = GEOS.map((g) => new GeoSocket(g, bot));
  }

  start() {
    for (const g of this.geos) g.start();
  }

  stop() {
    for (const g of this.geos) g.stop();
  }

  /** Ready when every geography is; failed (needs you) when any failed; connecting otherwise. */
  get state(): SocketState {
    const s = this.geos.map((g) => g.state);
    const failed = s.find((x) => x.state === "failed");
    if (failed) return failed;
    if (s.some((x) => x.state === "stopped")) return { state: "stopped" }; // they stop together
    if (s.every((x) => x.state === "ready")) return { state: "ready" };
    return { state: "connecting", detail: s.find((x) => x.detail)?.detail };
  }

  /** One inbound envelope → the activity handler → the reply frame Teams awaits (an ack, or an invoke's result). */
  private async dispatch(envelope: unknown) {
    const base = { protocolVersion: PROTOCOL_VERSION, envelopeId: field(envelope, "envelopeId"), botKey: this.creds.clientId, recvAt: Date.now() };
    const version = Number(field(envelope, "protocolVersion"));
    if (Number.isFinite(version) && version > PROTOCOL_VERSION) {
      this.log("teams.unsupported_protocol", { version });
      return { ...base, status: 400, body: { error: `unsupported protocolVersion ${version}` }, ts: Date.now() };
    }
    const activity = [field(envelope, "payload"), field(envelope, "activity")].find(isActivity);
    if (!activity) return undefined;
    const kind = String(field(envelope, "type") ?? "").toLowerCase();
    const invoke = kind ? kind === "invoke" : activity.type.toLowerCase() === "invoke";
    let status = 200;
    try {
      await this.onActivity(activity);
    } catch (err: any) {
      status = 500;
      this.log("teams.activity_failed", { type: activity.type, error: err?.message });
    }
    return invoke ? { ...base, status, body: {}, ts: Date.now() } : { ...base, status, ts: Date.now() };
  }

  /** A member of a conversation, as Teams knows them: their Microsoft Entra id is `aadObjectId`. */
  async member(serviceUrl: string, conversationId: string, memberId: string): Promise<{ aadObjectId?: string; email?: string; userPrincipalName?: string; name?: string }> {
    const r = await fetch(`${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(memberId)}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Teams answered ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim());
    return r.json();
  }

  /** Posts an activity (a message or typing) into a conversation. */
  async send(serviceUrl: string, conversationId: string, activity: Record<string, unknown>) {
    // Channel threads look like "19:…@thread.tacv2;messageid=…": encoded, like the Bot Framework SDK does.
    const r = await fetch(`${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Teams answered ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim());
  }
}

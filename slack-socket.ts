// Slack Socket Mode and the Web API, without the SDK: the app dials out to Slack, so nothing listens on the internet.
//
//   open       POST <api>/apps.connections.open with the app-level token (xapp-…, scope connections:write) → { url }
//   socket     a WebSocket to that url: Slack says "hello", then sends one envelope per event. Each envelope is acked by
//              sending its envelope_id back within 3 s, or Slack delivers it again.
//   refresh    every few hours Slack sends "disconnect" (reason "warning", then "refresh_requested") before it drops a
//              connection: a new one opens, and the old one closes once the new one said hello.
//   liveness   a WebSocket ping every 15 s; a connection that hears nothing for 45 s is replaced.
//   Web API    POST <api>/<method> with the bot token (xoxb-…), form-encoded (multipart with a file, as for an app's
//              icon). HTTP 429 means wait Retry-After seconds.
import { setting } from "./env";

/** Slack's Web API. HARMONIA_SLACK_API points it somewhere else (a local fake, for trying the bridge without Slack). */
export const SLACK_API = (setting("SLACK_API") ?? "https://slack.com/api").replace(/\/+$/, "");

const HELLO_TIMEOUT = 30_000;
const PING_EVERY = 15_000;
const QUIET_LIMIT = 45_000;
const HANDOFF = 5_000; // a replaced connection stays open this long, for envelopes already on it
const RETRY_MIN = 1_000;
const RETRY_MAX = 30_000;
const AUTH_RETRY_MIN = 30_000; // a refused token rarely fixes itself at once
const AUTH_RETRY_MAX = 10 * 60_000;
const RATE_LIMIT_RETRIES = 3;

export type SocketState = { state: "connecting" | "ready" | "failed" | "stopped"; detail?: string };

/** One Socket Mode envelope: an Events API callback, a slash command, an interaction, or Slack's own hello/disconnect. */
export type Envelope = { type: string; envelope_id?: string; payload?: any; retry_attempt?: number; reason?: string };

/** A Web API error: `code` is Slack's error string ("not_in_channel", "name_taken", "invalid_auth", …). */
export class SlackError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Errors that mean the token itself is wrong: retrying soon won't help. */
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type", "missing_scope"]);
export const isAuthError = (e: unknown) => e instanceof SlackError && AUTH_ERRORS.has(e.code);

/** A Web API call. Objects and arrays (blocks, say) are sent as JSON strings, as Slack expects in a form body. */
export async function slackCall(token: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return (await request(token, method, params)).json;
}

/** auth.test, plus the scopes the token was granted (Slack lists them in a header). */
export async function slackAuth(token: string): Promise<any> {
  const { json, headers } = await request(token, "auth.test");
  const scopes = headers.get("x-oauth-scopes");
  return { ...json, scopes: scopes === null ? undefined : scopes.split(",").map((s) => s.trim()).filter(Boolean) };
}

/** A Web API call with a file (multipart), like apps.icon.set. */
export async function slackUpload(token: string, method: string, params: Record<string, string>, file: { name: string; type: string; data: Uint8Array }): Promise<any> {
  return (await request(token, method, params, file)).json;
}

async function request(token: string, method: string, params: Record<string, unknown> = {}, file?: { name: string; type: string; data: Uint8Array }): Promise<{ json: any; headers: Headers }> {
  const fields = Object.entries(params).flatMap(([k, v]) => (v === undefined || v === null ? [] : [[k, typeof v === "string" ? v : JSON.stringify(v)] as const]));
  let body: URLSearchParams | FormData = new URLSearchParams(fields as [string, string][]);
  if (file) {
    body = new FormData();
    for (const [k, v] of fields) body.set(k, v);
    body.set("file", new Blob([file.data], { type: file.type }), file.name);
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${SLACK_API}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await Bun.sleep(Math.min(Number(r.headers.get("retry-after")) || 1, 60) * 1000);
      continue;
    }
    const j: any = await r.json().catch(() => undefined);
    if (!j) throw new SlackError(`http_${r.status}`, `Slack answered HTTP ${r.status} to ${method}`);
    if (!j.ok) {
      const code = String(j.error ?? "unknown_error");
      // A manifest Slack won't take says where: [{ pointer: "/display_information/name", message: "…" }].
      const why = Array.isArray(j.errors) ? j.errors.map((x: any) => `${x.pointer ?? ""} ${x.message ?? ""}`.trim()).filter(Boolean).join("; ") : "";
      throw new SlackError(code, `Slack refused ${method}: ${code}${j.needed ? ` (the app needs the ${j.needed} scope)` : ""}${why ? ` (${why})` : ""}`);
    }
    return { json: j, headers: r.headers };
  }
}

// ---------- One WebSocket connection ----------

class Connection {
  private ws?: WebSocket;
  private lastHeard = Date.now();
  private keepAlive?: ReturnType<typeof setInterval>;
  private done = false;
  private hello?: { resolve: () => void; reject: (e: Error) => void };

  constructor(
    private on: {
      envelope: (e: Envelope, from: Connection) => void;
      closed: (c: Connection, why: string, planned: boolean) => void;
    },
  ) {}

  /** Resolves once Slack says hello. */
  open(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.close(`no hello from Slack within ${HELLO_TIMEOUT / 1000} s`), HELLO_TIMEOUT);
      this.hello = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      const ws = new WebSocket(url);
      this.ws = ws;
      const heard = () => (this.lastHeard = Date.now());
      ws.addEventListener("ping", heard);
      ws.addEventListener("pong", heard);
      ws.onopen = () => {
        heard();
        this.keepAlive = setInterval(() => {
          if (Date.now() - this.lastHeard > QUIET_LIMIT) return this.close(`Slack went quiet (nothing for ${QUIET_LIMIT / 1000} s)`);
          try {
            (ws as any).ping?.();
          } catch {}
        }, PING_EVERY);
      };
      ws.onmessage = (e) => {
        heard();
        this.receive(String(e.data));
      };
      ws.onclose = (e) => this.close(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
      ws.onerror = () => {}; // onclose follows
    });
  }

  private receive(data: string) {
    let m: Envelope;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === "hello") {
      this.hello?.resolve();
      this.hello = undefined;
      return;
    }
    // Acked first, so a slow handler never makes Slack deliver the same event again.
    if (m.envelope_id) this.send({ envelope_id: m.envelope_id });
    this.on.envelope(m, this);
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(why: string, planned = false) {
    if (this.done) return;
    this.done = true;
    clearInterval(this.keepAlive);
    try {
      this.ws?.close();
    } catch {}
    this.hello?.reject(new Error(why));
    this.hello = undefined;
    this.on.closed(this, why, planned);
  }
}

// ---------- The app's socket: keeps one connection up, replaces it when Slack asks ----------

export class SlackSocket {
  state: SocketState = { state: "connecting" };
  private active?: Connection;
  private opening = false;
  private retryMs = RETRY_MIN;
  private authRetryMs = AUTH_RETRY_MIN;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private appToken: string,
    private onEvent: (e: Envelope) => void,
    private onChange: () => void,
    private log: (event: string, fields?: Record<string, unknown>) => void,
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
    this.onChange();
  }

  /** Opens a connection. With one already up (a refresh), it keeps serving until the new one is ready. */
  private async connect() {
    if (this.stopped || this.opening) return;
    this.opening = true;
    const conn = new Connection({
      envelope: (e, from) => this.envelope(e, from),
      closed: (c, why, planned) => this.closed(c, why, planned),
    });
    try {
      const { url } = await slackCall(this.appToken, "apps.connections.open");
      await conn.open(String(url));
      if (this.stopped) return conn.close("stopped", true);
      const old = this.active;
      this.active = conn;
      this.retryMs = RETRY_MIN;
      this.authRetryMs = AUTH_RETRY_MIN;
      this.set({ state: "ready" });
      if (old) {
        this.log("slack.socket_refreshed");
        setTimeout(() => old.close("replaced", true), HANDOFF);
      }
    } catch (err: any) {
      conn.close(String(err?.message ?? err), true);
      if (this.stopped) return;
      if (isAuthError(err)) {
        this.active?.close("token refused", true);
        this.active = undefined;
        this.set({ state: "failed", detail: authHint(err) });
        this.later(() => this.connect(), this.backoff("auth"));
        return;
      }
      this.log("slack.socket_retry", { why: err?.message });
      if (!this.active) this.set({ state: "connecting", detail: err?.message });
      this.later(() => this.connect(), this.backoff());
    } finally {
      this.opening = false;
    }
  }

  private envelope(e: Envelope, from: Connection) {
    if (e.type === "disconnect") {
      // Socket Mode was turned off for the app: nothing to reconnect to until it's back on.
      if (e.reason === "link_disabled") {
        this.active?.close("Socket Mode is off", true);
        this.active = undefined;
        this.set({ state: "failed", detail: "Socket Mode is turned off for the Slack app. Turn it on in the app's settings (Socket Mode)." });
        this.later(() => this.connect(), this.backoff("auth"));
        return;
      }
      if (from === this.active) void this.connect(); // "warning" or "refresh_requested": the replacement opens now
      return;
    }
    if (e.type === "events_api" || e.type === "slash_commands" || e.type === "interactive") {
      try {
        this.onEvent(e);
      } catch (err: any) {
        this.log("slack.event_failed", { type: e.type, error: err?.message });
      }
    }
  }

  private closed(c: Connection, why: string, planned: boolean) {
    if (planned || this.stopped || c !== this.active) return;
    this.active = undefined;
    this.log("slack.socket_closed", { why });
    this.set({ state: "connecting", detail: why });
    this.later(() => this.connect(), this.backoff());
  }

  private later(fn: () => void, ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }

  private backoff(kind?: "auth") {
    if (kind === "auth") {
      const ms = this.authRetryMs;
      this.authRetryMs = Math.min(this.authRetryMs * 2, AUTH_RETRY_MAX);
      return ms;
    }
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX);
    return ms;
  }
}

function authHint(e: SlackError) {
  if (e.code === "not_allowed_token_type") return "The app-level token isn't one: it starts with xapp-. Make one under Basic Information → App-Level Tokens.";
  if (e.code === "missing_scope") return "The app-level token needs the connections:write scope. Make a new one with it under Basic Information → App-Level Tokens.";
  return `Slack refused the app-level token (${e.code}). Make a new one under Basic Information → App-Level Tokens and connect again.`;
}

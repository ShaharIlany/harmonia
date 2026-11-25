// Small helpers for the bridge: which Slack errors to ignore or retry, what is wrong with a configuration token, the
// pairing code, and a safe JSON parse.
import { SlackError } from "../slack-socket";

/** Takes one Slack error as success (already reacted, nothing to take off); anything else still fails. */
export const ignore = (code: string) => (e: unknown) => {
  if (!(e instanceof SlackError && e.code === code)) throw e;
};

/** Network trouble and Slack's own hiccups are worth another try; "not_in_channel" and the like aren't. */
export function retryable(e: unknown) {
  if (!(e instanceof SlackError)) return true;
  return e.code.startsWith("http_5") || ["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(e.code);
}

/** What's wrong with the configuration token itself, when that's why a call failed: then there's no point going on. */
export function configTokenProblem(e: unknown): string | undefined {
  if (!(e instanceof SlackError)) return;
  if (e.code === "token_expired") return "The configuration token has expired (they last 12 hours). Generate a new one and paste it.";
  if (e.code === "invalid_auth" || e.code === "not_authed" || e.code === "token_revoked") return "Slack didn't accept the configuration token. Generate a new one and paste its access token (xoxe.xoxp-…).";
  if (e.code === "missing_scope" || e.code === "not_allowed_token_type") return "That isn't an app configuration token. Generate one at the top of api.slack.com/apps, under Your App Configuration Tokens.";
}

export const newPairCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

export const parse = (json: unknown): Record<string, any> => {
  try {
    return JSON.parse(String(json ?? "{}")) ?? {};
  } catch {
    return {};
  }
};

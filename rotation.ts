// When a teammate's chat session is too big to keep resuming. Kept apart from team.ts so the limits and the
// reasoning sit together, and the rule can be tested without a Team.
import { SETTINGS } from "./paths";
import type { AgentSession } from "./store";

/** A chat session this big (tokens) is replaced by a new one (`settings.json`: chatRotateTokens). */
const ROTATE_TOKENS = Number(SETTINGS.chatRotateTokens) || 60_000;
/** After sitting idle this long, a session above ROTATE_IDLE_TOKENS is replaced too (`chatRotateIdleTokens`). */
const ROTATE_IDLE_TOKENS = Number(SETTINGS.chatRotateIdleTokens) || 30_000;
/** The prompt cache keeps a conversation for an hour (CLAUDE_CODE_PROMPT_CACHE_TTL=1h). */
const ROTATE_IDLE_MS = 60 * 60_000;

/**
 * Whether a teammate's chat session is too big to keep resuming, and why (undefined: keep it). Every turn reads
 * the whole conversation from the prompt cache, and once the cache has expired (an hour idle) the whole thing is
 * written again at a premium, so a session that is large, or only moderately large and cold, costs more than a
 * new one that re-reads the channels' recent lines.
 */
export function shouldRotate(
  s: Pick<AgentSession, "context" | "lastAt">,
  now: number,
  limits = { tokens: ROTATE_TOKENS, idleTokens: ROTATE_IDLE_TOKENS },
): string | undefined {
  const context = s.context ?? 0;
  if (context > limits.tokens) return `${context} tokens is over ${limits.tokens}`;
  if (s.lastAt && now - s.lastAt > ROTATE_IDLE_MS && context > limits.idleTokens) return `idle over an hour with ${context} tokens, over ${limits.idleTokens}`;
}

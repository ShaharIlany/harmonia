import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { TEAM_DEFAULTS, TEAM_FILE } from "./paths";
import { setting } from "./env";

export type Teammate = {
  id: string;
  name: string;
  avatar: string;
  role: string;
  color: string;
  chatModel: string; // the model of the teammate's chat session
  chatEffort: string;
  routing: string; // a few keywords for Mozart (mozart.ts): what to send this teammate when nobody is named
};

/** Chat-session models, with $ per million tokens (input, output, cache read) for the settings page's estimate. */
export const CHAT_MODELS: Record<string, { label: string; input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { label: "Opus 5.5", input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { label: "Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-2": { label: "Fable 5.2", input: 8, output: 40, cacheRead: 0.2 },
};
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// `id` is the agent file name in ~/.claude/agents (claude --agent <id>) and never changes.
// The rest is edited from the app's settings page and saved back to team.json.
const FILE = TEAM_FILE;
// The colours team.json shipped with before the lyre's string colours. A teammate still on one gets the new
// default; a colour someone picked stays.
const OLD_COLORS: Record<string, string> = {
  dali: "#eab308",
  leo: "#3b82f6",
  elliot: "#22c55e",
  sherlock: "#a855f7",
  murphy: "#ef4444",
  emily: "#06b6d4",
};
export const ROSTER: Teammate[] = JSON.parse(readFileSync(FILE, "utf8")).map((t: Teammate) => ({
  ...t,
  // Lowercase, as the settings page's colour input gives it back: otherwise its Save button stays lit.
  color: (t.color?.toLowerCase() === OLD_COLORS[t.id] ? (TEAM_DEFAULTS.find((d) => d.id === t.id)?.color ?? t.color) : t.color)?.toLowerCase(),
  chatModel: t.chatModel ?? "claude-opus-5-5",
  chatEffort: t.chatEffort ?? "low",
  routing: t.routing ?? TEAM_DEFAULTS.find((d) => d.id === t.id)?.routing ?? "",
}));

// Who picks up a message that names nobody.
export const TRIAGE = "emily";

const login = userInfo().username;
export const USER_NAME = setting("USER") ?? login.charAt(0).toUpperCase() + login.slice(1);

export const teammate = (id: string) => ROSTER.find((t) => t.id === id);
export const nameOf = (author: string) => (author === "user" ? USER_NAME : teammate(author)?.name ?? author);

/** Applies a settings edit; returns an error message, or undefined when saved. */
export function updateTeammate(id: string, patch: Partial<Omit<Teammate, "id">>): string | undefined {
  const t = teammate(id);
  if (!t) return "No such teammate.";
  const next = { ...t, ...patch };
  if (!/^[\p{L}\d_]{1,24}$/u.test(next.name)) return "The name must be one word (letters, digits, _), so it works as an @mention.";
  const clash = ROSTER.find((o) => o.id !== id && o.name.toLowerCase() === next.name.toLowerCase());
  if (clash || next.name.toLowerCase() === USER_NAME.toLowerCase()) return `"${next.name}" is already taken.`;
  if (!next.avatar.trim() || [...next.avatar].length > 12) return "Pick one emoji for the avatar.";
  if (!/^#[0-9a-f]{6}$/i.test(next.color)) return "The colour must look like #3b82f6.";
  if (!CHAT_MODELS[next.chatModel]) return "Unknown chat model.";
  if (!CHAT_EFFORTS.includes(next.chatEffort)) return "Unknown chat effort.";
  Object.assign(t, {
    name: next.name,
    avatar: next.avatar.trim(),
    role: next.role.trim().slice(0, 40),
    color: next.color,
    chatModel: next.chatModel,
    chatEffort: next.chatEffort,
    routing: String(next.routing ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
  });
  writeFileSync(FILE, JSON.stringify(ROSTER, null, 2) + "\n");
}

/** Teammate ids @mentioned in `text` (and the user, as "user"). */
export function mentions(text: string): string[] {
  const found = new Set<string>();
  for (const [, word] of text.matchAll(/@([\p{L}\d_]+)/gu)) {
    const w = word.toLowerCase();
    if (w === USER_NAME.toLowerCase()) found.add("user");
    const t = ROSTER.find((r) => r.name.toLowerCase() === w);
    if (t) found.add(t.id);
  }
  return [...found];
}

/**
 * Teammates a teammate's message hands work to. Decided per sentence: "@Sherlock please review it"
 * is a handoff, but "@Alex, OK to hand it to @Elliot?" is a question to the user, so Elliot waits.
 */
export function handoffs(text: string): string[] {
  const found = new Set<string>();
  for (const sentence of text.split(/\n+|(?<=[.!?])\s+/)) {
    const ids = mentions(sentence);
    if (!ids.includes("user")) ids.forEach((id) => found.add(id));
  }
  return [...found];
}

/** "Sherlock, can you…" / "Sherlock: …" at the start of a user message. */
export function addressedAtStart(text: string): string | undefined {
  const m = text.trim().match(/^([\p{L}]+)\s*[,:]/u);
  return m ? ROSTER.find((r) => r.name.toLowerCase() === m[1].toLowerCase())?.id : undefined;
}

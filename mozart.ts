// Mozart: each channel's coordinator. After every message that doesn't name its teammate, the channel's Mozart decides
// who answers, if anyone: one teammate, several, or nobody. A message of yours that names its teammate (an @mention,
// "Name, …" or a reply to a teammate's message) goes to that teammate, and Mozart only decides whether it needs a turn
// at all. Either way, when all a message of yours needs is an acknowledgment (thanks, a "no thanks" to an offer that
// leaves nothing to do), the teammate reacts to it with an emoji instead of taking a turn. It's a Claude Code session of
// its own per channel (Haiku, no tools), so it remembers the channel's conversation, and each decision only appends the
// new lines (the prompt cache holds the rest). Nothing shows while it thinks; the teammate it picks starts typing.
//
// Without an answer from it (the call failed, timed out or answered nonsense, or the stub), simple rules decide: a
// teammate waiting on the user's answer gets it, else the teammate in the conversation, else the triage teammate. A
// message that names its teammate goes to it. The rules never react.
import { readFileSync } from "node:fs";
import mozartRulesFile from "./mozart-rules.md" with { type: "file" };
import { MOZART_DIR } from "./paths";
import { withDays } from "./dates";
import { setting } from "./env";
import { ROSTER, TRIAGE, USER_NAME, nameOf, teammate } from "./roster";
import { runAgent } from "./runner";
import { recordResult } from "./usage";
import { saveChannels, type Channel, type Message, type MozartSession } from "./store";

/** A teammate's emoji on the message, instead of a turn. */
export type Reaction = { by: string; emoji: string };
export type Decision = { to: string[]; react: Reaction[]; why: string; by: "mozart" | "rule" };

const MODEL = "claude-haiku-5-5";
/** A decision that takes longer than this falls back to the rules. */
const TIMEOUT_MS = 45_000;
/** For a message that names its teammate, which only waits on whether it's a reaction: the teammate starts sooner. */
const ADDRESSED_TIMEOUT_MS = 15_000;
/** A Mozart session that grew past this many tokens starts over (with the channel's recent lines). */
const MAX_CONTEXT = 60_000;
/** Lines a new Mozart session reads first. */
const FIRST_READ = 30;
/** Messages back the fallback rules look for the teammate the user is talking with. */
const CONVERSATION = 4;

const RULES = readFileSync(mozartRulesFile, "utf8");
const said = (m: Message) => m.author !== "system" && m.author !== "guest" && m.kind !== "status" && m.kind !== "job";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
/** One emoji (with its skin tone or ZWJ parts). */
const ONE_EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;
/** Stub mode's stand-in for Mozart's reactions: a message that's only thanks ("thanks!", "Leo, thank you"). */
const STUB_THANKS = /^(?:\p{L}+,\s*)?(?:thanks|thank you|thx|ty)(?:[\s,]+\p{L}+)?[\s!.]*$/iu;
const rosterId = (x: unknown) => {
  const key = String(x).trim().replace(/^@/, "").toLowerCase();
  return ROSTER.find((r) => r.id === key || r.name.toLowerCase() === key)?.id;
};

export function mozartPrompt(ch: Channel) {
  const vars: Record<string, string> = {
    channel: ch.name,
    user: USER_NAME,
    triage: `${TRIAGE} (${nameOf(TRIAGE)})`,
    roster: ROSTER.map((t) => `- ${t.id}: ${t.name}, ${t.role}${t.routing ? `: ${t.routing}` : ""}`).join("\n"),
  };
  return RULES.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all);
}

/**
 * Could this message of yours be a bare acknowledgment ("thanks!", "ok", "no need, thanks")? Only then is it worth
 * asking Mozart whether an emoji is enough. Anything long, with a question, a file, a voice note, a code block or a
 * link has something in it to answer.
 */
export function mayBeAcknowledgment(msg: Message): boolean {
  const text = msg.text.trim();
  if (msg.meta?.files?.length || msg.meta?.voice) return false;
  if (text.includes("?") || text.includes("`") || /https?:\/\/|www\./i.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length <= 12;
}

/**
 * Could a teammate's reply concern another teammate? It names one (as a whole word, no `@` needed: "Murphy, can you
 * try to break it?"), another teammate has a job running in the channel, or the reply's channel is waiting on another
 * teammate's question to you. Otherwise Mozart would say nobody, so asking it only costs time and tokens.
 */
export function mayNeedFollowUp(text: string, authorId: string, ch: Channel): boolean {
  if (ch.waitingOn && ch.waitingOn !== authorId) return true;
  if (ch.jobs.some((j) => j.status === "running" && j.agentId !== authorId)) return true;
  return ROSTER.some((r) => r.id !== authorId && new RegExp(`(?<![\\p{L}\\p{N}_])${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu").test(text));
}

export const mozartTitle = (ch: Channel) => `[Mozart] #${ch.name}`;

/**
 * Mozart's answer: `{"answer": [ids], "react": {id: emoji}, "why": "..."}`. Undefined when it isn't one. A reaction
 * with an id or an emoji that isn't one is left out.
 */
export function parseDecision(text: string): { to: string[]; react: Reaction[]; why: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return;
  let j: any;
  try {
    j = JSON.parse(text.slice(start, end + 1));
  } catch {
    return;
  }
  const raw = Array.isArray(j?.answer) ? j.answer : typeof j?.answer === "string" ? [j.answer] : undefined;
  if (!raw) return;
  const to: string[] = [];
  for (const x of raw) {
    const id = rosterId(x);
    if (!id) return; // an id it made up: don't trust the rest either
    if (!to.includes(id)) to.push(id);
  }
  const react: Reaction[] = [];
  if (j.react && typeof j.react === "object" && !Array.isArray(j.react))
    for (const [k, v] of Object.entries(j.react)) {
      const by = rosterId(k);
      const emoji = String(v ?? "").trim();
      if (by && ONE_EMOJI.test(emoji) && !react.some((r) => r.by === by)) react.push({ by, emoji });
    }
  return { to, react, why: clip(String(j.why ?? "").replace(/\s+/g, " ").trim(), 80) };
}

/** The rules, for when Mozart can't answer. */
export function fallback(all: Message[], msg: Message, waitingOn?: string): { to: string[]; why: string } {
  if (msg.author !== "user") return { to: [], why: "a teammate's message" };
  const before = all.slice(0, all.indexOf(msg)).filter(said);
  const recent = before.slice(-CONVERSATION);
  const asked = (waitingOn && teammate(waitingOn) && waitingOn) || recent.findLast((m) => teammate(m.author) && new RegExp(`@${USER_NAME}\\b`, "i").test(m.text))?.author;
  if (asked) return { to: [asked], why: `answering ${nameOf(asked)}'s question` };
  const last = recent.findLast((m) => teammate(m.author))?.author;
  if (last) return { to: [last], why: `continuing with ${nameOf(last)}` };
  return { to: [TRIAGE], why: "nobody in the conversation" };
}

/**
 * Who answers `msg` (a message in `ch`, already in `all`), and who just reacts to it. `line` formats a message the way
 * the teammates read it. `addressed`: the teammates a message of yours names: they answer it, unless Mozart says a
 * reaction from them is enough. Calls for one channel must not overlap (the caller queues them): they share the
 * channel's Mozart session.
 */
export async function decide(o: {
  ch: Channel;
  all: Message[];
  msg: Message;
  line: (m: Message) => string;
  waitingOn?: string;
  addressed?: string[];
}): Promise<Decision> {
  const { ch, all, msg, addressed } = o;
  const ruled = () => (addressed?.length ? { to: addressed, why: `named ${addressed.map(nameOf).join(", ")}` } : fallback(all, msg, o.waitingOn));
  const rules = (why: string): Decision => {
    const f = ruled();
    return { ...f, react: [], why: `${f.why} (${why})`, by: "rule" };
  };
  if (setting("STUB")) {
    // Stub mode: a bare "thanks" gets a reaction instead of a turn, as Mozart would give it.
    const f = ruled();
    if (msg.author === "user" && STUB_THANKS.test(msg.text.trim())) return { to: [], react: f.to.map((by) => ({ by, emoji: "🙏" })), why: "thanks", by: "mozart" };
    return { ...f, react: [], by: "rule" };
  }

  let i = all.indexOf(msg);
  if (i < 0) return rules("message gone");
  // A teammate's reply can be several bubbles in a row: they're one message.
  const parts = [msg];
  while (msg.author !== "user" && all[i + 1]?.author === msg.author && (all[i + 1].kind ?? "text") === "text") parts.push(all[++i]);
  const text = parts.map((m) => m.text).join("\n");
  const old = ch.mozart;
  const fresh = !old || (old.context ?? 0) > MAX_CONTEXT;
  // `seen` only moves when Mozart actually reads a line, so a message the caller skipped (mayBeAcknowledgment,
  // mayNeedFollowUp: no call made) is still ahead of `seen` and shows up in the next call. That's why skipping is safe.
  const from = fresh ? Math.max(0, i + 1 - FIRST_READ) : Math.min(old!.seen, i);
  const lines = withDays(all.slice(from, i + 1).filter((m) => m.kind !== "status"), o.line);
  const who = msg.author === "user" ? USER_NAME : nameOf(msg.author);
  const waiting = o.waitingOn && teammate(o.waitingOn) ? `\n(${nameOf(o.waitingOn)} asked ${USER_NAME} a question and is waiting for the answer.)` : "";
  const names = addressed?.map(nameOf).join(" and ");
  const prompt = [
    fresh ? `You're new in #${ch.name}. Its recent lines:` : `New in #${ch.name}:`,
    ...lines,
    "",
    `The latest message is ${who}'s: "${clip(text.replace(/\s+/g, " ").trim(), 400)}".${waiting}`,
    addressed?.length
      ? `It's for ${names} (named, or a reply to their message): they answer it, unless a reaction is all it needs. Only the JSON, with only ${addressed.join(", ")} in it.`
      : "Who should answer it now? Only the JSON.",
  ].join("\n");

  const session: MozartSession = fresh ? { sessionId: crypto.randomUUID(), createdAt: Date.now(), seen: 0, turns: 0, cost: 0 } : old!;
  const run = runAgent({
    agentId: "mozart",
    cwd: MOZART_DIR,
    prompt,
    sessionId: session.sessionId,
    resume: !fresh,
    title: mozartTitle(ch),
    allowedTools: [],
    systemPrompt: "",
    mode: [
      "--model", MODEL,
      "--effort", "low",
      "--system-prompt", mozartPrompt(ch),
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "project",
      "--disable-slash-commands",
    ],
    onActivity: () => {},
  });
  const timer = setTimeout(() => run.stop(), addressed?.length ? ADDRESSED_TIMEOUT_MS : TIMEOUT_MS);
  const r = await run.done.catch((e) => ({ text: String(e), isError: true, cost: 0, context: undefined }));
  clearTimeout(timer);
  recordResult("mozart", r, { channelId: ch.id });

  if (r.isError) {
    // A lost session file (deleted, another Mac): the next decision starts a new one.
    if (!fresh && /no conversation found/i.test(r.text)) {
      delete ch.mozart;
      saveChannels();
    }
    return rules("Mozart failed");
  }
  Object.assign(session, { seen: Math.max(session.seen, i + 1), turns: session.turns + 1, context: r.context ?? session.context, cost: session.cost + (r.cost ?? 0) });
  ch.mozart = session;
  saveChannels();
  const d = parseDecision(r.text);
  if (!d) return rules("Mozart's answer didn't parse");
  // Only your messages get reactions. A teammate that reacts doesn't also take a turn.
  const react = msg.author === "user" ? d.react.filter((x) => !addressed?.length || addressed.includes(x.by)) : [];
  const reacts = (id: string) => react.some((x) => x.by === id);
  // A message that names its teammates goes to them (unless they react); otherwise it never answers its own message.
  const to = addressed?.length ? addressed.filter((id) => !reacts(id)) : d.to.filter((id) => id !== msg.author && !reacts(id));
  return { to, react, why: d.why, by: "mozart" };
}

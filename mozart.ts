// Mozart: each channel's coordinator. After every message that doesn't name its teammate (an @mention, "Name, …" or a
// reply to a teammate's message goes straight there), the channel's Mozart decides who answers, if anyone: one
// teammate, several, or nobody. It's a Claude Code session of its own per channel (Haiku, no tools), so it remembers
// the channel's conversation, and each decision only appends the new lines (the prompt cache holds the rest).
// Nothing shows while it thinks; the teammate it picks starts typing.
//
// Without an answer from it (the call failed, timed out or answered nonsense, or the stub), simple rules decide: a
// teammate waiting on the user's answer gets it, else the teammate in the conversation, else the triage teammate.
import { readFileSync } from "node:fs";
import mozartRulesFile from "./mozart-rules.md" with { type: "file" };
import { MOZART_DIR } from "./paths";
import { env } from "./env";
import { ROSTER, TRIAGE, USER_NAME, nameOf, teammate } from "./roster";
import { runAgent } from "./runner";
import { saveChannels, type Channel, type Message, type MozartSession } from "./store";

export type Decision = { to: string[]; why: string; by: "mozart" | "rule" };

const MODEL = "claude-haiku-5-5";
/** A decision that takes longer than this falls back to the rules. */
const TIMEOUT_MS = 45_000;
/** A Mozart session that grew past this many tokens starts over (with the channel's recent lines). */
const MAX_CONTEXT = 60_000;
/** Lines a new Mozart session reads first. */
const FIRST_READ = 30;
/** Messages back the fallback rules look for the teammate the user is talking with. */
const CONVERSATION = 4;

const RULES = readFileSync(mozartRulesFile, "utf8");
const said = (m: Message) => m.author !== "system" && m.author !== "guest" && m.kind !== "status" && m.kind !== "job";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function mozartPrompt(ch: Channel) {
  const vars: Record<string, string> = {
    channel: ch.name,
    user: USER_NAME,
    triage: `${TRIAGE} (${nameOf(TRIAGE)})`,
    roster: ROSTER.map((t) => `- ${t.id}: ${t.name}, ${t.role}${t.routing ? `: ${t.routing}` : ""}`).join("\n"),
  };
  return RULES.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all);
}

export const mozartTitle = (ch: Channel) => `[Mozart] #${ch.name}`;

/** Teammate ids in Mozart's answer: `{"answer": [...], "why": "..."}`. Undefined when it isn't one. */
export function parseDecision(text: string): { to: string[]; why: string } | undefined {
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
    const key = String(x).trim().replace(/^@/, "").toLowerCase();
    const t = ROSTER.find((r) => r.id === key || r.name.toLowerCase() === key);
    if (!t) return; // an id it made up: don't trust the rest either
    if (!to.includes(t.id)) to.push(t.id);
  }
  return { to, why: clip(String(j.why ?? "").replace(/\s+/g, " ").trim(), 80) };
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
 * Who answers `msg` (a message in `ch`, already in `all`). `line` formats a message the way the teammates read it.
 * Calls for one channel must not overlap (the caller queues them): they share the channel's Mozart session.
 */
export async function decide(o: { ch: Channel; all: Message[]; msg: Message; line: (m: Message) => string; waitingOn?: string }): Promise<Decision> {
  const { ch, all, msg } = o;
  const rules = (why: string): Decision => {
    const f = fallback(all, msg, o.waitingOn);
    return { ...f, why: `${f.why} (${why})`, by: "rule" };
  };
  if (env("STUB")) return { ...fallback(all, msg, o.waitingOn), by: "rule" };

  let i = all.indexOf(msg);
  if (i < 0) return rules("message gone");
  // A teammate's reply can be several bubbles in a row: they're one message.
  const parts = [msg];
  while (msg.author !== "user" && all[i + 1]?.author === msg.author && (all[i + 1].kind ?? "text") === "text") parts.push(all[++i]);
  const text = parts.map((m) => m.text).join("\n");
  const old = ch.mozart;
  const fresh = !old || (old.context ?? 0) > MAX_CONTEXT;
  const from = fresh ? Math.max(0, i + 1 - FIRST_READ) : Math.min(old!.seen, i);
  const lines = all.slice(from, i + 1).filter((m) => m.kind !== "status").map(o.line);
  const who = msg.author === "user" ? USER_NAME : nameOf(msg.author);
  const waiting = o.waitingOn && teammate(o.waitingOn) ? `\n(${nameOf(o.waitingOn)} asked ${USER_NAME} a question and is waiting for the answer.)` : "";
  const prompt = [
    fresh ? `You're new in #${ch.name}. Its recent lines:` : `New in #${ch.name}:`,
    ...lines,
    "",
    `The latest message is ${who}'s: "${clip(text.replace(/\s+/g, " ").trim(), 400)}".${waiting}`,
    "Who should answer it now? Only the JSON.",
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
  const timer = setTimeout(() => run.stop(), TIMEOUT_MS);
  const r = await run.done.catch((e) => ({ text: String(e), isError: true, cost: 0, context: undefined }));
  clearTimeout(timer);

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
  // It never answers its own message.
  return { to: d.to.filter((id) => id !== msg.author), why: d.why, by: "mozart" };
}

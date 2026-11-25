// How messages are written for the teammates and read back from them: a message as one line, the catch-up a chat
// turn replays, a job's report cut for the channel, a reply's quote, and a reply split into bubbles. Kept apart from
// team.ts because none of it needs the Team, only the messages.
import { join } from "node:path";
import { DATA } from "./paths";
import { withDays } from "./dates";
import { filesLines } from "./attachments";
import { languageName } from "./voice";
import { USER_NAME, nameOf, teammate } from "./roster";
import type { Channel, Message } from "./store";

/** Where a channel is, as the teammates read it: "#name", or "your DM with <you>". */
export const placeOf = (ch: Channel) => (ch.dm ? `your DM with ${USER_NAME}` : `#${ch.name}`);
/** The same, as you read it (in the typing bar). */
export const shownAs = (ch: Channel) => (ch.dm ? "your DM" : `#${ch.name}`);

export const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
/** What a teammate answers when a turn needs nothing from it (chat-rules.md, "Is it your turn?"). */
export const NO_REPLY = /^`?\(?no reply\)?`?\.?$/i;
/** A hold-on line ("checking") shows only if the turn is still going this long after it was written. */
export const HOLD_ON_AFTER = 3000;

/** A reply that's only an emoji or three ("👍", "✅🙏"): shown as a reaction, not as a message. */
export const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

/** A reply split into WhatsApp-style bubbles at lines with only `---` (never inside a code block). */
export function bubbles(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const l of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^\s*---\s*$/.test(l)) {
      out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(l);
  }
  out.push(cur.join("\n"));
  return out.map((b) => b.trim()).filter(Boolean);
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…(cut)" : s);

/**
 * A message as the teammates (and Mozart) read it: "[14:02] Name: text". With `channelId`, each attached file follows
 * on a line of its own with its path, so a teammate can open it; without (Mozart), only the files' names.
 */
export function line(m: Message, channelId?: string): string {
  if (m.kind === "permission") {
    const p = m.meta!.permission!;
    const verdict = { pending: "is waiting on", once: "allowed once", always: "allowed for this channel", denied: "denied" }[p.status];
    return `[${time(m.ts)}] (event) ${USER_NAME} ${verdict}: ${nameOf(p.agentId)}${p.jobId ? `'s job ${p.jobId}` : ""} wants ${p.rule}`;
  }
  if (m.kind === "tools") {
    const r = m.meta!.toolRequest!;
    const verdict = { pending: "hasn't decided yet on", approved: "approved", denied: "denied" }[r.status];
    return `[${time(m.ts)}] (event) ${USER_NAME} ${verdict} ${nameOf(r.agentId)}'s request for ${r.tools.map((t) => t.name).join(", ")}`;
  }
  if (m.kind === "job") return `[${time(m.ts)}] (event) ${nameOf(m.author)} ${m.text}`;
  if (m.author === "system") return `[${time(m.ts)}] (event) ${m.text}`;
  const files = m.meta?.files?.length ? (channelId ? filesLines(channelId, m.meta.files) : ` (attached: ${m.meta.files.map((f) => f.name).join(", ")})`) : "";
  const voice = m.meta?.voice ? ` (voice message in ${languageName(m.meta.voice.language)}, transcribed by speech recognition, so a word may be misheard)` : "";
  if (m.author === "guest") return `[${time(m.ts)}] ${m.meta?.guest?.name ?? "Someone"} (in ${m.meta?.via === "teams" ? "Teams" : "Slack"})${voice}: ${m.text}${files}`;
  const re = m.meta?.replyTo;
  // A teammate's emoji on your message (instead of a turn, or as its whole answer): it's been answered.
  const reacted = m.author === "user" ? (m.meta?.reactions ?? []).filter((x) => teammate(x.by)).map((x) => `${nameOf(x.by)} ${x.emoji}`) : [];
  const quote = re && m.meta?.feedbackFor ? ` (feedback for ${nameOf(m.meta.feedbackFor)} on its message "${re.text.replace(/\s+/g, " ").slice(0, 200)}")` : re ? ` (replying to ${re.author === "user" ? "their own" : `${nameOf(re.author)}'s`} message "${re.text.replace(/\s+/g, " ").slice(0, 200)}")` : "";
  return `[${time(m.ts)}] ${nameOf(m.author)}${quote}${voice}: ${m.text}${files}${reacted.length ? ` (reacted: ${reacted.join(", ")})` : ""}`;
}

/** Most lines a chat turn replays from the channel, however long the teammate was away. */
export const CATCH_UP_LINES = 40;
/** A message from someone else is replayed to a teammate up to this long; the channel file has the rest. */
export const OTHERS_MESSAGE_CHARS = 1200;
/** A finished job's report is put in the channel up to this long; the job card keeps all of it. */
export const REPORT_IN_CHAT = 3000;

/** The last CATCH_UP_LINES of `fresh`, plus any dropped permission or tools card still waiting on a decision. */
export function capCatchUp(fresh: Message[]): { kept: Message[]; dropped: number } {
  if (fresh.length <= CATCH_UP_LINES) return { kept: fresh, dropped: 0 };
  const cut = fresh.length - CATCH_UP_LINES;
  const pending = (m: Message) => (m.kind === "permission" && m.meta?.permission?.status === "pending") || (m.kind === "tools" && m.meta?.toolRequest?.status === "pending");
  const rescued = fresh.slice(0, cut).filter(pending);
  return { kept: [...rescued, ...fresh.slice(cut)], dropped: cut - rescued.length };
}

/** A message's text for another teammate's turn: long ones cut, saying where the rest is. */
export function clipOthers(m: Message): Message {
  if (m.author === "user" || m.text.length <= OTHERS_MESSAGE_CHARS) return m;
  const more = m.text.length - OTHERS_MESSAGE_CHARS;
  return { ...m, text: `${m.text.slice(0, OTHERS_MESSAGE_CHARS)}…(cut: ${more} more characters; the full message is in the channel file, id ${m.id})` };
}

/** The lines of a chat turn: the capped catch-up, a note when lines were dropped, long messages by others clipped. */
export function catchUpLines(fresh: Message[], channelId: string): string[] {
  const { kept, dropped } = capCatchUp(fresh);
  const note = dropped ? [`(${dropped} earlier messages here are not shown. The whole channel is in ${join(DATA, "messages", `${channelId}.json`)}; read it if you need them.)`] : [];
  return [...note, ...withDays(kept, (m) => line(clipOthers(m), channelId))];
}

/** A job's report for the channel: cut, with where the whole of it is. */
export function reportInChat(text: string, jobId: string): string {
  if (text.length <= REPORT_IN_CHAT) return text;
  return `${text.slice(0, REPORT_IN_CHAT)}\n…(cut: ${text.length - REPORT_IN_CHAT} more characters; the full report is on the job card and in ${join(DATA, "channels.json")} under job ${jobId}, field report)`;
}

/**
 * A voice message doesn't change the conversation's language: it goes on in the language it started in. The
 * conversation is the thread the voice message replies in (its first message), else the channel. Empty when the voice
 * message starts it, or it started in the same language.
 */
export function keepLanguage(all: Message[], voiced: Message): string {
  const said = (m: Message) => (m.author === "user" || teammate(m.author)) && (!m.kind || m.kind === "text") && !m.meta?.interim && !!m.text.trim();
  const root = voiced.meta?.replyTo && all.find((m) => m.id === voiced.meta!.replyTo!.id);
  const first = root && said(root) ? root : all.find(said);
  const spoken = voiced.meta!.voice!.language;
  if (!first || first.id === voiced.id) return "";
  const lang = (tag: string) => tag.split(/[-_]/)[0].toLowerCase();
  if (first.meta?.voice) {
    if (lang(first.meta.voice.language) === lang(spoken)) return "";
    return `${USER_NAME}'s voice message was in ${languageName(spoken)}, but this conversation started in ${languageName(first.meta.voice.language)}: keep writing in ${languageName(first.meta.voice.language)}.`;
  }
  const opening = first.text.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${USER_NAME}'s voice message was in ${languageName(spoken)}, but keep writing in the language this ${root ? "thread" : "conversation"} started in, the language of its first message: "${opening}".`;
}

/** What a reply quotes from a message: its text, what the card is, or the files it carries. */
export function replyText(m: Message): string {
  if (m.kind === "job") return m.text;
  if (m.kind === "permission") return `asks to use ${m.meta?.permission?.tool}`;
  if (m.kind === "tools") return `asks for ${m.meta?.toolRequest?.tools.map((t) => t.name).join(", ")}`;
  return m.text || (m.meta?.files?.length ? `📎 ${m.meta.files.map((f) => f.name).join(", ")}` : "");
}

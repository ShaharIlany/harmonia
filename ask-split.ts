// Splitting a teammate's message that asks you several things into its questions, for the "Waiting on you" panel.
// Mozart (Haiku, one shot, no tools) reads the message and what came just before it, and lists each question with the
// answer the teammate itself picked and the other answer it offered. The panel shows each one with one-click answers and
// a box of its own, and sends them as one numbered reply (public/app.js). Pure, so it can be tested without a run.
import { USER_NAME } from "./roster";

/** recommended: the teammate's own pick ("" without one). alternative: the other answer it offered. other: with no pick,
 * a second answer it offered, so an either/or still gets both. */
export type AskQuestion = { question: string; recommended: string; alternative: string; other?: string };

/** A message with fewer question marks than this isn't sent to Mozart: one question needs no splitting. */
export const MIN_MARKS = 2;
const MAX_QUESTIONS = 8;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Whether a message might ask several things (worth a Mozart call). */
export const mightAskSeveral = (text: string) => (text.match(/[?？؟]/g) ?? []).length >= MIN_MARKS;

export const splitSystem = () =>
  `You split a teammate's chat message to ${USER_NAME} into the separate questions it asks ${USER_NAME}, so ${USER_NAME} can answer each with one click.

You get the lines that came before the message (context only) and the message. Return only a JSON array, nothing before or after it:
[{"question": "...", "recommended": "...", "alternative": "...", "other": "..."}]

- One entry per question the message asks ${USER_NAME} to answer or decide, in the message's order. Keep each question's own words, without its number; shorten only a very long one.
- "recommended": the answer the teammate itself picked or recommended for that question ("my pick", "I'd go with", "I recommend", "my vote", or its pick stated in the lines before). Write it as ${USER_NAME}'s short answer ("CSS restyle"). If the teammate picked nothing for that question, "": never pick one yourself.
- "alternative": the other answer the teammate offered (the other side of an either/or, or the other of yes/no). Short, as ${USER_NAME}'s answer. When the teammate picked nothing, the first answer it offered (for a yes/no question, "Yes"). "" only when the question offers no answers at all (an open question).
- "other": only when the teammate picked nothing: the second answer it offered (for a yes/no question, "No"). Otherwise "".
- Write the answers in the message's language.
- If the message asks ${USER_NAME} only one question, or none, return [].`;

/** What Mozart reads: the lines before the message, then the message. */
export const splitPrompt = (before: string[], text: string) =>
  [before.length ? `The lines before it:\n${before.map((l) => clip(l, 1500)).join("\n")}\n` : "", `The message:\n${clip(text, 4000)}`, "", "Only the JSON array."].join("\n");

/**
 * Words that mark a teammate's own pick. A `recommended` answer is kept only next to one of them (see `markedPick`).
 * "recommended" counts only as "(recommended)" or a leading "Recommended:", not inside a question's own words.
 */
const PICK_MARKS = new RegExp(
  [
    "my (?:pick|vote|choice|recommendation)",
    "i(?:'|’)?d (?:go with|pick|choose|suggest|recommend)",
    "i would (?:go with|pick|choose|suggest|recommend)",
    "i (?:recommend|suggest|prefer|lean)",
    "\\(recommended\\)",
    "(?:^|\\n)\\s*(?:\\d+[.)]\\s*)?recommended\\s*:",
    "(?:הבחירה|ההמלצה|ההצבעה) שלי",
    "אני (?:ממליץ|ממליצה|מציע|מציעה|בעד|הולך על|הולכת על)",
    "הייתי (?:הולך|הולכת|בוחר|בוחרת)",
  ].join("|"),
  "giu",
);
/** How far from a pick mark (characters, either side) the pick's words may be. */
const NEAR = 60;
/** The pick's words end at a sentence end, a comma, or an "or" / "but": what follows isn't about the pick. */
const WINDOW_END = /[.?!\n,;]|\s(?:or|but|או|אבל)\s/;
const STOP = new Set(["a", "an", "is", "it", "to", "of", "be", "the", "and", "for", "with", "like"]);
/** A word's forms: itself and, in Hebrew, without one prefix letter (ה ו ב ל מ ש כ: "העיצוב" → "עיצוב"). */
const forms = (w: string) => (/^[הובלמשכ]\p{L}{2,}$/u.test(w) ? [w, w.slice(1)] : [w]);
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const short = (w: string) => [...w].length <= 2;
/** "is", "to", "it" …: filler between a mark and the pick. A single letter ("A", "B") is never filler: it's a label. */
const filler = (w: string) => STOP.has(w) && [...w].length > 1;

/**
 * Whether `answer` is the teammate's own pick in `source` (the message and the lines before it). Its longer words sit
 * next to a pick mark, in the same clause ("A (my pick) or B?", "My pick is A."). A short word or label in it ("A",
 * "No", "כן") must sit right at the mark: the word before it, or one of the first three after it.
 */
export function markedPick(answer: string, source: string): boolean {
  const want = tokens(answer);
  const long = want.filter((w) => !short(w) && !STOP.has(w));
  const labels = want.filter((w) => short(w) && !filler(w));
  if (!long.length && !labels.length) return false;
  const low = source.toLowerCase();
  for (const m of low.matchAll(PICK_MARKS)) {
    const left = tokens(low.slice(Math.max(0, m.index - NEAR), m.index).split(WINDOW_END).pop()!);
    const right = tokens(low.slice(m.index + m[0].length, m.index + m[0].length + NEAR).split(WINDOW_END)[0]);
    const near = new Set([...left, ...right].filter((w) => !short(w) && !STOP.has(w)).flatMap(forms));
    const close = new Set([...left.slice(-1), ...right.filter((w) => !filler(w)).slice(0, 3)]);
    if (labels.every((w) => close.has(w)) && long.filter((w) => forms(w).some((f) => near.has(f))).length * 2 >= long.length) return true;
  }
  return false;
}

/**
 * Mozart's answer as questions. Undefined when it isn't a JSON array of them; [] when the message asks one thing or none,
 * or more than MAX_QUESTIONS (the single card shows). With `source` (the message and the lines before it), a
 * `recommended` answer the teammate didn't mark as its pick there becomes a plain answer.
 */
export function parseSplit(text: string, source?: string): AskQuestion[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return;
  let j: unknown;
  try {
    j = JSON.parse(text.slice(start, end + 1));
  } catch {
    return;
  }
  if (!Array.isArray(j)) return;
  const str = (x: unknown) => (typeof x === "string" ? clip(x.replace(/\s+/g, " ").trim(), 300) : "");
  const out: AskQuestion[] = [];
  for (const q of j) {
    if (!q || typeof q !== "object") return;
    const question = str((q as any).question);
    if (!question) return;
    let recommended = str((q as any).recommended);
    let [alt, oth] = [str((q as any).alternative), str((q as any).other)];
    if (recommended && source !== undefined && !markedPick(recommended, source)) [recommended, alt, oth] = ["", recommended, alt];
    // Each answer once: a repeat (or a pick and a second answer both) is dropped.
    const seen = new Set([recommended.toLowerCase()]);
    const once = (v: string) => (v && !seen.has(v.toLowerCase()) ? (seen.add(v.toLowerCase()), v) : "");
    const alternative = once(alt);
    const other = recommended ? "" : once(oth);
    out.push(other ? { question, recommended, alternative, other } : { question, recommended, alternative });
  }
  return out.length < 2 || out.length > MAX_QUESTIONS ? [] : out;
}

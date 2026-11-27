// Routing test set for Mozart (mozart-rules.md). Run it after changing the rules: `bun evals/mozart-eval.ts`.
// Each case in mozart-cases.json is sent to a fresh Haiku call with the same system prompt and the same user prompt
// `decide` builds (mozart.ts), and the answer must match what the case expects. It starts real `claude` runs (one per
// case), so it costs a little and needs `claude` to be signed in. `--dry` only prints the prompts.
//
//   bun evals/mozart-eval.ts [--dry] [--threshold 0.9] [--only "name part"]
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cases name the user "Alex" and the bundled team: use a throwaway data folder so the user's own roster and
// settings don't change the prompts. Set before the imports below read them.
process.env.HARMONIA_USER = "Alex";
process.env.HARMONIA_DATA ??= mkdtempSync(join(tmpdir(), "harmonia-eval-"));
delete process.env.HARMONIA_STUB;

const { mozartMode, mozartPrompt, mozartUserPrompt, parseDecision } = await import("../mozart");
const { runAgent } = await import("../runner");
const { MOZART_DIR } = await import("../paths");
const { ROSTER, USER_NAME, nameOf } = await import("../roster");

type Case = {
  name: string;
  lines: string[]; // the channel lines Mozart is shown, the latest message last
  latest: { author: string; text: string }; // "user" or a teammate id
  waitingOn?: string;
  addressed?: string[];
  /** `answer`: the teammates that answer. `answerAnyOf`: other sets that also pass. `react`: who reacts, any allowed emoji. */
  expect: { answer: string[]; answerAnyOf?: string[][]; react?: string[] };
};

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const THRESHOLD = Number(value("--threshold") ?? 0.9);
const CONCURRENCY = 4;
const ALLOWED_EMOJI = ["👍", "❤️", "🙏", "👌", "🎉", "😄", "✅", "🙌"];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const list = (ids: string[]) => (ids.length ? ids.join(", ") : "nobody");

const cases: Case[] = JSON.parse(readFileSync(join(import.meta.dir, "mozart-cases.json"), "utf8"));
const only = value("--only")?.toLowerCase();
const chosen = only ? cases.filter((c) => c.name.toLowerCase().includes(only)) : cases;
const ch = { name: "general" } as any; // mozartPrompt only reads the channel's name

for (const c of cases) {
  for (const id of [...c.expect.answer, ...(c.expect.answerAnyOf ?? []).flat(), ...(c.expect.react ?? []), ...(c.addressed ?? []), ...(c.waitingOn ? [c.waitingOn] : [])])
    if (!ROSTER.some((r) => r.id === id)) throw new Error(`"${c.name}": ${id} isn't a teammate`);
}

/** The user prompt `decide` sends for a case (a new session: the lines are the channel's recent ones). */
const userPrompt = (c: Case) =>
  mozartUserPrompt({
    channel: ch.name,
    fresh: true,
    lines: c.lines,
    who: c.latest.author === "user" ? USER_NAME : nameOf(c.latest.author),
    text: c.latest.text,
    waitingOn: c.waitingOn,
    addressed: c.addressed,
  });

if (flag("--dry")) {
  console.log(`SYSTEM PROMPT (the same for every case):\n${mozartPrompt(ch)}\n`);
  for (const c of chosen) console.log(`${"=".repeat(70)}\nCASE: ${c.name}\n${"-".repeat(70)}\n${userPrompt(c)}\n`);
  console.log(`${chosen.length} cases (dry run, nothing was called).`);
  process.exit(0);
}

type Outcome = { c: Case; ok: boolean; got: string; why: string };

async function ask(c: Case): Promise<Outcome> {
  // No saved session: every case is a fresh Haiku call, like a Mozart that has just started in the channel.
  const run = runAgent({
    agentId: "mozart",
    cwd: MOZART_DIR,
    prompt: userPrompt(c),
    sessionId: crypto.randomUUID(),
    resume: false,
    ephemeral: true,
    title: `[Mozart eval] ${c.name}`.slice(0, 80),
    allowedTools: [],
    systemPrompt: "",
    mode: mozartMode(ch),
    onActivity: () => {},
  });
  const timer = setTimeout(() => run.stop(), 60_000);
  const r = await run.done.catch((e) => ({ text: String(e), isError: true }));
  clearTimeout(timer);
  const d = r.isError ? undefined : parseDecision(r.text);
  if (!d) return { c, ok: false, got: `(no usable answer) ${String(r.text).slice(0, 120)}`, why: "" };

  // What `decide` does with the answer: only your messages get reactions, the author never answers its own message,
  // and a message that names its teammates goes to them unless they react.
  const react = c.latest.author === "user" ? d.react.filter((x) => !c.addressed?.length || c.addressed.includes(x.by)) : [];
  const reacts = (id: string) => react.some((x) => x.by === id);
  const to = c.addressed?.length ? c.addressed.filter((id) => !reacts(id)) : d.to.filter((id) => id !== c.latest.author && !reacts(id));

  const answerOk = [c.expect.answer, ...(c.expect.answerAnyOf ?? [])].some((set) => same(set, to));
  const reactOk = same(c.expect.react ?? [], react.map((x) => x.by)) && react.every((x) => ALLOWED_EMOJI.includes(x.emoji));
  const got = `answer: ${list(to)}${react.length ? `; react: ${react.map((x) => `${x.by} ${x.emoji}`).join(", ")}` : ""}`;
  return { c, ok: answerOk && reactOk, got, why: d.why };
}

const outcomes: Outcome[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, chosen.length) }, async () => {
    while (next < chosen.length) {
      const c = chosen[next++];
      const o = await ask(c);
      outcomes.push(o);
      console.log(`${o.ok ? "PASS" : "FAIL"}  ${c.name}`);
      if (!o.ok) {
        const e = c.expect;
        const any = e.answerAnyOf?.length ? ` (or ${e.answerAnyOf.map(list).join(" / ")})` : "";
        console.log(`      expected answer: ${list(e.answer)}${any}${e.react?.length ? `; react: ${e.react.join(", ")}` : ""}`);
        console.log(`      got:             ${o.got}${o.why ? `  [${o.why}]` : ""}`);
      }
    }
  }),
);

const passed = outcomes.filter((o) => o.ok).length;
const rate = outcomes.length ? passed / outcomes.length : 0;
console.log(`\n${passed}/${outcomes.length} passed (${Math.round(rate * 100)}%), threshold ${Math.round(THRESHOLD * 100)}%`);
process.exit(rate >= THRESHOLD ? 0 : 1);

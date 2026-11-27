// Continue on "Paused after 8 turns": the teammates the pause held back carry on, the turn count starts over, and the
// button can't be used twice, nor after you replied. Stub runs only (no `claude`). Run with `bun test`.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "harmonia-test-"));
// team.ts reads these when it's imported, so they come first. Agent files with LF line ends (see team-rules.test.ts).
mkdirSync(join(tmp, ".claude", "agents"), { recursive: true });
for (const f of readdirSync(join(root, "agents")))
  if (f.endsWith(".md")) writeFileSync(join(tmp, ".claude", "agents", f), readFileSync(join(root, "agents", f), "utf8").split(String.fromCharCode(13)).join(""));
Object.assign(process.env, { HARMONIA_DATA: join(tmp, "data"), HARMONIA_STUB: "1", HARMONIA_USER: "Alex", USERPROFILE: tmp, HOME: tmp });

const { Team } = await import("../team");
const { createChannel, messages } = await import("../store");
const { DATA } = await import("../paths");
const { card } = await import("../slack/blocks");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("Continue wakes the held-back teammates and resets the turns", async () => {
  const events: any[] = [];
  const team = new Team((e) => events.push(e), "http://127.0.0.1:1");
  const ch = createChannel("pause-test", tmp);
  const t = team as any;

  // Out of turns: Leo hands to Elliot and Murphy, and both are held back by one pause message.
  t.turnsLeft.set(ch.id, 0);
  const handoff = team.post(ch, { author: "leo", text: "@Elliot build it, @Murphy test it" });
  t.wake(ch, "elliot", handoff);
  t.wake(ch, "murphy", handoff);
  const pauses = (messages.get(ch.id) ?? []).filter((m) => m.meta?.paused);
  expect(pauses.length).toBe(1);
  const pause = pauses[0];
  expect(pause.meta!.paused).toEqual({ agents: [{ id: "elliot", cause: handoff.id, seen: -1 }, { id: "murphy", cause: handoff.id, seen: -1 }], status: "pending" });

  // The Slack card has the Continue button while it waits.
  expect(JSON.stringify(card(pause, ch))).toContain("harmonia:continue:go");

  expect(team.continueAfterPause(ch, pause.id)).toBeUndefined();
  expect(pause.meta!.paused!.status).toBe("continued");
  expect(team.continueAfterPause(ch, pause.id)).toBe("Already continued.");
  expect(events.some((e) => e.type === "update" && e.message.id === pause.id)).toBe(true);
  // No message from the user: only the teammates' answers follow.
  const before = messages.get(ch.id)!.length;

  const deadline = Date.now() + 15_000;
  const answered = () => ["elliot", "murphy"].every((id) => messages.get(ch.id)!.some((m) => m.author === id));
  while (!answered() && Date.now() < deadline) await Bun.sleep(200);
  expect(answered()).toBe(true);
  // Their answers are threaded to the handoff they were woken for.
  expect(messages.get(ch.id)!.find((m) => m.author === "elliot")!.meta?.answers).toBe(handoff.id);
  expect(messages.get(ch.id)!.slice(before).some((m) => m.author === "user")).toBe(false);
  expect(t.turnsLeft.get(ch.id)).toBeGreaterThanOrEqual(6); // 8, less the two turns just taken

  // After it's used, the Slack card says so instead of the button.
  const done = JSON.stringify(card(pause, ch));
  expect(done).toContain("Continued");
  expect(done).not.toContain("harmonia:continue:go");
}, 30_000);

/** Out of turns, Leo hands to Elliot and Murphy: one pause holds both back. */
function paused(team: any, name: string) {
  const ch = createChannel(name, tmp);
  team.turnsLeft.set(ch.id, 0);
  const handoff = team.post(ch, { author: "leo", text: "@Elliot build it, @Murphy test it" });
  team.wake(ch, "elliot", handoff);
  team.wake(ch, "murphy", handoff);
  const pause = messages.get(ch.id)!.find((m) => m.meta?.paused)!;
  return { ch, handoff, pause };
}

test("a reply first closes the pause, and a later Continue is refused", async () => {
  const events: any[] = [];
  const team = new Team((e) => events.push(e), "http://127.0.0.1:1");
  const { ch, pause } = paused(team, "pause-replied");
  team.userMessage(ch, "thanks");
  expect(pause.meta!.paused!.status).toBe("replied");
  expect(events.some((e) => e.type === "update" && e.message.id === pause.id && e.message.meta.paused.status === "replied")).toBe(true);
  // The Slack card says so instead of the button.
  const c = JSON.stringify(card(pause, ch));
  expect(c).toContain("You replied");
  expect(c).not.toContain("harmonia:continue:go");

  (team as any).turnsLeft.set(ch.id, 1); // the chain your reply started, nearly spent
  expect(team.continueAfterPause(ch, pause.id)).toBe("You already replied.");
  expect((team as any).turnsLeft.get(ch.id)).toBe(1); // not uncapped

  // The fallback: a pause still open with a message of yours after it (written without userMessage) is refused too.
  const other = paused(team, "pause-fallback");
  team.post(other.ch, { author: "user", text: "hm" });
  expect(team.continueAfterPause(other.ch, other.pause.id)).toBe("You already replied.");
  expect(other.pause.meta!.paused!.status).toBe("replied");
});

test("after a restart, Continue wakes only the still-held teammates, in the handoff's thread", async () => {
  const before = new Team(() => {}, "http://127.0.0.1:1");
  const { ch, handoff, pause } = paused(before, "pause-restart");
  await Bun.sleep(300); // saves are queued
  const saved = JSON.parse(readFileSync(join(DATA, "messages", `${ch.id}.json`), "utf8"));
  expect(saved.find((m: any) => m.id === pause.id).meta.paused.agents).toEqual([
    { id: "elliot", cause: handoff.id, seen: -1 },
    { id: "murphy", cause: handoff.id, seen: -1 },
  ]);

  // Murphy had a turn since (after a tool approval, say) and read past the pause: Continue leaves it be.
  ch.lastSeen.murphy = messages.get(ch.id)!.length;
  const after = new Team(() => {}, "http://127.0.0.1:1"); // a new server: nothing in `causes`
  expect(after.continueAfterPause(ch, pause.id)).toBeUndefined();
  const deadline = Date.now() + 15_000;
  const answer = () => messages.get(ch.id)!.find((m) => m.author === "elliot");
  while (!answer() && Date.now() < deadline) await Bun.sleep(200);
  expect(answer()?.meta?.answers).toBe(handoff.id);
  await Bun.sleep(300);
  expect(messages.get(ch.id)!.some((m) => m.author === "murphy")).toBe(false);
}, 30_000);

test("a teammate added to an open pause later is woken too", async () => {
  const team = new Team(() => {}, "http://127.0.0.1:1");
  const { ch, handoff, pause } = paused(team, "pause-added");
  // Leo is held back by the same pause, after other messages: its position is what it had read, not the pause's.
  team.post(ch, { author: "emily", text: "ping" });
  (team as any).wake(ch, "leo", handoff);
  expect(pause.meta!.paused!.agents.map((a: any) => a.id)).toEqual(["elliot", "murphy", "leo"]);
  expect(team.continueAfterPause(ch, pause.id)).toBeUndefined();
  const deadline = Date.now() + 15_000;
  const done = () => ["elliot", "murphy", "leo"].every((id) => messages.get(ch.id)!.some((m) => m.author === id && m.id !== handoff.id));
  while (!done() && Date.now() < deadline) await Bun.sleep(200);
  expect(done()).toBe(true);
}, 30_000);

test("a teammate busy in another channel still gets its turn here, queued", async () => {
  const team = new Team(() => {}, "http://127.0.0.1:1");
  const t = team as any;
  const { ch, pause } = paused(team, "pause-busy");
  const elsewhere = createChannel("pause-elsewhere", tmp);
  t.busy.set("elliot", { channelId: elsewhere.id, stop: () => {}, events: [] }); // at work in another channel
  expect(team.continueAfterPause(ch, pause.id)).toBeUndefined();
  expect(t.queue.get("elliot")).toEqual([ch.id]); // waiting for it, not dropped
  const deadline = Date.now() + 15_000;
  while (!messages.get(ch.id)!.some((m) => m.author === "murphy") && Date.now() < deadline) await Bun.sleep(200);
  expect(messages.get(ch.id)!.some((m) => m.author === "murphy")).toBe(true); // the others go on
});

test("a pause saved with plain ids still continues", async () => {
  const team = new Team(() => {}, "http://127.0.0.1:1");
  const { ch, handoff, pause } = paused(team, "pause-legacy");
  pause.meta!.paused!.agents = ["elliot"];
  expect(team.continueAfterPause(ch, pause.id)).toBeUndefined();
  const deadline = Date.now() + 15_000;
  while (!messages.get(ch.id)!.some((m) => m.author === "elliot") && Date.now() < deadline) await Bun.sleep(200);
  expect(messages.get(ch.id)!.some((m) => m.author === "elliot")).toBe(true);
  expect(messages.get(ch.id)!.some((m) => m.author === "murphy")).toBe(false); // it wasn't on the old pause
});

test("a reset session (lastSeen cleared) after the pause still gets woken", async () => {
  const team = new Team(() => {}, "http://127.0.0.1:1");
  const ch = createChannel("pause-reset", tmp);
  (team as any).turnsLeft.set(ch.id, 0);
  team.post(ch, { author: "user", text: "go" });
  ch.lastSeen.elliot = 1; // it had read the channel up to here
  const handoff = team.post(ch, { author: "leo", text: "@Elliot build it" });
  (team as any).turnsLeft.set(ch.id, 0);
  (team as any).wake(ch, "elliot", handoff);
  const pause = messages.get(ch.id)!.find((m) => m.meta?.paused)!;
  expect((pause.meta!.paused!.agents[0] as any).seen).toBe(1);
  delete ch.lastSeen.elliot; // dropSession: it re-reads the channel as new
  expect(team.continueAfterPause(ch, pause.id)).toBeUndefined();
  const deadline = Date.now() + 15_000;
  while (!messages.get(ch.id)!.some((m) => m.author === "elliot") && Date.now() < deadline) await Bun.sleep(200);
  expect(messages.get(ch.id)!.some((m) => m.author === "elliot")).toBe(true);
}, 30_000);

import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The modules read their folders when imported, so point them at temp folders first.
const home = mkdtempSync(join(tmpdir(), "harmonia-test-home-"));
mkdirSync(join(home, ".claude"), { recursive: true });
cpSync(join(import.meta.dir, "..", "agents"), join(home, ".claude", "agents"), { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-test-data-"));
process.env.HARMONIA_STUB = "1";

const { mayBeAcknowledgment, mayNeedFollowUp } = await import("../mozart");
const { ROSTER } = await import("../roster");

const user = (text: string, meta?: any) => ({ id: "m", author: "user", text, ...(meta && { meta }) }) as any;
const [a, b] = ROSTER;
const chan = (o: any = {}) => ({ jobs: [], ...o }) as any;

test("mayBeAcknowledgment: short bare thanks only", () => {
  expect(mayBeAcknowledgment(user("thanks!"))).toBe(true);
  expect(mayBeAcknowledgment(user("Elliot, no need, thanks"))).toBe(true);
  expect(mayBeAcknowledgment(user("thanks, can you also check it?"))).toBe(false);
  expect(mayBeAcknowledgment(user("thanks", { files: [{ name: "x" }] }))).toBe(false);
  expect(mayBeAcknowledgment(user("thanks", { voice: { language: "en" } }))).toBe(false);
  expect(mayBeAcknowledgment(user("ok `x`"))).toBe(false);
  expect(mayBeAcknowledgment(user("ok https://example.com"))).toBe(false);
  expect(mayBeAcknowledgment(user("one two three four five six seven eight nine ten eleven twelve thirteen"))).toBe(false);
});

test("mayNeedFollowUp: names, running jobs, waiting", () => {
  expect(mayNeedFollowUp("All done.", a.id, chan())).toBe(false);
  expect(mayNeedFollowUp(`${b.name}, can you try to break it?`, a.id, chan())).toBe(true);
  expect(mayNeedFollowUp(`${b.name.toLowerCase()}s are fine`, a.id, chan())).toBe(false); // not a whole word
  expect(mayNeedFollowUp(`I am ${a.name}`, a.id, chan())).toBe(false); // own name
  expect(mayNeedFollowUp("done", a.id, chan({ jobs: [{ status: "running", agentId: b.id }] }))).toBe(true);
  expect(mayNeedFollowUp("done", a.id, chan({ jobs: [{ status: "running", agentId: a.id }, { status: "done", agentId: b.id }] }))).toBe(false);
  expect(mayNeedFollowUp("done", a.id, chan({ waitingOn: b.id }))).toBe(true);
  expect(mayNeedFollowUp("done", a.id, chan({ waitingOn: a.id }))).toBe(false);
});

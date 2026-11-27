import { beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// team.ts reads its folders when imported, so point them at temp ones first.
const tmp = mkdtempSync(join(tmpdir(), "harmonia-test-"));
process.env.HARMONIA_DATA = join(tmp, "data");
process.env.HARMONIA_STUB = "1";
process.env.USERPROFILE = process.env.HOME = tmp;
cpSync(join(import.meta.dir, "..", "agents"), join(tmp, ".claude", "agents"), { recursive: true });

let t: typeof import("../team");
beforeAll(async () => {
  t = await import("../team");
});

const msg = (i: number, extra: object = {}): any => ({ id: `m${i}`, ts: 1000 + i, author: "elliot", text: `hi ${i}`, ...extra });

test("every new line is replayed, however many", () => {
  const lines = t.catchUpLines(Array.from({ length: 120 }, (_, i) => msg(i)), "c1");
  expect(lines.length).toBe(121); // the day line and 120 messages
});

test("long messages from others are clipped, the user's never", () => {
  const long = "x".repeat(5000);
  const clipped = t.clipOthers(msg(1, { text: long }));
  expect(clipped.text.startsWith("x".repeat(t.OTHERS_MESSAGE_CHARS) + "…(cut: 3800 more characters")).toBe(true);
  expect(clipped.text).toContain("id m1)");
  const mine = msg(2, { author: "user", text: long });
  expect(t.clipOthers(mine)).toBe(mine);
  expect(t.clipOthers(msg(3)).text).toBe("hi 3");
});

test("attached-file lines are not inside the clipped text", () => {
  const m = msg(1, { text: "y".repeat(3000), meta: { files: [{ id: "0123456789ab", name: "a.txt", type: "text/plain", size: 1 }] } });
  const l = t.catchUpLines([m], "c1")[1]; // [0] is the day line
  expect(l.indexOf("…(cut:")).toBeLessThan(l.indexOf("a.txt"));
});

test("job reports in chat are cut at 3000 and name the job", () => {
  expect(t.reportInChat("short", "j1")).toBe("short");
  const out = t.reportInChat("z".repeat(4000), "j9");
  expect(out.startsWith("z".repeat(3000) + "\n…(cut: 1000 more")).toBe(true);
  expect(out).toContain("job j9");
  expect(out).toContain("channels.json");
});

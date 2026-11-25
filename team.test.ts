import { beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// team.ts reads its folders when imported, so point them at temp ones first.
const tmp = mkdtempSync(join(tmpdir(), "harmonia-test-"));
process.env.HARMONIA_DATA = join(tmp, "data");
process.env.HARMONIA_STUB = "1";
process.env.USERPROFILE = process.env.HOME = tmp;
cpSync(join(import.meta.dir, "agents"), join(tmp, ".claude", "agents"), { recursive: true });

let t: typeof import("./team");
beforeAll(async () => {
  t = await import("./team");
});

const msg = (i: number, extra: object = {}): any => ({ id: `m${i}`, ts: 1000 + i, author: "elliot", text: `hi ${i}`, ...extra });
const card = (i: number, status: string): any =>
  msg(i, { kind: "permission", author: "system", meta: { permission: { status, agentId: "elliot", rule: "Bash" } } });

test("catch-up keeps the last 40 lines and counts the rest", () => {
  const all = Array.from({ length: 112 }, (_, i) => msg(i));
  const { kept, dropped } = t.capCatchUp(all);
  expect(kept.length).toBe(t.CATCH_UP_LINES);
  expect(kept[0].id).toBe("m72");
  expect(dropped).toBe(72);
  expect(t.capCatchUp(all.slice(0, 40)).dropped).toBe(0);
});

test("a pending card among the dropped lines is kept, a decided one is not", () => {
  const all = [card(0, "pending"), card(1, "once"), ...Array.from({ length: 60 }, (_, i) => msg(i + 2))];
  const { kept, dropped } = t.capCatchUp(all);
  expect(kept[0].id).toBe("m0");
  expect(kept.some((m) => m.id === "m1")).toBe(false);
  expect(kept.length).toBe(t.CATCH_UP_LINES + 1);
  expect(dropped).toBe(21);
});

test("the note comes first and names the channel file", () => {
  const lines = t.catchUpLines(Array.from({ length: 50 }, (_, i) => msg(i)), "c1");
  expect(lines.length).toBe(41);
  expect(lines[0]).toMatch(/^\(10 earlier messages here are not shown\..*c1\.json/);
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
  const l = t.catchUpLines([m], "c1")[0];
  expect(l.indexOf("…(cut:")).toBeLessThan(l.indexOf("a.txt"));
});

test("job reports in chat are cut at 3000 and name the job", () => {
  expect(t.reportInChat("short", "j1")).toBe("short");
  const out = t.reportInChat("z".repeat(4000), "j9");
  expect(out.startsWith("z".repeat(3000) + "\n…(cut: 1000 more")).toBe(true);
  expect(out).toContain("job j9");
  expect(out).toContain("channels.json");
});

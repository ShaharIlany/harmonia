import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// team.ts reads the data folder and ~/.claude/agents when it loads, so point both at temp folders first.
const home = mkdtempSync(join(tmpdir(), "harmonia-home-"));
mkdirSync(join(home, ".claude"), { recursive: true });
cpSync(join(import.meta.dir, "..", "agents"), join(home, ".claude", "agents"), { recursive: true });
process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-data-"));
process.env.HARMONIA_STUB = "1";
process.env.USERPROFILE = home;
process.env.HOME = home;

const { shouldRotate } = await import("../team");

const now = Date.now();
const MIN = 60_000;
const limits = { tokens: 60_000, idleTokens: 30_000 };

test("keeps a small session", () => {
  expect(shouldRotate({ context: 10_000, lastAt: now - 5 * MIN }, now, limits)).toBeUndefined();
});

test("rotates past the size limit, however recent", () => {
  expect(shouldRotate({ context: 60_001, lastAt: now - MIN }, now, limits)).toBeDefined();
  expect(shouldRotate({ context: 60_000, lastAt: now - MIN }, now, limits)).toBeUndefined();
});

test("rotates a medium session only once it has been idle over an hour", () => {
  expect(shouldRotate({ context: 40_000, lastAt: now - 59 * MIN }, now, limits)).toBeUndefined();
  expect(shouldRotate({ context: 40_000, lastAt: now - 61 * MIN }, now, limits)).toBeDefined();
  expect(shouldRotate({ context: 20_000, lastAt: now - 600 * MIN }, now, limits)).toBeUndefined();
});

test("a session with no recorded size or time is kept", () => {
  expect(shouldRotate({}, now, limits)).toBeUndefined();
});

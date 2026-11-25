import { test, expect } from "bun:test";
import { mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// team.ts reads its settings and the agents folder when imported, so point them at temp folders first.
const home = mkdtempSync(join(tmpdir(), "harmonia-home-"));
mkdirSync(join(home, ".claude"), { recursive: true });
cpSync(join(import.meta.dir, "..", "agents"), join(home, ".claude", "agents"), { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-data-"));
process.env.HARMONIA_STUB = "1";
const { nextStatusDelay, statusFingerprint, skipStatus } = await import("../team.ts");

test("updates come at 5, 15, 35 min, then every 20", () => {
  const min = 60_000;
  const at: number[] = [];
  let t = 0;
  for (let i = 0; i < 6; i++) at.push((t += nextStatusDelay(i, 5 * min)) / min);
  expect(at).toEqual([5, 15, 35, 55, 75, 95]);
});

test("the fingerprint changes with the log's length, last step or activity", () => {
  const base = statusFingerprint(["a", "b"], "x");
  expect(statusFingerprint(["a", "b"], "x")).toBe(base);
  expect(statusFingerprint(["a", "b", "c"], "x")).not.toBe(base);
  expect(statusFingerprint(["a", "c"], "x")).not.toBe(base);
  expect(statusFingerprint(["a", "b"], "y")).not.toBe(base);
  expect(statusFingerprint([], undefined)).toBe(statusFingerprint([], undefined));
});

test("skip only when nothing changed and there's no new warning", () => {
  const last = { fingerprint: "f", warned: false };
  expect(skipStatus(undefined, "f", false)).toBe(false);
  expect(skipStatus(last, "f", false)).toBe(true);
  expect(skipStatus(last, "g", false)).toBe(false);
  expect(skipStatus(last, "f", true)).toBe(false);
  expect(skipStatus({ fingerprint: "f", warned: true }, "f", true)).toBe(true);
});

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The data folder is the temp one tests/setup.ts points at before any module loads.
const { DATA: dir } = await import("../paths");
const { recordRun, usageSummary } = await import("../usage");

test("usageSummary adds up a hand-written ledger and skips bad lines and old runs", () => {
  const now = Date.now();
  const line = (o: object) => JSON.stringify(o);
  writeFileSync(
    join(dir, "usage.jsonl"),
    [
      line({ ts: now, kind: "chat", agentId: "elliot", channelId: "c1", cost: 0.5, inputTotal: 1000, cacheRead: 900 }),
      line({ ts: now, kind: "job", agentId: "elliot", channelId: "c1", cost: 1.5, inputTotal: 1000, cacheRead: 100 }),
      line({ ts: now, kind: "mozart", channelId: "c2", cost: 0.25 }),
      "not json",
      line({ ts: now - 40 * 86_400_000, kind: "chat", cost: 99 }),
    ].join("\n") + "\n",
  );
  const s = usageSummary(now - 7 * 86_400_000);
  expect(s.total.runs).toBe(3);
  expect(s.total.cost).toBeCloseTo(2.25);
  expect(s.total.cacheRead).toBe(1000);
  expect(s.byKind.chat.runs).toBe(1);
  expect(s.byAgent.elliot.cost).toBeCloseTo(2);
  expect(s.byChannel.c2.runs).toBe(1);
  expect(Object.keys(s.byDay).length).toBe(1);
});

test("recordRun appends a line that usageSummary reads back", () => {
  const before = usageSummary(0).total.runs;
  recordRun({ kind: "status", cost: 0.01, channelId: "c1" });
  expect(usageSummary(0).total.runs).toBe(before + 1);
});

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The data folder is the temp one tests/setup.ts points at before any module loads.
const { DATA: dir } = await import("../paths");
const { fixLedger, recordResult, recordRun, runCost, usageSummary } = await import("../usage");

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

// Claude Code reports a resumed session's running total as total_cost_usd; a run's own cost is the step from the last one.
test("runCost counts a resumed session's run as the step from its previous total", () => {
  writeFileSync(join(dir, "usage.jsonl"), "");
  fixLedger(() => undefined); // nothing to fix; it forgets the totals earlier tests left, as a restart does
  expect(runCost("s1", 0.5, false)).toBeCloseTo(0.5); // a new session: all of it is this run's
  expect(runCost("s1", 0.53, true)).toBeCloseTo(0.03);
  expect(runCost("s1", 0.6, true)).toBeCloseTo(0.07);
  expect(runCost("s2", 4, true)).toBeCloseTo(4); // resumed, but its earlier total is unknown
  expect(runCost("s1", 0.1, true)).toBeCloseTo(0.1); // the total went down: not carried over, so it's all this run's
  expect(runCost("s3", undefined, true)).toBeUndefined();
});

test("recordResult keeps the session total, so runCost picks up from it after a restart", () => {
  writeFileSync(join(dir, "usage.jsonl"), "");
  recordResult("chat", { cost: 0.02, sessionId: "s9", sessionCost: 6.27, inputTotal: 100, cacheRead: 90 }, { agentId: "elliot", channelId: "c1" });
  fixLedger(() => undefined); // as a restart does: the totals are read back from the ledger
  expect(runCost("s9", 6.3, true)).toBeCloseTo(0.03);
  expect(usageSummary(0).total.cost).toBeCloseTo(0.02);
});

test("fixLedger turns old lines' running totals into each run's own cost, once", () => {
  const ts = Date.now();
  const line = (o: object) => JSON.stringify({ ts, ...o });
  writeFileSync(
    join(dir, "usage.jsonl"),
    [
      line({ kind: "chat", agentId: "elliot", channelId: "c1", cost: 6.1 }),
      line({ kind: "chat", agentId: "sherlock", channelId: "c1", cost: 3.9 }),
      line({ kind: "chat", agentId: "elliot", channelId: "c2", cost: 6.14 }), // one chat session per teammate, every channel
      line({ kind: "chat", agentId: "elliot", channelId: "c1", cost: 0 }), // a failed turn: no total to go by
      line({ kind: "chat", agentId: "elliot", channelId: "c1", cost: 6.2 }),
      line({ kind: "chat", agentId: "sherlock", channelId: "c1", cost: 0.3 }), // a new session: lower than before
      line({ kind: "job", agentId: "elliot", channelId: "c1", jobId: "j1", cost: 1.85 }),
      line({ kind: "job", agentId: "elliot", channelId: "c1", jobId: "j2", cost: 1.0 }), // another session
      line({ kind: "job", agentId: "elliot", channelId: "c1", jobId: "j3", cost: 2.76 }), // continues j1's session
      line({ kind: "mozart", channelId: "c1", cost: 0.023 }),
      line({ kind: "mozart", channelId: "c1", cost: 0.025 }),
      line({ kind: "status", cost: 0.001 }),
    ].join("\n") + "\n",
  );
  const sessions: Record<string, string> = { j1: "A", j2: "B", j3: "A", elliot: "E", mozart: "M" };
  const sessionOf = (r: any) => sessions[r.kind === "job" ? r.jobId : r.kind === "chat" ? r.agentId : "mozart"];
  fixLedger(sessionOf);
  const costs = () => usageSummary(0);
  const s = costs();
  expect(s.byKind.chat.cost).toBeCloseTo(6.1 + 0.04 + 0.06 + 3.9 + 0.3);
  expect(s.byKind.job.cost).toBeCloseTo(1.85 + 1.0 + 0.91);
  expect(s.byKind.mozart.cost).toBeCloseTo(0.025);
  expect(s.byKind.status.cost).toBeCloseTo(0.001);
  // The current sessions continue from the totals the old lines left.
  expect(runCost("E", 6.25, true)).toBeCloseTo(0.05);
  expect(runCost("A", 3, true)).toBeCloseTo(0.24);
  expect(runCost("M", 0.027, true)).toBeCloseTo(0.002);
  // A second start changes nothing.
  fixLedger(sessionOf);
  expect(costs().total.cost).toBeCloseTo(s.total.cost);
});

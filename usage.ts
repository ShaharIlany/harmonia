// The usage ledger: one JSON line per Claude run (chat turn, job, Mozart, status summary, usage probe), so the cost of
// every kind of run can be added up. Costs are Claude Code's own estimates.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths";

export type RunKind = "chat" | "job" | "mozart" | "status" | "probe";
export type RunRecord = {
  kind: RunKind;
  agentId?: string;
  channelId?: string;
  jobId?: string;
  cost?: number;
  inputTotal?: number; // input tokens: fresh + cache write + cache read
  cacheRead?: number; // the part of inputTotal served from the prompt cache
  output?: number;
  context?: number;
  firstInput?: number;
  ms?: number;
};

const file = () => join(DATA, "usage.jsonl");

/** Appends one line. A failed write must never break a run, so it is swallowed. */
export function recordRun(r: RunRecord) {
  try {
    appendFileSync(file(), JSON.stringify({ ts: Date.now(), ...r }) + "\n");
  } catch {}
}

export type Totals = { runs: number; cost: number; input: number; cacheRead: number };
const empty = (): Totals => ({ runs: 0, cost: 0, input: 0, cacheRead: 0 });
const add = (t: Totals, r: any) => {
  t.runs++;
  t.cost += Number(r.cost) || 0;
  t.input += Number(r.inputTotal) || 0;
  t.cacheRead += Number(r.cacheRead) || 0;
};

/** Totals for runs since sinceMs, grouped by day (local date), kind, teammate and channel. Bad lines are skipped. */
export function usageSummary(sinceMs: number) {
  const out = { total: empty(), byDay: {} as Record<string, Totals>, byKind: {} as Record<string, Totals>, byAgent: {} as Record<string, Totals>, byChannel: {} as Record<string, Totals> };
  if (!existsSync(file())) return out;
  const day = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r.ts !== "number" || r.ts < sinceMs) continue;
    add(out.total, r);
    for (const [group, key] of [[out.byDay, day(r.ts)], [out.byKind, r.kind ?? "?"], [out.byAgent, r.agentId ?? "-"], [out.byChannel, r.channelId ?? "-"]] as const)
      add((group[key] ??= empty()), r);
  }
  return out;
}

/** Records a finished run from its RunResult (the fields are the same), plus where it ran. */
export const recordResult = (kind: RunKind, r: { cost?: number; inputTotal?: number; cacheRead?: number; context?: number; firstInput?: number }, who: Pick<RunRecord, "agentId" | "channelId" | "jobId" | "ms">) =>
  recordRun({ kind, ...who, cost: r.cost ?? 0, inputTotal: r.inputTotal ?? 0, cacheRead: r.cacheRead ?? 0, context: r.context, firstInput: r.firstInput });

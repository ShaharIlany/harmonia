// The usage ledger: one JSON line per Claude run (chat turn, job, Mozart, status summary, usage probe), so the cost of
// every kind of run can be added up. Costs are Claude Code's own estimates.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths";

export type RunKind = "chat" | "job" | "mozart" | "status" | "probe";
export type RunRecord = {
  kind: RunKind;
  agentId?: string;
  channelId?: string;
  jobId?: string;
  cost?: number; // what this run cost
  sessionId?: string;
  sessionCost?: number; // what its Claude session had cost by the end of it (see runCost)
  model?: string; // the model that answered, like claude-sonnet-5-5
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

const readLines = (): any[] => {
  if (!existsSync(file())) return [];
  const out: any[] = [];
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r.ts === "number") out.push(r);
    } catch {}
  }
  return out;
};

// Claude Code's total_cost_usd is what the whole session has cost so far: a resumed session starts from its earlier
// total. A chat turn that cost 2¢ reports $6.27 when its session has had a hundred turns. The cost of one run is the
// difference from the session's previous total, kept here by session id (read back from the ledger after a restart).
let totals: Map<string, number> | undefined;
const sessionTotals = () => {
  if (!totals) {
    totals = new Map();
    for (const r of readLines()) if (r.sessionId && typeof r.sessionCost === "number") totals.set(r.sessionId, r.sessionCost);
  }
  return totals;
};

/**
 * The cost of one run, from the session total Claude Code reported at its end. A new session's total is the run's own.
 * A resumed one whose earlier total is unknown, or whose total went down (Claude Code didn't carry it over), counts whole.
 */
export function runCost(sessionId: string, total: number | undefined, resumed: boolean): number | undefined {
  if (typeof total !== "number") return total;
  const before = resumed ? sessionTotals().get(sessionId) : undefined;
  sessionTotals().set(sessionId, total);
  return before !== undefined && total >= before ? total - before : total;
}

/**
 * Lines written before runCost hold the session's running total as the run's cost, so the Usage page added up the same
 * money again with every turn. Rewrites them once with the difference from the same session's previous line: a chat
 * session is the teammate's (one at a time, shared by every channel), Mozart's is the channel's, a job's is its
 * sessionId (a continued job resumes an earlier one's). sessionOf gives a line's session: for a job its own; for chat
 * and Mozart the current one, which the last such line gets, so the next resumed run counts from it.
 */
export function fixLedger(sessionOf: (r: RunRecord) => string | undefined) {
  totals = undefined; // read again from the ledger, as fixed
  const lines = readLines();
  const old = (r: any) => (r.kind === "chat" || r.kind === "job" || r.kind === "mozart") && r.sessionCost === undefined && Number(r.cost) > 0;
  if (!lines.some(old)) return;
  const prev = new Map<string, number>();
  const lastOf = new Map<string, any>();
  for (const r of lines) {
    if (!old(r)) continue;
    const session = r.kind === "job" ? sessionOf(r) : undefined;
    const key = r.kind === "chat" ? `chat:${r.agentId}` : r.kind === "mozart" ? `mozart:${r.channelId}` : `job:${session ?? `${r.channelId}:${r.jobId}`}`;
    const total = Number(r.cost);
    const before = prev.get(key);
    prev.set(key, total);
    Object.assign(r, { cost: before !== undefined && total >= before ? total - before : total, sessionCost: total, ...(session && { sessionId: session }) });
    if (r.kind !== "job") lastOf.set(key, r);
  }
  for (const r of lastOf.values()) {
    const session = sessionOf(r);
    if (session) r.sessionId = session;
  }
  // Runs append with sync writes in this same process, so none can land between the read and the rename. A failed
  // rewrite (a Windows file lock) leaves the old lines for the next start; it must not stop the server.
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, lines.map((r) => JSON.stringify(r) + "\n").join(""));
    renameSync(tmp, file());
  } catch (e) {
    console.error("Fixing the usage ledger failed:", e);
  }
}

export type Totals = { runs: number; cost: number; input: number; cacheRead: number };
const empty = (): Totals => ({ runs: 0, cost: 0, input: 0, cacheRead: 0 });
const add = (t: Totals, r: any) => {
  t.runs++;
  t.cost += Number(r.cost) || 0;
  t.input += Number(r.inputTotal) || 0;
  t.cacheRead += Number(r.cacheRead) || 0;
};

/** Totals for runs since sinceMs, grouped by day (local date), kind, teammate, channel and model. Bad lines are skipped. */
export function usageSummary(sinceMs: number) {
  const group = () => ({}) as Record<string, Totals>;
  const out = { total: empty(), byDay: group(), byKind: group(), byAgent: group(), byChannel: group(), byModel: group() };
  const day = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  for (const r of readLines()) {
    if (r.ts < sinceMs) continue;
    add(out.total, r);
    const keys = [[out.byDay, day(r.ts)], [out.byKind, r.kind ?? "?"], [out.byAgent, r.agentId ?? "-"], [out.byChannel, r.channelId ?? "-"], [out.byModel, r.model ?? "-"]] as const;
    for (const [g, key] of keys) add((g[key] ??= empty()), r);
  }
  return out;
}

/** Records a finished run from its RunResult (the fields are the same), plus where it ran. */
export const recordResult = (
  kind: RunKind,
  r: { cost?: number; sessionId?: string; sessionCost?: number; model?: string; inputTotal?: number; cacheRead?: number; context?: number; firstInput?: number },
  who: Pick<RunRecord, "agentId" | "channelId" | "jobId" | "ms">,
) =>
  recordRun({
    kind,
    ...who,
    cost: r.cost ?? 0,
    ...(r.sessionCost !== undefined && { sessionId: r.sessionId, sessionCost: r.sessionCost }),
    ...(r.model && { model: r.model }),
    inputTotal: r.inputTotal ?? 0,
    cacheRead: r.cacheRead ?? 0,
    context: r.context,
    firstInput: r.firstInput,
  });

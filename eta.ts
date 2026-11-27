// The timing of a job's status updates: how often they come, and the ETA a job gave and whether it has overrun. Kept apart from team.ts so the rules can be tested on plain numbers.
import { setting } from "./env";
import { time } from "./lines";

/** How often a running job posts a status update in its channel (minutes; HARMONIA_STATUS_MINUTES). */
export const STATUS_EVERY_MS = Number(setting("STATUS_MINUTES") ?? 5) * 60_000;

/**
 * The ETA a status update gave ("ETA ~15 min", "ETA ~1.5 h"), in minutes, and whether it gave a reason for it
 * ("ETA ~15 min because the build took longer"). Not "Over the ETA by…" nor "the first ETA (20 min)".
 */
export function readEta(text: string): { eta?: number; reason?: boolean } {
  const m = text.match(/\bETA\s*[:~≈]?\s*~?(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|mins?|minutes?)\b(.*)/i);
  if (!m) return {};
  return { eta: Math.round(Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1)), reason: /^\s*[,(–—-]?\s*because\s+\S/i.test(m[3]) };
}

/** Minutes past an update's ETA at `at`, when that counts as overrun: 10 min, or half the ETA when that's more (ETA 20 → 30). */
function overrun(u: { ts: number; eta: number }, at: number) {
  const by = Math.round((at - u.ts) / 60_000 - u.eta);
  return by >= Math.max(10, u.eta / 2) ? by : undefined;
}

/**
 * Whether a job's next status update leads with a warning. It's measured against the latest ETA; once that's overrun,
 * a later ETA replaces it only when it gives a reason ("because …"). And past twice the job's first ETA, it warns whatever.
 */
export function etaWarning(updates: { ts: number; eta?: number; reason?: boolean }[], startedAt: number, now: number) {
  let ref: { ts: number; eta: number } | undefined;
  for (const u of updates) {
    if (u.eta === undefined) continue;
    if (!ref || overrun(ref, u.ts) === undefined || u.reason) ref = { ts: u.ts, eta: u.eta };
  }
  const by = ref && overrun(ref, now);
  if (ref && by !== undefined)
    return { lead: `Over the ETA by ${by} min, may be stuck`, why: `the ${time(ref.ts)} update gave ETA ~${ref.eta} min; ${Math.round((now - ref.ts) / 60_000)} min have passed, ${by} min over.` };
  const first = updates.find((u) => u.eta !== undefined)?.eta;
  const elapsed = Math.round((now - startedAt) / 60_000);
  if (first && elapsed >= 2 * first)
    return { lead: `Over 2× the first ETA (${first} min), may be stuck`, why: `the first update gave ETA ~${first} min, and the job has run ${elapsed} min.` };
  return undefined;
}

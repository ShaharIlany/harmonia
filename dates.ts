// Dates for chat lines. A line only says "[14:02]", so a channel spanning days needs a marker where each day starts,
// and a turn needs to know today's date. Shared by the teammates' turns and Mozart's.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 25 Nov 2026", in local time (fixed English names, whatever the machine's language is). */
export function dateText(ts: number): string {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The line that marks the start of a day: "--- Wed 25 Nov 2026 ---". */
export const dayLine = (ts: number) => `--- ${dateText(ts)} ---`;

/** Each message's line, with a day line before the first one of each new day (and before the very first). */
export function withDays<T extends { ts: number }>(items: T[], render: (m: T) => string): string[] {
  const out: string[] = [];
  let day = "";
  for (const m of items) {
    const d = dateText(m.ts);
    if (d !== day) out.push(dayLine(m.ts));
    day = d;
    out.push(render(m));
  }
  return out;
}

/** "Wed 25 Nov 2026, 14:07": the current moment, for the end of a prompt. */
export const nowText = (ts: number) => `${dateText(ts)}, ${new Date(ts).toTimeString().slice(0, 5)}`;

import { expect, test } from "bun:test";
import { dateText, withDays } from "../dates";

test("a day line comes before the first line of each day", () => {
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 5).getTime();
  const msgs = [{ ts: at(25, 23) }, { ts: at(25, 23) + 1000 }, { ts: at(26, 8) }];
  const out = withDays(msgs, (m) => `[${new Date(m.ts).getHours()}] x`);
  expect(out).toEqual(["--- Wed 25 Nov 2026 ---", "[23] x", "[23] x", "--- Thu 26 Nov 2026 ---", "[8] x"]);
  expect(dateText(at(1, 9))).toBe("Sun 1 Nov 2026");
});

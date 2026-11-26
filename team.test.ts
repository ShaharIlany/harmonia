// bun test. A throwaway data folder, so importing the app's modules doesn't touch real channels.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-test-"));
const { Team } = await import("./team");
const { createChannel, messages } = await import("./store");

test("a handoff in a later bubble wakes its teammate only once that bubble is posted", async () => {
  const team: any = new Team(() => {}, "http://localhost");
  const ch = createChannel("handoff", process.env.HARMONIA_DATA!);
  const woken: { id: string; seen: string[] }[] = [];
  team.wake = (_ch: unknown, id: string) => woken.push({ id, seen: (messages.get(ch.id) ?? []).map((m) => m.text) });
  team.coordinate = () => {};

  team.afterReply(ch, "elliot", { isError: false, text: "done, build's green\n---\n@Sherlock can you review it" });
  expect(woken).toEqual([]);
  await Bun.sleep(1700);
  expect(woken).toEqual([{ id: "sherlock", seen: ["done, build's green", "@Sherlock can you review it"] }]);
});

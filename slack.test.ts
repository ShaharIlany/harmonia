// bun test. A throwaway data folder, so importing the app's modules doesn't touch real channels.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "./store";

process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-test-"));
const { threadReplyTo } = await import("./slack");

const C = "C1";
const ROOT = "100.0";
let n = 0;
const msg = (author: string, ts: string, thread?: string, conversation = C): Message => ({
  id: `m${++n}`,
  ts: n,
  author,
  text: `${author} ${ts}`,
  meta: { slack: { channel: conversation, ts, ...(thread && { thread }) } },
});

test("a thread reply answers the thread's latest teammate message, not its first", () => {
  const list = [msg("emily", ROOT), msg("user", "101.0", ROOT), msg("dali", "102.0", ROOT)];
  expect(threadReplyTo(list, C, ROOT)?.author).toBe("dali");
});

test("yours, guests' and system lines don't count", () => {
  const list = [msg("emily", ROOT), msg("dali", "101.0", ROOT), msg("guest", "102.0", ROOT), msg("system", "103.0", ROOT), msg("user", "104.0", ROOT)];
  expect(threadReplyTo(list, C, ROOT)?.author).toBe("dali");
});

test("other threads and conversations don't count", () => {
  const list = [msg("emily", ROOT), msg("leo", "200.0", "199.0"), msg("murphy", "101.0", ROOT, "C2")];
  expect(threadReplyTo(list, C, ROOT)?.author).toBe("emily");
});

test("no teammate in the thread: the thread's first message", () => {
  const list = [msg("guest", ROOT), msg("user", "101.0", ROOT)];
  expect(threadReplyTo(list, C, ROOT)?.author).toBe("guest");
  expect(threadReplyTo([], C, ROOT)).toBeUndefined();
});

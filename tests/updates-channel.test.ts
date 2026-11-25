// Which release the updater picks on each channel. updates.ts reads settings and the data folder when imported,
// so the data folder is a temp one, set before the import.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARMONIA_DATA = mkdtempSync(join(tmpdir(), "harmonia-updates-"));
const { pickRelease } = await import("../updates");

const rel = (tag_name: string, o: { draft?: boolean; prerelease?: boolean } = {}) => ({ tag_name, assets: [], ...o });
const list = [
  rel("v2.1.9", { prerelease: true }),
  rel("v2.1.10", { prerelease: true }),
  rel("v2.1.11", { draft: true }),
  rel("v2.1.8"),
  rel("v2.1.2"),
  rel("nightly"),
];

test("stable takes the newest full release", () => {
  expect(pickRelease(list, "stable")?.tag_name).toBe("v2.1.8");
});

test("beta takes the newest including prereleases, by version not position, and never a draft", () => {
  expect(pickRelease(list, "beta")?.tag_name).toBe("v2.1.10");
});

test("nothing usable gives undefined", () => {
  expect(pickRelease([], "beta")).toBeUndefined();
  expect(pickRelease([rel("v1.0.0", { prerelease: true })], "stable")).toBeUndefined();
  expect(pickRelease(undefined as any, "stable")).toBeUndefined();
});

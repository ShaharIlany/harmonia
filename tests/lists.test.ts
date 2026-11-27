// The list keys of the message boxes (public/lists.js) and how lists are drawn (public/markdown.js), run against a
// fake window.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Edit = { from: number; to: number; text: string; caret: number } | null;
const win: Record<string, any> = {};
for (const f of ["lists.js", "markdown.js"]) new Function("window", readFileSync(join(import.meta.dir, "..", "public", f), "utf8"))(win);
const { listEdit, bulletEdit, plainLists, startsWithItem } = win.composerLists as {
  listEdit: (v: string, s: number, e: number, key: string, shift: boolean) => Edit;
  bulletEdit: (v: string, caret: number) => Edit;
  plainLists: (t: string) => string;
  startsWithItem: (t: string) => boolean;
};
const md = (src: string): string => win.renderMarkdown(src, { people: {} });

// "~" stands for the figure space (U+2007) the box writes before a list line, "|" for the caret.
const fs = (s: string) => s.replaceAll("~", " ");
const unfs = (s: string) => s.replaceAll(" ", "~");

/** The box after a key, or null when the key is left to the browser. */
function press(box: string, key: string, shift = false): string | null {
  const at = box.indexOf("|");
  const value = fs(box.replace("|", ""));
  const e = key === " " ? bulletEdit(value, at) : listEdit(value, at, at, key, shift);
  if (!e) return null;
  const out = value.slice(0, e.from) + e.text + value.slice(e.to);
  return unfs(out.slice(0, e.caret) + "|" + out.slice(e.caret));
}

describe("composer lists", () => {
  test('"- " and "1. " at the start of a line become an item', () => {
    expect(press("- |", " ")).toBe("~~- |");
    expect(press("intro\n1. |", " ")).toBe("intro\n~~1. |");
    expect(press("a - |", " ")).toBeNull();
    expect(press("~~- |", " ")).toBeNull();
  });
  test("not inside a code block", () => {
    expect(press("```\n- |", " ")).toBeNull();
    expect(press("```\nx\n```\n- |", " ")).toBe("```\nx\n```\n~~- |");
  });
  test("Shift+Enter continues the list", () => {
    expect(press("~~- one|", "Enter", true)).toBe("~~- one\n~~- |");
    expect(press("~~1. one|", "Enter", true)).toBe("~~1. one\n~~2. |");
    expect(press("~~9) nine|", "Enter", true)).toBe("~~9) nine\n~~10) |");
    expect(press("~~- ab|cd", "Enter", true)).toBe("~~- ab\n~~- |cd");
    expect(press("~~- שלום|", "Enter", true)).toBe("~~- שלום\n~~- |");
  });
  test("Shift+Enter on an empty top item ends the list", () => {
    expect(press("~~- one\n~~- |", "Enter", true)).toBe("~~- one\n|");
  });
  test("Shift+Enter on an empty nested item moves out, numbered after the parent", () => {
    expect(press("~~1. a\n~~   - sub\n~~   - |", "Enter", true)).toBe("~~1. a\n~~   - sub\n~~2. |");
    expect(press("~~1. a\n~~   1. x\n~~   2. y\n~~   3. |", "Enter", true)).toBe("~~1. a\n~~   1. x\n~~   2. y\n~~2. |");
    expect(press("~~- a\n~~  - |", "Enter", true)).toBe("~~- a\n~~- |");
  });
  test("Enter is left to send, and other lines keep their keys", () => {
    expect(press("~~- one|", "Enter")).toBeNull();
    expect(press("plain|", "Enter", true)).toBeNull();
    expect(press("plain|", "Tab")).toBeNull();
  });
  test("Tab nests under the item above, by its marker's width", () => {
    expect(press("~~- one\n~~- two|", "Tab")).toBe("~~- one\n~~  - two|");
    expect(press("~~10. a\n~~11. b|", "Tab")).toBe("~~10. a\n~~    1. b|");
  });
  test("Tab restarts a numbered item at 1, or follows a sibling at the new level", () => {
    expect(press("~~1. a\n~~2. b|", "Tab")).toBe("~~1. a\n~~   1. b|");
    expect(press("~~1. a\n~~   1. x\n~~2. b|", "Tab")).toBe("~~1. a\n~~   1. x\n~~   2. b|");
  });
  test("Shift+Tab moves out, numbered after the parent", () => {
    expect(press("~~1. a\n~~   1. b|", "Tab", true)).toBe("~~1. a\n~~2. b|");
    expect(press("~~- a\n~~  - b|", "Tab", true)).toBe("~~- a\n~~- b|");
  });
  test("Tab and Shift+Tab with nothing to do are left to the browser (no keyboard trap)", () => {
    expect(press("~~- one|", "Tab", true)).toBeNull(); // top level
    expect(press("~~- one|", "Tab")).toBeNull(); // the first item can't nest
    expect(press("~~- a\n~~  - b|", "Tab")).toBeNull(); // already as deep as it can go
  });
  test("the sent text is plain Markdown: only the box's figure spaces come off", () => {
    expect(plainLists(fs("Plan:\n~~- one\n~~  - nested\n~~1. first\nnot  a list"))).toBe("Plan:\n- one\n  - nested\n1. first\nnot  a list");
    expect(plainLists("- parent\n    - child\n        - grandchild")).toBe("- parent\n    - child\n        - grandchild");
    expect(plainLists("```yaml\nsteps:\n    - run: x\n```")).toBe("```yaml\nsteps:\n    - run: x\n```");
    expect(plainLists(fs("```\n~~- kept\n```\n~~- off"))).toBe(fs("```\n~~- kept\n```\n- off"));
  });
  test("startsWithItem, for a mention put before the text", () => {
    expect(startsWithItem(fs("~~- one\n~~- two"))).toBe(true);
    expect(startsWithItem(fs("\n  \n~~1. one"))).toBe(true);
    expect(startsWithItem("hello - there")).toBe(false);
  });
});

describe("markdown lists", () => {
  test("a flat list is as before", () => {
    expect(md("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  test("a deeper item nests in the item above, and a child list doesn't continue the parent's numbers", () => {
    expect(md("1. a\n   - sub\n2. b")).toBe("<ol><li>a<ul><li>sub</li></ul></li><li>b</li></ol>");
    expect(md("1. a\n   1. x\n   2. y\n2. b")).toBe("<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>");
    expect(md("- a\n  - b\n    - c\n- d")).toBe("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>");
  });
  test("a first item indented more than the rest doesn't drop the others", () => {
    expect(md("  - a\n- b\n- c")).toBe("<ul><li>a</li></ul><ul><li>b</li><li>c</li></ul>");
    expect(md("    1. a\n  - b\n- c")).toBe("<ol><li>a</li></ol><ul><li>b</li></ul><ul><li>c</li></ul>");
  });
  test("a numbered list keeps its first number", () => {
    expect(md("3. c\n4. d")).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
  });
});

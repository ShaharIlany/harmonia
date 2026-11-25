// Unit tests for the pure functions. tests/setup.ts (the bunfig preload) points the data folder and home at temp
// folders before these modules load.
import { describe, expect, test } from "bun:test";
import { fallback, parseDecision } from "../mozart";
import { addressedAtStart, handoffs, mentions } from "../roster";
import { bubbles, etaWarning, parseTask, readEta } from "../team";
import { resolveTools, suggestTools } from "../tool-catalog";
import { STATUS_MARKS, topicOf } from "../slack-marks";
import type { Message } from "../store";

const msg = (author: string, text: string): Message => ({ id: `${author}-${text}`, ts: 0, author, text });

describe("parseDecision", () => {
  test("reads who answers, a reaction and the reason", () => {
    const d = parseDecision('Sure: {"answer": ["elliot", "Sherlock"], "react": {"leo": "👍"}, "why": "code\\nreview"}');
    expect(d).toEqual({ to: ["elliot", "sherlock"], react: [{ by: "leo", emoji: "👍" }], why: "code review" });
  });
  test("accepts a single id as a string and @names", () => {
    expect(parseDecision('{"answer": "@Emily"}')?.to).toEqual(["emily"]);
  });
  test("rejects a made-up id, even next to a real one", () => {
    expect(parseDecision('{"answer": ["elliot", "bob"]}')).toBeUndefined();
  });
  test("rejects text that isn't a decision", () => {
    expect(parseDecision("no json here")).toBeUndefined();
    expect(parseDecision("{not json}")).toBeUndefined();
    expect(parseDecision('{"why": "no answer key"}')).toBeUndefined();
  });
  test("an empty answer means nobody", () => {
    expect(parseDecision('{"answer": []}')?.to).toEqual([]);
  });
  test("leaves out reactions with an unknown teammate or something that isn't one emoji", () => {
    const d = parseDecision('{"answer": [], "react": {"nobody": "👍", "leo": "thanks", "elliot": "🙏", "murphy": "👍👍"}}');
    expect(d?.react).toEqual([{ by: "elliot", emoji: "🙏" }]);
  });
  test("clips a long reason", () => {
    expect(parseDecision(`{"answer": [], "why": "${"x".repeat(200)}"}`)!.why.length).toBeLessThanOrEqual(81);
  });
});

describe("fallback", () => {
  test("a teammate's message wakes nobody", () => {
    const m = msg("elliot", "done");
    expect(fallback([m], m).to).toEqual([]);
  });
  test("nobody in the conversation goes to the triage teammate", () => {
    const m = msg("user", "hello");
    expect(fallback([m], m).to).toEqual(["emily"]);
  });
  test("continues with the teammate in the conversation", () => {
    const all = [msg("user", "Elliot, hi"), msg("elliot", "hi"), msg("user", "and now?")];
    expect(fallback(all, all[2]).to).toEqual(["elliot"]);
  });
  test("a teammate that asked the user a question gets the answer", () => {
    const all = [msg("sherlock", "@Alex which one?"), msg("elliot", "working"), msg("user", "the first")];
    expect(fallback(all, all[2]).to).toEqual(["sherlock"]);
  });
  test("a teammate the channel is waiting on gets the answer", () => {
    const all = [msg("elliot", "working"), msg("user", "yes")];
    expect(fallback(all, all[1], "leo").to).toEqual(["leo"]);
  });
});

describe("mentions", () => {
  test("finds teammates and the user, once each, ignoring case", () => {
    expect(mentions("@elliot and @Sherlock, ask @Alex; @ELLIOT again").sort()).toEqual(["elliot", "sherlock", "user"]);
  });
  test("ignores names that aren't teammates", () => {
    expect(mentions("@nobody hi")).toEqual([]);
  });
});

describe("handoffs", () => {
  test("a request to a teammate is a handoff", () => {
    expect(handoffs("@Sherlock please review it")).toEqual(["sherlock"]);
  });
  test("a question to the user that names a teammate is not", () => {
    expect(handoffs("@Alex, OK to hand it to @Elliot?")).toEqual([]);
  });
  test("is decided per sentence", () => {
    expect(handoffs("@Alex, OK to hand it to @Elliot? Meanwhile @Sherlock please review it.")).toEqual(["sherlock"]);
    expect(handoffs("Done.\n@Leo take a look")).toEqual(["leo"]);
  });
});

describe("addressedAtStart", () => {
  test("a name then a comma or colon", () => {
    expect(addressedAtStart("Sherlock, can you look?")).toBe("sherlock");
    expect(addressedAtStart("  leo: plan this")).toBe("leo");
  });
  test("not a name without the comma, or not a teammate", () => {
    expect(addressedAtStart("Sherlock can you look?")).toBeUndefined();
    expect(addressedAtStart("Hello, Sherlock")).toBeUndefined();
  });
});

describe("bubbles", () => {
  test("splits at lines with only ---", () => {
    expect(bubbles("one\n---\ntwo\n  ---  \nthree")).toEqual(["one", "two", "three"]);
  });
  test("never splits inside a code block", () => {
    const text = "before\n```\na\n---\nb\n```\n---\nafter";
    expect(bubbles(text)).toEqual(["before\n```\na\n---\nb\n```", "after"]);
  });
  test("drops empty bubbles", () => {
    expect(bubbles("---\n\n---\nhi\n---")).toEqual(["hi"]);
  });
  test("no divider is one bubble", () => {
    expect(bubbles("a --- b")).toEqual(["a --- b"]);
  });
});

describe("parseTask", () => {
  test("a custom id, in any case", () => {
    expect(parseTask("abc-123")).toEqual({ id: "ABC-123", url: "https://app.clickup.com/t/999/ABC-123" });
  });
  test("a bare number gets the task prefix", () => {
    expect(parseTask("42")?.id).toBe("ABC-42");
  });
  test("an internal id", () => {
    expect(parseTask("1amkz0hxp0q")).toEqual({ id: "1amkz0hxp0q", url: "https://app.clickup.com/t/1amkz0hxp0q" });
  });
  test("a ClickUp link keeps its url", () => {
    const url = "https://app.clickup.com/t/999/abc-7";
    expect(parseTask(url)).toEqual({ id: "ABC-7", url });
  });
  test("anything else is not a task", () => {
    expect(parseTask("hello there")).toBeUndefined();
    expect(parseTask("https://example.com/t/ABC-1")).toBeUndefined();
  });
});

describe("readEta", () => {
  test("minutes and hours", () => {
    expect(readEta("Working. ETA ~15 min").eta).toBe(15);
    expect(readEta("ETA: 20 minutes").eta).toBe(20);
    expect(readEta("ETA ~1.5 h").eta).toBe(90);
  });
  test("whether it gives a reason", () => {
    expect(readEta("ETA ~15 min because the build took longer").reason).toBe(true);
    expect(readEta("ETA ~15 min, because the build took longer").reason).toBe(true);
    expect(readEta("ETA ~15 min").reason).toBe(false);
  });
  test("no ETA", () => {
    expect(readEta("Over the ETA by 5 min")).toEqual({});
    expect(readEta("nothing to say")).toEqual({});
  });
});

describe("etaWarning", () => {
  const MIN = 60_000;
  const t0 = 1_700_000_000_000;
  test("no warning before the ETA is overrun by half of it", () => {
    expect(etaWarning([{ ts: t0, eta: 40 }], t0, t0 + 59 * MIN)).toBeUndefined();
  });
  test("warns once overrun by half the ETA (ETA 40 → 20 min over)", () => {
    expect(etaWarning([{ ts: t0, eta: 40 }], t0, t0 + 60 * MIN)?.lead).toBe("Over the ETA by 20 min, may be stuck");
  });
  test("a short ETA warns after 10 min over, not half of it", () => {
    expect(etaWarning([{ ts: t0, eta: 12 }], t0, t0 + 21 * MIN)).toBeUndefined();
    expect(etaWarning([{ ts: t0, eta: 12 }], t0, t0 + 22 * MIN)?.lead).toBe("Over the ETA by 10 min, may be stuck");
  });
  test("a new ETA after an overrun replaces it only with a reason", () => {
    const late = t0 + 70 * MIN;
    const now = late + 5 * MIN;
    expect(etaWarning([{ ts: t0, eta: 40 }, { ts: late, eta: 100 }], t0, now)?.lead).toContain("Over the ETA");
    expect(etaWarning([{ ts: t0, eta: 40 }, { ts: late, eta: 100, reason: true }], t0, now)).toBeUndefined();
  });
  test("past twice the first ETA warns whatever", () => {
    const ups = [{ ts: t0, eta: 10 }, { ts: t0 + 15 * MIN, eta: 30, reason: true }];
    expect(etaWarning(ups, t0, t0 + 25 * MIN)?.lead).toBe("Over 2× the first ETA (10 min), may be stuck");
  });
  test("no ETA given, no warning", () => {
    expect(etaWarning([{ ts: t0 }], t0, t0 + 500 * MIN)).toBeUndefined();
  });
});

describe("tool catalog", () => {
  test("resolves a built-in tool in any case", () => {
    expect(resolveTools(["bash"])).toEqual({ found: [{ name: "Bash", grants: ["Bash"] }], unknown: [] });
  });
  test("resolves a connector tool by its short and its CLI name, once", () => {
    const r = resolveTools(["clickup_delete_task", "mcp__claude_ai_ClickUp__clickup_delete_task"]);
    expect(r.unknown).toEqual([]);
    expect(r.found).toHaveLength(1);
    expect(r.found[0].grants).toContain("mcp__claude_ai_ClickUp__clickup_delete_task");
  });
  test("reports unknown names and skips blanks", () => {
    expect(resolveTools(["", "  ", "teleport"])).toEqual({ found: [], unknown: ["teleport"] });
  });
  test("suggests close matches for an unknown name", () => {
    const s = suggestTools("clickup_remove_task");
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(6);
    expect(s).toContain("clickup_remove_task_link");
  });
  test("suggests nothing for a nonsense name", () => {
    expect(suggestTools("zzzz")).toEqual([]);
  });
});

describe("slack-marks topicOf", () => {
  test("status and task together", () => {
    expect(topicOf({ status: "inProgress", task: { id: "ABC-1", url: "" } })).toBe(`${STATUS_MARKS.inProgress} · ClickUp ABC-1`);
  });
  test("status only, task only, neither", () => {
    expect(topicOf({ status: "waiting" })).toBe("🟠 Waiting for response");
    expect(topicOf({ task: { id: "ABC-2", url: "" } })).toBe("ClickUp ABC-2");
    expect(topicOf({})).toBe("");
  });
  test("a status with no mark (archived) adds nothing", () => {
    expect(topicOf({ status: "archived" })).toBe("");
  });
});

// The permission and tool-request cards (public/cards.js), run against a fake window. A card waits on you while its
// status is "pending": it must show its buttons then, and only a decided card may collapse to one line.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const win: Record<string, any> = {};
new Function("window", readFileSync(join(import.meta.dir, "..", "public", "cards.js"), "utf8"))(win);
const card = (m: any, ch = { name: "dark-mode", dm: false }) => win.approvalCard(m, "Elliot", ch) as string;

const permission = (status: string) => ({
  id: 7,
  kind: "permission",
  meta: { permission: { agentId: "elliot", jobId: "j2", tool: "Bash", rule: "Bash(bun test)", summary: "Bash: bun test", status } },
});
const tools = (status: string) => ({
  id: 8,
  kind: "tools",
  meta: { toolRequest: { reason: "To read the task", tools: [{ name: "clickup_get_task" }], status } },
});

describe("permission card", () => {
  test("pending shows Allow once, Always and Deny", () => {
    const html = card(permission("pending"));
    expect(html).toContain('data-perm="once"');
    expect(html).toContain('data-perm="always"');
    expect(html).toContain('data-perm="denied"');
    expect(html).not.toContain("decided");
    expect(html).not.toContain("undefined");
  });
  test("decided names the decision and the tool once", () => {
    const html = card(permission("once"));
    expect(html).toContain("Allowed once");
    expect(html).not.toContain("data-perm");
    expect(html.match(/Bash/g)?.length).toBe(1);
    expect(card(permission("always"))).toContain("Allowed in #dark-mode");
    expect(card(permission("always"), { name: "elliot", dm: true })).toContain("Allowed in this DM");
    expect(card(permission("denied"))).toContain("Denied");
  });
});

describe("tool request card", () => {
  test("pending shows the reason, the tools, Approve and Deny", () => {
    const html = card(tools("pending"));
    expect(html).toContain("To read the task");
    expect(html).toContain("clickup_get_task");
    expect(html).toContain('data-tools="approved"');
    expect(html).toContain('data-tools="denied"');
    expect(html).not.toContain("Denied");
  });
  test("decided says who has it, or names what was denied", () => {
    expect(card(tools("approved"))).toContain("Approved: Elliot has it from now on");
    const denied = card(tools("denied"));
    expect(denied).toContain("Denied: <code>clickup_get_task</code>");
    expect(denied).not.toContain("data-tools");
  });
});

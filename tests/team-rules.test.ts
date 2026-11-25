// The team rules overlay: `chatPrompt` is what it was without `team-rules.md`, and has the section right before
// "## Who you are" with it. Run with `bun test`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "harmonia-test-"));
const data = join(tmp, "data");
// team.ts reads these when it's imported, so they come first.
mkdirSync(join(tmp, ".claude"), { recursive: true });
mkdirSync(join(tmp, ".claude", "agents"));
// A Windows checkout may have CRLF line endings, which the front matter parser doesn't take.
for (const f of readdirSync(join(root, "agents")))
  if (f.endsWith(".md")) writeFileSync(join(tmp, ".claude", "agents", f), readFileSync(join(root, "agents", f), "utf8").split(String.fromCharCode(13)).join(""));
Object.assign(process.env, { HARMONIA_DATA: data, HARMONIA_STUB: "1", HARMONIA_USER: "Alex", USERPROFILE: tmp, HOME: tmp });

const { chatPrompt, TEAM_RULES_FILE } = await import("../team");
const { readAgent } = await import("../agents");
const { ROSTER } = await import("../roster");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** What chatPrompt gave before the overlay existed: the template with the placeholder gone. */
function old(id: string) {
  const t = ROSTER.find((r) => r.id === id)!;
  const rosterText = ROSTER.map((r) => `- ${r.name} (@${r.name}): ${r.role}${r.id === id ? " (you)" : ""}`).join("\n");
  return readFileSync(join(root, "chat-rules.md"), "utf8")
    .replace(/\r\n/g, "\n") // team.ts reads its templates with LF line ends, whatever the checkout used
    .replace("{{teamRules}}", "")
    .replaceAll("{{user}}", "Alex")
    .replaceAll("{{name}}", t.name)
    .replaceAll("{{role}}", t.role)
    .replaceAll("{{roster}}", rosterText)
    .replaceAll("{{instructions}}", readAgent(id).instructions.trim());
}

test("without the file the prompt is unchanged", () => {
  rmSync(TEAM_RULES_FILE, { force: true });
  expect(chatPrompt("elliot")).toBe(old("elliot"));
  expect(chatPrompt("elliot")).not.toContain("{{");
  expect(chatPrompt("elliot")).toContain("\n\n## Who you are\n\n");
});

test("an empty file changes nothing either", () => {
  writeFileSync(TEAM_RULES_FILE, " \n\n");
  expect(chatPrompt("elliot")).toBe(old("elliot"));
});

test("with the file the section comes right before Who you are", () => {
  writeFileSync(TEAM_RULES_FILE, "\n- Never end a message with a question mark unless it's for Alex.\n- Use {{user}} as written.\n\n");
  const p = chatPrompt("elliot");
  expect(p).toContain("## Team rules from Alex\n\n- Never end a message with a question mark unless it's for Alex.\n- Use {{user}} as written.\n\n## Who you are\n\n");
  // The rest of the prompt is the same text, and every teammate gets it.
  expect(p.replace(/## Team rules from Alex\n\n[\s\S]*?\n\n(?=## Who you are)/, "")).toBe(old("elliot"));
  expect(chatPrompt("emily")).toContain("## Team rules from Alex");
  expect(p.indexOf("## Team rules from Alex")).toBeLessThan(p.indexOf("## Who you are"));
  expect(p.indexOf("## Is it your turn?")).toBeLessThan(p.indexOf("## Team rules from Alex"));
});

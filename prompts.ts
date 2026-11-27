// The text the teammates are given as rules: the chat and job system prompts filled in from the rule templates, the
// optional team rules file, the titles sessions get in Claude Code, and the job brief. Kept apart from team.ts so a
// prompt can be read, and its placeholders checked, without the Team around it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import chatRulesFile from "./chat-rules.md" with { type: "file" };
import jobRulesFile from "./job-rules.md" with { type: "file" };
import feedbackRulesFile from "./feedback-rules.md" with { type: "file" };
import { DATA } from "./paths";
import { readAgent } from "./agents";
import { ROSTER, USER_NAME, nameOf, teammate } from "./roster";
import type { Channel } from "./store";

/** A prompt template, with LF line ends whatever the checkout used: the teammates read the same text on every machine. */
const template = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
export const RULES = { chat: template(chatRulesFile), job: template(jobRulesFile), feedback: template(feedbackRulesFile) };
/** Fills {{key}} placeholders in one pass, so text put in is never filled again. Unknown keys stay as they are. */
export const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all);
export const roster = (agentId: string) => ROSTER.map((r) => `- ${r.name} (@${r.name}): ${r.role}${r.id === agentId ? " (you)" : ""}`).join("\n");

/** The optional team rules file: a short list of rules for every teammate, kept by feedback jobs (feedback-rules.md). */
export const TEAM_RULES_FILE = join(DATA, "team-rules.md");
/** Its text as a section of the chat rules, or "" when there's no file or it's empty, so the prompt stays as it was. */
function teamRulesSection() {
  let text = "";
  try {
    text = readFileSync(TEAM_RULES_FILE, "utf8").trim();
  } catch {}
  return text ? `## Team rules from ${USER_NAME}\n\n${text}\n\n` : "";
}

/** The chat session's whole system prompt. Nothing in it is per channel or per turn, so the cached prefix stays put. */
export function chatPrompt(agentId: string) {
  const t = teammate(agentId)!;
  return RULES.chat
    .replaceAll("{{user}}", USER_NAME)
    .replaceAll("{{name}}", t.name)
    .replaceAll("{{role}}", t.role)
    .replaceAll("{{roster}}", roster(agentId))
    .replaceAll("{{instructions}}", readAgent(agentId).instructions.trim())
    .replace("{{teamRules}}", () => teamRulesSection()); // last, so nothing in the file is filled in again
}

export function jobPrompt(ch: Channel, agentId: string) {
  return RULES.job
    .replaceAll("{{user}}", USER_NAME)
    .replaceAll("{{name}}", nameOf(agentId))
    .replaceAll("{{channel}}", ch.dm ? `a DM with ${USER_NAME}` : `the channel #${ch.name}`)
    .replaceAll("{{cwd}}", ch.cwd);
}

/** How sessions are titled in Claude Code: the tag says which teammate it is. */
export const chatTitle = (agentId: string) => `[${nameOf(agentId)}] Harmonia chat`;

export const jobTitle =(ch: Channel, agentId: string, title: string) => `[${nameOf(agentId)}] ${ch.dm ? "DM" : `#${ch.name}`} · ${title}`;

/** What the user can have said yes to in the chat, as start_job takes it (job-tools.ts has the same list). */
export const APPROVALS = ["commit", "push", "open_pr", "deploy", "send_message", "none"];
const APPROVAL_WORDS: Record<string, string> = { commit: "commit", push: "push", open_pr: "open a PR", deploy: "deploy", send_message: "send messages" };

/** The text a job is given and its card shows: the brief, what done looks like, and what the user approved. */
export function composeBrief(input: { brief: string; done_when?: string; approved_actions?: string[] }): string {
  let text = input.brief.trim();
  if (input.done_when?.trim()) text += `\n\nDone when: ${input.done_when.trim()}`;
  if (input.approved_actions) {
    const yes = input.approved_actions.filter((a) => a !== "none").map((a) => APPROVAL_WORDS[a] ?? a);
    text += yes.length ? `\n\nApproved by ${USER_NAME}: ${yes.join(", ")}` : `\n\nApproved by ${USER_NAME}: nothing. Draft, don't send, commit, push or deploy.`;
  }
  return text;
}

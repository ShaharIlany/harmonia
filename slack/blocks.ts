// What the app posts in Slack beyond plain text: Block Kit pieces, the project list at the top of a new channel, and
// the cards for a teammate's tool request, permission request or job.
import { nameOf } from "../roster";
import type { Channel, Message } from "../store";
import { parentOf, projectOf, tilde, type Project } from "../projects";
import { escapeSlack, mrkdwn, quote, relayText } from "./text";

export const PROJECT_PICK = "harmonia:project"; // the list of your Claude projects at the top of a new channel
export const PROJECTS_MAX = 100; // Slack's limit for a list's options
export const OPTION_MAX = 75; // … for an option's text
export const VALUE_MAX = 150; // … and its value (the project's folder)

// Block Kit pieces.
export const plain = (text: string) => ({ type: "plain_text", text });
export const section = (mrkdwnText: string) => ({ type: "section", text: { type: "mrkdwn", text: mrkdwnText.slice(0, 3000) } });
export const button = (label: string, action_id: string, value: string, style?: "primary" | "danger") => ({ type: "button", text: plain(label.slice(0, 75)), action_id, value, ...(style && { style }) });
/** What a button acts on: a message in a Harmonia channel. */
export const target = (ch: Channel, m: Message) => JSON.stringify({ c: ch.id, m: m.id });

/**
 * The list of your Claude projects, as a Slack message: with `current` picked (the channel's project), or nothing yet
 * (a new channel). The channel's own folder is on it even when Claude doesn't know it as a project.
 */
export function projectPicker(ch: Channel, projects: Project[], current?: string): { text: string; blocks: unknown[] } {
  const fits = (p: Project) => p.path.length <= VALUE_MAX; // an option's value is the folder
  const list = projects.filter(fits).slice(0, PROJECTS_MAX);
  const chosen = current ? (projects.find((p) => p.path === current) ?? projectOf(current)) : undefined;
  if (chosen && fits(chosen) && !list.some((p) => p.path === chosen.path)) list.splice(PROJECTS_MAX - 1, 1, chosen);
  const option = (p: Project) => ({ text: plain(optionText(p)), value: p.path });
  const text = chosen
    ? `:file_folder: *${escapeSlack(chosen.name)}* is this channel's project: the teammates' jobs run in \`${escapeSlack(tilde(chosen.path))}\`. Pick another to change it.`
    : "*Which project is this channel for?* Pick one of your Claude projects. The teammates join once you do, and their jobs run in its folder.";
  return {
    text,
    blocks: [
      {
        type: "section",
        block_id: `harmonia-project:${ch.id}`,
        text: { type: "mrkdwn", text },
        accessory: {
          type: "static_select",
          action_id: PROJECT_PICK,
          placeholder: plain("Choose a project"),
          options: list.map(option),
          ...(chosen && list.includes(chosen) && { initial_option: option(chosen) }),
        },
      },
    ],
  };
}

/** A project on the list: its name and where it is (team-chat · ~/GitRepos), clipped to fit. */
function optionText(p: Project): string {
  const where = parentOf(p.path);
  const room = OPTION_MAX - p.name.length - 3;
  if (room < 8) return p.name.slice(0, OPTION_MAX);
  return `${p.name} · ${where.length > room ? "…" + where.slice(-(room - 1)) : where}`;
}

/**
 * A teammate's tool request (a connector it lacks) or permission card, as a Slack message: Approve / Deny (or Allow
 * once / always / Deny) buttons while it's pending, what was decided once it isn't. A job's start, with a View in
 * Claude button that opens its session in the Claude app on this Mac. Undefined for anything else.
 */
export function card(m: Message, ch: Channel): { text: string; blocks: unknown[] } | undefined {
  const name = escapeSlack(nameOf(m.author));
  const value = target(ch, m);
  const r = m.kind === "tools" ? m.meta?.toolRequest : undefined;
  if (r) {
    const one = r.tools.length === 1;
    const text = `:toolbox: *${name}* asks for ${one ? "a new tool" : "new tools"}: ${r.tools.map((t) => `\`${escapeSlack(t.name)}\``).join(", ")}${r.reason ? `\n${quote(r.reason)}` : ""}`;
    const done = r.status === "approved" ? `:white_check_mark: Approved: ${name} has ${one ? "it" : "them"} from now on` : r.status === "denied" ? ":no_entry_sign: Denied" : undefined;
    return decided(text, done, [button("Approve", "harmonia:tools:approved", value, "primary"), button("Deny", "harmonia:tools:denied", value)]);
  }
  const p = m.kind === "permission" ? m.meta?.permission : undefined;
  if (p) {
    const text = `:closed_lock_with_key: *${name}*${p.jobId ? `'s job ${escapeSlack(p.jobId)}` : ""} wants to use ${escapeSlack(p.tool)}\n\`${escapeSlack(p.summary)}\``;
    const done = { pending: undefined, once: ":white_check_mark: Allowed once", always: `:white_check_mark: Allowed in #${escapeSlack(ch.name)}`, denied: ":no_entry_sign: Denied" }[p.status];
    return decided(text, done, [
      button("Allow once", "harmonia:perm:once", value, "primary"),
      button(`Always in #${ch.name}`, "harmonia:perm:always", value),
      button("Deny", "harmonia:perm:denied", value),
    ]);
  }
  const job = m.kind === "job" ? ch.jobs.find((j) => j.id === m.meta?.jobId) : undefined;
  if (job) {
    const text = mrkdwn(relayText(m, ch) ?? m.text);
    const open = button("View in Claude", "harmonia:session:open", JSON.stringify({ c: ch.id, j: job.id }));
    return { text, blocks: [section(text), { type: "actions", elements: [open] }] };
  }
}

export const decided = (text: string, done: string | undefined, buttons: unknown[]) => ({
  text: done ? `${text}\n${done}` : text,
  blocks: [section(text), done ? { type: "context", elements: [{ type: "mrkdwn", text: done }] } : { type: "actions", elements: buttons }],
});

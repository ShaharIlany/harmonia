// What you can tell the app in Slack (`@Harmonia new channel …`, `status …`, `project`, …): the commands, the statuses
// by the words people use for them, and the parsing.
import type { ChannelStatus } from "../store";
import { EMAIL, slackToText } from "./text";

export type Command =
  | { kind: "help" }
  | { kind: "newChannel"; name: string; private: boolean }
  | { kind: "archive" }
  | { kind: "project" } // the list of your Claude projects, to see or change the channel's
  | { kind: "task"; task?: string } // a ClickUp task id or link; "" clears it, undefined shows it
  /** `status` undefined: show it (or, with `asked`, a status nobody knows); "" clears it. */
  | { kind: "status"; status?: ChannelStatus | ""; asked: string };

/** The statuses as the app names them. */
export const STATUS_LABELS: Record<ChannelStatus, string> = { inProgress: "In progress", waiting: "Waiting for response", later: "For later", archived: "Archived" };
export const STATUS_CHOICES = "*in progress*, *waiting*, *later*, *archived* or *none*";

/** What you might call each status, letters only: "In progress", "in-progress", "waiting for response", "none". */
const STATUS_WORDS: Record<string, ChannelStatus | ""> = {
  inprogress: "inProgress", progress: "inProgress", active: "inProgress", working: "inProgress",
  waiting: "waiting", wait: "waiting", waitingforresponse: "waiting", waitingforreply: "waiting",
  later: "later", forlater: "later",
  archived: "archived", archive: "archived",
  none: "", nostatus: "", clear: "", channels: "",
};

/** A status as typed, or undefined when it isn't one. */
export function parseStatus(text: string): ChannelStatus | "" | undefined {
  const key = text.toLowerCase().replace(/[^a-z]/g, "");
  return Object.hasOwn(STATUS_WORDS, key) ? STATUS_WORDS[key] : undefined;
}

/** A command as typed: Slack's markup as text, without any @mentions (the app's, or the people to invite). */
export const commandText = (raw: string) => slackToText(raw.replace(/<@[^>]+>/g, " "));

/**
 * The app's commands: "new channel <name>" (also "create channel …"), "new private channel <name>" (also "new group
 * chat …", "new chat …"), "status <status>" (just "status" says what it is), "archive", "project" (also "change
 * project"), "task <id or link>" ("task none" clears it) and "help". In a channel they
 * only count when the app was @mentioned; in your DM with it, always. Emails and a trailing "with" (the people to
 * invite) aren't part of the name.
 */
export function parseCommand(text: string): Command | undefined {
  const t = text.trim().replace(/^\/+/, "");
  const m = t.match(/^(?:new|create|add|make)[\s-]?(private[\s-]?channel|channel|group[\s-]?chat|chat)\b[\s:]*(.*)$/is);
  if (m) {
    const name = m[2].replace(EMAIL, " ").replace(/(?:[\s,&]|\bwith\b|\band\b)+$/i, "");
    return { kind: "newChannel", private: !/^channel$/i.test(m[1]), name: name.trim().replace(/^["“'#]+|["”']+$/g, "").trim() };
  }
  if (/^(help|\?|commands)$/i.test(t)) return { kind: "help" };
  if (/^archive[.!]?$/i.test(t)) return { kind: "archive" };
  if (/^(?:(?:change|set|switch|pick|choose)\s+(?:the\s+)?)?project[.!]?$/i.test(t)) return { kind: "project" };
  const task = t.match(/^(?:clickup\s+)?task\b[\s:]*(\S*?)[.!]?$/i); // one word: "task 1 is done" in your DM is a message
  if (task) {
    const id = task[1].trim();
    return { kind: "task", task: !id ? undefined : /^(none|clear|remove)$/i.test(id) ? "" : id };
  }
  const st = t.match(/^status\b[\s:]*(.*?)[.!?]?$/is);
  if (st) {
    const asked = st[1].trim().replace(/^["“']+|["”']+$/g, "");
    return { kind: "status", status: asked ? parseStatus(asked) : undefined, asked };
  }
}

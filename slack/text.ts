// Text going to and from Slack: its markup as plain text and back (mentions, links, mrkdwn), the relay of a Harmonia
// message into Slack, and Slack channel names. Pure functions, no state.
import { USER_NAME, nameOf } from "../roster";
import type { Channel, Message } from "../store";

export const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
export const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export const mentions = (raw: string, userId: string) => raw.includes(`<@${userId}>`) || raw.includes(`<@${userId}|`);

/** Text as a Slack quote: its first lines, clipped. */
export function quote(text: string): string {
  const t = text.trim();
  return escapeSlack(t.length > 500 ? t.slice(0, 499) + "…" : t)
    .split("\n")
    .slice(0, 12)
    .map((l) => `>${l}`)
    .join("\n");
}

/** A Slack channel name: lowercase letters, numbers, hyphens and underscores, at most 80 characters. */
export function slackChannelName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 80)
    .replace(/[-_]+$/, "");
}

/**
 * What a Harmonia message says in Slack (under its teammate's name), or undefined when it stays in the app. A feedback
 * job's card doesn't quote the feedback (its title does): you may have given it in a DM, and the channel may be shared.
 */
export function relayText(m: Message, ch?: Channel): string | undefined {
  if (m.author === "user" || m.author === "guest") return undefined;
  if (m.author === "system") return `_${m.text}_`;
  const name = nameOf(m.author);
  switch (m.kind ?? "text") {
    case "text":
      return m.text.trim() ? m.text : undefined;
    case "job": {
      const job = ch?.jobs.find((j) => j.id === m.meta?.jobId);
      return job?.feedback ? `🛠️ ${name} is amending its rules from ${USER_NAME}'s feedback (job ${job.id})` : `🛠️ ${name} ${m.text}`;
    }
    case "status":
      return m.text; // a running job's update every few minutes: "⏳ j2 · title · 5 min" and what's going on
    case "error":
      return `⚠️ ${m.text}`;
    case "permission":
      return `🔐 ${name} is waiting for ${USER_NAME}'s OK in Harmonia: ${m.meta?.permission?.summary ?? m.text}`;
    case "tools":
      return `🧰 ${name} asks for more tools in Harmonia: ${m.meta?.toolRequest?.reason ?? m.text}`;
    default:
      return undefined;
  }
}

/**
 * Slack's markup as plain text: <@U…> through `user` (Slack ids, by default), <#C…|name> as #name, links as their
 * label (and the address when the label is something else), @here and friends, and &amp; &lt; &gt; decoded.
 */
export function slackToText(text = "", user: (id: string) => string = (id) => `@${id}`): string {
  return text
    .replace(USER_MENTION, (_, id) => user(id))
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<(mailto:)?([^|>]+)\|([^>]+)>/g, (_, mailto, url, label) => (mailto || url.includes(label) ? label : `${label} (${url})`))
    .replace(/<(?:mailto:)?([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/**
 * @Name as a real Slack mention (<@U…>) for everyone in `ids` (lowercase name → Slack user id), so Slack shows the tag
 * and notifies them. The longest name wins ("@Dana Cohen" over "@Dana"). Code, links and Slack's <…> markup stay as
 * they are, and so do emails and addresses (an @ right after a letter, digit or /).
 */
export function slackMentions(text: string, ids: Map<string, string>): string {
  if (!ids.size || !text.includes("@")) return text;
  const names = [...ids.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const at = new RegExp(`(?<![\\p{L}\\p{N}_@/<|\`])@(${names.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`|<[^<>\n]*>|\[[^\]\n]*\]\([^)\s]*\))/g)
    .map((p, i) => (i % 2 ? p : p.replace(at, (_, name: string) => `<@${ids.get(name.toLowerCase())}>`)))
    .join("");
}

/** & < > as Slack wants them in text. A > that starts a line stays: it's a quote. */
export const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(?<!^[ \t]*)>/gm, "&gt;");

/**
 * Markdown (what the teammates write) as Slack's mrkdwn, for the notification text and when a markdown block won't do:
 * **bold** and headings as *bold*, *italic* as _italic_, ~~struck~~ as ~struck~, [label](url) as <url|label>, list
 * dashes as bullets. Code stays as it is.
 */
export function mrkdwn(md: string): string {
  const prose = (s: string) =>
    escapeSlack(s)
      .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
      .replace(/!?\[([^\]\n]+)\]\(((?:https?|mailto):[^\s)]+)\)/g, "<$2|$1>")
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "\u0001$1\u0001")
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `\u0001${a ?? b}\u0001`)
      .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, "$1_$2_")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/\u0001/g, "*");
  const inline = (s: string) =>
    s
      .split(/(`[^`\n]+`)/g)
      .map((p, i) => (i % 2 ? escapeSlack(p) : prose(p)))
      .join("");
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((p, i) => (i % 2 ? escapeSlack(p) : inline(p)))
    .join("");
}

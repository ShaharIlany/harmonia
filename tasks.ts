// Reading a ClickUp task from what the user typed (an id, a number or a link). Kept apart from team.ts: it only
// needs the two ClickUp settings.
import { CLICKUP_TASK_PREFIX, CLICKUP_WORKSPACE } from "./paths";

/** "ABC-123", "123" (→ ABC-123 when the task prefix is ABC), "1amkz0hxp0q" (an internal id) or a ClickUp task link. */
export function parseTask(text: string): { id: string; url: string } | undefined {
  const byCustomId = (id: string) => ({ id, url: `https://app.clickup.com/t/${CLICKUP_WORKSPACE ? CLICKUP_WORKSPACE + "/" : ""}${id}` });
  const link = text.match(/^https:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9-]+)\/?(?:[?#].*)?$/);
  if (link) return { id: /^[A-Za-z]+-\d+$/.test(link[1]) ? link[1].toUpperCase() : link[1], url: text };
  if (/^[A-Za-z]+-\d+$/.test(text)) return byCustomId(text.toUpperCase());
  if (/^\d+$/.test(text) && CLICKUP_TASK_PREFIX) return byCustomId(`${CLICKUP_TASK_PREFIX}-${text}`);
  if (/^[a-z0-9]{7,12}$/.test(text)) return { id: text, url: `https://app.clickup.com/t/${text}` };
}

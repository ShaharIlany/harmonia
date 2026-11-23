// The tools a teammate can ask for in the chat (request_tool), and the names they go by in its agent file.
// Connector tools have two names: the Claude app's (mcp__<uuid>__x) and the CLI's (mcp__claude_ai_<Connector>__x).
// Both go in the allowlist, so the tool works in the chat, in jobs and in the Claude app. The app's uuid differs per
// account, so it's read from the agent files (any connector tool already in an allowlist) instead of written here.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTS_DIR = join(homedir(), ".claude/agents");

const BUILT_IN = ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Skill", "ToolSearch"];

const CONNECTORS = [
  {
    label: "ClickUp",
    cli: "mcp__claude_ai_ClickUp__",
    tools: `add_tag_to_task add_task_dependency add_task_link add_task_to_list add_time_entry attach_task_file create_comment
      create_document create_document_page create_folder create_list create_list_in_folder create_reminder create_space_tag
      create_task create_task_comment delete_chat_message delete_comment delete_task download_document_page_attachment
      download_task_attachment execute_operator filter_tasks find_member_by_name get_bulk_tasks_time_in_status
      get_chat_channel_messages get_chat_channels get_chat_message_replies get_current_time_entry get_custom_fields
      get_document_pages get_folder get_list get_operators get_schema get_task get_task_comments get_task_time_in_status
      get_threaded_comments get_time_entries get_user get_workspace_hierarchy get_workspace_members
      list_document_page_attachments list_document_pages merge_tasks move_task react_to_chat_message remove_tag_from_task
      remove_task_dependency remove_task_from_list remove_task_link request_attachment_upload resolve_assignees search
      search_reminders send_chat_message start_time_tracking stop_time_tracking update_chat_message update_comment
      update_document_page update_folder update_list update_reminder update_task`
      .split(/\s+/)
      .map((t) => `clickup_${t}`),
  },
  {
    label: "Microsoft 365",
    cli: "mcp__claude_ai_Microsoft_365__",
    tools: `chat_message_search find_meeting_availability get_granted_scopes get_me read_resource search_people
      outlook_batch_delete_messages outlook_batch_modify_labels outlook_calendar_search outlook_create_draft outlook_create_event
      outlook_create_filter outlook_create_label outlook_create_reply_all_draft outlook_create_reply_draft outlook_delete_draft
      outlook_delete_event outlook_delete_filter outlook_delete_label outlook_email_search outlook_find_available_time
      outlook_forward_mail outlook_modify_labels outlook_modify_thread_labels outlook_respond_to_event outlook_send_draft
      outlook_send_mail outlook_set_vacation outlook_trash_thread outlook_untrash_thread outlook_update_draft outlook_update_event
      outlook_update_label sharepoint_copy_item sharepoint_create_folder sharepoint_delete_item sharepoint_folder_search
      sharepoint_move_item sharepoint_rename_item sharepoint_search sharepoint_update_file sharepoint_upload_file
      teams_create_chat teams_list_channel_messages teams_list_channels teams_list_chats teams_list_teams
      teams_reply_channel_message teams_send_channel_message teams_send_chat_message`.split(/\s+/),
  },
  {
    label: "Meetings",
    cli: "mcp__claude_ai_Meetings__",
    tools: `list_meetings get_meeting get_meeting_action_items get_meeting_transcript follow_meeting_transcript`.split(/\s+/),
  },
];

type Connector = (typeof CONNECTORS)[number];
const APP_PREFIX = /\bmcp__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__([a-z0-9_]+)/g;

/** The connector's prefixes: the CLI's, plus the Claude app's as found in the agent files and in the request itself. */
function prefixes(c: Connector, requested: string): string[] {
  const found = new Set<string>([c.cli]);
  let text = requested;
  try {
    for (const f of readdirSync(AGENTS_DIR)) if (f.endsWith(".md")) text += "\n" + readFileSync(join(AGENTS_DIR, f), "utf8");
  } catch {}
  for (const m of text.matchAll(APP_PREFIX)) if (c.tools.includes(m[2])) found.add(`mcp__${m[1]}__`);
  return [...found];
}

export type ToolGrant = { name: string; grants: string[] }; // name: what the card shows (clickup_delete_task, Bash)

/** Resolves requested names ("clickup_delete_task", "mcp__claude_ai_ClickUp__clickup_delete_task", "bash"). */
export function resolveTools(names: string[]): { found: ToolGrant[]; unknown: string[] } {
  const found: ToolGrant[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    const short = name.replace(/^mcp__.*?__/, "");
    const builtIn = BUILT_IN.find((b) => b.toLowerCase() === short.toLowerCase());
    const connector = CONNECTORS.find((c) => c.tools.includes(short.toLowerCase()));
    if (builtIn) found.push({ name: builtIn, grants: [builtIn] });
    else if (connector) found.push({ name: short.toLowerCase(), grants: prefixes(connector, name).map((p) => p + short.toLowerCase()) });
    else unknown.push(name);
  }
  return { found: found.filter((f, i) => found.findIndex((g) => g.name === f.name) === i), unknown };
}

/** Close matches for a name nobody knows, so the teammate can try again. */
export function suggestTools(name: string): string[] {
  const words = name.toLowerCase().replace(/^mcp__.*?__/, "").split(/[_\s-]+/).filter((w) => w.length > 2);
  const all = [...BUILT_IN, ...CONNECTORS.flatMap((c) => c.tools)];
  return all
    .map((t) => ({ t, score: words.filter((w) => t.toLowerCase().includes(w)).length }))
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.t);
}

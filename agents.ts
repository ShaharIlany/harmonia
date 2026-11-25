// Reads and writes what Claude Code owns for each teammate:
// ~/.claude/agents/<id>.md (model, effort, instructions) and ~/.claude/agent-memory/<id>/ (memories).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dali from "./agents/dali.md" with { type: "file" };
import elliot from "./agents/elliot.md" with { type: "file" };
import emily from "./agents/emily.md" with { type: "file" };
import leo from "./agents/leo.md" with { type: "file" };
import murphy from "./agents/murphy.md" with { type: "file" };
import sherlock from "./agents/sherlock.md" with { type: "file" };

const AGENTS_DIR = join(homedir(), ".claude/agents");
const MEMORY_ROOT = join(homedir(), ".claude/agent-memory");

export const MODELS = ["opus", "sonnet", "haiku", "fable", "inherit"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const agentFile = (id: string) => join(AGENTS_DIR, `${id}.md`);
export const memoryDir = (id: string) => join(MEMORY_ROOT, id);

// The six starter teammates, carried inside the app so a fresh machine (Windows has no installer step) has them.
const STARTERS: Record<string, string> = { dali, elliot, emily, leo, murphy, sherlock };

/** Writes the bundled file for each id whose ~/.claude/agents/<id>.md is missing. Never overwrites; an id with no bundled file is left alone. */
export function installStarterAgents(ids: string[]) {
  for (const id of ids) {
    const bundled = STARTERS[id];
    if (!bundled || existsSync(agentFile(id))) continue;
    try {
      mkdirSync(AGENTS_DIR, { recursive: true });
      writeFileSync(agentFile(id), readFileSync(bundled, "utf8").replace(/\r\n/g, "\n"), { flag: "wx" }); // LF, which split() expects, even from a CRLF checkout
      console.log(`Installed starter teammate ${agentFile(id)}`);
    } catch (e) {
      console.error(`Could not install ${agentFile(id)}: ${(e as Error).message}`);
    }
  }
}

function split(id: string) {
  if (!existsSync(agentFile(id))) throw new Error(`${agentFile(id)} is missing, and Harmonia could not create it. Copy ${id}.md from the agents folder of the Harmonia repository to ${AGENTS_DIR}.`);
  const text = readFileSync(agentFile(id), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${agentFile(id)} has no frontmatter`);
  return { front: m[1], body: m[2] };
}

const field = (front: string, key: string) => front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";

function setField(front: string, key: string, value: string) {
  const re = new RegExp(`^${key}:.*$`, "m");
  return re.test(front) ? front.replace(re, `${key}: ${value}`) : `${front}\n${key}: ${value}`;
}

export type AgentConfig = { model: string; effort: string; instructions: string; tools: string[]; file: string; description: string };

export function readAgent(id: string): AgentConfig {
  const { front, body } = split(id);
  const tools = field(front, "tools");
  return {
    model: field(front, "model") || "inherit",
    effort: field(front, "effort") || "high",
    instructions: body.replace(/^\n+/, ""),
    tools: tools ? tools.split(",").map((t) => t.trim()).filter(Boolean) : [],
    file: agentFile(id),
    description: description(front),
  };
}

/** The frontmatter description, inline or as a folded block (`description: >-` and indented lines). */
function description(front: string) {
  const m = front.match(/^description:[ \t]*(.*)$((?:\n[ \t]+.*)*)/m);
  if (!m) return "";
  const head = /^[>|]-?$/.test(m[1].trim()) ? "" : m[1];
  return (head + " " + m[2]).replace(/\s+/g, " ").trim();
}

export function writeAgent(id: string, patch: { model?: string; effort?: string; instructions?: string }): string | undefined {
  if (patch.model !== undefined && !MODELS.includes(patch.model as any)) return "Unknown model.";
  if (patch.effort !== undefined && !EFFORTS.includes(patch.effort as any)) return "Unknown effort level.";
  let { front, body } = split(id);
  if (patch.model !== undefined) front = setField(front, "model", patch.model);
  if (patch.effort !== undefined) front = setField(front, "effort", patch.effort);
  if (patch.instructions !== undefined) body = "\n" + patch.instructions.trim() + "\n";
  writeFileSync(agentFile(id), `---\n${front}\n---\n${body}`);
}

/** Adds tools to the agent's allowlist (its chat and its jobs). A teammate without an allowlist already has every tool. */
export function addTools(id: string, names: string[]) {
  let { front, body } = split(id);
  const tools = field(front, "tools");
  if (!tools) return;
  const list = tools.split(",").map((t) => t.trim()).filter(Boolean);
  front = setField(front, "tools", [...list, ...names.filter((n) => !list.includes(n))].join(", "));
  writeFileSync(agentFile(id), `---\n${front}\n---\n${body}`);
}

// ---------- Memories ----------

const MEMORY_NAME = /^[\w][\w .-]{0,80}\.md$/;
export const validMemoryName = (name: string) => MEMORY_NAME.test(name) && !name.includes("..");

export function listMemories(id: string) {
  const dir = memoryDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => validMemoryName(f) && statSync(join(dir, f)).isFile())
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => (a.name === "MEMORY.md" ? -1 : b.name === "MEMORY.md" ? 1 : b.modified - a.modified));
}

export const readMemory = (id: string, name: string) => readFileSync(join(memoryDir(id), name), "utf8");

export function writeMemory(id: string, name: string, content: string) {
  mkdirSync(memoryDir(id), { recursive: true });
  writeFileSync(join(memoryDir(id), name), content.endsWith("\n") ? content : content + "\n");
}

export const deleteMemory = (id: string, name: string) => rmSync(join(memoryDir(id), name), { force: true });

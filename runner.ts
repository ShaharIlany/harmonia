import { homedir } from "node:os";
import { join } from "node:path";
import { USER_NAME } from "./roster";
import { setting } from "./env";
import { guarded, PROTECTED_NOTE } from "./sandbox";

export type Denial = { tool: string; rule: string; summary: string };
export type RunResult = {
  text: string;
  sessionId: string;
  isError: boolean;
  cost?: number;
  tokens?: number;
  inputTotal?: number; // input tokens across the turn's API calls: fresh + cache write + cache read
  cacheRead?: number; // the part of inputTotal served from the prompt cache
  context?: number; // conversation size at the turn's last API call
  denials: Denial[];
};
export type RunOptions = {
  agentId: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean; // continue sessionId, or start a new session with that id
  title: string; // session display name in Claude Code, e.g. "[Leo] #general · Fix the upload check"
  allowedTools: string[];
  systemPrompt: string; // jobs: appended to Claude Code's prompt; chat: the whole system prompt
  onActivity: (status: string) => void;
  onText?: (text: string) => void; // the session's own words between tool calls (not its subagents')
  onTool?: (name: string, input: Record<string, any>) => void; // each tool call of the session itself
  onToolResult?: (text: string, isError: boolean) => void; // what came back
  /** A chat turn: no agent file and no built-in tools, only the MCP servers in mcpConfig. */
  chat?: { model: string; effort: string; mcpConfig: string; tools?: string[] };
  ephemeral?: boolean; // don't save the session (dry runs)
  mode?: string[]; // replaces the agent/chat arguments (the router's own flags)
};

/** File edits always go through a job, so every change has a card and its own session. */
export const NO_CHAT_TOOLS = ["Edit", "Write", "NotebookEdit"];
export const JOB_TOOLS = ["mcp__team__start_job", "mcp__team__check_jobs", "mcp__team__stop_job", "mcp__team__request_tool"];

/** The chat side's tools: the agent's allowlist without file edits, plus the job tools. Undefined = every tool. */
export const chatToolsFor = (allowlist: string[]) =>
  allowlist.length ? [...allowlist.filter((t) => !NO_CHAT_TOOLS.includes(t)), ...JOB_TOOLS] : undefined;
export type Run = { done: Promise<RunResult>; stop: () => void };

export const CLAUDE = Bun.which("claude") ?? join(homedir(), ".local/bin/claude");

/** The Claude plan's usage windows, as every CLI run reports them. Utilization is 0–1; resetsAt is epoch seconds. */
export type Usage = {
  fiveHour?: { utilization: number; resetsAt: number; status: string };
  sevenDay?: { utilization: number; resetsAt: number; status: string };
  at: number;
};
let usageListener: (u: Usage) => void = () => {};
export const onUsage = (fn: (u: Usage) => void) => void (usageListener = fn);

function readUsage(info: any) {
  const w = info?.unifiedWindows;
  if (!w) return;
  const win = (x: any) => (x && typeof x.utilization === "number" ? { utilization: x.utilization, resetsAt: x.resetsAt, status: x.status } : undefined);
  usageListener({ fiveHour: win(w.five_hour), sevenDay: win(w.seven_day), at: Date.now() });
}

const childEnv = () => {
  // Don't let the child think it runs inside another Claude Code session.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
  // Keep each session's prompt cache warm for an hour between messages, not five minutes.
  env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= "1h";
  return env;
};

/** A one-shot Haiku answer with no tools and no saved session (status summaries). Empty on failure. */
export async function quickAnswer(system: string, prompt: string, cwd: string): Promise<string> {
  if (setting("STUB")) return "(stub) I'm checking the saved column order. Waiting for the dev env to finish building, about 2 more minutes.";
  const proc = Bun.spawn(guarded(
    [CLAUDE, "-p", "--model", "claude-haiku-5-5", "--effort", "low", "--tools", "", "--strict-mcp-config", "--setting-sources", "project",
      "--disable-slash-commands", "--system-prompt", system, "--no-session-persistence", "--output-format", "stream-json", "--verbose"], cwd),
    { cwd, env: childEnv(), stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), 90_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  let result = "";
  for (const l of out.split("\n")) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "rate_limit_event") readUsage(ev.rate_limit_info);
      if (ev.type === "result" && !ev.is_error) result = String(ev.result ?? "").trim();
    } catch {}
  }
  return result;
}

/** A one-word Haiku run with no tools and no saved session, just to read the current usage. */
export async function probeUsage(cwd: string) {
  if (setting("STUB")) {
    const now = Date.now() / 1000;
    return readUsage({ unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: now + 3 * 3600, status: "allowed" }, seven_day: { utilization: 0.31, resetsAt: now + 4 * 86400, status: "allowed" } } });
  }
  const proc = Bun.spawn(guarded(
    [CLAUDE, "-p", "--model", "claude-haiku-5-5", "--tools", "", "--strict-mcp-config", "--setting-sources", "project", "--disable-slash-commands",
      "--system-prompt", "Reply with OK.", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "ok"], cwd),
    { cwd, env: childEnv(), stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  for (const l of out.split("\n")) {
    if (!l.includes("rate_limit_event")) continue;
    try {
      readUsage(JSON.parse(l).rate_limit_info);
    } catch {}
  }
}

/** Every teammate run skips permission prompts (the user's choice, 2026-11-16). */
const PERMISSION_MODE = "bypassPermissions";

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** One line about what a tool call is doing, for the "is working…" bar. */
export function describeTool(name: string, input: Record<string, any> = {}): string {
  const tool = name.replace(/^mcp__.*?__/, "");
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  return detail ? `${tool}: ${short(String(detail).replace(/\s+/g, " "))}` : tool;
}

/** The --allowedTools rule that would let this exact call through. */
function ruleFor(tool: string, input: Record<string, any> = {}): string {
  return tool === "Bash" && input.command ? `Bash(${input.command})` : tool;
}

export function runAgent(o: RunOptions): Run {
  if (setting("STUB")) return stubRun(o);

  const sessionId = o.sessionId;
  // A chat turn runs as an inline agent: the chat prompt, and the teammate's own tools (minus file edits) plus the
  // job tools. The definition is the same every turn, so the cached prefix holds.
  const chatAgent = `${o.agentId}-chat`;
  const systemPrompt = guarded([], o.cwd).length ? `${o.systemPrompt}\n\n${PROTECTED_NOTE}` : o.systemPrompt;
  const mode = o.mode ?? (o.chat
    ? [
        "--agents", JSON.stringify({
          [chatAgent]: { description: `${o.title}: the teammate's chat side`, prompt: systemPrompt, ...(o.chat.tools ? { tools: o.chat.tools } : {}) },
        }),
        "--agent", chatAgent,
        ...(o.chat.tools ? [] : ["--disallowedTools", ...NO_CHAT_TOOLS]),
        "--model", o.chat.model,
        "--effort", o.chat.effort,
        // Re-render the prompt each turn, so edited instructions apply at once. It's the same text every turn
        // otherwise, so the cache still hits.
        "--system-prompt-snapshot", "off",
        "--mcp-config", o.chat.mcpConfig,
        "--disable-slash-commands",
      ]
    : ["--agent", o.agentId, "--append-system-prompt", systemPrompt]);
  const args = [
    "-p",
    ...mode,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", PERMISSION_MODE,
    "--name", o.title,
    ...(o.ephemeral ? ["--no-session-persistence"] : []),
    ...(o.resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(o.allowedTools.length ? ["--allowedTools", ...o.allowedTools] : []),
  ];
  const env = childEnv();

  const proc = Bun.spawn(guarded([CLAUDE, ...args], o.cwd), {
    cwd: o.cwd,
    env,
    stdin: new TextEncoder().encode(o.prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const done = (async (): Promise<RunResult> => {
    let final: any;
    let lastText = "";
    let context: number | undefined;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "assistant") {
          const u = ev.message?.usage;
          if (u && !ev.parent_tool_use_id) context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") {
              o.onActivity(describeTool(c.name, c.input));
              if (!ev.parent_tool_use_id) o.onTool?.(c.name, c.input ?? {});
            }
            if (c.type === "text" && c.text.trim()) {
              lastText = c.text;
              if (!ev.parent_tool_use_id) o.onText?.(c.text);
            }
          }
        } else if (ev.type === "user" && !ev.parent_tool_use_id && o.onToolResult) {
          for (const c of ev.message?.content ?? []) {
            if (c.type !== "tool_result") continue;
            const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("\n");
            o.onToolResult(text, !!c.is_error);
          }
        } else if (ev.type === "rate_limit_event") readUsage(ev.rate_limit_info);
        else if (ev.type === "result") final = ev;
      }
    }
    await proc.exited;
    if (!final) {
      const err = (await new Response(proc.stderr).text()).trim();
      return { text: err || `claude exited with code ${proc.exitCode}`, sessionId, isError: true, denials: [] };
    }
    const u = final.usage ?? {};
    const inputTotal = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return {
      text: (final.result ?? lastText ?? "").trim(),
      sessionId: final.session_id ?? sessionId,
      isError: !!final.is_error,
      cost: final.total_cost_usd,
      tokens: inputTotal + (u.output_tokens ?? 0),
      inputTotal,
      cacheRead: u.cache_read_input_tokens ?? 0,
      context,
      denials: (final.permission_denials ?? []).map((d: any) => ({
        tool: d.tool_name,
        rule: ruleFor(d.tool_name, d.tool_input),
        summary: describeTool(d.tool_name, d.tool_input),
      })),
    };
  })();

  return { done, stop: () => proc.kill() };
}

/** HARMONIA_STUB=1: canned replies, for trying the UI without spending a run. */
function stubRun(o: RunOptions): Run {
  let stopped = false;
  const lastLine = o.prompt.trim().split("\n").filter((l) => l.startsWith("[")).pop() ?? "";
  const done = (async (): Promise<RunResult> => {
    // "stub-slow": a hold-on line, then a tool call, then 4 s of work, so the line shows.
    if (/stub-slow/.test(lastLine)) (o.onText?.("checking"), o.onTool?.("Bash", { command: "git log" }), await Bun.sleep(4000));
    o.onActivity("Read: README.md");
    await Bun.sleep(900);
    o.onActivity("Bash: git status");
    await Bun.sleep(900);
    const base = { sessionId: o.sessionId, isError: false, cost: 0.004, tokens: 21000, inputTotal: 20800, cacheRead: o.resume ? 20000 : 0, context: 21000 };
    if (stopped) return { ...base, text: "(stopped)", denials: [] };
    if (o.chat && lastLine.includes("(event)") && /finished|failed/.test(lastLine))
      return { ...base, text: "(stub) The job is done. Report's in the card above.", denials: [] };
    if (/stub-react/.test(lastLine)) return { ...base, text: "👍", denials: [] };
    if (/stub-tools/.test(lastLine) && o.chat) {
      const env = JSON.parse(o.chat.mcpConfig).mcpServers?.team?.env ?? {};
      const r = await fetch(`${env.HARMONIA_URL}/api/turn/${env.HARMONIA_TURN}/request_tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tools: ["outlook_email_search"], reason: "(stub) to look up the customer's last email" }),
      });
      const j: any = await r.json().catch(() => ({}));
      return { ...base, text: `(stub) I asked for a tool: ${j.text ?? j.error ?? r.status}`, denials: [] };
    }
    if (/stub-bubbles/.test(lastLine)) return { ...base, text: "found it\n---\n`paths.ts:36` defaults to the home folder\n---\nwant me to change it?", denials: [] };
    if (o.chat && /\bjob\b/i.test(lastLine)) return { ...base, text: "(stub) On it, I started a job.", denials: [] };
    if (/stub-permission/.test(lastLine) && !o.allowedTools.length)
      return { ...base, text: "I need to run the tests for this, can I?", denials: [{ tool: "Bash", rule: "Bash(bun test)", summary: "Bash: bun test" }] };
    const attached = [...o.prompt.matchAll(/^ {2}attached file: (.+) \(/gm)].map((m) => m[1].split("/").pop());
    if (o.chat && attached.length) return { ...base, text: `(stub) Got ${attached.length === 1 ? "the file" : `${attached.length} files`}: ${attached.map((n) => `\`${n}\``).join(", ")}`, denials: [] };
    if (o.agentId === "emily" && /design/i.test(lastLine))
      return { ...base, text: "On it. **@Leo** can you sketch this one?", denials: [] };
    if (o.agentId === "leo")
      return { ...base, text: `Two ways to do it:\n\n| Option | Cost | Risk |\n|---|---|---|\n| A. Re-encode on upload | low | low |\n| B. Strip scripts | medium | breaks signed docs |\n\nI'd go with **A**. @${USER_NAME}, OK to hand it to @Elliot?`, denials: [] };
    return { ...base, text: `(stub) Got it, ${o.agentId} here. I read: \`${lastLine.slice(0, 60)}\``, denials: [] };
  })();
  return { done, stop: () => (stopped = true) };
}

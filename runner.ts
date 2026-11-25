import type { Subprocess } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { USER_NAME } from "./roster";
import { setting } from "./env";
import { guarded, PROTECTED_NOTE } from "./sandbox";
import { recordResult, type RunRecord } from "./usage";
import { stopProcessTree } from "./platform";

// Stopping a run and what it started is platform work, so it lives in platform.ts.
export const stopTree = stopProcessTree;

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
  firstInput?: number; // input size of the run's first API call: what it carries before it has done anything
  denials: Denial[];
  answered?: boolean; // it gave its answer, even if it was stopped or closed after that
  leftRunning?: string[]; // closed after its answer because of these background tasks, still running
  closedAfter?: number; // with leftRunning: how long after its answer it was closed (ms)
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
  /**
   * It gave its answer, and these background tasks it started are still running (claude -p doesn't exit until they
   * end); Harmonia closes it at closesAt if they still are. Called again with undefined if one of them wakes it for
   * another turn.
   */
  onAnswered?: (leftRunning: string[] | undefined, closesAt?: number) => void;
  /** A chat turn: no agent file and no built-in tools, only the MCP servers in mcpConfig. */
  chat?: { model: string; effort: string; mcpConfig: string; tools?: string[] };
  ephemeral?: boolean; // don't save the session (dry runs)
  permissionMode?: string; // Claude Code's --permission-mode: bypassPermissions (default here), acceptEdits or default
  mode?: string[]; // replaces the agent/chat arguments (the router's own flags)
  model?: string; // jobs: run at this model instead of the agent file's
  effort?: string; // jobs: and at this effort
};

/** A small job (a lookup, a summary, a mechanical change) doesn't need the agent file's Opus at high effort. */
export const SMALL_JOB = { model: "sonnet", effort: "medium" };

/**
 * `--model` / `--effort` for a job. They sit next to `--agent` and are meant to override the agent file's own
 * model and effort (the chat turns already pass them the same way); nothing is added when there is no override.
 */
export const overrideArgs = (model?: string, effort?: string) => [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];

/** File edits always go through a job, so every change has a card and its own session. */
export const NO_CHAT_TOOLS = ["Edit", "Write", "NotebookEdit"];
export const JOB_TOOLS = ["mcp__team__start_job", "mcp__team__check_jobs", "mcp__team__read_job", "mcp__team__stop_job", "mcp__team__request_tool"];

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

/** A CLI `result` event's cost and token counts, as the arguments recordResult takes after the kind. */
function resultUsage(ev: any, who: Pick<RunRecord, "agentId" | "channelId" | "jobId">): [Parameters<typeof recordResult>[1], Parameters<typeof recordResult>[2]] {
  const u = ev.usage ?? {};
  const inputTotal = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return [{ cost: ev.total_cost_usd, inputTotal, cacheRead: u.cache_read_input_tokens ?? 0 }, { ...who, ms: ev.duration_ms }];
}

/** A one-shot Haiku answer with no tools and no saved session (status summaries). Empty on failure. */
export async function quickAnswer(system: string, prompt: string, cwd: string, who: Pick<RunRecord, "agentId" | "channelId" | "jobId"> = {}): Promise<string> {
  if (setting("STUB")) return "(stub) ETA ~5 min: I'm checking the saved column order. Waiting for the dev env to finish building, about 2 more minutes.";
  const proc = Bun.spawn(guarded(
    [CLAUDE, "-p", "--model", "claude-haiku-5-5", "--effort", "low", "--tools", "", "--strict-mcp-config", "--setting-sources", "project",
      "--disable-slash-commands", "--system-prompt", system, "--no-session-persistence", "--output-format", "stream-json", "--verbose"], cwd),
    { cwd, env: childEnv(), stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => stopTree(proc), 90_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  let result = "";
  for (const l of out.split("\n")) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "rate_limit_event") readUsage(ev.rate_limit_info);
      if (ev.type === "result") recordResult("status", ...resultUsage(ev, who));
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
    if (!l.includes("rate_limit_event") && !l.includes('"type":"result"')) continue;
    try {
      const ev = JSON.parse(l);
      if (ev.type === "result") recordResult("probe", ...resultUsage(ev, {}));
      else readUsage(ev.rate_limit_info);
    } catch {}
  }
}

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

/**
 * How long a run may stay open after its answer, for background tasks it left running (HARMONIA_LINGER_MINUTES).
 * claude -p waits for them, and one that never ends (a dev server, a browser driver) would hold it open for good.
 * A task that ends in time wakes it for another turn, whose answer adds to the first.
 */
const lingerMinutes = Number(setting("LINGER_MINUTES"));
const LINGER_MS = (lingerMinutes > 0 ? lingerMinutes : 10) * 60_000;
/** The longest it waits for a background command's own timeout (a job can ask for any). */
const MAX_WAIT_MS = 3 * 60 * 60_000;

/**
 * How long a run stays open after its answer, given when each background task still running stops by itself.
 * A Bash command's `timeout` is kept in the background too: Claude Code stops it then and wakes the run, so wait until
 * the last of those (and a minute for the wake). One with no limit (a dev server) may never end: LINGER_MS for that.
 */
function waitAfterAnswer(stopsAt: (number | undefined)[]) {
  const last = Math.max(0, ...stopsAt.map((t) => (t ?? 0) + 60_000 - Date.now()));
  return Math.min(MAX_WAIT_MS, Math.max(LINGER_MS, last));
}

/**
 * The size at which Claude Code compacts a session (CLAUDE_CODE_AUTO_COMPACT_WINDOW; it compacts about 13k below it).
 * HARMONIA_CHAT_COMPACT_WINDOW / HARMONIA_JOB_COMPACT_WINDOW change it ("150k", "300000"), "off" leaves the model's
 * own window. Claude Code's smallest is 100k.
 * Chat turns get their channel's new messages in the prompt, so a chat session needs little history: 100k. Jobs keep
 * more of their work in view: 200k, which still compacts a job that goes on for hours or is continued round after round.
 */
const COMPACT_WINDOW = { CHAT: "100k", JOB: "200k" };
function compactWindow(kind: keyof typeof COMPACT_WINDOW): string | undefined {
  const v = setting(`${kind}_COMPACT_WINDOW`)?.trim() || COMPACT_WINDOW[kind];
  return v.toLowerCase() === "off" ? undefined : v;
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
    : ["--agent", o.agentId, ...overrideArgs(o.model, o.effort), "--append-system-prompt", systemPrompt]);
  const args = [
    "-p",
    ...mode,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", o.permissionMode ?? "bypassPermissions",
    "--name", o.title,
    ...(o.ephemeral ? ["--no-session-persistence"] : []),
    ...(o.resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(o.allowedTools.length ? ["--allowedTools", ...o.allowedTools] : []),
  ];
  const env = childEnv();
  // Every API call re-reads the whole conversation, so a session that is never compacted gets dearer with each step.
  // With a 1M window, the chat sessions reached 600k and long jobs 590k. Compacting at a smaller window keeps them small.
  const window = o.mode ? undefined : compactWindow(o.chat ? "CHAT" : "JOB");
  if (window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= window;

  const proc = Bun.spawn(guarded([CLAUDE, ...args], o.cwd), {
    cwd: o.cwd,
    env,
    stdin: new TextEncoder().encode(o.prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const done = (async (): Promise<RunResult> => {
    let final: any;
    const answers: string[] = []; // every answer: a background task that ends can wake it for another one
    const denials = new Map<string, Denial>();
    let tasks: { id: string; description: string }[] = []; // the background tasks running now
    const timeouts = new Map<string, number>(); // Bash tool_use id → the timeout it asked for (ms)
    const stopsAt = new Map<string, number>(); // background task id → when Claude Code stops it (its Bash timeout)
    let linger: Timer | undefined;
    let answered = false; // and not woken since
    let leftRunning: string[] | undefined;
    let closedAfter = 0;
    let lastText = "";
    let context: number | undefined;
    let firstInput: number | undefined;
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
        // Compacting takes a while (more on a big conversation): say so, or the turn looks stuck.
        if (ev.type === "system" && ev.subtype === "status" && ev.status === "compacting") o.onActivity("compacting the conversation");
        if (ev.subtype === "background_tasks_changed")
          tasks = (ev.tasks ?? []).map((t: any) => ({ id: String(t.task_id), description: String(t.description || "a background task") }));
        if (ev.subtype === "task_started" && timeouts.has(ev.tool_use_id)) stopsAt.set(String(ev.task_id), Date.now() + timeouts.get(ev.tool_use_id)!);
        if (answered && (ev.subtype === "init" || ev.type === "assistant")) {
          // A background task ended and woke it: it's working again.
          answered = false;
          clearTimeout(linger);
          o.onAnswered?.(undefined);
        }
        if (ev.type === "assistant") {
          const u = ev.message?.usage;
          if (u && !ev.parent_tool_use_id) {
            const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            firstInput ??= input;
            context = input + (u.output_tokens ?? 0);
          }
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") {
              if (c.name === "Bash" && Number(c.input?.timeout) > 0) timeouts.set(c.id, Number(c.input.timeout));
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
        else if (ev.type === "result") {
          final = ev;
          const text = String(ev.result ?? "").trim();
          if (text && !ev.is_error && !answers.includes(text)) answers.push(text);
          for (const d of ev.permission_denials ?? []) {
            const rule = ruleFor(d.tool_name, d.tool_input);
            denials.set(rule, { tool: d.tool_name, rule, summary: describeTool(d.tool_name, d.tool_input) });
          }
          // Done. If what it left running keeps the process open, close it after a while: the answer is in.
          answered = true;
          clearTimeout(linger);
          const running = tasks.map((t) => t.description);
          const wait = waitAfterAnswer(tasks.map((t) => stopsAt.get(t.id)));
          linger = setTimeout(() => {
            leftRunning = running.length ? running : ["a background process"];
            closedAfter = wait;
            stopTree(proc);
          }, wait);
          o.onAnswered?.(running, Date.now() + wait);
        }
      }
    }
    await proc.exited;
    clearTimeout(linger);
    if (!final) {
      const err = (await new Response(proc.stderr).text()).trim();
      return { text: err || `claude exited with code ${proc.exitCode}`, sessionId, isError: true, denials: [] };
    }
    const u = final.usage ?? {};
    const inputTotal = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return {
      text: answers.length ? answers.join("\n\n") : String(final.result ?? lastText ?? "").trim(),
      sessionId: final.session_id ?? sessionId,
      isError: !answers.length && !!final.is_error,
      cost: final.total_cost_usd,
      tokens: inputTotal + (u.output_tokens ?? 0),
      inputTotal,
      cacheRead: u.cache_read_input_tokens ?? 0,
      context,
      firstInput,
      denials: [...denials.values()],
      answered: answers.length > 0,
      ...(leftRunning && { leftRunning, closedAfter }),
    };
  })();

  return { done, stop: () => stopTree(proc) };
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

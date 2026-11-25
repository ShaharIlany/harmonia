// The chat sessions' team tools: start_job, check_jobs, read_job, stop_job and request_tool, as a stdio MCP server.
// Claude Code starts it for each chat turn; every call goes back to the Harmonia server for that turn.
// An empty export makes this a module, so top-level await type-checks.
export {};
const URL_ = process.env.HARMONIA_URL!;
const TURN = process.env.HARMONIA_TURN!;

const TOOLS = [
  {
    name: "start_job",
    description:
      "Start a job: a Claude Code session that runs as you, with your instructions, tools and memory, in this channel's folder. " +
      "Use it for real work: changing files or code, running tests, builds or deploys, using the browser, a long investigation, or anything with many steps or that could take more than a couple of minutes. " +
      "Don't use it for quick things you can do yourself right now, like reading a file, a short read-only command, or an email, calendar or ClickUp lookup. " +
      "The job can't see the chat, so the brief must stand on its own. Returns right away; the job's report comes back later as an event.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, 3 to 8 words, shown on the job card and the session name." },
        brief: {
          type: "string",
          description: "The goal plus context, self-contained: relevant files, task ids and links, constraints, and what to report back.",
        },
        done_when: { type: "string", description: "What finished looks like and how the job can check it (a command to run, a file that exists, a question answered)." },
        approved_actions: {
          type: "array",
          items: { type: "string", enum: ["commit", "push", "open_pr", "deploy", "send_message", "none"] },
          description: "What the user has said yes to in this chat. Use [\"none\"] when they haven't approved anything beyond the work itself.",
        },
        continue_job: { type: "string", description: "Optional id of an earlier job of yours (like j3) whose session this job should continue." },
        size: {
          type: "string",
          enum: ["small", "normal"],
          description: "Optional, default normal. \"small\" runs the job on a smaller, cheaper model: use it when the job only reads, searches, summarises or makes a mechanical change. Design, debugging, multi-file changes and reviews are normal. When unsure, normal.",
        },
      },
      required: ["title", "brief", "done_when", "approved_actions"],
    },
  },
  {
    name: "check_jobs",
    description: "List the recent jobs in this channel (everyone's), with their status and what each is doing right now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_job",
    description: "Read one job in this channel (any teammate's): its title, teammate, status, brief and full report.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  },
  {
    name: "stop_job",
    description: "Stop a running job by its id (like j3).",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  },
  {
    name: "request_tool",
    description:
      "Ask the user for a tool you don't have yet, for example clickup_delete_task, clickup_create_task_comment, outlook_send_draft or Bash. " +
      "The user sees an Approve / Deny card in this channel. Once approved, the tool is yours for good (here and in your jobs), " +
      "and you're told in an event line. Returns right away. Ask only for what the current request needs.",
    inputSchema: {
      type: "object",
      properties: {
        tools: { type: "array", items: { type: "string" }, description: "Tool names, like clickup_delete_task (connector tools without the mcp__ prefix), or a built-in tool like Bash." },
        reason: { type: "string", description: "One sentence the user reads on the card: what you need it for, right now." },
      },
      required: ["tools", "reason"],
    },
  },
];

async function call(name: string, args: unknown): Promise<string> {
  const res = await fetch(`${URL_}/api/turn/${TURN}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Harmonia answered ${res.status}.`);
  return String(data.text);
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(m: any) {
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize")
    return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "team", version: "1.0.0" } });
  if (m.method === "tools/list") return reply({ tools: TOOLS });
  if (m.method === "tools/call") {
    try {
      return reply({ content: [{ type: "text", text: await call(m.params.name, m.params.arguments) }] });
    } catch (err) {
      return reply({ content: [{ type: "text", text: String((err as Error).message ?? err) }], isError: true });
    }
  }
  if (m.method === "ping") return reply({});
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
}

let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line)).catch(() => {});
  }
}

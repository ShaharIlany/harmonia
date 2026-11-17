// Laya, the router's local decision model, as a child process of the server (laya-router.py over its pipes).
// It starts with the server, loads the model once (~10 s), and stops with it. It restarts if it crashes.
import { appendFileSync, existsSync } from "node:fs";
import { LAYA } from "./paths";

export type LayaStatus = { state: "off" | "starting" | "ready" | "failed"; detail?: string };
type Answer = { choice: string; answer_confidence: number; probabilities: Record<string, number> };
type Pending = { resolve: (a: Record<string, Answer> | undefined) => void; timer: ReturnType<typeof setTimeout> };

let proc: ReturnType<typeof Bun.spawn> | undefined;
let status: LayaStatus = { state: "off" };
let nextId = 1;
let failures = 0;
const pending = new Map<number, Pending>();
let onStatus: (s: LayaStatus) => void = () => {};

export const layaStatus = () => status;

function setStatus(s: LayaStatus) {
  status = s;
  onStatus(s);
}

const log = (line: string) => {
  try {
    appendFileSync(LAYA.log, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

export function startLaya(notify?: (s: LayaStatus) => void) {
  if (notify) onStatus = notify;
  if (proc || process.env.TEAM_CHAT_STUB) return;
  if (!existsSync(LAYA.python)) return setStatus({ state: "failed", detail: `No Laya runtime at ${LAYA.python}. Run macapp/build.sh.` });
  setStatus({ state: "starting", detail: "loading the model" });
  const p = Bun.spawn([LAYA.python, "-s", LAYA.script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: process.env.HOME ?? "",
      PATH: "/usr/bin:/bin",
      PYTHONPATH: LAYA.packages,
      HF_HOME: LAYA.models,
      HF_HUB_DISABLE_TELEMETRY: "1",
      // English text goes to the English checkpoint (it routes far better), other languages to the multilingual one.
      LAYA_MODELS: "english,multilingual",
      TOKENIZERS_PARALLELISM: "false",
    },
  });
  proc = p;
  readLines(p.stdout as ReadableStream<Uint8Array>, (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return log(`stdout: ${line}`);
    }
    if (m.ready) {
      failures = 0;
      log(`ready on ${m.device}`);
      return setStatus({ state: "ready", detail: m.device });
    }
    if (m.fatal) return log(`fatal: ${m.fatal}`), setStatus({ state: "failed", detail: m.fatal });
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    clearTimeout(w.timer);
    if (m.error) log(`error: ${m.error}`);
    w.resolve(m.error ? undefined : m.answers);
  });
  readLines(p.stderr as ReadableStream<Uint8Array>, (line) => {
    if (!/Fetching \d+ files|it\/s\]|Redirects are currently not supported/.test(line)) log(line);
  });
  p.exited.then((code) => {
    if (proc !== p) return;
    proc = undefined;
    for (const [id, w] of pending) (clearTimeout(w.timer), w.resolve(undefined), pending.delete(id));
    log(`exited with code ${code}`);
    if (status.state !== "failed") setStatus({ state: "failed", detail: `stopped (code ${code})` });
    // A crash restarts it, a few times, further apart each time.
    if (++failures <= 3) setTimeout(() => startLaya(), 5000 * failures);
  });
}

export function stopLaya() {
  proc?.kill();
  proc = undefined;
}

/** One decision. Undefined when Laya isn't ready, fails or takes too long; the caller falls back. */
export function askLaya(state: string, questions: Record<string, unknown>, timeoutMs = 4000): Promise<Record<string, Answer> | undefined> {
  if (!proc || status.state !== "ready") return Promise.resolve(undefined);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => (pending.delete(id), log(`timeout on request ${id}`), resolve(undefined)), timeoutMs);
    pending.set(id, { resolve, timer });
    const stdin = proc!.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify({ id, state, questions }) + "\n");
    stdin.flush();
  });
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
}

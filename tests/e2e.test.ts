// End to end: the real server in stub mode (no `claude` is started), a message to Elliot, and his reply.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let tmp = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A free port: ask the OS for one. PORT=4805 if that fails. */
function freePort(): number {
  try {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = s.port;
    s.stop(true);
    return port ?? 4805;
  } catch {
    return Number(process.env.PORT ?? 4805);
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "harmonia-e2e-"));
  mkdirSync(join(tmp, "data"));
  // The agent files go in with LF line endings: a Windows checkout may have CRLF, which agents.ts's frontmatter match
  // doesn't accept (a known bug, not fixed here), and that would crash the server on the first turn.
  const agents = join(tmp, "home", ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  for (const f of readdirSync(join(ROOT, "agents"))) writeFileSync(join(agents, f), readFileSync(join(ROOT, "agents", f), "utf8").split("\r\n").join("\n"));
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, "server.ts"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      HARMONIA_STUB: "1",
      HARMONIA_USER: "Alex",
      HARMONIA_DATA: join(tmp, "data"),
      USERPROFILE: join(tmp, "home"),
      HOME: join(tmp, "home"),
    },
  });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}`);
    try {
      if ((await fetch(`${base}/`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server didn't answer GET /");
}, 30_000);

afterAll(() => {
  server?.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

test("Elliot answers a message in the first channel, and the server stays up", async () => {
  const headers = { Origin: base, "content-type": "application/json" };
  const state: any = await (await fetch(`${base}/api/state`, { headers })).json();
  const channel = state.channels[0];
  expect(channel?.id).toBeTruthy();

  const res = await fetch(`${base}/api/channels/${channel.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Elliot, hello" }) });
  expect(res.ok).toBe(true);

  let reply: any;
  const deadline = Date.now() + 20_000;
  while (!reply && Date.now() < deadline) {
    const all: any[] = await (await fetch(`${base}/api/channels/${channel.id}/messages`, { headers })).json();
    reply = all.find((m) => m.author === "elliot");
    if (!reply) await sleep(300);
  }
  expect(reply).toBeTruthy();
  expect(server!.exitCode).toBeNull(); // still running
}, 30_000);

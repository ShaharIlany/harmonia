// start_job's brief fields, the context pack and read_job, through Team.turnTool with a turn token set up by hand.
// Runs in stub mode (no real Claude run) against a throwaway data folder.
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harmonia-test-"));
mkdirSync(join(tmp, "home", ".claude"), { recursive: true });
cpSync(join(import.meta.dir, "..", "agents"), join(tmp, "home", ".claude", "agents"), { recursive: true });
// The data folder and home are the temp ones tests/setup.ts points at before any module loads.

const { Team } = await import("../team");
const { DATA } = await import("../paths");
const { createChannel, addMessage } = await import("../store");

const team: any = new Team(() => {}, "http://127.0.0.1:0");
const ch = createChannel("brief-test", tmp);
ch.task = { id: "ABC-1", url: "https://app.clickup.com/t/ABC-1" };
addMessage(ch.id, { author: "user", text: "Elliot, fix the login bug" });
const token = crypto.randomUUID();
team.turns.set(token, { channelId: ch.id, agentId: "elliot", tools: team.chatTools(ch, "elliot") });
const call = (tool: string, input: any) => team.turnTool(token, tool, input).text as string;
const full = { title: "Fix login", brief: "Fix the login bug in auth.ts.", done_when: "bun test passes" };

test("start_job asks for done_when and approved_actions", () => {
  expect(call("start_job", { title: "t", brief: "b" })).toContain("done_when");
  expect(call("start_job", { ...full, approved_actions: [] })).toContain("approved_actions");
  expect(call("start_job", { ...full, approved_actions: ["rm_rf"] })).toContain("approved_actions");
  expect(call("start_job", { ...full, approved_actions: ["none", "push"] })).toContain("Nothing was started");
  expect(ch.jobs.length).toBe(0);
});

test("the job's brief is composed in a fixed layout, and the context pack is written", () => {
  expect(call("start_job", { ...full, approved_actions: ["commit", "push"] })).toContain("Started job j1");
  expect(ch.jobs[0].brief).toBe("Fix the login bug in auth.ts.\n\nDone when: bun test passes\n\nApproved by Shahar: commit, push".replace("Shahar", ch.jobs[0].brief.match(/Approved by (\S+):/)![1]));
  expect(call("start_job", { ...full, approved_actions: ["none"] })).toContain("Started job j2");
  expect(ch.jobs[1].brief).toContain("nothing. Draft, don't send, commit, push or deploy.");
  const transcript = join(DATA, "transcripts", `${ch.id}-j1.txt`);
  expect(existsSync(transcript)).toBe(true);
  expect(readFileSync(transcript, "utf8")).toContain("fix the login bug");
});

test("calls from inside the server need no new fields, and read_job returns the job", () => {
  expect(team.startJob(ch, "elliot", { title: "Stub job", brief: "just this" })).toContain("Started job j3");
  expect(ch.jobs[2].brief).toBe("just this");
  const text = call("read_job", { job_id: "j1" });
  expect(text).toContain("Fix login");
  expect(text).toContain("Done when: bun test passes");
  expect(call("read_job", { job_id: "j99" })).toContain("no job j99");
});

test("a job runs on the teammate's default model unless it picks one, and a continued job keeps its model", () => {
  const start = (input: any) => {
    const text = call("start_job", { ...full, approved_actions: ["none"], ...input });
    const id = text.match(/Started job (j\d+)/)?.[1];
    if (!id) throw new Error(text);
    const job = ch.jobs.find((j: any) => j.id === id);
    job.status = "done"; // as if it had finished, so it can be continued
    return job;
  };
  expect(start({}).model).toBe("sonnet"); // the starter agents/elliot.md
  const deep = start({ model: "opus" });
  expect(deep.model).toBe("opus");
  expect(start({ continue_job: deep.id }).model).toBe("opus");
  expect(start({ continue_job: deep.id, model: "sonnet" }).model).toBe("sonnet");
  const before = ch.jobs.length;
  expect(call("start_job", { ...full, approved_actions: ["none"], model: "haiku" })).toContain('no model "haiku"');
  expect(ch.jobs.length).toBe(before);
  // A "small" job from before the model pick keeps running at Sonnet and medium effort, unless a model is picked.
  ch.jobs.push({ ...deep, id: "j90", model: undefined, size: "small", sessionId: crypto.randomUUID() });
  const small = start({ continue_job: "j90" });
  expect([small.size, small.model]).toEqual(["small", undefined]);
  const picked = start({ continue_job: "j90", model: "opus" });
  expect([picked.size, picked.model]).toEqual([undefined, "opus"]);
});

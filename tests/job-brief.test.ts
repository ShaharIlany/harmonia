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

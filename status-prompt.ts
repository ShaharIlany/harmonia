// The text a job's status update is written from (the system prompt and the prompt for the small model). Kept apart
// from the Team because it only reads what it is given, so the wording can be read and tested on its own.
import { USER_NAME, type Teammate } from "./roster";
import { time } from "./lines";
import type { Channel, Job } from "./store";

/** How many of a job's earlier status updates its next one is written against. */
const STATUS_HISTORY = 6;

export function statusPrompt(a: {
  ch: Pick<Channel, "cwd">;
  job: Job;
  t: Teammate;
  now: number;
  minutes: number;
  earlier: { ts: number; text: string; eta?: number }[];
  warning: { lead: string; why: string } | undefined;
  steps: string[] | undefined; // the job's logged steps, if it has any
}) {
  const { ch, job, t, now, minutes, earlier, warning } = a;
  const system = [
    `You write a short status update for ${USER_NAME} about a job that ${t.name} (${t.role}) is running for them.`,
    `Write as ${t.name}, in the first person, in the language of the brief.`,
    "2 to 4 short markdown lines, no heading, no preamble, no sign-off.",
    "The first line starts with the ETA to finish, as `ETA ~N min:` (minutes, even past an hour), then what's happening right now, in plain words (not tool names).",
    "Estimate it from the brief (what done looks like), the steps done so far and what's left; a wait on a build, a deploy or someone's answer counts.",
    "Then, if worth saying: what's done so far, and what we're waiting for (a build, a deploy, a test run, a query, someone's answer).",
    "If the input has a WARNING line, don't give a cheerful new ETA: lead with the warning it gives, then `: <what it's doing or waiting on, and the last real progress, with its time>`.",
    "After a warning, give a new ETA only if the log shows a concrete reason for the delay and a clear way to finish, written as `ETA ~N min because <reason>:`",
    "(keep the words `ETA` and `because` as they are, e.g. `ETA ~15 min because the backend restarted, rerunning the specs:`). With no concrete reason, give no new ETA: the warning stays.",
    "If the job is stuck, failing or retrying the same thing, say so plainly.",
    "Only state what the log shows. Don't invent results.",
  ].join("\n");
  const prompt = [
    `Job ${job.id}: ${job.title}`,
    `Now: ${time(now)}. Started ${time(job.startedAt)}, running for ${minutes} min, in ${ch.cwd}.`,
    "",
    "Brief:",
    job.brief.length > 2000 ? job.brief.slice(0, 2000) + "…" : job.brief,
    "",
    "Your earlier updates on this job, oldest first:",
    ...(earlier.length
      ? earlier.slice(-STATUS_HISTORY).map((u) =>
          `- ${time(u.ts)} (${Math.round((now - u.ts) / 60_000)} min ago${u.eta === undefined ? "" : `, ETA ~${u.eta} min`}): ${u.text.replace(/\s+/g, " ")}`)
      : ["(none yet)"]),
    ...(warning ? ["", `WARNING: ${warning.why} Lead with "${warning.lead}: …".`] : []),
    "",
    "Recent steps, oldest first:",
    ...(a.steps ?? ["(nothing yet)"]).slice(-30).map((x) => `- ${x}`),
    "",
    `Right now: ${job.activity ?? "thinking"}`,
  ].join("\n");
  return { system, prompt };
}

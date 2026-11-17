// The router: decides which teammate answers a message the user sends without naming anyone. It runs locally, with
// no Claude call:
// 1. the conversation decides first: a teammate waiting on the user's answer, else the teammate the user was just
//    talking with (a short "yes" or "delete it" belongs to them);
// 2. a new topic with nobody in the conversation goes to Laya (laya.ts), which picks by role and routing keywords;
// 3. without Laya (still loading, or failed), the triage teammate.
// (@mentions, "Name," openers and replies to a message never get here: they go straight to their teammate.)
import { askLaya, layaStatus } from "./laya";
import { ROSTER, TRIAGE, USER_NAME, nameOf, teammate } from "./roster";
import type { Message } from "./store";

export type Route = { to: string[]; why: string };

/** Messages back the router looks for the teammate the user is talking with. */
const CONVERSATION = 4;

const said = (m: Message) => m.author !== "system" && m.kind !== "status" && m.kind !== "job";

/**
 * One choice per teammate: its role and routing keywords ("QA: test, try to break, reproduce bugs"). Short keyword
 * lists route far better than the long agent descriptions or the names (measured 2026-11-17: 13/15 against 2–9/15).
 */
const criteria = () => Object.fromEntries(ROSTER.map((t) => [t.id, `${t.role.toLowerCase()}${t.routing ? `: ${t.routing}` : ""}`]));

export async function route(o: { all: Message[]; msg: Message; waitingOn?: string }): Promise<Route> {
  const before = o.all.slice(0, o.all.indexOf(o.msg)).filter(said);
  const recent = before.slice(-CONVERSATION);
  const asked = (o.waitingOn && teammate(o.waitingOn) && o.waitingOn) || recent.findLast((m) => teammate(m.author) && new RegExp(`@${USER_NAME}\\b`, "i").test(m.text))?.author;
  if (asked) return { to: [asked], why: `answering ${nameOf(asked)}'s question` };
  const last = recent.findLast((m) => teammate(m.author))?.author;
  if (last) return { to: [last], why: `continuing with ${nameOf(last)}` };

  // Only the message: earlier lines, when there are any, belong to nobody in the conversation and only add noise.
  const state = `Team chat.\n${USER_NAME}'s new message (who should answer it?):\n${o.msg.text}`;
  const answers = await askLaya(state, {
    to: {
      type: "choice",
      instructions: `Which teammate should answer ${USER_NAME}'s new message? Usually the teammate he is talking with, or the one whose work it is.`,
      criteria: criteria(),
    },
  });
  const a = answers?.to;
  if (a && teammate(a.choice)) return { to: [a.choice], why: `Laya, ${Math.round(a.answer_confidence * 100)}% sure` };
  const s = layaStatus();
  return { to: [TRIAGE], why: `nobody named; Laya ${s.state === "starting" ? "is still loading" : s.state === "ready" ? "didn't answer" : "isn't running"}` };
}

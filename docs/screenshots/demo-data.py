# Builds a Harmonia data folder with made-up channels, for README screenshots. No real customers or tasks.
import json, os, shutil, sys, uuid
from datetime import datetime

out = sys.argv[1]
shutil.rmtree(out, ignore_errors=True)
os.makedirs(f"{out}/messages")
day = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
ms = lambda h, m: int(day.replace(hour=h, minute=m).timestamp() * 1000)
mid = lambda: str(uuid.uuid4())

def msg(author, h, m, text="", kind=None, **meta):
    x = {"id": mid(), "ts": ms(h, m), "author": author, "text": text}
    if kind: x["kind"] = kind
    if meta: x["meta"] = meta
    return x

channels, messages = [], {}

def channel(name, status, msgs, jobs=(), task=None, waiting=None):
    cid = f"{name}-{uuid.uuid4().hex[:6]}"
    c = {"id": cid, "name": name, "cwd": os.path.expanduser("~/Projects/notes-app"), "createdAt": ms(8, 50),
         "lastSeen": {t: len(msgs) for t in ["leo", "elliot", "sherlock", "murphy", "emily", "dali"]},
         "allowedTools": [], "jobs": list(jobs), "nextJob": len(jobs) + 1, "status": status, "statusAt": ms(9, 0)}
    if task: c["task"] = {"id": task, "url": f"https://app.clickup.com/t/{task}"}
    if waiting: c["waitingOn"] = waiting
    channels.append(c)
    messages[cid] = msgs

# --- #dark-mode: design → reply → job → review → tool request ---
leo_opts = msg("leo", 9, 13, """Three ways to do it:

- **A. CSS media query only.** Follows the system, no toggle. Zero state, but no choice.
- **B. Toggle + system default.** A `data-theme` attribute on `<html>`, saved in `localStorage`. Follows the system until you pick. ~80 lines.
- **C. Per-account setting.** Same as B, stored on the server. Needs an API change and a migration.

I'd go with **B**: it covers everyone today, and C can come later without undoing it. @Alex, OK to go with B?""", tokens=18240, cached=0.94)
dark = [
    msg("user", 9, 12, "@Leo we need a dark mode toggle in Settings. What are the options?"),
    leo_opts,
    msg("user", 9, 20, "B. And no flash of the light theme on load.", replyTo={"id": leo_opts["id"], "author": "leo", "text": "Three ways to do it: A. CSS media query only… I'd go with B. OK to go with B?"},
        routedTo=["leo"], routeWhy="reply to Leo's message"),
    msg("leo", 9, 21, "Plan's in `docs/dark-mode.md`: tokens in `theme.css`, an inline script in `<head>` that sets the theme before first paint, and the toggle under Settings → Appearance. @Elliot, it's yours."),
    msg("elliot", 9, 22, "On it. Starting a job on branch `feature/dark-mode`."),
    msg("elliot", 9, 22, kind="job", jobId="j1"),
    msg("elliot", 9, 41, "Done. The toggle is in Settings → Appearance and follows the system until you pick. 14 files, all tests green. @Sherlock, can you review `feature/dark-mode`?"),
    msg("sherlock", 9, 44, """Two findings, one real:

1. **Bug** `theme-init.js:7`: reads `localStorage` before the `try`. In Safari private mode that throws, and the page stays blank.
2. **Nit** `Settings.tsx:52`: the toggle has no `aria-pressed`, so screen readers don't say which theme is on.

Fix 1 before it ships."""),
    msg("murphy", 9, 46, kind="tools", toolRequest={"agentId": "murphy", "tools": [{"name": "clickup_create_task_comment", "grants": []}],
        "reason": "To post the Safari private-mode repro steps on the task, so they sit next to the fix.", "status": "pending"}),
]
job = {"id": "j1", "kind": "job", "agentId": "elliot", "sessionId": str(uuid.uuid4()), "title": "Dark mode toggle", "brief": "Implement plan B from docs/dark-mode.md",
       "status": "done", "startedAt": ms(9, 22), "endedAt": ms(9, 41), "cost": 1.84, "allowed": [],
       "report": "Added `theme.css` tokens, `theme-init.js` in `<head>`, and the Appearance toggle. 14 files changed, 212 tests pass."}
channel("dark-mode", "inProgress", dark, [job], task="APP-142")

# --- #csv-export: a new topic that names nobody → Mozart picks Murphy ---
channel("csv-export", "waiting", [
    msg("user", 10, 5, "The CSV export drops the last row when a list has more than 500 notes", routedTo=["murphy"], routeWhy="Mozart: Murphy reproduces bugs"),
    msg("murphy", 10, 9, """Reproduced. With 501 notes the file has 500 rows; with 1,000 it has 999. The export pages by 500 and skips the last item of every page after the first.

Steps: create 501 notes → Export → CSV → count the rows.

@Alex, is 500 the page size on production too?"""),
], task="APP-151", waiting="murphy")

# --- #morning-brief: Emily ---
channel("morning-brief", "later", [
    msg("user", 8, 55, "Good morning, Emily", routedTo=["emily"], routeWhy="Mozart: greeting"),
    msg("emily", 8, 56, """Morning. Today:

- **10:30** Design review (45 min)
- **14:00** 1:1 with Dana
- 3 tasks due this week: APP-142, APP-151, APP-155

Nothing overdue."""),
])
channel("release-notes", None, [
    msg("user", 11, 0, "@Dali draft the release notes for 2.4"),
    msg("dali", 11, 3, "Drafted in `release-notes/2.4.md`: dark mode up top, the CSV fix as a one-liner. Nothing sent."),
])
channel("search-spike", "archived", [msg("user", 8, 0, "@Leo is SQLite FTS enough for search?"), msg("leo", 8, 2, "Yes, up to about a million notes.")])

json.dump(channels, open(f"{out}/channels.json", "w"), indent=1)
for cid, ms_ in messages.items():
    json.dump(ms_, open(f"{out}/messages/{cid}.json", "w"), indent=1, ensure_ascii=False)
sessions = {t: {"sessionId": str(uuid.uuid4()), "createdAt": ms(8, 0), "lastAt": ms(9, 46), "turns": n, "cost": n * 0.06,
                "context": ctx, "cacheRead": int(ctx * n * 0.9), "inputTotal": ctx * n}
            for t, n, ctx in [("leo", 14, 41000), ("elliot", 9, 28000), ("sherlock", 6, 22000), ("murphy", 8, 25000), ("emily", 21, 33000), ("dali", 4, 19000)]}
json.dump(sessions, open(f"{out}/chat-sessions.json", "w"), indent=1)
print(out)

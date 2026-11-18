# Team chat

A local Slack-style group chat with the six teammates in `~/.claude/agents`
(Dali, Leo, Elliot, Sherlock, Murphy, Emily).

![A channel: Leo lays out options, Elliot's job card, Sherlock's review and Murphy asking for a new tool](docs/screenshots/channel.png)

Each teammate is a Claude Code agent. They talk in channels, hand work to each
other with @mentions, and start Claude Code jobs for real work. You approve
their permissions and new tools from cards in the chat.

| Replies and the local router | A teammate's settings |
| --- | --- |
| ![Replying to Murphy; the earlier message was routed to Murphy by Laya](docs/screenshots/reply-and-router.png) | ![Leo's profile: name, role, routing keywords, avatar, chat model and effort](docs/screenshots/teammate-settings.png) |
| A reply wakes only the teammate you reply to. A message that names nobody goes to whoever you're talking with, or Laya (a local model, inside the app) picks. | Name, role, routing keywords, avatar, colour, and the chat session's model and effort. |

<details>
<summary>Dark mode</summary>

![The same channel in dark mode](docs/screenshots/channel-dark.png)

</details>

The screenshots use made-up demo data: `docs/screenshots/demo-data.py` builds it,
and `docs/screenshots/capture.mjs` takes them.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ShaharIlany/team-chat/main/install.sh | bash
```

You need a Mac with Xcode's command line tools (`xcode-select --install`),
[Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/) and the
[Claude Code CLI](https://claude.com/claude-code), signed in. The script checks
for them, clones the repo into the app's folder, builds the app, installs it in
`~/Applications` and opens it. It also adds the six starter teammates from
`agents/` to `~/.claude/agents` (see [agents/README.md](agents/README.md)),
leaving any file you already have alone. From then on the app updates itself
from `main`. Run the script again any time to reinstall.

## Team Chat.app

From a checkout:

```bash
macapp/build.sh --install   # builds build/Team Chat.app and copies it to ~/Applications
```

The app is a native window (`macapp/main.swift`, WKWebView) around the server,
compiled with `bun build --compile main.ts` into
`Contents/Resources/team-chat-server`. The page, the prompt templates and the
default `team.json` are embedded. The same binary runs the chat sessions' job
tools (`team-chat-server --job-tools`).

- **Data:** `~/Library/Application Support/Team Chat` (channels, messages, chat
  sessions, `team.json`). `settings.json` there holds `teamAgentsDir`
  (default `~/TeamAgents`), `defaultCwd` (default `~`), and for ClickUp
  `clickupWorkspace` and `clickupTaskPrefix` (say `ABC` for task ids like
  `ABC-123`). The first `--install` writes it and copies `data/` over.
- **Server:** started on 127.0.0.1:4747 with your login shell's PATH, so jobs
  find git, bun and your other tools. If something already answers on 4747 (say
  `bun server.ts`), the app shows that instead of starting a second one. Log:
  `~/Library/Logs/Team Chat/server.log` (View → Show Server Log).
- **Window:** closing it keeps the team running; click the Dock icon to bring it
  back. Quit (⌘Q) stops the server, and asks first if a teammate or job is still
  working. Unread messages show as a Dock badge. Links open in your browser;
  View → Open in Browser shows the same chat in Chrome.
- **Notifications:** whenever you're not looking at a channel (another channel,
  the window hidden, or the app in the background), a teammate's reply, a
  question for you, a permission card, an error or a finished or failed job
  becomes a macOS notification. The 5-minute job status updates don't. A
  question for you also bounces the Dock icon once. Clicking a notification
  opens its channel. The 🔔 setting at the bottom of the sidebar switches
  between all of these, only @mentions of you, or off (saved per browser). In
  a browser they're web notifications.
- **Updates over the air:** the app follows the git repo and branch it was
  built from (`build.json` in the app, written by `build.sh`). Every 30 minutes
  it fetches the branch into its own clone (`source/` in the data folder). When
  there are new commits, it builds them there with the same `build.sh`, in the
  background, and swaps the new build in when no teammate or job is working
  and you haven't sent anything for 10 minutes (`macapp/update.sh`: quit, old
  build to the Trash, new one in place, reopen; the old one comes back if the new
  one doesn't start). The sidebar footer shows an update while it's pending,
  with **Restart to update** to install it as soon as nobody's working.
  Team Chat → Check for Updates… checks now. `settings.json`: `updateRepo`,
  `updateBranch`, and `autoUpdate: false` to only show updates. Building needs
  git, bun and Xcode's command line tools; Laya's Python is cloned from the
  installed app when its version hasn't changed. Log: `update.log` in the data
  folder. A build from a commit that isn't on the branch (not pushed yet)
  doesn't update.
- **After a code change:** run `build.sh --install` again and reopen the app, or
  push it and let the app update itself. The old build goes to the Trash.

To run from source instead: `TEAM_CHAT_DATA="$HOME/Library/Application Support/Team Chat" bun team-chat/server.ts`
or `bun run stub` to try the UI.

No dependencies, no API key: everything runs on the `claude` CLI sign-in.

## Chat sessions and jobs

Every teammate has two kinds of Claude Code session:

- **One chat session**, in the **TeamAgents** project (`~/TeamAgents`, `teamAgentsDir`
  or `TEAM_AGENTS_DIR`). It's the same session for every channel, titled
  `[Name] Team chat`. It answers in the chat, asks you questions, and decides
  per request whether to do it itself or start a job. It runs as an inline
  agent (`--agents`) with the agent's own tool allowlist minus file edits
  (`Edit`, `Write`, `NotebookEdit`), so quick lookups (an email, a meeting, a
  ClickUp task, a file, `git status`) and Outlook drafts happen in the chat
  turn. It also gets `start_job`, `check_jobs` and `stop_job` (`job-tools.ts`, a
  stdio MCP server that calls back into the app with a token that's valid for
  that turn only). Its system prompt is `chat-rules.md` plus the agent's
  instructions. Model and
  effort are set per teammate on its settings page ("Chat side").
- **Jobs** for the real work: `claude -p --agent <id>` in the channel's folder,
  one session per job, titled `[Name] #channel · title`, with the agent's tools,
  memory, model and effort from `~/.claude/agents/<id>.md` and `job-rules.md`
  appended. Each appears as a card in the chat and in the sessions panel. When
  it finishes, its report goes back to the teammate's chat session as an event.

**Prompt caching.** All chat turns run in one folder. The chat system prompt
holds nothing per channel or per turn, and each turn only appends the channel's
new lines, so the cached prefix stays put. Runs set
`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. Hover a message's time, or look at the
sessions panel, to see how much input came from the cache.

**Plan usage.** The top of the sidebar shows your Claude plan's 5-hour and
weekly usage, with when each resets. Every CLI run reports them (the
`rate_limit_event` in its stream). When nothing has reported them for 5 minutes
and the page is open, the server runs a one-word Haiku probe with no tools and
no saved session. They count all your Claude use, not just this app. No dollar
amounts are shown. The bars pace you the same way as the `usage-limits-band`
Claude Code mod: a grey marker shows where usage would be now if spread evenly
over the window, the fill turns amber or red when you're 5 or 15 points ahead
of it (or past 80% / 90%), and a line says whether you're on pace and, if
you're running hot, when you'd run out before the reset.

**One reply at a time.** A teammate's chat session answers one channel at a
time. Other channels that need it wait in a queue (the typing bar says "busy in
#x, then here"). Jobs run in parallel and don't block the chat.

**Start a fresh session** on a teammate's page forgets the chat conversation.
Jobs and memories stay.

## How it behaves

- **Who answers:** `@Name` anywhere, or `Name, …` at the start, goes straight
  to that teammate, and so does a reply to a teammate's message. Anything else
  goes through the **router** (`router.ts`), which runs on this Mac with no
  Claude call: a teammate waiting on your answer gets it; else the teammate who
  spoke in the last 4 messages (a short "yes" belongs to them); else **Laya**
  (`laya.ts`, `laya-router.py`), a local decision model, picks by each
  teammate's role and *routing keywords* (teammate page → Profile). Its pick
  shows under your message ("→ Elliot · Laya, 84% sure"). While Laya loads
  (~10 s after start) or if it's down, Emily gets the message. The sidebar
  footer shows Laya's state; its log is `laya.log` in the data folder.
- **Laya inside the app:** `macapp/build.sh` builds `build/laya` once: a
  relocatable uv-managed CPython 3.14 plus `laya==0.4.35` and its packages
  (~800 MB, `--target site-packages`), and copies it with `laya-router.py`
  into `Contents/Resources/laya`. The server starts it as a child process
  (stdin/stdout JSON lines, no network port), with both checkpoints (English
  for English text, multilingual for other languages) on the Apple GPU, and restarts it
  if it crashes. The model files (~1.4 GB) live in
  `~/Library/Application Support/Team Chat/laya/hf` (HF_HOME) and download on
  first start. `bun server.ts` in the repo uses the same `build/laya`.
- **Handoffs:** a teammate's `@Name` wakes that teammate, unless it's in the
  same sentence as a question to you. Teammates write a name without `@` when
  they don't need that person yet. A woken teammate first checks it's really
  its turn; if not, it answers `(no reply)` and nothing is posted (chat-rules.md,
  "Is it your turn?"). After 8 agent turns without you, the chat pauses.
- **Job status updates:** every 5 minutes while a job runs
  (`TEAM_CHAT_STATUS_MINUTES`), its teammate posts what's happening, what's
  done and what the job is waiting for. A one-shot Haiku call (`quickAnswer`
  in `runner.ts`, no tools, no saved session) writes it from the job's last 30
  steps: its narration, tool calls and results. The chat session isn't
  involved, and teammates don't read these updates as chat lines. If the call
  fails, the update falls back to the job's latest words and current step.
- **Reply to a message:** hover a message → ↩ Reply. The composer shows what
  you're answering (Esc cancels), and the posted message quotes it (click the
  quote to jump there). A reply to a teammate's message wakes that teammate
  directly, with no router; an @mention in the reply wins instead. The
  teammate's turn shows `Alex (replying to Leo's message "…"): text`.
- **Tool requests:** a teammate that lacks a tool calls `request_tool` (a
  team tool, like `start_job`). `tool-catalog.ts` resolves the names (built-ins
  plus the ClickUp and Microsoft 365 connector tools; typos get suggestions) and
  an Approve / Deny card appears. Approve adds both names of each tool (app and
  CLI form; the app form's connector id is read from the agent files) to `~/.claude/agents/<id>.md`, so the teammate has it for good, in
  the chat and in jobs; either way it hears back as an event and carries on.
- **ClickUp task:** "+ ClickUp task" next to a channel's name tags it with a
  task. Accepts a custom task id (`ABC-123`, or `123` when `clickupTaskPrefix`
  is `ABC`), an internal id, or a task link. The task shows as a pill in the sidebar and the header. Clicking the
  header pill opens it in Chrome (`open -a "Google Chrome"`, falling back to
  the default browser); ✎ changes or removes it. Every chat turn in the
  channel tells the teammate the task id and link. Custom ids link through
  `clickupWorkspace` in `settings.json`.
- **Task links:** any task id with your `clickupTaskPrefix` (`ABC-123`) in a message (plain, in a table, or alone in
  backticks) links to that ClickUp task, with no tagging needed (`linkTasks` in
  `markdown.js`; it needs `clickupWorkspace` and `clickupTaskPrefix`). In the app, ClickUp links open
  in Chrome, and other links in the default browser.
- **Channel status:** the picker in a channel's header tags it In progress,
  Waiting for response or For later, and the sidebar groups channels by tag.
  Archived channels fold away at the bottom of the list. They're read-only:
  you can't post, nobody is woken there, and archiving is refused while a
  teammate or job is still working in the channel. Unarchive from the bar at
  the bottom of an archived channel, or pick another status.
- **Errors:** a failed turn leaves its messages unread, and the error has a
  **Try again** button. A chat session file that disappeared is replaced by a
  new session automatically.
- **Permissions:** every run uses `--permission-mode bypassPermissions`
  (`PERMISSION_MODE` in `runner.ts`). Allow / Deny cards only appear if that
  constant is changed back to a stricter mode.
- **Teammate settings:** click a teammate (sidebar, avatar or name). Name,
  avatar, role, colour and the chat model and effort live in `team.json`. Job
  model, effort and instructions are written to `~/.claude/agents/<id>.md`. Memories are the files in
  `~/.claude/agent-memory/<id>/`.
- **Claude CLI sign-in:** the sidebar shows whether the `claude` CLI is signed in.
  **Quick login** opens Terminal on `claude auth login --claudeai`.
- **Safety:** the server listens on 127.0.0.1 only, and accepts API calls and
  the WebSocket only from its own page. Teammates draft emails and posts but
  don't send them without your OK.

## Files

| File | What it holds |
|---|---|
| `team.json` | Default roster (copied into the data folder, which holds the live one) |
| `paths.ts` | Data folder, TeamAgents folder, default channel folder, embedded-file detection |
| `main.ts` | Entry point of the compiled server (`--job-tools` runs the job tools) |
| `macapp/` | The Swift app shell, Info.plist, icon script and `build.sh` |
| `roster.ts` | Loads and validates `team.json`, @mention parsing |
| `chat-rules.md` | The chat session's system prompt (plus the agent's instructions) |
| `job-rules.md` | Appended to every job's system prompt |
| `job-tools.ts` | The chat sessions' MCP server: start, check and stop jobs |
| `router.ts` | Picks who answers a message that names nobody (conversation rules, then Laya) |
| `laya.ts`, `laya-router.py` | Laya, the local decision model, as a child process of the server |
| `updates.ts`, `macapp/update.sh` | Over-the-air updates: check, build in the background, swap in when idle |
| `tool-catalog.ts` | The tools a teammate can ask for (`request_tool`) and their allowlist names |
| `team.ts` | Routing, the chat-session queue, chat turns, jobs, the turn limit |
| `runner.ts` | Runs `claude -p --agent …`, plus the stub used by `bun run stub` |
| `agents.ts` | Reads and writes agent files and agent memories |
| `store.ts` | Channels, jobs, messages and the chat sessions as JSON under `data/` |
| `public/` | The web UI (`app.js` chat and sessions, `agent-page.js` settings) |

`TEAM_CHAT_STUB=1` (`bun run stub`) gives canned replies, with no Claude runs,
to try the UI. `TEAM_CHAT_DATA` moves the data folder, `PORT` the port, and
`TEAM_CHAT_CWD` the default working folder for new channels.

## License

MIT, see [LICENSE](LICENSE).

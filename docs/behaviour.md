# How Harmonia behaves

## Chat sessions and jobs

Every teammate has two kinds of Claude Code session:

- **One chat session**, in the **TeamAgents** project (`~/TeamAgents`, `teamAgentsDir`
  or `TEAM_AGENTS_DIR`). It's the same session for every channel, titled
  `[Name] Harmonia chat`. It answers in the chat, asks you questions, and decides
  per request whether to do it itself or start a job. It runs as an inline
  agent (`--agents`) with the agent's own tool allowlist minus file edits
  (`Edit`, `Write`, `NotebookEdit`), so quick lookups (an email, a meeting, a
  ClickUp task, a file, `git status`) and Outlook drafts happen in the chat
  turn. It also gets `start_job` (brief, done_when, approved_actions), `check_jobs`, `read_job` and `stop_job` (`job-tools.ts`, a
  stdio MCP server that calls back into the app with a token that's valid for
  that turn only). Its system prompt is `chat-rules.md` plus the agent's
  instructions. Model and
  effort are set per teammate on its settings page ("Chat side").
- **Jobs** for the real work: `claude -p --agent <id>` in the channel's folder,
  one session per job, titled `[Name] #channel · title`, with the agent's tools,
  memory, model and effort from `~/.claude/agents/<id>.md` and `job-rules.md`
  appended. Each appears as a card in the chat and in the sessions panel. When
  it finishes, its report goes back to the teammate's chat session as an event.
  A job started with `size: "small"` (lookups, summaries, mechanical changes)
  runs with `--model sonnet --effort medium` instead of the agent file's, and
  keeps that when continued. Each job also records `baseline`: the input tokens
  of its first API call, i.e. what it carries before it has done anything.

**Prompt caching.** All chat turns run in one folder. The chat system prompt
holds nothing per channel or per turn, and each turn only appends the channel's
new lines, so the cached prefix stays put. Runs set
`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. Hover a message's time, or look at the
sessions panel, to see how much input came from the cache.
A chat session that grows past 60,000 tokens, or past 30,000 after an hour idle,
is replaced by a new one (it re-reads each channel's recent lines); tune with
`chatRotateTokens` and `chatRotateIdleTokens` in `settings.json`.

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

**Usage page.** Click the meters to see what the runs cost: every chat turn, job,
Mozart decision, job status update and usage probe adds a line to `usage.jsonl`
in the data folder, and the page adds them up by kind, teammate, channel and day
(Claude Code's own cost estimates).

**One reply at a time.** A teammate's chat session answers one channel at a
time. Other channels that need it wait in a queue (the typing bar says "busy in
#x, then here"). Jobs run in parallel and don't block the chat.

**Start a fresh session** on a teammate's page forgets the chat conversation.
Jobs and memories stay.

## How it behaves

- **Who answers: Mozart.** `@Name` anywhere, or `Name, …` at the start, goes
  to that teammate, and so does a reply to a teammate's message.
  Anything else, the channel's **Mozart** decides (`mozart.ts`,
  `mozart-rules.md`): one teammate, several, or nobody. Each channel has its
  own Mozart, a Claude Code session on Haiku 5.5 with no tools, so it knows
  the channel's conversation: who asked you what, who you're talking with,
  whose work a new topic is (by each teammate's role and *routing keywords*,
  teammate page → Profile). Each decision appends only the new lines, so the
  rest comes from the prompt cache; it takes about 2 seconds. Nothing shows
  while it thinks: the teammate it picks starts typing. Its pick shows under
  the message: "🎼 Mozart → Elliot · Elliot's code fix". Its sessions run in
  `mozart/` in the data folder, titled `[Mozart] #channel`, and start over
  when one grows past 60k tokens. If a decision fails or takes over 45 s, a
  rule decides instead: a teammate waiting on your answer gets it, else the
  teammate you were just talking with, else Emily ("→ Emily · nobody in the
  conversation (Mozart failed)").
  After changing `mozart-rules.md`, run `bun evals/mozart-eval.ts` (or
  `bun run eval:mozart`): 40 routing cases in `evals/mozart-cases.json`, one
  fresh Haiku call each, pass/fail per case, exit code 1 under 90%. `--dry`
  prints the prompts without calling anything.
- **A reaction instead of a turn.** Mozart also reads each message of yours
  that names its teammate, and decides whether all it needs is an
  acknowledgment: you thank a teammate, say "ok" to something finished, or
  turn down an offer and that's the end of it. Then the teammate doesn't run:
  its emoji (🙏, 👍, 🎉…) goes on your message, here and in Slack, and the line
  under it says "🎼 Mozart: Elliot reacted instead · thanks Elliot". Anything
  that also asks something, gives work, says yes to an offer or pushes back
  gets an answer. Only a short message (about 12 words, no question, file,
  voice note, code or link) is even asked about: anything longer that names
  its teammate goes straight to them. For the short ones the decision waits at
  most 15 s; then the teammate answers as usual. The teammates read your
  message later with "(reacted: Elliot 🙏)", so they don't answer it again.
- **After a teammate's message, too.** A teammate's `@Name` wakes that
  teammate (a handoff), unless it's in the same sentence as a question to you,
  and a question to you waits for you. Otherwise, if the reply names another
  teammate (or one has a job running, or is waiting on you), Mozart reads it and
  decides whether anyone follows up; a reply that doesn't skips Mozart: usually nobody, but "Murphy, can you try
  to break it?" without the `@` wakes Murphy. A note shows only when it wakes
  someone.
- **Protected folders:** every `claude` the app starts runs in a macOS
  sandbox (`sandbox.ts`, `sandbox-exec`) that blocks the folders macOS asks
  permission for: Desktop, Documents, Downloads, Music, Pictures, Movies,
  iCloud Drive, `~/Library/CloudStorage`, Mail, Messages, Safari, Calendars,
  Contacts, Notes, Reminders, other apps' data (`~/Library/Containers`) and
  `/Volumes`. A teammate gets "Operation not permitted" there, so it never
  triggers a permission prompt for Harmonia. It can move things into the
  Trash but not look inside. Allowed anyway: the channel's own folder, and
  anything in `settings.json` `"protectedAllow": ["~/Downloads"]` (read on
  every turn, no restart). `"protectedGuard": false` turns the sandbox off.
  A sandboxed process can't start its own sandbox: Chrome needs
  `--no-sandbox` (Playwright's default) and `swift build` needs
  `--disable-sandbox`.
- **Feedback:** ✎ next to React and Reply on a teammate's message (or
  "Feedback for …" in its ⌄ menu) opens a box for your feedback; Enter sends,
  Shift+Enter adds a line. It's posted in the channel as a reply to that
  message, and starts a job for the teammate who wrote it, with
  `feedback-rules.md` around it: the message, the 40 messages before it, the
  job's brief and report when it's a job card, the teammate's instructions
  file and memories, and the team rules. The teammate works out how its rules
  led to the message and amends its own instructions to include the feedback,
  keeping every intended behavior and the file as short as it can. A lesson
  for the whole team goes into `team-rules.md` in the data folder instead: if
  that file exists, its text is added to every teammate's rules under "Team
  rules from you" (read on every turn). Its report
  comes back in the chat like any job's.
- **Handoffs:** a teammate's `@Name` wakes that teammate, unless it's in the
  same sentence as a question to you. Teammates write a name without `@` when
  they don't need that person yet (Mozart still decides whether they're
  needed now). A woken teammate first checks it's really
  its turn; if not, it answers `(no reply)` and nothing is posted (chat-rules.md,
  "Is it your turn?"). After 8 agent turns without you, the chat pauses.
- **Job status updates:** at 5, 15 and 35 minutes into a job, then every 20
  (`HARMONIA_STATUS_MINUTES` scales it), and only when something changed since
  the last one (or an ETA warning is new), its teammate posts what's happening, what's
  done and what the job is waiting for. A one-shot Haiku call (`quickAnswer`
  in `runner.ts`, no tools, no saved session) writes it from the job's last 30
  steps: its narration, tool calls and results. The chat session isn't
  involved, and teammates don't read these updates as chat lines. If the call
  fails, the update falls back to the job's latest words and current step.
- **Leftovers:** `claude -p` doesn't exit while a background command it
  started is still running (a dev server, a browser driver), so a job that
  has answered can stay open. Its update then says so once, instead of
  repeating its last step. Harmonia waits until the last of those commands
  with a `timeout` of its own has reached it (Claude Code stops a background
  command at its timeout and wakes the job), at most 3 hours, or ten minutes
  after the answer (`HARMONIA_LINGER_MINUTES`) for commands without one. Then
  it closes the job with that answer and stops what it started, and the
  report says so. A background command that ends sooner wakes the job for
  another turn, and that answer adds to the report. The job rules tell
  teammates never to end a turn to wait for something, since a turn's end is
  the job's report. Stopping a job that has already answered counts as done: the
  teammate gets the report, and no Allow cards are posted, since allowing one
  would start the stopped job again. The job rules (job-rules.md) also tell
  teammates to stop what they started before they report.
- **Open in Claude:** a job's session opens in the Claude app from its card,
  its message menu, the sidebar or View in Claude in Slack, once the job has
  ended. Not while it runs: the app would resume the session next to the
  job's own run, answer the last step on its own and fork the session.
- **Menus:** right-click (or Shift+F10 on) a message, a channel or a
  teammate. A message: react, reply, copy, try again, open or stop its job,
  message the teammate, and when it was sent and what it cost. A channel: mark
  read or unread, pin to the top, mute, status, ClickUp task, open its folder,
  archive (also under ⋮ in the header). Pins, mutes and unread counts are kept
  per browser. A muted channel still notifies you when a teammate needs your OK.
- **Reactions:** your emoji on any message (its menu, or ☺ beside it); click
  your reaction to take it off. Teammates react when Mozart says a reaction is
  enough (above), or by answering with only an emoji.
- **Files:** 📎 in the composer, drop files anywhere on the channel, or paste
  them (a screenshot, a picture copied from a page, a file copied in the
  Finder; text copied from Word or Excel still pastes as text). Up to 10 files
  of up to 100 MB on a message, with or without words. They upload while you
  type and wait above the composer (× takes one off; they stay with their
  channel if you switch away). Pictures show in the bubble (click one for a
  viewer, ← → between them); other files are cards that open in their app.
  A message's menu has **Show in Finder**. Each file is copied into the data
  folder, `attachments/<channel>/<id>/<name>` (`attachments.ts`), and the
  teammates read it under the message as `attached file: <path> (type,
  size)`: they open it with Read (images and PDFs too) and put the path in a
  job's brief. That works for files from Downloads or the Desktop, which the
  sandbox otherwise keeps them out of. Uploads that never went out are
  deleted the next time the server starts.
- **Reply to a message:** hover a message → ↩ beside it, or Reply in its menu. The composer shows what
  you're answering (Esc cancels), and the posted message quotes it (click the
  quote to jump there). A reply to a teammate's message goes to that teammate
  (Mozart only decides whether a reaction is enough); an @mention in the reply
  wins instead. The
  teammate's turn shows `Alex (replying to Leo's message "…"): text`.
- **Tool requests:** a teammate that lacks a tool calls `request_tool` (a
  team tool, like `start_job`). `tool-catalog.ts` resolves the names (built-ins
  plus the ClickUp, Microsoft 365 and Meetings connector tools; typos get suggestions) and
  an Approve / Deny card appears. Approve adds both names of each tool (app and
  CLI form; the app form's connector id is read from the agent files) to `~/.claude/agents/<id>.md`, so the teammate has it for good, in
  the chat and in jobs; either way it hears back as an event and carries on.
- **ClickUp task:** "+ ClickUp task" next to a channel's name (or the
  channel's menu) tags it with a task. Accepts a custom task id (`ABC-123`, or `123` when `clickupTaskPrefix`
  is `ABC`), an internal id, or a task link. The task shows as a pill in the sidebar and the header. Clicking the
  header pill opens it in Chrome (`open -a "Google Chrome"`, falling back to
  the default browser); ✎ changes or removes it. Every chat turn in the
  channel tells the teammate the task id and link. Custom ids link through
  `clickupWorkspace` in `settings.json`.
- **Task links:** any task id with your `clickupTaskPrefix` (`ABC-123`) in a message (plain, in a table, or alone in
  backticks) links to that ClickUp task, with no tagging needed (`linkTasks` in
  `markdown.js`; it needs `clickupWorkspace` and `clickupTaskPrefix`). In the app, ClickUp links open
  in Chrome, and other links in the default browser.
- **Channel status:** the channel's menu tags it In progress, Waiting for
  response or For later, and the chat list groups channels by tag (newest
  message first, pinned ones on top). The search box filters by name or task.
  Archived channels fold away at the bottom of the list. They're read-only:
  you can't post, nobody is woken there, and archiving is refused while a
  teammate or job is still working in the channel. Unarchive from the bar at
  the bottom of an archived channel, or from its menu.
- **Errors:** a failed turn leaves its messages unread, and the error has a
  **Try again** button. A chat session file that disappeared is replaced by a
  new session automatically.
- **Permissions:** each channel's menu has a Permissions choice for its jobs:
  run everything without asking (`bypassPermissions`), edit files freely and
  ask before commands (`acceptEdits`), or ask before edits and commands
  (`default`). Asking shows the Allow once / Always / Deny cards. A channel with
  no choice gets settings.json `"permissionMode"` (`bypass`, `acceptEdits` or
  `ask`), else `bypass` where the sandbox is on (the Mac) and `acceptEdits`
  where it isn't. Chat turns stay on bypass (no file-edit tools, and they have
  no cards) unless they have no tool list and no sandbox.
- **DMs:** click a teammate in the sidebar for your DM with them: a channel
  of its own (`dm` set on it, made the first time you open it), shown under the
  teammate with its unread count. Only that teammate reads it and only that
  teammate is woken there, whoever your message names, and Mozart stays out.
  Its turns say "your DM with Alex", and an @mention it writes wakes nobody.
  Jobs it starts run in the default folder, like any channel's.
- **Teammate settings:** right-click a teammate in the sidebar (or click its
  avatar or name in a message, or ⚙ in its DM's menu). Name,
  avatar, role, colour and the chat model and effort live in `team.json`. Job
  model, effort and instructions are written to `~/.claude/agents/<id>.md`. Memories are the files in
  `~/.claude/agent-memory/<id>/`.
- **Claude CLI sign-in:** the sidebar shows whether the `claude` CLI is signed in.
  **Quick login** opens Terminal on `claude auth login --claudeai`.
- **Safety:** the server listens on 127.0.0.1 only, and accepts API calls and
  the WebSocket only from its own page. Teammates draft emails and posts but
  don't send them without your OK.
- **Slack:** see [Slack](slack.md).

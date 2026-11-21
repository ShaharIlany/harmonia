<h1><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-white.svg"><img alt="Harmonia" src="docs/brand/lockup.svg" height="56"></picture></h1>

A local group chat, laid out like WhatsApp, with the six teammates in `~/.claude/agents`
(Dali, Leo, Elliot, Sherlock, Murphy, Emily). It used to be called Team Chat.

![A channel: Leo lays out options, Elliot's job card, Sherlock's review and Murphy asking for a new tool](docs/screenshots/channel.png)

Each teammate is a Claude Code agent. They talk in channels, hand work to each
other with @mentions, and start Claude Code jobs for real work. You approve
their permissions and new tools from cards in the chat.

| Replies and Mozart | Right-click menus | A teammate's settings |
| --- | --- | --- |
| ![Replying to Murphy; the earlier message was routed to Murphy by Mozart](docs/screenshots/reply-and-router.png) | ![A message's menu: reactions, reply, copy, message the teammate, their settings](docs/screenshots/menus.png) | ![Leo's profile: name, role, routing keywords, avatar, chat model and effort](docs/screenshots/teammate-settings.png) |
| A reply wakes only the teammate you reply to. A message that names nobody goes to whoever the channel's Mozart picks. | Right-click a message, a channel or a teammate. | Name, role, routing keywords, avatar, colour, and the chat session's model and effort. |

<details>
<summary>Dark mode</summary>

![The same channel in dark mode](docs/screenshots/channel-dark.png)

</details>

The screenshots use made-up demo data and a made-up user, Alex:
`docs/screenshots/demo-data.py` builds the data, and `docs/screenshots/capture.mjs`
takes them from the demo server (its first line has the commands).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ShaharIlany/harmonia/main/install.sh | bash
```

You need an Apple Silicon Mac and the
[Claude Code CLI](https://claude.com/claude-code), signed in. Nothing to build:
the script downloads the latest release, checks it against its SHA-256,
installs it in `~/Applications` and opens it. It also adds the six starter
teammates to `~/.claude/agents` (see [agents/README.md](agents/README.md)),
leaving any file you already have alone. From then on the app updates itself
from new releases. Run the script again any time to reinstall.

To build it yourself instead (an Intel Mac, or to follow a branch):
`HARMONIA_FROM_SOURCE=1` before `bash`. That needs Xcode's command line tools
(`xcode-select --install`) and [Bun](https://bun.sh).

### Coming from Team Chat

Team Chat updates itself to Harmonia like to any other release, and running
the install script does the same. The app moves to `Harmonia.app`, its data
folder to `~/Library/Application Support/Harmonia` (the old folder's name
stays behind as a link to it), and Mozart's sessions, your pinned and muted
channels and the window's place come along.
Two things to do by hand: allow notifications again when macOS asks (they're
per app, and the app's id changed), and put Harmonia back in the Dock if
Team Chat was kept there.

### Coming from the Microsoft Teams bridge

The Teams bridge is gone: a Slack bridge took its place (see **Slack** below).
The Teams bots stop answering when you update. The channels they made here
(`#teams-<id>` and the linked ones) stay as ordinary channels with their
messages. What's left to clean up, if you like: delete the bots' apps in the
Teams Developer Portal, the `Harmonia Teams bot` items in your Keychain, and
`teams.json` and `teams-links.json` in the data folder (nothing reads them).

## Releases

Every version tag is a release, built on GitHub
([.github/workflows/release.yml](.github/workflows/release.yml), on an Apple
Silicon runner):

```bash
git tag v1.2.0 && git push origin v1.2.0
```

It builds the app with `build.sh` and publishes `Harmonia-arm64.zip` (about
20 MB) with its `.sha256`, and the same app as `Team-Chat-arm64.zip`: installs
from before the rename look for that name. Pushing to `main` alone ships
nothing.

## Harmonia.app

From a checkout:

```bash
macapp/build.sh --install   # builds build/Harmonia.app and copies it to ~/Applications
```

The app is a native window (`macapp/main.swift`, WKWebView) around the server,
compiled with `bun build --compile main.ts` into
`Contents/Resources/harmonia-server`. The page, the prompt templates and the
default `team.json` are embedded. The same binary runs the chat sessions' job
tools (`harmonia-server --job-tools`).

- **Data:** `~/Library/Application Support/Harmonia` (channels, messages, chat
  sessions, `team.json`). `settings.json` there holds `teamAgentsDir`
  (default `~/TeamAgents`), `defaultCwd` (default `~`), and for ClickUp
  `clickupWorkspace` and `clickupTaskPrefix` (say `ABC` for task ids like
  `ABC-123`). The first `--install` writes it and copies `data/` over.
- **Server:** started on 127.0.0.1:4747 with your login shell's PATH, so jobs
  find git, bun and your other tools. If something already answers on 4747 (say
  `bun server.ts`), the app shows that instead of starting a second one. Log:
  `~/Library/Logs/Harmonia/server.log` (View → Show Server Log).
- **Window:** closing it keeps the team running; click the Dock icon to bring it
  back. Quit (⌘Q) stops the server, and asks first if a teammate or job is still
  working. The Dock badge counts teammates' messages that came while you weren't
  looking (another channel, or the app in the background); muted channels
  don't count. Links open in your browser;
  View → Open in Browser shows the same chat in Chrome.
- **Notifications:** whenever you're not looking at a channel (another channel,
  the window hidden, or the app in the background), a teammate's reply, a
  question for you, a permission card, an error or a finished or failed job
  becomes a macOS notification. The 5-minute job status updates don't. A
  question for you also bounces the Dock icon once. Clicking a notification
  opens its channel. The 🔔 setting at the bottom of the sidebar switches
  between all of these, only @mentions of you, or off (saved per browser). In
  a browser they're web notifications.
- **Updates over the air:** every 30 minutes the app asks GitHub for the
  repo's latest release (`updates.ts`; the repo is in `build.json`, written by
  `build.sh`). When it's newer than the running version, the app downloads the
  zip in the background, checks its SHA-256, unpacks it and signs it ad hoc. It swaps the new build in when no
  teammate or job is working and you haven't sent anything for 10 minutes: the
  server moves the running build to `previous/` in the data folder, puts the
  new one in its place and exits, and the app reopens itself on the new build.
  (A helper that outlives the app can't do it: macOS ends everything an app
  started when it quits.) The chat list's footer shows an update while it's
  pending, with **Restart to update** to install it as soon as nobody's
  working. Harmonia → Check for Updates… checks now. A build without a
  version (made from source) counts as older than any release.
  `settings.json`: `updateRepo` (`owner/name`), `autoUpdate: false` to only
  show updates, and `"updateFrom": "source"` to follow a branch's commits
  instead (`updateBranch`): the app then fetches them into its own clone
  (`source/` in the data folder) and builds them there with `build.sh`, which
  needs git, bun and Xcode's command line tools. Log: `update.log` in the data
  folder.
- **After a code change:** run `build.sh --install` again and reopen the app,
  or tag a release and let the app update itself. The old build goes to the
  Trash. (A build from source updates itself to the next release, unless
  `updateFrom` is `source`.)

To run from source instead: `HARMONIA_DATA="$HOME/Library/Application Support/Harmonia" bun server.ts`
or `bun run stub` to try the UI.

No dependencies, no API key: everything runs on the `claude` CLI sign-in.

## Chat sessions and jobs

Every teammate has two kinds of Claude Code session:

- **One chat session**, in the **TeamAgents** project (`~/TeamAgents`, `teamAgentsDir`
  or `TEAM_AGENTS_DIR`). It's the same session for every channel, titled
  `[Name] Harmonia chat`. It answers in the chat, asks you questions, and decides
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

- **Who answers: Mozart.** `@Name` anywhere, or `Name, …` at the start, goes
  straight to that teammate, and so does a reply to a teammate's message.
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
- **After a teammate's message, too.** A teammate's `@Name` wakes that
  teammate (a handoff), unless it's in the same sentence as a question to you,
  and a question to you waits for you. Otherwise Mozart reads the reply and
  decides whether anyone follows up: usually nobody, but "Murphy, can you try
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
  keeping every intended behavior and the file as short as it can. Its report
  comes back in the chat like any job's.
- **Handoffs:** a teammate's `@Name` wakes that teammate, unless it's in the
  same sentence as a question to you. Teammates write a name without `@` when
  they don't need that person yet (Mozart still decides whether they're
  needed now). A woken teammate first checks it's really
  its turn; if not, it answers `(no reply)` and nothing is posted (chat-rules.md,
  "Is it your turn?"). After 8 agent turns without you, the chat pauses.
- **Job status updates:** every 5 minutes while a job runs
  (`HARMONIA_STATUS_MINUTES`), its teammate posts what's happening, what's
  done and what the job is waiting for. A one-shot Haiku call (`quickAnswer`
  in `runner.ts`, no tools, no saved session) writes it from the job's last 30
  steps: its narration, tool calls and results. The chat session isn't
  involved, and teammates don't read these updates as chat lines. If the call
  fails, the update falls back to the job's latest words and current step.
- **Menus:** right-click (or Shift+F10 on) a message, a channel or a
  teammate. A message: react, reply, copy, try again, open or stop its job,
  message the teammate, and when it was sent and what it cost. A channel: mark
  read or unread, pin to the top, mute, status, ClickUp task, open its folder,
  archive (also under ⋮ in the header). Pins, mutes and unread counts are kept
  per browser. A muted channel still notifies you when a teammate needs your OK.
- **Reactions:** your emoji on any message (its menu, or ☺ beside it); click
  your reaction to take it off. Teammates react by answering with only an emoji.
- **Reply to a message:** hover a message → ↩ beside it, or Reply in its menu. The composer shows what
  you're answering (Esc cancels), and the posted message quotes it (click the
  quote to jump there). A reply to a teammate's message wakes that teammate
  directly, without Mozart; an @mention in the reply wins instead. The
  teammate's turn shows `Alex (replying to Leo's message "…"): text`.
- **Tool requests:** a teammate that lacks a tool calls `request_tool` (a
  team tool, like `start_job`). `tool-catalog.ts` resolves the names (built-ins
  plus the ClickUp and Microsoft 365 connector tools; typos get suggestions) and
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
- **Slack:** the teammates can talk in Slack, through one Slack app,
  **Harmonia**. Click the **Slack bridge** light at the bottom left for a
  step-by-step page: create the app from its manifest (one link sets up Socket
  Mode, a bot you can DM, its scopes and its events), install it in your
  workspace, make an app-level token with `connections:write`, and paste the
  bot token (`xoxb-…`) and the app-level token (`xapp-…`) on the page.
  Harmonia checks both with Slack and keeps them in your Keychain. The app
  connects out over Slack's Socket Mode (`slack-socket.ts`), so nothing listens
  on the internet; it works while Harmonia runs. The light is green when it's
  connected and paired.
  - **Pairing:** the page then shows a 6-digit code. Send it to the app in a
    Slack DM: whoever sends it is the one the teammates work for. **Pair
    someone else** makes a new code. After five wrong codes from one person,
    the app stops answering them.
  - **Your DM** with the app mirrors the channel `#slack`: what you write there
    is posted as you, Mozart picks who answers (or `@Leo` goes straight to
    Leo), and the answers come back to the DM.
  - **Channels:** `/invite @Harmonia` in a channel or private channel and
    write there: the first time, it's linked to a new channel here
    (`#slack-<name>`). Each teammate answers under its own name and emoji
    (`chat:write.customize`: the avatar as a picture, Apple's emoji from
    `emoji-datasource-apple` on jsDelivr, so its skin tone shows as it does
    here; when the picture can't be had, the avatar's Slack emoji, else the
    avatar goes before the name). Without apps of their own (below), the
    teammates aren't Slack members, so Slack's @ menu doesn't list them: type
    `@Emily` in full, or start with `Emily, …`. Answers, job starts and errors
    go to Slack
    where you last wrote: in the channel, or in the thread you replied in; the
    5-minute job status updates stay here. The teammates' Markdown goes in a
    Slack markdown block. What you type in the app goes to Slack as "Alex (in
    Harmonia)". While a teammate works on your Slack message, it carries 👀.
  - **Teammates as Slack members:** on the Slack page, each teammate can get a
    Slack app of its own (a bot that only posts), so it's a member you can
    @mention from Slack's list, with its own profile. Generate an app
    configuration token (api.slack.com/apps → **Your App Configuration
    Tokens**) and paste it: Harmonia makes the apps (`apps.manifest.create`,
    scopes `chat:write` and `chat:write.customize`, nothing to DM), sets each
    icon to the teammate's emoji (a 512 px picture the page draws,
    `apps.icon.set`), and doesn't keep the token. Then install each app and
    paste its bot token: Harmonia checks it's that app's, keeps it in the
    Keychain, and invites the bot to the linked channels (and to new ones).
    There, the teammate's answers go out from its own bot. Everything still
    comes in through the Harmonia app: `<@Emily's bot>` reads as `@Emily`.
    Cards with buttons (their clicks go to the Harmonia app), your DM with
    Harmonia and group DMs stay with Harmonia, under the teammate's name. A bot
    taken out of a channel is invited back; one whose token Slack stops taking
    (uninstalled) shows **Needs you**, and Harmonia posts for it meanwhile.
    Pasting a configuration token again updates the apps' names, descriptions
    and icons (after a rename, say); **Forget** drops one here (delete the app
    in Slack yourself).
  - **Replies:** reply in a Slack thread to a message and it's a reply to that
    message here: a reply to a teammate goes straight to them (no Mozart), and
    the answers come back in the thread. A reply you type in the app goes in
    that message's Slack thread. Every message keeps its Slack ts
    (`meta.slack`) for this.
  - **Reactions:** your reaction on a message in Slack is your reaction on it
    here, and taking it off takes it off (one at a time, as in the app; a
    custom emoji shows as `:name:`). Other people's reactions aren't read.
  - **⚠️ feedback:** react ⚠️ to a teammate's message and Harmonia DMs you:
    "How can Leo's message be improved?", quoting it. Answer in that DM's
    thread, or press **Write feedback** for a box. Either way it's the same as
    ✎ in the app: a feedback job in which the teammate amends its rules. The
    feedback stays out of the Slack channel (shared channels have other people
    in them), and the job's card there says only that the teammate is
    amending its rules.
  - **Requests with buttons:** when a teammate asks for a tool it doesn't have
    (a connector, through `request_tool`), its message in Slack has
    **Approve** / **Deny**; a permission card has **Allow once** / **Always in
    #channel** / **Deny**. Only your clicks count (anyone else gets a note only
    they see). Decide in Slack or in the app: the Slack message then says what
    you chose, without the buttons.
  - **Only you wake the teammates.** Other people's messages in a linked
    channel show here as "Bob · in Slack", and the teammates and Mozart read
    them as context, but they never wake anyone: the teammates can read your
    mail and calendar. Only you can run the app's commands, and a DM from
    anyone else gets "Sorry, I only work for Alex."
  - **New channels from Slack:** `@Harmonia new channel <name>` creates a Slack
    channel with you in it and links it to a new channel here; `@Harmonia new
    private channel <name>` (also `new group chat`) makes one only its members
    see. @mention people, or write their email, to invite them too. No admin
    needed, unless your workspace doesn't let apps create channels. In your DM
    with the app, leave out the `@Harmonia`. `@Harmonia help` lists the
    commands.
  - Messages from Slack are read as text: mentions become `@Name`, and links
    their label and address. Files stay in Slack (the teammates see their
    names). The Slack page lists the linked conversations, with **Unlink**.
    `slack.json` in the data folder holds the workspace, who the app works for,
    the links, the open ⚠️ questions and the teammates' apps; the tokens are in the Keychain
    (`Harmonia Slack`; off a Mac, `slack-secrets.json` in the data folder,
    readable only by you).
  - **An app made from an older manifest** (before reactions and buttons) is
    missing scopes: the Slack page notices and shows how to update it (paste
    the new manifest in the app's **App Manifest** page, then reinstall it).

## Files

| File | What it holds |
|---|---|
| `team.json` | Default roster (copied into the data folder, which holds the live one) |
| `paths.ts` | Data folder (and moving Team Chat's over), TeamAgents folder, default channel folder, embedded-file detection |
| `env.ts` | Reads a `HARMONIA_*` setting, or its `TEAM_CHAT_*` name from before the rename |
| `main.ts` | Entry point of the compiled server (`--job-tools` runs the job tools) |
| `macapp/` | The Swift app shell, Info.plist, icon script and `build.sh` |
| `.github/workflows/release.yml` | Builds and publishes a release for every version tag |
| `install.sh` | Installs the latest release (or builds from source) |
| `roster.ts` | Loads and validates `team.json`, @mention parsing |
| `chat-rules.md` | The chat session's system prompt (plus the agent's instructions) |
| `job-rules.md` | Appended to every job's system prompt |
| `feedback-rules.md` | The prompt of a feedback job (a teammate amending its rules) |
| `job-tools.ts` | The chat sessions' MCP server: start, check and stop jobs |
| `mozart.ts`, `mozart-rules.md` | Mozart, each channel's coordinator: decides who answers each message (Haiku), with fallback rules |
| `updates.ts` | Over-the-air updates: check for a release (or commits), get it in the background, swap in when idle |
| `tool-catalog.ts` | The tools a teammate can ask for (`request_tool`) and their allowlist names |
| `team.ts` | Routing, the chat-session queue, chat turns, jobs, the turn limit |
| `runner.ts` | Runs `claude -p --agent …`, plus the stub used by `bun run stub` |
| `sandbox.ts` | The macOS sandbox that keeps teammates out of protected folders |
| `agents.ts` | Reads and writes agent files and agent memories |
| `store.ts` | Channels, jobs, messages and the chat sessions as JSON under `data/` |
| `slack.ts` | The Slack bridge: the app's manifest, the tokens in the Keychain, pairing, your DM and linked channels both ways, the teammates' names and emoji (and their own Slack apps), threads, reactions, ⚠️ feedback, buttons on requests, 👀, `new channel` |
| `slack-socket.ts` | Slack Socket Mode and the Web API without the SDK: the WebSocket, acks, refreshes, rate limits |
| `public/` | The web UI (`app.js` chat and sessions, `agent-page.js` settings, `slack-page.js` Slack) |
| `docs/brand/` | The logo, app icon, colours and usage rules (`make-brand.py` writes them) |
| `docs/screenshots/` | The README screenshots, their demo data and the script that takes them |

`HARMONIA_STUB=1` (`bun run stub`) gives canned replies, with no Claude runs,
to try the UI. `HARMONIA_DATA` moves the data folder, `PORT` the port,
`HARMONIA_CWD` the default working folder for new channels, and `HARMONIA_USER`
the name the teammates call you (your login name by default), and
`HARMONIA_SLACK_API` points the Slack bridge at another Web API (a local fake,
to try it without Slack). The `TEAM_CHAT_*` names from before the rename still
work.

## Brand

*Harmonia* first meant tuning a lyre's strings to each other, so the logo is a
lyre whose six strings are the starter teammates' colours, on a thin graphite
frame. The wordmark is Poppins, and the app is graphite and cool greys: the
teammates are the colour. The logo, app icon, colours and usage rules are in
[docs/brand](docs/brand/guidelines.md).

## License

MIT, see [LICENSE](LICENSE).

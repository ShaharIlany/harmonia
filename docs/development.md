# Development

Conventions, the map of the modules and what not to touch are in
[CLAUDE.md](../CLAUDE.md). Settings and environment variables are in
[Settings](settings.md).

## Running from source

To run from source instead: `HARMONIA_DATA="$HOME/Library/Application Support/Harmonia" bun server.ts`
or `bun run stub` to try the UI.

## Tests

`bun test` runs the unit tests and one end-to-end run of the server with stub teammates (no `claude` runs,
nothing outside a temp folder is touched). No workflow runs them: run them yourself before a pull request.

## Type check

`bun run typecheck`.

## Stub mode

`bun run stub` starts the server on port 4748 with canned replies, no Claude runs and its data in `./data-stub`
(`HARMONIA_STUB=1`). The last line of a message picks a canned behaviour: `stub-slow`, `stub-react`, `stub-tools`,
`stub-bubbles` or `stub-permission`; a word `job` starts a stub job, and `need a tool` makes a tool request.

## Trying a change before it's merged

If you use Harmonia and work on it, keep the installed app as it is and run the
change as a **candidate**: a second Harmonia with its own port, its own copy of
your data and its own git worktree.

```
bun candidate.ts my-branch          # that branch, at the first free port from 4749
bun candidate.ts                    # this checkout as it is now, uncommitted changes too
bun candidate.ts my-branch --stub   # canned teammates, no Claude runs
bun candidate.ts my-branch --refresh   # copy your data again first
bun candidate.ts list | clean [ref] | restore [ref]
```

The candidate copies your data folder once (`~/.harmonia-candidates/<name>/`,
`HARMONIA_CANDIDATES` moves it), without Slack's settings and tokens, so it
can't take your Slack messages, and with updates off. Your teammates' agent
files and memories live in `~/.claude` and can't be moved: they're copied aside
before each run and compared after it, and `restore` puts them back. A
channel's working folder is still your real folder, so jobs in a candidate can
change real files; try those in a channel pointed at a scratch folder.

## The Mozart eval

After changing `mozart-rules.md`, run `bun run eval:mozart` (the same as `bun evals/mozart-eval.ts`); the details are
under Mozart in [How it behaves](behaviour.md). It starts real `claude` runs, one per case.

## Files

| File | What it holds |
|---|---|
| `team.json` | Default roster (copied into the data folder, which holds the live one) |
| `paths.ts` | Data folder (and moving Team Chat's over), TeamAgents folder, default channel folder, embedded-file detection |
| `env.ts` | Reads a `HARMONIA_*` setting, or its `TEAM_CHAT_*` name from before the rename |
| `main.ts` | Entry point of the compiled server (`--job-tools` runs the job tools) |
| `macapp/` | The Swift app shell, Info.plist, icon script and `build.sh` |
| `.github/workflows/release.yml` | Builds and publishes a release for every version tag |
| `.github/workflows/windows.yml` | Builds the Windows server and checks that it starts, for every PR and push to main |
| `.github/workflows/tag.yml` | Tags every push to `main` as the next patch version, and starts its release |
| `install.sh` | Installs the latest release (or builds from source) |
| `roster.ts` | Loads and validates `team.json`, @mention parsing |
| `chat-rules.md` | The chat session's system prompt (plus the agent's instructions) |
| `job-rules.md` | Appended to every job's system prompt |
| `feedback-rules.md` | The prompt of a feedback job (a teammate amending its rules) |
| `job-tools.ts` | The chat sessions' MCP server: start, check and stop jobs |
| `mozart.ts`, `mozart-rules.md` | Mozart, each channel's coordinator: decides who answers each message (Haiku), with fallback rules |
| `candidate.ts` | Runs a branch as a second Harmonia (own port, data copy and worktree) to try it before it's merged |
| `updates.ts` | Over-the-air updates: check for a release (or commits), get it in the background, swap in when idle |
| `tool-catalog.ts` | The tools a teammate can ask for (`request_tool`) and their allowlist names |
| `team.ts` | The `Team` class: routing, the chat-session queue, chat turns, jobs, status updates, restarts, the turn limit |
| `lines.ts` | How messages are written for the teammates: a message as a line, the catch-up, reports cut for the channel, bubbles |
| `prompts.ts` | The chat and job system prompts from the rule templates, the team rules file, session titles, the job brief |
| `eta.ts` | Status-update timing: the wait before the next one, when to skip, the ETA a job gave and its overrun |
| `status-prompt.ts` | The text a job's status update is written from |
| `permission-mode.ts` | The permission mode a channel gets when it has no choice of its own |
| `tasks.ts` | Reading a ClickUp task from an id, a number or a link |
| `runner.ts` | Runs `claude -p --agent …` (and closes a run that stays open after its answer), plus the stub used by `bun run stub` |
| `sandbox.ts` | The macOS sandbox that keeps teammates out of protected folders |
| `projects.ts` | Your Claude projects (the folders your Claude Code sessions run in), for a channel's folder |
| `agents.ts` | Reads and writes agent files and agent memories |
| `store.ts` | Channels, jobs, messages and the chat sessions as JSON under `data/` |
| `attachments.ts` | Files on messages: where they're kept, their limits, uploads waiting for their message, the lines the teammates read |
| `slack.ts` | The Slack bridge: the app's manifest, the tokens in the Keychain, pairing, your DM and linked channels both ways, files both ways, the teammates' names and emoji (and their own Slack apps), threads, reactions, ⚠️ feedback, buttons on requests, typing messages, `new channel`, `status`, `archive` and `project` (a new channel's project list), a Slack channel for every channel here. The code outside the `SlackBridge` class is in `slack/` (manifests, tokens, text, commands, emoji, blocks, types) |
| `slack-socket.ts` | Slack Socket Mode and the Web API without the SDK: the WebSocket, acks, refreshes, rate limits |
| `public/` | The web UI (`app.js` chat and sessions, `agent-page.js` settings, `slack-page.js` Slack; `plan-usage.js`, `notifications.js`, `picture-viewer.js` and `feedback.js` are parts of the chat moved out of `app.js`) |
| `server.ts` | The HTTP and WebSocket API, and the static files |
| `setup.ts` | The Setup check (what's missing before the team can work) and the settings page's reading and saving of `settings.json` |
| `usage.ts` | The usage ledger: one line per Claude run in `usage.jsonl`, for the Usage page |
| `dates.ts` | Dates for chat lines, so a channel spanning days has a marker where each day starts |
| `voice.ts` | Voice messages to text (macOS on-device dictation) |
| `slack-marks.ts` | A channel's status and ClickUp task in its Slack channel's topic and bookmark |
| `public/index.html`, `public/markdown.js`, `public/style.css` | The page, the chat Markdown renderer and the styles |
| `public/setup-page.js`, `public/usage-page.js` | The Setup check and settings page, and the Usage page |
| `evals/` | `mozart-eval.ts` and `mozart-cases.json`: the routing test set for Mozart |
| `tests/`, `runner.test.ts`, `bunfig.toml` | The tests `bun test` runs (`tests/setup.ts` points them at a temp folder first) |
| `winapp/` | The Windows app shell: window, tray and installer, around `harmonia-server.exe` |
| `agents/` | The six starter teammates (see [agents/README.md](../agents/README.md)) |
| `CLAUDE.md` | The map of the code and the conventions, for working on Harmonia |
| `docs/brand/` | The logo, app icon, colours and usage rules (`make-brand.py` writes them) |
| `docs/screenshots/` | The README screenshots, their demo data and the script that takes them |

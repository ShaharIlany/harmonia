# Harmonia

Harmonia is a local group chat where six Claude Code "teammates" (Dali, Leo, Elliot, Sherlock, Murphy, Emily; `team.json`) answer in channels. It is a Bun/TypeScript server with a plain-JS web UI in `public/`, a Swift Mac shell in `macapp/` and a C# Windows shell in `winapp/`. There are no runtime dependencies. README.md is the user manual; this file is the map.

**Main flow.** A user message (`Team.userMessage`, `team.ts`) → Mozart (`mozart.ts`, `decide`) picks who answers, or only a reaction, or nobody → the teammate's chat session (`Team.start`, run by `runAgent` in `runner.ts`, one session per teammate, shared by all channels) → optionally a job (`startJob` / `runJob`: its own Claude Code session in the channel's folder, started through the `start_job` tool from `job-tools.ts`) → the job's report comes back to the chat session as an event.

## Modules
- `server.ts` HTTP + WebSocket API and static files; `main.ts` entry of the compiled binary (`--job-tools` runs `job-tools.ts`).
- `team.ts` the core. Sections, by banner: From the user (routing, `coordinate`) · Restarting for an update · Chat turns (`wake`, `next`, `start`, `afterReply`) · Jobs (`startJob`, `runJob`, `postJobStatus`). `chatPrompt` and `jobPrompt` build the prompts from the `*-rules.md` files.
- `mozart.ts` per-channel coordinator (Haiku, no tools) and the fallback rules when it fails. `roster.ts` loads `team.json`, @mention parsing.
- `runner.ts` runs `claude -p`, tool lists, usage, and the stub (`stubRun`). `job-tools.ts` the stdio MCP server for chat sessions. `tool-catalog.ts` tools a teammate can request.
- `store.ts` channels, messages, jobs and sessions as JSON in the data folder. `attachments.ts` files on messages. `projects.ts` Claude projects for a channel's folder.
- `agents.ts` reads and writes `~/.claude/agents/<id>.md` and `~/.claude/agent-memory/<id>/`.
- `paths.ts` data folder, `settings.json`, embedded-file detection. `env.ts` reads `HARMONIA_*` (or the old `TEAM_CHAT_*`).
- `slack.ts` the Slack bridge. Sections: Setup · Teammates as Slack members · DMs with a teammate · Slack → Harmonia · Reactions and ⚠️ feedback · Buttons and boxes · Commands · A channel's project · Harmonia's channels in Slack · Harmonia → Slack · Helpers · Tokens (Keychain). `slack-socket.ts` Socket Mode and the Web API, no SDK. `slack-marks.ts` status and task in a Slack channel's topic.
- `sandbox.ts` macOS sandbox profile. `voice.ts` voice notes to text. `updates.ts` over-the-air updates.
- `public/` the UI (`app.js`, `agent-page.js`, `slack-page.js`, `markdown.js`, `style.css`). `agents/` starter teammates. `docs/` brand and screenshots.

## Running
```powershell
bun server.ts          # real teammates, http://localhost:4747
bun run stub           # canned replies, no Claude runs, port 4748, data in ./data-stub
```
Real teammates need `~/.claude/agents/<id>.md` (copy `agents/*.md`) and the `claude` CLI signed in. In stub mode, the last line of a message triggers: `stub-slow`, `stub-react`, `stub-tools`, `stub-bubbles`, `stub-permission` (`stubRun`, `runner.ts`), a word `job` (starts a stub job) and `need a tool` (a tool request) (`team.ts`).

Env vars: `HARMONIA_STUB`, `HARMONIA_DATA`, `PORT` (4747), `HARMONIA_USER`, `HARMONIA_CWD`, `HARMONIA_STATUS_MINUTES` (job status interval, 5), `HARMONIA_LINGER_MINUTES`, `HARMONIA_SLACK_API`. In PowerShell, `HARMONIA_STUB=1 bun ...` does not work: set `$env:HARMONIA_STUB = "1"` first, or use `bun run stub`. If a `tests/` folder exists, `bun test` runs it.

## Conventions
- No runtime dependencies. Embed files with `import x from "./file" with { type: "file" }` and read them through the import, so the compiled binary carries them (`bun run build:windows`; `macapp/build.sh` on the Mac).
- Comments say why, in plain full sentences. User-facing strings are plain and specific.
- Commit subjects: `Area: what changed, in plain words` (`Slack: …`, `Jobs: …`, `Mozart: …`).
- README documents behaviour; update it in the same commit as the feature. Old `TEAM_CHAT_*` names still work (via `setting()` in `env.ts`); keep it so.

## Releases: can hurt
Every push to `main` is tagged as the next patch version (`tag.yml`) and released (`release.yml`), and installed apps update to it by themselves within 30 minutes. `[skip ci]` in the commit message prevents the tag and release. Never push to `main` to "try" something; use a branch. `windows.yml` builds and smoke-tests the Windows server on every PR.

## Data, and what not to touch
`paths.ts`: the data folder is `~/Library/Application Support/Harmonia` (Mac), `%APPDATA%\Harmonia` (Windows), `$XDG_DATA_HOME` or `~/.local/share/Harmonia` (Linux), `./data` when run from the repo, `HARMONIA_DATA` overrides. It holds `channels.json`, `team.json`, `slack.json`, `attachments/`, `mozart/` and `settings.json`. Keys in `settings.json`: `teamAgentsDir`, `defaultCwd`, `clickupWorkspace`, `clickupTaskPrefix`, `updateFrom`, `updateRepo`, `updateBranch`, `autoUpdate`, `voiceLanguages`, `protectedAllow`, `protectedGuard`.

In tests and experiments never write to the real `~/.claude` or the real data folder (set `HARMONIA_DATA` to a temp folder, and `HOME` too if `agents.ts` is involved), and never start a real `claude` run: use `HARMONIA_STUB=1`.

## Prompts are product
`chat-rules.md`, `job-rules.md`, `mozart-rules.md`, `feedback-rules.md` and `agents/*.md` are what the teammates read. A change there changes behaviour, costs tokens on every turn and breaks the prompt cache for chats; make it as short as the rule allows. Placeholders like `{{user}}` are filled in `team.ts` and `mozart.ts`.

## Platforms
Mac-only: the sandbox (`sandbox.ts`, `sandbox-exec`), Keychain tokens (elsewhere `slack.ts` writes a private file), voice notes (`macapp/transcribe.swift`), self-update (`updates.ts`) and the app shell (`macapp/`). Windows has `winapp/` (window, tray, installer) around `harmonia-server.exe`, with no sandbox, voice or self-update.

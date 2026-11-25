# Settings

Two places hold settings: `settings.json` in the data folder, and environment
variables. The **Setup check** link at the bottom of the sidebar opens a page
that shows most of the `settings.json` keys and edits them (see the
[Mac app](mac-app.md)). Changes to all but `protectedAllow` and `protectedGuard`
need a restart.

## settings.json

The data folder is `~/Library/Application Support/Harmonia` on a Mac,
`%APPDATA%\Harmonia` on Windows, `$XDG_DATA_HOME/Harmonia` (or
`~/.local/share/Harmonia`) on Linux, and `./data` when run from the repo;
`HARMONIA_DATA` overrides it.

| Key | Default | What it does |
|---|---|---|
| `teamAgentsDir` | `~/TeamAgents` | The Claude Code project that holds the six chat sessions. `TEAM_AGENTS_DIR` overrides it. |
| `defaultCwd` | your home folder | The working folder new channels start in. `HARMONIA_CWD` overrides it. |
| `clickupWorkspace` | none | Your ClickUp workspace id, so a task like `ABC-123` links to its page. `CLICKUP_WORKSPACE` overrides it. |
| `clickupTaskPrefix` | none | Your ClickUp custom task id prefix (`ABC` for `ABC-123`). Without it, task ids in messages aren't linked. `CLICKUP_TASK_PREFIX` overrides it. |
| `protectedAllow` | `[]` | Folders macOS protects that teammates may use anyway, like `["~/Downloads"]`. Mac only. Read on every turn, no restart. |
| `protectedGuard` | `true` | `false` turns the macOS sandbox off. Mac only. Read on every turn, no restart. |
| `permissionMode` | `bypass` where the sandbox is on (the Mac), else `acceptEdits` | What a channel with no Permissions choice of its own gets for its jobs: `bypass`, `acceptEdits` or `ask`. |
| `chatRotateTokens` | `60000` | A chat session that grows past this many tokens is replaced by a new one. |
| `chatRotateIdleTokens` | `30000` | The same, for a session that has been idle for an hour. |
| `autoUpdate` | `true` | `false` only shows updates, without installing them. |
| `updateFrom` | `release` | `source` follows a branch's commits instead of releases. |
| `updateBranch` | the branch the app was built from (`main`) | With `"updateFrom": "source"`, the branch to follow. |
| `updateRepo` | the repo the app was built from | The GitHub repo to update from, as `owner/name`. |
| `updateChannel` | `stable` | `beta` also takes betas (prereleases). |
| `voiceLanguages` | the Mac's preferred languages | The languages voice messages are heard in, like `["he-IL", "en-US"]`. |

`permissionMode`, `chatRotateTokens`, `chatRotateIdleTokens` and `updateChannel`
are not on the settings page: edit `settings.json` for them.

## Environment variables

`HARMONIA_STUB=1` (`bun run stub`) gives canned replies, with no Claude runs,
to try the UI. `HARMONIA_DATA` moves the data folder, `PORT` the port,
`HARMONIA_CWD` the default working folder for new channels, and `HARMONIA_USER`
the name the teammates call you (your login name by default), and
`HARMONIA_SLACK_API` points the Slack bridge at another Web API (a local fake,
to try it without Slack). The `TEAM_CHAT_*` names from before the rename still
work.

| Variable | Default | What it does |
|---|---|---|
| `HARMONIA_STUB` | off | `1` (`bun run stub`) gives canned replies, with no Claude runs, to try the UI. |
| `HARMONIA_DATA` | see above | Moves the data folder. |
| `PORT` | `4747` | The server's port. |
| `HARMONIA_CWD` | your home folder | The default working folder for new channels. |
| `HARMONIA_USER` | your login name | The name the teammates call you. |
| `HARMONIA_STATUS_MINUTES` | `5` | Scales the interval of job status updates. |
| `HARMONIA_LINGER_MINUTES` | `10` | How long a job stays open after its answer for background commands without a `timeout` of their own. |
| `HARMONIA_SLACK_API` | `https://slack.com/api` | Points the Slack bridge at another Web API (a local fake, to try it without Slack). |
| `HARMONIA_RELEASES_API` | `https://api.github.com` | Where `updates.ts` looks for releases. |
| `TEAM_AGENTS_DIR`, `CLICKUP_WORKSPACE`, `CLICKUP_TASK_PREFIX` | none | Override `teamAgentsDir`, `clickupWorkspace` and `clickupTaskPrefix`. |
| `HARMONIA_REPO`, `HARMONIA_BRANCH` | the Harmonia repo, `main` | For `install.sh`: the GitHub repo (`owner/name`) to install from, and the branch to follow from source. `macapp/build.sh` reads them too, for what updates follow. |
| `HARMONIA_FROM_SOURCE` | off | For `install.sh`: `1` clones and builds instead of downloading a release. |
| `HARMONIA_NO_OPEN` | off | For `install.sh`: `1` doesn't open the app afterwards. |
| `HARMONIA_DOWNLOADS` | the repo's GitHub releases | For `install.sh`: where releases are downloaded from (for testing). |
| `HARMONIA_VERSION` | none | For `macapp/build.sh`: a release's version, set by the release workflow. |
| `HARMONIA_URL`, `HARMONIA_TURN` | set by the server | Tell `job-tools.ts` where to call back and which turn it belongs to. Don't set them. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's own variable, read to find the projects folder. |

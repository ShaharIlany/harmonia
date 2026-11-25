# The Mac app

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
  The **Setup check** link at the bottom of the sidebar lists what Harmonia
  still needs (Claude Code signed in, the agent files, the folders) and edits
  these settings; it opens by itself when something is missing. Changes to
  all but `protectedAllow` and `protectedGuard` need a restart.
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
  repo's latest full release, or on the beta channel the newest one including
  betas (`updates.ts`; the repo is in `build.json`, written by
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
  `settings.json`: `updateRepo` (`owner/name`), `"updateChannel": "beta"`,
  `autoUpdate: false` to only
  show updates, and `"updateFrom": "source"` to follow a branch's commits
  instead (`updateBranch`): the app then fetches them into its own clone
  (`source/` in the data folder) and builds them there with `build.sh`, which
  needs git, bun and Xcode's command line tools. Log: `update.log` in the data
  folder.
- **After a code change:** run `build.sh --install` again and reopen the app,
  or tag a release and let the app update itself. The old build goes to the
  Trash. (A build from source updates itself to the next release, unless
  `updateFrom` is `source`.)

## Coming from Team Chat

Team Chat updates itself to Harmonia like to any other release, and running
the install script does the same. The app moves to `Harmonia.app`, its data
folder to `~/Library/Application Support/Harmonia` (the old folder's name
stays behind as a link to it), and Mozart's sessions, your pinned and muted
channels and the window's place come along.
Two things to do by hand: allow notifications again when macOS asks (they're
per app, and the app's id changed), and put Harmonia back in the Dock if
Team Chat was kept there.

## Coming from the Microsoft Teams bridge

The Teams bridge is gone: a Slack bridge took its place (see [Slack](slack.md)).
The Teams bots stop answering when you update. The channels they made here
(`#teams-<id>` and the linked ones) stay as ordinary channels with their
messages. What's left to clean up, if you like: delete the bots' apps in the
Teams Developer Portal, the `Harmonia Teams bot` items in your Keychain, and
`teams.json` and `teams-links.json` in the data folder (nothing reads them).

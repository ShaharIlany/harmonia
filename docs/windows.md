# Windows

The server also builds for Windows (x64), without the Mac app shell: run
`harmonia-server.exe` and open http://localhost:4747 in your browser. Each
release has it as `Harmonia-windows-x64.zip`. On start it adds any missing starter
teammate to `%USERPROFILE%\.claude\agents` (never overwriting yours). To build it
yourself, from any OS:

```bash
bun run build:windows   # build/windows/harmonia-server.exe
```

It needs the `claude` CLI on your PATH, signed in. Data lives in
`%APPDATA%\Harmonia` (`HARMONIA_DATA` overrides it). What's Mac-only stays
off: the sandbox around protected folders (`sandbox-exec`), voice-message
transcription, the Keychain (Slack tokens go to a private file instead, as on
Linux). The bare server doesn't update itself; the installed app (below) does. Opening files,
folders, links and the Claude app goes through Explorer and the default
handlers; the sign-in opens a console window on `claude auth login`. With no
sandbox, jobs ask before running commands by default (see Permissions in [How it behaves](behaviour.md)): pick
"Run everything without asking" in a channel's menu to turn that off.

## The Windows app

`Harmonia-Setup-x64.exe` (also on each release) installs Harmonia with its own
window (Edge WebView2) into `%LOCALAPPDATA%\Programs\Harmonia`. Like the Mac
app it updates itself: every 30 minutes it looks for a newer release, downloads
`Harmonia-windows-x64.zip` in the background, checks its SHA-256, and swaps the
files in at a quiet moment (or right away with "Restart to update"); the window
reopens on the new build. The settings are the Mac's (`autoUpdate`,
`updateRepo` in `settings.json`); `updateFrom: "source"` is Mac-only. To build
the app and installer yourself: `winapp\build.ps1`, then
`ISCC winapp\installer.iss`.

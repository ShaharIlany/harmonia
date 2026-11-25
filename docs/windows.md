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
Linux) and updating itself (download the next release by hand). Opening files,
folders, links and the Claude app goes through Explorer and the default
handlers; the sign-in opens a console window on `claude auth login`. With no
sandbox, jobs ask before running commands by default (see Permissions in [How it behaves](behaviour.md)): pick
"Run everything without asking" in a channel's menu to turn that off.

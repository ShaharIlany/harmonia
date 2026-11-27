# Starter teammates

`install.sh` copies these into `~/.claude/agents/` (it never overwrites a file
that's already there). Each one is a Claude Code subagent: `claude --agent leo`
works on its own too.

| File | Teammate | Model |
|---|---|---|
| `dali.md` | Dali, customer success: requirements, email drafts, updates, decks | Sonnet |
| `leo.md` | Leo, architecture: options, one recommendation, a build plan | Opus |
| `elliot.md` | Elliot, code: implements the plan, fixes review and QA findings | Sonnet |
| `sherlock.md` | Sherlock, code review: real bugs with evidence | Opus |
| `murphy.md` | Murphy, QA: tries to break it, with repro steps | Sonnet |
| `emily.md` | Emily, secretary: daily brief, minutes, follow-ups | Sonnet |

The ids (file names) match the roster in `team.json`; names, avatars and chat
models are edited in the app. Model, effort and instructions here are what
jobs use, and the teammate's settings page edits them. The model is the
default: starting a job, a teammate can pick Opus or Sonnet for that one job.

**Tools.** Each file has a `tools:` allowlist of Claude Code's built-in tools.
Connector tools (ClickUp, Microsoft 365, …) aren't listed: when a teammate
needs one, it asks in the chat (`request_tool`) and you approve it with a card,
which adds it to the file. Remove the `tools:` line to give a teammate every
tool you have.

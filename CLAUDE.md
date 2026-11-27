# Harmonia

How it works and what each file holds: [README.md](README.md).
Tests: `bun test`.

## Trying a change before it's merged

When the developer asks to try, test or run a pull request, a branch or their checkout ("let me try PR 12"), use
`candidate.ts`. Don't copy data, make worktrees or start `server.ts` by hand, and leave the installed app, its data and
the current checkout as they are. Trying a change doesn't include merging it, pushing or commenting on it.

1. Start it in the background: `bun candidate.ts pr 12` (a branch: `bun candidate.ts <branch>`; the checkout:
   `bun candidate.ts`). Add `--stub` if they want canned teammates and no Claude runs. If this checkout has no
   `candidate.ts`, update it from `main` first (ask before touching uncommitted work).
2. Check that the address it prints responds, and give them the link.
3. Read the change (`gh pr view 12`, `gh pr diff 12`) and give them a few short steps that try what's new.
4. Remind them that, without `--stub`, the teammates are real: they use their Claude plan and can change files in a
   channel's folder. The agent files and memories are shared with the installed app.
5. When they're done: `bun candidate.ts stop pr 12`, then `bun candidate.ts changes pr 12`. If anything changed, show
   it and ask before `restore`: it also undoes what their own Harmonia wrote there since the candidate started. Then
   `bun candidate.ts clean pr 12` (after any restore: `clean` deletes the snapshot).

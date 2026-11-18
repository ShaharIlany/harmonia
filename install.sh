#!/bin/bash
# Installs Team Chat on this Mac:
#   curl -fsSL https://raw.githubusercontent.com/ShaharIlany/team-chat/main/install.sh | bash
#
# It clones the repo into the app's own folder (the same clone its over-the-air updates use), builds the app there
# with macapp/build.sh, installs it in ~/Applications, adds the starter teammates to ~/.claude/agents (never
# overwriting yours), and opens it. Run it again to reinstall from the latest commit.
#
# Environment: TEAM_CHAT_REPO, TEAM_CHAT_BRANCH (what to install and follow), TEAM_CHAT_NO_OPEN=1 (don't open it).
set -euo pipefail

REPO="${TEAM_CHAT_REPO:-https://github.com/ShaharIlany/team-chat.git}"
BRANCH="${TEAM_CHAT_BRANCH:-main}"
SUPPORT="$HOME/Library/Application Support/Team Chat"
SRC="$SUPPORT/source"
APP="$HOME/Applications/Team Chat.app"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

step() { printf '\n\033[1m› %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "Team Chat is a Mac app."

step "Checking what's needed"
missing=()
xcode-select -p >/dev/null 2>&1 || missing+=("Xcode command line tools: xcode-select --install")
command -v git >/dev/null || missing+=("git: comes with the Xcode command line tools")
command -v bun >/dev/null || missing+=("Bun: curl -fsSL https://bun.sh/install | bash")
command -v uv >/dev/null || missing+=("uv (for the router's local model): curl -LsSf https://astral.sh/uv/install.sh | sh")
if [ ${#missing[@]} -gt 0 ]; then
  printf '  Missing:\n'
  printf '  - %s\n' "${missing[@]}"
  fail "Install those, open a new Terminal window, and run this again."
fi
if ! command -v claude >/dev/null; then
  echo "  Note: the Claude Code CLI isn't installed. The teammates run on it: https://claude.com/claude-code"
fi
echo "  ok"

step "Getting the code ($BRANCH)"
mkdir -p "$SUPPORT"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" remote set-url origin "$REPO"
  git -C "$SRC" fetch --quiet origin "$BRANCH"
  git -C "$SRC" checkout --quiet --force --detach FETCH_HEAD
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$SRC"
fi
echo "  $(git -C "$SRC" log -1 --format='%h %s')"

step "Building the app (the first build downloads the router's model runtime, ~800 MB)"
export TEAM_CHAT_REPO="$REPO" TEAM_CHAT_BRANCH="$BRANCH"
(cd "$SRC" && bash macapp/build.sh)

if pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null; then
  step "Quitting the running Team Chat"
  osascript -e 'quit app id "local.teamchat.app"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null || break; sleep 1; done
  pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null && fail "Team Chat is still running (a teammate may be working). Quit it and run this again."
fi

step "Installing"
(cd "$SRC" && bash macapp/build.sh --install | tail -1)

step "Starter teammates"
mkdir -p "$HOME/.claude/agents"
for f in "$SRC"/agents/*.md; do
  [ "$(basename "$f")" = README.md ] && continue
  dest="$HOME/.claude/agents/$(basename "$f")"
  if [ -e "$dest" ]; then echo "  kept your $(basename "$f")"
  else cp "$f" "$dest" && echo "  added $(basename "$f")"; fi
done

step "Done"
echo "  Team Chat is in ~/Applications and updates itself from $BRANCH."
if [ -z "${TEAM_CHAT_NO_OPEN:-}" ]; then open "$APP"; fi

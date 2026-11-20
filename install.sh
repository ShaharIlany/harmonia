#!/bin/bash
# Installs Harmonia on this Mac:
#   curl -fsSL https://raw.githubusercontent.com/ShaharIlany/harmonia/main/install.sh | bash
#
# It downloads the latest release (built by .github/workflows/release.yml for every version tag), checks it, installs
# it in ~/Applications, adds the starter teammates to ~/.claude/agents (never overwriting yours), and opens it. The
# app then updates itself from new releases. Run it again to reinstall. Harmonia used to be called Team Chat: an
# install of Team Chat is replaced, and its data moves to Harmonia's folder.
#
# Environment: HARMONIA_REPO (owner/name on GitHub), HARMONIA_NO_OPEN=1 (don't open it),
# HARMONIA_FROM_SOURCE=1 (clone and build instead, and follow HARMONIA_BRANCH from source: needs git, bun and
# Xcode's command line tools). The TEAM_CHAT_ names from before the rename still work.
set -euo pipefail

REPO="${HARMONIA_REPO:-${TEAM_CHAT_REPO:-ShaharIlany/harmonia}}"
REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"
BRANCH="${HARMONIA_BRANCH:-${TEAM_CHAT_BRANCH:-main}}"
FROM_SOURCE="${HARMONIA_FROM_SOURCE:-${TEAM_CHAT_FROM_SOURCE:-}}"
NO_OPEN="${HARMONIA_NO_OPEN:-${TEAM_CHAT_NO_OPEN:-}}"
SUPPORT="$HOME/Library/Application Support/Harmonia"
APP="$HOME/Applications/Harmonia.app"
OLD_SUPPORT="$HOME/Library/Application Support/Team Chat"
OLD_APP="$HOME/Applications/Team Chat.app"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

step() { printf '\n\033[1m› %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "Harmonia is a Mac app."

# The app's settings on first install, and the starter teammates.
first_settings() {
  mkdir -p "$SUPPORT"
  [ -f "$SUPPORT/settings.json" ] && return
  printf '{\n  "teamAgentsDir": "%s",\n  "defaultCwd": "%s",\n  "clickupWorkspace": "",\n  "clickupTaskPrefix": ""%s\n}\n' \
    "$HOME/TeamAgents" "$HOME" "$1" > "$SUPPORT/settings.json"
  echo "  wrote $SUPPORT/settings.json"
}
starter_agents() {
  step "Starter teammates"
  mkdir -p "$HOME/.claude/agents"
  for f in "$1"/*.md; do
    [ "$(basename "$f")" = README.md ] && continue
    dest="$HOME/.claude/agents/$(basename "$f")"
    if [ -e "$dest" ]; then echo "  kept your $(basename "$f")"
    else cp "$f" "$dest" && echo "  added $(basename "$f")"; fi
  done
}
running() { pgrep -f "$APP/Contents/MacOS/Harmonia" >/dev/null || pgrep -f "$OLD_APP/Contents/MacOS/" >/dev/null; }
quit_running() {
  running || return 0
  step "Quitting the running app"
  osascript -e 'quit app id "local.harmonia.app"' >/dev/null 2>&1 || true
  osascript -e 'quit app id "local.teamchat.app"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || break; sleep 1; done
  running && fail "The app is still running (a teammate may be working). Quit it and run this again."
  return 0
}
# Team Chat's data folder moves to Harmonia's (the app does the same on first launch), and the old name stays as a
# link to it. Mozart's Claude Code sessions are filed under its folder: they're copied to the new one.
old_data() { [ -f "$OLD_SUPPORT/channels.json" ] && [ ! -L "$OLD_SUPPORT" ] && [ ! -f "$SUPPORT/channels.json" ]; }
move_old_data() {
  old_data || return 0
  # A Harmonia folder without channels yet (made by a run from the repo) goes to the Trash.
  if [ -e "$SUPPORT" ]; then mv "$SUPPORT" "$HOME/.Trash/Harmonia $(date +%Y%m%d-%H%M%S)"; fi
  mv "$OLD_SUPPORT" "$SUPPORT" && ln -s Harmonia "$OLD_SUPPORT"
  local projects="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" from to
  from="$projects/$(printf '%s' "$OLD_SUPPORT/mozart" | sed 's/[^a-zA-Z0-9]/-/g')"
  to="$projects/$(printf '%s' "$SUPPORT/mozart" | sed 's/[^a-zA-Z0-9]/-/g')"
  if [ -d "$from" ] && [ ! -e "$to" ]; then cp -R "$from" "$to"; fi
  echo "  moved Team Chat's data to $SUPPORT"
  return 0
}
# The old builds go to the Trash rather than being deleted: Harmonia's, and Team Chat's.
trash_old_apps() {
  local old
  for old in "$APP" "$OLD_APP"; do
    if [ -d "$old" ]; then mv "$old" "$HOME/.Trash/$(basename "$old" .app) $(date +%Y%m%d-%H%M%S).app"; fi
  done
  return 0
}
claude_note() {
  command -v claude >/dev/null || echo "  Note: the Claude Code CLI isn't installed. The teammates run on it: https://claude.com/claude-code"
}

# ---------- From source ----------
if [ -n "$FROM_SOURCE" ]; then
  # With Team Chat's data still to move, clone into its folder: the clone moves with it.
  SRC="$SUPPORT/source"
  old_data && SRC="$OLD_SUPPORT/source"
  step "Checking what's needed"
  missing=()
  xcode-select -p >/dev/null 2>&1 || missing+=("Xcode command line tools: xcode-select --install")
  command -v git >/dev/null || missing+=("git: comes with the Xcode command line tools")
  command -v bun >/dev/null || missing+=("Bun: curl -fsSL https://bun.sh/install | bash")
  if [ ${#missing[@]} -gt 0 ]; then
    printf '  Missing:\n'; printf '  - %s\n' "${missing[@]}"
    fail "Install those, open a new Terminal window, and run this again."
  fi
  claude_note
  echo "  ok"

  step "Getting the code ($BRANCH)"
  mkdir -p "$(dirname "$SRC")"
  URL="https://github.com/$REPO.git"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" remote set-url origin "$URL"
    git -C "$SRC" fetch --quiet origin "$BRANCH"
    git -C "$SRC" checkout --quiet --force --detach FETCH_HEAD
  else
    git clone --quiet --branch "$BRANCH" "$URL" "$SRC"
  fi
  echo "  $(git -C "$SRC" log -1 --format='%h %s')"

  step "Building the app"
  export HARMONIA_REPO="$URL" HARMONIA_BRANCH="$BRANCH"
  (cd "$SRC" && bash macapp/build.sh)
  quit_running
  step "Installing"
  move_old_data
  SRC="$SUPPORT/source"
  first_settings $',\n  "updateFrom": "source"'
  (cd "$SRC" && bash macapp/build.sh --install | tail -1)
  starter_agents "$SRC/agents"
  step "Done"
  echo "  Harmonia is in ~/Applications and updates itself from $BRANCH."
  [ -z "$NO_OPEN" ] && open "$APP"
  exit 0
fi

# ---------- The latest release ----------
[ "$(uname -m)" = "arm64" ] || fail "Releases are for Apple Silicon Macs. On this Mac, build it: HARMONIA_FROM_SOURCE=1 (see the README)."
claude_note
DL="${HARMONIA_DOWNLOADS:-${TEAM_CHAT_DOWNLOADS:-https://github.com/$REPO/releases}}" # overridable for testing
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Downloads <url> to <file> and checks it against <url>.sha256.
fetch() {
  curl -fsSL "$1" -o "$2" || fail "Couldn't download $1"
  local expected actual
  expected="$(curl -fsSL "$1.sha256" | awk '{print $1}')" || fail "Couldn't download $1.sha256"
  actual="$(shasum -a 256 "$2" | awk '{print $1}')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "$(basename "$2") doesn't match its checksum."
}

step "Downloading the latest release"
fetch "$DL/latest/download/Harmonia-arm64.zip" "$TMP/app.zip"
ditto -x -k "$TMP/app.zip" "$TMP"
NEW="$TMP/Harmonia.app"
BUILD="$NEW/Contents/Resources/build.json"
VERSION="$(plutil -extract version raw -o - "$BUILD")"
echo "  version $VERSION"

xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
codesign --force --deep --sign - "$NEW" >/dev/null 2>&1

quit_running
step "Installing"
move_old_data
first_settings ""
mkdir -p "$HOME/Applications"
trash_old_apps
cp -cR "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"
echo "  $APP"
starter_agents "$APP/Contents/Resources/starter-agents"

step "Done"
echo "  Harmonia $VERSION is in ~/Applications and updates itself from new releases."
[ -z "$NO_OPEN" ] && open "$APP"
exit 0

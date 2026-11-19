#!/bin/bash
# Installs Team Chat on this Mac:
#   curl -fsSL https://raw.githubusercontent.com/ShaharIlany/team-chat/main/install.sh | bash
#
# It downloads the latest release (built by .github/workflows/release.yml for every version tag), checks it, installs
# it in ~/Applications, adds the starter teammates to ~/.claude/agents (never overwriting yours), and opens it. The
# app then updates itself from new releases. Run it again to reinstall.
#
# Environment: TEAM_CHAT_REPO (owner/name on GitHub), TEAM_CHAT_NO_OPEN=1 (don't open it),
# TEAM_CHAT_FROM_SOURCE=1 (clone and build instead, and follow TEAM_CHAT_BRANCH from source: needs git, bun, uv and
# Xcode's command line tools).
set -euo pipefail

REPO="${TEAM_CHAT_REPO:-ShaharIlany/team-chat}"
REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"
BRANCH="${TEAM_CHAT_BRANCH:-main}"
SUPPORT="$HOME/Library/Application Support/Team Chat"
APP="$HOME/Applications/Team Chat.app"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

step() { printf '\n\033[1m› %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "Team Chat is a Mac app."

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
quit_running() {
  pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null || return 0
  step "Quitting the running Team Chat"
  osascript -e 'quit app id "local.teamchat.app"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null || break; sleep 1; done
  pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null && fail "Team Chat is still running (a teammate may be working). Quit it and run this again."
  return 0
}
claude_note() {
  command -v claude >/dev/null || echo "  Note: the Claude Code CLI isn't installed. The teammates run on it: https://claude.com/claude-code"
}

# ---------- From source ----------
if [ -n "${TEAM_CHAT_FROM_SOURCE:-}" ]; then
  SRC="$SUPPORT/source"
  step "Checking what's needed"
  missing=()
  xcode-select -p >/dev/null 2>&1 || missing+=("Xcode command line tools: xcode-select --install")
  command -v git >/dev/null || missing+=("git: comes with the Xcode command line tools")
  command -v bun >/dev/null || missing+=("Bun: curl -fsSL https://bun.sh/install | bash")
  command -v uv >/dev/null || missing+=("uv (for the router's local model): curl -LsSf https://astral.sh/uv/install.sh | sh")
  if [ ${#missing[@]} -gt 0 ]; then
    printf '  Missing:\n'; printf '  - %s\n' "${missing[@]}"
    fail "Install those, open a new Terminal window, and run this again."
  fi
  claude_note
  echo "  ok"

  step "Getting the code ($BRANCH)"
  mkdir -p "$SUPPORT"
  URL="https://github.com/$REPO.git"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" remote set-url origin "$URL"
    git -C "$SRC" fetch --quiet origin "$BRANCH"
    git -C "$SRC" checkout --quiet --force --detach FETCH_HEAD
  else
    git clone --quiet --branch "$BRANCH" "$URL" "$SRC"
  fi
  echo "  $(git -C "$SRC" log -1 --format='%h %s')"

  step "Building the app (the first build downloads the router's model runtime, ~800 MB)"
  export TEAM_CHAT_REPO="$URL" TEAM_CHAT_BRANCH="$BRANCH"
  (cd "$SRC" && bash macapp/build.sh)
  quit_running
  step "Installing"
  first_settings $',\n  "updateFrom": "source"'
  (cd "$SRC" && bash macapp/build.sh --install | tail -1)
  starter_agents "$SRC/agents"
  step "Done"
  echo "  Team Chat is in ~/Applications and updates itself from $BRANCH."
  [ -z "${TEAM_CHAT_NO_OPEN:-}" ] && open "$APP"
  exit 0
fi

# ---------- The latest release ----------
[ "$(uname -m)" = "arm64" ] || fail "Releases are for Apple Silicon Macs. On this Mac, build it: TEAM_CHAT_FROM_SOURCE=1 (see the README)."
claude_note
DL="${TEAM_CHAT_DOWNLOADS:-https://github.com/$REPO/releases}" # overridable for testing
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
fetch "$DL/latest/download/Team-Chat-arm64.zip" "$TMP/app.zip"
ditto -x -k "$TMP/app.zip" "$TMP"
NEW="$TMP/Team Chat.app"
BUILD="$NEW/Contents/Resources/build.json"
VERSION="$(plutil -extract version raw -o - "$BUILD")"
STAMP="$(plutil -extract laya raw -o - "$BUILD")"
echo "  version $VERSION"

# Laya's Python isn't in the zip: reuse the installed app's when it's the one this release needs, else download it.
LAYA="$NEW/Contents/Resources/laya"
if [ "$(cat "$APP/Contents/Resources/laya/version" 2>/dev/null)" = "$STAMP" ]; then
  step "The router's runtime: reusing the installed one ($STAMP)"
  for part in python site-packages version; do cp -cR "$APP/Contents/Resources/laya/$part" "$LAYA/$part" 2>/dev/null || ditto "$APP/Contents/Resources/laya/$part" "$LAYA/$part"; done
else
  TAG="laya-${STAMP/\//-py}"
  step "Downloading the router's runtime ($STAMP, ~300 MB)"
  fetch "$DL/download/$TAG/$TAG-arm64.tar.gz" "$TMP/laya.tar.gz"
  tar -xzf "$TMP/laya.tar.gz" -C "$LAYA"
fi
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
codesign --force --deep --sign - "$NEW" >/dev/null 2>&1

quit_running
step "Installing"
first_settings ""
mkdir -p "$HOME/Applications"
if [ -d "$APP" ]; then
  # Keep the old build in the Trash rather than deleting it.
  mv "$APP" "$HOME/.Trash/Team Chat $(date +%Y%m%d-%H%M%S).app"
fi
cp -cR "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"
echo "  $APP"
starter_agents "$APP/Contents/Resources/starter-agents"

step "Done"
echo "  Team Chat $VERSION is in ~/Applications and updates itself from new releases."
[ -z "${TEAM_CHAT_NO_OPEN:-}" ] && open "$APP"
exit 0

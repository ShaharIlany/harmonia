#!/bin/bash
# Builds "Team Chat.app" into team-chat/build/. With --install it also copies it to ~/Applications and,
# on the first install, sets up ~/Library/Application Support/Team Chat from the repo's data.
#
# Environment: TEAM_CHAT_VERSION (a release's version, set by the release workflow), TEAM_CHAT_WITHOUT_LAYA=1 (leave
# Laya's Python out: releases ship it as its own download), TEAM_CHAT_REPO / TEAM_CHAT_BRANCH (what updates follow).
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Team Chat.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
LAYA_STAMP="$(bash macapp/laya.sh --stamp)"

# What this build is, for over-the-air updates (updates.ts): its version (releases) or commit, the repo and branch
# to follow, and the Laya runtime it needs.
if git rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git rev-parse HEAD)"
  BRANCH="${TEAM_CHAT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  REPO="${TEAM_CHAT_REPO:-$(git remote get-url origin 2>/dev/null || true)}"
  DIRTY=$([ -n "$(git status --porcelain)" ] && echo true || echo false)
  printf '{"version":"%s","commit":"%s","branch":"%s","repo":"%s","dirty":%s,"laya":"%s","arch":"%s","builtAt":"%s"}\n' \
    "${TEAM_CHAT_VERSION:-}" "$COMMIT" "$BRANCH" "$REPO" "$DIRTY" "$LAYA_STAMP" "$(uname -m)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$APP/Contents/Resources/build.json"
fi

echo "› server"
bun build --compile main.ts --outfile "$APP/Contents/Resources/team-chat-server" >/dev/null

echo "› app shell"
xcrun swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/Team Chat" macapp/main.swift \
  -framework Cocoa -framework WebKit -framework UserNotifications
cp macapp/Info.plist "$APP/Contents/Info.plist"

# The icon is drawn by make-icon.swift (docs/brand/app-icon.svg is the same drawing) and rebuilt when that script changes.
ICON_STAMP="$(shasum macapp/make-icon.swift | cut -d' ' -f1)"
if [ ! -f build/AppIcon.icns ] || [ "$(cat build/AppIcon.stamp 2>/dev/null)" != "$ICON_STAMP" ]; then
  echo "› icon"
  swift macapp/make-icon.swift build/icon-1024.png >/dev/null
  swift macapp/make-icon.swift build/icon-small.png --small >/dev/null
  rm -rf build/AppIcon.iconset && mkdir -p build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    # 16 and 32 px (and their @2x) use the small cut: bigger dots on a fuller tile.
    SRC=build/icon-1024.png; [ $s -le 32 ] && SRC=build/icon-small.png
    sips -z $s $s "$SRC" --out "build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$SRC" --out "build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
  echo "$ICON_STAMP" > build/AppIcon.stamp
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# The router's local model (Laya): its Python runtime (macapp/laya.sh), and the script that drives it.
if [ -z "${TEAM_CHAT_WITHOUT_LAYA:-}" ]; then
  bash macapp/laya.sh
  cp -cR build/laya "$APP/Contents/Resources/laya" 2>/dev/null || ditto build/laya "$APP/Contents/Resources/laya"
fi
mkdir -p "$APP/Contents/Resources/laya"
cp laya-router.py "$APP/Contents/Resources/laya/laya-router.py"

# The starter teammates, for install.sh when it installs a release (there's no clone of the repo then).
mkdir -p "$APP/Contents/Resources/starter-agents"
cp agents/*.md "$APP/Contents/Resources/starter-agents/"

echo "› sign (ad hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Built $(pwd)/$APP"

[ "${1:-}" = "--install" ] || exit 0

SUPPORT="$HOME/Library/Application Support/Team Chat"
mkdir -p "$SUPPORT"
if [ ! -f "$SUPPORT/settings.json" ]; then
  printf '{\n  "teamAgentsDir": "%s",\n  "defaultCwd": "%s",\n  "clickupWorkspace": "",\n  "clickupTaskPrefix": ""\n}\n' "$HOME/TeamAgents" "$HOME" > "$SUPPORT/settings.json"
  echo "› wrote $SUPPORT/settings.json"
fi
if [ ! -f "$SUPPORT/channels.json" ] && [ -f data/channels.json ]; then
  # First install: carry over the channels, messages and chat sessions from the repo's data folder.
  ditto data "$SUPPORT"
  [ -f "$SUPPORT/team.json" ] || cp team.json "$SUPPORT/team.json"
  echo "› copied data/ to $SUPPORT"
fi

DEST="$HOME/Applications/Team Chat.app"
mkdir -p "$HOME/Applications"
if [ -d "$DEST" ]; then
  # Keep the old build in the Trash rather than deleting it.
  mv "$DEST" "$HOME/.Trash/Team Chat $(date +%Y%m%d-%H%M%S).app"
fi
cp -cR "$APP" "$DEST" 2>/dev/null || ditto "$APP" "$DEST"
echo "Installed $DEST"

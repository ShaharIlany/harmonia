#!/bin/bash
# Builds "Harmonia.app" into build/. With --install it also copies it to ~/Applications and, on the first install,
# sets up ~/Library/Application Support/Harmonia from the repo's data.
#
# --legacy also leaves "build/Team Chat.app": the same app under the name it had before the rename, with a copy of its
# executable called "Team Chat". Team Chat's updater looks for exactly that, so installs from before the rename can
# update to Harmonia; the app moves itself to Harmonia.app the first time it opens. Team Chat's updater, building from
# source, passes TEAM_CHAT_REPO, which turns it on as well.
#
# Environment: HARMONIA_VERSION (a release's version, set by the release workflow), HARMONIA_REPO / HARMONIA_BRANCH
# (what updates follow). The TEAM_CHAT_ names from before the rename still work.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Harmonia.app"
INSTALL="" LEGACY=""
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --legacy) LEGACY=1 ;;
  esac
done
[ -n "${TEAM_CHAT_REPO:-}" ] && [ -z "${HARMONIA_REPO:-}" ] && LEGACY=1
VERSION="${HARMONIA_VERSION:-${TEAM_CHAT_VERSION:-}}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# What this build is, for over-the-air updates (updates.ts): its version (releases) or commit, the repo and branch
# to follow.
if git rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git rev-parse HEAD)"
  BRANCH="${HARMONIA_BRANCH:-${TEAM_CHAT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}}"
  REPO="${HARMONIA_REPO:-${TEAM_CHAT_REPO:-$(git remote get-url origin 2>/dev/null || true)}}"
  DIRTY=$([ -n "$(git status --porcelain)" ] && echo true || echo false)
  printf '{"version":"%s","commit":"%s","branch":"%s","repo":"%s","dirty":%s,"arch":"%s","builtAt":"%s"}\n' \
    "$VERSION" "$COMMIT" "$BRANCH" "$REPO" "$DIRTY" "$(uname -m)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$APP/Contents/Resources/build.json"
fi

echo "› server"
bun build --compile main.ts --outfile "$APP/Contents/Resources/harmonia-server" >/dev/null

echo "› app shell"
xcrun swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/Harmonia" macapp/main.swift \
  -framework Cocoa -framework WebKit -framework UserNotifications
cp macapp/Info.plist "$APP/Contents/Info.plist"

# Voice messages from Slack (voice.ts): macOS's on-device dictation, which needs the macOS 26 SDK (Xcode 26) to build.
# Without it the app still builds, and a voice note reaches the teammates as an audio file they can't listen to.
echo "› transcriber"
if ! xcrun swiftc -O -swift-version 5 -o "$APP/Contents/Resources/harmonia-transcribe" macapp/transcribe.swift \
  -framework Speech -framework AVFoundation 2>build/transcribe.log; then
  echo "  ! no transcriber: this Xcode has no macOS 26 SDK (see build/transcribe.log). Voice messages stay audio files."
fi

# What the About panel shows: "Version <CFBundleShortVersionString> (<CFBundleVersion>)". A release gets its version
# and commit, "2.1.3 (1a2b3c4)"; a build from source the newest version tag it's built on, with how many commits it's
# past that, "2.1.3+4 (1a2b3c4-dirty)". Info.plist's own 1.0 is only for a build outside a git checkout.
if [ -n "${COMMIT:-}" ]; then
  SHORT="$VERSION"
  if [ -z "$SHORT" ]; then
    TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
    if [ -n "$TAG" ]; then
      SHORT="${TAG#v}"
      AHEAD="$(git rev-list --count "$TAG..HEAD")"
      [ "$AHEAD" -gt 0 ] && SHORT="$SHORT+$AHEAD"
    else
      SHORT="0.0.0"
    fi
  fi
  BUNDLE="${COMMIT:0:7}"
  [ "$DIRTY" = true ] && BUNDLE="$BUNDLE-dirty"
  plutil -replace CFBundleShortVersionString -string "$SHORT" "$APP/Contents/Info.plist"
  plutil -replace CFBundleVersion -string "$BUNDLE" "$APP/Contents/Info.plist"
fi

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


# The starter teammates, for install.sh when it installs a release (there's no clone of the repo then).
mkdir -p "$APP/Contents/Resources/starter-agents"
cp agents/*.md "$APP/Contents/Resources/starter-agents/"

echo "› sign (ad hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Built $(pwd)/$APP"

if [ -n "$LEGACY" ]; then
  OLD="build/Team Chat.app"
  rm -rf "$OLD"
  cp -cR "$APP" "$OLD" 2>/dev/null || ditto "$APP" "$OLD"
  cp "$OLD/Contents/MacOS/Harmonia" "$OLD/Contents/MacOS/Team Chat"
  codesign --force --deep --sign - "$OLD" >/dev/null 2>&1
  echo "Built $(pwd)/$OLD (the same app, for Team Chat's updater)"
fi

[ -n "$INSTALL" ] || exit 0

SUPPORT="$HOME/Library/Application Support/Harmonia"
# Before the rename the data folder was "Team Chat". Move it (the app does the same on first launch, but the
# settings below would make the new folder first). Mozart's Claude Code sessions are filed under its folder: copy them.
OLD_SUPPORT="$HOME/Library/Application Support/Team Chat"
if [ -f "$OLD_SUPPORT/channels.json" ] && [ ! -L "$OLD_SUPPORT" ] && [ ! -f "$SUPPORT/channels.json" ]; then
  pgrep -qf "/Contents/MacOS/Team Chat" && { echo "Quit Team Chat first: its data folder moves to $SUPPORT."; exit 1; }
  # A Harmonia folder without channels yet (made by a run from the repo) goes to the Trash.
  if [ -e "$SUPPORT" ]; then mv "$SUPPORT" "$HOME/.Trash/Harmonia $(date +%Y%m%d-%H%M%S)"; fi
  mv "$OLD_SUPPORT" "$SUPPORT" && ln -s Harmonia "$OLD_SUPPORT"
  PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
  FROM="$PROJECTS/$(printf '%s' "$OLD_SUPPORT/mozart" | sed 's/[^a-zA-Z0-9]/-/g')"
  TO="$PROJECTS/$(printf '%s' "$SUPPORT/mozart" | sed 's/[^a-zA-Z0-9]/-/g')"
  if [ -d "$FROM" ] && [ ! -e "$TO" ]; then cp -R "$FROM" "$TO"; fi
  echo "› moved $OLD_SUPPORT to $SUPPORT"
fi
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

DEST="$HOME/Applications/Harmonia.app"
mkdir -p "$HOME/Applications"
# Keep the old build in the Trash rather than deleting it; Team Chat too, the app's name before the rename.
for old in "$DEST" "$HOME/Applications/Team Chat.app"; do
  [ -d "$old" ] && mv "$old" "$HOME/.Trash/$(basename "$old" .app) $(date +%Y%m%d-%H%M%S).app"
done
cp -cR "$APP" "$DEST" 2>/dev/null || ditto "$APP" "$DEST"
echo "Installed $DEST"

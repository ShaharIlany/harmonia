#!/bin/bash
# Builds "Team Chat.app" into team-chat/build/. With --install it also copies it to ~/Applications and,
# on the first install, sets up ~/Library/Application Support/Team Chat from the repo's data.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Team Chat.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# What this build is, for over-the-air updates (updates.ts): the commit, and the repo and branch to follow.
if git rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git rev-parse HEAD)"
  BRANCH="${TEAM_CHAT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  REPO="${TEAM_CHAT_REPO:-$(git remote get-url origin 2>/dev/null || true)}"
  DIRTY=$([ -n "$(git status --porcelain)" ] && echo true || echo false)
  printf '{"commit":"%s","branch":"%s","repo":"%s","dirty":%s,"builtAt":"%s"}\n' \
    "$COMMIT" "$BRANCH" "$REPO" "$DIRTY" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP/Contents/Resources/build.json"
else
  rm -f "$APP/Contents/Resources/build.json"
fi
cp macapp/update.sh "$APP/Contents/Resources/update.sh"

echo "› server"
bun build --compile main.ts --outfile "$APP/Contents/Resources/team-chat-server" >/dev/null

echo "› app shell"
xcrun swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/Team Chat" macapp/main.swift \
  -framework Cocoa -framework WebKit -framework UserNotifications
cp macapp/Info.plist "$APP/Contents/Info.plist"

if [ ! -f build/AppIcon.icns ]; then
  echo "› icon"
  swift macapp/make-icon.swift build/icon-1024.png >/dev/null
  mkdir -p build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon-1024.png --out "build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) build/icon-1024.png --out "build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# The router's local model (Laya) runs on a Python that ships inside the app: a relocatable uv-managed CPython plus
# laya's packages. Built once into build/laya (the dev server uses the same copy) and rebuilt when LAYA_VERSION changes.
LAYA_VERSION=0.4.35
LAYA_PY=3.14
# An update builds in a fresh clone: it borrows the installed app's copy when the version matches.
LAYA_SEED="${TEAM_CHAT_LAYA_SEED:-$HOME/Applications/Team Chat.app/Contents/Resources/laya}"
if [ "$(cat build/laya/version 2>/dev/null)" != "$LAYA_VERSION/$LAYA_PY" ] && [ "$(cat "$LAYA_SEED/version" 2>/dev/null)" = "$LAYA_VERSION/$LAYA_PY" ]; then
  echo "› laya from $LAYA_SEED"
  rm -rf build/laya
  cp -cR "$LAYA_SEED" build/laya 2>/dev/null || ditto "$LAYA_SEED" build/laya
  rm -f build/laya/laya-router.py
fi
if [ "$(cat build/laya/version 2>/dev/null)" != "$LAYA_VERSION/$LAYA_PY" ]; then
  echo "› laya $LAYA_VERSION (python $LAYA_PY)"
  [ -d build/laya ] && mv build/laya "$HOME/.Trash/team-chat-laya-$(date +%Y%m%d-%H%M%S)"
  mkdir -p build/laya
  uv python install "$LAYA_PY" >/dev/null 2>&1
  PY_HOME="$(cd "$(dirname "$(uv python find --managed-python "$LAYA_PY")")/.." && pwd -P)"
  ditto "$PY_HOME" build/laya/python
  uv pip install --quiet --python build/laya/python/bin/python3 --target build/laya/site-packages "laya==$LAYA_VERSION"
  echo "$LAYA_VERSION/$LAYA_PY" > build/laya/version
fi
rm -rf "$APP/Contents/Resources/laya"
cp -cR build/laya "$APP/Contents/Resources/laya" 2>/dev/null || ditto build/laya "$APP/Contents/Resources/laya"
cp laya-router.py "$APP/Contents/Resources/laya/laya-router.py"

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

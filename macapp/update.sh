#!/bin/bash
# Swaps in a new Team Chat build. The server starts this detached (updates.ts) and then gets quit by it, so it
# keeps running on its own: quit the app, move the old build to the Trash, put the new one in its place, open it.
# If the new build doesn't come up within a minute, the old one goes back.
#   update.sh <new Team Chat.app> <installed Team Chat.app> <server pid>
set -u
NEW="$1"
APP="$2"
SERVER_PID="$3"
PORT=4747
say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update.sh: $*"; }

[ -x "$NEW/Contents/MacOS/Team Chat" ] || { say "no new build at $NEW"; exit 1; }

say "quitting Team Chat"
osascript -e 'quit app id "local.teamchat.app"' >/dev/null 2>&1
for _ in $(seq 1 60); do
  kill -0 "$SERVER_PID" 2>/dev/null || pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null || break
  sleep 1
done
if kill -0 "$SERVER_PID" 2>/dev/null || pgrep -f "$APP/Contents/MacOS/Team Chat" >/dev/null; then
  say "Team Chat didn't quit; leaving it as it is"
  exit 1
fi

OLD="$HOME/.Trash/Team Chat $(date +%Y%m%d-%H%M%S).app"
mv "$APP" "$OLD" || { say "couldn't move $APP aside"; open "$APP"; exit 1; }
# A clone on APFS (instant, no extra space for Laya's ~800 MB); a copy elsewhere.
cp -cR "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"
say "installed $(plutil -extract commit raw "$APP/Contents/Resources/build.json" 2>/dev/null | cut -c1-7)"
open "$APP"

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/state" && { say "Team Chat is back"; exit 0; }
  sleep 1
done

say "the new build didn't start; putting the old one back"
osascript -e 'quit app id "local.teamchat.app"' >/dev/null 2>&1
sleep 3
pkill -f "$APP/Contents/MacOS/Team Chat" 2>/dev/null
mv "$APP" "$HOME/.Trash/Team Chat failed $(date +%Y%m%d-%H%M%S).app" && mv "$OLD" "$APP"
open "$APP"

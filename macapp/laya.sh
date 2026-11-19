#!/bin/bash
# The router's local model (Laya) runs on a Python that ships inside the app: a relocatable uv-managed CPython plus
# laya's packages, in build/laya (the dev server uses the same copy). Rebuilt when LAYA_VERSION or LAYA_PY changes.
#
#   bash macapp/laya.sh           make sure build/laya is there (borrowing the installed app's copy when it matches)
#   bash macapp/laya.sh --stamp   print the version stamp ("0.4.35/3.14") and stop
#
# Releases publish it once per stamp as its own download (.github/workflows/release.yml), since it's ~800 MB and
# rarely changes. Apps that update from releases copy it from themselves, or download it when the stamp moves.
set -euo pipefail
cd "$(dirname "$0")/.."

LAYA_VERSION=0.4.35
LAYA_PY=3.14
STAMP="$LAYA_VERSION/$LAYA_PY"
[ "${1:-}" = "--stamp" ] && { echo "$STAMP"; exit 0; }

# An update builds in a fresh clone: it borrows the installed app's copy when the stamp matches.
SEED="${TEAM_CHAT_LAYA_SEED:-$HOME/Applications/Team Chat.app/Contents/Resources/laya}"
if [ "$(cat build/laya/version 2>/dev/null)" != "$STAMP" ] && [ "$(cat "$SEED/version" 2>/dev/null)" = "$STAMP" ]; then
  echo "› laya from $SEED"
  rm -rf build/laya
  mkdir -p build
  cp -cR "$SEED" build/laya 2>/dev/null || ditto "$SEED" build/laya
  rm -f build/laya/laya-router.py
fi
if [ "$(cat build/laya/version 2>/dev/null)" != "$STAMP" ]; then
  echo "› laya $LAYA_VERSION (python $LAYA_PY)"
  if [ -d build/laya ]; then
    if [ -d "$HOME/.Trash" ]; then mv build/laya "$HOME/.Trash/team-chat-laya-$(date +%Y%m%d-%H%M%S)"; else rm -rf build/laya; fi
  fi
  mkdir -p build/laya
  uv python install "$LAYA_PY" >/dev/null 2>&1
  PY_HOME="$(cd "$(dirname "$(uv python find --managed-python "$LAYA_PY")")/.." && pwd -P)"
  ditto "$PY_HOME" build/laya/python
  uv pip install --quiet --python build/laya/python/bin/python3 --target build/laya/site-packages "laya==$LAYA_VERSION"
  echo "$STAMP" > build/laya/version
fi

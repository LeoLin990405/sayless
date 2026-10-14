#!/bin/bash
# 构建 SaylessBar.app 并安装（默认 /Applications）
set -euo pipefail
cd "$(dirname "$0")"
node --check ../sayless.mjs
rm -rf SaylessBar.app
mkdir -p SaylessBar.app/Contents/MacOS
swiftc -O SaylessBar.swift -o SaylessBar.app/Contents/MacOS/SaylessBar 2>&1 | grep -E 'error' && { echo BUILD_FAILED; exit 1; } || true
cp Info.plist SaylessBar.app/Contents/
codesign --force -s - SaylessBar.app
DEST="${1:-/Applications/SaylessBar.app}"
rm -rf "$DEST"
cp -R SaylessBar.app "$DEST"
echo "built & installed: $DEST"
[ "$DEST" = "/Applications/SaylessBar.app" ] && open /Applications/SaylessBar.app

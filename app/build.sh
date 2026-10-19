#!/bin/bash
# 构建 SaylessBar.app 并安装（默认 /Applications）
set -euo pipefail
cd "$(dirname "$0")"
node --check ../sayless.mjs
rm -rf SaylessBar.app
mkdir -p SaylessBar.app/Contents/MacOS
swiftc -O SaylessBar.swift -o SaylessBar.app/Contents/MacOS/SaylessBar 2>&1 | grep -E 'error' && { echo BUILD_FAILED; exit 1; } || true
cp Info.plist SaylessBar.app/Contents/
mkdir -p SaylessBar.app/Contents/Resources
cp hub.html SaylessBar.app/Contents/Resources/
# 签名：优先用持久身份（Sayless Local Dev 证书，TCC 授权跨重装保留），否则退回 ad-hoc（每次重装授权失效）
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Sayless Local Dev/{print $2; exit}')
if [ -n "${IDENTITY}" ]; then
  codesign --force -s "$IDENTITY" SaylessBar.app
  echo "signed with persistent identity: Sayless Local Dev"
else
  codesign --force -s - SaylessBar.app
  echo "signed ad-hoc (no persistent identity found — TCC grants will reset on reinstall)"
fi
DEST="${1:-/Applications/SaylessBar.app}"
rm -rf "$DEST"
cp -R SaylessBar.app "$DEST"
echo "built & installed: $DEST"
[ "$DEST" = "/Applications/SaylessBar.app" ] && open /Applications/SaylessBar.app

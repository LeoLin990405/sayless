#!/bin/bash
# 构建 SaylessBar.app（默认安装到 /Applications 并启动）
# BUILD_ONLY=1 ./build.sh  只打包，不安装/不启动（CI / 本地验证用）
set -euo pipefail
cd "$(dirname "$0")"

node --check ../sayless.mjs || { echo "sayless.mjs syntax FAILED"; exit 1; }
node --check ../asr-ark-ws.mjs || { echo "asr-ark-ws.mjs syntax FAILED"; exit 1; }

rm -rf SaylessBar.app
mkdir -p SaylessBar.app/Contents/MacOS SaylessBar.app/Contents/Resources

if ! swiftc -O SaylessBar.swift -o SaylessBar.app/Contents/MacOS/SaylessBar; then
  echo "BUILD_FAILED"
  exit 1
fi

cp Info.plist SaylessBar.app/Contents/
cp hub.html SaylessBar.app/Contents/Resources/
# App 自带 CLI，避免用户必须先手动 ln -sf 到 /opt/homebrew/bin
cp ../sayless.mjs ../asr-ark-ws.mjs SaylessBar.app/Contents/Resources/

# 签名：优先用持久身份（Sayless Local Dev 证书，TCC 授权跨重装保留），否则退回 ad-hoc（每次重装授权失效）
IDENTITY=""
if [ "${SAYLESS_SIGN:-auto}" != "adhoc" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Sayless Local Dev/{print $2; exit}')
fi
if [ -n "${IDENTITY}" ]; then
  codesign --force -s "$IDENTITY" SaylessBar.app
  echo "signed with persistent identity: Sayless Local Dev"
else
  codesign --force -s - SaylessBar.app
  echo "signed ad-hoc (no persistent identity found — TCC grants will reset on reinstall)"
fi

if [ "${BUILD_ONLY:-0}" = "1" ]; then
  echo "built (build-only): $(pwd)/SaylessBar.app"
  exit 0
fi

DEST="${1:-/Applications/SaylessBar.app}"
case "$DEST" in
  /*/SaylessBar.app) ;;
  *) echo "refusing to remove unsafe DEST: $DEST（必须以 /…/SaylessBar.app 结尾）"; exit 1 ;;
esac
rm -rf "$DEST"
cp -R SaylessBar.app "$DEST"
echo "built & installed: $DEST"
if [ "$DEST" = "/Applications/SaylessBar.app" ]; then
  open /Applications/SaylessBar.app
fi

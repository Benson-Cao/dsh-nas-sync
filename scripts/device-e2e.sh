#!/usr/bin/env bash
# 0.6.0 / 收尾⑤ · 真机 E2E 入口
# ------------------------------------------------------------------
# 这个脚本只负责「把设备准备好」：找到无线调试目标、把 DSH 拉到前台、
# 建立 webview_devtools_remote 的端口转发，然后交给 device-e2e.mjs 做 CDP 断言。
# 它不会安装 APK、不会改设备上的文件、不会删除任何东西。
#
# 用法：
#   ADB_TARGET=192.168.0.100:5555 bash scripts/device-e2e.sh
#   不传 ADB_TARGET 时取 `adb devices` 里第一个 device。
# 前置：设备已开启无线调试 / USB 调试，且 DSH 已安装并能正常启动。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${CDP_PORT:-9222}"

if ! command -v adb >/dev/null 2>&1; then
  echo "[device-e2e] 找不到 adb，请把 Android platform-tools 加进 PATH" >&2
  exit 2
fi

pick_target() {
  if [ -n "${ADB_TARGET:-}" ]; then echo "$ADB_TARGET"; return; fi
  adb devices | awk 'NR>1 && $2=="device" {print $1; exit}'
}

T="$(pick_target)"
if [ -z "$T" ]; then
  echo "[device-e2e] 没有可用设备。先 adb connect <ip>:<port>，或用 ADB_TARGET 指定。" >&2
  exit 2
fi
echo "[device-e2e] target=$T"

connect_if_needed() {
  if ! adb devices | awk 'NR>1 && $2=="device" {print $1}' | grep -Fxq "$T"; then
    echo "[device-e2e] 重新连接 $T"
    adb connect "$T" >/dev/null 2>&1 || true
  fi
}
connect_if_needed
adb -s "$T" get-state >/dev/null 2>&1 || { echo "[device-e2e] $T 不在线" >&2; exit 2; }

# DSH 在后台会被 Android 冻结，devtools socket 存在但不响应 /json/list。
# 必须拉到前台再等 WebView 完成首屏渲染。
echo "[device-e2e] 冷启动 DSH"
adb -s "$T" shell 'am force-stop com.dsh.harness' >/dev/null 2>&1 || true
sleep 2
adb -s "$T" shell 'am start -n com.dsh.harness/.MainActivity' >/dev/null 2>&1 || true
sleep 12

SOCK="$(adb -s "$T" shell "cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1" | tr -d '\r')"
if [ -z "$SOCK" ]; then
  echo "[device-e2e] 找不到 webview_devtools_remote_*（WebView 未起来或应用被冻结）" >&2
  exit 2
fi
echo "[device-e2e] socket=$SOCK"

adb -s "$T" forward --remove "tcp:$PORT" >/dev/null 2>&1 || true
adb -s "$T" forward "tcp:$PORT" "localabstract:$SOCK" >/dev/null
cleanup() { adb -s "$T" forward --remove "tcp:$PORT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cd "$ROOT"
CDP_PORT="$PORT" NO_PROXY='*' no_proxy='*' node scripts/device-e2e.mjs

#!/usr/bin/env bash
# 守护循环：bot.mjs 异常退出后 5 秒自动重启；退出码 1（配置缺失）或收到 TERM 时停止
cd "$(dirname "$0")"
# 如需指定 Node 版本，可设置 NODE_BIN 目录
[ -n "${NODE_BIN:-}" ] && export PATH="$NODE_BIN:$PATH"
child=""
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
while true; do
  node bot.mjs &
  child=$!
  wait "$child"; code=$?
  echo "$(date -Iseconds) bot.mjs exited with code $code" >> bot.out
  [ "$code" = "1" ] && exit 1
  sleep 5
done

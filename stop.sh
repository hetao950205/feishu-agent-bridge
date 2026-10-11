#!/usr/bin/env bash
# 只停止 bot.pid 记录的守护循环及其子进程（同一进程组），并先确认它确实是本目录的 run-loop.sh；不做大范围 kill
set -uo pipefail
cd "$(dirname "$0")"
[ -f bot.pid ] || { echo "no bot.pid"; exit 0; }
pid=$(cat bot.pid)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "run-loop.sh"; then
  kill -TERM "$pid"
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  # 兜底：只针对以该 pid 为组长的进程组（setsid 启动，组内只有 run-loop 和 bot.mjs）
  kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
  echo "stopped pid $pid"
else
  echo "pid $pid not running (or not run-loop.sh)"
fi
rm -f bot.pid

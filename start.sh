#!/usr/bin/env bash
# (重新)启动 bot：先用 stop.sh 停掉 bot.pid 记录的旧进程组，再在新会话中后台启动守护循环
set -euo pipefail
cd "$(dirname "$0")"
./stop.sh >/dev/null 2>&1 || true
setsid nohup bash ./run-loop.sh >> bot.out 2>&1 < /dev/null &
echo $! > bot.pid
echo "bot started, pid $(cat bot.pid)"

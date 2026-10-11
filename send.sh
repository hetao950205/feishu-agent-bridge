#!/usr/bin/env bash
# 用法:
#   send.sh <chatId|lark:chat:root> [文本文件|-]          # 发 Markdown 文本（默认 stdin）
#   send.sh <chatId> --file <本地路径> [显示文件名]       # 发文件附件
#   send.sh <chatId> --image <本地路径>                  # 发图片
# 环境变量: REPLY_TO=<om_消息ID>；FEISHU_BRIDGE_PORT 默认 8787
set -euo pipefail
target="${1:?usage: send.sh <chatId> [text-file|-] | --file <path> [name] | --image <path>}"
shift || true
key=chatId; [[ "$target" == lark:* ]] && key=threadId
port="${FEISHU_BRIDGE_PORT:-8787}"
reply_args=()
if [ -n "${REPLY_TO:-}" ]; then reply_args=(--arg r "$REPLY_TO"); else reply_args=(--arg r ""); fi

post_json() {
  curl -sS --fail-with-body -X POST "http://127.0.0.1:${port}/send" \
    -H 'content-type: application/json' --data-binary @-
  echo
}

if [ "${1:-}" = "--file" ]; then
  fpath="${2:?need file path}"
  fname="${3:-$(basename "$fpath")}"
  abs="$(cd "$(dirname "$fpath")" && pwd)/$(basename "$fpath")"
  jq -n --arg k "$key" --arg t "$target" --arg p "$abs" --arg n "$fname" --arg r "${REPLY_TO:-}" \
    '{($k): $t, filePath: $p, fileName: $n} + (if $r != "" then {replyTo: $r} else {} end)' | post_json
elif [ "${1:-}" = "--image" ]; then
  fpath="${2:?need image path}"
  abs="$(cd "$(dirname "$fpath")" && pwd)/$(basename "$fpath")"
  jq -n --arg k "$key" --arg t "$target" --arg p "$abs" --arg r "${REPLY_TO:-}" \
    '{($k): $t, imagePath: $p} + (if $r != "" then {replyTo: $r} else {} end)' | post_json
else
  src="${1:--}"
  if [ "$src" = "-" ]; then text="$(cat)"; else text="$(cat "$src")"; fi
  jq -n --arg k "$key" --arg t "$target" --arg text "$text" --arg r "${REPLY_TO:-}" \
    '{($k): $t, text: $text} + (if $r != "" then {replyTo: $r} else {} end)' | post_json
fi

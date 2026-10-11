// 飞书 / Lark ↔ AI 智能体桥接服务
// - WebSocket 长连接接收私聊 / 群里 @ 机器人的消息 → 追加到 inbox.jsonl，并可选 POST 到 FEISHU_WAKE_URL
// - 本机 HTTP 127.0.0.1:8787：POST /send 发文字/文件/图片，POST /download 下载收到的附件，GET /health 查看状态
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { LarkChannel } from "@larksuite/channel";
import { DIR, addSecret, localIso, makeLogger, readEnvFile } from "./lib.mjs";

const log = makeLogger("bot.log");

// .env 中的值作为默认，进程环境变量优先
const fileEnv = readEnvFile();
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const APP_ID = env("LARK_APP_ID");
const APP_SECRET = env("LARK_APP_SECRET");
addSecret(APP_SECRET);
addSecret(env("FEISHU_WAKE_KEY"));
if (!APP_ID || !APP_SECRET) {
  log.error("缺少 LARK_APP_ID / LARK_APP_SECRET（.env），请先运行 register.mjs");
  process.exit(1);
}

const PORT = Number(env("FEISHU_BRIDGE_PORT", "8787"));
const HOST = "127.0.0.1"; // 固定只监听本机
const INBOX = path.join(DIR, "inbox.jsonl");
const ACKED_FILE = path.join(DIR, "acked.json");

const allowlist = () =>
  (env("FEISHU_ALLOWED_OPEN_IDS", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const BOT_NAME = env("FEISHU_BOT_NAME", "AI Agent");
const PAIRING_ACK = env("FEISHU_PAIRING_ACK", `已收到，${BOT_NAME} 会尽快回复你。`);

function loadAcked() {
  try {
    return new Set(JSON.parse(fs.readFileSync(ACKED_FILE, "utf8")));
  } catch {
    return new Set();
  }
}
const acked = loadAcked();
function markAcked(id) {
  acked.add(id);
  fs.writeFileSync(ACKED_FILE, JSON.stringify([...acked]) + "\n");
}

const domain = env("LARK_DOMAIN") === "lark" ? "https://open.larksuite.com" : undefined;

const ALLOWED_FILE_DIRS = [
  DIR,
  "/tmp",
  ...(env("FEISHU_ALLOWED_FILE_DIRS", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

const channel = new LarkChannel({
  appId: APP_ID,
  appSecret: APP_SECRET,
  transport: "websocket",
  ...(domain ? { domain } : {}),
  logger: log,
  source: "feishu-agent-bridge",
  resolveSenderNames: true,
  policy: { dmMode: "open", requireMention: true, respondToMentionAll: false },
  outbound: { allowedFileDirs: ALLOWED_FILE_DIRS },
  keepalive: {
    enabled: true,
    onUnrecoverable: (err) => {
      log.error("长连接无法恢复，进程退出（run-loop.sh 会自动重启）:", err?.message || err);
      process.exit(3);
    },
  },
  httpTimeoutMs: 30_000,
  connectTimeoutMs: 30_000,
});

let connectedAt = null;
let lastInboundAt = null;
let stats = { received: 0, accepted: 0, ignored: 0, wakeOk: 0, wakeFail: 0, sent: 0 };

async function wake(record) {
  const url = env("FEISHU_WAKE_URL");
  if (!url) return;
  const key = env("FEISHU_WAKE_KEY");
  const headerName = env("FEISHU_WAKE_KEY_HEADER", "Authorization");
  const headers = { "content-type": "application/json" };
  if (key) headers[headerName] = headerName.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      stats.wakeFail++;
      log.warn(`唤醒请求失败 HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    } else {
      stats.wakeOk++;
      log.info(`唤醒请求成功 HTTP ${res.status} (message ${record.messageId})`);
    }
  } catch (e) {
    stats.wakeFail++;
    log.warn("唤醒请求异常:", e?.message || e);
  }
}

channel.on({
  message: async (msg) => {
    stats.received++;
    lastInboundAt = localIso();
    const record = {
      timestamp: localIso(),
      createTime: msg.createTime ? localIso(new Date(Number(msg.createTime))) : undefined,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId,
      rootId: msg.rootId,
      replyToMessageId: msg.replyToMessageId,
      // 与 vercel chat adapter 一致的线程 ID：lark:{chatId}:{rootId}
      adapterThreadId: `lark:${msg.chatId}:${msg.rootId || msg.messageId}`,
      messageId: msg.messageId,
      senderOpenId: msg.senderId,
      senderName: msg.senderName,
      senderType: msg.senderType,
      contentType: msg.rawContentType,
      text: msg.content,
      mentionedBot: msg.mentionedBot,
      resources: msg.resources?.length ? msg.resources : undefined,
    };

    const allow = allowlist();
    const isOwner = !allow.length || allow.includes(msg.senderId);
    record.isOwner = isOwner;
    if (!isOwner) {
      // 访客模式：仍唤醒上层智能体，由 routine 按隐私规则回复（不拒绝对方）
      record.guestMode = true;
      stats.ignored++; // 统计上仍计非主人消息
      record.ignored = "guest_mode"; // 兼容旧字段语义：非白名单
      fs.appendFileSync(INBOX, JSON.stringify(record) + "\n");
      log.info(
        `访客消息 ${msg.messageId} 来自 ${msg.senderId}${msg.senderName ? `(${msg.senderName})` : ""} chat=${msg.chatId} type=${msg.chatType} mentioned=${!!msg.mentionedBot}: ${String(msg.content).slice(0, 200)}`,
      );
      await wake(record);
      return;
    }

    stats.accepted++;
    fs.appendFileSync(INBOX, JSON.stringify(record) + "\n");
    log.info(
      `收到 ${msg.chatType === "p2p" ? "私聊" : "群聊"}消息 ${msg.messageId} 来自 ${msg.senderId}${msg.senderName ? `(${msg.senderName})` : ""} chat=${msg.chatId}: ${String(msg.content).slice(0, 200)}`,
    );

    // 初次配对（未设置白名单）时，对每个发送者的第一条私聊自动回执一次
    if (!allow.length && msg.chatType === "p2p" && !acked.has(msg.senderId)) {
      try {
        await channel.reply(msg, { text: PAIRING_ACK });
        markAcked(msg.senderId);
        log.info(`已向 ${msg.senderId} 发送配对回执`);
      } catch (e) {
        log.warn("发送配对回执失败:", e?.message || e);
      }
    }

    await wake(record);
  },
  reject: (evt) => log.debug?.("策略拒绝:", evt),
  botAdded: (evt) => log.info(`机器人被拉入群 ${evt.chatId}（操作人 ${evt.operator?.openId}）`),
  error: (err) => log.error(`channel 错误 [${err?.code}]: ${err?.message}`),
  reconnecting: () => log.warn("长连接重连中…"),
  reconnected: () => {
    connectedAt = localIso();
    log.info("长连接已恢复");
  },
});

// ---------- 本机 HTTP 接口 ----------
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};


/** 本机绝对路径读成 Buffer；URL/相对路径原样交给 SDK。 */
function resolveMediaSource(src) {
  if (typeof src === "string" && src.startsWith("/") && fs.existsSync(src)) {
    return fs.readFileSync(src);
  }
  return src;
}

/** 解析目标：chatId（oc_/ou_）或 adapter 线程 ID lark:{chatId}:{rootId} */
function resolveTarget(body) {
  let chatId = body.chatId;
  let replyTo = body.replyTo;
  if (body.threadId) {
    const m = /^lark:([^:]+):(.*)$/.exec(body.threadId);
    if (m) {
      chatId = chatId || m[1];
      if (!replyTo && m[2] && body.replyInThread) replyTo = m[2];
    } else {
      chatId = chatId || body.threadId;
    }
  }
  return { chatId, replyTo };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      let identity;
      try {
        identity = channel.getBotIdentity();
      } catch {}
      return json(res, 200, {
        ok: !!connectedAt,
        appId: APP_ID,
        bot: identity ? { openId: identity.openId, name: identity.name } : null,
        connectedAt,
        connection: channel.getConnectionStatus?.() ?? null,
        lastInboundAt,
        allowlist: allowlist(),
        wakeConfigured: !!env("FEISHU_WAKE_URL"),
        stats,
        pid: process.pid,
      });
    }
    if (req.method === "POST" && req.url === "/send") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return json(res, 400, { ok: false, error: "invalid JSON: " + e.message });
      }
      const { chatId, replyTo } = resolveTarget(body);
      if (!chatId) {
        return json(res, 400, { ok: false, error: "need chatId (or threadId)" });
      }
      const opts = {};
      if (replyTo) opts.replyTo = replyTo;
      if (body.replyInThread) opts.replyInThread = true;

      let input;
      let kind = "text";
      const text = body.text ?? body.markdown;
      if (body.filePath || body.file) {
        const src = body.filePath || body.file?.source || body.file?.path;
        const fileName =
          body.fileName ||
          body.file?.fileName ||
          (typeof src === "string" ? path.basename(src) : undefined);
        if (!src || !fileName) {
          return json(res, 400, { ok: false, error: "file send needs filePath/file.source and fileName" });
        }
        if (typeof src === "string" && src.startsWith("/") && !fs.existsSync(src)) {
          return json(res, 400, { ok: false, error: "filePath not found: " + src });
        }
        input = { file: { source: resolveMediaSource(src), fileName } };
        kind = `file:${fileName}`;
      } else if (body.imagePath || body.image) {
        const src = body.imagePath || body.image?.source || body.image?.path;
        if (!src) return json(res, 400, { ok: false, error: "image send needs imagePath/image.source" });
        if (typeof src === "string" && src.startsWith("/") && !fs.existsSync(src)) {
          return json(res, 400, { ok: false, error: "imagePath not found: " + src });
        }
        input = { image: { source: resolveMediaSource(src) } };
        kind = "image";
      } else if (typeof text === "string" && text.trim()) {
        input = { markdown: text };
        kind = `text:${text.length}`;
      } else {
        return json(res, 400, {
          ok: false,
          error: "need non-empty text, or filePath/file, or imagePath/image",
        });
      }

      const r = await channel.send(chatId, input, opts);
      stats.sent++;
      log.info(`已发送消息 ${r.messageId} → ${chatId}${replyTo ? ` (回复 ${replyTo})` : ""}，${kind}`);
      return json(res, 200, { ok: true, messageId: r.messageId, chunkIds: r.chunkIds, kind });
    }
    if (req.method === "POST" && req.url === "/download") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return json(res, 400, { ok: false, error: "invalid JSON: " + e.message });
      }
      const messageId = body.messageId;
      const fileKey = body.fileKey;
      const type = body.type || "file";
      const savePath = body.savePath;
      if (!messageId || !fileKey || !savePath) {
        return json(res, 400, { ok: false, error: "need messageId, fileKey, savePath" });
      }
      if (!["image", "file", "audio", "video", "sticker"].includes(type)) {
        return json(res, 400, { ok: false, error: "type must be image|file|audio|video|sticker" });
      }
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      const meta = await channel.downloadResourceToFile(messageId, fileKey, type, savePath);
      const size = fs.existsSync(savePath) ? fs.statSync(savePath).size : undefined;
      log.info(`已下载附件 ${fileKey} (${type}) ← ${messageId} → ${savePath}${size != null ? `，${size} 字节` : ""}`);
      return json(res, 200, {
        ok: true,
        savePath,
        size,
        contentType: meta?.contentType,
        fileName: meta?.fileName,
      });
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log.error("HTTP 处理出错:", e?.code || "", e?.message || e);
    json(res, 500, { ok: false, error: String(e?.code ? `${e.code}: ${e.message}` : e?.message || e) });
  }
});

process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => log.error("uncaughtException:", e?.stack || e));
const shutdown = async (sig) => {
  log.info(`收到 ${sig}，正在退出`);
  server.close();
  try {
    await channel.disconnect();
  } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => log.info(`本机接口已监听 http://${HOST}:${PORT}（/send, /download, /health）`));

log.info(`正在连接飞书长连接，app=${APP_ID} …`);
for (let attempt = 1; ; attempt++) {
  try {
    await channel.connect();
    connectedAt = localIso();
    const id = channel.getBotIdentity();
    log.info(`已连接飞书。机器人: ${id?.name} (${id?.openId})；白名单: ${allowlist().join(",") || "未设置（配对模式）"}`);
    break;
  } catch (e) {
    const wait = Math.min(60_000, 5_000 * attempt);
    log.error(`连接失败（第 ${attempt} 次）: ${e?.code || ""} ${e?.message || e}，${wait / 1000}s 后重试`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

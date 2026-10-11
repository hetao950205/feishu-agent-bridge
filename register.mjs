// 飞书「扫码创建应用」流程：生成二维码 → 等待用户在飞书 App 扫码确认 → 保存凭据到 .env → 启动 bot
// 用法: node register.mjs [--force]
//   --force  即使 .env 里已有 LARK_APP_ID 也重新创建（会生成一个新应用）
// 环境变量: REGISTER_MAX_ROUNDS  二维码过期后自动重新生成的最大轮数（默认 6，每轮约 10 分钟）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { registerLarkApp } from "@larksuite/vercel-chat-adapter";
import { DIR, ENV_PATH, addSecret, localIso, makeLogger, readEnvFile, updateEnvFile } from "./lib.mjs";

const log = makeLogger("register.log");
const QR_URL_FILE = path.join(DIR, "qr-url.txt");
const QR_PNG = process.env.FEISHU_QR_PNG || path.join(DIR, "feishu-qr.png");
const STATUS_FILE = path.join(DIR, "register-status.json");
const MAX_ROUNDS = Math.max(1, Number(process.env.REGISTER_MAX_ROUNDS) || 6);
const fileEnv = readEnvFile();
const APP_NAME = process.env.FEISHU_BOT_NAME || fileEnv.FEISHU_BOT_NAME || "AI Agent";
const APP_DESC = process.env.FEISHU_BOT_DESC || fileEnv.FEISHU_BOT_DESC || `${APP_NAME} 的飞书入口`;
const force = process.argv.includes("--force");

function setStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ updatedAt: localIso(), ...obj }, null, 2) + "\n");
}

const existing = readEnvFile();
if (existing.LARK_APP_ID && existing.LARK_APP_SECRET && !force) {
  log.warn(`.env 已存在 LARK_APP_ID=${existing.LARK_APP_ID}，跳过注册（如需重新创建应用请加 --force）`);
  process.exit(0);
}

process.on("SIGTERM", () => {
  log.info("收到 SIGTERM，注册流程退出");
  setStatus({ state: "stopped" });
  process.exit(0);
});

let lastStatus = "";
for (let round = 1; round <= MAX_ROUNDS; round++) {
  try {
    log.info(`第 ${round}/${MAX_ROUNDS} 轮：请求新的扫码链接…`);
    const result = await registerLarkApp({
      source: "feishu-agent-bridge",
      appPreset: { name: APP_NAME, desc: APP_DESC },
      onQRCodeReady: async ({ url, expireIn }) => {
        const expiresAt = new Date(Date.now() + expireIn * 1000);
        fs.writeFileSync(QR_URL_FILE, url + "\n");
        try {
          await QRCode.toFile(QR_PNG, url, { width: 512, margin: 2, errorCorrectionLevel: "M" });
        } catch (e) {
          log.error("生成二维码 PNG 失败:", e?.message || e);
        }
        setStatus({ state: "waiting_for_scan", round, url, png: QR_PNG, expireInSec: expireIn, expiresAt: localIso(expiresAt) });
        log.info(`二维码已就绪（有效期 ${expireIn} 秒，至 ${localIso(expiresAt)}），等待扫码: ${url}`);
        log.info(`PNG: ${QR_PNG}`);
      },
      onStatusChange: ({ status, interval }) => {
        // 'polling' 每 5 秒一次，只在状态变化时记录
        if (status !== lastStatus || status !== "polling") {
          log.info(`状态: ${status}${interval ? ` (轮询间隔 ${interval}s)` : ""}${status === "polling" ? " — 等待扫码中" : ""}`);
          lastStatus = status;
        }
      },
    });

    addSecret(result.client_secret);
    const updates = { LARK_APP_ID: result.client_id, LARK_APP_SECRET: result.client_secret };
    if (result.user_info?.tenant_brand === "lark") updates.LARK_DOMAIN = "lark";
    updateEnvFile(updates);
    const ownerOpenId = result.user_info?.open_id;
    if (ownerOpenId) fs.writeFileSync(path.join(DIR, "owner-open-id.txt"), ownerOpenId + "\n");
    setStatus({ state: "registered", appId: result.client_id, ownerOpenId, tenantBrand: result.user_info?.tenant_brand });
    log.info(`注册成功：LARK_APP_ID=${result.client_id}，凭据已写入 ${ENV_PATH}（权限 600）。扫码人 open_id=${ownerOpenId ?? "未知"}`);

    // 启动 bot（脱离当前进程）
    const child = spawn("bash", [path.join(DIR, "start.sh")], { cwd: DIR, detached: true, stdio: "ignore" });
    child.unref();
    log.info("已触发 start.sh 启动 bot");
    try { fs.unlinkSync(path.join(DIR, "register.pid")); } catch {}
    process.exit(0);
  } catch (e) {
    const code = e?.code || e?.name || "error";
    log.warn(`注册未完成: ${code} ${e?.message || e}`);
    if (code === "expired_token" || /expired|timed out/i.test(String(e?.message))) {
      setStatus({ state: "expired", round });
      continue; // 重新生成二维码
    }
    if (code === "access_denied") {
      setStatus({ state: "denied" });
      log.error("用户在飞书里拒绝了授权，退出。重新运行 register.mjs 可再试。");
      process.exit(2);
    }
    setStatus({ state: "error", error: String(e?.message || e) });
    if (round < MAX_ROUNDS) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
  }
}
log.error(`已达最大轮数 ${MAX_ROUNDS}，二维码均未被扫描。重新运行: nohup node register.mjs &`);
setStatus({ state: "gave_up" });
process.exit(1);

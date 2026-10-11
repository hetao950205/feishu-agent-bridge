// 共享工具：日志（带本地时区时间戳 + 密钥脱敏）、.env 读写
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = path.join(DIR, ".env");

/** ISO timestamp in the machine's local time zone, e.g. 2026-10-08T23:50:00.123+08:00 */
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

const secrets = new Set();
/** Register a value that must never appear in logs. */
export function addSecret(v) {
  if (v && typeof v === "string" && v.length >= 6) secrets.add(v);
}
export function redact(s) {
  let out = s;
  for (const v of secrets) out = out.split(v).join("[REDACTED]");
  return out;
}

export function makeLogger(file) {
  const full = path.join(DIR, file);
  const write = (level, args) => {
    const msg = args
      .flatMap((a) => (Array.isArray(a) && a.every((x) => typeof x !== "object") ? a : [a]))
      .map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4, breakLength: 200 })))
      .join(" ");
    const line = redact(`${localIso()} [${level}] ${msg}`) + "\n";
    try {
      fs.appendFileSync(full, line);
    } catch {}
    if (process.stdout.isTTY) process.stdout.write(line);
  };
  return {
    error: (...a) => write("ERROR", a),
    warn: (...a) => write("WARN", a),
    info: (...a) => write("INFO", a),
    debug: (...a) => (process.env.FEISHU_DEBUG ? write("DEBUG", a) : undefined),
    trace: () => {},
  };
}

/** Parse .env (KEY=VALUE lines) without exporting anything. */
export function readEnvFile(p = ENV_PATH) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Merge keys into .env, preserving other lines; file mode 600. */
export function updateEnvFile(updates, p = ENV_PATH) {
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : [];
  const done = new Set();
  const out = lines.map((l) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    if (m && m[1] in updates) {
      done.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return l;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${v}`);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
}

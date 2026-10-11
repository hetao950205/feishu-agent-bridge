// Catch-up: while the host sleeps the WebSocket is down and Feishu does NOT redeliver events.
// On startup / reconnect / keepalive wake-up / every N minutes we list recent messages per chat via
// im/v1/messages and feed anything unseen through the same inbound pipeline (marked catchUp: true).
import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";

export function createCatchUp({ appId, appSecret, domain, dir, log, inboxFile, extraChats = [], handle, getBotOpenId,
  intervalMs = 120_000, firstRunWindowMs = 6 * 3600_000 }) {
  const STATE = path.join(dir, "catchup-state.json");
  const client = new lark.Client({ appId, appSecret, ...(domain ? { domain } : {}), loggerLevel: lark.LoggerLevel.error });
  let state = { chats: {}, processed: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, "utf8")) }; } catch {}
  const processed = new Set(state.processed);
  const chatTypes = {};
  const warned = new Set();
  let running = null, runs = 0, found = 0, lastRunAt = null;
  const save = () => {
    state.processed = [...processed].slice(-2000);
    fs.writeFileSync(STATE + ".tmp", JSON.stringify(state));
    fs.renameSync(STATE + ".tmp", STATE);
  };
  const warnOnce = (k, ...a) => { if (!warned.has(k)) { warned.add(k); log.warn(...a); } };

  function markProcessed(id, chatId, createMs) {
    if (!id) return;
    processed.add(id);
    if (chatId && createMs) {
      const c = (state.chats[chatId] ||= {});
      if (!c.lastCreateMs || createMs > c.lastCreateMs) c.lastCreateMs = createMs;
    }
    save();
  }

  function knownChats() {
    const set = new Set(extraChats.filter(Boolean));
    try {
      for (const l of fs.readFileSync(inboxFile, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try { const r = JSON.parse(l); if (r.chatId) { set.add(r.chatId); if (r.chatType) chatTypes[r.chatId] = r.chatType; } } catch {}
      }
    } catch {}
    for (const id of Object.keys(state.chats)) set.add(id);
    return set;
  }

  async function discoverChats(set) {
    try {
      let page_token;
      do {
        const r = await client.request({ method: "GET", url: "/open-apis/im/v1/chats", params: { page_size: 100, page_token } });
        if (r.code) throw Object.assign(new Error(r.msg), { code: r.code });
        for (const c of r.data?.items || []) { set.add(c.chat_id); chatTypes[c.chat_id] ||= "group"; }
        page_token = r.data?.has_more ? r.data.page_token : undefined;
      } while (page_token);
    } catch (e) {
      warnOnce("chats", `[catch-up] im/v1/chats list unavailable (${e?.response?.data?.code || e.code || ""} ${e?.response?.data?.msg || e.message}); using known chats only`);
    }
  }

  async function chatType(chatId) {
    if (chatTypes[chatId]) return chatTypes[chatId];
    try {
      const r = await client.request({ method: "GET", url: `/open-apis/im/v1/chats/${chatId}` });
      chatTypes[chatId] = r.data?.chat_mode === "p2p" ? "p2p" : "group";
    } catch { chatTypes[chatId] = "group"; }
    return chatTypes[chatId];
  }

  function parseContent(item) {
    let body = {};
    try { body = JSON.parse(item.body?.content || "{}"); } catch { return item.body?.content || ""; }
    const mentions = item.mentions || [];
    const fixMentions = (s) => mentions.reduce((t, m) => t.split(m.key).join(`@${m.name}`), s);
    const resources = [];
    let text = "";
    switch (item.msg_type) {
      case "text": text = fixMentions(body.text || ""); break;
      case "post": {
        const p = body.content ? body : Object.values(body)[0] || {};
        const lines = (p.content || []).map((para) => para.map((el) => {
          if (el.tag === "text" || el.tag === "a") return el.text || "";
          if (el.tag === "at") return `@${el.user_name || mentions.find((m) => m.key === el.user_id)?.name || ""}`;
          if (el.tag === "img") { resources.push({ type: "image", fileKey: el.image_key }); return "[image]"; }
          return "";
        }).join(""));
        text = [p.title, ...lines].filter(Boolean).join("\n");
        break;
      }
      case "image": resources.push({ type: "image", fileKey: body.image_key }); text = "[image]"; break;
      case "file": resources.push({ type: "file", fileKey: body.file_key, fileName: body.file_name }); text = `[file] ${body.file_name || ""}`; break;
      case "audio": resources.push({ type: "audio", fileKey: body.file_key }); text = "[audio]"; break;
      case "media": resources.push({ type: "video", fileKey: body.file_key, fileName: body.file_name }); text = "[video]"; break;
      default: text = item.body?.content || "";
    }
    return { text, resources };
  }

  async function runOnce(reason) {
    runs++; lastRunAt = new Date().toISOString();
    const chats = knownChats();
    await discoverChats(chats);
    const botId = getBotOpenId?.();
    let n = 0;
    for (const chatId of chats) {
      const c = (state.chats[chatId] ||= {});
      const sinceMs = c.lastCreateMs ? c.lastCreateMs - 60_000 : Date.now() - firstRunWindowMs;
      let page_token;
      try {
        do {
          const r = await client.request({ method: "GET", url: "/open-apis/im/v1/messages", params: {
            container_id_type: "chat", container_id: chatId, start_time: String(Math.floor(sinceMs / 1000)),
            sort_type: "ByCreateTimeAsc", page_size: 50, page_token } });
          if (r.code) throw Object.assign(new Error(r.msg), { code: r.code });
          for (const item of r.data?.items || []) {
            const createMs = Number(item.create_time);
            if (processed.has(item.message_id)) continue;
            if (item.deleted || item.sender?.sender_type !== "user" || item.sender?.id === botId) {
              markProcessed(item.message_id, chatId, createMs); continue;
            }
            const type = await chatType(chatId);
            const mentionedBot = (item.mentions || []).some((m) => m.id === botId || m.id?.open_id === botId);
            if (type === "group" && !mentionedBot) { markProcessed(item.message_id, chatId, createMs); continue; }
            const { text, resources } = parseContent(item);
            const msg = {
              chatId, chatType: type, messageId: item.message_id, rootId: item.root_id, threadId: item.thread_id,
              replyToMessageId: item.parent_id, senderId: item.sender?.id, senderType: item.sender?.sender_type,
              rawContentType: item.msg_type, content: text, mentionedBot, resources, createTime: createMs,
            };
            markProcessed(item.message_id, chatId, createMs);
            n++; found++;
            log.info(`[catch-up] missed message ${item.message_id} chat=${chatId} created=${new Date(createMs).toISOString()}`);
            try { await handle(msg, { catchUp: true }); } catch (e) { log.error("[catch-up] handler error:", e?.message || e); }
          }
          page_token = r.data?.has_more ? r.data.page_token : undefined;
        } while (page_token);
      } catch (e) {
        const code = e?.response?.data?.code || e.code;
        warnOnce(`chat:${chatId}:${code}`, `[catch-up] cannot list messages of ${chatId} (${code || ""} ${e?.response?.data?.msg || e.message}); check im:message / im:message.group_msg permissions`);
      }
    }
    save();
    log.info(`[catch-up] run done (${reason}): ${chats.size} chats, ${n} new`);
  }

  function trigger(reason) {
    if (running) return running;
    running = runOnce(reason).catch((e) => log.error("[catch-up] failed:", e?.message || e)).finally(() => { running = null; });
    return running;
  }
  const timer = setInterval(() => trigger("interval"), intervalMs);
  timer.unref?.();
  return { trigger, markProcessed, isProcessed: (id) => processed.has(id), stats: () => ({ runs, found, lastRunAt }) };
}

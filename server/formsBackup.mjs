// Private copies of form data: a non-public R2 bucket and a Telegram backup chat.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const hex = buffer => Buffer.from(buffer).toString("hex");
const sha256 = data => createHash("sha256").update(data).digest();
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encodePath = path => path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

export function r2FormsSettings(env = process.env) {
  const bucket = (env.R2_FORMS_BUCKET ?? "").trim(), publicBuckets = [env.R2_BUCKET ?? "vn-reader-media", env.R2_SECONDARY_BUCKET].filter(Boolean);
  const settings = { bucket, accountId: env.R2_FORMS_ACCOUNT_ID || env.R2_ACCOUNT_ID || "", accessKeyId: env.R2_FORMS_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "", secretAccessKey: env.R2_FORMS_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "", prefix: (env.R2_FORMS_PREFIX ?? "forms").replace(/^\/+|\/+$/g, "") };
  // Form answers hold addresses and phone numbers. They must never land in the public media bucket.
  if (bucket && publicBuckets.includes(bucket) && !env.R2_FORMS_ACCOUNT_ID) return { ...settings, enabled: false, reason: "R2_FORMS_BUCKET is the public media bucket. Create a separate private bucket for form data." };
  if (!bucket) return { ...settings, enabled: false, reason: "Set R2_FORMS_BUCKET to a private bucket to mirror form data to R2." };
  if (!settings.accountId || !settings.accessKeyId || !settings.secretAccessKey) return { ...settings, enabled: false, reason: "R2 credentials are missing for the forms bucket." };
  return { ...settings, enabled: true, reason: "" };
}

/** AWS Signature V4 for a single S3 request against Cloudflare R2. */
export function signR2Request({ method, accountId, bucket, key, accessKeyId, secretAccessKey, body = "", contentType = "application/json", now = new Date() }) {
  const host = `${accountId}.r2.cloudflarestorage.com`, path = `/${encodePath(`${bucket}/${key}`)}`;
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""), date = amzDate.slice(0, 8), payloadHash = hex(sha256(body));
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(method === "PUT" ? { "content-type": contentType } : {}) };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [method, path, "", ...Object.keys(headers).sort().map(name => `${name}:${headers[name]}`), "", signedHeaders, payloadHash].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(sha256(canonical))].join("\n");
  const signingKey = ["auto", "s3", "aws4_request"].reduce((key, part) => hmac(key, part), hmac(`AWS4${secretAccessKey}`, date));
  const { host: _host, ...sendHeaders } = headers;
  return { url: `https://${host}${path}`, headers: { ...sendHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hex(hmac(signingKey, toSign))}` } };
}

export function createR2Forms(settings, fetchImpl = fetch) {
  const send = async (method, key, body = "", contentType) => {
    if (!settings.enabled) return false;
    const fullKey = settings.prefix ? `${settings.prefix}/${key}` : key;
    const { url, headers } = signR2Request({ method, ...settings, key: fullKey, body, contentType });
    const response = await fetchImpl(url, { method, headers, body: method === "PUT" ? body : undefined, signal: AbortSignal.timeout(15000) });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error(`R2 ${method} failed with ${response.status}`);
    return true;
  };
  return { enabled: settings.enabled, reason: settings.reason, bucket: settings.bucket,
    put: (key, value, contentType = "application/json") => send("PUT", key, typeof value === "string" ? value : JSON.stringify(value, null, 2), contentType),
    remove: key => send("DELETE", key) };
}

const escapeHTML = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Telegram Bot API helper. `config()` is read on every call so settings saved
 * in the admin console apply without a restart.
 */
export function createTelegramForms(config, fetchImpl = fetch) {
  async function call(method, payload, token = config().botToken, timeoutMs = 20000) {
    if (!token) throw new Error("No Telegram bot token is set.");
    const isForm = typeof FormData !== "undefined" && payload instanceof FormData;
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: isForm ? undefined : { "Content-Type": "application/json" }, body: isForm ? payload : JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(typeof data.description === "string" ? data.description.slice(0, 200) : `Telegram ${method} failed`);
    return data.result;
  }
  const target = () => { const { backupChat, backupThread } = config(); return backupChat ? { chat_id: backupChat, ...(backupThread ? { message_thread_id: Number(backupThread) } : {}) } : null; };
  return {
    escapeHTML, call,
    configured: () => !!(config().botToken && config().backupChat),
    me: token => call("getMe", {}, token),
    async message(html, extra = {}) { const chat = target(); if (!chat || !config().botToken) return false; await call("sendMessage", { ...chat, text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }); return true; },
    async document(filename, content, caption = "", contentType = "application/json") {
      const chat = target(); if (!chat || !config().botToken) return false;
      const form = new FormData();
      for (const [key, value] of Object.entries(chat)) form.set(key, String(value));
      form.set("caption", caption.slice(0, 1000)); form.set("parse_mode", "HTML");
      form.set("document", new Blob([content], { type: contentType }), filename);
      await call("sendDocument", form); return true;
    },
    /** Direct message. Only works for people who opened the bot or its web app. */
    async direct(userId, html, button) {
      if (!config().botToken || !/^\d{3,20}$/.test(String(userId ?? ""))) return false;
      await call("sendMessage", { chat_id: String(userId), text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}) });
      return true;
    },
    /** Validate Telegram Mini App initData; returns the Telegram user or null. */
    verifyInitData(initData, maxAgeSeconds = 86400, now = Date.now(), token = config().botToken) {
      if (!token || typeof initData !== "string" || !initData || initData.length > 4096) return null;
      const params = new URLSearchParams(initData), hash = params.get("hash");
      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
      params.delete("hash");
      const check = [...params].map(([key, value]) => `${key}=${value}`).sort().join("\n");
      const expected = hmac(hmac("WebAppData", token), check);
      if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
      const authDate = Number(params.get("auth_date"));
      if (!Number.isFinite(authDate) || authDate > now / 1000 + 60 || now / 1000 - authDate > maxAgeSeconds) return null;
      try { const user = JSON.parse(params.get("user") ?? "null"); return user && Number.isSafeInteger(user.id) && user.id > 0 ? { id: String(user.id), username: typeof user.username === "string" ? user.username : "", firstName: typeof user.first_name === "string" ? user.first_name : "", canMessage: user.allows_write_to_pm !== false } : null; }
      catch { return null; }
    }
  };
}

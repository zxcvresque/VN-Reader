import { createHash, timingSafeEqual } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { FormsStore, FormError, PERMISSIONS, ROLE_PRESETS } from "./formsStore.mjs";
import { allFields, displayAnswer, isTelegramUserId } from "./formLogic.mjs";
import { createR2Forms, createTelegramForms, r2FormsSettings } from "./formsBackup.mjs";

const ALL = PERMISSIONS.map(permission => permission.id);
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

export function createForms({ accounts, settings, fetchImpl = fetch, env = process.env }) {
  const store = new FormsStore(accounts.database);
  const r2 = createR2Forms(settings.r2Forms ?? r2FormsSettings(env), fetchImpl);
  const telegramConfig = () => ({ botToken: store.getSetting("tg.botToken") || settings.botToken || "", backupChat: store.getSetting("tg.backupChat") || "", backupThread: store.getSetting("tg.backupThread") || "" });
  const telegram = createTelegramForms(telegramConfig, fetchImpl);
  const flag = (key, fallback = true) => { const value = store.getSetting(key); return value === null ? fallback : value === "1"; };
  const origin = new URL(settings.baseURL).origin;
  const quiet = promise => promise.catch(error => { console.warn(`Form backup step failed: ${String(error?.message ?? error).slice(0, 160)}`); return false; });

  const sessionOf = async req => { try { return accounts.enabled ? await accounts.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }) : null; } catch { return null; } };
  async function adminOf(req) {
    const user = (await sessionOf(req))?.user;
    if (!user?.emailVerified) throw new FormError(401, "Sign in with a verified email to open the admin console.");
    const owner = accounts.admin.allowed(user), member = owner ? null : store.member(user.email);
    if (!owner && !member?.active) throw new FormError(403, "This account does not have administrator access.");
    const permissions = new Set(owner ? ALL : member.permissions);
    return { user, email: user.email.toLowerCase(), owner, permissions, formIds: owner ? null : member.formIds,
      need(permission, formId) {
        if (!permissions.has(permission)) throw new FormError(403, "Your admin role doesn't include this action. Ask the owner for access.");
        if (formId && this.formIds && !this.formIds.includes(formId)) throw new FormError(403, "Your admin role doesn't cover this form.");
      } };
  }
  /** Site-level admin check used by the existing reader dashboard routes. */
  const siteAdmin = user => !!user?.emailVerified && (accounts.admin.allowed(user) || !!store.member(user.email)?.active && store.member(user.email).permissions.includes("site.read"));
  const hasPermission = (user, permission) => !!user?.emailVerified && (accounts.admin.allowed(user) || !!store.member(user.email)?.active && store.member(user.email).permissions.includes(permission));
  const anyAdmin = user => !!user?.emailVerified && (accounts.admin.allowed(user) || !!store.member(user.email)?.active);

  // ----- copies -----
  const readable = (form, response) => Object.fromEntries(allFields(form.schema).filter(field => field.type !== "statement").map(field => [field.label, displayAnswer(field, response.answers[field.id])]));
  const responseKey = (form, response) => `${form.id}/responses/${response.createdAt.slice(0, 4)}/${response.createdAt.slice(5, 7)}/${response.id}.json`;
  async function syncResponse(form, response) {
    if (!r2.enabled) return false;
    const stamp = store.time();
    await r2.put(responseKey(form, response), { form: { id: form.id, slug: form.slug, title: form.title }, response, readable: readable(form, response) });
    store.markSynced(response.id, stamp);
    return true;
  }
  async function syncPending() {
    if (!r2.enabled) return;
    for (const response of store.unsynced()) { const form = store.form(response.formId); if (form) await quiet(syncResponse(form, response)); }
  }
  const timer = r2.enabled ? setInterval(() => void syncPending(), 300000) : null;
  timer?.unref();
  const nameOf = (form, response) => { const field = allFields(form.schema).find(candidate => candidate.role === "name"); return field ? displayAnswer(field, response.answers[field.id]) : ""; };
  function afterSubmit(form, response) {
    void quiet(syncResponse(form, response));
    if (!form.settings.notifyTelegram || !flag("tg.notifyOnSubmit")) return;
    const caption = [`<b>${telegram.escapeHTML(form.title)}</b> · new response`, `Status: ${response.status}`, response.state ? `State: ${telegram.escapeHTML(response.state)}` : "", nameOf(form, response) ? `Name: ${telegram.escapeHTML(nameOf(form, response))}` : "", `ID: <code>${response.id}</code>`].filter(Boolean).join("\n");
    void quiet(telegram.document(`${form.slug}-${response.id}.json`, JSON.stringify({ form: { id: form.id, slug: form.slug, title: form.title }, response, readable: readable(form, response) }, null, 2), caption));
  }
  function afterReview(form, changed, actor) {
    for (const { before, after } of changed) {
      void quiet(syncResponse(form, after));
      if (before.status === after.status) continue;
      if (flag("tg.notifyOnSubmit")) void quiet(telegram.message(`<b>${telegram.escapeHTML(form.title)}</b> · response ${after.status}\nBy: ${telegram.escapeHTML(actor)}\nID: <code>${after.id}</code>`));
      if (after.status === "pending") continue;
      const outcome = store.outcome(form, after);
      emailDecision(form, after, outcome);
      if (!after.telegram?.id || !flag("tg.dmOnDecision")) continue;
      const button = outcome.reward?.url ? { text: outcome.reward.label, url: outcome.reward.url } : { text: "View your response status", url: `${origin}/f/${form.slug}` };
      void quiet(telegram.direct(after.telegram.id, `<b>${telegram.escapeHTML(form.title)}</b>\n${telegram.escapeHTML(outcome.message || (after.status === "approved" ? "Your response was approved." : "Your response wasn't approved."))}`, after.status === "approved" ? button : undefined));
    }
  }

  // ----- status updates for respondents -----
  let botName = null;
  /** Username of the bot that answers /start and /status: the archive service's bot. */
  async function statusBot() {
    if (botName !== null) return botName;
    if (!settings.botToken) return (botName = "");
    try { botName = (await telegram.me(settings.botToken))?.username ?? ""; } catch { return ""; }
    return botName;
  }
  const statusWord = status => (status === "approved" ? "Approved ✅" : status === "rejected" ? "Not approved" : "Waiting for review ⏳");
  function formatSubmissionTime(timestamp, timezone) {
    const options = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" };
    let formatter;
    try { formatter = new Intl.DateTimeFormat("en-IN", { ...options, timeZone: timezone }); }
    catch { formatter = new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }); }
    return formatter.format(new Date(timestamp));
  }
  /** What the bot says back to one Telegram user. Only responses bound to that user are ever shown. */
  function botReply({ userId, username, text }) {
    const contactCode = /^\/start(?:@\w+)?\s+tguserid_([A-Za-z0-9_-]{24})$/.exec(text)?.[1];
    if (contactCode || /^\/start(?:@\w+)?\s+tguserid$/.test(text)) {
      const linked = contactCode && store.confirmTelegramLink(contactCode, userId, username);
      const next = linked ? "Copy this ID and paste it into the form." : contactCode ? "Open Telegram from the form again if you need a new link." : "Use the Telegram button in the form to verify your ID.";
      return { text: `Your Telegram user ID is <code>${userId}</code>.${username ? `\nUsername: @${telegram.escapeHTML(username)}` : ""}\n\n${next}`, copyText: userId };
    }
    if (/^\/start(?:@\w+)?$/.test(text)) {
      return {
        text: [
          "<b>Welcome to Vidurneeti!</b>",
          "We share commentary on India, drawing on Vidura of the Mahabharata and the Bhagavad Geeta.",
          "Tap <b>Open Vidurneeti</b> in this chat’s menu to launch the web app inside Telegram. Read posts in VN Reader, browse threads and timelines, save posts, and take notes. You can also explore Ground Work and fill out forms.",
          "After submitting a form, tap <b>Get updates</b> under Telegram on the confirmation page, then tap <b>Start</b> to link your response. Send /status here anytime to check your linked responses.",
          "Need help? Visit our support channel, <a href=\"https://t.me/vidurneetixyz\">@vidurneetixyz</a>."
        ].join("\n\n"),
        button: { text: "Open Vidurneeti", url: `${origin}/` }
      };
    }
    const payload = /^\/start(?:@\w+)?\s+r_([A-Za-z0-9_-]{12,32})\s*$/.exec(String(text ?? ""))?.[1];
    const lines = [];
    if (payload) {
      const bound = store.bindTelegram(payload, userId, username), form = bound && store.form(bound.formId);
      if (!bound || !form) return { text: "This link has expired or was already used. Open your status page and tap “Get updates on Telegram” again.", button: { text: "Open Vidurneeti", url: `${origin}/` } };
      void quiet(syncResponse(form, bound));
      lines.push("Linked. You'll get a message here when your response is reviewed.", "");
    }
    const mine = store.byTelegram(userId).map(response => ({ response, form: store.form(response.formId) })).filter(item => item.form);
    if (!mine.length) return { text: "No form responses are linked to this Telegram account yet.\n\nFill a form, then tap “Get updates on Telegram” on the confirmation page.", button: { text: "Open Vidurneeti", url: `${origin}/` } };
    let button;
    for (const { response, form } of mine) {
      const outcome = store.outcome(form, response);
      lines.push(`<b>${telegram.escapeHTML(form.title)}</b>`, `${statusWord(response.status)} · submitted ${formatSubmissionTime(response.createdAt, form.settings.timezone)}`, "");
      if (!button && outcome.reward?.url) button = { text: outcome.reward.label, url: outcome.reward.url };
    }
    return { text: lines.join("\n").trim(), ...(button ? { button } : {}) };
  }
  function emailDecision(form, response, outcome) {
    if (!response.notifyEmail || !accounts.mail || !flag("mail.onDecision")) return;
    const approved = response.status === "approved";
    const text = [outcome.message || (approved ? "Your response was approved." : "Your response wasn't approved."), approved && outcome.reward?.url ? `\n${outcome.reward.label}: ${outcome.reward.url}` : "", `\nYou asked for this update when you filled “${form.title}” on ${new URL(origin).host}. If that wasn't you, ignore this email.`, "If you expect an update and don’t see it in your inbox, check your spam or junk folder. If it’s there, mark it as not spam to help future updates reach your inbox."].filter(Boolean).join("\n");
    void quiet(accounts.mail({ to: response.notifyEmail, subject: `${form.title} · ${approved ? "Approved" : "Update on your response"}`, text }));
  }

  // ----- public throttling -----
  const hits = new Map();
  function throttled(req, bucket, limit, windowMs) {
    const key = `${bucket}:${createHash("sha256").update(String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "")).digest("hex").slice(0, 24)}`, now = Date.now();
    const recent = (hits.get(key) ?? []).filter(time => now - time < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return true; }
    recent.push(now); hits.set(key, recent);
    if (hits.size > 5000) for (const [entry, times] of hits) if (!times.some(time => now - time < 3600000)) hits.delete(entry);
    return false;
  }

  function mount(app) {
    const liveForm = req => { const form = store.formBySlug(String(req.params.slug)); if (!form || form.status === "draft") throw new FormError(404, "This form doesn't exist or isn't published yet."); return form; };

    // ----- public -----
    app.get("/api/forms/go/:code", wrap((req, res) => { const link = store.link(String(req.params.code)); const form = link && store.form(link.formId); if (!form || form.status === "draft") throw new FormError(404, "This link is no longer active."); res.json({ slug: form.slug, via: link.code }); }));
    app.get("/api/forms/:slug", wrap(async (req, res) => {
      const form = liveForm(req), session = await sessionOf(req), link = typeof req.query.via === "string" ? store.link(req.query.via) : null;
      const mine = store.byReceipt(form.id, req.headers["x-vn-receipt"]) ?? (session?.user?.emailVerified ? store.byUser(form.id, session.user.id) : null);
      res.json({ form: store.publicForm(form), updates: { telegram: await statusBot(), email: !!accounts.enabled && flag("mail.onDecision") }, prefill: link?.formId === form.id ? link.prefill : {}, signedIn: !!session?.user?.emailVerified, outcome: mine ? store.outcome(form, mine) : null });
    }));
    app.get("/api/forms/:slug/share-image", wrap((req, res) => { const form = liveForm(req), image = store.shareImage(form.id); if (!image) throw new FormError(404, "No share image."); res.set({ "Content-Type": image.mime, "Cache-Control": "public, max-age=86400", ETag: `"${image.updated_at}"` }).send(Buffer.from(image.data)); }));
    app.get("/api/forms/:slug/font", wrap((req, res) => { const form = liveForm(req), font = store.font(form.id); if (!font) throw new FormError(404, "No custom font."); res.set({ "Content-Type": font.mime, "Cache-Control": "public, max-age=86400", ETag: `"${font.updated_at}"` }).send(Buffer.from(font.data)); }));
    app.post("/api/forms/:slug/events", wrap((req, res) => {
      const form = liveForm(req);
      if (!throttled(req, "event", 40, 600000)) store.track(form.id, req.body?.kind, typeof req.body?.via === "string" ? req.body.via : "", form.settings.timezone);
      res.json({ ok: true });
    }));
    app.post("/api/forms/:slug/telegram-link", wrap(async (req, res) => {
      const form = liveForm(req);
      if (store.publicForm(form).availability !== "open" || !allFields(form.schema).some(field => field.type === "telegram")) throw new FormError(409, "Telegram linking is unavailable for this form.");
      if (throttled(req, "telegram-link", 12, 600000)) throw new FormError(429, "Too many attempts. Please try again in a few minutes.");
      const bot = await statusBot();
      if (!bot) throw new FormError(503, "Telegram linking is unavailable right now. Try again in a moment.");
      const { code, key } = store.createTelegramLink(form.id);
      res.json({ url: `https://t.me/${bot}?start=tguserid_${code}`, key });
    }));
    app.get("/api/forms/:slug/telegram-link", wrap((req, res) => {
      const form = liveForm(req);
      if (throttled(req, "telegram-poll", 240, 60000)) throw new FormError(429, "Too many requests. Please wait and try again.");
      const link = store.telegramLink(form.id, req.headers["x-vn-telegram-link"]);
      if (!link) throw new FormError(404, "This Telegram link has expired. Open Telegram from the form again.");
      res.json({ telegram: link.id ? link : null });
    }));
    app.post("/api/forms/:slug/responses", wrap(async (req, res) => {
      const form = liveForm(req), body = req.body ?? {};
      // The hidden "website" field is only ever filled by scripts.
      if (typeof body.website === "string" && body.website) throw new FormError(422, "This response couldn't be accepted.");
      if (throttled(req, "submit", 6, 600000)) throw new FormError(429, "Too many responses from this connection. Please try again in a few minutes.");
      const session = await sessionOf(req), started = Number(body.startedAt), now = Date.now();
      const input = { answers: body.answers, userId: session?.user?.emailVerified ? session.user.id : null, link: typeof body.via === "string" ? body.via : "",
        device: ["mobile", "tablet", "desktop", "telegram"].includes(body.device) ? body.device : "", durationMs: Number.isFinite(started) && started < now ? Math.round(now - started) : null, telegram: allFields(form.schema).some(field => field.type === "telegram") ? null : telegram.verifyInitData(body.initData, undefined, undefined, settings.botToken) };
      const { receipt, response } = body.telegramLink ? store.submitWithTelegramLink(form, input, body.telegramLink) : store.submit(form, input);
      afterSubmit(form, response);
      res.status(201).json({ receipt, outcome: store.outcome(form, response) });
    }));

    // Opt in to status updates. The receipt proves the caller owns the response.
    app.post("/api/forms/:slug/notify", wrap(async (req, res) => {
      const form = liveForm(req), mine = store.byReceipt(form.id, req.headers["x-vn-receipt"]);
      if (!mine) throw new FormError(404, "We couldn't find your response on this device. Open your private status link first.");
      if (throttled(req, "notify", 12, 600000)) throw new FormError(429, "Too many attempts. Please try again in a few minutes.");
      if (req.body?.channel === "telegram") {
        const bot = await statusBot();
        if (!bot) throw new FormError(503, "Telegram updates aren't available right now.");
        return res.json({ url: `https://t.me/${bot}?start=r_${store.createBind(form.id, mine.id)}` });
      }
      if (req.body?.channel === "email") {
        if (!accounts.enabled || !flag("mail.onDecision")) throw new FormError(503, "Email updates aren't available right now.");
        const updated = store.setNotifyEmail(form.id, mine.id, String(req.body?.email ?? ""));
        void quiet(syncResponse(form, updated));
        return res.json({ outcome: store.outcome(form, updated) });
      }
      throw new FormError(422, "Choose Telegram or email.");
    }));
    // Called by the archive service's bot for /start and /status in private chats. Never routed publicly.
    app.post("/internal/forms/telegram", wrap((req, res) => {
      const given = Buffer.from(String(req.headers.authorization ?? "")), expected = Buffer.from(`Bearer ${settings.botToken ?? ""}`);
      if (!settings.botToken || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new FormError(403, "Forbidden");
      const { userId, username, text } = req.body ?? {};
      if (!isTelegramUserId(String(userId ?? ""))) throw new FormError(422, "Invalid user.");
      res.json(botReply({ userId: String(userId), username: typeof username === "string" && /^[A-Za-z0-9_]{1,32}$/.test(username) ? username : "", text: typeof text === "string" ? text.trim() : "" }));
    }));

    // ----- admin -----
    app.get("/api/admin/me", wrap(async (req, res) => { const admin = await adminOf(req); res.json({ email: admin.email, owner: admin.owner, permissions: [...admin.permissions], formIds: admin.formIds, catalog: PERMISSIONS, presets: ROLE_PRESETS }); }));
    app.get("/api/admin/forms", wrap(async (req, res) => { const admin = await adminOf(req); admin.need("forms.read"); res.json({ forms: store.forms().filter(form => !admin.formIds || admin.formIds.includes(form.id)) }); }));
    app.post("/api/admin/forms", wrap(async (req, res) => { const admin = await adminOf(req); admin.need("forms.write"); if (admin.formIds) throw new FormError(403, "Your admin role is limited to specific forms."); res.status(201).json({ form: store.createForm(req.body ?? {}, admin.email) }); }));
    const formFor = async (req, permission) => { const admin = await adminOf(req); admin.need(permission, String(req.params.id)); const form = store.form(String(req.params.id)); if (!form) throw new FormError(404, "This form no longer exists."); return { admin, form }; };
    app.get("/api/admin/forms/:id", wrap(async (req, res) => { const { form } = await formFor(req, "forms.read"); res.json({ form, hasCustomFont: !!store.font(form.id), shareImage: store.shareImageInfo(form.id) }); }));
    // Share picture: PNG, JPEG or WebP, already sized to 1200×630 by the console.
    app.put("/api/admin/forms/:id/share-image", wrap(async (req, res) => {
      const { admin, form } = await formFor(req, "forms.write");
      const data = Buffer.from(String(req.body?.data ?? ""), "base64"), head = data.subarray(0, 12);
      const mime = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png" : head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg" : head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp" : null;
      if (!mime || data.length < 500) throw new FormError(422, "Use a PNG, JPEG or WebP image.");
      if (data.length > 700 * 1024) throw new FormError(413, "The image is too large. Use one under 700 KB.");
      const auto = req.body?.auto === true;
      if (auto && store.shareImageInfo(form.id)?.auto === false) return res.json({ shareImage: store.shareImageInfo(form.id) }); // never replace a chosen picture
      res.json({ shareImage: store.setShareImage(form.id, mime, data, auto, admin.email) });
    }));
    app.get("/api/admin/forms/:id/share-image", wrap(async (req, res) => { const { form } = await formFor(req, "forms.read"), image = store.shareImage(form.id); if (!image) throw new FormError(404, "No share image."); res.set({ "Content-Type": image.mime, "Cache-Control": "private, max-age=60" }).send(Buffer.from(image.data)); }));
    app.delete("/api/admin/forms/:id/share-image", wrap(async (req, res) => { const { form } = await formFor(req, "forms.write"); store.clearShareImage(form.id); res.json({ shareImage: null }); }));
    app.put("/api/admin/forms/:id", wrap(async (req, res) => { const { admin, form } = await formFor(req, "forms.write"); const next = store.updateForm(form.id, req.body ?? {}, admin.email); void quiet(r2.put(`${form.id}/definition.json`, next)); res.json({ form: next }); }));
    app.post("/api/admin/forms/:id/duplicate", wrap(async (req, res) => { const { admin, form } = await formFor(req, "forms.write"); res.status(201).json({ form: store.duplicateForm(form.id, admin.email) }); }));
    app.delete("/api/admin/forms/:id", wrap(async (req, res) => { const { admin, form } = await formFor(req, "forms.write"); admin.need("responses.delete", form.id); store.deleteForm(form.id, admin.email); res.json({ ok: true }); }));
    app.put("/api/admin/forms/:id/font", wrap(async (req, res) => {
      const { admin, form } = await formFor(req, "forms.write");
      const data = Buffer.from(String(req.body?.data ?? ""), "base64"), magic = data.subarray(0, 4).toString("latin1");
      const mime = magic === "wOF2" ? "font/woff2" : magic === "wOFF" ? "font/woff" : magic === "OTTO" ? "font/otf" : data.readUInt32BE?.(0) === 0x00010000 ? "font/ttf" : null;
      if (!mime || data.length < 1000) throw new FormError(422, "Upload a WOFF2, WOFF, TTF or OTF font file.");
      if (data.length > 600 * 1024) throw new FormError(413, "Fonts must be 600 KB or smaller. WOFF2 files are usually the smallest.");
      res.json({ form: store.setFont(form.id, mime, data, req.body?.name, admin.email) });
    }));

    const filtersOf = req => {
      const time = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);
      const fields = Object.fromEntries(Object.entries(req.query).filter(([key, value]) => key.startsWith("f.") && typeof value === "string").map(([key, value]) => [key.slice(2), value]));
      return { status: req.query.status, state: req.query.state === "*" ? "" : req.query.state || undefined, district: typeof req.query.district === "string" ? req.query.district : undefined, link: req.query.link, device: req.query.device, q: typeof req.query.q === "string" ? req.query.q.trim() : "", from: time(req.query.from), to: time(req.query.to), sort: req.query.sort, fields };
    };
    app.get("/api/admin/forms/:id/responses", wrap(async (req, res) => {
      const { form } = await formFor(req, "responses.read");
      const rows = store.query(form.id, filtersOf(req)), size = 50, page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
      res.json({ total: rows.length, page, pageSize: size, responses: rows.slice((page - 1) * size, page * size), states: [...new Set(store.query(form.id).map(row => row.state).filter(Boolean))].sort() });
    }));
    app.patch("/api/admin/forms/:id/responses", wrap(async (req, res) => {
      const body = req.body ?? {}, ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === "string") : [];
      if (!ids.length) throw new FormError(422, "Select at least one response.");
      if (body.status !== undefined) { const { admin, form } = await formFor(req, "responses.review"); const changed = store.review(form.id, ids, body.status, admin.email, body.note); afterReview(form, changed, admin.email); return res.json({ updated: changed.map(change => change.after) }); }
      const { admin, form } = await formFor(req, "responses.review"); const updated = store.setNote(form.id, ids[0], String(body.note ?? ""), admin.email); void quiet(syncResponse(form, updated)); res.json({ updated: [updated] });
    }));
    app.delete("/api/admin/forms/:id/responses", wrap(async (req, res) => {
      const { admin, form } = await formFor(req, "responses.delete"), ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === "string") : [];
      const doomed = ids.map(id => store.response(form.id, id)).filter(Boolean), removed = store.deleteResponses(form.id, ids, admin.email);
      for (const response of doomed) if (removed.includes(response.id)) void quiet(r2.remove(responseKey(form, response)));
      res.json({ removed });
    }));
    app.get("/api/admin/forms/:id/export", wrap(async (req, res) => {
      const { admin, form } = await formFor(req, "responses.export"), rows = store.query(form.id, { ...filtersOf(req), sort: "oldest" }), stamp = new Date(store.time()).toISOString().slice(0, 10);
      store.audit(admin.email, "response.export", form.title, `${rows.length} rows · ${req.query.format === "json" ? "json" : "csv"}`);
      if (req.query.format === "json") return res.set({ "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${form.slug}-${stamp}.json"` }).send(JSON.stringify({ form: { id: form.id, slug: form.slug, title: form.title, schema: form.schema }, exportedAt: new Date(store.time()).toISOString(), responses: rows }, null, 2));
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${form.slug}-${stamp}.csv"` }).send(store.csv(form, rows));
    }));
    app.post("/api/admin/forms/:id/backup", wrap(async (req, res) => {
      const { admin, form } = await formFor(req, "responses.export"), rows = store.query(form.id, { sort: "oldest" }), stamp = new Date(store.time()).toISOString().replace(/[:.]/g, "-");
      const snapshot = JSON.stringify({ form, exportedAt: new Date(store.time()).toISOString(), responses: rows }, null, 2), caption = `<b>${telegram.escapeHTML(form.title)}</b> · full backup\n${rows.length} responses · by ${telegram.escapeHTML(admin.email)}`;
      const sentJson = telegram.configured() ? await quiet(telegram.document(`${form.slug}-backup-${stamp}.json`, snapshot, caption)) : false;
      const sentCsv = telegram.configured() ? await quiet(telegram.document(`${form.slug}-backup-${stamp}.csv`, store.csv(form, rows), caption, "text/csv")) : false;
      const stored = r2.enabled ? await quiet(r2.put(`${form.id}/snapshots/${stamp}.json`, snapshot)) : false;
      if (r2.enabled) await syncPending();
      store.audit(admin.email, "backup.run", form.title, `telegram:${sentJson && sentCsv ? "sent" : "no"} r2:${stored ? "stored" : "no"}`);
      res.json({ responses: rows.length, telegram: !!(sentJson && sentCsv), r2: !!stored, telegramConfigured: telegram.configured(), r2Enabled: r2.enabled });
    }));
    app.get("/api/admin/forms/:id/places", wrap(async (req, res) => {
      const { form } = await formFor(req, "insights.read"), filters = filtersOf(req);
      res.json(store.places(form, { from: filters.from, to: filters.to }));
    }));
    app.get("/api/admin/forms/:id/insights", wrap(async (req, res) => { const { form } = await formFor(req, "insights.read"), filters = filtersOf(req); res.json(store.insights(form, { from: filters.from, to: filters.to })); }));
    app.get("/api/admin/forms/:id/links", wrap(async (req, res) => { const { form } = await formFor(req, "forms.read"); res.json({ ...store.links(form.id), origin, slug: form.slug }); }));
    app.post("/api/admin/forms/:id/links", wrap(async (req, res) => { const { admin, form } = await formFor(req, "links.manage"); res.status(201).json({ code: store.saveLink(form.id, req.body ?? {}, admin.email) }); }));
    app.delete("/api/admin/forms/:id/links/:code", wrap(async (req, res) => { const { form } = await formFor(req, "links.manage"); res.json({ ok: store.deleteLink(form.id, String(req.params.code)) }); }));

    // ----- team -----
    app.get("/api/admin/team", wrap(async (req, res) => { const admin = await adminOf(req); admin.need("team.manage"); res.json({ owners: settings.adminEmails ?? [], members: store.members(), audit: store.auditLog() }); }));
    app.put("/api/admin/team", wrap(async (req, res) => {
      const admin = await adminOf(req); admin.need("team.manage");
      const email = String(req.body?.email ?? "").toLowerCase().trim();
      if ((settings.adminEmails ?? []).includes(email)) throw new FormError(422, "That address is already an owner with full access.");
      // Only an owner can hand out the right to manage admins.
      if (!admin.owner && (req.body?.permissions ?? []).includes("team.manage")) throw new FormError(403, "Only an owner can let someone else manage admins.");
      res.json({ member: store.saveMember(req.body, admin.email) });
    }));
    app.delete("/api/admin/team/:email", wrap(async (req, res) => { const admin = await adminOf(req); admin.need("team.manage"); const target = store.member(String(req.params.email)); if (!admin.owner && target?.permissions.includes("team.manage")) throw new FormError(403, "Only an owner can remove this admin."); res.json({ ok: store.removeMember(String(req.params.email), admin.email) }); }));

    // ----- settings -----
    const settingsView = () => {
      const saved = store.getSetting("tg.botToken"), token = saved || settings.botToken || "";
      return { telegram: { tokenSource: saved ? "console" : token ? "server" : "none", tokenHint: token ? `…${token.slice(-4)}` : "", botUsername: saved ? store.getSetting("tg.botUsername") ?? "" : "", backupChat: store.getSetting("tg.backupChat") ?? "", backupThread: store.getSetting("tg.backupThread") ?? "", notifyOnSubmit: flag("tg.notifyOnSubmit"), dmOnDecision: flag("tg.dmOnDecision"), webAppUrl: origin },
        email: { available: !!accounts.enabled, onDecision: flag("mail.onDecision") },
        r2: { enabled: r2.enabled, bucket: r2.enabled ? r2.bucket : "", reason: r2.reason, waiting: r2.enabled ? store.unsynced(500).length : 0 } };
    };
    app.get("/api/admin/settings", wrap(async (req, res) => { const admin = await adminOf(req); admin.need("settings.manage"); res.json(settingsView()); }));
    app.put("/api/admin/settings", wrap(async (req, res) => {
      const admin = await adminOf(req); admin.need("settings.manage"); const body = req.body ?? {};
      if (typeof body.botToken === "string") {
        const token = body.botToken.trim();
        if (!token) { store.setSetting("tg.botToken", null); store.setSetting("tg.botUsername", null); }
        else {
          if (!TOKEN.test(token)) throw new FormError(422, "That doesn't look like a bot token. Copy it from @BotFather; it looks like 123456789:AA….");
          let bot; try { bot = await telegram.me(token); } catch { throw new FormError(422, "Telegram rejected this bot token. Check it with @BotFather and try again."); }
          store.setSetting("tg.botToken", token); store.setSetting("tg.botUsername", bot?.username ?? "");
        }
      }
      if (body.backupChat !== undefined) { const chat = String(body.backupChat).trim(); if (chat && !/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(chat)) throw new FormError(422, "Use the channel's numeric ID (like -1001234567890) or its @username."); store.setSetting("tg.backupChat", chat || null); }
      if (body.backupThread !== undefined) { const thread = String(body.backupThread).trim(); if (thread && !/^\d{1,12}$/.test(thread)) throw new FormError(422, "The topic ID is a number. Leave it empty for channels and groups without topics."); store.setSetting("tg.backupThread", thread || null); }
      for (const key of ["notifyOnSubmit", "dmOnDecision"]) if (typeof body[key] === "boolean") store.setSetting(`tg.${key}`, body[key] ? "1" : "0");
      if (typeof body.emailOnDecision === "boolean") store.setSetting("mail.onDecision", body.emailOnDecision ? "1" : "0");
      store.audit(admin.email, "settings.update", "Telegram");
      res.json(settingsView());
    }));
    app.post("/api/admin/settings/telegram-test", wrap(async (req, res) => {
      const admin = await adminOf(req); admin.need("settings.manage");
      if (!telegram.configured()) throw new FormError(422, "Add a bot token and a backup channel first.");
      try { await telegram.message(`<b>VN forms</b> · test message\nBackups for form responses will arrive here. Sent by ${telegram.escapeHTML(admin.email)}.`); }
      catch (error) { throw new FormError(502, `Telegram couldn't deliver the test: ${String(error.message).slice(0, 160)}. Make sure the bot is an admin of the channel.`); }
      res.json({ ok: true });
    }));
    app.post("/api/admin/settings/telegram-menu", wrap(async (req, res) => {
      const admin = await adminOf(req); admin.need("settings.manage");
      if (!telegramConfig().botToken) throw new FormError(422, "Add a bot token first.");
      if (!origin.startsWith("https://")) throw new FormError(422, "Telegram web apps need an https address. Set this up on the live site.");
      try { await telegram.call("setChatMenuButton", { menu_button: { type: "web_app", text: "Open Vidurneeti", web_app: { url: `${origin}/` } } }); }
      catch (error) { throw new FormError(502, `Telegram couldn't set the menu button: ${String(error.message).slice(0, 160)}`); }
      store.audit(admin.email, "settings.update", "Telegram web app button");
      res.json({ ok: true });
    }));
  }
  return { store, r2, telegram, mount, botReply, siteAdmin, anyAdmin, hasPermission, syncPending, close: () => { if (timer) clearInterval(timer); } };
}
export { FormError };

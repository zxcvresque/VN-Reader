import { randomBytes, randomUUID, createHash } from "node:crypto";
import { allFields, displayAnswer, isEmpty, normalizeSchema, validateAnswers, CHOICE_TYPES, INDIA_STATES, isEmailAddress } from "./formLogic.mjs";
import { GROUNDWORK_FORM } from "./formsSeed.mjs";

export class FormError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

export const PERMISSIONS = [
  { id: "forms.read", label: "View forms", group: "Forms" },
  { id: "forms.write", label: "Create and edit forms", group: "Forms" },
  { id: "links.manage", label: "Manage share links and QR codes", group: "Forms" },
  { id: "responses.read", label: "View responses", group: "Responses" },
  { id: "responses.review", label: "Approve and reject responses", group: "Responses" },
  { id: "responses.export", label: "Export and back up responses", group: "Responses" },
  { id: "responses.delete", label: "Delete responses", group: "Responses" },
  { id: "insights.read", label: "View statistics and insights", group: "Insights" },
  { id: "site.read", label: "View reader activity and storage", group: "Site" },
  { id: "settings.manage", label: "Change Telegram and backup settings", group: "Site" },
  { id: "team.manage", label: "Add and remove admins", group: "Site" }
];
export const ROLE_PRESETS = {
  viewer: ["forms.read", "responses.read", "insights.read"],
  analyst: ["forms.read", "responses.read", "responses.export", "insights.read"],
  reviewer: ["forms.read", "responses.read", "responses.review", "insights.read"],
  editor: ["forms.read", "forms.write", "links.manage", "responses.read", "responses.review", "responses.export", "insights.read"],
  manager: PERMISSIONS.map(permission => permission.id).filter(id => id !== "team.manage")
};
const PERMISSION_IDS = new Set(PERMISSIONS.map(permission => permission.id));
const STATUSES = ["pending", "approved", "rejected"];
const FONTS = ["aspekta", "system", "serif", "rounded", "mono", "humanist", "custom"];
const sha = value => createHash("sha256").update(value).digest("hex");
const clip = (value, limit) => (typeof value === "string" ? value : "").replace(/\u0000/g, "").trim().slice(0, limit);
const slugOk = value => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const httpUrl = value => { try { const url = new URL(clip(value, 500)); return ["https:", "http:", "tg:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } };

export function normalizeSettings(input = {}) {
  const reward = input.reward ?? {}, confirmation = input.confirmation ?? {};
  const date = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
  const limit = Number(input.responseLimit);
  return {
    access: input.access === "account" ? "account" : "public",
    oneResponse: ["none", "device", "account"].includes(input.oneResponse) ? input.oneResponse : "none",
    requireApproval: input.requireApproval !== false,
    showProgress: input.showProgress !== false,
    reward: { enabled: !!reward.enabled && !!httpUrl(reward.url), label: clip(reward.label, 80) || "Your link", url: httpUrl(reward.url) },
    confirmation: { title: clip(confirmation.title, 140) || "Thank you. Your response is in.", message: clip(confirmation.message, 1200) },
    approvedMessage: clip(input.approvedMessage, 600),
    rejectedMessage: clip(input.rejectedMessage, 600),
    closedMessage: clip(input.closedMessage, 600),
    opensAt: date(input.opensAt), closesAt: date(input.closesAt),
    responseLimit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    notifyTelegram: input.notifyTelegram !== false,
    timezone: clip(input.timezone, 60) || "Asia/Kolkata"
  };
}
export function normalizeTheme(input = {}) {
  const radius = Number(input.radius);
  return {
    accent: /^#[0-9a-fA-F]{6}$/.test(input.accent ?? "") ? input.accent.toLowerCase() : "#f2a23a",
    font: FONTS.includes(input.font) ? input.font : "aspekta",
    surface: ["glass", "solid", "paper"].includes(input.surface) ? input.surface : "glass",
    mode: ["auto", "light", "dark"].includes(input.mode) ? input.mode : "auto",
    backdrop: ["mono", "aurora", "saffron", "ocean", "emerald", "dawn", "ink", "plain"].includes(input.backdrop) ? input.backdrop : "mono",
    radius: Number.isFinite(radius) ? Math.min(32, Math.max(0, Math.round(radius))) : 22,
    layout: input.layout === "focus" ? "focus" : "classic",
    submitLabel: clip(input.submitLabel, 40) || "Submit response",
    fontName: clip(input.fontName, 80)
  };
}

const STOP = new Set("the and for that this with you your are was have has from not but can will all any our out who what when how why they them his her their its about into than then there been being were had more most some such very just also over only own same too did does doing would could should to of in on at by an a is it i me my we us as be or if so no yes do am im ka ki ke ko hai hain se me mein aur par bhi nahi ho hu hoon tha thi the kya jo ek ye yeh wo woh na hi to".split(" "));

export class FormsStore {
  constructor(database, { now = () => new Date() } = {}) {
    this.database = database; this.now = now;
    database.exec(`
      CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft', schema TEXT NOT NULL, settings TEXT NOT NULL, theme TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT);
      CREATE TABLE IF NOT EXISTS form_responses (id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        receipt_hash TEXT NOT NULL UNIQUE, user_id TEXT, status TEXT NOT NULL, answers TEXT NOT NULL, state TEXT, link TEXT, device TEXT,
        duration_ms INTEGER, tg_user_id TEXT, tg_username TEXT, note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, synced_at INTEGER);
      CREATE INDEX IF NOT EXISTS form_responses_form ON form_responses(form_id, created_at);
      CREATE INDEX IF NOT EXISTS form_responses_user ON form_responses(form_id, user_id);
      CREATE TABLE IF NOT EXISTS form_events (form_id TEXT NOT NULL, day TEXT NOT NULL, link TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(form_id, day, link, kind));
      CREATE TABLE IF NOT EXISTS form_links (code TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, label TEXT NOT NULL,
        prefill TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, created_by TEXT);
      CREATE TABLE IF NOT EXISTS form_fonts (form_id TEXT PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_members (email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL, form_ids TEXT,
        active INTEGER NOT NULL DEFAULT 1, added_by TEXT, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS form_telegram_links (
        code_hash TEXT PRIMARY KEY, poll_hash TEXT NOT NULL UNIQUE, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, user_id TEXT, username TEXT
      );
      CREATE INDEX IF NOT EXISTS form_telegram_links_expiry ON form_telegram_links(expires_at);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);`);
    // Columns added after the first release are appended so existing databases upgrade in place.
    const columns = new Set(database.prepare("PRAGMA table_info(form_responses)").all().map(column => column.name));
    for (const [name, type] of [["notify_email", "TEXT"], ["bind_hash", "TEXT"], ["bind_expires", "INTEGER"]]) if (!columns.has(name)) database.exec(`ALTER TABLE form_responses ADD COLUMN ${name} ${type}`);
    database.exec("CREATE INDEX IF NOT EXISTS form_responses_tg ON form_responses(tg_user_id)");
    if (!this.getSetting("forms.seeded")) {
      if (!database.prepare("SELECT id FROM forms WHERE slug=?").get(GROUNDWORK_FORM.slug)) this.createForm(GROUNDWORK_FORM, "system");
      this.setSetting("forms.seeded", "1");
    }
    if (!this.getSetting("forms.groundwork-contact")) {
      const row = database.prepare("SELECT id,schema FROM forms WHERE slug=?").get(GROUNDWORK_FORM.slug);
      if (row) {
        const schema = parse(row.schema, { pages: [] });
        const defaults = new Map(allFields(GROUNDWORK_FORM.schema).map(field => [field.id, field]));
        const hasState = allFields(schema).some(field => field.id === "gw_state" && field.type === "state");
        const hasLocality = allFields(schema).some(field => field.id === "gw_locality");
        for (const page of schema.pages) {
          page.fields = page.fields.flatMap(field => {
            if (field.type === "short" && field.id === "gw_district" && hasState) {
              const district = { ...field, type: "district", stateField: "gw_state" };
              return hasLocality ? [district] : [district, defaults.get("gw_locality")];
            }
            if (field.type === "short" && field.id === "gw_telegram") {
              const { validation, placeholder, ...rest } = field;
              return [{ ...rest, type: "telegram", label: defaults.get(field.id).label, help: undefined }];
            }
            if (field.type === "short" && field.id === "gw_social") {
              const social = defaults.get(field.id);
              return [{ ...field, type: social.type, label: social.label, help: social.help }];
            }
            return [field];
          });
        }
        database.prepare("UPDATE forms SET schema=? WHERE id=?").run(JSON.stringify(schema), row.id);
      }
      this.setSetting("forms.groundwork-contact", "1");
    }
  }
  time() { return this.now().getTime(); }
  day(time, timezone = "Asia/Kolkata") {
    let formatter;
    try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }); }
    catch { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }); }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) };
  }

  // ----- settings, audit -----
  getSetting(key) { return this.database.prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value ?? null; }
  setSetting(key, value) {
    if (value === null || value === "") this.database.prepare("DELETE FROM app_settings WHERE key=?").run(key);
    else this.database.prepare("INSERT INTO app_settings VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, String(value), this.time());
  }
  audit(actor, action, target = "", detail = "") { this.database.prepare("INSERT INTO admin_audit (at,actor,action,target,detail) VALUES (?,?,?,?,?)").run(this.time(), actor ?? "system", action, target, clip(detail, 300)); }
  auditLog(limit = 60) { return this.database.prepare("SELECT at,actor,action,target,detail FROM admin_audit ORDER BY id DESC LIMIT ?").all(limit).map(row => ({ ...row, at: new Date(row.at).toISOString() })); }

  // ----- team -----
  members() { return this.database.prepare("SELECT * FROM admin_members ORDER BY added_at").all().map(row => this.memberRow(row)); }
  memberRow(row) { return { email: row.email, name: row.name, permissions: parse(row.permissions, []).filter(id => PERMISSION_IDS.has(id)), formIds: row.form_ids ? parse(row.form_ids, null) : null, active: !!row.active, addedBy: row.added_by, addedAt: new Date(row.added_at).toISOString() }; }
  member(email) { const row = this.database.prepare("SELECT * FROM admin_members WHERE email=?").get(String(email ?? "").toLowerCase()); return row ? this.memberRow(row) : null; }
  saveMember(input, actor) {
    const email = clip(input?.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FormError(422, "Enter a valid email address for the admin.");
    const permissions = [...new Set((Array.isArray(input.permissions) ? input.permissions : []).filter(id => PERMISSION_IDS.has(id)))];
    if (!permissions.length) throw new FormError(422, "Choose at least one permission.");
    const formIds = Array.isArray(input.formIds) && input.formIds.length ? JSON.stringify(input.formIds.filter(id => typeof id === "string").slice(0, 200)) : null;
    const time = this.time();
    this.database.prepare(`INSERT INTO admin_members VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,form_ids=excluded.form_ids,active=excluded.active,updated_at=excluded.updated_at`)
      .run(email, clip(input.name, 80), JSON.stringify(permissions), formIds, input.active === false ? 0 : 1, actor, time, time);
    this.audit(actor, "team.save", email, permissions.join(", "));
    return this.member(email);
  }
  removeMember(email, actor) { const changes = this.database.prepare("DELETE FROM admin_members WHERE email=?").run(String(email).toLowerCase()).changes; if (changes) this.audit(actor, "team.remove", email); return !!changes; }

  // ----- forms -----
  formRow(row) { return row && { id: row.id, slug: row.slug, title: row.title, description: row.description, status: row.status, schema: parse(row.schema, { pages: [] }), settings: normalizeSettings(parse(row.settings, {})), theme: normalizeTheme(parse(row.theme, {})), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
  form(id) { return this.formRow(this.database.prepare("SELECT * FROM forms WHERE id=?").get(id)); }
  formBySlug(slug) { return this.formRow(this.database.prepare("SELECT * FROM forms WHERE slug=?").get(slug)); }
  forms() {
    const counts = new Map(this.database.prepare("SELECT form_id,status,COUNT(*) AS count,MAX(created_at) AS latest FROM form_responses GROUP BY form_id,status").all().reduce((map, row) => { const entry = map.get(row.form_id) ?? { total: 0, pending: 0, approved: 0, rejected: 0, latest: 0 }; entry[row.status] = row.count; entry.total += row.count; entry.latest = Math.max(entry.latest, row.latest); return map.set(row.form_id, entry); }, new Map()));
    return this.database.prepare("SELECT * FROM forms ORDER BY updated_at DESC").all().map(row => { const form = this.formRow(row), count = counts.get(row.id) ?? { total: 0, pending: 0, approved: 0, rejected: 0, latest: 0 }; return { id: form.id, slug: form.slug, title: form.title, description: form.description, status: form.status, updatedAt: form.updatedAt, questions: allFields(form.schema).filter(field => field.type !== "statement").length, accent: form.theme.accent, counts: { ...count, latest: count.latest ? new Date(count.latest).toISOString() : null } }; });
  }
  uniqueSlug(base, ignoreId) {
    let slug = clip(base, 48).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "form";
    if (["admin", "api", "assets", "new"].includes(slug)) slug = `${slug}-form`;
    for (let n = 1, candidate = slug; ; candidate = `${slug.slice(0, 44)}-${++n}`) {
      const row = this.database.prepare("SELECT id FROM forms WHERE slug=?").get(candidate);
      if (!row || row.id === ignoreId) return candidate;
    }
  }
  createForm(input, actor) {
    const title = clip(input?.title, 140) || "Untitled form";
    const schema = normalizeSchema(input?.schema ?? { pages: [{ title: "", fields: [{ type: "short", label: "Your name", required: true }] }] });
    const id = randomUUID(), time = this.time(), slug = this.uniqueSlug(slugOk(input?.slug) ? input.slug : title);
    this.database.prepare("INSERT INTO forms VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, slug, title, clip(input?.description, 2000), ["live", "closed"].includes(input?.status) ? input.status : "draft", JSON.stringify(schema), JSON.stringify(normalizeSettings(input?.settings)), JSON.stringify(normalizeTheme(input?.theme)), time, time, actor ?? null);
    this.audit(actor, "form.create", title);
    return this.form(id);
  }
  updateForm(id, input, actor) {
    const current = this.form(id); if (!current) throw new FormError(404, "This form no longer exists.");
    let slug = current.slug;
    if (input.slug !== undefined && input.slug !== current.slug) {
      if (!slugOk(input.slug)) throw new FormError(422, "Use lowercase letters, numbers and hyphens for the link name.");
      if (this.uniqueSlug(input.slug, id) !== input.slug) throw new FormError(409, "Another form already uses that link name.");
      slug = input.slug;
    }
    let schema = current.schema;
    if (input.schema !== undefined) { try { schema = normalizeSchema(input.schema); } catch (error) { throw new FormError(422, error.message); } }
    const next = { title: input.title !== undefined ? clip(input.title, 140) || "Untitled form" : current.title, description: input.description !== undefined ? clip(input.description, 2000) : current.description,
      status: ["draft", "live", "closed"].includes(input.status) ? input.status : current.status, settings: input.settings !== undefined ? normalizeSettings(input.settings) : current.settings, theme: input.theme !== undefined ? normalizeTheme({ ...input.theme, fontName: input.theme.fontName ?? current.theme.fontName }) : current.theme };
    this.database.prepare("UPDATE forms SET slug=?,title=?,description=?,status=?,schema=?,settings=?,theme=?,updated_at=? WHERE id=?").run(slug, next.title, next.description, next.status, JSON.stringify(schema), JSON.stringify(next.settings), JSON.stringify(next.theme), this.time(), id);
    this.audit(actor, next.status !== current.status ? `form.${next.status}` : "form.update", next.title);
    return this.form(id);
  }
  duplicateForm(id, actor) { const form = this.form(id); if (!form) throw new FormError(404, "This form no longer exists."); return this.createForm({ ...form, slug: undefined, title: `${form.title} (copy)`, status: "draft" }, actor); }
  deleteForm(id, actor) { const form = this.form(id); if (!form) return false; this.database.prepare("DELETE FROM form_events WHERE form_id=?").run(id); this.database.prepare("DELETE FROM forms WHERE id=?").run(id); this.audit(actor, "form.delete", form.title); return true; }
  setFont(id, mime, data, name, actor) {
    const form = this.form(id); if (!form) throw new FormError(404, "This form no longer exists.");
    this.database.prepare("INSERT INTO form_fonts VALUES (?,?,?,?) ON CONFLICT(form_id) DO UPDATE SET mime=excluded.mime,data=excluded.data,updated_at=excluded.updated_at").run(id, mime, data, this.time());
    return this.updateForm(id, { theme: { ...form.theme, font: "custom", fontName: clip(name, 80) || "Custom font" } }, actor);
  }
  font(id) { return this.database.prepare("SELECT mime,data,updated_at FROM form_fonts WHERE form_id=?").get(id); }

  /** What a respondent's browser may know about a form. Never includes the gated link. */
  publicForm(form) {
    const now = this.time(), { settings } = form;
    let availability = form.status === "live" ? "open" : form.status === "closed" ? "closed" : "draft";
    if (availability === "open" && settings.opensAt && now < Date.parse(settings.opensAt)) availability = "soon";
    if (availability === "open" && settings.closesAt && now >= Date.parse(settings.closesAt)) availability = "closed";
    if (availability === "open" && settings.responseLimit && this.count(form.id) >= settings.responseLimit) availability = "full";
    return { slug: form.slug, title: form.title, description: form.description, availability, schema: form.schema, theme: { ...form.theme, hasCustomFont: form.theme.font === "custom" && !!this.font(form.id) },
      settings: { access: settings.access, oneResponse: settings.oneResponse, requireApproval: settings.requireApproval, showProgress: settings.showProgress, closedMessage: settings.closedMessage, opensAt: settings.opensAt, hasReward: settings.reward.enabled, rewardLabel: settings.reward.enabled ? settings.reward.label : "" } };
  }
  count(formId) { return Number(this.database.prepare("SELECT COUNT(*) AS count FROM form_responses WHERE form_id=?").get(formId).count); }

  // ----- events and links -----
  track(formId, kind, link = "", timezone) {
    if (!["view", "start"].includes(kind)) return;
    this.database.prepare("INSERT INTO form_events VALUES (?,?,?,?,1) ON CONFLICT(form_id,day,link,kind) DO UPDATE SET count=count+1").run(formId, this.day(this.time(), timezone).day, this.linkCode(formId, link), kind);
  }
  linkCode(formId, code) { return typeof code === "string" && code && this.database.prepare("SELECT code FROM form_links WHERE code=? AND form_id=? AND active=1").get(code, formId) ? code : ""; }
  links(formId) {
    const events = this.database.prepare("SELECT link,kind,SUM(count) AS count FROM form_events WHERE form_id=? GROUP BY link,kind").all(formId);
    const responses = this.database.prepare("SELECT COALESCE(link,'') AS link,COUNT(*) AS count FROM form_responses WHERE form_id=? GROUP BY COALESCE(link,'')").all(formId);
    const stat = code => ({ views: events.find(e => e.link === code && e.kind === "view")?.count ?? 0, starts: events.find(e => e.link === code && e.kind === "start")?.count ?? 0, responses: responses.find(r => r.link === code)?.count ?? 0 });
    return { direct: stat(""), links: this.database.prepare("SELECT * FROM form_links WHERE form_id=? ORDER BY created_at DESC").all(formId).map(row => ({ code: row.code, label: row.label, prefill: parse(row.prefill, {}), active: !!row.active, createdAt: new Date(row.created_at).toISOString(), ...stat(row.code) })) };
  }
  link(code) { const row = this.database.prepare("SELECT * FROM form_links WHERE code=? AND active=1").get(code); return row ? { code: row.code, formId: row.form_id, label: row.label, prefill: parse(row.prefill, {}) } : null; }
  saveLink(formId, input, actor) {
    const form = this.form(formId); if (!form) throw new FormError(404, "This form no longer exists.");
    const label = clip(input?.label, 80); if (!label) throw new FormError(422, "Give the link a name, like “WhatsApp groups” or “Delhi meetup poster”.");
    let code = clip(input?.code, 40).toLowerCase();
    if (code && !slugOk(code)) throw new FormError(422, "Use lowercase letters, numbers and hyphens for the custom link.");
    const fieldIds = new Set(allFields(form.schema).map(field => field.id));
    const prefill = Object.fromEntries(Object.entries(input?.prefill ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string" && value).slice(0, 20).map(([key, value]) => [key, clip(value, 300)]));
    if (input?.existing) {
      const changes = this.database.prepare("UPDATE form_links SET label=?,prefill=?,active=? WHERE code=? AND form_id=?").run(label, JSON.stringify(prefill), input.active === false ? 0 : 1, input.existing, formId).changes;
      if (!changes) throw new FormError(404, "That link no longer exists.");
      return input.existing;
    }
    if (!code) do { code = randomBytes(4).toString("hex"); } while (this.database.prepare("SELECT code FROM form_links WHERE code=?").get(code));
    else if (this.database.prepare("SELECT code FROM form_links WHERE code=?").get(code)) throw new FormError(409, "That custom link is already taken. Try another.");
    this.database.prepare("INSERT INTO form_links VALUES (?,?,?,?,1,?,?)").run(code, formId, label, JSON.stringify(prefill), this.time(), actor ?? null);
    this.audit(actor, "link.create", `${form.title} · ${label}`);
    return code;
  }
  deleteLink(formId, code) { return !!this.database.prepare("DELETE FROM form_links WHERE code=? AND form_id=?").run(code, formId).changes; }

  // ----- responses -----
  responseRow(row, withAnswers = true) {
    return row && { id: row.id, formId: row.form_id, status: row.status, state: row.state, link: row.link ?? "", device: row.device ?? "", durationMs: row.duration_ms, telegram: row.tg_user_id ? { id: row.tg_user_id, username: row.tg_username } : null, hasAccount: !!row.user_id,
      notifyEmail: row.notify_email ?? "", note: row.note ?? "", reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null, createdAt: new Date(row.created_at).toISOString(), synced: !!row.synced_at, ...(withAnswers ? { answers: parse(row.answers, {}) } : {}) };
  }
  submit(form, { answers, userId = null, link = "", device = "", durationMs = null, telegram = null }) {
    const available = this.publicForm(form).availability;
    if (available !== "open") throw new FormError(409, available === "full" ? "This form has reached its response limit." : "This form isn't accepting responses right now.");
    if (form.settings.access === "account" && !userId) throw new FormError(401, "Sign in to your Vidurneeti account to fill this form.");
    if (form.settings.oneResponse === "account" && userId && this.database.prepare("SELECT id FROM form_responses WHERE form_id=? AND user_id=?").get(form.id, userId)) throw new FormError(409, "You've already filled this form with this account.");
    const input = { ...(answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {}) };
    const fields = allFields(form.schema);
    const result = validateAnswers(form.schema, input);
    const telegramFields = fields.filter(field => field.type === "telegram");
    const enteredIds = telegramFields.filter(field => result.clean[field.id] !== undefined);
    for (const field of enteredIds) {
      if (result.clean[field.id] !== telegram?.id) {
        result.errors[field.id] = telegram?.id
          ? "Paste the same Telegram user ID the bot sent you."
          : "Open Telegram from this form and tap Start to verify your user ID.";
      }
    }
    if (Object.keys(result.errors).length) throw new FormError(422, "Some answers need attention.", { errors: result.errors });
    if (telegramFields.length && !enteredIds.length) telegram = null;
    const stateField = fields.find(field => field.role === "state") ?? fields.find(field => field.type === "state");
    const state = stateField ? displayAnswer(stateField, result.clean[stateField.id]) || null : null;
    const id = randomUUID(), receipt = randomBytes(24).toString("base64url"), time = this.time();
    const status = form.settings.requireApproval ? "pending" : "approved";
    this.database.prepare("INSERT INTO form_responses (id,form_id,receipt_hash,user_id,status,answers,state,link,device,duration_ms,tg_user_id,tg_username,note,reviewed_by,reviewed_at,created_at,updated_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, form.id, sha(receipt), userId, status, JSON.stringify(result.clean), state, this.linkCode(form.id, link) || null, clip(device, 12) || null,
      Number.isSafeInteger(durationMs) && durationMs > 0 ? Math.min(durationMs, 86400000) : null, telegram?.id ? String(telegram.id) : null, telegram?.username ? clip(telegram.username, 40) : null, null, null, null, time, time, null);
    return { receipt, response: this.response(form.id, id) };
  }
  response(formId, id) { return this.responseRow(this.database.prepare("SELECT * FROM form_responses WHERE id=? AND form_id=?").get(id, formId)); }
  byReceipt(formId, receipt) { return typeof receipt === "string" && receipt.length >= 20 && receipt.length <= 80 ? this.responseRow(this.database.prepare("SELECT * FROM form_responses WHERE receipt_hash=? AND form_id=?").get(sha(receipt), formId)) : null; }
  byUser(formId, userId) { return userId ? this.responseRow(this.database.prepare("SELECT * FROM form_responses WHERE form_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(formId, userId)) : null; }
  /** Status a respondent may see. The gated link is included only once approved. */
  outcome(form, response) {
    const { settings } = form, approved = response.status === "approved";
    const [mailbox, domain = ""] = (response.notifyEmail ?? "").split("@");
    return { status: response.status, submittedAt: response.createdAt, title: settings.confirmation.title,
      notify: { telegram: !!response.telegram, email: mailbox ? `${mailbox.slice(0, 2)}…@${domain}` : "" },
      message: approved ? settings.approvedMessage || settings.confirmation.message : response.status === "rejected" ? settings.rejectedMessage || "This response wasn't approved." : settings.confirmation.message,
      reward: settings.reward.enabled ? (approved ? { label: settings.reward.label, url: settings.reward.url } : { label: settings.reward.label, url: null }) : null };
  }
  // ----- status updates: Telegram binding and email -----
  setNotifyEmail(formId, id, email) {
    const clean = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (clean && !isEmailAddress(clean)) throw new FormError(422, "Enter a valid email address.");
    this.database.prepare("UPDATE form_responses SET notify_email=?,updated_at=?,synced_at=NULL WHERE id=? AND form_id=?").run(clean || null, this.time(), id, formId);
    return this.response(formId, id);
  }
  createTelegramLink(formId) {
    const code = randomBytes(18).toString("base64url"), key = randomBytes(24).toString("base64url"), now = this.time();
    this.database.prepare("DELETE FROM form_telegram_links WHERE expires_at<=?").run(now);
    this.database.prepare("INSERT INTO form_telegram_links (code_hash,poll_hash,form_id,expires_at) VALUES (?,?,?,?)").run(sha(code), sha(key), formId, now + 3600000);
    return { code, key };
  }
  confirmTelegramLink(code, userId, username) {
    return !!this.database.prepare("UPDATE form_telegram_links SET user_id=?,username=? WHERE code_hash=? AND expires_at>? AND user_id IS NULL")
      .run(userId, clip(username, 40) || null, sha(code), this.time()).changes;
  }
  telegramLink(formId, key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(key)) return null;
    return this.database.prepare("SELECT user_id AS id,username FROM form_telegram_links WHERE poll_hash=? AND form_id=? AND expires_at>?").get(sha(key), formId, this.time()) ?? null;
  }
  submitWithTelegramLink(form, input, key) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const telegram = this.telegramLink(form.id, key);
      if (!telegram?.id) {
        const errors = Object.fromEntries(allFields(form.schema).filter(field => field.type === "telegram")
          .map(field => [field.id, "Get a new Telegram link and tap Start in the bot."]));
        throw new FormError(422, "This Telegram link has expired or hasn't been confirmed.", { errors });
      }
      const result = this.submit(form, { ...input, telegram });
      this.database.prepare("DELETE FROM form_telegram_links WHERE poll_hash=?").run(sha(key));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  /** A short single-use code that lets one Telegram account claim this response through the bot. */
  createBind(formId, id) {
    const code = randomBytes(12).toString("base64url");
    this.database.prepare("UPDATE form_responses SET bind_hash=?,bind_expires=? WHERE id=? AND form_id=?").run(sha(code), this.time() + 3600000, id, formId);
    return code;
  }
  bindTelegram(code, userId, username = "") {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{12,32}$/.test(code) || !/^\d{3,20}$/.test(String(userId))) return null;
    const row = this.database.prepare("SELECT id,form_id FROM form_responses WHERE bind_hash=? AND bind_expires>? AND tg_user_id IS NULL").get(sha(code), this.time());
    if (!row) return null;
    this.database.prepare("UPDATE form_responses SET tg_user_id=?,tg_username=?,bind_hash=NULL,bind_expires=NULL,updated_at=?,synced_at=NULL WHERE id=?").run(String(userId), clip(username, 40) || null, this.time(), row.id);
    return this.response(row.form_id, row.id);
  }
  byTelegram(userId, limit = 5) { return /^\d{3,20}$/.test(String(userId ?? "")) ? this.database.prepare("SELECT * FROM form_responses WHERE tg_user_id=? ORDER BY created_at DESC LIMIT ?").all(String(userId), limit).map(row => this.responseRow(row)) : []; }

  query(formId, filters = {}) {
    const where = ["form_id=?"], values = [formId];
    if (STATUSES.includes(filters.status)) { where.push("status=?"); values.push(filters.status); }
    if (filters.state) { where.push("state=?"); values.push(String(filters.state)); }
    if (filters.link !== undefined && filters.link !== null && filters.link !== "") { where.push("COALESCE(link,'')=?"); values.push(filters.link === "direct" ? "" : String(filters.link)); }
    if (filters.device) { where.push("device=?"); values.push(String(filters.device)); }
    if (Number.isFinite(filters.from)) { where.push("created_at>=?"); values.push(filters.from); }
    if (Number.isFinite(filters.to)) { where.push("created_at<?"); values.push(filters.to); }
    if (filters.q) { where.push("(answers LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')"); const like = `%${String(filters.q).slice(0, 80).replace(/[\\%_]/g, "\\$&")}%`; values.push(like, like); }
    let rows = this.database.prepare(`SELECT * FROM form_responses WHERE ${where.join(" AND ")} ORDER BY created_at ${filters.sort === "oldest" ? "ASC" : "DESC"} LIMIT 50000`).all(...values).map(row => this.responseRow(row));
    const fieldFilters = Object.entries(filters.fields ?? {}).filter(([, value]) => value !== "");
    if (fieldFilters.length) rows = rows.filter(row => fieldFilters.every(([id, value]) => { const answer = row.answers[id]; return Array.isArray(answer) ? answer.includes(value) : String(answer ?? "") === value; }));
    return rows;
  }
  review(formId, ids, status, actor, note) {
    if (!STATUSES.includes(status)) throw new FormError(422, "Choose approve, reject, or pending.");
    const time = this.time(), changed = [];
    for (const id of ids.slice(0, 500)) {
      const before = this.response(formId, id); if (!before) continue;
      this.database.prepare("UPDATE form_responses SET status=?,note=COALESCE(?,note),reviewed_by=?,reviewed_at=?,updated_at=?,synced_at=NULL WHERE id=? AND form_id=?").run(status, typeof note === "string" ? clip(note, 1000) : null, actor, time, time, id, formId);
      changed.push({ before, after: this.response(formId, id) });
    }
    if (changed.length) this.audit(actor, `response.${status}`, formId, `${changed.length} response${changed.length === 1 ? "" : "s"}`);
    return changed;
  }
  setNote(formId, id, note, actor) { const changes = this.database.prepare("UPDATE form_responses SET note=?,updated_at=?,synced_at=NULL WHERE id=? AND form_id=?").run(clip(note, 1000), this.time(), id, formId).changes; if (!changes) throw new FormError(404, "That response no longer exists."); return this.response(formId, id); }
  deleteResponses(formId, ids, actor) {
    const removed = ids.slice(0, 500).filter(id => this.database.prepare("DELETE FROM form_responses WHERE id=? AND form_id=?").run(id, formId).changes);
    if (removed.length) this.audit(actor, "response.delete", formId, `${removed.length} deleted`);
    return removed;
  }
  unsynced(limit = 25) { return this.database.prepare("SELECT * FROM form_responses WHERE synced_at IS NULL ORDER BY updated_at LIMIT ?").all(limit).map(row => this.responseRow(row)); }
  markSynced(id, updatedBefore) { this.database.prepare("UPDATE form_responses SET synced_at=? WHERE id=? AND updated_at<=?").run(this.time(), id, updatedBefore); }

  /** Flat export rows: one column per question, labels resolved. */
  exportRows(form, responses) {
    const fields = allFields(form.schema).filter(field => field.type !== "statement");
    const header = ["Response ID", "Submitted (UTC)", "Status", "Reviewed by", "Note", "Link", "Device", "Telegram", ...fields.map(field => field.label)];
    const rows = responses.map(response => [response.id, response.createdAt, response.status, response.reviewedBy ?? "", response.note, response.link || "direct", response.device, response.telegram ? [response.telegram.id, response.telegram.username && `@${response.telegram.username}`].filter(Boolean).join(" ") : "", ...fields.map(field => displayAnswer(field, response.answers[field.id]))]);
    return { header, rows };
  }
  csv(form, responses) {
    const { header, rows } = this.exportRows(form, responses);
    // Prefix formula-looking cells so a spreadsheet never executes a respondent's answer.
    const cell = value => { let string = String(value ?? ""); if (/^[=+\-@\t\r]/.test(string)) string = `'${string}`; return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string; };
    return "﻿" + [header, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  // ----- insights -----
  insights(form, { from, to } = {}) {
    const timezone = form.settings.timezone, now = this.time();
    const end = Number.isFinite(to) ? to : now + 1, start = Number.isFinite(from) ? from : end - 30 * 86400000;
    const responses = this.query(form.id, { from: start, to: end, sort: "oldest" });
    const all = this.database.prepare("SELECT status,COUNT(*) AS count FROM form_responses WHERE form_id=? GROUP BY status").all(form.id);
    const startDay = this.day(start, timezone).day, endDay = this.day(end - 1, timezone).day;
    const events = this.database.prepare("SELECT day,link,kind,SUM(count) AS count FROM form_events WHERE form_id=? AND day>=? AND day<=? GROUP BY day,link,kind").all(form.id, startDay, endDay);
    const sumEvents = kind => events.filter(event => event.kind === kind).reduce((total, event) => total + event.count, 0);
    const views = sumEvents("view"), starts = Math.max(sumEvents("start"), responses.length);
    const tally = (list, key) => { const map = new Map(); for (const item of list) { const value = key(item); if (value === null || value === undefined || value === "") continue; map.set(value, (map.get(value) ?? 0) + 1); } return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count); };
    const days = []; for (let cursor = Date.parse(startDay); cursor <= Date.parse(endDay) && days.length < 400; cursor += 86400000) days.push(new Date(cursor).toISOString().slice(0, 10));
    const stamped = responses.map(response => ({ response, ...this.day(Date.parse(response.createdAt), timezone) }));
    const daily = days.map(day => ({ day, submitted: 0, approved: 0, views: events.filter(event => event.day === day && event.kind === "view").reduce((total, event) => total + event.count, 0) }));
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
    for (const item of stamped) { const index = dayIndex.get(item.day); if (index !== undefined) { daily[index].submitted++; if (item.response.status === "approved") daily[index].approved++; } hours[item.hour]++; if (item.weekday >= 0) weekdays[item.weekday]++; }
    const states = tally(responses, response => response.state).map(entry => ({ ...entry, approved: responses.filter(r => r.state === entry.name && r.status === "approved").length, pending: responses.filter(r => r.state === entry.name && r.status === "pending").length }));
    const durations = responses.map(response => response.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const median = list => (list.length ? list[Math.floor((list.length - 1) / 2)] : null);
    const linkLabels = new Map(this.links(form.id).links.map(link => [link.code, link.label]));
    const linkNames = [...new Set([...events.map(event => event.link), ...responses.map(response => response.link)])];
    const links = linkNames.map(code => ({ code, label: code ? linkLabels.get(code) ?? code : "Direct link", views: events.filter(e => e.link === code && e.kind === "view").reduce((t, e) => t + e.count, 0), starts: events.filter(e => e.link === code && e.kind === "start").reduce((t, e) => t + e.count, 0), responses: responses.filter(response => response.link === code).length })).sort((a, b) => b.responses - a.responses || b.views - a.views);

    const questions = allFields(form.schema).filter(field => field.type !== "statement").map(field => {
      const values = responses.map(response => response.answers[field.id]).filter(value => !isEmpty(value));
      const base = { id: field.id, label: field.label, type: field.type, required: !!field.required, answered: values.length, total: responses.length };
      if ([...CHOICE_TYPES, "yesno", "state", "consent"].includes(field.type)) {
        const flat = values.flat().map(value => (typeof value === "string" && value.startsWith("~") ? "Other" : displayAnswer(field, value)));
        const order = field.type === "yesno" ? ["Yes", "No"] : field.type === "state" ? null : [...(field.options ?? []).map(option => option.label), "Other"];
        let options = tally(flat.map(value => (field.type === "yesno" ? (value === "yes" ? "Yes" : "No") : value)), value => value);
        if (order) options = order.filter(label => label !== "Other" || options.some(option => option.name === "Other")).map(label => ({ name: label, count: options.find(option => option.name === label)?.count ?? 0 }));
        return { ...base, kind: "choice", options: options.slice(0, 40) };
      }
      if (["number", "scale", "rating"].includes(field.type)) {
        const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (!numbers.length) return { ...base, kind: "number", stats: null, buckets: [] };
        const min = numbers[0], max = numbers.at(-1), average = numbers.reduce((total, value) => total + value, 0) / numbers.length;
        let buckets;
        if (field.type !== "number" || max - min <= 10) buckets = Array.from({ length: max - min + 1 }, (_, index) => ({ name: String(min + index), count: numbers.filter(value => Math.round(value) === min + index).length }));
        else { const size = Math.max(1, Math.ceil((max - min + 1) / 8 / 5) * 5), first = Math.floor(min / size) * size; buckets = []; for (let low = first; low <= max; low += size) buckets.push({ name: `${low}–${low + size - 1}`, count: numbers.filter(value => value >= low && value < low + size).length }); }
        return { ...base, kind: "number", stats: { min, max, average: Math.round(average * 10) / 10, median: median(numbers) }, buckets };
      }
      const words = new Map();
      for (const value of values) for (const word of new Set(String(value).toLowerCase().match(/[\p{L}][\p{L}'-]{2,}/gu) ?? [])) if (!STOP.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
      const sensitive = ["email", "phone", "url"].includes(field.type) || ["name", "phone", "email", "telegram"].includes(field.role) || ["telegram", "social"].includes(field.type);
      return { ...base, kind: "text", averageLength: values.length ? Math.round(values.reduce((total, value) => total + String(value).length, 0) / values.length) : 0,
        topWords: sensitive ? [] : [...words].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })) };
    });

    const count = status => all.find(row => row.status === status)?.count ?? 0;
    const week = 7 * 86400000, last7 = responses.filter(r => Date.parse(r.createdAt) >= end - week).length, prev7 = this.query(form.id, { from: end - 2 * week, to: end - week }).length;
    const totals = { responses: responses.length, allTime: count("pending") + count("approved") + count("rejected"), pending: count("pending"), approved: count("approved"), rejected: count("rejected"), views, starts,
      completionRate: starts ? Math.round((responses.length / starts) * 100) : null, viewToSubmit: views ? Math.round((responses.length / views) * 100) : null, medianDurationMs: median(durations), last7, prev7,
      states: states.length, telegramLinked: responses.filter(response => response.telegram).length };
    return { range: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), timezone }, totals, daily, hours, weekdays, states, links, devices: tally(responses, response => response.device || "unknown"), questions, insights: this.smart(totals, { states, daily, hours, weekdays, questions, links, responses }) };
  }
  smart(totals, { states, daily, hours, weekdays, questions, links, responses }) {
    const out = [], add = (tone, title, detail) => out.push({ tone, title, detail });
    if (!responses.length) { add("info", "No responses in this period yet", totals.views ? `${totals.views} people opened the form. Share a custom link or QR code to see where they come from.` : "Share the form link or a QR code to start collecting responses."); return out; }
    if (totals.pending) { const oldest = responses.filter(r => r.status === "pending").map(r => Date.parse(r.createdAt)).sort((a, b) => a - b)[0]; const waiting = oldest ? Math.floor((this.time() - oldest) / 86400000) : 0; add(waiting >= 3 ? "warn" : "info", `${totals.pending} response${totals.pending === 1 ? " is" : "s are"} waiting for review`, waiting >= 1 ? `The oldest in this period has waited ${waiting} day${waiting === 1 ? "" : "s"}. People only get their link after approval.` : "People only get their link after approval."); }
    if (totals.prev7 || totals.last7) { const change = totals.prev7 ? Math.round(((totals.last7 - totals.prev7) / totals.prev7) * 100) : null; add(totals.last7 >= totals.prev7 ? "good" : "warn", change === null ? `${totals.last7} responses in the last 7 days` : `Responses are ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% week over week`, `${totals.last7} in the last 7 days against ${totals.prev7} in the 7 days before.`); }
    if (states.length) { const top = states[0], share = Math.round((top.count / responses.length) * 100), three = states.slice(0, 3).reduce((total, state) => total + state.count, 0); add("info", `${top.name} leads with ${share}% of responses`, states.length > 3 ? `The top three states account for ${Math.round((three / responses.length) * 100)}% across ${states.length} states and territories.` : `Responses come from ${states.length} state${states.length === 1 ? "" : "s"} so far.`); const missing = INDIA_STATES.length - 1 - states.filter(state => state.name !== "Outside India").length; if (missing > 0 && states.length >= 5) add("info", `${missing} states and territories have no responses yet`, "The map in Statistics shows where outreach hasn't landed."); }
    if (totals.completionRate !== null && totals.starts >= 10) add(totals.completionRate >= 60 ? "good" : "warn", `${totals.completionRate}% of people who start the form finish it`, totals.completionRate >= 60 ? "That's a healthy completion rate for a form this long." : "Consider making long-answer questions optional or splitting pages further.");
    const skipped = questions.filter(q => !q.required && q.total >= 10).map(q => ({ q, rate: 1 - q.answered / q.total })).sort((a, b) => b.rate - a.rate)[0];
    if (skipped && skipped.rate >= 0.4) add("warn", `“${skipped.q.label.slice(0, 60)}” is skipped ${Math.round(skipped.rate * 100)}% of the time`, "Rephrase it, add a hint, or drop it if the answer isn't needed.");
    const peak = hours.indexOf(Math.max(...hours)), days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], peakDay = weekdays.indexOf(Math.max(...weekdays));
    if (responses.length >= 8) add("info", `Most responses arrive around ${peak % 12 || 12}${peak < 12 ? " am" : " pm"} on ${days[peakDay]}s`, "Post reminders shortly before that window for the best pickup.");
    const best = links.filter(link => link.views >= 10 && link.code).map(link => ({ link, rate: link.responses / link.views })).sort((a, b) => b.rate - a.rate)[0];
    if (best) add("good", `“${best.link.label}” converts best`, `${Math.round(best.rate * 100)}% of its ${best.link.views} visitors submitted the form.`);
    if (totals.medianDurationMs) add("info", `A typical response takes ${Math.max(1, Math.round(totals.medianDurationMs / 60000))} min`, "Measured from the first answer to submission.");
    const busiest = [...daily].sort((a, b) => b.submitted - a.submitted)[0];
    if (busiest?.submitted >= 5 && busiest.submitted >= 3 * (responses.length / Math.max(1, daily.length))) add("info", `${busiest.day} was the busiest day with ${busiest.submitted} responses`, "Whatever went out that day worked. Worth repeating.");
    return out.slice(0, 8);
  }
}

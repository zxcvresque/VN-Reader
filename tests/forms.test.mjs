import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { createAccountApp } from "../server/accountService.mjs";
import { validateAnswers, pagePath, normalizeSchema, pipeText, INDIA_STATES, districtsFor } from "../server/formLogic.mjs";
import { signR2Request, r2FormsSettings, createTelegramForms } from "../server/formsBackup.mjs";
import { FormsStore } from "../server/formsStore.mjs";
import { GROUNDWORK_FORM } from "../server/formsSeed.mjs";

const complete = { gw_name: "Arjun Sharma", gw_age: 29, gw_gender: "male", gw_married: "no", gw_address: "12 MG Road, Pune", gw_state: "Maharashtra", gw_district: "Pune", gw_same_address: "yes", gw_profession: "Engineer", gw_whatsapp: "+91 98765 43210", gw_email: "arjun@example.com", gw_telegram: "4242", gw_dharma: "Teach and organise locally.", gw_influence: "Clearer thinking.", gw_skills: "Web development" };

test("conditional questions, skip rules and validation follow the respondent's path", () => {
  const schema = GROUNDWORK_FORM.schema;
  assert.equal(validateAnswers(schema, complete).ok, true);
  const needsPermanent = validateAnswers(schema, { ...complete, gw_same_address: "no" });
  assert.equal(needsPermanent.errors.gw_permanent, "This question needs an answer.");
  // A hidden question's stale answer is dropped rather than stored.
  assert.equal("gw_permanent" in validateAnswers(schema, { ...complete, gw_permanent: "old" }).clean, false);
  assert.match(validateAnswers(schema, { ...complete, gw_email: "nope" }).errors.gw_email, /valid email/);
  assert.match(validateAnswers(schema, { ...complete, gw_telegram: "@arjun_s" }).errors.gw_telegram, /Telegram account/);
  assert.match(validateAnswers(schema, { ...complete, gw_whatsapp: "43636363", gw_alt_phone: "346346346" }).errors.gw_whatsapp, /valid phone number/);
  assert.match(validateAnswers(schema, { ...complete, gw_alt_phone: "346346346" }).errors.gw_alt_phone, /valid phone number/);
  assert.match(validateAnswers(schema, { ...complete, gw_email: "a..b@example.com" }).errors.gw_email, /valid email/);
  assert.equal(validateAnswers(schema, { ...complete, gw_whatsapp: "98765 43210" }).clean.gw_whatsapp, "+919876543210");
  assert.equal(validateAnswers(schema, { ...complete, gw_state: "Outside India", gw_district: "London", gw_whatsapp: "+44 20 7946 0958" }).ok, true);
  assert.match(validateAnswers(schema, { ...complete, gw_state: "Outside India", gw_whatsapp: "9876543210" }).errors.gw_whatsapp, /country code/);
  assert.match(validateAnswers(schema, { ...complete, gw_state: "Assam" }).errors.gw_district, /selected state/);
  assert.ok(INDIA_STATES.filter(state => state !== "Outside India").every(state => districtsFor(state).length));
  assert.equal(INDIA_STATES.flatMap(districtsFor).length, 790);
  assert.ok(districtsFor("Assam").includes("Sribhumi"));
  const social = [{ platform: " Instagram ", handle: " @arjun " }, { platform: "Custom messenger", handle: "123" }];
  assert.deepEqual(validateAnswers(schema, { ...complete, gw_social: social }).clean.gw_social,
    [{ platform: "Instagram", handle: "@arjun" }, social[1]]);
  assert.match(validateAnswers(schema, { ...complete, gw_social: [{ platform: "Signal", handle: "" }] }).errors.gw_social, /each account/);
  assert.match(validateAnswers(schema, { ...complete, gw_gender: "robot" }).errors.gw_gender, /Choose one/);
  assert.equal(validateAnswers(schema, { ...complete, gw_gender: "~Non-binary" }).ok, true);
  assert.match(validateAnswers(schema, { ...complete, gw_age: 5 }).errors.gw_age, /13 or more/);

  const skipping = normalizeSchema({ pages: [
    { id: "a", title: "A", fields: [{ id: "member", type: "yesno", label: "Member?", required: true }], jumps: [{ when: { mode: "all", rules: [{ field: "member", op: "eq", value: "no" }] }, to: "c" }, { when: { mode: "all", rules: [{ field: "ghost", op: "eq", value: "x" }] }, to: "a" }] },
    { id: "b", title: "B", fields: [{ id: "since", type: "short", label: "Since when, {{member}}?", required: true }] },
    { id: "c", title: "C", fields: [{ id: "why", type: "multi", label: "Why?", options: ["One", "Two"], validation: { max: 1 } }] }] });
  assert.equal(skipping.pages[0].jumps.length, 1, "rules pointing at unknown questions are removed");
  assert.deepEqual(pagePath(skipping, { member: "no" }).map(p => p.id), ["a", "c"]);
  assert.deepEqual(pagePath(skipping, { member: "yes" }).map(p => p.id), ["a", "b", "c"]);
  assert.equal(validateAnswers(skipping, { member: "no" }).ok, true, "a skipped page's required question is not demanded");
  assert.equal(validateAnswers(skipping, { member: "yes" }).ok, false);
  assert.equal(pipeText("Since when, {{member}}?", skipping, { member: "yes" }), "Since when, yes?");
  const ids = skipping.pages[2].fields[0].options.map(o => o.id);
  assert.match(validateAnswers(skipping, { member: "no", why: ids }).errors.why, /at most 1/);
  assert.throws(() => normalizeSchema({ pages: [] }), /at least one page/);
});

test("R2 signing is deterministic and form data never targets the public media bucket", () => {
  const signed = signR2Request({ method: "PUT", accountId: "acc", bucket: "vn-forms", key: "forms/a b/1.json", accessKeyId: "AKID", secretAccessKey: "secret", body: "{}", now: new Date("2026-01-02T03:04:05.000Z") });
  assert.equal(signed.url, "https://acc.r2.cloudflarestorage.com/vn-forms/forms/a%20b/1.json");
  assert.match(signed.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(signed.headers["x-amz-date"], "20260102T030405Z");
  assert.equal(signR2Request({ method: "PUT", accountId: "acc", bucket: "vn-forms", key: "forms/a b/1.json", accessKeyId: "AKID", secretAccessKey: "secret", body: "{}", now: new Date("2026-01-02T03:04:05.000Z") }).headers.Authorization, signed.headers.Authorization);
  const keys = { R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "vn-reader-media" };
  assert.equal(r2FormsSettings({ ...keys, R2_FORMS_BUCKET: "vn-reader-media" }).enabled, false);
  assert.equal(r2FormsSettings(keys).enabled, false);
  assert.equal(r2FormsSettings({ ...keys, R2_FORMS_BUCKET: "vn-forms-private" }).enabled, true);
});

test("Telegram web-app sign-in data is verified against the bot token", () => {
  const token = "123456789:AAExampleExampleExampleExampleExample", telegram = createTelegramForms(() => ({ botToken: token }));
  const sign = fields => { const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n"); const secret = createHmac("sha256", "WebAppData").update(token).digest(); return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString(); };
  const now = Date.now(), fields = { auth_date: String(Math.floor(now / 1000)), query_id: "q", user: JSON.stringify({ id: 4242, username: "arjun_s", first_name: "Arjun" }) };
  assert.deepEqual(telegram.verifyInitData(sign(fields), 86400, now), { id: "4242", username: "arjun_s", firstName: "Arjun", canMessage: true });
  assert.equal(telegram.verifyInitData(sign(fields).replace("arjun_s", "mallory"), 86400, now), null);
  assert.equal(telegram.verifyInitData(sign({ ...fields, auth_date: "1000" }), 86400, now), null);
  assert.equal(telegram.verifyInitData("", 86400, now), null);
});

test("form flow: submit, approval-gated link, roles, exports, insights, backups", async () => {
  const mail = [], calls = [];
  const fetchImpl = async (url, options = {}) => { calls.push({ url: String(url), options }); if (String(url).includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { username: "vn_forms_bot" } }), { status: 200 }); return new Response("", { status: 200 }); };
  const { app, accounts, forms } = await createAccountApp({ database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test", origins: ["http://reader.test"], production: false, archiveEnabled: false, adminEmails: ["owner@example.com"], emailDailyLimit: 20, fetchImpl, botToken: "test-bot-token",
    r2Forms: { enabled: true, bucket: "vn-forms-private", accountId: "acc", accessKeyId: "k", secretAccessKey: "s", prefix: "forms", reason: "" } }, m => mail.push(m));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { body, cookie = "", method, headers = {} } = {}) => fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://reader.test", "x-vn-csrf": "1", "content-type": "application/json", cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const account = async email => { assert.equal((await request("/api/auth/sign-up/email", { body: { name: "Reader", email, password: "strong-test-password-123" } })).status, 200); const r = await request("/api/auth/email-otp/verify-email", { body: { email, otp: mail.findLast(m => m.email === email).otp } }); assert.equal(r.status, 200); return r.headers.getSetCookie().map(c => c.split(";")[0]).join("; "); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  try {
    const publicView = await (await request("/api/forms/groundwork")).json();
    assert.equal(publicView.form.title, "Vidurneeti Ground Work"); assert.equal(publicView.form.availability, "open"); assert.equal(publicView.outcome, null);
    assert.ok(!JSON.stringify(publicView).includes("t.me/+"), "the gated link is never sent with the form");
    assert.equal((await request("/api/forms/groundwork/responses", { body: { answers: complete, website: "spam" } })).status, 422);
    const rejected = await request("/api/forms/groundwork/responses", { body: { answers: { ...complete, gw_email: "" } } });
    assert.equal(rejected.status, 422); assert.ok((await rejected.json()).errors.gw_email);
    const forged = await request("/api/forms/groundwork/responses", { body: { answers: complete } });
    assert.match((await forged.json()).errors.gw_telegram, /verify your user ID/);
    const { url, key } = await (await request("/api/forms/groundwork/telegram-link", { body: {} })).json();
    const start = new URL(url).searchParams.get("start");
    assert.match(start, /^tguserid_[A-Za-z0-9_-]{24}$/);
    assert.equal((await request("/api/forms/groundwork/telegram-link", { headers: { "X-VN-Telegram-Link": start } })).status, 404);
    const poll = () => request("/api/forms/groundwork/telegram-link", { headers: { "X-VN-Telegram-Link": key } });
    assert.equal((await (await poll()).json()).telegram, null);
    const sendStart = (userId, username) => request("/internal/forms/telegram", { headers: { Authorization: "Bearer test-bot-token" }, body: { userId, username, text: `/start ${start}` } });
    const botReply = await (await sendStart("4242", "")).json();
    assert.equal(botReply.copyText, "4242");
    await sendStart("9999", "other");
    assert.deepEqual((await (await poll()).json()).telegram, { id: "4242", username: null });
    const badSubmit = await request("/api/forms/groundwork/responses", { body: { answers: { ...complete, gw_email: "bad" }, telegramLink: key } });
    assert.equal(badSubmit.status, 422);
    assert.equal((await poll()).status, 200, "a validation error does not consume the link");
    const wrongId = await request("/api/forms/groundwork/responses", { body: { answers: { ...complete, gw_telegram: "9999" }, telegramLink: key } });
    assert.equal(wrongId.status, 422);
    assert.match((await wrongId.json()).errors.gw_telegram, /same Telegram user ID/);
    assert.equal((await poll()).status, 200, "the applicant can correct the pasted ID");
    const submitted = await request("/api/forms/groundwork/responses", { body: { answers: { ...complete, gw_social: [{ platform: "Signal", handle: "arjun.01" }] }, telegramLink: key, startedAt: Date.now() - 60000, device: "mobile" } });
    assert.equal((await poll()).status, 404, "a successful submission consumes the link");
    assert.equal(submitted.status, 201); const { receipt, outcome } = await submitted.json();
    assert.equal(outcome.status, "pending"); assert.equal(outcome.notify.telegram, true); assert.equal(outcome.reward.url, null);
    const waiting = await (await request("/api/forms/groundwork", { headers: { "x-vn-receipt": receipt } })).json();
    assert.equal(waiting.outcome.status, "pending"); assert.equal(waiting.outcome.reward.url, null);
    assert.equal((await (await request("/api/forms/groundwork", { headers: { "x-vn-receipt": "x".repeat(32) } })).json()).outcome, null);
    await settle();
    assert.ok(calls.some(c => c.url.startsWith("https://acc.r2.cloudflarestorage.com/vn-forms-private/forms/") && c.options.method === "PUT"), "the response is mirrored to the private bucket");

    assert.equal((await request("/api/admin/forms")).status, 401);
    const owner = await account("owner@example.com"), reader = await account("reader@example.com"), reviewer = await account("reviewer@example.com");
    assert.equal((await request("/api/admin/forms", { cookie: reader })).status, 403);
    const me = await (await request("/api/admin/me", { cookie: owner })).json(); assert.equal(me.owner, true); assert.ok(me.permissions.includes("team.manage"));
    const list = await (await request("/api/admin/forms", { cookie: owner })).json(); const form = list.forms[0]; assert.equal(form.counts.pending, 1);

    assert.equal((await request("/api/admin/team", { cookie: owner, method: "PUT", body: { email: "reviewer@example.com", permissions: ["forms.read", "responses.read", "responses.review"] } })).status, 200);
    assert.deepEqual(await (await request("/api/admin/access", { cookie: reviewer })).json(), { allowed: true });
    assert.equal((await request("/api/admin/dashboard", { cookie: reviewer })).status, 403, "form reviewers do not see reader accounts");
    assert.equal((await request(`/api/admin/forms/${form.id}`, { cookie: reviewer, method: "PUT", body: { title: "Hijack" } })).status, 403);
    assert.equal((await request(`/api/admin/forms/${form.id}/export`, { cookie: reviewer })).status, 403);
    assert.equal((await request("/api/admin/team", { cookie: reviewer })).status, 403);
    assert.equal((await request("/api/admin/settings", { cookie: reviewer })).status, 403);

    const responses = await (await request(`/api/admin/forms/${form.id}/responses?state=Maharashtra&q=Arjun`, { cookie: reviewer })).json();
    assert.equal(responses.total, 1); assert.equal(responses.responses[0].answers.gw_name, "Arjun Sharma"); assert.equal(responses.responses[0].device, "mobile");
    assert.deepEqual(responses.responses[0].telegram, { id: "4242", username: null });
    assert.equal(responses.responses[0].answers.gw_telegram, "4242");
    assert.equal((await (await request(`/api/admin/forms/${form.id}/responses?state=Kerala`, { cookie: reviewer })).json()).total, 0);
    assert.equal((await (await request(`/api/admin/forms/${form.id}/responses?f.gw_gender=male`, { cookie: reviewer })).json()).total, 1);
    const approved = await request(`/api/admin/forms/${form.id}/responses`, { cookie: reviewer, method: "PATCH", body: { ids: [responses.responses[0].id], status: "approved" } });
    assert.equal(approved.status, 200); assert.equal((await approved.json()).updated[0].reviewedBy, "reviewer@example.com");
    const unlocked = await (await request("/api/forms/groundwork", { headers: { "x-vn-receipt": receipt } })).json();
    assert.equal(unlocked.outcome.status, "approved"); assert.equal(unlocked.outcome.reward.url, "https://t.me/+EcstnRyYKytlOWE9");
    assert.equal((await request(`/api/admin/forms/${form.id}/responses`, { cookie: reviewer, method: "DELETE", body: { ids: [responses.responses[0].id] } })).status, 403);

    const csv = await (await request(`/api/admin/forms/${form.id}/export`, { cookie: owner })).text();
    assert.match(csv, /Signal: arjun\.01/); assert.match(csv, /Full name/); assert.match(csv, /Arjun Sharma/); assert.match(csv, /'\+919876543210/, "formula-like cells are neutralised");
    const placesPath = `/api/admin/forms/${form.id}/places`;
    assert.equal((await request(placesPath)).status, 401);
    assert.equal((await request(placesPath, { cookie: reader })).status, 403);
    assert.equal((await request(placesPath, { cookie: reviewer })).status, 403);
    const places = await (await request(placesPath, { cookie: owner })).json();
    assert.deepEqual(places.totals, {
      count: 1, approved: 1, pending: 0, rejected: 0,
      daily: { count: 1, approved: 1, pending: 0, rejected: 0 }, latest: Date.parse(responses.responses[0].createdAt),
      recent: { count: 1, approved: 1, pending: 0, rejected: 0 }, previous: 0
    });
    assert.deepEqual(places.states[0].districts[0], { name: "Pune", ...places.totals });
    const districtResponses = `/api/admin/forms/${form.id}/responses?state=Maharashtra&district=Pune&status=approved`;
    assert.equal((await (await request(districtResponses, { cookie: owner })).json()).total, 1);
    assert.equal((await (await request(districtResponses.replace("Pune", "Mumbai"), { cookie: owner })).json()).total, 0);
    const insights = await (await request(`/api/admin/forms/${form.id}/insights`, { cookie: owner })).json();
    assert.equal(insights.totals.responses, 1); assert.equal(insights.states[0].name, "Maharashtra"); assert.ok(insights.insights.length > 0);
    assert.deepEqual(insights.questions.find(q => q.id === "gw_gender").options.find(o => o.name === "Male"), { name: "Male", count: 1 });
    assert.deepEqual(insights.questions.find(q => q.id === "gw_whatsapp").topWords, []);

    const link = await (await request(`/api/admin/forms/${form.id}/links`, { cookie: owner, body: { label: "WhatsApp groups", code: "wa", prefill: { gw_state: "Delhi", nope: "x" } } })).json(); assert.equal(link.code, "wa");
    assert.equal((await request(`/api/admin/forms/${form.id}/links`, { cookie: owner, body: { label: "Again", code: "wa" } })).status, 409);
    assert.deepEqual((await (await request("/api/forms/groundwork?via=wa")).json()).prefill, { gw_state: "Delhi" });
    assert.deepEqual(await (await request("/api/forms/go/wa")).json(), { slug: "groundwork", via: "wa" });
    await request("/api/forms/groundwork/events", { body: { kind: "view", via: "wa" } });
    assert.equal((await (await request(`/api/admin/forms/${form.id}/links`, { cookie: owner })).json()).links[0].views, 1);

    assert.equal((await request("/api/admin/settings", { cookie: owner, method: "PUT", body: { botToken: "bad" } })).status, 422);
    const saved = await (await request("/api/admin/settings", { cookie: owner, method: "PUT", body: { botToken: "123456789:AAExampleExampleExampleExampleExample", backupChat: "-1001234567890" } })).json();
    assert.equal(saved.telegram.tokenSource, "console"); assert.equal(saved.telegram.tokenHint, "…mple"); assert.equal(saved.telegram.botUsername, "vn_forms_bot"); assert.ok(!JSON.stringify(saved).includes("AAExample"), "the token is never echoed back");
    assert.equal(saved.r2.enabled, true);
    const backup = await (await request(`/api/admin/forms/${form.id}/backup`, { cookie: owner, body: {} })).json();
    assert.deepEqual([backup.telegram, backup.r2, backup.responses], [true, true, 1]);
    assert.ok(calls.some(c => c.url.endsWith("/sendDocument")));

    const created = await (await request("/api/admin/forms", { cookie: owner, body: { title: "Volunteer check-in" } })).json();
    assert.equal(created.form.slug, "volunteer-check-in"); assert.equal(created.form.status, "draft");
    assert.equal((await request("/api/forms/volunteer-check-in")).status, 404, "drafts are not public");
    assert.equal((await request(`/api/admin/forms/${created.form.id}`, { cookie: owner, method: "PUT", body: { slug: "groundwork" } })).status, 409);
    const open = await (await request(`/api/admin/forms/${created.form.id}`, { cookie: owner, method: "PUT", body: { status: "live", settings: { requireApproval: false, reward: { enabled: true, label: "Join", url: "https://t.me/example" } } } })).json();
    const instant = await (await request("/api/forms/volunteer-check-in/responses", { body: { answers: { [open.form.schema.pages[0].fields[0].id]: "Meera" } } })).json();
    assert.equal(instant.outcome.status, "approved"); assert.equal(instant.outcome.reward.url, "https://t.me/example");
    assert.equal((await request(`/api/admin/forms/${created.form.id}`, { cookie: owner, method: "DELETE" })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); accounts.close(); }
});

test("status updates: Telegram binding through the bot, /status privacy, and opt-in email", async () => {
  const mail = [], token = "123456789:AAExampleExampleExampleExampleExample";
  const fetchImpl = async url => new Response(JSON.stringify({ ok: true, result: { username: "vn_status_bot" } }), { status: String(url).includes("api.telegram.org") ? 200 : 200 });
  const { app, accounts, forms } = await createAccountApp({ database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test", origins: ["http://reader.test"], production: false, archiveEnabled: false, adminEmails: ["owner@example.com"], emailDailyLimit: 20, fetchImpl, botToken: token }, m => mail.push(m));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { body, headers = {} } = {}) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://reader.test", "x-vn-csrf": "1", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bot = (body, authorization = `Bearer ${token}`) => fetch(base + "/internal/forms/telegram", { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });
  try {
    // An older response, or a form with optional Telegram contact, can still opt in afterwards.
    const original = forms.store.formBySlug("groundwork");
    const schema = structuredClone(original.schema);
    schema.pages.flatMap(page => page.fields).find(field => field.id === "gw_telegram").required = false;
    forms.store.updateForm(original.id, { schema }, "owner@example.com");
    const submission = await request("/api/forms/groundwork/responses", { body: { answers: { ...complete, gw_telegram: undefined } } });
    assert.equal(submission.status, 201);
    const { receipt } = await submission.json();
    const mine = { "x-vn-receipt": receipt };
    assert.deepEqual((await (await request("/api/forms/groundwork", { headers: mine })).json()).updates, { telegram: "vn_status_bot", email: true });
    assert.equal((await request("/api/forms/groundwork/notify", { body: { channel: "telegram" } })).status, 404, "a receipt is required");

    assert.equal((await bot({ userId: "4242", text: "/status" }, "Bearer wrong")).status, 403);
    assert.match((await (await bot({ userId: "4242", text: "/status" })).json()).text, /No form responses are linked/);
    const { url } = await (await request("/api/forms/groundwork/notify", { body: { channel: "telegram" }, headers: mine })).json();
    const code = /^https:\/\/t\.me\/vn_status_bot\?start=r_([A-Za-z0-9_-]+)$/.exec(url)[1];
    const linked = await (await bot({ userId: "4242", username: "arjun_s", text: `/start r_${code}` })).json();
    assert.match(linked.text, /Linked\./); assert.match(linked.text, /Waiting for review/); assert.equal(linked.button, undefined);
    assert.match((await (await bot({ userId: "9999", text: `/start r_${code}` })).json()).text, /expired or was already used/, "a code works once");
    assert.match((await (await bot({ userId: "9999", text: "/status" })).json()).text, /No form responses are linked/, "other accounts see nothing");

    assert.equal((await request("/api/forms/groundwork/notify", { body: { channel: "email", email: "nope" }, headers: mine })).status, 422);
    const emailed = await (await request("/api/forms/groundwork/notify", { body: { channel: "email", email: "Arjun@Example.com" }, headers: mine })).json();
    assert.deepEqual(emailed.outcome.notify, { telegram: true, email: "ar…@example.com" });

    const form = forms.store.formBySlug("groundwork"), response = forms.store.byReceipt(form.id, receipt);
    const changed = forms.store.review(form.id, [response.id], "approved", "owner@example.com");
    assert.equal(changed.length, 1);
    const status = await (await bot({ userId: "4242", text: "/status" })).json();
    assert.match(status.text, /Approved/); assert.deepEqual(status.button, { text: "Groundwork group link", url: "https://t.me/+EcstnRyYKytlOWE9" });
    assert.equal(await accounts.mail({ to: "arjun@example.com", subject: "s", text: "t" }), true);
    assert.equal(mail.at(-1).type, "notice"); assert.equal(accounts.admin.capacity(true).used, 1, "notices count against the daily allowance");
  } finally { await new Promise(resolve => server.close(resolve)); accounts.close(); }
});

test("existing Ground Work form gains contact fields without replacing settings or previous responses", async () => {
  const { accounts, forms } = await createAccountApp({ database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test", origins: [], production: false }, () => {});
  try {
    const form = forms.store.formBySlug("groundwork"), schema = structuredClone(form.schema);
    for (const page of schema.pages) {
      page.fields = page.fields.filter(field => field.id !== "gw_locality");
      for (const field of page.fields) if (["gw_district", "gw_telegram", "gw_social"].includes(field.id)) field.type = "short";
    }
    const reward = { enabled: true, label: "Existing group", url: "https://example.com/invite" };
    const old = forms.store.updateForm(form.id, { title: "My live form", schema, settings: { reward } }, "owner@example.com");
    const previous = forms.store.submit(old, { answers: { ...complete, gw_district: "Old district text", gw_telegram: "@legacy", gw_social: "old handle" } }).response;
    forms.store.setSetting("forms.groundwork-contact", null);
    const upgradedStore = new FormsStore(accounts.database);
    const upgraded = upgradedStore.form(form.id);
    assert.equal(upgraded.title, "My live form");
    assert.deepEqual(upgraded.settings.reward, reward);
    assert.deepEqual(upgradedStore.response(form.id, previous.id).answers, previous.answers);
    const fields = upgraded.schema.pages.flatMap(page => page.fields);
    assert.equal(fields.find(field => field.id === "gw_district").stateField, "gw_state");
    assert.equal(fields.find(field => field.id === "gw_locality").required, undefined);
    assert.equal(fields.find(field => field.id === "gw_telegram").type, "telegram");
    assert.equal(fields.find(field => field.id === "gw_social").type, "social");
    assert.deepEqual(new FormsStore(accounts.database).form(form.id).schema, upgraded.schema);
  } finally { accounts.close(); }
});

test("Places groups legacy district names, counts the recent and prior weeks, and preserves unmapped responses", async () => {
  const { accounts, forms } = await createAccountApp({
    database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test",
    origins: [], production: false
  }, () => {});
  try {
    const form = forms.store.formBySlug("groundwork");
    const now = Date.parse("2026-11-13T12:00:00Z"), day = 86400000;
    const add = (state, district, status, age) => {
      const response = forms.store.submit(form, {
        answers: { ...complete, gw_state: state, gw_district: district }, telegram: { id: "4242" }
      }).response;
      accounts.database.prepare("UPDATE form_responses SET status=?,created_at=? WHERE id=?")
        .run(status, now - age * day, response.id);
      return response.id;
    };
    add("Assam", "Sribhumi", "approved", 0.5);
    const older = add("Assam", "Sribhumi", "pending", 9);
    const unknown = add("Assam", "Sribhumi", "rejected", 3);
    const noState = add("Assam", "Sribhumi", "pending", 3);
    const outside = add("Outside India", "London", "approved", 4);
    const changeDistrict = accounts.database.prepare("UPDATE form_responses SET answers=json_set(answers,'$.gw_district',?) WHERE id=?");
    changeDistrict.run("karimganj", older);
    changeDistrict.run("A free-text locality", unknown);
    accounts.database.prepare("UPDATE form_responses SET state=NULL WHERE id=?").run(noState);
    const places = forms.store.places(form, { from: now - 30 * day, to: now });
    const assam = places.states.find(region => region.name === "Assam");
    assert.equal(assam.count, 3);
    assert.deepEqual(assam.districts.find(district => district.name === "Sribhumi"), {
      name: "Sribhumi", count: 2, approved: 1, pending: 1, rejected: 0,
      daily: { count: 1, approved: 1, pending: 0, rejected: 0 }, latest: now - day / 2,
      recent: { count: 1, approved: 1, pending: 0, rejected: 0 }, previous: 1
    });
    assert.equal(assam.districts.find(district => district.name === "").count, 1);
    assert.equal(places.totals.count, 5);
    assert.equal(places.totals.recent.count, 4);
    assert.equal(places.totals.previous, 1);
    const lastWeek = forms.store.places(form, { from: now - 7 * day, to: now });
    assert.equal(lastWeek.totals.count, 4);
    assert.equal(lastWeek.totals.previous, 1, "growth keeps the prior week when the date filter is seven days");
    assert.equal(forms.store.query(form.id, { state: "Assam", district: "Sribhumi" }).length, 2);
    assert.equal(forms.store.query(form.id, { state: "Assam", district: "" })[0].id, unknown);
    assert.equal(forms.store.query(form.id, { state: "" })[0].id, noState);
    assert.equal(forms.store.query(form.id, { state: "Outside India" })[0].id, outside);
  } finally { accounts.close(); }
});

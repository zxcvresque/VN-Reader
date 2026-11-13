import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createAccountApp } from "../server/accountService.mjs";
import { FormsStore, ROLE_PRESETS } from "../server/formsStore.mjs";
import { buildSampleStore, createSampleForms, SAMPLE_LINKS } from "../server/formsSample.mjs";
import { validateAnswers, districtsFor, INDIA_STATES, allFields } from "../server/formLogic.mjs";

const realStore = () => new FormsStore(new DatabaseSync(":memory:"));

test("sample responses follow the form's own questions and rules", () => {
  const store = realStore(), form = store.formBySlug("groundwork"), sample = buildSampleStore(form);
  const rows = sample.query(form.id);
  assert.ok(rows.length >= 30 && rows.length <= 50);
  for (const row of rows) {
    const check = validateAnswers(form.schema, row.answers);
    assert.equal(check.ok, true, JSON.stringify(check.errors));
    assert.ok(INDIA_STATES.includes(row.state));
    if (row.state !== "Outside India") assert.ok(districtsFor(row.state).includes(row.answers.gw_district), `${row.answers.gw_district} is a district of ${row.state}`);
    assert.match(row.answers.gw_email, /@example\.com$/, "sample contacts use reserved example addresses");
    assert.ok(row.id.startsWith("sample-"));
  }
  assert.deepEqual(new Set(rows.map(row => row.status)), new Set(["pending", "approved", "rejected"]));
  assert.ok(new Set(rows.map(row => row.state)).size >= 8, "responses come from many states");
  assert.ok(rows.some(row => row.link) && rows.some(row => !row.link), "both share links and the direct link appear");
  // The real statistics code runs on the sample.
  const insights = sample.insights(form), places = sample.places(form);
  assert.equal(insights.totals.responses, rows.length);
  assert.ok(insights.totals.views > insights.totals.starts && insights.totals.starts >= rows.length);
  assert.ok(insights.insights.length >= 4);
  assert.ok(insights.links.some(link => link.label === SAMPLE_LINKS[0].label));
  assert.equal(places.totals.count, rows.length);
  assert.ok(places.states.every(state => state.districts.every(district => district.name)), "every sample district is on the map");
  // Same form, same people.
  assert.deepEqual(buildSampleStore(form).query(form.id).map(row => row.answers.gw_name), rows.map(row => row.answers.gw_name));
  assert.equal(store.count(form.id), 0, "the real form gets no responses");
});

test("sample data fits any form, including choice, rating and scale questions", () => {
  const store = realStore();
  const form = store.createForm({ title: "Feedback", status: "live", schema: { pages: [{ title: "", fields: [
    { type: "rating", label: "How would you rate your experience?", required: true, scale: { max: 5 } },
    { type: "multi", label: "What can you help with?", required: true, options: ["Events", "Design", "Writing", "Technology"] },
    { type: "scale", label: "How likely are you to recommend us?", scale: { min: 0, max: 10 } },
    { type: "state", label: "State", required: true }, { type: "consent", label: "I agree", required: true }, { type: "date", label: "Preferred date" } ] }] } }, "owner@example.com");
  const rows = buildSampleStore(form).query(form.id);
  for (const row of rows) assert.equal(validateAnswers(form.schema, row.answers).ok, true);
  const multi = allFields(form.schema)[1];
  assert.ok(rows.every(row => Array.isArray(row.answers[multi.id]) && row.answers[multi.id].length >= 1));
});

test("sample stores are per admin, reusable, bounded and resettable", () => {
  const store = realStore(), form = store.formBySlug("groundwork");
  let now = Date.now();
  const samples = createSampleForms({ now: () => now, limit: 2 });
  const mine = samples.storeFor("a@example.com", form);
  assert.equal(samples.storeFor("a@example.com", form), mine);
  assert.notEqual(samples.storeFor("b@example.com", form), mine);
  samples.storeFor("c@example.com", form);
  assert.equal(samples.size, 2);
  now += 7 * 3600000;
  assert.notEqual(samples.storeFor("c@example.com", form), mine, "old samples are rebuilt");
  samples.reset("c@example.com");
  assert.equal(samples.size, 1);
  samples.close();
});

test("sample mode keeps permissions, never touches real data and never leaves the server", async () => {
  const mail = [], calls = [];
  const fetchImpl = async (url, options = {}) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: true, result: { username: "vn_forms_bot" } }), { status: 200 }); };
  const { app, accounts, forms } = await createAccountApp({ database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test", origins: ["http://reader.test"], production: false, archiveEnabled: false, adminEmails: ["owner@example.com"], emailDailyLimit: 30, fetchImpl, botToken: "test-bot-token",
    r2Forms: { enabled: true, bucket: "vn-forms-private", accountId: "acc", accessKeyId: "k", secretAccessKey: "s", prefix: "forms", reason: "" } }, m => mail.push(m));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { body, cookie = "", method, sample = false } = {}) => fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://reader.test", "x-vn-csrf": "1", "content-type": "application/json", cookie, ...(sample ? { "x-vn-sample": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const account = async email => { await request("/api/auth/sign-up/email", { body: { name: "Reader", email, password: "strong-test-password-123" } }); const r = await request("/api/auth/email-otp/verify-email", { body: { email, otp: mail.findLast(m => m.email === email).otp } }); return r.headers.getSetCookie().map(c => c.split(";")[0]).join("; "); };
  try {
    const owner = await account("owner@example.com"), reviewer = await account("reviewer@example.com"), reader = await account("reader@example.com");
    const groundwork = forms.store.formBySlug("groundwork"), other = forms.store.createForm({ title: "Volunteer sign-up", status: "live" }, "owner@example.com");
    await request("/api/admin/team", { cookie: owner, method: "PUT", body: { email: "reviewer@example.com", name: "Reviewer", permissions: ROLE_PRESETS.reviewer, formIds: [groundwork.id] } });
    const realRows = () => Number(accounts.database.prepare("SELECT COUNT(*) AS n FROM form_responses").get().n);
    assert.equal(realRows(), 0);

    assert.equal((await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: reader, sample: true })).status, 403, "sample mode is still admin-only");
    assert.equal((await request(`/api/admin/forms/${other.id}/responses`, { cookie: reviewer, sample: true })).status, 403, "sample mode never opens a form outside the role");
    const list = await (await request("/api/admin/forms", { cookie: reviewer, sample: true })).json();
    assert.deepEqual(list.forms.map(form => form.id), [groundwork.id]);
    assert.ok(list.sample && list.forms[0].counts.total >= 30);
    assert.equal((await (await request("/api/admin/forms", { cookie: reviewer })).json()).forms[0].counts.total, 0, "real counts stay real");

    const page = await (await request(`/api/admin/forms/${groundwork.id}/responses?status=pending`, { cookie: reviewer, sample: true })).json();
    assert.equal(page.sample, true); assert.ok(page.total > 0 && page.responses.every(row => row.status === "pending"));
    assert.equal((await (await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: reviewer })).json()).total, 0);
    const insights = await (await request(`/api/admin/forms/${groundwork.id}/insights`, { cookie: reviewer, sample: true })).json();
    assert.equal(insights.sample, true); assert.ok(insights.totals.responses >= 30); assert.ok(insights.questions.find(q => q.id === "gw_gender").options.some(o => o.count > 0));
    assert.equal((await (await request(`/api/admin/forms/${groundwork.id}/insights`, { cookie: reviewer })).json()).totals.responses, 0);
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/places`, { cookie: reviewer, sample: true })).status, 200);
    assert.equal((await (await request(`/api/admin/forms/${groundwork.id}/links`, { cookie: reviewer, sample: true })).json()).links.length, SAMPLE_LINKS.length);
    assert.equal((await (await request(`/api/admin/forms/${groundwork.id}/links`, { cookie: owner })).json()).links.length, 0, "sample links are not real links");

    // Reviewing sample responses changes only that admin's sample, with no backups, messages or emails.
    const before = calls.length, mailBefore = mail.length, target = page.responses[0].id;
    const approved = await (await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: reviewer, method: "PATCH", sample: true, body: { ids: [target], status: "approved" } })).json();
    assert.equal(approved.updated[0].status, "approved"); assert.equal(approved.updated[0].reviewedBy, "reviewer@example.com");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, before, "no R2 or Telegram request for sample decisions"); assert.equal(mail.length, mailBefore);
    const ownerView = await (await request(`/api/admin/forms/${groundwork.id}/responses?status=pending`, { cookie: owner, sample: true })).json();
    assert.ok(ownerView.responses.some(row => row.id === target), "another admin's sample is separate");
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: reviewer, method: "DELETE", sample: true, body: { ids: [target] } })).status, 403, "the reviewer role cannot delete, even in the sample");
    assert.deepEqual((await (await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: owner, method: "DELETE", sample: true, body: { ids: [target] } })).json()).removed, [target]);
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/responses`, { cookie: owner, method: "PATCH", body: { ids: [target], status: "approved" } })).status, 200, "a real request with a sample ID finds nothing to change");
    assert.equal(realRows(), 0, "nothing reached the real responses table");

    // Exports and backups refuse sample mode, and real exports carry only real responses.
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/export`, { cookie: owner, sample: true })).status, 409);
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/backup`, { cookie: owner, sample: true, body: {} })).status, 409);
    const csv = await (await request(`/api/admin/forms/${groundwork.id}/export`, { cookie: owner })).text();
    assert.equal(csv.trim().split("\r\n").length, 1, "the real export has only its header row");
    assert.ok(!csv.includes("@example.com"));

    assert.equal((await request("/api/admin/sample", { cookie: owner, method: "DELETE" })).status, 200);
    const fresh = await (await request(`/api/admin/forms/${groundwork.id}/responses?status=pending`, { cookie: owner, sample: true })).json();
    assert.ok(fresh.responses.some(row => row.id === target), "reset brings the sample back to its start");
  } finally { await new Promise(resolve => server.close(resolve)); accounts.close(); }
});

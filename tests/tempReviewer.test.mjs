import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAccountApp } from "../server/accountService.mjs";
import { ROLE_PRESETS } from "../server/formsStore.mjs";
import { createTemporaryReviewer, revokeTemporaryReviewer, sweepTemporaryReviewers, temporaryReviewers } from "../server/tempReviewer.mjs";

test("temporary reviewers get exactly the reviewer role, expire on time and are removed cleanly", async () => {
  const mail = [];
  const { app, accounts, forms } = await createAccountApp({ database: ":memory:", secret: "test-only-secret-at-least-thirty-two-characters", baseURL: "http://reader.test", origins: ["http://reader.test"], production: false, archiveEnabled: false, adminEmails: ["owner@example.com"], emailDailyLimit: 30 }, m => mail.push(m));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { body, cookie = "", method } = {}) => fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: "http://reader.test", "x-vn-csrf": "1", "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signIn = async (email, password) => { const r = await request("/api/auth/sign-in/email", { body: { email, password } }); return { status: r.status, cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") }; };
  const store = forms.store, groundwork = store.formBySlug("groundwork");
  try {
    const made = await createTemporaryReviewer({ accounts, store, email: "Demo.Reviewer@example.com", forms: ["groundwork"], hours: 48 });
    assert.equal(made.email, "demo.reviewer@example.com"); assert.ok(made.password.length >= 20);
    await assert.rejects(createTemporaryReviewer({ accounts, store, email: "owner@example.com", forms: ["groundwork"] }), /owner/);
    await assert.rejects(createTemporaryReviewer({ accounts, store, email: "demo.reviewer@example.com", forms: ["groundwork"] }), /already exists/);
    await assert.rejects(createTemporaryReviewer({ accounts, store, email: "x@example.com", forms: ["missing"] }), /No form/);

    const session = await signIn(made.email, made.password);
    assert.equal(session.status, 200);
    const me = await (await request("/api/admin/me", { cookie: session.cookie })).json();
    assert.deepEqual([...me.permissions].sort(), [...ROLE_PRESETS.reviewer].sort());
    assert.deepEqual(me.formIds, [groundwork.id]); assert.equal(me.owner, false);
    assert.equal((await request("/api/admin/team", { cookie: session.cookie })).status, 403);
    assert.equal((await request(`/api/admin/forms/${groundwork.id}/export`, { cookie: session.cookie })).status, 403);
    assert.equal(temporaryReviewers(store)[0].expired, false);

    // At the expiry time the console closes for them, without anyone running a command.
    accounts.database.prepare("UPDATE admin_members SET expires_at=? WHERE email=?").run(Date.now() - 1000, made.email);
    assert.equal((await request("/api/admin/me", { cookie: session.cookie })).status, 403);
    assert.equal(store.member(made.email).expired, true);
    assert.deepEqual(await sweepTemporaryReviewers({ accounts, store }), [made.email]);
    assert.equal(store.member(made.email), null);
    assert.equal(accounts.database.prepare("SELECT id FROM user WHERE email=?").get(made.email), undefined, "the account it made is gone");
    assert.equal((await signIn(made.email, made.password)).status, 401);
    await assert.rejects(revokeTemporaryReviewer({ accounts, store, email: "owner@example.com" }), /Only accounts made by this tool/);
    assert.ok(store.auditLog().some(entry => entry.action === "team.remove" && entry.target === made.email));
  } finally { await new Promise(resolve => server.close(resolve)); accounts.close(); }
});

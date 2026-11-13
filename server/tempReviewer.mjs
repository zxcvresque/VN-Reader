// Temporary reviewer accounts, for demos and short reviews.
//
// A temporary reviewer is an ordinary reader account plus admin access with exactly the
// `reviewer` role (view forms, view and review responses, view statistics), limited to the
// forms you name. Access ends by itself at the expiry time, because the console treats an
// expired member as inactive. `revoke` and `sweep` then remove the member and, when this
// tool created the reader account, the account too.
//
//   node server/tempReviewer.mjs create --email demo.reviewer@example.com --form groundwork [--hours 72] [--name "Demo reviewer"] [--password-file path]
//   node server/tempReviewer.mjs list
//   node server/tempReviewer.mjs revoke --email demo.reviewer@example.com
//   node server/tempReviewer.mjs sweep          # revoke every expired temporary reviewer
//
// In Docker: docker compose exec accounts node server/tempReviewer.mjs list
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_PRESETS } from "./formsStore.mjs";

const PREFIX = "temp-reviewer:";
const ACTOR = "temporary-reviewer tool";
const MAX_HOURS = 24 * 30;

/** Records of temporary reviewers, kept in app_settings next to the forms. */
export function temporaryReviewers(store) {
  return store.database.prepare("SELECT key,value FROM app_settings WHERE key LIKE ?").all(`${PREFIX}%`).map(row => {
    const record = JSON.parse(row.value), member = store.member(record.email);
    return { ...record, active: !!member?.active, expired: !member || member.expired || Date.parse(record.expiresAt) <= store.time() };
  });
}

export async function createTemporaryReviewer({ accounts, store, email, forms, hours = 72, name = "Temporary reviewer", password = randomBytes(18).toString("base64url") }) {
  email = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Give a valid --email for the reviewer.");
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw new Error(`--hours must be between 1 and ${MAX_HOURS}.`);
  if (accounts.admin.adminEmails.has(email)) throw new Error("That address is an owner. Use a separate address for a temporary reviewer.");
  if (store.member(email) && !store.getSetting(PREFIX + email)) throw new Error("That address is already an admin. Choose another address so its access isn't changed.");
  const formIds = forms.map(slug => { const form = store.formBySlug(slug) ?? store.form(slug); if (!form) throw new Error(`No form called "${slug}".`); return form.id; });
  if (!formIds.length) throw new Error("Name at least one --form the reviewer may see.");
  const context = await accounts.auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (existing) throw new Error("A reader account with that email already exists. Temporary reviewers get their own new account, so revoking never touches someone's real account.");
  const user = await context.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
  await context.internalAdapter.linkAccount({ providerId: "credential", accountId: user.id, userId: user.id, password: await context.password.hash(password) });
  const expiresAt = new Date(store.time() + Math.round(hours * 3600000)).toISOString();
  // Exactly the reviewer preset: no exports, deletions, editing, team or site access.
  store.saveMember({ email, name, permissions: ROLE_PRESETS.reviewer, formIds, expiresAt }, ACTOR);
  const record = { email, userId: user.id, formIds, createdAt: new Date(store.time()).toISOString(), expiresAt };
  store.setSetting(PREFIX + email, JSON.stringify(record));
  return { ...record, password };
}

export async function revokeTemporaryReviewer({ accounts, store, email }) {
  email = String(email ?? "").trim().toLowerCase();
  const saved = store.getSetting(PREFIX + email);
  if (!saved) throw new Error("No temporary reviewer with that email. Only accounts made by this tool can be revoked with it.");
  const record = JSON.parse(saved);
  store.removeMember(email, ACTOR);
  // Remove the reader account this tool made; sessions and saved state go with it.
  const user = accounts.database.prepare("SELECT id FROM user WHERE id=? AND email=?").get(record.userId, email);
  if (user) for (const table of ["session", "account", "reader_states", "reader_sign_ins"]) accounts.database.prepare(`DELETE FROM ${table} WHERE ${table === "reader_states" || table === "reader_sign_ins" ? "user_id" : "userId"}=?`).run(user.id);
  if (user) accounts.database.prepare("DELETE FROM user WHERE id=?").run(user.id);
  store.setSetting(PREFIX + email, null);
  return { email, removedAccount: !!user };
}

export async function sweepTemporaryReviewers({ accounts, store }) {
  const expired = temporaryReviewers(store).filter(record => record.expired);
  for (const record of expired) await revokeTemporaryReviewer({ accounts, store, email: record.email });
  return expired.map(record => record.email);
}

async function main(argv) {
  const [command, ...rest] = argv, options = {};
  for (let index = 0; index < rest.length; index++) if (rest[index].startsWith("--")) options[rest[index].slice(2)] = rest[index + 1]?.startsWith("--") || rest[index + 1] === undefined ? true : rest[++index];
  if (!["create", "list", "revoke", "sweep"].includes(command)) { console.log("Usage: node server/tempReviewer.mjs create|list|revoke|sweep [--email address] [--form slug[,slug]] [--hours 72] [--name text] [--password-file path]"); process.exitCode = 1; return; }
  const { config } = await import("dotenv");
  config({ path: process.env.VN_ENV_FILE ?? ".env.production", quiet: true });
  const { createAccounts, accountSettings } = await import("./accounts.mjs");
  const { FormsStore } = await import("./formsStore.mjs");
  // A no-op sender: this tool never sends email, and the account is verified directly.
  const accounts = await createAccounts(accountSettings(), async () => {});
  const store = new FormsStore(accounts.database);
  try {
    if (command === "create") {
      const made = await createTemporaryReviewer({ accounts, store, email: options.email, forms: String(options.form ?? "").split(",").map(item => item.trim()).filter(Boolean), hours: options.hours === undefined ? 72 : Number(options.hours), name: typeof options.name === "string" ? options.name : undefined });
      console.log(`Temporary reviewer ${made.email} can open /admin until ${made.expiresAt}.`);
      if (typeof options["password-file"] === "string") { writeFileSync(options["password-file"], `${made.email}\n${made.password}\n`, { mode: 0o600 }); chmodSync(options["password-file"], 0o600); console.log(`Password written to ${options["password-file"]} (readable only by you).`); }
      else console.log(`Password (shown once): ${made.password}`);
      console.log(`Remove it any time with: node server/tempReviewer.mjs revoke --email ${made.email}`);
    } else if (command === "list") {
      const list = temporaryReviewers(store);
      if (!list.length) console.log("No temporary reviewers.");
      for (const record of list) console.log(`${record.email}\t${record.expired ? "expired" : "active"}\tuntil ${record.expiresAt}\tforms ${record.formIds.map(id => store.form(id)?.slug ?? id).join(", ")}`);
    } else if (command === "revoke") {
      const result = await revokeTemporaryReviewer({ accounts, store, email: options.email });
      console.log(`Revoked ${result.email}${result.removedAccount ? " and removed its reader account" : ""}.`);
    } else {
      const removed = await sweepTemporaryReviewers({ accounts, store });
      console.log(removed.length ? `Revoked ${removed.join(", ")}.` : "Nothing has expired.");
    }
  } finally { accounts.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

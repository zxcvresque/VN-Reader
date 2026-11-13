import { useState } from "react";
import { PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { call, type TeamMember } from "../forms/api";
import type { AdminContext } from "./AdminApp";
import { Card } from "./charts";
import { Confirm, Failure, Loading, Modal, formatDate, useAction, useLoad } from "./ui";

interface TeamData { owners: string[]; members: TeamMember[]; audit: Array<{ at: string; actor: string; action: string; target: string; detail: string }> }
const PRESET_LABELS: Record<string, string> = { viewer: "Viewer", analyst: "Analyst", reviewer: "Reviewer", editor: "Editor", manager: "Manager" };
const ACTIONS: Record<string, string> = { "form.create": "created a form", "form.update": "edited a form", "form.live": "published a form", "form.closed": "closed a form", "form.draft": "moved a form to draft", "form.delete": "deleted a form", "response.approved": "approved", "response.rejected": "rejected", "response.pending": "moved back to pending", "response.delete": "deleted responses", "response.export": "exported responses", "backup.run": "ran a backup", "team.save": "updated an admin", "team.remove": "removed an admin", "settings.update": "changed settings", "link.create": "created a share link" };

export default function TeamPane({ context }: { context: AdminContext }) {
  const { me, forms } = context, run = useAction();
  const { data, error, reload } = useLoad(() => call<TeamData>("/admin/team"), []);
  const [editing, setEditing] = useState<{ email: string; name: string; permissions: string[]; formIds: string[]; existing: boolean } | null>(null), [removing, setRemoving] = useState<TeamMember | null>(null), [busy, setBusy] = useState(false);
  if (error) return <Failure message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const groups = [...new Set(me.catalog.map(item => item.group))];
  const presetOf = (permissions: string[]) => Object.entries(me.presets).find(([, list]) => list.length === permissions.length && list.every(id => permissions.includes(id)))?.[0];
  const save = async () => { if (!editing?.name.trim()) return; setBusy(true); const done = await run(() => call("/admin/team", { method: "PUT", body: { email: editing.email, name: editing.name, permissions: editing.permissions, formIds: editing.formIds } }), editing.existing ? "Access updated." : "Admin added. They can sign in at /admin with their reader account."); setBusy(false); if (done) { setEditing(null); reload(); } };
  const toggle = (id: string) => setEditing(current => current && ({ ...current, permissions: current.permissions.includes(id) ? current.permissions.filter(item => item !== id) : [...current.permissions, id] }));
  return <>
    <header className="va-head"><div><h1>Team and access</h1><p>Owners have full access. Add other admins and choose exactly what each one can see and do.</p></div><div className="va-actions"><button type="button" className="vg-btn is-primary" onClick={() => setEditing({ email: "", name: "", permissions: [...me.presets.reviewer], formIds: [], existing: false })}><PlusIcon aria-hidden="true" />Add an admin</button></div></header>
    <Card title="People">
      <div className="va-tablewrap"><table className="va-table"><thead><tr><th>Person</th><th>Role</th><th>Forms</th><th>Added</th><th /></tr></thead><tbody>
        {data.owners.map(email => <tr key={email} style={{ cursor: "default" }}><td style={{ fontWeight: 600 }}>{email}</td><td><span className="vg-chip" data-tone="good">Owner</span></td><td>All forms</td><td className="vg-muted">Set on the server</td><td /></tr>)}
        {data.members.map(member => <tr key={member.email} onClick={() => setEditing({ email: member.email, name: member.name, permissions: member.permissions, formIds: member.formIds ?? [], existing: true })}>
          <td><strong style={{ fontWeight: 600 }}>{member.name || member.email}</strong>{member.name && <div className="vg-muted" style={{ fontSize: "0.82rem" }}>{member.email}</div>}</td>
          <td><span className="vg-chip is-plain">{PRESET_LABELS[presetOf(member.permissions) ?? ""] ?? `Custom · ${member.permissions.length} permissions`}</span></td><td>{member.formIds ? `${member.formIds.length} selected` : "All forms"}</td><td className="vg-num">{formatDate(member.addedAt, false)}</td>
          <td onClick={event => event.stopPropagation()} style={{ textAlign: "right" }}><button type="button" className="vg-btn is-quiet is-icon is-small" aria-label={`Remove ${member.email}`} onClick={() => setRemoving(member)}><TrashIcon /></button></td></tr>)}
      </tbody></table></div>
      {data.members.length === 0 && <p className="va-note" style={{ marginTop: 12 }}>Only owners so far. Added admins sign in with their own Vidurneeti reader account, so they need to register and verify their email on the site first.</p>}
      <p className="va-note" style={{ marginTop: 12 }}>Owners are set with <span className="va-code">VN_ADMIN_EMAILS</span> on the server, so nobody can remove an owner from this screen.</p>
    </Card>
    <Card title="Recent admin activity" note="Who did what, newest first.">{data.audit.length ? <div className="va-tablewrap" style={{ maxHeight: 360, overflowY: "auto" }}><table className="va-table"><tbody>{data.audit.map((entry, index) => <tr key={index} style={{ cursor: "default" }}><td className="vg-num vg-muted" style={{ width: 170 }}>{formatDate(entry.at)}</td><td><strong style={{ fontWeight: 600 }}>{entry.actor}</strong> {ACTIONS[entry.action] ?? entry.action} <span className="vg-muted">{[forms.find(form => form.id === entry.target)?.title ?? entry.target, entry.detail].filter(Boolean).join(" · ")}</span></td></tr>)}</tbody></table></div> : <p className="va-note">Nothing yet.</p>}</Card>
    {editing && <Modal wide title={editing.existing ? "Change access" : "Add an admin"} onClose={() => setEditing(null)} footer={<><button type="button" className="vg-btn" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="vg-btn is-primary" disabled={busy || !editing.email.includes("@") || !editing.name.trim() || !editing.permissions.length} onClick={() => void save()}>{busy ? "Saving…" : editing.existing ? "Save access" : "Add admin"}</button></>}>
      <div className="va-fieldgrid"><label className="vg-label">Email of their reader account<input className="vg-input" type="email" value={editing.email} disabled={editing.existing} onChange={event => setEditing({ ...editing, email: event.target.value })} /></label><label className="vg-label">Name<input className="vg-input" required value={editing.name} maxLength={80} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label></div>
      <div className="vg-label">Start from a role<div className="va-tabs vg-glass" role="group" aria-label="Role presets">{Object.keys(me.presets).map(preset => <button type="button" key={preset} aria-pressed={presetOf(editing.permissions) === preset} onClick={() => setEditing({ ...editing, permissions: [...me.presets[preset]] })}>{PRESET_LABELS[preset] ?? preset}</button>)}</div></div>
      <div className="vt-perms">{groups.map(group => <div key={group} style={{ display: "contents" }}><h4>{group}</h4>{me.catalog.filter(item => item.group === group).map(item => <label key={item.id}><input type="checkbox" className="va-check" checked={editing.permissions.includes(item.id)} disabled={item.id === "team.manage" && !me.owner} onChange={() => toggle(item.id)} />{item.label}</label>)}</div>)}</div>
      {forms.length > 1 && <div className="vg-label">Limit to specific forms<div className="va-stack" style={{ gap: 2 }}>{forms.map(form => <label key={form.id} className="va-row" style={{ minHeight: 32, cursor: "pointer", fontWeight: 400, color: "var(--vg-text)" }}><input type="checkbox" className="va-check" checked={editing.formIds.includes(form.id)} onChange={() => setEditing({ ...editing, formIds: editing.formIds.includes(form.id) ? editing.formIds.filter(id => id !== form.id) : [...editing.formIds, form.id] })} />{form.title}</label>)}</div><span className="va-note" style={{ fontWeight: 400 }}>Leave all unticked to give access to every form, including future ones.</span></div>}
    </Modal>}
    {removing && <Confirm title={`Remove ${removing.email}?`} body="They lose access to the admin console immediately. Their reader account stays as it is." action="Remove admin" danger onClose={() => setRemoving(null)} onConfirm={async () => { await run(() => call(`/admin/team/${encodeURIComponent(removing.email)}`, { method: "DELETE" }), "Admin removed."); reload(); }} />}
  </>;
}

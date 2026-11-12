import { useMemo, useState } from "react";
import { CopyIcon, DownloadIcon, PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { allFields } from "../../server/formLogic.mjs";
import { call, type AdminForm, type ShareLink } from "../forms/api";
import { qrSvg } from "../forms/qr";
import type { AdminContext } from "./AdminApp";
import { Card } from "./charts";
import { Confirm, Failure, Loading, Modal, number, useAction, useLoad, useToast } from "./ui";

interface LinksData { direct: { views: number; starts: number; responses: number }; links: ShareLink[]; origin: string; slug: string }

function saveFile(name: string, blob: Blob) { const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 2000); }
async function savePng(name: string, svg: string) {
  const image = new Image(), url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The QR image couldn't be drawn.")); image.src = url; });
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024; const context = canvas.getContext("2d")!; context.imageSmoothingEnabled = false; context.drawImage(image, 0, 0, 1024, 1024); URL.revokeObjectURL(url);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png")); if (blob) saveFile(name, blob);
}

function QrBlock({ url, name, title }: { url: string; name: string; title: string }) {
  const toast = useToast();
  const svg = useMemo(() => { try { return qrSvg(url); } catch { return ""; } }, [url]);
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch { toast("Copy didn't work. Select the link and copy it manually.", "bad"); } };
  return <div className="vs-qr">
    {svg ? <div className="vs-qr-code" role="img" aria-label={`QR code for ${title}`} dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="va-note">This link is too long for a QR code.</p>}
    <div className="va-stack">
      <div className="vs-url"><input className="vg-input is-small" readOnly aria-label={`${title} link`} value={url} onFocus={event => event.target.select()} /><button type="button" className="vg-btn is-small is-primary" onClick={() => void copy()}><CopyIcon aria-hidden="true" />Copy</button></div>
      {svg && <div className="va-row"><button type="button" className="vg-btn is-small" onClick={() => void savePng(`${name}-qr.png`, svg).catch(error => toast(error.message, "bad"))}><DownloadIcon aria-hidden="true" />QR as PNG</button><button type="button" className="vg-btn is-small" onClick={() => saveFile(`${name}-qr.svg`, new Blob([svg], { type: "image/svg+xml" }))}><DownloadIcon aria-hidden="true" />QR as SVG (for print)</button></div>}
    </div>
  </div>;
}

export default function SharePane({ context, form }: { context: AdminContext; form: AdminForm }) {
  const run = useAction(), canManage = context.can("links.manage");
  const { data, error, reload } = useLoad(() => call<LinksData>(`/admin/forms/${form.id}/links`), [form.id]);
  const [creating, setCreating] = useState(false), [label, setLabel] = useState(""), [code, setCode] = useState(""), [prefillField, setPrefillField] = useState(""), [prefillValue, setPrefillValue] = useState(""), [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState<ShareLink | null>(null), [removing, setRemoving] = useState<ShareLink | null>(null);
  const fields = useMemo(() => allFields(form.schema).filter(field => ["short", "long", "state", "email", "phone", "number"].includes(field.type)), [form.schema]);
  if (error) return <Failure message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const base = `${data.origin}/f/${data.slug}`, linkUrl = (link: ShareLink) => `${data.origin}/go/${link.code}`;
  const create = async () => {
    setBusy(true);
    const made = await run(() => call<{ code: string }>(`/admin/forms/${form.id}/links`, { body: { label, code, prefill: prefillField && prefillValue ? { [prefillField]: prefillValue } : {} } }), "Link created.");
    setBusy(false);
    if (made) { setCreating(false); setLabel(""); setCode(""); setPrefillField(""); setPrefillValue(""); reload(); }
  };
  const rate = (responses: number, views: number) => (views ? `${Math.round((responses / views) * 100)}%` : "—");
  return <div className="va-stack" style={{ gap: 18 }}>
    {form.status !== "live" && <p className="vg-alert" data-tone="warn">This form is {form.status === "draft" ? "still a draft" : "closed"}. Links and QR codes work once you publish it.</p>}
    <Card title="Form link and QR code" note={`${number(data.direct.views)} opens · ${number(data.direct.responses)} responses from the plain link`}><QrBlock url={base} name={form.slug} title={form.title} /></Card>
    <Card title="Custom links" note="Give each channel its own short link to see which one brings responses." action={canManage ? <button type="button" className="vg-btn is-small is-primary" onClick={() => setCreating(true)}><PlusIcon aria-hidden="true" />New link</button> : undefined}>
      {data.links.length === 0 ? <p className="va-note">No custom links yet. Create one for each place you post the form: a Telegram post, WhatsApp groups, a printed poster.</p>
        : <div>{data.links.map(link => <div key={link.code} className="vs-link">
          <div style={{ minWidth: 0 }}><strong>{link.label}</strong><div className="va-code va-truncate" style={{ display: "block", marginTop: 4, width: "fit-content", maxWidth: "100%" }}>{linkUrl(link).replace(/^https?:\/\//, "")}</div>
            <p className="va-note vg-num" style={{ marginTop: 6 }}>{number(link.views)} opens · {number(link.starts)} started · {number(link.responses)} responses · {rate(link.responses, link.views)} converted{Object.keys(link.prefill).length ? " · pre-fills an answer" : ""}</p></div>
          <div className="va-row"><button type="button" className="vg-btn is-small" onClick={() => setShowQr(link)}>Link and QR</button>{canManage && <button type="button" className="vg-btn is-small is-quiet is-icon" aria-label={`Delete ${link.label}`} onClick={() => setRemoving(link)}><TrashIcon /></button>}</div>
        </div>)}</div>}
    </Card>
    <Card title="Inside Telegram" note="The same bot that sends backups can open the site as a web app."><p className="va-note">Once the bot's menu button is set (Backups and Telegram), people who open the form from the bot are linked to their Telegram account automatically, and the bot can message them when you approve their response. Use this web app link in posts: <span className="va-code">{base}</span></p></Card>
    {creating && <Modal title="New custom link" onClose={() => setCreating(false)} footer={<><button type="button" className="vg-btn" onClick={() => setCreating(false)}>Cancel</button><button type="button" className="vg-btn is-primary" disabled={busy || !label.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create link"}</button></>}>
      <label className="vg-label">Where will you post it?<input className="vg-input" value={label} maxLength={80} placeholder="Telegram channel post" onChange={event => setLabel(event.target.value)} /></label>
      <label className="vg-label">Custom ending (optional)<input className="vg-input" value={code} maxLength={40} placeholder="pune-meetup" onChange={event => setCode(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /><span className="va-note" style={{ fontWeight: 400 }}>{data.origin.replace(/^https?:\/\//, "")}/go/{code || "a-short-code"}</span></label>
      {fields.length > 0 && <div className="va-fieldgrid"><label className="vg-label">Pre-fill a question (optional)<select className="vg-select is-small" value={prefillField} onChange={event => setPrefillField(event.target.value)}><option value="">Don't pre-fill</option>{fields.map(field => <option key={field.id} value={field.id}>{field.label.slice(0, 44)}</option>)}</select></label>
        {prefillField && <label className="vg-label">With this answer<input className="vg-input is-small" value={prefillValue} maxLength={300} onChange={event => setPrefillValue(event.target.value)} /></label>}</div>}
    </Modal>}
    {showQr && <Modal title={showQr.label} wide onClose={() => setShowQr(null)}><QrBlock url={linkUrl(showQr)} name={`${form.slug}-${showQr.code}`} title={showQr.label} /></Modal>}
    {removing && <Confirm title={`Delete “${removing.label}”?`} body="The short link and any printed QR codes for it stop working. Responses already collected through it are kept." action="Delete link" danger onClose={() => setRemoving(null)} onConfirm={async () => { await run(() => call(`/admin/forms/${form.id}/links/${removing.code}`, { method: "DELETE" }), "Link deleted."); reload(); }} />}
  </div>;
}

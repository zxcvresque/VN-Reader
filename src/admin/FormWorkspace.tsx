import { useCallback, useEffect, type MouseEvent } from "react";
import { refreshAutoShareImage, type ShareImageInfo } from "./shareCard";
import { BarChartIcon, ExternalLinkIcon, ListBulletIcon, Pencil2Icon, Share1Icon } from "@radix-ui/react-icons";
import { call, type AdminForm } from "../forms/api";
import type { AdminContext } from "./AdminApp";
import { Failure, Loading, StatusChip, useAction, useLoad } from "./ui";
import ResponsesPane from "./ResponsesPane";
import InsightsPane from "./InsightsPane";
import BuilderPane from "./BuilderPane";
import SharePane from "./SharePane";

type Tab = "responses" | "insights" | "build" | "share";
export default function FormWorkspace({ context, formId, tab }: { context: AdminContext; formId: string; tab: Tab }) {
  const { can, go, reloadForms } = context, run = useAction();
  const { data, setData, error, loading, reload } = useLoad(() => call<{ form: AdminForm; hasCustomFont: boolean; shareImage: ShareImageInfo | null }>(`/admin/forms/${formId}`), [formId]);
  const setShareImage = useCallback((shareImage: ShareImageInfo | null) => setData(current => (current ? { ...current, shareImage } : current)), [setData]);
  // The generated share picture follows the form's title and description. Uploaded pictures are left alone.
  const onSaved = useCallback((form: AdminForm) => { setData(current => (current ? { ...current, form } : current)); reloadForms(); if (can("forms.write")) void refreshAutoShareImage(form, data?.shareImage).then(setShareImage); }, [setData, reloadForms, can, data?.shareImage, setShareImage]);
  const missingPicture = !!data && !data.shareImage && can("forms.write");
  useEffect(() => { if (missingPicture && data) void refreshAutoShareImage(data.form, null).then(setShareImage); }, [missingPicture]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading label="Opening the form" />;
  if (error || !data) return <Failure message={error} onRetry={reload} />;
  const { form } = data;
  const tabs: Array<{ id: Tab; label: string; icon: JSX.Element; show: boolean }> = [
    { id: "responses", label: "Responses", icon: <ListBulletIcon aria-hidden="true" />, show: can("responses.read") },
    { id: "insights", label: "Statistics", icon: <BarChartIcon aria-hidden="true" />, show: can("insights.read") },
    { id: "build", label: "Edit form", icon: <Pencil2Icon aria-hidden="true" />, show: can("forms.write") },
    { id: "share", label: "Share", icon: <Share1Icon aria-hidden="true" />, show: can("forms.read") }
  ].filter(item => item.show) as Array<{ id: Tab; label: string; icon: JSX.Element; show: boolean }>;
  const active = tabs.some(item => item.id === tab) ? tab : tabs[0]?.id;
  const setStatus = async (status: AdminForm["status"]) => { const result = await run(() => call<{ form: AdminForm }>(`/admin/forms/${form.id}`, { method: "PUT", body: { status } }), status === "live" ? "Published. The form is accepting responses." : status === "closed" ? "Closed. The form no longer accepts responses." : "Moved back to draft."); if (result) onSaved(result.form); };
  return <>
    <header className="va-head">
      <div><div className="va-row" style={{ marginBottom: 8 }}><StatusChip status={form.status} />{context.sample && <span className="vg-chip" data-tone="sample">Demo data</span>}<span className="va-code">/f/{form.slug}</span></div><h1>{form.title}</h1></div>
      <div className="va-actions">
        {form.status !== "draft" && <a className="vg-btn" href={`/f/${form.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLinkIcon aria-hidden="true" />Open form</a>}
        {can("forms.write") && (form.status === "live" ? <button type="button" className="vg-btn" onClick={() => void setStatus("closed")}>Stop accepting responses</button> : <button type="button" className="vg-btn is-primary" onClick={() => void setStatus("live")}>{form.status === "draft" ? "Publish form" : "Reopen form"}</button>)}
      </div>
    </header>
    <nav className="va-tabs vg-glass" aria-label="Form sections">{tabs.map(item => <a key={item.id} href={`/admin/forms/${form.id}/${item.id}`} aria-current={active === item.id ? "page" : undefined} onClick={(event: MouseEvent) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); go(`/admin/forms/${form.id}/${item.id}`); }}>{item.icon}{item.label}</a>)}</nav>
    {active === "responses" && <ResponsesPane context={context} form={form} onChanged={reloadForms} />}
    {active === "insights" && <InsightsPane form={form} sample={context.sample} onOpenResponses={can("responses.read") ? query => go(`/admin/forms/${form.id}/responses?${query}`) : undefined} />}
    {active === "build" && <BuilderPane context={context} form={form} hasCustomFont={data.hasCustomFont} onSaved={onSaved} onFont={reload} />}
    {active === "share" && <SharePane context={context} form={form} shareImage={data.shareImage} onShareImage={setShareImage} />}
  </>;
}

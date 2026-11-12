import { useMemo, useState } from "react";
import { call, type AdminForm, type Insights, type QuestionInsight } from "../forms/api";
import { BarList, Card, Columns, Funnel, HourStrip, StateTileMap, TrendChart } from "./charts";
import { Failure, Loading, number, useLoad } from "./ui";

const RANGES = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }, { id: "all", label: "All time" }];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function QuestionCard({ question }: { question: QuestionInsight }) {
  const rate = question.total ? Math.round((question.answered / question.total) * 100) : 0;
  return <section className="va-card vg-glass">
    <h2 style={{ fontSize: "0.98rem", lineHeight: 1.35 }}>{question.label}</h2>
    <p className="va-note vg-num" style={{ marginTop: 6 }}>{question.answered} of {question.total} answered ({rate}%){question.required ? "" : " · optional"}</p>
    <div className="vq-rate" aria-hidden="true"><i style={{ width: `${rate}%`, background: "var(--vg-series-1)" }} /></div>
    {question.kind === "choice" && <BarList items={question.options ?? []} limit={8} empty="No answers yet" />}
    {question.kind === "number" && (question.stats ? <><Columns items={question.buckets ?? []} label={`Distribution for ${question.label}`} /><p className="va-note vg-num" style={{ marginTop: 8 }}>Average {question.stats.average} · median {question.stats.median} · range {question.stats.min}–{question.stats.max}</p></> : <p className="va-note">No answers yet</p>)}
    {question.kind === "text" && (question.answered ? <>{(question.topWords?.length ?? 0) > 0 ? <><p className="va-note" style={{ marginBottom: 8 }}>Words that come up most</p><div className="vc-words">{question.topWords!.map(word => <span key={word.name}>{word.name}<small>{word.count}</small></span>)}</div></> : <p className="va-note">Written answers, about {question.averageLength} characters each. Read them in Responses.</p>}</> : <p className="va-note">No answers yet</p>)}
  </section>;
}

export default function InsightsPane({ form, onOpenState }: { form: AdminForm; onOpenState: (state: string) => void }) {
  const [range, setRange] = useState("30"), [table, setTable] = useState(false);
  const query = useMemo(() => (range === "all" ? `?from=${encodeURIComponent(form.createdAt)}` : `?from=${encodeURIComponent(new Date(Date.now() - Number(range) * 86400000).toISOString())}`), [range, form.createdAt]);
  const { data, error, loading, reload } = useLoad(() => call<Insights>(`/admin/forms/${form.id}/insights${query}`), [form.id, query]);
  if (error) return <Failure message={error} onRetry={reload} />;
  if (!data) return <Loading label="Crunching the numbers" />;
  const { totals } = data, change = totals.prev7 ? Math.round(((totals.last7 - totals.prev7) / totals.prev7) * 100) : null;
  return <div className="va-stack" style={{ gap: 18, opacity: loading ? 0.6 : 1, transition: "opacity 160ms ease" }}>
    <div className="va-row" style={{ justifyContent: "space-between" }}>
      <div className="va-tabs vg-glass" role="group" aria-label="Time range">{RANGES.map(item => <button type="button" key={item.id} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</div>
      <span className="va-note">Days and hours use {data.range.timezone.replace("_", " ")} time.</span>
    </div>
    <div className="va-tiles">
      <div className="va-tile vg-glass"><span>Responses</span><strong>{number(totals.responses)}</strong><small data-trend={change === null ? undefined : change >= 0 ? "up" : "down"}>{change === null ? `${totals.last7} in the last 7 days` : `${change >= 0 ? "Up" : "Down"} ${Math.abs(change)}% on the week before`}</small></div>
      <div className="va-tile vg-glass"><span>Waiting for review</span><strong>{number(totals.pending)}</strong><small>{number(totals.approved)} approved · {number(totals.rejected)} rejected, all time</small></div>
      <div className="va-tile vg-glass"><span>Completion rate</span><strong>{totals.completionRate === null ? "—" : `${totals.completionRate}%`}</strong><small>of people who start, finish</small></div>
      <div className="va-tile vg-glass"><span>Typical time to fill</span><strong>{totals.medianDurationMs ? `${Math.max(1, Math.round(totals.medianDurationMs / 60000))} min` : "—"}</strong><small>median</small></div>
      <div className="va-tile vg-glass"><span>States reached</span><strong>{totals.states}</strong><small>of 36 states and territories</small></div>
    </div>
    <Card title="Smart insights" note="Worked out from this period's responses. Refreshes as new ones arrive."><div className="vi-list">{data.insights.map(item => <div key={item.title} className="vi-item" data-tone={item.tone}><i aria-hidden="true" /><div><strong>{item.title}</strong><span>{item.detail}</span></div></div>)}</div></Card>
    <Card title="Responses over time" action={<button type="button" className="vg-btn is-quiet is-small" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Show chart" : "Show as table"}</button>}>
      {table ? <div className="va-tablewrap" style={{ maxHeight: 320, overflowY: "auto" }}><table className="va-table"><thead><tr><th>Day</th><th>Submitted</th><th>Approved</th><th>Form opens</th></tr></thead><tbody>{[...data.daily].reverse().map(row => <tr key={row.day} style={{ cursor: "default" }}><td className="vg-num">{row.day}</td><td className="vg-num">{row.submitted}</td><td className="vg-num">{row.approved}</td><td className="vg-num">{row.views}</td></tr>)}</tbody></table></div>
        : <TrendChart data={data.daily} series={[{ key: "submitted", label: "Submitted", color: "var(--vg-series-1)" }, { key: "approved", label: "Approved so far", color: "var(--vg-series-2)" }]} />}
    </Card>
    <div className="va-grid cols-2">
      <Card title="Where responses come from" note="Each state and territory is one tile, so small ones stay visible."><StateTileMap states={data.states} onPick={onOpenState} /></Card>
      <Card title="Top states" note="Click a state to open its responses."><BarList items={data.states} total={totals.responses} limit={10} onPick={onOpenState} empty="No responses with a state yet" /></Card>
    </div>
    <div className="va-grid cols-3">
      <Card title="From opening to approval" note="How many people make it through each step."><Funnel steps={[{ label: "Opened the form", value: Math.max(totals.views, totals.starts) }, { label: "Started answering", value: totals.starts }, { label: "Submitted", value: totals.responses }, { label: "Approved", value: data.daily.reduce((sum, day) => sum + day.approved, 0) }]} /></Card>
      <Card title="Share links" note="Responses by the link people used.">{data.links.length ? <BarList items={data.links.map(link => ({ name: link.label, count: link.responses }))} empty="No responses yet" /> : <p className="va-note">Create custom links in the Share tab to compare sources.</p>}</Card>
      <Card title="Devices"><BarList items={data.devices.map(device => ({ name: device.name === "telegram" ? "Telegram app" : device.name[0].toUpperCase() + device.name.slice(1), count: device.count }))} /><p className="va-note" style={{ marginTop: 10 }}>{totals.telegramLinked} respondents can be messaged by the bot.</p></Card>
    </div>
    <div className="va-grid cols-2">
      <Card title="Time of day" note="Darker hours get more responses."><HourStrip hours={data.hours} /></Card>
      <Card title="Day of the week"><Columns items={data.weekdays.map((count, index) => ({ name: WEEKDAYS[index], count }))} label="Responses by day of the week" /></Card>
    </div>
    <header className="va-head" style={{ paddingTop: 10 }}><div><h2 style={{ fontSize: "1.3rem" }}>Question by question</h2><p>How each question was answered in this period.</p></div></header>
    <div className="vq-grid">{data.questions.map(question => <QuestionCard key={question.id} question={question} />)}</div>
  </div>;
}

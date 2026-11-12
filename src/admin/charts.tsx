import { useRef, useState, type ReactNode } from "react";
import type { NamedCount } from "../forms/api";

const ramp = (share: number) => `color-mix(in srgb, var(--vg-series-1) ${Math.round(22 + share * 78)}%, var(--vg-bg))`;
const shortDay = (day: string) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
function niceMax(value: number): number { if (value <= 4) return 4; const power = 10 ** Math.floor(Math.log10(value)); for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power; return 10 * power; }

/** Two-series daily trend with a crosshair tooltip. */
export function TrendChart({ data, series }: { data: Array<{ day: string } & Record<string, number | string>>; series: Array<{ key: string; label: string; color: string }> }) {
  const [hover, setHover] = useState<number | null>(null), box = useRef<HTMLDivElement>(null);
  const width = 720, height = 240, pad = { left: 34, right: 12, top: 10, bottom: 26 }, innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...data.flatMap(row => series.map(item => Number(row[item.key]) || 0))));
  const x = (index: number) => pad.left + (data.length <= 1 ? innerW / 2 : (index / (data.length - 1)) * innerW), y = (value: number) => pad.top + innerH - (value / max) * innerH;
  const ticks = [0, max / 2, max], every = Math.max(1, Math.ceil(data.length / 7));
  const move = (clientX: number) => { const rect = box.current?.getBoundingClientRect(); if (!rect || !data.length) return; const ratio = ((clientX - rect.left) / rect.width * width - pad.left) / innerW; setHover(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1))))); };
  return <div>
    <div className="vc-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
    <div className="vc" ref={box} onPointerMove={event => move(event.clientX)} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily trend: ${series.map(item => item.label).join(", ")}`}>
        {ticks.map(tick => <g key={tick}><line className="vc-grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} /><text x={pad.left - 8} y={y(tick) + 4} textAnchor="end">{Math.round(tick)}</text></g>)}
        {data.map((row, index) => (index % every === 0 || index === data.length - 1) && (data.length - 1 - index >= every / 2 || index === data.length - 1) ? <text key={row.day} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === data.length - 1 ? "end" : "middle"}>{shortDay(row.day)}</text> : null)}
        {series.map((item, order) => { const points = data.map((row, index) => `${x(index)},${y(Number(row[item.key]) || 0)}`); return <g key={item.key}>
          {order === 0 && data.length > 1 && <polygon points={`${pad.left},${y(0)} ${points.join(" ")} ${x(data.length - 1)},${y(0)}`} fill={item.color} opacity={0.1} />}
          <polyline points={points.join(" ")} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </g>; })}
        {hover !== null && <g><line className="vc-grid" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} style={{ stroke: "var(--vg-muted)" }} />{series.map(item => <circle key={item.key} cx={x(hover)} cy={y(Number(data[hover][item.key]) || 0)} r={5} fill={item.color} stroke="var(--vg-bg)" strokeWidth={2} />)}</g>}
      </svg>
      {hover !== null && <div className="vc-tip" style={{ left: `${(x(hover) / width) * 100}%`, top: `${(Math.min(...series.map(item => y(Number(data[hover][item.key]) || 0))) / height) * 100}%` }}><b>{shortDay(data[hover].day)}</b>{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}: <b style={{ color: "var(--vg-text)" }}>{Number(data[hover][item.key]) || 0}</b></span>)}</div>}
    </div>
  </div>;
}

/** Categorical slots in fixed order. Past eight, answers fold into a neutral "other" colour. */
export const seriesColor = (index: number) => (index < 8 ? `var(--vg-series-${index + 1})` : "var(--vg-faint)");
const STATUS = [{ key: "approved", label: "Approved", color: "var(--vg-mark-good)" }, { key: "pending", label: "Pending", color: "var(--vg-mark-warn)" }, { key: "rejected", label: "Rejected", color: "var(--vg-mark-bad)" }] as const;

/** Ranked horizontal bars. Pass `colored` when each row is a different thing (an answer, a device),
 *  so each keeps its own hue; leave it off for pure magnitude comparisons. */
export function BarList({ items, total, limit = 12, onPick, empty = "No data yet", unit = "", colored = false }: { items: NamedCount[]; total?: number; limit?: number; onPick?: (name: string) => void; empty?: string; unit?: string; colored?: boolean }) {
  const [all, setAll] = useState(false);
  if (!items.length || items.every(item => !item.count)) return <p className="va-note">{empty}</p>;
  const max = Math.max(1, ...items.map(item => item.count)), sum = total ?? items.reduce((value, item) => value + item.count, 0), shown = all ? items : items.slice(0, limit);
  return <div className="vc-bars">{shown.map(item => { const row = <><span title={item.name}>{item.name}</span><span className="vc-bar-track"><i style={{ width: `${(item.count / max) * 100}%`, ...(colored ? { background: seriesColor(items.indexOf(item)) } : {}) }} /></span><b>{item.count}{unit}{sum > 0 && !unit && <small>{Math.round((item.count / sum) * 100)}%</small>}</b></>;
    return onPick ? <button type="button" key={item.name} className="vc-bar" style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", textAlign: "left", font: "inherit", fontSize: "0.87rem" }} onClick={() => onPick(item.name)} title={`Show responses from ${item.name}`}>{row}</button> : <div key={item.name} className="vc-bar">{row}</div>; })}
    {items.length > limit && <button type="button" className="vg-btn is-quiet is-small" style={{ justifySelf: "start" }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}</div>;
}

/** Each state's responses split by review status, with a legend. */
export function StatusBars({ items, limit = 10, onPick }: { items: Array<NamedCount & { approved: number; pending: number }>; limit?: number; onPick?: (name: string) => void }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="va-note">No responses with a state yet</p>;
  const max = Math.max(1, ...items.map(item => item.count)), shown = all ? items : items.slice(0, limit);
  return <div className="vc-bars">
    <div className="vc-legend" aria-hidden="true">{STATUS.map(status => <span key={status.key}><i style={{ background: status.color }} />{status.label}</span>)}</div>
    {shown.map(item => { const parts = { approved: item.approved, pending: item.pending, rejected: Math.max(0, item.count - item.approved - item.pending) };
      const label = `${item.name}: ${item.count} responses, ${parts.approved} approved, ${parts.pending} pending, ${parts.rejected} rejected`;
      return <button type="button" key={item.name} className="vc-bar is-button" aria-label={label} title={label} onClick={() => onPick?.(item.name)}>
        <span>{item.name}</span>
        <span className="vc-bar-track is-stack" style={{ width: `${(item.count / max) * 100}%` }}>{STATUS.map(status => parts[status.key] ? <i key={status.key} style={{ flex: parts[status.key], background: status.color }} /> : null)}</span>
        <b>{item.count}</b></button>; })}
    {items.length > limit && <button type="button" className="vg-btn is-quiet is-small" style={{ justifySelf: "start" }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}
  </div>;
}
/** One stacked bar for the whole review queue. */
export function StatusSplit({ approved, pending, rejected }: { approved: number; pending: number; rejected: number }) {
  const parts = { approved, pending, rejected }, total = approved + pending + rejected;
  if (!total) return null;
  return <span className="vc-split" role="img" aria-label={`${approved} approved, ${pending} pending, ${rejected} rejected`}>{STATUS.map(status => parts[status.key] ? <i key={status.key} title={`${status.label}: ${parts[status.key]}`} style={{ flex: parts[status.key], background: status.color }} /> : null)}</span>;
}

export function Columns({ items, label }: { items: NamedCount[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 320, height = 120, max = Math.max(1, ...items.map(item => item.count)), slot = width / Math.max(1, items.length), bar = Math.max(4, Math.min(34, slot - 4));
  return <div className="vc"><svg viewBox={`0 0 ${width} ${height + 18}`} role="img" aria-label={label}>
    <line className="vc-grid" x1={0} x2={width} y1={height} y2={height} />
    {items.map((item, index) => { const h = (item.count / max) * (height - 8), cx = index * slot + slot / 2; return <g key={item.name} onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}>
      <rect x={index * slot} y={0} width={slot} height={height} fill="transparent" /><path d={`M${cx - bar / 2},${height} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${bar - 8} q4,0 4,4 v${Math.max(0, h - 4)} z`} fill="var(--vg-series-1)" opacity={hover === null || hover === index ? 1 : 0.55} />
      {(items.length <= 12 || index % 2 === 0) && <text x={cx} y={height + 14} textAnchor="middle">{item.name}</text>}</g>; })}
  </svg>{hover !== null && <div className="vc-tip" style={{ left: `${((hover + 0.5) * slot / width) * 100}%`, top: 0, transform: "translate(-50%, 0)" }}><b>{items[hover].name}</b><span>{items[hover].count} response{items[hover].count === 1 ? "" : "s"}</span></div>}</div>;
}

const TILES: Array<[string, string, number, number]> = [
  ["JK", "Jammu and Kashmir", 3, 0], ["LA", "Ladakh", 4, 0],
  ["PB", "Punjab", 2, 1], ["CH", "Chandigarh", 3, 1], ["HP", "Himachal Pradesh", 4, 1], ["UK", "Uttarakhand", 5, 1],
  ["RJ", "Rajasthan", 1, 2], ["HR", "Haryana", 2, 2], ["DL", "Delhi", 3, 2], ["UP", "Uttar Pradesh", 4, 2], ["BR", "Bihar", 5, 2], ["SK", "Sikkim", 7, 2], ["AR", "Arunachal Pradesh", 9, 2],
  ["GJ", "Gujarat", 1, 3], ["MP", "Madhya Pradesh", 3, 3], ["CG", "Chhattisgarh", 4, 3], ["JH", "Jharkhand", 5, 3], ["WB", "West Bengal", 6, 3], ["AS", "Assam", 8, 3], ["NL", "Nagaland", 9, 3],
  ["DD", "Dadra and Nagar Haveli and Daman and Diu", 0, 4], ["MH", "Maharashtra", 2, 4], ["TS", "Telangana", 3, 4], ["OD", "Odisha", 5, 4], ["ML", "Meghalaya", 7, 4], ["TR", "Tripura", 8, 4], ["MN", "Manipur", 9, 4],
  ["GA", "Goa", 1, 5], ["KA", "Karnataka", 2, 5], ["AP", "Andhra Pradesh", 3, 5], ["MZ", "Mizoram", 9, 5],
  ["LD", "Lakshadweep", 0, 6], ["KL", "Kerala", 2, 6], ["TN", "Tamil Nadu", 3, 6], ["PY", "Puducherry", 4, 6], ["AN", "Andaman and Nicobar Islands", 10, 6]
];
/** A tile map: every state and territory gets the same area, so small ones stay visible. */
export function StateTileMap({ states, onPick }: { states: Array<NamedCount & { approved: number; pending: number }>; onPick?: (state: string) => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  const byName = new Map(states.map(state => [state.name, state])), max = Math.max(1, ...states.map(state => state.count)), outside = byName.get("Outside India");
  const detail = focus ? byName.get(focus) : null;
  return <div>
    <div className="vc-tilemap" role="group" aria-label="Responses by state and union territory">{TILES.map(([code, name, column, row]) => { const count = byName.get(name)?.count ?? 0; return <button type="button" key={code} className="vc-tile" data-on={count > 0} aria-pressed={focus === name} aria-label={`${name}: ${count} response${count === 1 ? "" : "s"}`} title={`${name}: ${count}`} style={{ gridColumn: column + 1, gridRow: row + 1, background: count ? ramp(count / max) : undefined }} onPointerEnter={() => setFocus(name)} onFocus={() => setFocus(name)} onClick={() => { setFocus(name); if (count && onPick) onPick(name); }}>{code}</button>; })}</div>
    <div className="vc-ramp"><span>Fewer</span><i style={{ background: `linear-gradient(90deg, ${ramp(0)}, ${ramp(1)})` }} /><span>More responses</span></div>
    <p className="va-note" style={{ textAlign: "center", marginTop: 10, minHeight: "2.6em" }} aria-live="polite">{focus ? <><strong style={{ color: "var(--vg-text)" }}>{focus}</strong>: {detail ? `${detail.count} response${detail.count === 1 ? "" : "s"}, ${detail.approved} approved, ${detail.pending} pending` : "no responses yet"}</> : "Hover or tap a tile for details. Click a state with responses to open them."}{outside ? <><br />Outside India: {outside.count}</> : null}</p>
  </div>;
}

export function HourStrip({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours), label = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
  return <div><div className="vc-heat" role="img" aria-label="Responses by hour of day">{hours.map((count, hour) => <i key={hour} title={`${label(hour)}: ${count} response${count === 1 ? "" : "s"}`} style={{ background: count ? ramp(count / max) : undefined }} />)}</div><div className="vc-heat-axis" aria-hidden="true">{hours.map((_, hour) => <span key={hour}>{hour % 6 === 0 ? label(hour) : ""}</span>)}</div></div>;
}

export function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const top = Math.max(1, steps[0]?.value ?? 1);
  return <div className="vc-bars">{steps.map((step, index) => <div key={step.label} className="vc-bar" title={`${step.label}: ${step.value}`}><span>{step.label}</span><span className="vc-bar-track"><i style={{ width: `${Math.min(100, (step.value / top) * 100)}%` }} /></span><b>{step.value}{index > 0 && <small>{Math.round((step.value / top) * 100)}%</small>}</b></div>)}</div>;
}
export function Card({ title, note, children, action }: { title: string; note?: string; children: ReactNode; action?: ReactNode }) { return <section className="va-card vg-glass"><header><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</header>{children}</section>; }

import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon, PinLeftIcon } from "@radix-ui/react-icons";
import { call, type DistrictStats, type PlaceCounts, type PlacesData, type PlaceStats } from "../forms/api";
import { Card, StatusSplit } from "./charts";
import { Failure, Loading, formatDate, useLoad } from "./ui";
import "./places.css";

const METRICS = [
  { id: "count", label: "Responses", color: "var(--vg-series-1)" },
  { id: "approved", label: "Approved", color: "var(--vg-mark-good)" },
  { id: "pending", label: "Pending", color: "var(--vg-mark-warn)" },
  { id: "rejected", label: "Rejected", color: "var(--vg-mark-bad)" },
  { id: "approval", label: "Approval rate", color: "var(--vg-series-7)" },
  { id: "share", label: "Share of responses", color: "var(--vg-series-5)" },
  { id: "growth", label: "Week-over-week growth", color: "var(--vg-series-2)" },
  { id: "population", label: "Population estimate", color: "var(--vg-series-3)" },
] as const;
type Metric = typeof METRICS[number]["id"];
type Mode = "heat" | "bubbles" | "spikes";
type SortColumn = "name" | Metric;
type Level = "states" | "districts";
type TableWindow = "map" | "range" | "recent";

interface MapPreferences {
  metric?: Metric;
  mode?: Mode;
  level?: Level;
  state?: string;
  selection?: string;
  pin?: boolean;
  expanded?: boolean;
  recent?: boolean;
  normalize?: string;
  per?: string;
  scale?: string;
  custom?: string;
  tableLevel?: Level;
  tableWindow?: TableWindow;
  tableUnits?: string;
  sort?: { column: SortColumn; ascending: boolean };
}
type Bounds = [number, number, number, number];

interface Boundary {
  name: string;
  path?: string;
  point?: [number, number];
  bounds?: Bounds;
  population?: number;
}
interface StateBoundary extends Boundary {
  path: string;
  bounds: Bounds;
  districts: Boundary[];
}
interface Geography { population: number; states: StateBoundary[] }
interface Region extends Boundary {
  key: string;
  state?: string;
  district?: string;
  label: string;
  stats: PlaceStats;
}

const EMPTY_COUNTS: PlaceCounts = { count: 0, approved: 0, pending: 0, rejected: 0 };
const EMPTY: PlaceStats = { ...EMPTY_COUNTS, daily: EMPTY_COUNTS, recent: EMPTY_COUNTS, previous: 0, latest: null };
const PRESETS = [10, 100, 1000, 10000, 100000, 1000000];
const DENOMINATORS = [1000, 10000, 100000];
const LABELS: Record<Mode, string> = { heat: "Heatmap", bubbles: "Bubbles", spikes: "Spikes" };
const SHOW = 12;
const format = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const small = (value: number) => value > 0 && value < 0.01 ? "<0.01" : value < 0 && value > -0.01 ? ">−0.01" : format.format(value);
const integer = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
const percent = (metric: Metric) => metric === "approval" || metric === "share" || metric === "growth";
const isCount = (metric: Metric): metric is keyof PlaceCounts => ["count", "approved", "pending", "rejected"].includes(metric);

function ceiling(value: number) {
  if (!value) return 1;
  const unit = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find(step => step * unit >= value) ?? 10) * unit;
}

function readPreferences(key: string): MapPreferences {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "{}") ?? {}; }
  catch { return {}; }
}

function MapLegend({ mode, maximum, unit, capped, signed }: { mode: Mode; maximum: number; unit: string; capped: boolean; signed: boolean }) {
  const ticks = [0.25, 0.5, 1];
  return <div className="vp-legend" aria-label={`Legend, ${unit}, scale maximum ${format.format(maximum)}`}>
    {mode === "heat" ? <>
      <div className="vp-ramp" data-signed={signed} aria-hidden="true" />
      <div className="vp-ticks" style={{ "--vp-ticks": signed ? 5 : 4 } as CSSProperties} aria-hidden="true">{(signed ? [-1, -0.5, 0, 0.5, 1] : [0, 1 / 3, 2 / 3, 1]).map(fraction => <span key={fraction}>{small(maximum * fraction)}{Math.abs(fraction) === 1 && capped ? fraction < 0 ? "−" : "+" : ""}</span>)}</div>
    </> : <svg viewBox="0 0 255 64" aria-hidden="true">{ticks.map((fraction, index) => {
      const x = 47 + index * 80, size = mode === "bubbles" ? 19 * Math.sqrt(fraction) : 38 * fraction;
      return <g key={fraction}>
        {mode === "bubbles" ? <circle cx={x} cy={43 - size} r={size} /> : <path d={`M${x - 5},43L${x},${43 - size}L${x + 5},43Z`} />}
        <text x={x} y={59} textAnchor="middle">{small(maximum * fraction)}{fraction === 1 && capped ? "+" : ""}</text>
      </g>;
    })}</svg>}
    <span>{unit}</span>
  </div>;
}

function MapCanvas({ regions, outlines, bounds, mode, maximum, value, active, selected, onHover, onPick, onSwipe }: {
  regions: Region[];
  outlines: Boundary[];
  bounds?: Bounds;
  mode: Mode;
  maximum: number;
  value: (region: Region) => number | null;
  active?: string;
  selected?: string;
  onHover: (region?: Region) => void;
  onPick: (region: Region) => void;
  onSwipe: (direction: number) => void;
}) {
  const missing = useId();
  const start = useRef<{ x: number; y: number }>();
  const [left, top, right, bottom] = bounds ?? [0, 0, 560, 605];
  const padding = Math.max(3, Math.max(right - left, bottom - top) * 0.055);
  const width = right - left + padding * 2, height = bottom - top + padding * 2;
  const symbolUnit = Math.min(width, height) / 540;
  const marks = regions.filter(region => region.path);
  const symbols = mode === "heat" ? [] : marks.filter(region => region.point && (value(region) ?? 0) > 0).sort((a, b) => {
    const selectedOrder = Number(a.key === selected) - Number(b.key === selected);
    return selectedOrder || value(b)! - value(a)!;
  });
  return <svg className="vp-map" viewBox={`${left - padding} ${top - padding} ${width} ${height}`}
    aria-label="Geographic map. Use the table to select a region with the keyboard."
    role="img" onPointerLeave={() => onHover()}
    onTouchStart={event => {
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      start.current = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
    }}
    onTouchEnd={event => {
      const origin = start.current, touch = event.changedTouches[0];
      start.current = undefined;
      if (!origin || !touch) return;
      const dx = touch.clientX - origin.x, dy = touch.clientY - origin.y;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
    }}>
    <defs><pattern id={missing} width={5} height={5} patternUnits="userSpaceOnUse"><path d="M0,5L5,0" stroke="var(--vg-faint)" strokeOpacity={0.35} /></pattern></defs>
    {outlines.map(outline => <path key={outline.name} className="vp-outline" d={outline.path} fillRule="evenodd" />)}
    {marks.map(region => {
      const current = value(region), share = Math.min(1, Math.abs(current ?? 0) / maximum);
      const fill = mode === "heat" && share > 0 ? `color-mix(in srgb, var(${current! < 0 ? "--vp-negative" : "--vp-ink"}) ${Math.round(share * 100)}%, var(--vp-base))` : undefined;
      return <path className="vp-region" key={region.key} data-active={active === region.key} data-selected={selected === region.key}
        data-missing={current === null} d={region.path} fillRule="evenodd" style={{ fill: current === null ? `url(#${missing})` : fill }}
        onPointerEnter={event => { if (event.pointerType !== "touch") onHover(region); }} onClick={() => onPick(region)} />;
    })}
    {symbols.map(region => {
      const ratio = Math.min(1, value(region)! / maximum), [x, y] = region.point!;
      const radius = (1.6 + 24 * Math.sqrt(ratio)) * symbolUnit, spike = (2 + ratio * 54) * symbolUnit;
      const props = { className: "vp-symbol", "data-active": active === region.key, "data-selected": selected === region.key,
        onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== "touch") onHover(region); }, onClick: () => onPick(region) };
      return mode === "bubbles" ? <circle key={region.key} {...props} cx={x} cy={y} r={radius} />
        : <path key={region.key} {...props} d={`M${x - 4 * symbolUnit},${y}L${x},${y - spike}L${x + 4 * symbolUnit},${y}Z`} />;
    })}
  </svg>;
}

export default function PlacesPane({ formId, query, sample = false, onOpenResponses }: {
  formId: string;
  query: string;
  sample?: boolean;
  onOpenResponses?: (query: URLSearchParams) => void;
}) {
  const places = useLoad(() => call<PlacesData>(`/admin/forms/${formId}/places${query}`, { sample }), [formId, query, sample]);
  const geography = useLoad<Geography>(async () => {
    const response = await fetch("/maps/ground-work-india.json");
    if (!response.ok) throw new Error("The map boundaries couldn’t be loaded.");
    return response.json();
  }, []);
  const storageKey = `vn-places:${formId}`;
  const [saved] = useState(() => readPreferences(storageKey));
  const [metric, setMetric] = useState<Metric>(saved.metric ?? "count");
  const [mode, setMode] = useState<Mode>(saved.mode ?? "heat");
  const [level, setLevel] = useState<Level>(saved.level ?? "districts");
  const [state, setState] = useState(saved.state ?? "");
  const [tableLevel, setTableLevel] = useState<Level>(saved.tableLevel ?? "states");
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [tableWindow, setTableWindow] = useState<TableWindow>(saved.tableWindow ?? "map");
  const [tableUnits, setTableUnits] = useState(saved.tableUnits ?? "map");
  const [selection, setSelection] = useState(saved.selection ?? "");
  const [hover, setHover] = useState("");
  const [pin, setPin] = useState(saved.pin ?? false);
  const [expanded, setExpanded] = useState(saved.expanded ?? false);
  const [recent, setRecent] = useState(saved.recent ?? false);
  const [normalize, setNormalize] = useState(saved.normalize ?? "0");
  const [per, setPer] = useState(saved.per ?? "1000");
  const [scale, setScale] = useState(saved.scale ?? "auto");
  const [custom, setCustom] = useState(saved.custom ?? "1000");
  const [sort, setSort] = useState<{ column: SortColumn; ascending: boolean }>(saved.sort ?? { column: "count", ascending: false });
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const preferences = { metric, mode, level, state, selection, pin, expanded, recent, normalize, per, scale, custom, tableLevel, tableWindow, tableUnits, sort };
    try { sessionStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Preferences are optional. */ }
  }, [storageKey, metric, mode, level, state, selection, pin, expanded, recent, normalize, per, scale, custom, tableLevel, tableWindow, tableUnits, sort]);

  const model = useMemo(() => {
    const counts = new Map(places.data?.states.map(item => [item.name, item]));
    const states: Region[] = [];
    const districts: Region[] = [];
    for (const boundary of geography.data?.states ?? []) {
      const stats = counts.get(boundary.name);
      states.push({ ...boundary, key: boundary.name, state: boundary.name, label: boundary.name, stats: stats ?? EMPTY });
      const districtCounts = new Map<string, DistrictStats>(stats?.districts.map(item => [item.name, item]));
      for (const district of boundary.districts) {
        districts.push({ ...district, key: `${boundary.name}:${district.name}`, state: boundary.name, district: district.name,
          label: district.name, stats: districtCounts.get(district.name) ?? EMPTY });
      }
      const unidentified = districtCounts.get("");
      if (unidentified?.count) districts.push({ name: "District not identified", key: `${boundary.name}:`, state: boundary.name,
        district: "", label: "District not identified", stats: unidentified });
    }
    // Keep the sortable table usable even if the static map could not load.
    if (!geography.data) for (const item of places.data?.states ?? []) {
      if (!item.name || item.name === "Outside India") continue;
      states.push({ name: item.name, key: item.name, state: item.name, label: item.name, stats: item });
      for (const district of item.districts) {
        const label = district.name || "District not identified";
        districts.push({ name: label, key: `${item.name}:${district.name}`, state: item.name, district: district.name, label, stats: district });
      }
    }
    const extra: Region[] = [];
    for (const name of ["Outside India", ""]) {
      const stats = counts.get(name);
      if (stats?.count) extra.push({ name, key: name || "no-state", state: name || undefined, label: name || "State not reported", stats });
    }
    return { states, districts, extra, byKey: new Map([...states, ...districts, ...extra].map(region => [region.key, region])) };
  }, [places.data, geography.data]);

  if (places.error) return <Failure message={places.error} onRetry={places.reload} />;
  if (!places.data) return <Loading label="Loading response locations" />;

  const data = places.data, config = METRICS.find(item => item.id === metric)!;
  const denominator = normalize === "custom" ? integer(per) : Number(normalize);
  const tableRecent = tableWindow === "map" ? recent : tableWindow === "recent";
  const tableDenominator = tableUnits === "map" ? denominator : Number(tableUnits);
  const raw = (region: Region, column: Metric, window = recent, perResidents = denominator): number | null => {
    const counts = window ? region.stats.recent : region.stats;
    if (column === "population") return region.population ?? null;
    if (column === "growth") return region.stats.previous ? (region.stats.recent.count / region.stats.previous - 1) * 100 : null;
    if (column === "approval") return counts.count ? counts.approved / counts.count * 100 : null;
    if (column === "share") {
      const baseline = window ? data.totals.recent.count : data.totals.count;
      return baseline ? counts.count / baseline * 100 : null;
    }
    if (perResidents) return region.population ? counts[column] / region.population * perResidents : null;
    return counts[column];
  };
  const display = (value: number | null, column: Metric) => value === null ? "—" : `${small(value)}${percent(column) ? "%" : ""}`;
  const currentState = model.byKey.get(state);
  const regionalTotal = model.states.reduce<PlaceStats>((sum, region) => {
    const next = { ...sum, daily: { ...sum.daily }, recent: { ...sum.recent }, previous: sum.previous + region.stats.previous,
      latest: Math.max(sum.latest ?? 0, region.stats.latest ?? 0) || null };
    for (const item of ["count", "approved", "pending", "rejected"] as const) {
      next[item] += region.stats[item];
      next.daily[item] += region.stats.daily[item];
      next.recent[item] += region.stats.recent[item];
    }
    return next;
  }, EMPTY);
  const isDistrictView = !!state || level === "districts";
  const scope = isDistrictView ? model.districts.filter(region => !state || region.state === state) : model.states;
  const tableDistricts = !!state || tableLevel === "districts";
  const rows = state ? scope : [...(tableDistricts ? model.districts : model.states), ...model.extra];
  const view: Region = currentState ?? { name: "India", key: "india", label: "India", population: geography.data?.population,
    stats: regionalTotal };
  const inspected = model.byKey.get(hover || selection) ?? view;
  const value = (region: Region) => raw(region, metric);
  const largest = scope.reduce((max, region) => region.path ? Math.max(max, Math.abs(value(region) ?? 0)) : max, 0);
  const automatic = metric === "growth" || !percent(metric) ? ceiling(largest) : 100;
  const customLimit = integer(custom);
  const fixed = scale === "custom" ? (percent(metric) && metric !== "growth" && customLimit > 100 ? 0 : customLimit) : Number(scale);
  const maximum = scale === "auto" || !fixed ? automatic : fixed;
  const visibleBounds = geography.data?.states.find(item => item.name === state)?.bounds;
  const outsideOrUnknown = !state && model.extra.reduce((sum, region) => sum + (recent ? region.stats.recent.count : region.stats.count), 0);
  const unmapped = scope.reduce((sum, region) => sum + (!region.path && region.district ? (recent ? region.stats.recent.count : region.stats.count) : 0), 0);
  const chooseState = (name: string) => {
    setState(name); setSelection(""); setHover(""); setFilter(""); setPage(0);
  };
  const chooseRegion = (region: Region) => {
    setHover("");
    if (region.state && region.state !== "Outside India" && region.district === undefined && region.key !== state) {
      chooseState(region.state);
    } else {
      if (region.district !== undefined && !state) setLevel("districts");
      setSelection(region.key);
    }
  };
  const selectMetric = (id: Metric) => {
    setMetric(id);
    setScale("auto");
    setSort({ column: id, ascending: false });
    if (percent(id)) setMode("heat");
    setPage(0);
  };
  const swipeMetric = (direction: number) => {
    const index = METRICS.indexOf(config);
    selectMetric(METRICS[(index + direction + METRICS.length) % METRICS.length].id);
  };
  const open = () => {
    const params = new URLSearchParams({ from: recent && metric !== "population" ? data.recentFrom : data.from, to: data.to });
    if (inspected.state) params.set("state", inspected.state);
    if (inspected.key === "no-state") params.set("state", "*");
    if (inspected.district !== undefined) params.set("district", inspected.district);
    if (metric === "approved" || metric === "pending" || metric === "rejected") params.set("status", metric);
    onOpenResponses?.(params);
  };
  const changeSort = (column: SortColumn) => {
    setSort(current => ({ column, ascending: current.column === column ? !current.ascending : column === "name" }));
    setPage(0);
  };
  const keyword = filter.trim().toLowerCase();
  const compare = (a: Region, b: Region) => {
    const sign = sort.ascending ? 1 : -1;
    if (sort.column === "name") return sign * a.label.localeCompare(b.label);
    const first = raw(a, sort.column, tableRecent, tableDenominator), second = raw(b, sort.column, tableRecent, tableDenominator);
    if (first === null) return second === null ? a.label.localeCompare(b.label) : 1;
    if (second === null) return -1;
    return sign * (first - second) || a.label.localeCompare(b.label);
  };
  const listed = rows.filter(region => !keyword || `${region.label} ${region.state ?? ""}`.toLowerCase().includes(keyword)).sort(compare);
  const columns: Metric[] = [...new Set<Metric>(["count", "approved", "pending", "rejected", metric])];
  const pages = Math.max(1, Math.ceil(listed.length / SHOW));
  const currentPage = Math.min(page, pages - 1);
  const shown = listed.slice(currentPage * SHOW, (currentPage + 1) * SHOW);
  const inspectedCounts = recent && metric !== "population" ? inspected.stats.recent : inspected.stats;
  const inspectedCount = metric === "approved" || metric === "pending" || metric === "rejected" ? inspectedCounts[metric] : inspectedCounts.count;
  const activeKey = hover || selection;
  const tableTotal = state || tableDenominator ? view : { ...view, label: "All locations", stats: data.totals };
  const tableValue = (region: Region, column: Metric) => raw(region, column, tableRecent, tableDenominator);
  const tableDelta = (region: Region, column: keyof PlaceCounts) =>
    tableDenominator ? region.population ? region.stats.daily[column] / region.population * tableDenominator : null : region.stats.daily[column];
  const hoverRegion = (region?: Region) => setHover(region?.key ?? "");
  const mapTitle = state ? `Districts in ${state}` : isDistrictView ? "Districts across India" : "States and union territories";
  const renderRow = (region: Region, nested = false) => {
    const canExpand = !nested && !tableDistricts && !!region.state && region.state !== "Outside India";
    const isOpen = canExpand && openRows.has(region.key);
    const toggle = () => {
      if (!canExpand) return chooseRegion(region);
      setOpenRows(current => {
        const next = new Set(current);
        if (next.has(region.key)) next.delete(region.key); else next.add(region.key);
        return next;
      });
    };
    return <tr key={region.key} data-active={activeKey === region.key || !!isOpen} data-nested={nested}
      onPointerEnter={event => { if (event.pointerType !== "touch") hoverRegion(region); }}>
      <th scope="row"><button type="button" aria-expanded={canExpand ? isOpen : undefined} onClick={toggle}
        onFocus={() => hoverRegion(region)} onBlur={() => hoverRegion()}>
        {canExpand && <span className="vp-disclosure" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>}{region.label}
        {!nested && !state && region.district !== undefined && <small>{region.state}</small>}
      </button></th>
      {columns.map(column => <td key={column} className="vg-num">
        {isCount(column) && region.stats.daily[column] > 0 && tableDelta(region, column) !== null &&
          <small className="vp-recent" title="Last 24 hours">+{display(tableDelta(region, column), column)}</small>}
        {display(tableValue(region, column), column)}
      </td>)}
    </tr>;
  };
  const scaleUnit = percent(metric) ? `${config.label} (%)` : metric === "population" ? "Population estimate" :
    denominator ? `${config.label} per ${format.format(denominator)} residents` : config.label;

  return <section className="vp-places va-stack" style={{ "--vp-ink": config.color } as CSSProperties} aria-label="Where responses come from">
    <div className="vp-metrics va-tiles" role="group" aria-label="Quick metrics">
      {METRICS.filter(item => isCount(item.id)).map(item => <button type="button" key={item.id} className="va-tile vg-glass" aria-pressed={item.id === metric} aria-label={item.label}
        onClick={() => selectMetric(item.id)} style={{ "--vp-metric": item.color } as CSSProperties}>
        <span>{item.label}</span><strong>{display(raw(view, item.id, recent, 0), item.id)}</strong>
        {isCount(item.id) && view.stats.daily[item.id] > 0 && <small>+{format.format(view.stats.daily[item.id])} in the last 24 hours</small>}
      </button>)}
    </div>
    <Card title="Where responses come from" note="Explore applications by state and district." action={
      <button type="button" className="vg-btn is-small is-quiet vp-pin" aria-pressed={pin} onClick={() => setPin(!pin)} title={pin ? "Unpin map" : "Keep map visible while scrolling"}><PinLeftIcon aria-hidden="true" />{pin ? "Unpin map" : "Pin map"}</button>
    }>
      <div className="vp-controls">
        <label className="vg-label">Show<select className="vg-select is-small" aria-label="Show" value={metric} onChange={event => selectMetric(event.target.value as Metric)}>
          {METRICS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        <label className="vg-label">Geography<select className="vg-select is-small" aria-label="Geography" value={state ? "state" : level} onChange={event => {
          if (event.target.value !== "state") { setLevel(event.target.value as Level); chooseState(""); }
        }}><option value="states">States and UTs</option><option value="districts">All districts</option>{state && <option value="state">Districts in {state}</option>}</select></label>
        <label className="vg-label">View<select className="vg-select is-small" aria-label="View" value={mode} disabled={metric === "growth"} onChange={event => setMode(event.target.value as Mode)}>
          {Object.entries(LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label className="vg-label">Units<select className="vg-select is-small" aria-label="Units" value={isCount(metric) ? normalize : "0"} disabled={!isCount(metric)} onChange={event => {
          setNormalize(event.target.value); setScale("auto");
          if (event.target.value !== "0") setMode("heat");
        }}><option value="0">{percent(metric) ? "Percent" : metric === "population" ? "Residents" : "Raw counts"}</option>
          {DENOMINATORS.map(item => <option key={item} value={item}>Per {format.format(item)} residents</option>)}<option value="custom">Custom per-capita rate</option>
        </select></label>
        <label className="vg-label">Map scale<select className="vg-select is-small" aria-label="Map scale" value={scale} onChange={event => setScale(event.target.value)}>
          <option value="auto">Auto · {small(automatic)}{percent(metric) ? "%" : ""}</option>
          {(percent(metric) && metric !== "growth" ? [10, 25, 50, 100] : PRESETS).map(item => <option key={item} value={item}>{format.format(item)}{percent(metric) ? "%" : ""}</option>)}
          <option value="custom">Custom maximum</option>
        </select></label>
        {isCount(metric) && normalize === "custom" && <label className="vg-label">Residents per rate<input className="vg-input is-small" type="number" min="1" step="1" value={per} onChange={event => setPer(event.target.value)} aria-invalid={!denominator} /></label>}
        {scale === "custom" && <label className="vg-label">Maximum<input aria-label="Maximum" className="vg-input is-small" type="number" min="1" max={percent(metric) && metric !== "growth" ? 100 : undefined} step="1" value={custom} onChange={event => setCustom(event.target.value)} aria-invalid={!fixed} /></label>}
      </div>
      {scale === "custom" && !fixed && <p className="va-note">Enter a valid maximum to replace the automatic scale.</p>}
      {isCount(metric) && normalize === "custom" && !denominator && <p className="va-note">Enter a positive population denominator. The map shows raw counts until then.</p>}
      <div className="vp-scope va-row">
        <div className="va-row">
          <button type="button" className="vg-btn is-small" disabled={!state && !selection} onClick={() => chooseState("")}><ArrowLeftIcon aria-hidden="true" />India</button>
          <select className="vg-select is-small" aria-label="Jump to a state or union territory" value={state} onChange={event => chooseState(event.target.value)}>
            <option value="">Jump to a state or UT…</option>{model.states.map(region => <option key={region.key} value={region.name}>{region.name}</option>)}
          </select>
        </div>
        <div className="va-tabs vg-glass" role="group" aria-label="Places time window">
          <button type="button" aria-pressed={!recent} onClick={() => { setRecent(false); setPage(0); }}>Selected dates</button>
          <button type="button" aria-pressed={recent} onClick={() => { setRecent(true); setPage(0); }}>Last 7 days</button>
        </div>
      </div>
    </Card>
    <div className="vp-layout" data-expanded={expanded}>
      <section className="va-card vg-glass vp-map-card" data-pinned={pin} aria-label={mapTitle}>
        <div className="vp-detail" aria-live="polite">
          <div><p className="va-note">{mapTitle}</p><h2>{inspected.label}{inspected.district !== undefined && !state ? `, ${inspected.state}` : ""}</h2>
            <div className="vp-value vg-num">{display(value(inspected), metric)}</div>
            <p className="va-note">{scaleUnit}{value(inspected) === null ? " · data unavailable" : ""}</p>
            {inspected.stats.latest !== null && <p className="va-note">Latest response {formatDate(new Date(inspected.stats.latest).toISOString())}</p>}
          </div>
          {selection && <button type="button" className="vg-btn is-small is-quiet" onClick={() => { setSelection(""); setHover(""); }}>Clear selection</button>}
        </div>
        {onOpenResponses && inspectedCount > 0 &&
          <button type="button" className="vg-btn is-small vp-open" onClick={open}>View responses <ArrowRightIcon aria-hidden="true" /></button>}
        {geography.error ? <Failure message={geography.error} onRetry={geography.reload} /> : geography.loading && !geography.data ? <Loading label="Loading map boundaries" /> :
          <MapCanvas regions={scope} outlines={state ? model.states.filter(region => region.key === state) : model.states} bounds={visibleBounds}
            mode={mode} maximum={maximum} value={value} active={isDistrictView ? activeKey : model.byKey.get(activeKey)?.state ?? activeKey} selected={selection} onHover={hoverRegion} onPick={chooseRegion} onSwipe={swipeMetric} />}
        <div className="vp-status">
          <StatusSplit approved={inspectedCounts.approved} pending={inspectedCounts.pending} rejected={inspectedCounts.rejected} />
          <div className="vc-legend">{METRICS.filter(item => item.id === "approved" || item.id === "pending" || item.id === "rejected").map(item =>
            <span key={item.id}><i style={{ background: item.color }} />{format.format(inspectedCounts[item.id as keyof PlaceCounts])} {item.label.toLowerCase()}</span>)}</div>
        </div>
        <MapLegend mode={mode} maximum={maximum} unit={scaleUnit} capped={largest > maximum} signed={metric === "growth"} />
        <div className="vp-notes va-note">
          {metric === "growth" && <p>Compares responses in the last seven days with the previous seven days. A dash means there were no responses in the earlier week.</p>}
          {denominator > 0 && isCount(metric) && <p>Rates use population estimates from the October 2021 COVID19India snapshot. Areas without estimates show a dash.</p>}
          {!!unmapped && <p>{format.format(unmapped)} {unmapped === 1 ? "response is" : "responses are"} from districts listed in the table without a matching boundary.</p>}
          {!!outsideOrUnknown && <p>{format.format(outsideOrUnknown)} outside India or without a state are included in the table.</p>}
          <details><summary>Map data</summary><p><a href="https://bharatlas.com/view/lgd_districts" target="_blank" rel="noreferrer">LGD district boundaries via bharatlas</a> · <a href="https://github.com/covid19india/covid19india.github.io" target="_blank" rel="noreferrer">COVID19India map reference</a> · <a href="https://github.com/covid19india/data" target="_blank" rel="noreferrer">Historical population data</a></p></details>
        </div>
      </section>
      <Card title={tableDistricts ? "Districts" : "States and union territories"} action={
        <button type="button" className="vg-btn is-quiet is-small vp-expand" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Side by side" : "Expand table"}</button>
      }>
        <div className="vp-table-controls">
          {!state && <label className="vg-label">Table geography<select className="vg-select is-small" aria-label="Table geography" value={tableLevel} onChange={event => {
            setTableLevel(event.target.value as Level); setFilter(""); setPage(0);
          }}><option value="states">States and UTs</option><option value="districts">All districts</option></select></label>}
          <label className="vg-label">Table period<select className="vg-select is-small" aria-label="Table period" value={tableWindow} onChange={event => {
            setTableWindow(event.target.value as TableWindow); setPage(0);
          }}><option value="map">Same as map</option><option value="range">Selected dates</option><option value="recent">Last 7 days</option></select></label>
          <label className="vg-label">Table units<select className="vg-select is-small" aria-label="Table units" value={tableUnits} onChange={event => {
            setTableUnits(event.target.value); setPage(0);
          }}><option value="map">Same as map</option><option value="0">Raw counts</option>
            {DENOMINATORS.map(item => <option key={item} value={item}>Per {format.format(item)} residents</option>)}
          </select></label>
        </div>
        <input type="search" className="vg-input is-small vp-search" value={filter} aria-label="Find a place"
          placeholder={tableDistricts ? "Find a district or state…" : "Find a state or UT…"} onChange={event => { setFilter(event.target.value); setPage(0); }} />
        <div className="va-tablewrap vp-table" onPointerLeave={() => hoverRegion()}>
          <table className="va-table" aria-label={tableDistricts ? "District statistics" : "State and union territory statistics"}>
            <thead><tr>{(["name", ...columns] as SortColumn[]).map(column =>
              <th key={column} scope="col" aria-sort={sort.column === column ? sort.ascending ? "ascending" : "descending" : undefined}>
                <button type="button" onClick={() => changeSort(column)}>
                  {column === "name" ? tableDistricts ? "District" : "State / UT" : METRICS.find(item => item.id === column)?.label}
                  {sort.column === column && <span aria-hidden="true">{sort.ascending ? " ↑" : " ↓"}</span>}
                </button>
              </th>)}</tr></thead>
            <tbody>{shown.map(region => <Fragment key={region.key}>
              {renderRow(region)}
              {!tableDistricts && openRows.has(region.key) && <>
                <tr className="vp-district-link"><td colSpan={columns.length + 1}>
                  <button type="button" className="vg-btn is-small" onClick={() => chooseState(region.state!)}>Open {region.name} map <ArrowRightIcon aria-hidden="true" /></button>
                </td></tr>
                {model.districts.filter(district => district.state === region.state).sort(compare).map(district => renderRow(district, true))}
              </>}
            </Fragment>)}</tbody>
            {!!listed.length && <tfoot><tr><th scope="row">{tableTotal.label} total</th>
              {columns.map(column => <td key={column} className="vg-num">{display(tableValue(tableTotal, column), column)}</td>)}
            </tr></tfoot>}
          </table>
        </div>
        {!listed.length && <p className="va-note">No places match your search.</p>}
        {pages > 1 && <nav className="vp-pager va-row" aria-label="Places table pages">
          <button type="button" className="vg-btn is-small is-icon" aria-label="First page" disabled={!currentPage} onClick={() => setPage(0)}><DoubleArrowLeftIcon /></button>
          <button type="button" className="vg-btn is-small is-icon" aria-label="Previous page" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeftIcon /></button>
          <span className="va-note vg-num" role="status">{currentPage + 1} of {pages}</span>
          <button type="button" className="vg-btn is-small is-icon" aria-label="Next page" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRightIcon /></button>
          <button type="button" className="vg-btn is-small is-icon" aria-label="Last page" disabled={currentPage === pages - 1} onClick={() => setPage(pages - 1)}><DoubleArrowRightIcon /></button>
        </nav>}
        <details className="vp-notes"><summary>How to read the table</summary><p className="va-note">Select a heading to sort. The smaller + figure shows the last 24 hours within your date range. Expand a state to see its districts. Open its map for a closer view, or select a district to highlight it.</p></details>
      </Card>
    </div>
  </section>;
}

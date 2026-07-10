import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { MessageRecord } from "../types";
import type { GraphEdge, GraphNode, GraphProgress, GraphResult } from "../lib/graph-worker";
import GraphWorkerCtor from "../lib/graph-worker.ts?worker";

interface GraphViewProps {
  messages: MessageRecord[];
  userAliases: Array<{ match: string; canonical: string }>;
  onFilterByEntity: (entity: string) => void;
  onJumpToThread: (rootMessageId: number) => void;
  onMergeEntities: (fromMatch: string, toCanonical: string) => Promise<void>;
}

const PALETTE = [
  "#e8b26b", // amber
  "#7cb7ff", // blue
  "#9dc4a7", // sage
  "#e07a5f", // coral
  "#c8a2c8", // lilac
  "#f0c280", // honey
  "#7fa7c5", // steel
  "#d8a657", // mustard
  "#b8a89a", // sand
  "#a3b18a"  // moss
];

function hashColor(group: number): string {
  return PALETTE[group % PALETTE.length];
}

interface ForceNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  __color?: string;
}

interface ForceLink extends Omit<GraphEdge, "source" | "target"> {
  source: string | ForceNode;
  target: string | ForceNode;
}

export default function GraphView({
  messages,
  userAliases,
  onFilterByEntity,
  onJumpToThread,
  onMergeEntities
}: GraphViewProps) {
  const [progress, setProgress] = useState<GraphProgress | null>(null);
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [selected, setSelected] = useState<ForceNode | null>(null);
  const [controlsExpanded, setControlsExpanded] = useState(true);
  const [minCount, setMinCount] = useState(5);
  const [minWeight, setMinWeight] = useState(3);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeFrom, setMergeFrom] = useState<ForceNode | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });

  useEffect(() => {
    if (!messages.length) return undefined;
    setGraph(null);
    setProgress({ type: "progress", phase: "Starting", done: 0, total: messages.length });

    const worker = new GraphWorkerCtor();

    worker.onmessage = (event: MessageEvent<GraphProgress | GraphResult>) => {
      const data = event.data;
      if (data.type === "progress") {
        setProgress(data);
      } else if (data.type === "result") {
        setGraph(data);
        setProgress(null);
      }
    };

    worker.postMessage({
      type: "build",
      messages: messages.map((m) => ({
        message_key: m.message_key,
        message_id: m.message_id,
        text: m.text,
        quote_text: m.quote_text,
        date_utc: m.date_utc
      })),
      userAliases
    });

    return () => worker.terminate();
  }, [messages, userAliases]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const update = () => {
      setSize({ width: node.clientWidth, height: node.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Tune the underlying d3 forces for an Obsidian-style spread:
  // stronger repulsion, longer link distance, weaker link attraction so the
  // graph spreads instead of clumping around dense hubs.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph) return;
    const charge = fg.d3Force?.("charge") as
      | { strength: (n: number) => unknown; distanceMax: (n: number) => unknown }
      | undefined;
    charge?.strength(-260);
    charge?.distanceMax(1500);
    const link = fg.d3Force?.("link") as
      | {
          distance: (n: number) => unknown;
          strength: (n: number) => unknown;
        }
      | undefined;
    link?.distance(90);
    link?.strength(0.35);
    fg.d3ReheatSimulation?.();
  }, [graph]);

  const data = useMemo(() => {
    if (!graph) return { nodes: [] as ForceNode[], links: [] as ForceLink[] };
    const keep = new Set<string>();
    const filteredNodes: ForceNode[] = [];
    let rank = 0;
    for (const n of graph.nodes) {
      if (n.count < minCount) continue;
      keep.add(n.id);
      rank += 1;
      filteredNodes.push({ ...n, rank, __color: hashColor(n.group) });
    }
    const filteredLinks: ForceLink[] = [];
    for (const e of graph.edges) {
      if (e.weight < minWeight) continue;
      if (!keep.has(e.source) || !keep.has(e.target)) continue;
      filteredLinks.push({ ...e });
    }
    return { nodes: filteredNodes, links: filteredLinks };
  }, [graph, minCount, minWeight]);

  const messageByKey = useMemo(() => {
    const map = new Map<string, MessageRecord>();
    for (const m of messages) map.set(m.message_key, m);
    return map;
  }, [messages]);

  // Set of node ids directly connected to the selected node (including itself),
  // computed against the currently-visible (filtered) graph.
  const connectedIds = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected.id]);
    for (const edge of data.links) {
      const a = typeof edge.source === "string" ? edge.source : (edge.source as ForceNode).id;
      const b = typeof edge.target === "string" ? edge.target : (edge.target as ForceNode).id;
      if (a === selected.id) set.add(b);
      else if (b === selected.id) set.add(a);
    }
    return set;
  }, [selected, data.links]);

  // For the detail panel: which thread roots does this entity show up in?
  const selectedThreads = useMemo(() => {
    if (!selected) return [];
    const roots = new Map<number, number>(); // thread_root_id -> count
    for (const key of selected.topMessages) {
      const msg = messageByKey.get(key);
      if (!msg) continue;
      roots.set(msg.thread_root_id, (roots.get(msg.thread_root_id) ?? 0) + 1);
    }
    return Array.from(roots.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => id);
  }, [selected, messageByKey]);

  const edgeIsHighlighted = (link: ForceLink) => {
    if (!connectedIds) return true;
    const a = typeof link.source === "string" ? link.source : (link.source as ForceNode).id;
    const b = typeof link.target === "string" ? link.target : (link.target as ForceNode).id;
    // Obsidian-style: any edge between two highlighted nodes lights up
    return connectedIds.has(a) && connectedIds.has(b);
  };

  return (
    <div className="graph-stage" ref={containerRef}>
      {graph ? (
        <ForceGraph2D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="#0b0d11"
          nodeLabel={(node: object) => {
            const n = node as ForceNode;
            return `${n.label} · ${n.count} mentions`;
          }}
          nodeColor={(node: object) => {
            const n = node as ForceNode;
            const base = n.__color ?? "#9aa0a6";
            if (!connectedIds) return base;
            // Dimmed: very faint so they recede into the background
            return connectedIds.has(n.id) ? base : "rgba(80, 86, 100, 0.25)";
          }}
          nodeRelSize={4}
          nodeVal={(node: object) => {
            const n = node as ForceNode;
            // Shrink dimmed nodes so the focal cluster reads cleanly
            if (connectedIds && !connectedIds.has(n.id)) return Math.max(2, n.size * 0.15);
            return n.size;
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const n = node as ForceNode;
            const labelBudget =
              globalScale < 1.4 ? 100 : globalScale < 2.5 ? 300 : 1000;
            const inSelection = connectedIds?.has(n.id) ?? false;
            if (!inSelection && n.rank > labelBudget) return;
            const fontSize = Math.max(10, Math.min(14, 10 + n.count / 80)) / globalScale;
            ctx.font = `${
              inSelection && n.id === selected?.id ? "bold " : ""
            }${fontSize}px Inter, system-ui, sans-serif`;
            ctx.fillStyle = !connectedIds
              ? n.rank <= 25
                ? "rgba(232, 230, 224, 0.95)"
                : "rgba(232, 230, 224, 0.7)"
              : inSelection
                ? "rgba(232, 230, 224, 0.95)"
                : "rgba(232, 230, 224, 0.16)";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            // Match force-graph's internal radius formula: sqrt(value * relSize).
            // When dimmed, value is shrunk so radius is too — labels track it.
            const effectiveSize =
              connectedIds && !connectedIds.has(n.id) ? Math.max(2, n.size * 0.15) : n.size;
            const renderedRadius = Math.sqrt(effectiveSize * 4);
            const x = n.x ?? 0;
            const y = (n.y ?? 0) + renderedRadius + 4;
            ctx.fillText(n.label, x, y);
          }}
          linkColor={(link: object) => {
            const l = link as ForceLink;
            if (!connectedIds) return "rgba(180, 180, 200, 0.1)";
            return edgeIsHighlighted(l)
              ? "rgba(232, 178, 107, 0.7)"
              : "rgba(180, 180, 200, 0.03)";
          }}
          linkWidth={(link: object) => {
            const l = link as ForceLink;
            const base = Math.min(1.5, 0.3 + Math.log1p(l.weight) * 0.25);
            if (!connectedIds) return base;
            return edgeIsHighlighted(l) ? base * 2.2 : base * 0.5;
          }}
          cooldownTicks={300}
          warmupTicks={60}
          onNodeClick={(node: object) => {
            const n = node as ForceNode;
            if (mergeMode) {
              if (!mergeFrom) {
                setMergeFrom(n);
                return;
              }
              if (mergeFrom.id === n.id) {
                setMergeFrom(null);
                return;
              }
              // Merge mergeFrom → n (mergeFrom becomes alias for n.label)
              void onMergeEntities(mergeFrom.id, n.label).then(() => {
                setMergeMode(false);
                setMergeFrom(null);
              });
              return;
            }
            setSelected(n);
          }}
          onBackgroundClick={() => {
            if (mergeMode) {
              setMergeMode(false);
              setMergeFrom(null);
            } else {
              setSelected(null);
            }
          }}
        />
      ) : null}

      {progress ? (
        <div className="graph-loading">
          <span>{progress.phase}…</span>
          <div className="graph-loading-bar">
            <div
              className="graph-loading-bar-fill"
              style={{
                width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0}%`
              }}
            />
          </div>
          <span className="graph-stat">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
          </span>
        </div>
      ) : null}

      <div className="graph-overlay">
        {controlsExpanded ? (
          <div className="graph-controls">
            <div className="graph-controls-head">
              <h3>Topic graph</h3>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Collapse controls"
                onClick={() => setControlsExpanded(false)}
              >
                ×
              </button>
            </div>
            <p>
              Each dot is a person, place, or concept the channel mentions repeatedly.
              Edges connect entities that appear together. Click a node to filter the
              reader to only messages about it.
            </p>
            <span className="graph-stat">
              {graph
                ? `${data.nodes.length.toLocaleString()} of ${graph.totalEntities.toLocaleString()} entities · ${data.links.length.toLocaleString()} links · across ${graph.totalMessages.toLocaleString()} messages`
                : "Extracting entities in worker thread…"}
            </span>
            {graph ? (
              <>
                <label className="graph-slider">
                  <span>Min mentions: {minCount}</span>
                  <input
                    type="range"
                    min={2}
                    max={50}
                    value={minCount}
                    onChange={(e) => setMinCount(Number(e.target.value))}
                  />
                </label>
                <label className="graph-slider">
                  <span>Min link weight: {minWeight}</span>
                  <input
                    type="range"
                    min={2}
                    max={20}
                    value={minWeight}
                    onChange={(e) => setMinWeight(Number(e.target.value))}
                  />
                </label>
                <span className="graph-stat" style={{ opacity: 0.7 }}>
                  Top 100 labeled. Zoom in to reveal more.
                </span>
                <div className="graph-controls-actions">
                  <button type="button" onClick={() => fgRef.current?.zoomToFit(400, 60)}>
                    Fit
                  </button>
                  <button
                    type="button"
                    className={mergeMode ? "is-saved" : ""}
                    onClick={() => {
                      setMergeMode((m) => !m);
                      setMergeFrom(null);
                      setSelected(null);
                    }}
                  >
                    {mergeMode ? "Cancel merge" : "Merge entities"}
                  </button>
                </div>
                {mergeMode ? (
                  <span className="graph-stat" style={{ color: "var(--accent)" }}>
                    {mergeFrom
                      ? `Merging "${mergeFrom.label}" → click target to merge into.`
                      : "Click the entity you want to merge FROM."}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="graph-controls-collapsed"
            onClick={() => setControlsExpanded(true)}
          >
            <span className="graph-controls-collapsed-mode">Topics</span>
            <span className="graph-stat">
              {graph
                ? `${graph.totalEntities.toLocaleString()}e · ${data.links.length.toLocaleString()}l`
                : "computing…"}
            </span>
          </button>
        )}
      </div>

      {selected ? (
        <div className="graph-detail">
          <div className="graph-detail-head">
            <span>
              <strong style={{ color: "var(--accent)" }}>{selected.label}</strong> ·{" "}
              {selected.count} {selected.count === 1 ? "mention" : "mentions"}
              {connectedIds && connectedIds.size > 1 ? (
                <span style={{ color: "var(--text-dim)" }}>
                  {" "}· {connectedIds.size - 1} connected
                </span>
              ) : null}
            </span>
            <button type="button" className="btn-ghost" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>

          {selectedThreads.length ? (
            <div className="graph-detail-threads">
              <span className="graph-detail-threads-label">
                Appears in threads · click to open
              </span>
              <div className="graph-detail-threads-list">
                {selectedThreads.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="graph-detail-thread-chip"
                    onClick={() => onJumpToThread(id)}
                  >
                    #{id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {selected.topMessages.length ? (
            <ul className="graph-detail-messages">
              {selected.topMessages.slice(0, 4).map((key) => {
                const msg = messageByKey.get(key);
                if (!msg) return null;
                return (
                  <li key={key}>
                    <span className="graph-detail-msg-id">#{msg.message_id}</span>
                    <span className="graph-detail-msg-text">
                      {(msg.text || msg.quote_text || "(media)").slice(0, 120)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="graph-detail-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => onFilterByEntity(selected.label)}
            >
              Show all {selected.count} messages in reader
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

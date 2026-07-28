import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { EntityResolutionRecord, MessageRecord } from "../types";
import type {
  GraphEdge,
  GraphNode,
  GraphProgress,
  GraphResult
} from "../lib/graph-worker";
import GraphWorkerCtor from "../lib/graph-worker.ts?worker";

interface GraphViewProps {
  messages: MessageRecord[];
  userAliases: Array<{ match: string; canonical: string }>;
  entityResolutions: EntityResolutionRecord[];
  onFilterByEntity: (entity: string) => void;
  onJumpToThread: (rootMessageId: number) => void;
  onMergeEntities: (fromMatch: string, toCanonical: string) => Promise<void>;
}

const COMMUNITY_PALETTE = [
  "#e8b26b",
  "#7cb7ff",
  "#9dc4a7",
  "#e07a5f",
  "#c8a2c8",
  "#f0c280",
  "#7fa7c5",
  "#d8a657",
  "#b8a89a",
  "#a3b18a"
];

const TYPE_PALETTE: Record<string, string> = {
  person: "#e8b26b",
  organization: "#7cb7ff",
  place: "#9dc4a7",
  event: "#e07a5f",
  concept: "#c8a2c8",
  work: "#f0c280",
  other: "#7fa7c5",
  unknown: "#79808c"
};

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

function nodeId(value: string | ForceNode): string {
  return typeof value === "string" ? value : value.id;
}

function colorForNode(
  node: GraphNode,
  mode: "community" | "type"
): string {
  if (mode === "type") return TYPE_PALETTE[node.entityType] ?? TYPE_PALETTE.unknown;
  return COMMUNITY_PALETTE[node.group % COMMUNITY_PALETTE.length];
}

export default function GraphView({
  messages,
  userAliases,
  entityResolutions,
  onFilterByEntity,
  onJumpToThread,
  onMergeEntities
}: GraphViewProps) {
  const [progress, setProgress] = useState<GraphProgress | null>(null);
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controlsExpanded, setControlsExpanded] = useState(true);
  const [minCount, setMinCount] = useState(2);
  const [minScore, setMinScore] = useState(0.025);
  const [maxLinks, setMaxLinks] = useState(12);
  const [nodeLimit, setNodeLimit] = useState(2400);
  const [colorMode, setColorMode] = useState<"community" | "type">("community");
  const [entityType, setEntityType] = useState("all");
  const [focusOnly, setFocusOnly] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [labelDensity, setLabelDensity] = useState(38);
  const [nodeScale, setNodeScale] = useState(0.78);
  const [linkScale, setLinkScale] = useState(0.72);
  const [repelForce, setRepelForce] = useState(390);
  const [linkDistance, setLinkDistance] = useState(94);
  const [linkForce, setLinkForce] = useState(18);
  const [search, setSearch] = useState("");
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeFrom, setMergeFrom] = useState<ForceNode | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });

  useEffect(() => {
    if (!messages.length) return undefined;
    setGraph(null);
    setSelectedId(null);
    setProgress({
      type: "progress",
      phase: "Starting",
      done: 0,
      total: messages.length
    });
    const worker = new GraphWorkerCtor();
    worker.onmessage = (event: MessageEvent<GraphProgress | GraphResult>) => {
      const value = event.data;
      if (value.type === "progress") {
        setProgress(value);
      } else {
        setGraph(value);
        setProgress(null);
      }
    };
    worker.postMessage({
      type: "build",
      messages: messages.map((message) => ({
        message_key: message.message_key,
        message_id: message.message_id,
        text: message.text,
        quote_text: message.quote_text,
        date_utc: message.date_utc
      })),
      userAliases,
      entityResolutions
    });
    return () => worker.terminate();
  }, [messages, userAliases, entityResolutions]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const update = () => setSize({
      width: node.clientWidth,
      height: node.clientHeight
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph) return;
    const charge = fg.d3Force?.("charge") as
      | { strength: (value: number) => unknown; distanceMax: (value: number) => unknown }
      | undefined;
    charge?.strength(-repelForce);
    charge?.distanceMax(2200);
    const link = fg.d3Force?.("link") as
      | { distance: (value: number) => unknown; strength: (value: number) => unknown }
      | undefined;
    link?.distance(linkDistance);
    link?.strength(linkForce / 100);
    fg.d3ReheatSimulation?.();
  }, [
    graph,
    minCount,
    minScore,
    maxLinks,
    nodeLimit,
    entityType,
    repelForce,
    linkDistance,
    linkForce
  ]);

  const overviewData = useMemo(() => {
    if (!graph) return { nodes: [] as ForceNode[], links: [] as ForceLink[] };
    const eligibleNodes = graph.nodes
        .filter(
          (node) =>
            node.count >= minCount
            && (entityType === "all" || node.entityType === entityType)
        )
        .slice(0, nodeLimit);
    const eligible = new Set(eligibleNodes.map((node) => node.id));
    const degree = new Map<string, number>();
    const links: ForceLink[] = [];
    const sorted = graph.edges
      .filter(
        (edge) =>
          eligible.has(edge.source)
          && eligible.has(edge.target)
          && (edge.score >= minScore || edge.relationCount > 0)
      )
      .sort(
        (left, right) =>
          Number(right.relationCount > 0) - Number(left.relationCount > 0)
          || right.score - left.score
          || right.weight - left.weight
      );

    for (const edge of sorted) {
      const leftDegree = degree.get(edge.source) ?? 0;
      const rightDegree = degree.get(edge.target) ?? 0;
      if (leftDegree >= maxLinks || rightDegree >= maxLinks) continue;
      links.push({ ...edge });
      degree.set(edge.source, leftDegree + 1);
      degree.set(edge.target, rightDegree + 1);
    }

    const linked = new Set<string>();
    links.forEach((edge) => {
      linked.add(nodeId(edge.source));
      linked.add(nodeId(edge.target));
    });
    const nodes: ForceNode[] = eligibleNodes
      .filter((node) => showOrphans || linked.has(node.id))
      .map((node, index): ForceNode => ({
        ...node,
        rank: index + 1,
        __color: colorForNode(node, colorMode)
      }));
    return { nodes, links };
  }, [
    graph,
    minCount,
    minScore,
    maxLinks,
    nodeLimit,
    colorMode,
    entityType,
    showOrphans
  ]);

  const selected = useMemo(
    () => overviewData.nodes.find((node) => node.id === selectedId) ?? null,
    [overviewData.nodes, selectedId]
  );

  const connectedIds = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of overviewData.links) {
      const source = nodeId(edge.source);
      const target = nodeId(edge.target);
      if (source === selectedId) ids.add(target);
      if (target === selectedId) ids.add(source);
    }
    return ids;
  }, [selectedId, overviewData.links]);

  const data = useMemo(() => {
    if (!focusOnly || !connectedIds) return overviewData;
    return {
      nodes: overviewData.nodes.filter((node) => connectedIds.has(node.id)),
      links: overviewData.links.filter(
        (edge) =>
          connectedIds.has(nodeId(edge.source))
          && connectedIds.has(nodeId(edge.target))
      )
    };
  }, [overviewData, focusOnly, connectedIds]);

  const selectedEdges = useMemo(() => {
    if (!selectedId) return [] as ForceLink[];
    return overviewData.links
      .filter(
        (edge) =>
          nodeId(edge.source) === selectedId
          || nodeId(edge.target) === selectedId
      )
      .sort((a, b) => b.score - a.score || b.weight - a.weight);
  }, [overviewData.links, selectedId]);

  const messageByKey = useMemo(() => {
    const map = new Map<string, MessageRecord>();
    messages.forEach((message) => map.set(message.message_key, message));
    return map;
  }, [messages]);

  const selectedThreads = useMemo(() => {
    if (!selected) return [];
    const roots = new Map<number, number>();
    selected.topMessages.forEach((key) => {
      const message = messageByKey.get(key);
      if (!message) return;
      roots.set(message.thread_root_id, (roots.get(message.thread_root_id) ?? 0) + 1);
    });
    return [...roots.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => id);
  }, [selected, messageByKey]);

  const typeOptions = useMemo(() => {
    if (!graph) return [];
    return [...new Set(graph.nodes.map((node) => node.entityType))]
      .filter((value) => value !== "unknown")
      .sort();
  }, [graph]);

  const edgeIsHighlighted = (edge: ForceLink): boolean => {
    if (!connectedIds) return true;
    return connectedIds.has(nodeId(edge.source)) && connectedIds.has(nodeId(edge.target));
  };

  const selectAndFocus = (id: string) => {
    setSelectedId(id);
    const node = overviewData.nodes.find((item) => item.id === id);
    if (node?.x !== undefined && node.y !== undefined) {
      fgRef.current?.centerAt(node.x, node.y, 420);
      fgRef.current?.zoom(2.7, 420);
    }
  };

  const submitSearch = () => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return;
    const match =
      overviewData.nodes.find((node) => node.label.toLocaleLowerCase() === query)
      ?? overviewData.nodes.find((node) => node.label.toLocaleLowerCase().includes(query));
    if (match) selectAndFocus(match.id);
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
          nodeLabel={(value: object) => {
            const node = value as ForceNode;
            const type = node.entityType === "unknown" ? "untyped" : node.entityType;
            return `${node.label} · ${node.count} mentions · ${type}`;
          }}
          linkLabel={(value: object) => {
            const edge = value as ForceLink;
            const context = edge.relationCount
              ? ` · ${edge.relationCount} quote/reply reference${edge.relationCount === 1 ? "" : "s"}`
              : "";
            return `${edge.weight} shared contexts · ${Math.round(edge.score * 100)}% association${context}`;
          }}
          nodeColor={(value: object) => {
            const node = value as ForceNode;
            const base = node.__color ?? TYPE_PALETTE.unknown;
            if (!connectedIds) return base;
            return connectedIds.has(node.id) ? base : "rgba(80, 86, 100, 0.18)";
          }}
          nodeRelSize={3.6}
          nodeVal={(value: object) => {
            const node = value as ForceNode;
            const scaled = node.size * nodeScale;
            return connectedIds && !connectedIds.has(node.id)
              ? Math.max(2, scaled * 0.28)
              : scaled;
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(
            value: object,
            context: CanvasRenderingContext2D,
            globalScale: number
          ) => {
            const node = value as ForceNode;
            const inSelection = connectedIds?.has(node.id) ?? false;
            const labelBudget =
              globalScale < 0.85
                ? Math.max(4, Math.round(labelDensity * 0.22))
                : globalScale < 1.35
                  ? labelDensity
                  : globalScale < 2.4
                    ? labelDensity * 4
                    : labelDensity * 16;
            if (!inSelection && node.rank > labelBudget) return;
            const fontSize = Math.max(10, Math.min(13, 10 + node.count / 110)) / globalScale;
            const radius = Math.sqrt(node.size * nodeScale * 3.6);
            if (node.id === selectedId) {
              context.beginPath();
              context.arc(node.x ?? 0, node.y ?? 0, radius + 2.5 / globalScale, 0, Math.PI * 2);
              context.strokeStyle = "rgba(245, 218, 174, 0.94)";
              context.lineWidth = 1.5 / globalScale;
              context.stroke();
            }
            context.font = `${node.id === selectedId ? "700 " : "500 "}${fontSize}px Inter, system-ui, sans-serif`;
            context.fillStyle = !connectedIds
              ? node.rank <= 18
                ? "rgba(232, 230, 224, 0.94)"
                : "rgba(232, 230, 224, 0.62)"
              : inSelection
                ? "rgba(232, 230, 224, 0.96)"
                : "rgba(232, 230, 224, 0.12)";
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillText(node.label, node.x ?? 0, (node.y ?? 0) + radius + 4);
          }}
          linkColor={(value: object) => {
            const edge = value as ForceLink;
            if (!connectedIds) {
              return edge.relationCount
                ? "rgba(124, 183, 255, 0.34)"
                : "rgba(180, 180, 200, 0.085)";
            }
            return edgeIsHighlighted(edge)
              ? edge.relationCount
                ? "rgba(124, 183, 255, 0.82)"
                : "rgba(232, 178, 107, 0.68)"
              : "rgba(180, 180, 200, 0.018)";
          }}
          linkWidth={(value: object) => {
            const edge = value as ForceLink;
            const base =
              Math.min(2.4, 0.32 + edge.score * 4 + Math.log1p(edge.weight) * 0.18)
              * linkScale;
            return edgeIsHighlighted(edge) ? base * 1.8 : base;
          }}
          linkDirectionalParticles={(value: object) =>
            (value as ForceLink).relationCount > 0 ? 1 : 0
          }
          linkDirectionalParticleWidth={1.4}
          linkDirectionalParticleSpeed={0.0025}
          warmupTicks={80}
          cooldownTicks={320}
          d3AlphaDecay={0.035}
          d3VelocityDecay={0.38}
          onNodeClick={(value: object) => {
            const node = value as ForceNode;
            if (mergeMode) {
              if (!mergeFrom) {
                setMergeFrom(node);
                return;
              }
              if (mergeFrom.id === node.id) {
                setMergeFrom(null);
                return;
              }
              void onMergeEntities(mergeFrom.id, node.label).then(() => {
                setMergeMode(false);
                setMergeFrom(null);
              });
              return;
            }
            selectAndFocus(node.id);
          }}
          onBackgroundClick={() => {
            if (mergeMode) {
              setMergeMode(false);
              setMergeFrom(null);
            } else {
              setSelectedId(null);
              setFocusOnly(false);
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
              <div>
                <span className="eyebrow">Knowledge map</span>
                <h3>Entity graph</h3>
              </div>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Collapse controls"
                onClick={() => setControlsExpanded(false)}
              >
                ×
              </button>
            </div>
            <span className="graph-stat">
              {graph
                ? `${data.nodes.length.toLocaleString()} entities · ${data.links.length.toLocaleString()} links · ${graph.contextualReferences.toLocaleString()} contextual`
                : "Resolving the archive…"}
            </span>
            {graph ? (
              <>
                <div className="graph-search-row">
                  <input
                    type="search"
                    value={search}
                    list="graph-entities"
                    placeholder="Find an entity"
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitSearch();
                    }}
                  />
                  <datalist id="graph-entities">
                    {graph.nodes.slice(0, 500).map((node) => (
                      <option key={node.id} value={node.label} />
                    ))}
                  </datalist>
                  <button type="button" onClick={submitSearch}>Find</button>
                </div>
                <div className="graph-sections">
                  <details className="graph-section" open>
                    <summary>Groups</summary>
                    <div className="graph-section-body">
                      <span className="graph-section-label">Color nodes by</span>
                      <div className="graph-mode" aria-label="Node color">
                        <button
                          type="button"
                          className={colorMode === "community" ? "active" : ""}
                          onClick={() => setColorMode("community")}
                        >
                          Communities
                        </button>
                        <button
                          type="button"
                          className={colorMode === "type" ? "active" : ""}
                          onClick={() => setColorMode("type")}
                        >
                          Entity types
                        </button>
                      </div>
                      <label className="graph-filter-label">
                        <span>Entity type</span>
                        <select
                          value={entityType}
                          onChange={(event) => setEntityType(event.target.value)}
                        >
                          <option value="all">All types</option>
                          {typeOptions.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                          <option value="unknown">Untyped</option>
                        </select>
                      </label>
                    </div>
                  </details>

                  <details className="graph-section" open>
                    <summary>Filters</summary>
                    <div className="graph-section-body">
                      <label className="graph-slider">
                        <span>Minimum mentions <b>{minCount}</b></span>
                        <input
                          type="range"
                          min={2}
                          max={50}
                          value={minCount}
                          onChange={(event) => setMinCount(Number(event.target.value))}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Association <b>{Math.round(minScore * 100)}%</b></span>
                        <input
                          type="range"
                          min={0}
                          max={40}
                          value={Math.round(minScore * 100)}
                          onChange={(event) => setMinScore(Number(event.target.value) / 100)}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Links per entity <b>{maxLinks}</b></span>
                        <input
                          type="range"
                          min={2}
                          max={28}
                          value={maxLinks}
                          onChange={(event) => setMaxLinks(Number(event.target.value))}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Entity ceiling <b>{nodeLimit.toLocaleString()}</b></span>
                        <input
                          type="range"
                          min={200}
                          max={5000}
                          step={100}
                          value={nodeLimit}
                          onChange={(event) => setNodeLimit(Number(event.target.value))}
                        />
                      </label>
                    </div>
                  </details>

                  <details className="graph-section">
                    <summary>Display</summary>
                    <div className="graph-section-body">
                      <label className="graph-check">
                        <input
                          type="checkbox"
                          checked={showOrphans}
                          onChange={(event) => setShowOrphans(event.target.checked)}
                        />
                        <span>Show unconnected entities</span>
                      </label>
                      <label className="graph-slider">
                        <span>Text fade threshold <b>{labelDensity}</b></span>
                        <input
                          type="range"
                          min={6}
                          max={140}
                          value={labelDensity}
                          onChange={(event) => setLabelDensity(Number(event.target.value))}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Node size <b>{Math.round(nodeScale * 100)}%</b></span>
                        <input
                          type="range"
                          min={35}
                          max={160}
                          value={Math.round(nodeScale * 100)}
                          onChange={(event) => setNodeScale(Number(event.target.value) / 100)}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Link thickness <b>{Math.round(linkScale * 100)}%</b></span>
                        <input
                          type="range"
                          min={20}
                          max={180}
                          value={Math.round(linkScale * 100)}
                          onChange={(event) => setLinkScale(Number(event.target.value) / 100)}
                        />
                      </label>
                    </div>
                  </details>

                  <details className="graph-section">
                    <summary>Forces</summary>
                    <div className="graph-section-body">
                      <label className="graph-slider">
                        <span>Repel force <b>{repelForce}</b></span>
                        <input
                          type="range"
                          min={80}
                          max={900}
                          step={10}
                          value={repelForce}
                          onChange={(event) => setRepelForce(Number(event.target.value))}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Link distance <b>{linkDistance}</b></span>
                        <input
                          type="range"
                          min={28}
                          max={220}
                          value={linkDistance}
                          onChange={(event) => setLinkDistance(Number(event.target.value))}
                        />
                      </label>
                      <label className="graph-slider">
                        <span>Link force <b>{linkForce}%</b></span>
                        <input
                          type="range"
                          min={2}
                          max={60}
                          value={linkForce}
                          onChange={(event) => setLinkForce(Number(event.target.value))}
                        />
                      </label>
                    </div>
                  </details>
                </div>
                <div className="graph-controls-actions">
                  <button type="button" onClick={() => fgRef.current?.zoomToFit(450, 72)}>
                    Fit
                  </button>
                  <button
                    type="button"
                    disabled={!selectedId}
                    className={focusOnly ? "is-saved" : ""}
                    onClick={() => setFocusOnly((value) => !value)}
                  >
                    {focusOnly ? "Overview" : "Focus"}
                  </button>
                  <button
                    type="button"
                    className={mergeMode ? "is-saved" : ""}
                    onClick={() => {
                      setMergeMode((value) => !value);
                      setMergeFrom(null);
                      setSelectedId(null);
                    }}
                  >
                    {mergeMode ? "Cancel" : "Merge"}
                  </button>
                  <button
                    type="button"
                    onClick={() => fgRef.current?.d3ReheatSimulation?.()}
                  >
                    Animate
                  </button>
                </div>
                {mergeMode ? (
                  <span className="graph-stat graph-merge-hint">
                    {mergeFrom
                      ? `Merge “${mergeFrom.label}” → choose its canonical entity.`
                      : "Choose the duplicate or alias first."}
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
            <span className="graph-controls-collapsed-mode">Knowledge map</span>
            <span className="graph-stat">
              {graph
                ? `${data.nodes.length.toLocaleString()}e · ${data.links.length.toLocaleString()}l`
                : "computing…"}
            </span>
          </button>
        )}
      </div>

      {selected ? (
        <aside className="graph-detail">
          <div className="graph-detail-head">
            <div>
              <span className="eyebrow">{selected.entityType === "unknown" ? "Entity" : selected.entityType}</span>
              <strong>{selected.label}</strong>
              <span>
                {selected.count.toLocaleString()} mentions · {selectedEdges.length} visible relationships
              </span>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setSelectedId(null);
                setFocusOnly(false);
              }}
            >
              ×
            </button>
          </div>

          {selectedEdges.length ? (
            <div className="graph-relationships">
              <span className="graph-detail-threads-label">Strongest relationships</span>
              <div className="graph-relationship-list">
                {selectedEdges.slice(0, 6).map((edge) => {
                  const other = nodeId(edge.source) === selected.id
                    ? nodeId(edge.target)
                    : nodeId(edge.source);
                  return (
                    <button
                      type="button"
                      key={`${selected.id}:${other}`}
                      onClick={() => selectAndFocus(other)}
                    >
                      <span>{other}</span>
                      <small>
                        {Math.round(edge.score * 100)}%
                        {edge.relationCount ? ` · ${edge.relationCount} referenced` : ""}
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {selectedEdges.some((edge) => edge.relationCount > 0) ? (
            <div className="graph-reference-evidence">
              <span className="graph-detail-threads-label">Quote / reply evidence</span>
              {selectedEdges
                .flatMap((edge) => edge.evidence)
                .filter((evidence) => evidence.relation_type !== "co_occurrence")
                .slice(0, 3)
                .map((evidence, index) => {
                  const message = messageByKey.get(evidence.message_key);
                  return (
                    <button
                      type="button"
                      key={`${evidence.message_key}:${evidence.related_message_key}:${index}`}
                      onClick={() => {
                        if (message) onJumpToThread(message.thread_root_id);
                      }}
                    >
                      <span>{evidence.relation_type.replace(/_/g, " ")}</span>
                      <small>
                        {message
                          ? (message.text || message.quote_text || "(media)").slice(0, 105)
                          : `${evidence.message_key} → ${evidence.related_message_key}`}
                      </small>
                    </button>
                  );
                })}
            </div>
          ) : null}

          {selectedThreads.length ? (
            <div className="graph-detail-threads">
              <span className="graph-detail-threads-label">Appears in threads</span>
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

          <div className="graph-detail-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => onFilterByEntity(selected.label)}
            >
              Open {selected.count.toLocaleString()} mentions in reader
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

// Web worker: extracts entities from messages and builds a co-occurrence graph.
// Each node is a keyword / proper noun / alias. Each edge is the count of
// messages that mention both entities.

import { extractMessageHits, setUserAliases } from "./entities";

interface InboundMessage {
  type: "build";
  messages: Array<{
    message_key: string;
    message_id: number;
    text: string;
    quote_text: string | null;
    date_utc: string | null;
  }>;
  userAliases?: Array<{ match: string; canonical: string }>;
  options?: {
    minEntityCount?: number;     // drop entities mentioned in < N messages
    minEdgeWeight?: number;      // drop edges with < N shared messages
    maxLabeled?: number;         // top-N entities get rendered labels
  };
}

export interface GraphNode {
  id: string;
  label: string;
  count: number;
  size: number;
  group: number;
  topMessages: string[];
  rank: number;     // 1 = most-mentioned. Used for label visibility.
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphProgress {
  type: "progress";
  phase: string;
  done: number;
  total: number;
}

export interface GraphResult {
  type: "result";
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalMessages: number;
  totalEntities: number;
  droppedWeak: number;       // how many weak hits we threw out
  droppedRare: number;       // how many entities below count threshold
}

function postProgress(phase: string, done: number, total: number) {
  const message: GraphProgress = { type: "progress", phase, done, total };
  (self as unknown as Worker).postMessage(message);
}

function hashGroup(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  if (event.data.type !== "build") return;
  const { messages, options, userAliases } = event.data;
  if (userAliases?.length) {
    setUserAliases(userAliases);
  }
  // Permissive defaults: emit everything count>=2, weight>=2. The view layer
  // applies a stricter user-controlled threshold via sliders, so we don't have
  // to re-run the worker on every tweak.
  const minEntityCount = options?.minEntityCount ?? 2;
  const minEdgeWeight = options?.minEdgeWeight ?? 2;
  const N = messages.length;

  // 1. Extract hits per message (with strength flag)
  postProgress("Extracting entities", 0, N);
  type Hit = { canonical: string; isStrong: boolean };
  const hitsPerMessage: Hit[][] = [];
  const strongCanonicals = new Set<string>();
  const candidateCount = new Map<string, number>(); // strong + weak candidate counts

  for (let i = 0; i < N; i++) {
    const m = messages[i];
    const combined = `${m.text ?? ""} ${m.quote_text ?? ""}`;
    const hits = extractMessageHits(combined);
    hitsPerMessage.push(hits);
    for (const h of hits) {
      if (h.isStrong) strongCanonicals.add(h.canonical);
      candidateCount.set(h.canonical, (candidateCount.get(h.canonical) ?? 0) + 1);
    }
    if (i % 250 === 0) postProgress("Extracting entities", i, N);
  }

  // 2. Filter: drop weak hits whose canonical NEVER appears strong globally.
  //    Then drop entities below minEntityCount.
  postProgress("Filtering noise", 0, candidateCount.size);
  const entityMessages = new Map<string, string[]>();
  let droppedWeak = 0;
  for (let i = 0; i < N; i++) {
    const m = messages[i];
    for (const h of hitsPerMessage[i]) {
      if (!h.isStrong && !strongCanonicals.has(h.canonical)) {
        droppedWeak++;
        continue;
      }
      const list = entityMessages.get(h.canonical);
      if (list) list.push(m.message_key);
      else entityMessages.set(h.canonical, [m.message_key]);
    }
  }

  let droppedRare = 0;
  const keptEntities = new Set<string>();
  for (const [entity, msgs] of entityMessages) {
    if (msgs.length >= minEntityCount) {
      keptEntities.add(entity);
    } else {
      droppedRare++;
    }
  }

  // 3. Co-occurrence
  postProgress("Linking entities", 0, N);
  const SEP = "";
  const pairCounts = new Map<string, number>();

  for (let i = 0; i < N; i++) {
    const ents = Array.from(
      new Set(
        hitsPerMessage[i]
          .filter((h) => h.isStrong || strongCanonicals.has(h.canonical))
          .map((h) => h.canonical)
          .filter((c) => keptEntities.has(c))
      )
    );
    if (ents.length < 2) continue;
    for (let a = 0; a < ents.length; a++) {
      for (let b = a + 1; b < ents.length; b++) {
        const x = ents[a];
        const y = ents[b];
        const key = x < y ? `${x}${SEP}${y}` : `${y}${SEP}${x}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
    if (i % 250 === 0) postProgress("Linking entities", i, N);
  }

  // 4. Build nodes, sized by count, ranked by frequency
  const sortedEntities = Array.from(keptEntities).sort((a, b) => {
    const ac = entityMessages.get(a)?.length ?? 0;
    const bc = entityMessages.get(b)?.length ?? 0;
    return bc - ac;
  });

  const nodes: GraphNode[] = sortedEntities.map((entity, idx) => {
    const msgs = entityMessages.get(entity) ?? [];
    // Obsidian-style: small uniform dots, log-scaled growth, hard upper cap.
    // size is the d3-force "value" used by ForceGraph; pixel radius is
    // sqrt(size * nodeRelSize / PI) — keep range tight (~3-9px).
    const c = msgs.length;
    const size = Math.min(80, 6 + Math.log(c + 1) * 6);
    return {
      id: entity,
      label: entity,
      count: c,
      size,
      group: hashGroup(entity),
      topMessages: msgs.slice(0, 12),
      rank: idx + 1
    };
  });

  // 5. Build edges
  const edges: GraphEdge[] = [];
  for (const [key, weight] of pairCounts) {
    if (weight < minEdgeWeight) continue;
    const sepIdx = key.indexOf(SEP);
    const source = key.slice(0, sepIdx);
    const target = key.slice(sepIdx + 1);
    edges.push({ source, target, weight });
  }
  edges.sort((a, b) => b.weight - a.weight);

  const result: GraphResult = {
    type: "result",
    nodes,
    edges,
    totalMessages: N,
    totalEntities: nodes.length,
    droppedWeak,
    droppedRare
  };
  (self as unknown as Worker).postMessage(result);
};

export {};

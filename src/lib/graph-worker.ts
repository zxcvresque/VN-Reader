// Web worker: resolves canonical entities, adds occurrence-scoped
// coreferences, and builds a weighted knowledge graph.

import { extractMessageHits, setUserAliases } from "./entities";
import type { EntityResolutionRecord } from "../types";

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
  entityResolutions?: EntityResolutionRecord[];
  options?: {
    minEntityCount?: number;
    minEdgeWeight?: number;
  };
}

export interface GraphNode {
  id: string;
  label: string;
  count: number;
  size: number;
  group: number;
  entityType: string;
  topMessages: string[];
  rank: number;
}

export interface GraphEdgeEvidence {
  message_key: string;
  related_message_key: string;
  relation_type: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  score: number;
  relationCount: number;
  evidence: GraphEdgeEvidence[];
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
  droppedWeak: number;
  droppedRare: number;
  contextualReferences: number;
  maxEdgeScore: number;
}

interface Hit {
  canonical: string;
  isStrong: boolean;
  isResolved: boolean;
}

interface ContextRelation {
  canonical: string;
  messageKey: string;
  relatedMessageKey: string;
  relationType: string;
}

interface PairAggregate {
  weight: number;
  relationCount: number;
  evidence: GraphEdgeEvidence[];
}

const SEP = "\u0001";
const MAX_ENTITIES_PER_MESSAGE = 32;

function postProgress(phase: string, done: number, total: number) {
  const message: GraphProgress = { type: "progress", phase, done, total };
  (self as unknown as Worker).postMessage(message);
}

function accepted(record: EntityResolutionRecord): boolean {
  return record.status === "resolved" || record.status === "same_as_written";
}

function phrasePattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}${SEP}${right}` : `${right}${SEP}${left}`;
}

function addEvidence(aggregate: PairAggregate, evidence: GraphEdgeEvidence): void {
  const exists = aggregate.evidence.some(
    (item) =>
      item.message_key === evidence.message_key
      && item.related_message_key === evidence.related_message_key
      && item.relation_type === evidence.relation_type
  );
  if (!exists && aggregate.evidence.length < 5) aggregate.evidence.push(evidence);
}

function addPair(
  pairs: Map<string, PairAggregate>,
  left: string,
  right: string,
  evidence: GraphEdgeEvidence,
  contextual = false
): void {
  if (!left || !right || left === right) return;
  const key = pairKey(left, right);
  const aggregate = pairs.get(key) ?? { weight: 0, relationCount: 0, evidence: [] };
  aggregate.weight += 1;
  if (contextual) aggregate.relationCount += 1;
  addEvidence(aggregate, evidence);
  pairs.set(key, aggregate);
}

function compactCommunities(
  entities: string[],
  edges: GraphEdge[]
): Map<string, number> {
  const adjacency = new Map<string, Array<{ id: string; strength: number }>>();
  for (const entity of entities) adjacency.set(entity, []);
  for (const edge of edges) {
    const strength = Math.max(0.01, edge.score) * Math.log2(edge.weight + 1);
    adjacency.get(edge.source)?.push({ id: edge.target, strength });
    adjacency.get(edge.target)?.push({ id: edge.source, strength });
  }

  const community = new Map<string, number>();
  entities.forEach((entity, index) => community.set(entity, index));
  const order = [...entities].sort(
    (a, b) =>
      (adjacency.get(b)?.length ?? 0) - (adjacency.get(a)?.length ?? 0)
      || a.localeCompare(b)
  );

  for (let iteration = 0; iteration < 10; iteration += 1) {
    let changed = 0;
    for (const entity of order) {
      const scores = new Map<number, number>();
      for (const neighbor of adjacency.get(entity) ?? []) {
        const id = community.get(neighbor.id);
        if (id === undefined) continue;
        scores.set(id, (scores.get(id) ?? 0) + neighbor.strength);
      }
      let best = community.get(entity) ?? 0;
      let bestScore = -1;
      for (const [candidate, score] of scores) {
        if (score > bestScore || (score === bestScore && candidate < best)) {
          best = candidate;
          bestScore = score;
        }
      }
      if (community.get(entity) !== best) {
        community.set(entity, best);
        changed += 1;
      }
    }
    if (changed === 0) break;
  }

  const sizes = new Map<number, number>();
  for (const id of community.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  const remap = new Map<number, number>();
  [...sizes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .forEach(([id], index) => remap.set(id, index));
  for (const [entity, id] of community) community.set(entity, remap.get(id) ?? 0);
  return community;
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  if (event.data.type !== "build") return;
  const {
    messages,
    options,
    userAliases,
    entityResolutions = []
  } = event.data;
  setUserAliases(userAliases ?? []);

  const minEntityCount = options?.minEntityCount ?? 2;
  const minEdgeWeight = options?.minEdgeWeight ?? 2;
  const total = messages.length;
  const typeByCanonical = new Map<string, string>();
  const resolvedCanonicals = new Set<string>();
  const globalMappings: Array<{ surface: string; names: string[]; pattern: RegExp }> = [];
  const blockedGlobal = new Set<string>();
  const contextualByMessage = new Map<string, Set<string>>();
  const contextRelations: ContextRelation[] = [];

  for (const resolution of entityResolutions) {
    if (
      (resolution.status === "wrong_flag" || resolution.status === "not_entity")
      && resolution.resolution_scope === "global_alias"
    ) {
      blockedGlobal.add(resolution.surface_form.toLocaleLowerCase());
      continue;
    }
    if (!accepted(resolution)) continue;
    for (const canonical of resolution.canonical_names) {
      resolvedCanonicals.add(canonical);
      if (resolution.entity_type) typeByCanonical.set(canonical, resolution.entity_type);
    }
    if (resolution.resolution_scope === "global_alias" && resolution.surface_form) {
      globalMappings.push({
        surface: resolution.surface_form,
        names: resolution.canonical_names,
        pattern: phrasePattern(resolution.surface_form)
      });
      continue;
    }
    for (const evidence of resolution.evidence) {
      if (!evidence.message_key) continue;
      const set = contextualByMessage.get(evidence.message_key) ?? new Set<string>();
      resolution.canonical_names.forEach((canonical) => set.add(canonical));
      contextualByMessage.set(evidence.message_key, set);
      for (const canonical of resolution.canonical_names) {
        contextRelations.push({
          canonical,
          messageKey: evidence.message_key,
          relatedMessageKey: evidence.related_message_key,
          relationType: evidence.relation_type || "context"
        });
      }
    }
  }

  postProgress("Resolving entities", 0, total);
  const hitsPerMessage = new Map<string, Hit[]>();
  const strongCanonicals = new Set<string>();
  const candidateCount = new Map<string, number>();
  let contextualReferences = 0;

  for (let index = 0; index < total; index += 1) {
    const message = messages[index];
    const combined = `${message.text ?? ""} ${message.quote_text ?? ""}`;
    const deduped = new Map<string, Hit>();
    for (const hit of extractMessageHits(combined)) {
      if (blockedGlobal.has(hit.canonical.toLocaleLowerCase())) continue;
      const existing = deduped.get(hit.canonical);
      deduped.set(hit.canonical, {
        canonical: hit.canonical,
        isStrong: hit.isStrong || Boolean(existing?.isStrong),
        isResolved: Boolean(existing?.isResolved)
      });
    }
    for (const mapping of globalMappings) {
      mapping.pattern.lastIndex = 0;
      if (!mapping.pattern.test(combined)) continue;
      for (const canonical of mapping.names) {
        deduped.set(canonical, { canonical, isStrong: true, isResolved: true });
      }
    }
    for (const canonical of contextualByMessage.get(message.message_key) ?? []) {
      deduped.set(canonical, { canonical, isStrong: true, isResolved: true });
      contextualReferences += 1;
    }
    const hits = [...deduped.values()];
    hitsPerMessage.set(message.message_key, hits);
    for (const hit of hits) {
      if (hit.isStrong) strongCanonicals.add(hit.canonical);
      candidateCount.set(hit.canonical, (candidateCount.get(hit.canonical) ?? 0) + 1);
    }
    if (index % 250 === 0) postProgress("Resolving entities", index, total);
  }

  postProgress("Filtering noise", 0, candidateCount.size);
  const entityMessages = new Map<string, string[]>();
  let droppedWeak = 0;
  for (const message of messages) {
    const acceptedHits = (hitsPerMessage.get(message.message_key) ?? []).filter((hit) => {
      if (hit.isStrong || hit.isResolved || strongCanonicals.has(hit.canonical)) return true;
      droppedWeak += 1;
      return false;
    });
    for (const hit of acceptedHits) {
      const list = entityMessages.get(hit.canonical);
      if (list) list.push(message.message_key);
      else entityMessages.set(hit.canonical, [message.message_key]);
    }
    hitsPerMessage.set(message.message_key, acceptedHits);
  }

  const keptEntities = new Set<string>();
  let droppedRare = 0;
  for (const [entity, messageKeys] of entityMessages) {
    if (messageKeys.length >= minEntityCount || resolvedCanonicals.has(entity)) {
      keptEntities.add(entity);
    } else {
      droppedRare += 1;
    }
  }

  postProgress("Linking knowledge", 0, total);
  const pairCounts = new Map<string, PairAggregate>();
  const canonicalHitsByMessage = new Map<string, string[]>();
  for (let index = 0; index < total; index += 1) {
    const message = messages[index];
    const hits = (hitsPerMessage.get(message.message_key) ?? [])
      .filter((hit) => keptEntities.has(hit.canonical))
      .sort(
        (a, b) =>
          Number(b.isResolved) - Number(a.isResolved)
          || Number(b.isStrong) - Number(a.isStrong)
          || (candidateCount.get(b.canonical) ?? 0) - (candidateCount.get(a.canonical) ?? 0)
      )
      .slice(0, MAX_ENTITIES_PER_MESSAGE);
    const entities = [...new Set(hits.map((hit) => hit.canonical))];
    canonicalHitsByMessage.set(message.message_key, entities);
    for (let left = 0; left < entities.length; left += 1) {
      for (let right = left + 1; right < entities.length; right += 1) {
        addPair(pairCounts, entities[left], entities[right], {
          message_key: message.message_key,
          related_message_key: "",
          relation_type: "co_occurrence"
        });
      }
    }
    if (index % 250 === 0) postProgress("Linking knowledge", index, total);
  }

  for (const relation of contextRelations) {
    if (!keptEntities.has(relation.canonical) || !relation.relatedMessageKey) continue;
    const relatedEntities = canonicalHitsByMessage.get(relation.relatedMessageKey) ?? [];
    for (const related of relatedEntities.slice(0, 12)) {
      addPair(
        pairCounts,
        relation.canonical,
        related,
        {
          message_key: relation.messageKey,
          related_message_key: relation.relatedMessageKey,
          relation_type: relation.relationType
        },
        true
      );
    }
  }

  const edges: GraphEdge[] = [];
  let maxEdgeScore = 0;
  for (const [key, aggregate] of pairCounts) {
    if (aggregate.weight < minEdgeWeight && aggregate.relationCount === 0) continue;
    const separator = key.indexOf(SEP);
    const source = key.slice(0, separator);
    const target = key.slice(separator + 1);
    if (!keptEntities.has(source) || !keptEntities.has(target)) continue;
    const sourceCount = entityMessages.get(source)?.length ?? 1;
    const targetCount = entityMessages.get(target)?.length ?? 1;
    const score = aggregate.weight / Math.sqrt(sourceCount * targetCount);
    maxEdgeScore = Math.max(maxEdgeScore, score);
    edges.push({
      source,
      target,
      weight: aggregate.weight,
      score,
      relationCount: aggregate.relationCount,
      evidence: aggregate.evidence
    });
  }
  edges.sort((a, b) => b.score - a.score || b.weight - a.weight);

  const sortedEntities = [...keptEntities].sort(
    (a, b) =>
      (entityMessages.get(b)?.length ?? 0) - (entityMessages.get(a)?.length ?? 0)
      || a.localeCompare(b)
  );
  const communities = compactCommunities(sortedEntities, edges);
  const nodes: GraphNode[] = sortedEntities.map((entity, index) => {
    const messageKeys = entityMessages.get(entity) ?? [];
    const count = messageKeys.length;
    return {
      id: entity,
      label: entity,
      count,
      size: Math.min(68, 7 + Math.log(count + 1) * 5.4),
      group: communities.get(entity) ?? 0,
      entityType: typeByCanonical.get(entity) || "unknown",
      topMessages: messageKeys.slice(0, 16),
      rank: index + 1
    };
  });

  const result: GraphResult = {
    type: "result",
    nodes,
    edges,
    totalMessages: total,
    totalEntities: nodes.length,
    droppedWeak,
    droppedRare,
    contextualReferences,
    maxEdgeScore
  };
  (self as unknown as Worker).postMessage(result);
};

export {};

import type {
  EntityMentionKind,
  EntityResolutionEvidence,
  EntityResolutionImport,
  EntityResolutionRecord,
  EntityResolutionScope,
  EntityResolutionStatus
} from "../types";

const MENTION_KINDS = new Set<EntityMentionKind>([
  "alias",
  "implicit_reference",
  "noun_phrase",
  "pronoun"
]);

const SCOPES = new Set<EntityResolutionScope>([
  "context_cluster",
  "global_alias",
  "occurrence"
]);

const STATUSES = new Set<EntityResolutionStatus>([
  "not_entity",
  "resolved",
  "same_as_written",
  "skipped",
  "unknown",
  "wrong_flag"
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEvidence(value: unknown): EntityResolutionEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((raw, index) => {
    const item = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    return {
      occurrence_id: text(item.occurrence_id) || `evidence-${index + 1}`,
      message_key: text(item.message_key),
      telegram_url: text(item.telegram_url),
      excerpt: text(item.excerpt),
      relation_type: text(item.relation_type),
      related_message_key: text(item.related_message_key),
      related_telegram_url: text(item.related_telegram_url),
      related_excerpt: text(item.related_excerpt)
    };
  });
}

function normalizeNames(value: unknown, fallback: unknown): string[] {
  const source = Array.isArray(value) ? value : [fallback];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of source) {
    const name = text(raw);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function parseEntityResolutionJson(rawText: string): EntityResolutionImport {
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (parsed.schema !== "vn-reader-entity-resolutions") {
    throw new Error("Not a VN Reader entity-resolution file.");
  }
  if (Number(parsed.schema_version) !== 1) {
    throw new Error("Unsupported entity-resolution schema version.");
  }

  const dataset = parsed.dataset && typeof parsed.dataset === "object"
    ? parsed.dataset as Record<string, unknown>
    : {};
  const datasetId = text(dataset.dataset_id);
  if (!datasetId) {
    throw new Error("Entity-resolution file is missing dataset.dataset_id.");
  }
  if (!Array.isArray(parsed.resolutions)) {
    throw new Error("Entity-resolution file has no resolutions array.");
  }

  const resolutions: EntityResolutionRecord[] = [];
  parsed.resolutions.forEach((raw, index) => {
    const value = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    const questionId = text(value.question_id) || `resolution-${index + 1}`;
    const surfaceForm = text(value.surface_form);
    const rawKind = text(value.mention_kind) as EntityMentionKind;
    const rawScope = text(value.resolution_scope) as EntityResolutionScope;
    const rawStatus = text(value.status) as EntityResolutionStatus;
    const mentionKind = MENTION_KINDS.has(rawKind) ? rawKind : "noun_phrase";
    const resolutionScope = SCOPES.has(rawScope)
      ? rawScope
      : mentionKind === "pronoun"
        ? "occurrence"
        : "global_alias";
    const status = STATUSES.has(rawStatus) ? rawStatus : "resolved";
    const canonicalNames = normalizeNames(value.canonical_names, value.canonical_name);
    if (
      (status === "resolved" || status === "same_as_written")
      && canonicalNames.length === 0
    ) {
      throw new Error(`Resolution ${questionId} has no canonical entity.`);
    }
    resolutions.push({
      key: `${datasetId}::${questionId}`,
      dataset_id: datasetId,
      question_id: questionId,
      surface_form: surfaceForm,
      mention_kind: mentionKind,
      resolution_scope: resolutionScope,
      occurrence_cluster_id: text(value.occurrence_cluster_id),
      canonical_name: canonicalNames[0] ?? "",
      canonical_names: canonicalNames,
      entity_type: text(value.entity_type),
      status,
      evidence: normalizeEvidence(value.evidence),
      notes: text(value.notes),
      created_at_utc: text(value.created_at_utc) || new Date().toISOString(),
      updated_at_utc: text(value.updated_at_utc) || new Date().toISOString()
    });
  });

  return {
    schema: "vn-reader-entity-resolutions",
    schema_version: 1,
    exported_at_utc: text(parsed.exported_at_utc),
    dataset: {
      dataset_id: datasetId,
      title: text(dataset.title)
    },
    resolutions
  };
}

export function acceptedResolution(record: EntityResolutionRecord): boolean {
  return record.status === "resolved" || record.status === "same_as_written";
}

export function globalSingleAlias(
  record: EntityResolutionRecord
): { match: string; canonical: string } | null {
  if (
    !acceptedResolution(record)
    || record.resolution_scope !== "global_alias"
    || !record.surface_form
    || record.canonical_names.length !== 1
  ) {
    return null;
  }
  return {
    match: record.surface_form,
    canonical: record.canonical_names[0]
  };
}

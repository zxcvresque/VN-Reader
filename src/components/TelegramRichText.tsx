import type { ReactNode } from "react";

type TelegramEntity = {
  _: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

const URL_REGEX = /https?:\/\/[^\s]+/gi;

function normalizeEntities(input: unknown): TelegramEntity[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((entity): entity is TelegramEntity => {
      if (!entity || typeof entity !== "object") {
        return false;
      }
      const candidate = entity as Partial<TelegramEntity>;
      return (
        typeof candidate._ === "string" &&
        typeof candidate.offset === "number" &&
        typeof candidate.length === "number"
      );
    })
    .filter((entity) => entity.length > 0)
    .sort((left, right) => left.offset - right.offset || left.length - right.length);
}

function normalizeUrlCandidate(value: string): string {
  return value.replace(/[).,!?]+$/g, "");
}

function entityHref(entity: TelegramEntity, segmentText: string): string | null {
  switch (entity._) {
    case "MessageEntityTextUrl":
      return entity.url ?? null;
    case "MessageEntityUrl":
      return normalizeUrlCandidate(segmentText);
    case "MessageEntityEmail":
      return `mailto:${segmentText}`;
    case "MessageEntityPhone":
      return `tel:${segmentText}`;
    case "MessageEntityMention":
      return `https://t.me/${segmentText.replace(/^@/, "")}`;
    default:
      return null;
  }
}

function applyEntityStyles(
  node: ReactNode,
  activeEntities: TelegramEntity[],
  keyPrefix: string
): ReactNode {
  return activeEntities.reduce<ReactNode>((current, entity, index) => {
    const key = `${keyPrefix}-${entity._}-${entity.offset}-${index}`;
    switch (entity._) {
      case "MessageEntityBold":
        return <strong key={key}>{current}</strong>;
      case "MessageEntityItalic":
        return <em key={key}>{current}</em>;
      case "MessageEntityUnderline":
        return <u key={key}>{current}</u>;
      case "MessageEntityStrike":
        return <s key={key}>{current}</s>;
      case "MessageEntityCode":
        return <code key={key} className="tg-inline-code">{current}</code>;
      case "MessageEntityPre":
        return (
          <code key={key} className="tg-inline-code tg-inline-pre" data-language={entity.language ?? ""}>
            {current}
          </code>
        );
      case "MessageEntitySpoiler":
        return <span key={key} className="tg-spoiler">{current}</span>;
      case "MessageEntityBlockquote":
        return <span key={key} className="tg-inline-quote">{current}</span>;
      case "MessageEntitySearchHighlight":
        return <mark key={key} className="tg-search-highlight">{current}</mark>;
      case "MessageEntityPassageHighlight":
        return <mark key={key} className="tg-passage-highlight">{current}</mark>;
      case "MessageEntityQuoteHighlight":
        return <mark key={key} className="tg-quote-highlight">{current}</mark>;
      default:
        return current;
    }
  }, node);
}

export interface TelegramRichTextProps {
  className?: string;
  entities?: unknown;
  text: string;
  highlightRange?: { offset: number; length: number } | null;
  searchHighlight?: string;
  savedPassageTexts?: string[];
}

export function extractMessageEntities(raw: unknown): TelegramEntity[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const entities = (raw as { entities?: unknown }).entities;
  return normalizeEntities(entities);
}

export default function TelegramRichText({
  className, entities, text, highlightRange, searchHighlight, savedPassageTexts = []
}: TelegramRichTextProps) {
  const normalizedText = text ?? "";
  if (!normalizedText) return null;
  const normalizedEntities: TelegramEntity[] = [...normalizeEntities(entities)];
  // Link boundaries and highlights share one pipeline so formatting and URLs survive splitting.
  for (const match of normalizedText.matchAll(URL_REGEX)) {
    const offset = match.index ?? 0;
    if (!normalizedEntities.some((entity) => entity.offset <= offset && offset < entity.offset + entity.length && ["MessageEntityUrl", "MessageEntityTextUrl"].includes(entity._))) {
      const url = normalizeUrlCandidate(match[0]);
      normalizedEntities.push({ _: "MessageEntityTextUrl", offset, length: url.length, url });
    }
  }
  const addMatches = (needle: string, kind: string) => {
    if (!needle.trim()) return;
    const haystack = normalizedText.toLocaleLowerCase();
    const query = needle.toLocaleLowerCase();
    let cursor = 0;
    while (cursor < haystack.length) {
      const offset = haystack.indexOf(query, cursor);
      if (offset < 0) break;
      normalizedEntities.push({ _: kind, offset, length: needle.length });
      cursor = offset + Math.max(1, needle.length);
    }
  };
  for (const passage of savedPassageTexts) addMatches(passage, "MessageEntityPassageHighlight");
  if (searchHighlight) addMatches(searchHighlight, "MessageEntitySearchHighlight");
  if (highlightRange && highlightRange.length > 0 && highlightRange.offset >= 0 && highlightRange.offset < normalizedText.length) {
    normalizedEntities.push({ _: "MessageEntityQuoteHighlight", offset: highlightRange.offset, length: Math.min(highlightRange.length, normalizedText.length - highlightRange.offset) });
  }

  function renderRange(rangeStart: number, rangeEnd: number): ReactNode[] {
    const boundaries = new Set<number>([rangeStart, rangeEnd]);
    for (const entity of normalizedEntities) {
      if (entity.offset + entity.length <= rangeStart || entity.offset >= rangeEnd) continue;
      boundaries.add(Math.max(rangeStart, Math.min(rangeEnd, entity.offset)));
      boundaries.add(Math.max(rangeStart, Math.min(rangeEnd, entity.offset + entity.length)));
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    const nodes: ReactNode[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (end <= start) continue;
      const segmentText = normalizedText.slice(start, end);
      const active = normalizedEntities.filter((entity) => entity.offset <= start && start < entity.offset + entity.length);
      const link = active.find((entity) => entity._ === "MessageEntityTextUrl") ?? active.find((entity) => ["MessageEntityUrl", "MessageEntityEmail", "MessageEntityPhone", "MessageEntityMention"].includes(entity._));
      let node: ReactNode = segmentText;
      if (link) {
        // Derive the address from the entire entity, never the highlighted fragment.
        const href = entityHref(link, normalizedText.slice(link.offset, link.offset + link.length));
        if (href && /^(https?:|mailto:|tel:)/i.test(href)) node = <a href={href} target="_blank" rel="noreferrer">{segmentText}</a>;
      }
      const highlight = active.find((entity) => entity._ === "MessageEntityQuoteHighlight")
        ?? active.find((entity) => entity._ === "MessageEntitySearchHighlight")
        ?? active.find((entity) => entity._ === "MessageEntityPassageHighlight");
      node = applyEntityStyles(node, active.filter((entity) => entity !== link && (!entity._.endsWith("Highlight") || entity === highlight)), `segment-${start}-${end}`);
      nodes.push(<span key={`segment-${start}-${end}`} data-text-offset={start}>{node}</span>);
    }
    return nodes;
  }

  const paragraphs: ReactNode[] = [];
  let cursor = 0;
  for (const separator of normalizedText.matchAll(/\n[ \t]*\n+/g)) {
    const end = separator.index ?? 0;
    paragraphs.push(<p className="reader-text-paragraph" data-paragraph-offset={cursor} key={cursor}>{renderRange(cursor, end)}</p>);
    cursor = end + separator[0].length;
  }
  paragraphs.push(<p className="reader-text-paragraph" data-paragraph-offset={cursor} key={cursor}>{renderRange(cursor, normalizedText.length)}</p>);
  return <div className={["telegram-rich-text", className].filter(Boolean).join(" ")}>{paragraphs}</div>;
}

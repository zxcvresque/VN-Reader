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
      case "MessageEntityQuoteHighlight":
        return <mark key={key} className="tg-quote-highlight">{current}</mark>;
      default:
        return current;
    }
  }, node);
}

function renderLinkifiedPlainText(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0;
    const rawUrl = match[0];
    const normalizedUrl = normalizeUrlCandidate(rawUrl);

    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <a key={`${keyPrefix}-${start}`} href={normalizedUrl} target="_blank" rel="noreferrer">
        {normalizedUrl}
      </a>
    );
    cursor = start + rawUrl.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export interface TelegramRichTextProps {
  className?: string;
  entities?: unknown;
  text: string;
  highlightRange?: { offset: number; length: number } | null;
}

export function extractMessageEntities(raw: unknown): TelegramEntity[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const entities = (raw as { entities?: unknown }).entities;
  return normalizeEntities(entities);
}

export default function TelegramRichText({
  className,
  entities,
  text,
  highlightRange
}: TelegramRichTextProps) {
  const normalizedText = text ?? "";
  const baseEntities = normalizeEntities(entities);

  // Inject the quote-highlight as a synthetic entity so it goes through the
  // same boundary/segment pipeline as bold/italic/etc.
  const normalizedEntities: TelegramEntity[] = [...baseEntities];
  if (
    highlightRange &&
    highlightRange.length > 0 &&
    highlightRange.offset >= 0 &&
    highlightRange.offset < normalizedText.length
  ) {
    const start = Math.max(0, Math.min(normalizedText.length, highlightRange.offset));
    const end = Math.max(
      start,
      Math.min(normalizedText.length, highlightRange.offset + highlightRange.length)
    );
    if (end > start) {
      normalizedEntities.push({
        _: "MessageEntityQuoteHighlight",
        offset: start,
        length: end - start
      });
    }
  }

  if (!normalizedText) {
    return null;
  }

  if (!normalizedEntities.length) {
    const inlineNodes = renderLinkifiedPlainText(normalizedText, "plain");
    return (
      <div className={["telegram-rich-text", className].filter(Boolean).join(" ")}>
        {inlineNodes}
      </div>
    );
  }

  const boundaries = new Set<number>([0, normalizedText.length]);
  for (const entity of normalizedEntities) {
    boundaries.add(Math.max(0, Math.min(normalizedText.length, entity.offset)));
    boundaries.add(Math.max(0, Math.min(normalizedText.length, entity.offset + entity.length)));
  }

  const orderedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
  const nodes: ReactNode[] = [];

  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const start = orderedBoundaries[index];
    const end = orderedBoundaries[index + 1];
    if (end <= start) {
      continue;
    }

    const segmentText = normalizedText.slice(start, end);
    if (!segmentText) {
      continue;
    }

    const activeEntities = normalizedEntities.filter(
      (entity) => entity.offset <= start && start < entity.offset + entity.length
    );

    const linkEntity =
      activeEntities.find((entity) => entity._ === "MessageEntityTextUrl") ??
      activeEntities.find((entity) =>
        [
          "MessageEntityUrl",
          "MessageEntityEmail",
          "MessageEntityPhone",
          "MessageEntityMention"
        ].includes(entity._)
      );

    let segmentNode: ReactNode = segmentText;
    if (linkEntity) {
      const href = entityHref(linkEntity, segmentText);
      if (href) {
        segmentNode = (
          <a
            key={`link-${start}-${end}`}
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {segmentText}
          </a>
        );
      }
    }

    segmentNode = applyEntityStyles(
      segmentNode,
      activeEntities.filter((entity) => entity !== linkEntity),
      `segment-${start}-${end}`
    );

    nodes.push(<span key={`segment-${start}-${end}`}>{segmentNode}</span>);
  }

  return <div className={["telegram-rich-text", className].filter(Boolean).join(" ")}>{nodes}</div>;
}

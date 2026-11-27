import { useState, type ReactNode } from "react";

export interface InstantViewDocument {
  title: string | null;
  siteName: string | null;
  url: string;
  rtl: boolean;
  blocks: unknown[];
  photos?: Record<string, { url: string; width?: number; height?: number }>;
}

type TL = Record<string, unknown>;
const object = (value: unknown): TL => value && typeof value === "object" ? value as TL : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const photoDimension = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 32768 ? value : undefined;

function captionText(value: unknown, depth = 0): string {
  if (depth > 20) return "";
  if (typeof value === "string") return value;
  const item = object(value);
  return item._ === "TextConcat" ? array(item.texts).map(part => captionText(part, depth + 1)).join("") : captionText(item.text, depth + 1);
}

function CachedArticlePhoto({ photo, alt, fallback, inline = false, width, height }: {
  photo: unknown; alt: string; fallback: ReactNode; inline?: boolean; width?: unknown; height?: unknown;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const item = object(photo), src = string(item.url);
  // Only files already fetched and indexed by the IV worker may render here.
  // Publisher URLs, data URLs and URL-shaped paths are never image sources.
  if (!/^\/api\/instant-view-media\/[a-f0-9]{64}$/.test(src) || failedSource === src) {
    return <span className="iv-photo-unavailable">{fallback}</span>;
  }
  return <img className={inline ? "iv-inline-photo" : "iv-photo"} src={src} alt={alt}
    width={photoDimension(width) ?? photoDimension(item.width)} height={photoDimension(height) ?? photoDimension(item.height)}
    loading="lazy" decoding="async" onError={() => setFailedSource(src)} />;
}

/** Content links are data, never executable markup or embedded scripts. */
function safeHref(value: unknown, base: string): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export default function InstantViewArticle({ article }: { article: InstantViewDocument }) {
  const original = safeHref(article.url, article.url);
  const link = (href: string | undefined, children: ReactNode): ReactNode => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : children;
  const photoFor = (id: unknown) => {
    if (typeof id === "number" && !Number.isSafeInteger(id)) return null;
    const key = typeof id === "string" || typeof id === "number" ? String(id) : "";
    return /^-?\d+$/.test(key) && Object.prototype.hasOwnProperty.call(article.photos ?? {}, key) ? article.photos?.[key] : null;
  };

  function text(value: unknown, depth = 0): ReactNode {
    if (depth > 40) return null;
    if (typeof value === "string") return value;
    const item = object(value), child = () => text(item.text, depth + 1);
    switch (item._) {
      case "TextEmpty": return null;
      case "TextPlain": return string(item.text);
      case "TextConcat": return array(item.texts).map((part, index) => <span key={index}>{text(part, depth + 1)}</span>);
      case "TextBold": return <strong>{child()}</strong>;
      case "TextItalic": return <em>{child()}</em>;
      case "TextUnderline": return <u>{child()}</u>;
      case "TextStrike": return <s>{child()}</s>;
      case "TextFixed": return <code>{child()}</code>;
      case "TextSubscript": return <sub>{child()}</sub>;
      case "TextSuperscript": return <sup>{child()}</sup>;
      case "TextMarked": return <mark>{child()}</mark>;
      case "TextUrl": return link(safeHref(item.url, article.url), child());
      case "TextEmail": return child();
      case "TextPhone": return child();
      case "TextAnchor": return <span id={string(item.name)}>{child()}</span>;
      case "TextImage": return <CachedArticlePhoto inline photo={photoFor(item.photo_id ?? item.document_id)} alt="Article image" width={item.w} height={item.h} fallback={link(original, "View image on original page")} />;
      default: return typeof item.text === "string" ? item.text : null;
    }
  }

  const caption = (value: unknown) => {
    const item = object(value);
    return <figcaption>{text(item.text)}{Boolean(item.credit) && <small>{text(item.credit)}</small>}</figcaption>;
  };
  const blocks = (values: unknown, depth = 0): ReactNode => array(values).map((value, index) => <div className="iv-block" key={index}>{block(value, depth + 1)}</div>);

  function block(value: unknown, depth = 0): ReactNode {
    if (depth > 30) return null;
    const item = object(value);
    switch (item._) {
      case "PageBlockTitle": return <h1>{text(item.text)}</h1>;
      case "PageBlockSubtitle": return <p className="iv-subtitle">{text(item.text)}</p>;
      case "PageBlockHeader": return <h2>{text(item.text)}</h2>;
      case "PageBlockSubheader": return <h3>{text(item.text)}</h3>;
      case "PageBlockParagraph": return <p>{text(item.text)}</p>;
      case "PageBlockFooter": return <p className="iv-credit">{text(item.text)}</p>;
      case "PageBlockKicker": return <p>{text(item.text)}</p>;
      case "PageBlockAuthorDate": return <p className="iv-credit">{text(item.author)}{typeof item.published_date === "number" && item.published_date > 0 && <> · {new Date(item.published_date * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}</>}</p>;
      case "PageBlockPreformatted": return <pre><code>{text(item.text)}</code></pre>;
      case "PageBlockDivider": return <hr />;
      case "PageBlockAnchor": return <span id={string(item.name)} />;
      case "PageBlockBlockquote":
      case "PageBlockPullquote": return <blockquote><p>{text(item.text)}</p>{Boolean(item.caption) && <footer>{text(item.caption)}</footer>}</blockquote>;
      case "PageBlockCover": return block(item.cover, depth + 1);
      case "PageBlockList":
      case "PageBlockOrderedList": {
        const List = item._ === "PageBlockOrderedList" || item.ordered ? "ol" : "ul";
        return <List>{array(item.items).map((part, index) => {
          const entry = object(part), orderedValue = Number(entry.num);
          return <li key={index} value={Number.isInteger(orderedValue) && orderedValue > 0 ? orderedValue : undefined}>{entry.blocks ? blocks(entry.blocks, depth) : text(entry.text ?? part)}</li>;
        })}</List>;
      }
      case "PageBlockDetails": return <details open={Boolean(item.open)}><summary>{text(item.title)}</summary>{blocks(item.blocks, depth)}</details>;
      case "PageBlockTable": return <div className="iv-table"><table><caption>{text(item.title)}</caption><tbody>{array(item.rows).map((row, index) => <tr key={index}>{array(object(row).cells).map((cell, cellIndex) => {
        const entry = object(cell), Cell = entry.header ? "th" : "td";
        const span = (value: unknown) => typeof value === "number" && value > 0 ? Math.min(100, value) : undefined;
        return <Cell key={cellIndex} colSpan={span(entry.colspan)} rowSpan={span(entry.rowspan)}>{text(entry.text)}</Cell>;
      })}</tr>)}</tbody></table></div>;
      case "PageBlockCollage":
      case "PageBlockSlideshow": return <section>{blocks(item.items, depth)}{caption(item.caption)}</section>;
      case "PageBlockEmbedPost": return <section>{blocks(item.blocks, depth)}{caption(item.caption)}</section>;
      case "PageBlockPhoto": return <figure className="iv-photo-figure">
        <CachedArticlePhoto photo={photoFor(item.photo_id)} alt={captionText(object(item.caption).text).trim().slice(0, 500) || "Article image"}
          fallback={link(safeHref(item.url, article.url) ?? original, "View image on original page")} />
        {caption(item.caption)}
      </figure>;
      case "PageBlockVideo":
      case "PageBlockAudio":
      case "PageBlockEmbed":
      case "PageBlockMap": return <figure>{link(safeHref(item.url, article.url) ?? original, item._ === "PageBlockVideo" ? "Watch video on original page" : item._ === "PageBlockAudio" ? "Listen on original page" : "Open content on original page")}{caption(item.caption)}</figure>;
      case "PageBlockRelatedArticles": return <section><h2>{text(item.title)}</h2><ul>{array(item.articles).map((entry, index) => {
        const related = object(entry);
        return <li key={index}>{link(safeHref(related.url, article.url), string(related.title) || string(related.url))}</li>;
      })}</ul></section>;
      case "PageBlockUnsupported": return <p>{link(original, "Read this section on the original page")}</p>;
      default: return item.text ? <p>{text(item.text)}</p> : <p>{link(original, "Read this section on the original page")}</p>;
    }
  }

  return <article className="instant-view-article" dir={article.rtl ? "rtl" : "ltr"} data-no-viewer>
    {!article.blocks.some(value => object(value)._ === "PageBlockTitle") && article.title && <h1>{article.title}</h1>}
    {blocks(article.blocks)}
    <footer className="iv-source">{link(original, `Read the original${article.siteName ? ` at ${article.siteName}` : " page"}`)}</footer>
  </article>;
}

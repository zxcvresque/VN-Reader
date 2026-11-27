import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon } from "@radix-ui/react-icons";
import type { MessageRecord } from "../types";
import { loadPreview, type LinkPreview } from "./LinkViewer";

function articleAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    parsed.username = ""; parsed.password = ""; parsed.hash = "";
    return parsed.href;
  } catch { return null; }
}

/** The title already written by the author is a better fallback than a URL slug. */
export function linkedArticleTitle(message: Pick<MessageRecord, "text" | "raw">, url: string | null): string | null {
  if (!url || !message.raw || typeof message.raw !== "object") return null;
  const entities = (message.raw as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    if (!entity || entity._ !== "MessageEntityTextUrl" || articleAddress(entity.url) !== articleAddress(url)) continue;
    const { offset, length } = entity;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > (message.text ?? "").length) continue;
    // Telegram and JavaScript both count UTF-16 code units, including emoji.
    const label = message.text.slice(offset, offset + length).replace(/\s+/g, " ").trim();
    if (label && !/^https?:\/\//i.test(label)) return label;
  }
  return null;
}

function derivedTitle(url: string | null): string {
  if (!url) return "Original article";
  const parsed = new URL(url), segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let slug = segment;
  try { slug = decodeURIComponent(segment); } catch { /* Keep malformed escapes readable. */ }
  const title = slug.replace(/\.(?:html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ").trim();
  return title && /\p{L}/u.test(title) ? title : parsed.hostname.replace(/^www\./, "");
}

export default function ArticleLinkPreview({ message, url, preview }: {
  message: MessageRecord;
  url: string | null;
  preview?: MessageRecord["media_preview"];
}) {
  const node = useRef<HTMLElement | null>(null), request = useRef<{ url: string; active: boolean } | null>(null);
  const [enriched, setEnriched] = useState<{ url: string; value: LinkPreview } | null>(null);
  const [brokenImage, setBrokenImage] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!url || request.current?.url === url) return;
    const current = { url, active: true };
    request.current = current;
    // Uses the same deduplicated request/cache as the hovercard, including IV.
    void loadPreview(url).then(value => {
      if (current.active && value.ok) setEnriched({ url, value });
    }).catch(() => { /* Saved metadata and the original link remain usable offline. */ });
  }, [url]);
  useEffect(() => {
    if (!url || !node.current) return;
    // Only visible fallback cards request metadata. A whole archive is never prefetched.
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "120px" }) : null;
    observer?.observe(node.current);
    return () => {
      observer?.disconnect();
      if (request.current?.url === url) { request.current.active = false; request.current = null; }
    };
  }, [url, load]);

  const fetched = enriched?.url === url ? enriched.value : null;
  const authorTitle = linkedArticleTitle(message, url);
  const hostname = url ? new URL(url).hostname.replace(/^www\./, "") : null;
  const fetchedTitle = fetched?.title?.trim();
  const title = (fetchedTitle && fetchedTitle !== hostname ? fetchedTitle : null) || preview?.title?.trim() || authorTitle;
  const description = fetched?.description?.trim() || preview?.description?.trim();
  const siteName = fetched?.siteName?.trim() || preview?.site_name?.trim() || hostname || "Article preview";
  const image = typeof fetched?.image === "string" && /^\/api\/instant-view-media\/[a-f0-9]{64}$/.test(fetched.image)
    ? fetched.image : articleAddress(fetched?.image);
  const visibleImage = image && brokenImage !== image ? image : null;
  return <aside ref={node} className={`reader-media reader-media-file reader-link-preview${visibleImage ? " has-thumbnail" : ""}`} aria-label="Article preview" onPointerEnter={load} onFocusCapture={load}>
    {visibleImage && <img className="reader-link-preview-image" src={visibleImage} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBrokenImage(visibleImage)} />}
    <div className="reader-link-preview-body">
      <div className="reader-link-preview-content">
        <p className="reader-link-preview-site">{siteName}</p>
        <strong className="reader-link-preview-title">{title || derivedTitle(url)}</strong>
        {description && <p className="reader-link-preview-description">{description}</p>}
        {!title && <p className="reader-link-preview-caption">{url ? "From the article link" : "Find the original link in this post."}</p>}
      </div>
      {url && <div className="reader-link-preview-actions"><a className="reader-inline-button reader-link-preview-open" href={url} target="_blank" rel="noopener noreferrer">{fetched?.instantView ? "Read Instant View" : fetched?.readerVersion ? "Read saved version" : "Open article"}<ExternalLinkIcon aria-hidden="true" /></a>
        {(fetched?.instantView || fetched?.readerVersion) && <a className="reader-inline-button reader-link-preview-open" data-no-viewer href={url} target="_blank" rel="noopener noreferrer">Open original<ExternalLinkIcon aria-hidden="true" /></a>}
      </div>}
    </div>
  </aside>;
}

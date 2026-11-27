import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cross2Icon, ExternalLinkIcon, CopyIcon, CheckIcon, GlobeIcon } from "@radix-ui/react-icons";
import InstantViewArticle, { type InstantViewDocument } from "./InstantViewArticle";

/** What the server learned about a link: its card details and whether it can be shown in a frame. */
export interface LinkPreview { url: string; finalUrl: string; host: string; title: string; description: string; image: string; siteName: string; icon: string; embed: string | null; ok: boolean; instantView?: boolean; readerVersion?: boolean }

function validArticle(value: unknown): value is InstantViewDocument {
  if (!value || typeof value !== "object") return false;
  const article = value as Partial<InstantViewDocument>;
  if (!Array.isArray(article.blocks) || article.blocks.length === 0 || typeof article.url !== "string") return false;
  try { return ["https:", "http:"].includes(new URL(article.url).protocol); } catch { return false; }
}

function savedArticleImage(article: InstantViewDocument): string {
  const cover = article.blocks.find(value => value && typeof value === "object" && (value as { _?: string })._ === "PageBlockCover") as { cover?: { photo_id?: unknown } } | undefined;
  const photos = article.photos ?? {};
  const coverPhoto = cover?.cover?.photo_id === undefined ? undefined : photos[String(cover.cover.photo_id)];
  for (const photo of [coverPhoto, ...Object.values(photos)]) {
    if (photo && typeof photo.url === "string" && /^\/api\/instant-view-media\/[a-f0-9]{64}$/.test(photo.url)) return photo.url;
  }
  return "";
}

function savedArticleDescription(article: InstantViewDocument): string {
  const plainText = (value: unknown, depth = 0): string => {
    if (depth > 20) return "";
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as { texts?: unknown[]; text?: unknown };
    return Array.isArray(item.texts) ? item.texts.map(part => plainText(part, depth + 1)).join("") : plainText(item.text, depth + 1);
  };
  const subtitle = article.blocks.find(value => value && typeof value === "object" && (value as { _?: string })._ === "PageBlockSubtitle") as { text?: unknown } | undefined;
  return plainText(subtitle?.text).replace(/\s+/g, " ").trim().slice(0, 500);
}

const cache = new Map<string, Promise<LinkPreview>>();
const articleCache = new Map<string, { expires: number; job: Promise<InstantViewDocument | null> }>();
/** Reads only the server's prefilled cache; opening a link never requests a Telegram fetch. */
export function loadInstantView(url: string): Promise<InstantViewDocument | null> {
  const cached = articleCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.job;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 1500);
  const entry = { expires: Date.now() + 60000, job: Promise.resolve<InstantViewDocument | null>(null) };
  entry.job = fetch(`/api/instant-view?url=${encodeURIComponent(url)}`, { credentials: "omit", signal: controller.signal })
    .then(async response => {
      if (!response.ok) return null;
      const value = await response.json();
      if (value.status === "ready" && (value.source === undefined || value.source === "telegram") && validArticle(value.article)) {
        entry.expires = Date.now() + 3600000;
        return value.article as InstantViewDocument;
      }
      return null;
    }).catch(() => null).finally(() => clearTimeout(timeout));
  articleCache.set(url, entry);
  if (articleCache.size > 300) articleCache.delete(articleCache.keys().next().value!);
  return entry.job;
}
const readerCache = new Map<string, { expires: number; job: Promise<InstantViewDocument | null> }>();
/** Reads only a prepared shared reader version; this GET never queues extraction. */
export function loadReaderVersion(url: string): Promise<InstantViewDocument | null> {
  const cached = readerCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.job;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 1500);
  const entry = { expires: Date.now() + 60000, job: Promise.resolve<InstantViewDocument | null>(null) };
  entry.job = fetch(`/api/reader-version?url=${encodeURIComponent(url)}`, { credentials: "omit", signal: controller.signal })
    .then(async response => {
      if (!response.ok) return null;
      const value = await response.json();
      if (value.status === "ready" && value.source === "reader" && validArticle(value.article)) {
        entry.expires = Date.now() + 3600000;
        return value.article as InstantViewDocument;
      }
      return null;
    }).catch(() => null).finally(() => clearTimeout(timeout));
  readerCache.set(url, entry);
  if (readerCache.size > 300) readerCache.delete(readerCache.keys().next().value!);
  return entry.job;
}

export async function loadSavedArticle(url: string): Promise<{ article: InstantViewDocument; source: "telegram" | "reader" } | null> {
  // Both endpoints only read prepared caches. Start together so an unavailable
  // IV cannot add a second timeout before a saved reader article is displayed.
  const [instantView, reader] = await Promise.all([loadInstantView(url), loadReaderVersion(url)]);
  if (instantView) return { article: instantView, source: "telegram" };
  return reader ? { article: reader, source: "reader" } : null;
}
const fallback = (url: string): LinkPreview => { const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })(); return { url, finalUrl: url, host, title: host, description: "", image: "", siteName: "", icon: "", embed: null, ok: false }; };
/** One request per link per session; hovering again or opening it reuses the answer. */
export function loadPreview(url: string): Promise<LinkPreview> {
  let job = cache.get(url);
  if (!job) {
    job = loadSavedArticle(url).then(saved => saved
      ? { ...fallback(url), finalUrl: saved.article.url, title: saved.article.title || fallback(url).title, siteName: saved.article.siteName || "", image: savedArticleImage(saved.article), description: savedArticleDescription(saved.article), ok: true, instantView: saved.source === "telegram", readerVersion: saved.source === "reader" }
      : fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { credentials: "omit" }).then(response => (response.ok ? response.json() as Promise<LinkPreview> : fallback(url))))
      .catch(() => fallback(url));
    cache.set(url, job);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return job;
}

/** External http(s) links only. Same-site links and anything marked data-no-viewer keep their normal behaviour. */
function viewerLink(target: EventTarget | null): HTMLAnchorElement | null {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download") || anchor.closest("[data-no-viewer], .link-viewer, .link-hovercard")) return null;
  try { const url = new URL(anchor.href); return /^https?:$/.test(url.protocol) && url.origin !== window.location.origin ? anchor : null; } catch { return null; }
}

const canHover = () => { try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch { return false; } };

function Favicon({ preview }: { preview: LinkPreview }) {
  const [broken, setBroken] = useState(false);
  return preview.icon && !broken ? <img className="link-favicon" src={preview.icon} alt="" width={16} height={16} referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <GlobeIcon className="link-favicon" aria-hidden="true" />;
}

function HoverCard({ preview, rect, onEnter, onLeave, onOpen }: { preview: LinkPreview | null; rect: DOMRect; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const width = Math.min(360, window.innerWidth - 24), below = rect.bottom + 8 + 300 < window.innerHeight || rect.top < 320;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  return <div className="link-hovercard" role="tooltip" style={{ left, width, ...(below ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }) }} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onOpen}>
    {!preview ? <div className="link-hovercard-loading" aria-label="Loading preview"><span /><span /><span /></div> : <>
      {preview.image && <img className="link-hovercard-image" src={preview.image} alt="" referrerPolicy="no-referrer" loading="eager" onError={event => { event.currentTarget.style.display = "none"; }} />}
      <div className="link-hovercard-body">
        <span className="link-hovercard-site"><Favicon preview={preview} />{preview.siteName || preview.host}</span>
        <strong>{preview.title}</strong>
        {preview.description && <p>{preview.description}</p>}
        <small>{preview.instantView ? "Read cached Telegram Instant View" : preview.readerVersion ? "Read saved reader version" : preview.embed ? "Open website preview" : "Open article summary"}</small>
      </div>
    </>}
  </div>;
}

function Viewer({ url, onClose }: { url: string; onClose: () => void }) {
  const [article, setArticle] = useState<InstantViewDocument | null>(null), [articleChecked, setArticleChecked] = useState(false);
  const [articleSource, setArticleSource] = useState<"telegram" | "reader" | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null>(null), [loaded, setLoaded] = useState(false), [slow, setSlow] = useState(false), [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { let live = true; setPreview(null); setLoaded(false); setSlow(false); void loadPreview(url).then(value => { if (live) setPreview(value); }); const timer = window.setTimeout(() => setSlow(true), 7000); return () => { live = false; window.clearTimeout(timer); }; }, [url]);
  useEffect(() => {
    let live = true; setArticle(null); setArticleChecked(false);
    void loadSavedArticle(url).then(saved => { if (live) { setArticle(saved?.article ?? null); setArticleSource(saved?.source ?? null); setArticleChecked(true); } });
    // A slow cache response must not prevent opening the existing preview.
    const timer = window.setTimeout(() => { if (live) setArticleChecked(true); }, 1800);
    return () => { live = false; window.clearTimeout(timer); };
  }, [url]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>(".link-viewer-close")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),iframe")].filter(item => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const target = article?.url ?? preview?.finalUrl ?? url;
  const copy = async () => { try { await navigator.clipboard.writeText(target); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ } };
  return <div className="link-viewer-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="link-viewer" ref={panel} role="dialog" aria-modal="true" aria-label={article?.title ?? (preview ? `Preview: ${preview.title}` : "Link preview")}>
      <header className="link-viewer-bar">
        <div className="link-viewer-title">{preview ? <Favicon preview={preview} /> : <GlobeIcon className="link-favicon" aria-hidden="true" />}<div><strong>{article?.title ?? preview?.title ?? "Opening…"}</strong><span>{articleSource === "telegram" ? "Telegram Instant View" : articleSource === "reader" ? "Saved reader version" : "Website preview"} · {preview?.host ?? (() => { try { return new URL(url).hostname; } catch { return url; } })()}</span></div></div>
        <div className="link-viewer-actions">
          <button type="button" className="link-viewer-btn is-icon" onClick={() => void copy()} aria-label="Copy link" title="Copy link">{copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}</button>
          <a className="link-viewer-btn" href={target} target="_blank" rel="noopener noreferrer" onClick={() => onClose()} aria-label="Open original page in a new tab"><ExternalLinkIcon aria-hidden="true" /><span>Open original</span></a>
          <button type="button" className="link-viewer-btn is-icon link-viewer-close" onClick={onClose} aria-label="Close preview" title="Close (Esc)"><Cross2Icon aria-hidden="true" /></button>
        </div>
      </header>
      {articleSource === "reader" && <p className="link-viewer-source-note">Saved reader version. Open the original for the publisher's full layout and media.</p>}
      <div className={`link-viewer-body${article ? " has-instant-view" : ""}`}>
        {article ? <InstantViewArticle article={article} />
          : !preview || !articleChecked ? <div className="link-viewer-wait" role="status"><span className="link-viewer-spinner" aria-hidden="true" />Loading the page…</div>
          : preview.embed ? <>
            {!loaded && <div className="link-viewer-wait" role="status"><span className="link-viewer-spinner" aria-hidden="true" />Loading {preview.host}…</div>}
            <iframe key={preview.embed} src={preview.embed} title={preview.title} className={loaded ? "is-loaded" : ""} onLoad={() => setLoaded(true)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation" allow="fullscreen; picture-in-picture; encrypted-media; clipboard-write" referrerPolicy="strict-origin-when-cross-origin" />
            {(slow || loaded) && <p className="link-viewer-hint">Page blank or not working here? <a href={target} target="_blank" rel="noopener noreferrer" onClick={() => onClose()}>Open it in a new tab</a>.</p>}
          </>
          : <article className="link-viewer-summary">
            {preview.image && <img src={preview.image} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = "none"; }} />}
            <div>
              <span className="link-hovercard-site"><Favicon preview={preview} />{preview.siteName || preview.host}</span>
              <h2>{preview.title}</h2>
              {preview.description && <p>{preview.description}</p>}
              <p className="link-viewer-note">{preview.ok ? "This is a website summary, not a saved Instant View article." : "This page couldn't be loaded for a preview."}</p>
              <a className="link-viewer-btn is-primary" href={target} target="_blank" rel="noopener noreferrer" onClick={() => onClose()}><ExternalLinkIcon aria-hidden="true" />Open in new tab</a>
            </div>
          </article>}
      </div>
    </div>
  </div>;
}

/**
 * Link previews for the reader. Hovering an outside link (mouse) shows a card;
 * clicking or tapping opens the page in a viewer. Ctrl/⌘/Shift/middle-click still open a new tab.
 */
export default function LinkViewer() {
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<{ url: string; rect: DOMRect; preview: LinkPreview | null } | null>(null);
  const timers = useRef<{ show?: number; hide?: number }>({}), hoverUrl = useRef<string | null>(null), pushed = useRef(false);

  const hideSoon = useCallback(() => { window.clearTimeout(timers.current.show); window.clearTimeout(timers.current.hide); timers.current.hide = window.setTimeout(() => { hoverUrl.current = null; setHover(null); }, 180); }, []);
  const keep = useCallback(() => window.clearTimeout(timers.current.hide), []);
  const close = useCallback(() => { setOpen(null); if (pushed.current) { pushed.current = false; window.history.back(); } }, []);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = viewerLink(event.target);
      if (!anchor) return;
      event.preventDefault();
      window.clearTimeout(timers.current.show); hoverUrl.current = null; setHover(null);
      // The phone's back button closes the viewer instead of leaving the reader.
      if (!pushed.current) { window.history.pushState({ ...(window.history.state ?? {}), vnLinkViewer: true }, ""); pushed.current = true; }
      setOpen(anchor.href);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !canHover()) return;
      const anchor = viewerLink(event.target);
      if (!anchor) return;
      window.clearTimeout(timers.current.hide);
      if (hoverUrl.current === anchor.href) return;
      window.clearTimeout(timers.current.show);
      const url = anchor.href;
      void loadPreview(url); // start early so the card and the viewer are instant
      timers.current.show = window.setTimeout(() => {
        hoverUrl.current = url;
        setHover({ url, rect: anchor.getBoundingClientRect(), preview: null });
        void loadPreview(url).then(preview => setHover(current => (current?.url === url ? { ...current, preview } : current)));
      }, 380);
    };
    const out = (event: PointerEvent) => { if (event.pointerType === "mouse" && viewerLink(event.target)) hideSoon(); };
    const touch = (event: TouchEvent) => { const anchor = viewerLink(event.target); if (anchor) void loadPreview(anchor.href); };
    const scroll = () => { if (hoverUrl.current) { hoverUrl.current = null; setHover(null); } };
    const popstate = () => { if (pushed.current) { pushed.current = false; setOpen(null); } };
    document.addEventListener("click", click);
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("touchstart", touch, { passive: true });
    window.addEventListener("scroll", scroll, { passive: true, capture: true });
    window.addEventListener("popstate", popstate);
    return () => { document.removeEventListener("click", click); document.removeEventListener("pointerover", over); document.removeEventListener("pointerout", out); document.removeEventListener("touchstart", touch); window.removeEventListener("scroll", scroll, { capture: true }); window.removeEventListener("popstate", popstate); };
  }, [hideSoon]);

  return createPortal(<>
    {hover && !open && <HoverCard preview={hover.preview} rect={hover.rect} onEnter={keep} onLeave={hideSoon} onOpen={() => { const url = hover.url; hoverUrl.current = null; setHover(null); if (!pushed.current) { window.history.pushState({ ...(window.history.state ?? {}), vnLinkViewer: true }, ""); pushed.current = true; } setOpen(url); }} />}
    {open && <Viewer key={open} url={open} onClose={close} />}
  </>, document.body);
}

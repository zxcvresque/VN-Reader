import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { MinusIcon, PlusIcon, Cross2Icon } from "@radix-ui/react-icons";
import { FIT_TRANSFORM, MAX_MEDIA_ZOOM, constrainMedia, fitMedia, zoomMediaAt, type MediaSize, type MediaTransform } from "../lib/mediaViewport";

export interface LightboxMedia { url: string; kind: string | null; caption?: string }
interface MediaLightboxProps { media: LightboxMedia | null; onClose: () => void }
type Point = { x: number; y: number };
interface Gesture { points: Point[]; transform: MediaTransform }
const midpoint = (points: Point[]): Point => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
const distance = (points: Point[]): number => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);

export default function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  const stage = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [natural, setNatural] = useState<MediaSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<MediaSize>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<MediaTransform>(FIT_TRANSFORM);
  const current = useRef<MediaTransform>(FIT_TRANSFORM);
  const [interacting, setInteracting] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const backdropDown = useRef(false);
  const isVideo = media?.kind === "video" || media?.kind === "animation";
  const isAudio = media?.kind === "audio" || media?.kind === "voice";
  const isImage = !!media && !isVideo && !isAudio;
  const fitted = fitMedia(natural, viewport);
  const geometry = useRef({ fitted, viewport });
  geometry.current = { fitted, viewport };

  const apply = (next: MediaTransform) => {
    const bounded = constrainMedia(next, geometry.current.fitted, geometry.current.viewport);
    current.current = bounded;
    setTransform(bounded);
  };
  const reset = () => { current.current = FIT_TRANSFORM; setTransform(FIT_TRANSFORM); };
  const zoom = (scale: number, point: Point = { x: 0, y: 0 }) => apply(zoomMediaAt(current.current, scale, point, geometry.current.fitted, geometry.current.viewport));
  const relativePoint = (clientX: number, clientY: number): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  useLayoutEffect(() => {
    if (!media) return;
    setNatural({ width: 0, height: 0 });
    reset(); pointers.current.clear(); gesture.current = null; moved.current = false; backdropDown.current = false; setInteracting(false);
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
      reset();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [media?.url]);

  useEffect(() => {
    if (!media) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === "Tab") {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), video[controls], audio[controls]") ?? []);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [media?.url]);

  useEffect(() => {
    const element = stage.current;
    if (!isImage || !element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoom(current.current.scale * Math.exp(-Math.max(-120, Math.min(120, pixels)) * .003), relativePoint(event.clientX, event.clientY));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [isImage, media?.url]);

  const beginGesture = () => { gesture.current = { points: Array.from(pointers.current.values()).slice(0, 2), transform: { ...current.current } }; };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isImage || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (!pointers.current.size) { moved.current = false; backdropDown.current = event.target === event.currentTarget; }
    pointers.current.set(event.pointerId, relativePoint(event.clientX, event.clientY));
    event.currentTarget.setPointerCapture(event.pointerId);
    setInteracting(true); beginGesture();
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, relativePoint(event.clientX, event.clientY));
    const points = Array.from(pointers.current.values()).slice(0, 2), start = gesture.current;
    if (points.length === 2 && start.points.length === 2) {
      moved.current = true;
      const origin = midpoint(start.points), center = midpoint(points);
      const scale = Math.max(1, Math.min(MAX_MEDIA_ZOOM, start.transform.scale * distance(points) / Math.max(1, distance(start.points))));
      const ratio = scale / start.transform.scale;
      apply({ scale, x: center.x - (origin.x - start.transform.x) * ratio, y: center.y - (origin.y - start.transform.y) * ratio });
    } else if (points.length === 1 && start.transform.scale > 1) {
      const dx = points[0].x - start.points[0].x, dy = points[0].y - start.points[0].y;
      if (Math.hypot(dx, dy) > 3) moved.current = true;
      apply({ scale: start.transform.scale, x: start.transform.x + dx, y: start.transform.y + dy });
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size) beginGesture();
    else { gesture.current = null; setInteracting(false); }
  };

  if (!media) return null;
  const caption = media.caption?.replace(/\s*·\s*\/api\/media\/\d+(?:\?.*)?$/, "");
  return createPortal(<div ref={dialog} className="lightbox-overlay" role="dialog" aria-modal="true" aria-label="Media viewer">
    <header className="lightbox-header">
      <span className="lightbox-title">{caption || (isVideo ? "Video" : isAudio ? "Audio" : "Photo")}</span>
      {isImage ? <div className="lightbox-zoom-controls" aria-label="Image zoom">
        <button type="button" aria-label="Zoom out" disabled={transform.scale <= 1} onClick={() => zoom(current.current.scale / 1.25)}><MinusIcon aria-hidden="true" /></button>
        <button type="button" className="lightbox-fit" aria-label="Fit image" onClick={reset}>{Math.round(transform.scale * 100)}% <span>Fit</span></button>
        <button type="button" aria-label="Zoom in" disabled={transform.scale >= MAX_MEDIA_ZOOM} onClick={() => zoom(current.current.scale * 1.25)}><PlusIcon aria-hidden="true" /></button>
      </div> : <span />}
      <button ref={closeButton} type="button" className="lightbox-close" onClick={onClose} aria-label="Close media viewer"><Cross2Icon aria-hidden="true" /></button>
    </header>
    <div ref={stage} className={`lightbox-stage ${isImage ? "lightbox-image-stage" : ""}`} data-zoomed={transform.scale > 1} data-interacting={interacting}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}
      onClick={event => { if (event.target === event.currentTarget && (!isImage || backdropDown.current) && !moved.current && transform.scale === 1) onClose(); }}>
      {isVideo ? <video className="lightbox-media" src={media.url} controls autoPlay /> : isAudio ? <audio className="lightbox-audio" src={media.url} controls autoPlay /> :
        <div className="lightbox-image-frame" style={{ width: fitted.width || "100%", height: fitted.height || "100%", transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}>
          <img className="lightbox-media" src={media.url} alt={caption || "Opened photo"} draggable={false} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        </div>}
    </div>
    <footer className="lightbox-footer">{isImage ? <><span className="lightbox-desktop-hint">Ctrl + scroll to zoom · drag to move</span><span className="lightbox-mobile-hint">Pinch to zoom · drag to move</span></> : <span>Use the playback controls below the media.</span>}</footer>
  </div>, document.body);
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewName } from "./CommandPalette";

interface TopBarProps {
  channelTitle: string;
  channelMeta: string;
  anchorLabel: string;
  progressPercent: number;
  view: ViewName;
  onSetView: (view: ViewName) => void;
  onOpenPalette: () => void;
}

const VIEWS: Array<{ key: ViewName; label: string }> = [
  { key: "read", label: "Read" },
  { key: "threads", label: "Threads" },
  { key: "graph", label: "Graph" },
  { key: "bookmarks", label: "Bookmarks" },
  { key: "progress", label: "Progress" }
];

const WIDTH_KEY = "vn-reader-reading-width";
const MIN_CH = 40;
const MAX_CH = 120;
const DEFAULT_CH = 68;

function getStoredWidth(): number {
  try {
    const v = localStorage.getItem(WIDTH_KEY);
    if (v) {
      const n = Number(v);
      if (n >= MIN_CH && n <= MAX_CH) return n;
    }
  } catch { /* noop */ }
  return DEFAULT_CH;
}

function WidthSlider() {
  const [width, setWidth] = useState(getStoredWidth);
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const applyWidth = useCallback((ch: number) => {
    document.documentElement.style.setProperty("--reading-width", `${ch}ch`);
    localStorage.setItem(WIDTH_KEY, String(ch));
  }, []);

  useEffect(() => {
    applyWidth(width);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setWidth(v);
    applyWidth(v);
    window.clearTimeout(hideTimer.current);
  };

  const handleToggle = () => {
    setOpen((o) => !o);
    window.clearTimeout(hideTimer.current);
  };

  const scheduleHide = () => {
    hideTimer.current = window.setTimeout(() => setOpen(false), 2500);
  };

  const cancelHide = () => {
    window.clearTimeout(hideTimer.current);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="width-slider-wrap" ref={containerRef}>
      <button
        type="button"
        className="btn-ghost width-slider-toggle"
        onClick={handleToggle}
        title="Adjust reading width"
        aria-label="Adjust reading width"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="8" x2="14" y2="8" />
          <line x1="4" y1="4" x2="4" y2="12" />
          <line x1="12" y1="4" x2="12" y2="12" />
        </svg>
      </button>
      {open && (
        <div
          className="width-slider-popover"
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <label className="width-slider-label">
            <span className="eyebrow">Width</span>
            <span className="width-slider-value">{width}ch</span>
          </label>
          <input
            type="range"
            min={MIN_CH}
            max={MAX_CH}
            step={2}
            value={width}
            onChange={handleChange}
            className="width-slider-range"
          />
          <div className="width-slider-preview" style={{ maxWidth: `${width}ch` }} />
        </div>
      )}
    </div>
  );
}

export default function TopBar({
  channelTitle,
  channelMeta,
  anchorLabel,
  progressPercent,
  view,
  onSetView,
  onOpenPalette
}: TopBarProps) {
  const [compact, setCompact] = useState(view === "graph");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (view === "graph") {
      setCompact(true);
      return undefined;
    }
    const onReaderScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ top?: number }>).detail;
      setCompact((detail?.top ?? 0) > 36);
    };
    const onWindowScroll = () => setCompact(window.scrollY > 36);
    window.addEventListener("vn-reader-scroll", onReaderScroll);
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    onWindowScroll();
    return () => {
      window.removeEventListener("vn-reader-scroll", onReaderScroll);
      window.removeEventListener("scroll", onWindowScroll);
    };
  }, [view]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [view]);

  return (
      <header
        className={[
          "top-bar",
          compact ? "is-compact" : "is-expanded",
          mobileNavOpen ? "is-mobile-open" : ""
        ].join(" ")}
      >
        <div className="top-bar-channel" title={channelTitle}>
          <span className="top-bar-mark" aria-hidden="true">V</span>
          <span className="top-bar-channel-copy">
          <span className="top-bar-channel-name">{channelTitle}</span>
          <span className="top-bar-channel-meta">{channelMeta}</span>
          </span>
        </div>

        <nav className="view-switch" aria-label="Views">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={view === item.key ? "active" : ""}
              onClick={() => onSetView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="top-bar-progress" aria-hidden>
          <div
            className="top-bar-progress-fill"
            style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
          />
        </div>

        <span className="top-bar-anchor">{anchorLabel}</span>

        <div className="top-bar-actions">
          <WidthSlider />
          <button type="button" className="kbd-hint" onClick={onOpenPalette}>
            <span className="kbd">⌘</span>
              <span className="kbd">K</span>
          </button>
          <button
            type="button"
            className="btn-ghost top-bar-menu"
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? "×" : "≡"}
          </button>
        </div>
      </header>
  );
}

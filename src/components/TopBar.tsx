import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ViewName } from "./CommandPalette";

interface TopBarProps {
  channelTitle: string;
  channelMeta: string;
  anchorLabel: string;
  progressPercent: number;
  view: ViewName;
  onSetView: (view: ViewName) => void;
  onOpenPalette: () => void;
  onOpenSettings?: () => void;
  onOpenGuide?: () => void;
  onOpenAccount?: () => void;
  accountLabel?: string;
  paletteOpen?: boolean;
  settingsOpen?: boolean;
  guideOpen?: boolean;
  accountOpen?: boolean;
  onToggleFocus?: () => void;
  focusMode?: boolean;
}

const VIEWS: Array<{ key: ViewName; label: string; path: string }> = [
  { key: "read", label: "Read", path: "M3 4.5c3-1 5-.5 7 1 2-1.5 4-2 7-1V16c-3-1-5-.5-7 1-2-1.5-4-2-7-1V4.5ZM10 5.5V17" },
  { key: "threads", label: "Threads", path: "M5 3v9a3 3 0 0 0 3 3h7M5 6h10M13 4l2 2-2 2m0 5 2 2-2 2" },
  { key: "bookmarks", label: "Bookmarks", path: "M5 3h10v14l-5-3-5 3V3Z" },
  { key: "progress", label: "Progress", path: "M4 16V10m6 6V4m6 12V7M2 18h16" }
];

function NavIcon({ path }: { path: string }) {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export default function TopBar({ channelTitle, channelMeta, anchorLabel, progressPercent, view, onSetView, onOpenPalette, onOpenSettings, onOpenGuide, onOpenAccount, accountLabel, paletteOpen = false, settingsOpen = false, guideOpen = false, accountOpen = false, onToggleFocus, focusMode = false }: TopBarProps) {
  const [compact, setCompact] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const shell = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const progress = Math.min(100, Math.max(0, progressPercent));

  useEffect(() => {
    let readerTop = 0;
    const update = () => {
      const top = Math.max(window.scrollY, readerTop);
      // A small dead zone keeps the dock steady around the scroll threshold.
      setCompact(previous => previous ? top > 12 : top > 48);
    };
    const onReaderScroll = (event: Event) => {
      readerTop = (event as CustomEvent<{ top?: number }>).detail?.top ?? 0;
      update();
    };
    window.addEventListener("vn-reader-scroll", onReaderScroll);
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      window.removeEventListener("vn-reader-scroll", onReaderScroll);
      window.removeEventListener("scroll", update);
    };
  }, [view]);

  useEffect(() => { setMobileNavOpen(false); }, [view, focusMode]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    shell.current?.querySelector<HTMLButtonElement>('.view-switch [aria-current="page"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!shell.current?.contains(event.target as Node)) setMobileNavOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        menuButton.current?.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!shell.current?.contains(event.target as Node)) setMobileNavOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [mobileNavOpen]);

  return <header ref={shell} className={`top-bar ${compact ? "is-compact" : "is-expanded"} ${mobileNavOpen ? "is-mobile-open" : ""}`}>
    <div className="top-bar-channel" title={channelTitle}>
      <span className="top-bar-mark" aria-hidden="true">vn<span /></span>
      <span className="top-bar-channel-copy">
        <span className="top-bar-channel-name">{channelTitle}</span>
        <span className="top-bar-channel-meta">{channelMeta}</span>
      </span>
    </div>

    <nav id="reader-view-navigation" data-tour="navigation" className="view-switch" aria-label="Views" style={{ "--active-view": VIEWS.findIndex(item => item.key === view) } as CSSProperties}>
      <span className="view-switch-indicator" aria-hidden="true" />
      {VIEWS.map(item => <button key={item.key} type="button" data-tour={`view-${item.key}`} className={view === item.key ? "active" : ""} aria-label={item.key === "bookmarks" ? "Bookmarks" : item.label} aria-current={view === item.key ? "page" : undefined} onClick={() => { onSetView(item.key); if (mobileNavOpen) menuButton.current?.focus(); setMobileNavOpen(false); }}>
        <NavIcon path={item.path} /><span>{item.label}</span>
      </button>)}
    </nav>

    <div className="top-bar-position" title={`Reading position: ${anchorLabel}`}>
      <svg className="top-bar-progress" width="30" height="30" viewBox="0 0 32 32" role="progressbar" aria-label="Archive reading position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
        <circle className="top-bar-progress-track" cx="16" cy="16" r="12" />
        <circle className="top-bar-progress-fill" cx="16" cy="16" r="12" pathLength="100" strokeDasharray={`${progress} 100`} />
        <circle className="top-bar-progress-dot" cx="16" cy="16" r="2.5" />
      </svg>
      <span className="top-bar-anchor">{anchorLabel}</span>
    </div>

    <div className="top-bar-actions">
      <button type="button" data-tour="search" className="top-bar-search nav-action" aria-haspopup="dialog" aria-expanded={paletteOpen} onClick={onOpenPalette} aria-label="Search and commands" data-tooltip="Search · ⌘K">
        <NavIcon path="M14 14l4 4M15.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" /><kbd>⌘ K</kbd>
      </button>
      {onToggleFocus && <button type="button" data-tour="focus" className="nav-action top-bar-focus" aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"} aria-pressed={focusMode} onClick={onToggleFocus} data-tooltip={focusMode ? "Exit focus" : "Focus mode"}>
        <NavIcon path="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4M7 8h6M7 12h6" />
      </button>}
      {onOpenSettings && <button type="button" data-tour="settings" className="nav-action top-bar-settings" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={onOpenSettings} aria-label="Open reader settings" data-tooltip="Appearance & settings">
        <NavIcon path="M4 3v3m0 4v7M10 3v7m0 4v3M16 3v2m0 4v8M2 6h4v4H2V6Zm6 4h4v4H8v-4Zm6-5h4v4h-4V5Z" />
      </button>}
      {onOpenGuide && <button type="button" data-tour="help" className="nav-action top-bar-guide" aria-haspopup="dialog" aria-expanded={guideOpen} onClick={onOpenGuide} aria-label="Help and page tours" data-tooltip="Help & page tours">
        <NavIcon path="M7.5 7a2.5 2.5 0 1 1 4 2c-1 .65-1.5 1.15-1.5 2M10 14h.01M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
      </button>}
      {onOpenAccount && <button type="button" data-tour="account-controls" className="nav-action top-bar-account" aria-haspopup="dialog" aria-expanded={accountOpen} onClick={onOpenAccount} aria-label={accountLabel??"Reading account"} data-tooltip={accountLabel??"Reading account"}><NavIcon path="M14 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 18v-2a7 7 0 0 1 14 0v2" /></button>}
      <button ref={menuButton} type="button" className="nav-action top-bar-menu" aria-label="Toggle navigation" aria-controls="reader-view-navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(open => !open)}>
        <NavIcon path={mobileNavOpen ? "M5 5l10 10M15 5 5 15" : "M3 6h14M3 14h14"} />
      </button>
    </div>
  </header>;
}

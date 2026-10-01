import { useEffect, useRef, useState } from "react";
import { THEMES, type ThemeId } from "../lib/preferences";
import type { ArchiveManifest, MessageRecord } from "../types";
import SignupCapacity from "./SignupCapacity";
import type { SignupCapacity as Capacity } from "../lib/admin";
import TelegramRichText from "./TelegramRichText";
import BrandLogo from "./BrandLogo";
import "./welcome.css";

export const WELCOME_SLIDES = [
  { title: "Pick up exactly where you left off.", description: "Long posts deserve an unhurried read. VN Reader remembers your paragraph and position, so coming back feels familiar.", features: ["Resume your exact place, even inside a long post.", "Keep ‘seen’ separate from ‘finished’, ‘in progress’, and ‘revisit’.", "Set a session boundary by post count, reading time, or date."], tip: "In Read, choose Resume your place. Use the reading-state menu when you finish a post.", label: "Read & resume" },
  { title: "Keep the context close.", description: "Understand a post through the conversation around it, without losing the sentence you started with.", features: ["Peek at a quoted source without leaving your current post.", "Search in a side panel and return to your original passage.", "Read around a result, explore reply threads, and retrace your reading trail."], tip: "Open a quoted source, or choose Read around this from a post’s More actions menu.", label: "Context & search" },
  { title: "Turn reading into your own library.", description: "Save what matters, write in your own words, and build a collection around the questions you are following.", features: ["Bookmark posts, save selected passages, and add personal notes.", "Keep a separate read-later queue with your chosen order.", "Create named collections with introductions, then search your own work."], tip: "Select a passage to save it. Open My library to find notes, collections, and your queue.", label: "Notes & collections" },
  { title: "See how the archive unfolds.", description: "The Progress timeline maps Vidurneeti’s posts over time, with distinct colors for different kinds of content.", features: ["Explore the entire archive, a year, six or three months, a month, or any week.", "Preview text, images, videos, GIFs, polls, and links before opening a post.", "Pinch to zoom on mobile. Use Ctrl + scroll to zoom and drag to pan on desktop."], tip: "On mobile, tap a point for its preview. Only Read this post takes you into the archive.", label: "Timeline & progress" },
  { title: "Make room for your attention.", description: "Choose an appearance that feels comfortable, then shape the reading space around you.", features: ["Switch themes, fonts, line spacing, column width, and warm or sepia paper.", "Place the floating navigation at the top, bottom, left, or right.", "Use focus mode, compact or expanded media, playback memory, and guided page tours."], tip: "Open Settings to save reading presets. The Help button offers tours of the actual controls.", label: "Comfort & control" },
  { title: "Your reading, your choice.", description: "Start as a guest or sign in with email and password. Both ways let you make the archive your own.", features: ["Guest progress, bookmarks, notes, and preferences are saved in this browser.", "Export a reading backup in Settings and restore it whenever you need it.", "A verified account syncs progress, notes, collections, history, and preferences across devices signed into that account."], tip: "Guest data stays separate when you sign in. You can choose to bring it into your account from the account panel.", label: "Guest & account" }
] as const;

export function FeatureWalkthrough({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const touchStart = useRef<number | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === "ArrowRight") { event.preventDefault(); setIndex(i => Math.min(WELCOME_SLIDES.length - 1, i + 1)); }
      if (event.key === "ArrowLeft") { event.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
      if (event.key === "Tab") {
        const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, []);
  const slide = WELCOME_SLIDES[index];
  return <div className="welcome-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="welcome-walkthrough" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="welcome-slide-title">
      <header><span>Why VN Reader?</span><button type="button" onClick={onClose} aria-label="Close feature walkthrough">Close</button></header>
      <div className="welcome-slide" key={index} aria-live="polite" onTouchStart={e => { touchStart.current = e.touches[0]?.clientX ?? null; }} onTouchEnd={e => {
        const start = touchStart.current; touchStart.current = null;
        if (start === null || !e.changedTouches[0]) return;
        const delta = e.changedTouches[0].clientX - start;
        if (Math.abs(delta) > 60) setIndex(i => Math.max(0, Math.min(WELCOME_SLIDES.length - 1, i + (delta < 0 ? 1 : -1))));
      }}>
        <p className="welcome-slide-category">{slide.label}</p>
        <h2 id="welcome-slide-title">{slide.title}</h2>
        <p className="welcome-slide-intro">{slide.description}</p>
        <ul>{slide.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
        <p className="welcome-slide-tip"><strong>Try it in the reader</strong>{slide.tip}</p>
      </div>
      <nav className="welcome-slide-nav" aria-label="Feature slides">
        <button type="button" onClick={() => setIndex(i => Math.max(0, i - 1))} disabled={index === 0}>Previous</button>
        <span aria-label={`Slide ${index + 1} of ${WELCOME_SLIDES.length}`}>{index + 1} / {WELCOME_SLIDES.length}</span>
        {index < WELCOME_SLIDES.length - 1 ? <button type="button" className="welcome-primary" onClick={() => setIndex(i => i + 1)}>Next</button> : <button type="button" className="welcome-primary" onClick={onClose}>Got it</button>}
      </nav>
      <div className="welcome-slide-tabs" role="group" aria-label="Choose a feature slide">{WELCOME_SLIDES.map((s, i) => <button key={s.label} type="button" aria-label={s.label} aria-pressed={i === index} onClick={() => setIndex(i)} />)}</div>
    </div>
  </div>;
}

export interface WelcomePageProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  onGuest: () => void;
  onSignIn: () => void;
  onSignUp?: () => void;
  capacity?: Capacity | null;
  capacityError?: string;
  onRefreshCapacity?: () => void;
  messages: MessageRecord[];
  manifest: ArchiveManifest | null;
}

export default function WelcomePage({ theme, onThemeChange, onGuest, onSignIn, onSignUp, capacity=null, capacityError, onRefreshCapacity=()=>{}, messages, manifest }: WelcomePageProps) {
  const [learnMore, setLearnMore] = useState(false);
  // A real archive passage, not invented marketing copy or a simulated reader.
  const preview = messages.find(m => m.text.length > 240 && !/rules|guidelines/i.test(m.text.slice(0, 100)));
  const cleanText = preview?.text.replace(/\s+/g, " ").trim();
  const excerpt = cleanText && cleanText.length > 230 ? `${cleanText.slice(0, 230).replace(/\s+\S*$/, "")}…` : cleanText;
  const range = manifest?.range;
  const year = (date: string | null | undefined) => date ? new Date(date).getFullYear() : null;
  return <div className="welcome-page">
    <div className="welcome-wrap">
      <header className="welcome-header"><div className="welcome-brand"><span className="welcome-mark" aria-hidden="true"><BrandLogo /></span><span>VN</span></div><span className="welcome-for">For readers of Vidurneeti</span></header>
      <main>
        <section className="welcome-hero" aria-labelledby="welcome-title">
          <div className="welcome-copy"><h1 id="welcome-title">Read Vidurneeti.<br />At your own pace.</h1><p>A dedicated reader for Vidurneeti’s posts. Follow the context, save what matters, and always find your way back.</p>
            <div className="welcome-entry-actions"><button type="button" className="welcome-primary" aria-describedby="welcome-guest-storage" onClick={onGuest}>Continue as guest <span aria-hidden="true">→</span></button><button type="button" className="welcome-signin" aria-describedby="welcome-account-storage" onClick={onSignUp??onSignIn} disabled={capacity?.configured===false||capacity?.remaining===0}>Create an account</button><button type="button" className="welcome-signin welcome-login" aria-describedby="welcome-account-storage" onClick={onSignIn}>Sign in</button></div>
            <SignupCapacity capacity={capacity} error={capacityError} onRetry={onRefreshCapacity}/>
            <p className="welcome-entry-note">Guest reading stays in this browser and can be exported. Sign in to sync across devices.</p>
          </div>
          <aside className="welcome-archive" aria-label="A passage from the Vidurneeti archive">
            <div className="welcome-archive-heading"><span>From the archive</span><span>{preview ? `Post #${preview.message_id}` : "Vidurneeti"}</span></div>
            {excerpt ? <blockquote><TelegramRichText text={excerpt} entities={[]} /></blockquote> : <div className="welcome-archive-empty"><p>Understand the post.<br />Follow the thread.<br />Keep the thought.</p><span>The archive opens when you enter the reader.</span></div>}
            <div className="welcome-archive-footer">{preview?.date_utc ? <time dateTime={preview.date_utc}>{new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(preview.date_utc))}</time> : <span>Text, media, replies, and sources</span>}<span>Vidurneeti</span></div>
          </aside>
        </section>
        <section className="welcome-storage" aria-label="Choose how your reading is saved">
          <div><h2>Just this browser</h2><p id="welcome-guest-storage">As a guest, your progress, bookmarks, notes, and preferences stay in this browser. Export a backup from Settings to keep a copy or move your reading.</p></div>
          <div><h2>Across your devices</h2><p id="welcome-account-storage">Sign in with email and password to sync your profile’s reading progress, saved history, and personal library on every device using the same account.</p></div>
        </section>
        <section className="welcome-appearance" aria-labelledby="welcome-appearance-title"><div><h2 id="welcome-appearance-title">Set the mood.</h2><p>Choose your theme. More reading controls await inside.</p></div>
          <div className="welcome-themes" role="group" aria-label="Welcome page theme">{THEMES.map(t => <button type="button" key={t.id} className="welcome-theme" aria-pressed={theme === t.id} onClick={() => onThemeChange(t.id)} title={t.description}><span className="welcome-theme-swatch" aria-hidden="true" style={{ background: t.colors[0], color: t.colors[1], borderColor: t.colors[2] }}>Aa</span><span>{t.name}</span></button>)}</div>
        </section>
      </main>
      <footer className="welcome-footer"><button type="button" onClick={() => setLearnMore(true)}>Learn more <span aria-hidden="true">↗</span></button><span>{messages.length ? `${messages.length.toLocaleString()} posts${year(range?.first_message_date_utc) ? `, ${year(range?.first_message_date_utc)}-${year(range?.last_message_date_utc)}` : ""}` : "Your place to read Vidurneeti"}</span></footer>
    </div>
    {learnMore ? <FeatureWalkthrough onClose={() => setLearnMore(false)} /> : null}
  </div>;
}

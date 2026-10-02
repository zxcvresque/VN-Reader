import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { THEMES, type ThemeId } from "../lib/preferences";
import type { ArchiveManifest, MessageRecord } from "../types";
import SignupCapacity from "./SignupCapacity";
import type { SignupCapacity as Capacity } from "../lib/admin";
import TelegramRichText from "./TelegramRichText";
import BrandLogo from "./BrandLogo";
import { ArrowRightIcon, QuestionMarkCircledIcon, BookmarkIcon, ReaderIcon, MoonIcon, SunIcon, ChevronDownIcon, CheckIcon, EnterIcon } from "@radix-ui/react-icons";
import "./welcome.css";

export const WELCOME_SLIDES = [
  { title: "Read for understanding, not just updates.", description: "vn reader makes Vidurneeti’s archive a calm place to follow ideas in context. Less jumping between posts. More room to read, reflect, and return.", features: ["Follow a conversation rather than an isolated post.", "Keep your thoughts beside the words that prompted them.", "Choose your own pace, with your place remembered."], tip: "Start as a guest. You can explore the tools gradually and replay every tour from Help.", label: "Why vn reader" },
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

export default function WelcomePage({ theme, onThemeChange, onGuest, onSignIn, onSignUp, capacity=null, capacityError, onRefreshCapacity=()=>{}, messages }: WelcomePageProps) {
  const [learnMore, setLearnMore] = useState(false);
  const [themeOpen,setThemeOpen]=useState(false);
  const themePicker=useRef<HTMLDivElement>(null);
  const themeTrigger=useRef<HTMLButtonElement>(null);
  const activeTheme=THEMES.find(t=>t.id===theme)??THEMES[0];
  const tiltPages = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse" || !window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    event.currentTarget.style.setProperty("--stack-tilt-x", `${-y * 3}deg`);
    event.currentTarget.style.setProperty("--stack-tilt-y", `${x * 4}deg`);
  };
  const resetPages = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.style.removeProperty("--stack-tilt-x");
    event.currentTarget.style.removeProperty("--stack-tilt-y");
  };
  useEffect(()=>{if(!themeOpen)return;const outside=(e:PointerEvent)=>{if(!themePicker.current?.contains(e.target as Node))setThemeOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){setThemeOpen(false);themeTrigger.current?.focus();}};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);};},[themeOpen]);
  // A real archive passage, not invented marketing copy or a simulated reader.
  const preview = messages.find(m => m.text.length > 240 && !/rules|guidelines/i.test(m.text.slice(0, 100)));
  const cleanText = preview?.text.replace(/\s+/g, " ").trim();
  const excerpt = cleanText && cleanText.length > 130 ? `${cleanText.slice(0, 130).replace(/\s+\S*$/, "")}…` : cleanText;
  return <div className="welcome-page">
    <div className="welcome-wrap">
      <header className="welcome-header"><div className="welcome-header-brand"><div className="welcome-brand" aria-label="vn reader"><BrandLogo width={48}/></div><button type="button" className="welcome-why" onClick={()=>setLearnMore(true)}><QuestionMarkCircledIcon aria-hidden="true"/><span>Why vn reader</span></button></div><div className="welcome-header-actions"><div className="welcome-theme-picker" ref={themePicker}><button ref={themeTrigger} type="button" className="welcome-theme-trigger" aria-label={`Change theme: ${activeTheme.name}`} aria-haspopup="listbox" aria-expanded={themeOpen} aria-controls="welcome-theme-options" onClick={()=>setThemeOpen(v=>!v)}>{["vercel","editorial"].includes(theme)?<MoonIcon aria-hidden="true"/>:<SunIcon aria-hidden="true"/>}<span>{activeTheme.name}</span><ChevronDownIcon aria-hidden="true"/></button>{themeOpen&&<div id="welcome-theme-options" className="welcome-theme-options" role="listbox" aria-label="Welcome page theme"><span className="welcome-theme-heading">Appearance</span>{THEMES.map(t=><button key={t.id} type="button" role="option" aria-selected={theme===t.id} onClick={()=>{onThemeChange(t.id);setThemeOpen(false);themeTrigger.current?.focus();}}><span className="welcome-theme-colors" aria-hidden="true">{t.colors.map(c=><i key={c} style={{background:c}}/>)}</span><span>{t.name}</span>{theme===t.id&&<CheckIcon aria-hidden="true"/>}</button>)}</div>}</div><button type="button" className="welcome-header-signin" onClick={onSignIn}><EnterIcon aria-hidden="true"/><span>Sign in</span></button></div></header>
      <main>
        <section className="welcome-hero" aria-labelledby="welcome-title">
          <div className="welcome-copy"><span className="welcome-product-name">vn reader</span><h1 id="welcome-title">A quieter way to<br />read Vidurneeti.</h1><p>The posts, their context, and a place for your thoughts.<br className="welcome-desktop-break"/> Pick up exactly where you left off.</p>
            <div className="welcome-entry-actions"><button type="button" className="welcome-primary" aria-describedby="welcome-guest-storage" onClick={onGuest}>Read as guest <ArrowRightIcon aria-hidden="true"/></button><button type="button" className="welcome-signin" aria-describedby="welcome-account-storage" onClick={onSignUp??onSignIn} disabled={capacity?.configured===false||capacity?.remaining===0}>Create an account</button></div>
            <SignupCapacity compact capacity={capacity} error={capacityError} onRetry={onRefreshCapacity}/>
          </div>
          <aside className="welcome-pages" aria-label="Read, save and return" onPointerMove={tiltPages} onPointerLeave={resetPages} onPointerCancel={resetPages}><div className="welcome-page-leaf welcome-leaf-context"><ReaderIcon aria-hidden="true"/><span>Follow the<br/>conversation.</span><i/><i/><i/></div><div className="welcome-page-leaf welcome-leaf-reading"><span className="welcome-leaf-label">From the archive</span>{excerpt ? <div className="welcome-leaf-text"><TelegramRichText text={excerpt} entities={[]}/></div> : <p>Read a little.<br/>Think a little.<br/>Come back.</p>}<span className="welcome-leaf-bottom">Your place, remembered.</span></div><div className="welcome-page-leaf welcome-leaf-save"><BookmarkIcon aria-hidden="true"/><span>Keep what<br/>stays with you.</span><i/><i/><i/></div></aside>
        </section>
        <section className="welcome-storage" aria-label="Choose how your reading is saved">
          <p id="welcome-guest-storage">Guests save in this browser and can export a backup.</p>
          <p id="welcome-account-storage">An account keeps your progress and library in sync across devices.</p>
        </section>
      </main>
      <footer className="welcome-footer"><span>{messages.length ? `${messages.length.toLocaleString()} posts, one place to read.` : "A dedicated reader for Vidurneeti."}</span></footer>
    </div>
    {learnMore ? <FeatureWalkthrough onClose={() => setLearnMore(false)} /> : null}
  </div>;
}

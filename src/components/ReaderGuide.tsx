import { useEffect, useId, useRef, useState } from "react";
import { GUIDE_TOPICS, HELP_SECTIONS, THEME_GUIDE, TOUR_STEPS, type GuideTopic, type TourStep } from "../lib/tours";

interface ReaderGuideProps {
  topic: GuideTopic | null;
  onSelectTopic: (topic: GuideTopic) => void;
  onClose: () => void;
  onStepChange: (step: TourStep | null) => void;
  hasArchive?: boolean;
  onLearnMore?: () => void;
}

interface TargetRect { top: number; left: number; width: number; height: number }
const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';

function visibleTarget(selector: string): Element | null {
  const candidates = [...document.querySelectorAll(selector)];
  return candidates.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }) ?? null;
}

export default function ReaderGuide({ topic, onSelectTopic, onClose, onStepChange, hasArchive = true, onLearnMore }: ReaderGuideProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onStepChange });
  callbacks.current = { onClose, onStepChange };
  const [progress, setProgress] = useState<{ topic: GuideTopic | null; index: number }>({ topic, index: 0 });
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [cardHeight, setCardHeight] = useState(360);
  const headingId = useId();
  const bodyId = useId();
  const index = progress.topic === topic ? progress.index : 0;
  const steps = topic ? TOUR_STEPS[topic] : [];
  const step = steps[index] ?? null;
  const topicInfo = GUIDE_TOPICS.find((item) => item.id === topic);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); callbacks.current.onClose(); return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter((item) => item.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => { callbacks.current.onStepChange(step); }, [step]);
  useEffect(() => () => { callbacks.current.onStepChange(null); }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (topic) dialog.current?.querySelector<HTMLButtonElement>("[data-guide-next]")?.focus();
      else dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [topic, index]);

  useEffect(() => {
    if (!step) { setRect(null); return; }
    let pending = 0;
    let watched: Element | null = null;
    const resizeObserver = new ResizeObserver(() => schedule());
    const measure = () => {
      pending = 0;
      setViewport((current) => current.width === window.innerWidth && current.height === window.innerHeight ? current : { width: window.innerWidth, height: window.innerHeight });
      const element = visibleTarget(step.target);
      if (watched !== element) {
        resizeObserver.disconnect(); watched = element;
        if (element) resizeObserver.observe(element);
      }
      const bounds = element?.getBoundingClientRect();
      const next = bounds ? {
        top: Math.max(8, bounds.top - 6), left: Math.max(8, bounds.left - 6),
        width: Math.max(0, Math.min(window.innerWidth - 8, bounds.right + 6) - Math.max(8, bounds.left - 6)),
        height: Math.max(0, Math.min(window.innerHeight - 8, bounds.bottom + 6) - Math.max(8, bounds.top - 6))
      } : null;
      setRect((current) => current?.top === next?.top && current?.left === next?.left && current?.width === next?.width && current?.height === next?.height ? current : next);
    };
    function schedule() { if (!pending) pending = requestAnimationFrame(measure); }
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-tour", "open"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(pending); resizeObserver.disconnect(); mutationObserver.disconnect();
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true);
    };
  }, [step]);

  useEffect(() => {
    if (!topic || !dialog.current) return;
    const observer = new ResizeObserver(([entry]) => setCardHeight(entry.target.getBoundingClientRect().height));
    observer.observe(dialog.current);
    return () => observer.disconnect();
  }, [topic]);

  const width = Math.min(432, viewport.width - 32);
  const height = Math.min(cardHeight, viewport.height - 32);
  let left = (viewport.width - width) / 2;
  let top = Math.max(16, (viewport.height - height) / 2);
  if (step && rect) {
    if (viewport.width < 1000) { left = (viewport.width - width) / 2; top = rect.top > viewport.height - height - 40 ? 16 : Math.max(16, viewport.height - height - 16); }
    else if (rect.left + rect.width + width + 32 <= viewport.width) { left = rect.left + rect.width + 16; top = rect.top; }
    else if (rect.left - width - 16 >= 16) { left = rect.left - width - 16; top = rect.top; }
    else if (rect.top + rect.height + height + 32 <= viewport.height) { top = rect.top + rect.height + 16; }
    else if (rect.top - height - 16 >= 16) { top = rect.top - height - 16; }
    else { left = viewport.width - width - 20; top = viewport.height - height - 20; }
  }
  top = Math.max(16, Math.min(top, viewport.height - height - 16));

  const move = (next: number) => setProgress({ topic, index: Math.max(0, Math.min(next, steps.length - 1)) });

  if (step && topicInfo) return <div className="guide-tour-overlay">
    {rect && <div className="guide-spotlight" style={{ position: "fixed", ...rect, pointerEvents: "none" }} aria-hidden="true" />}
    <div className="guide-tour-card" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={bodyId} tabIndex={-1} style={{ position: "fixed", width, left, top, maxHeight: "calc(100dvh - 32px)", overflowY: "auto" }}>
      <header className="guide-tour-header"><span className="guide-tour-topic">{topicInfo.title}</span><button type="button" className="btn-ghost guide-close" onClick={onClose} aria-label="Close tour">×</button></header>
      <div className="guide-step-count">Step {index + 1} of {steps.length}</div>
      <div className="guide-tour-progress" role="progressbar" aria-label="Tour progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={index + 1}><span style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
      <div className="guide-tour-body" aria-live="polite" aria-atomic="true"><h2 id={headingId}>{step.title}</h2><p id={bodyId}>{step.body}</p>{step.tip && <p className="guide-tour-tip">{step.tip}</p>}</div>
      {!rect && <p className="guide-target-note">This control appears when the matching page or post context is available.</p>}
      <footer className="guide-tour-footer"><button type="button" className="btn-ghost guide-tour-dismiss" onClick={onClose}>End tour</button><div className="guide-tour-buttons"><button type="button" className="btn-ghost" onClick={() => move(index - 1)} disabled={index === 0}>Back</button><button type="button" className="btn-primary" data-guide-next onClick={() => index === steps.length - 1 ? onClose() : move(index + 1)}>{index === steps.length - 1 ? "Finish tour" : step.actionLabel ?? "Next"}<span aria-hidden="true"> →</span></button></div></footer>
    </div>
  </div>;

  return <div className="guide-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="reader-guide" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={bodyId} tabIndex={-1}>
      <header className="guide-header"><div><p className="eyebrow">A reader's companion</p><h2 id={headingId}>A little guidance, a better read.</h2><p id={bodyId} className="guide-intro">Follow a tour of the actual controls, or keep this guide close as a reference. Every tour works with every theme and navigation position.</p></div><button type="button" className="btn-ghost guide-close" onClick={onClose} aria-label="Close reader guide">×</button></header>
      {onLearnMore && <div className="guide-feature-intro"><button type="button" onClick={onLearnMore}>Why VN Reader? <span aria-hidden="true">↗</span></button><span>A quick introduction to its reading tools.</span></div>}
      <div className="guide-topic-grid">{GUIDE_TOPICS.map((item) => <button type="button" className="guide-topic" key={item.id} disabled={!hasArchive && item.id !== "appearance" && item.id !== "account"} onClick={() => { setProgress({ topic: item.id, index: 0 }); onSelectTopic(item.id); }}><span className="guide-topic-number" aria-hidden="true">{item.icon}</span><span className="guide-topic-copy"><strong>{item.title}</strong><span>{item.description}</span><small className="guide-topic-count">{TOUR_STEPS[item.id].length} steps <span aria-hidden="true">↗</span></small></span></button>)}</div>
      {!hasArchive && <p className="guide-archive-notice">Import an archive or open the sample to try the reading, library, and search tours. You can explore appearance and accounts now.</p>}
      <section className="guide-theme-reference"><h3>Seven atmospheres. The same reading tools.</h3><p>The theme changes the character of your space. You choose its navigation position separately in Settings.</p><div className="guide-theme-grid">{THEME_GUIDE.map((theme) => <article className="guide-theme-item" key={theme.name}><h4>{theme.name}</h4><p>{theme.description}</p></article>)}</div></section>
      <section className="guide-reference"><h3>How everything works</h3><p>Open a topic for the practical steps.</p>{HELP_SECTIONS.map((section) => <details className="guide-reference-section" key={section.title}><summary>{section.title}</summary>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</details>)}</section>
    </div>
  </div>;
}

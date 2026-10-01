import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WidthIcon } from "@radix-ui/react-icons";

const PRESETS = [{ label: "Narrow", value: 60 }, { label: "Comfortable", value: 76 }, { label: "Wide", value: 100 }];
type Position = { left: number; top: number; width: number };

export default function ReadingWidth({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const dragging = useRef<number | null>(null);
  const updateDraft = (next: number) => { draftRef.current = next; setDraft(next); };
  const close = () => {
    dragging.current = null; updateDraft(value);
    if (details.current) details.current.open = false;
    setOpen(false);
  };
  useEffect(() => { if (dragging.current === null) { draftRef.current = value; setDraft(value); } }, [value]);
  // Column reflow must not move the panel. Clamp its screen coordinates only
  // when opening it or when the viewport changes.
  useLayoutEffect(() => {
    if (!open) return;
    const clamp = () => setPosition(previous => {
      if (!previous) return previous;
      const width = Math.min(340, Math.max(0, window.innerWidth - 24));
      const height = panel.current?.getBoundingClientRect().height ?? 244;
      return { width, left: Math.max(12, Math.min(previous.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(previous.top, window.innerHeight - height - 12)) };
    });
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!details.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close();
      details.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open, value]);
  const finishDrag = () => {
    if (dragging.current === null) return;
    dragging.current = null;
    if (draftRef.current !== value) onChange(draftRef.current);
  };
  return <details className="reading-width-control" ref={details} data-tour="reading-width" onToggle={event => {
    const nextOpen = event.currentTarget.open;
    if (nextOpen) {
      const bounds = event.currentTarget.querySelector("summary")!.getBoundingClientRect();
      const width = Math.min(340, Math.max(0, window.innerWidth - 24));
      setPosition({ width, left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - 256)) });
    }
    setOpen(nextOpen);
  }}>
    <summary aria-label="Adjust reading width" aria-expanded={open} aria-controls="reading-width-popup"><WidthIcon aria-hidden="true" /><span>Width</span></summary>
    {open && position ? createPortal(<div id="reading-width-popup" className="reading-width-panel" ref={panel} style={position}>
      <label className="reading-width-label" htmlFor="toolbar-reading-width">Reading width <output>{draft < 68 ? "Narrow" : draft < 90 ? "Comfortable" : "Wide"}</output></label>
      <div className="reading-width-presets" aria-label="Reading width presets">
        {PRESETS.map(preset => <button key={preset.value} type="button" aria-pressed={draft === preset.value} onClick={() => { updateDraft(preset.value); onChange(preset.value); }}>{preset.label}</button>)}
      </div>
      <input id="toolbar-reading-width" aria-label="Adjust reading column width" type="range" min="40" max="120" step="2" value={draft}
        onPointerDown={event => { dragging.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={finishDrag} onLostPointerCapture={finishDrag}
        onPointerCancel={() => { dragging.current = null; updateDraft(value); }}
        onChange={event => { const next = Number(event.target.value); updateDraft(next); if (dragging.current === null) onChange(next); }} />
      <p>Choose a column that feels comfortable. This also applies in focus mode.</p>
    </div>, document.body) : null}
  </details>;
}

import { Children, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "@radix-ui/react-icons";

interface Props {
  value: string | number;
  onChange: (event: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}
interface Option { value: string; label: ReactNode; text: string; disabled: boolean }
function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : String(child)).join("");
}
export default function CustomSelect({ value, onChange, children, disabled = false, className = "", id, "aria-label": label }: Props) {
  const uid = useId(); const listId = `${uid}-list`;
  const options: Option[] = Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)) return [];
    return [{ value: String(child.props.value ?? textOf(child.props.children)), label: child.props.children, text: textOf(child.props.children), disabled: !!child.props.disabled }];
  });
  const selected = options.findIndex(option => option.value === String(value));
  const trigger = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [active, setActive] = useState(selected < 0 ? 0 : selected);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 200, maxHeight: 280 });
  const typeahead = useRef({ text: "", time: 0 });
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const show = (index = selected < 0 ? 0 : selected) => { if (disabled || !options.length) return; setActive(index); setOpen(true); };
  const choose = (index: number) => { if (!options[index] || options[index].disabled) return; onChange({ target: { value: options[index].value } }); close(); };
  const move = (delta: number) => {
    for (let offset = 1; offset <= options.length; offset++) {
      const next = (active + offset * delta + options.length * 2) % options.length;
      if (!options[next].disabled) { setActive(next); break; }
    }
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect(); if (!bounds) return;
      const viewport = window.visualViewport;
      const insetX = viewport?.offsetLeft ?? 0, insetY = viewport?.offsetTop ?? 0;
      const widthLimit = viewport?.width ?? window.innerWidth, heightLimit = viewport?.height ?? window.innerHeight;
      const width = Math.min(Math.max(bounds.width, 200), widthLimit - 32);
      const below = insetY + heightLimit - bounds.bottom - 24, above = bounds.top - insetY - 24;
      const height = Math.min(280, Math.max(44, Math.max(below, above)));
      const actualHeight = Math.min(height, options.length * 44 + 12);
      const top = below >= actualHeight || below >= above ? bounds.bottom + 8 : bounds.top - actualHeight - 8;
      setPosition({ left: Math.max(insetX + 16, Math.min(bounds.left, insetX + widthLimit - width - 16)), top: Math.max(insetY + 16, Math.min(top, insetY + heightLimit - actualHeight - 16)), width, maxHeight: Math.max(44, Math.min(height, heightLimit - 32)) });
    };
    place(); panel.current?.focus();
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); };
  }, [open, options.length]);
  useLayoutEffect(() => { if (open) panel.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  return <>
    <button id={id} ref={trigger} type="button" role="combobox" className={`custom-select-trigger ${className}`} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); show(event.key === "End" ? options.length - 1 : event.key === "Home" ? 0 : selected < 0 ? 0 : selected); }
      }}><span>{options[selected]?.label ?? "Choose an option"}</span><ChevronDownIcon aria-hidden="true" /></button>
    {open && createPortal(<div ref={panel} id={listId} role="listbox" tabIndex={-1} aria-label={label ?? "Choose an option"} aria-activedescendant={`${uid}-option-${active}`} className="custom-select-list" style={position}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Tab") { close(); return; }
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); return; }
        if (event.key === "Home" || event.key === "End") { event.preventDefault(); const enabled = options.map((option, index) => ({ option, index })).filter(item => !item.option.disabled); setActive((event.key === "Home" ? enabled[0] : enabled.at(-1))?.index ?? 0); return; }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); return; }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); const now = Date.now(); const previous = now - typeahead.current.time < 700 ? typeahead.current.text : "";
          const query = previous + event.key.toLowerCase(); typeahead.current = { text: query, time: now };
          const matches = options.map((option, index) => ({ option, index })).filter(item => !item.option.disabled && item.option.text.toLowerCase().startsWith(query));
          if (matches.length) setActive(matches[0].index);
        }
      }}>
      {options.map((option, index) => <div key={`${option.value}-${index}`} id={`${uid}-option-${index}`} role="option" aria-selected={option.value === String(value)} aria-disabled={option.disabled || undefined} data-option-index={index} className={`custom-select-option ${active === index ? "is-active" : ""}`} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}><span>{option.label}</span>{option.value === String(value) && <CheckIcon aria-hidden="true" />}</div>)}
    </div>, document.body)}
  </>;
}

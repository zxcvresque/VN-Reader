import CustomSelect from "./CustomSelect";
import { restoreCustomFont, uploadCustomFont, removeCustomFont } from "../lib/customFont";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_PREFERENCES, NAV_POSITIONS, THEMES, type ReaderPreferences } from "../lib/preferences";

interface ReaderSettingsProps {
  preferences: ReaderPreferences;
  onChange: (preferences: ReaderPreferences) => void;
  onClose: () => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  onOpenGuide?: () => void;
  tourActive?: boolean;
  backupBusy?: boolean;
}

export default function ReaderSettings({ preferences, onChange, onClose, onExportBackup, onImportBackup, onOpenGuide, tourActive = false, backupBusy = false }: ReaderSettingsProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const tourActiveRef = useRef(tourActive);
  tourActiveRef.current = tourActive;
  const fontInput = useRef<HTMLInputElement>(null);
  const latestPreferences = useRef(preferences);
  latestPreferences.current = preferences;
  const [fontName, setFontName] = useState("");
  const [fontNotice, setFontNotice] = useState("");
  const [fontBusy, setFontBusy] = useState(true);
  useEffect(() => {
    let mounted = true;
    void restoreCustomFont().then(name => { if (mounted) setFontName(name); })
      .catch(error => { if (mounted) setFontNotice(error instanceof Error ? error.message : "Could not restore your font. Aspekta is available instead."); })
      .finally(() => { if (mounted) setFontBusy(false); });
    return () => { mounted = false; };
  }, []);
  const changeCustomFont = async (file?: File) => {
    setFontBusy(true);
    setFontNotice(file ? "Loading your font…" : "Removing your font…");
    try {
      if (file) {
        const name = await uploadCustomFont(file);
        setFontName(name);
        onChange({ ...latestPreferences.current, fontFamily: "custom" });
        setFontNotice("Custom font applied. Your typeface choice and text settings sync with your account.");
      } else {
        await removeCustomFont();
        setFontName("");
        if (latestPreferences.current.fontFamily === "custom") onChange({ ...latestPreferences.current, fontFamily: "sans" });
        setFontNotice("Custom font removed.");
      }
    } catch (error) {
      setFontNotice(error instanceof Error ? error.message : "Could not change the custom font. Please try again.");
    } finally { setFontBusy(false); }
  };
  const [presetName, setPresetName] = useState("");
  const [presetNotice, setPresetNotice] = useState("");
  const update = <K extends keyof ReaderPreferences>(key: K, value: ReaderPreferences[K]) => onChange({ ...preferences, [key]: value });

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!tourActiveRef.current) dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (tourActiveRef.current || document.activeElement?.closest(".custom-select-list")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCallback.current(); }
      if (event.key !== "Tab") return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled), [tabindex="0"]') ?? [])];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handleKey, true); previousFocus?.focus(); };
  }, []);

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const { presets = [], ...appearance } = preferences;
    if (presets.length >= 12) { setPresetNotice("Remove a preset before saving another (12 maximum)."); return; }
    onChange({ ...preferences, presets: [...presets, { id: crypto.randomUUID(), name, preferences: appearance }] });
    setPresetName(""); setPresetNotice(`Saved “${name}”.`);
  };

  return <div className="reader-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="reader-settings" ref={dialog} role="dialog" aria-modal={!tourActive} aria-labelledby="reader-settings-title">
      <header className="reader-settings-header">
        <div><p className="eyebrow">Make room for your mind</p><h2 id="reader-settings-title">Your reading space</h2><p>Changes apply everywhere and stay with you on this device.</p></div>
        <button type="button" className="btn-ghost reader-settings-close" aria-label="Close reader settings" onClick={onClose}>×</button>
      </header>
      <div className="reader-settings-body">
        {onOpenGuide && <button type="button" className="reader-settings-guide" onClick={onOpenGuide}><span aria-hidden="true">?</span><span><strong>Find your way around</strong><small>Take a guided page tour or explore how every reading tool works.</small></span><span aria-hidden="true">↗</span></button>}
        <section className="reader-settings-section" data-tour="themes">
          <div className="reader-settings-section-title"><h3>Choose an atmosphere</h3><span>Four ways to settle in</span></div>
          <div className="theme-grid" role="group" aria-label="Reader theme">
            {THEMES.map(theme => <button type="button" key={theme.id} className={`theme-option theme-option-${theme.id} ${preferences.theme === theme.id ? "is-selected" : ""}`} aria-pressed={preferences.theme === theme.id} onClick={() => update("theme", theme.id)}>
              <span className="theme-option-preview" style={{ backgroundColor: theme.colors[0], color: theme.colors[1] }} aria-hidden="true"><span className="theme-preview-nav"><i /><i /><i /></span><span className="theme-preview-heading">Aa</span><span className="theme-preview-lines"><i style={{ background: theme.colors[2] }} /><i style={{ background: theme.colors[2] }} /><i style={{ background: theme.colors[2] }} /></span><span className="theme-preview-dot" style={{ background: theme.colors[1] }} /></span>
              <span className="theme-option-label"><strong>{theme.name}</strong><span className="theme-option-check" aria-hidden="true">{preferences.theme === theme.id ? "✓" : "↗"}</span></span>
              <small>{theme.description}</small>
            </button>)}
          </div>
          <p className="reader-settings-description">Your first visit follows your device: Vercel for dark mode, Liquid Opal for light. Choose any atmosphere here to make it your own.</p>
        </section>
        <section className="reader-settings-section" data-tour="nav-placement">
          <div className="reader-settings-section-title"><h3>Put navigation within reach</h3><span>Works with every theme</span></div>
          <div className="nav-placement-grid" role="group" aria-label="Navigation position">
            {NAV_POSITIONS.map(position => <button type="button" key={position.id} className={`nav-placement-option ${preferences.navPosition === position.id ? "is-selected" : ""}`} aria-pressed={preferences.navPosition === position.id} onClick={() => update("navPosition", position.id)}>
              <span className={`nav-placement-preview nav-placement-preview-${position.id}`} aria-hidden="true"><span className="nav-placement-dock"><i /><i /><i /></span><span className="nav-placement-page"><i /><i /><i /></span></span>
              <span className="nav-placement-name"><strong>{position.name}</strong><span aria-hidden="true">{preferences.navPosition === position.id ? "✓" : ""}</span></span><small>{position.description}</small>
            </button>)}
          </div>
          <p className="reader-settings-description">Placement and theme are independent. Side rails stay on your chosen edge and become a compact top bar on phones.</p>
        </section>
        <section className="reader-settings-section" data-tour="typography">
          <div className="reader-settings-section-title"><h3>The shape of a page</h3><span>Find your comfortable pace</span></div>
          <div className="reader-settings-fields">
            <label>Typeface<CustomSelect value={preferences.fontFamily} onChange={event => update("fontFamily", event.target.value as ReaderPreferences["fontFamily"])}><option value="serif">Bookish serif</option><option value="sans">Aspekta sans serif</option><option value="mono">Measured monospace</option>{(fontName || preferences.fontFamily === "custom") && <option value="custom">{fontName ? `Custom · ${fontName}` : "Custom font · upload on this device"}</option>}</CustomSelect></label>
            <label>Reading surface<CustomSelect value={preferences.paper} onChange={event => update("paper", event.target.value as ReaderPreferences["paper"])}><option value="theme">Match the theme</option><option value="warm">Warm ivory</option><option value="sepia">Soft sepia</option></CustomSelect></label>
            <label><span>Text size <output>{preferences.fontSize}px</output></span><input aria-label="Reading text size" type="range" min="14" max="26" step="1" value={preferences.fontSize} onChange={event => update("fontSize", Number(event.target.value))} /></label>
            <label><span>Line spacing <output>{preferences.lineHeight.toFixed(2)}</output></span><input aria-label="Reading line spacing" type="range" min="1.3" max="2.2" step="0.05" value={preferences.lineHeight} onChange={event => update("lineHeight", Number(event.target.value))} /></label>
            <label><span>Paragraph spacing <output>{preferences.paragraphSpacing.toFixed(2)}em</output></span><input aria-label="Reading paragraph spacing" type="range" min="0.25" max="2" step="0.25" value={preferences.paragraphSpacing} onChange={event => update("paragraphSpacing", Number(event.target.value))} /></label>
            <label><span>Column width <output>{preferences.readingWidth}ch</output></span><input aria-label="Reading column width" type="range" min="40" max="120" step="2" value={preferences.readingWidth} onChange={event => update("readingWidth", Number(event.target.value))} /></label>
          </div>
          <div className="custom-font-controls" aria-busy={fontBusy}>
            <button type="button" disabled={fontBusy} onClick={() => fontInput.current?.click()}>{fontName ? "Replace custom font" : "Add custom font"}</button>
            {fontName && <button type="button" disabled={fontBusy} onClick={() => { void changeCustomFont(); }}>Remove custom font</button>}
            <input ref={fontInput} hidden type="file" accept=".woff2,.woff,.ttf,.otf" aria-label="Custom font file" onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void changeCustomFont(file);
            }} />
            <p role="status">{fontNotice || "Choose a WOFF2, WOFF, TTF or OTF font up to 2 MB. Typeface and text settings sync with your account. Upload the font file on each device where you use it."}</p>
          </div>
          <div className="reader-settings-reading-preview"><span className="eyebrow">A little breathing room</span><p>Let an idea unfold at its own pace. A comfortable page gives you space to pause, connect, and return with a fresh perspective.</p></div>
        </section>
        <section className="reader-settings-section" data-tour="attention">
          <div className="reader-settings-section-title"><h3>Keep attention close</h3></div>
          <label className="reader-settings-toggle"><span><strong>Distraction-free reading</strong><small>Quiet the navigation and post actions. The focus button brings them back.</small></span><input type="checkbox" checked={preferences.focusMode} onChange={event => update("focusMode", event.target.checked)} /></label>
          <label className="reader-settings-media" data-tour="media">Images and media<CustomSelect value={preferences.mediaMode} onChange={event => update("mediaMode", event.target.value as ReaderPreferences["mediaMode"])}><option value="compact">Compact previews</option><option value="full">Full-width media</option><option value="collapsed">Collapsed until opened</option></CustomSelect></label>
        </section>
        <section className="reader-settings-section" data-tour="presets">
          <div className="reader-settings-section-title"><h3>Your page presets</h3><span>Keep a few familiar places</span></div>
          <form className="reader-settings-preset-form" onSubmit={event => { event.preventDefault(); savePreset(); }}><input aria-label="Preset name" placeholder="Evening reading, close study…" maxLength={60} value={presetName} onChange={event => setPresetName(event.target.value)} /><button type="submit" disabled={!presetName.trim()}>Save this setup</button></form>
          {!!preferences.presets?.length && <div className="reader-settings-presets">{preferences.presets.map(preset => <div key={preset.id}><button type="button" onClick={() => { onChange({ ...preset.preferences, presets: preferences.presets }); setPresetNotice(`Applied “${preset.name}”.`); }}>{preset.name}<span>Apply ↗</span></button><button type="button" className="btn-ghost" aria-label={`Remove preset ${preset.name}`} onClick={() => update("presets", preferences.presets?.filter(item => item.id !== preset.id))}>×</button></div>)}</div>}
          <p className="reader-settings-notice" role="status">{presetNotice || "Presets are included in your reading-state backup."}</p>
        </section>
        <section className="reader-settings-section" data-tour="backup">
          <div className="reader-settings-section-title"><h3>Take your work with you</h3></div>
          <p className="reader-settings-description">Export your progress, notes, highlights, collections, queue, and appearance as one reading-state backup.</p>
          <div className="reader-settings-backup"><button type="button" onClick={onExportBackup} disabled={backupBusy}>Export reading backup ↗</button><button type="button" onClick={() => importInput.current?.click()} disabled={backupBusy}>Restore backup</button><input hidden ref={importInput} type="file" accept="application/json,.json" aria-label="Reading backup file" onChange={event => { const file = event.target.files?.[0]; if (file) onImportBackup(file); event.target.value = ""; }} /></div>
        </section>
      </div>
      <footer className="reader-settings-footer"><button type="button" className="btn-ghost" onClick={() => onChange({ ...DEFAULT_PREFERENCES, presets: preferences.presets })}>Reset appearance</button><span>Saved automatically</span><button type="button" className="btn-primary" onClick={onClose}>Back to reading</button></footer>
    </div>
  </div>;
}

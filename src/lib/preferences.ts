export const THEMES = [
  { id: "vercel", name: "Vercel", description: "Quiet monochrome · engineered clarity", colors: ["#0a0a0a", "#ededed", "#a1a1a1"] },
  { id: "editorial", name: "Editorial", description: "Amber ink · quiet editorial", colors: ["#11141b", "#e8b26b", "#e8e6e0"] },
  { id: "cobalt", name: "Cobalt Index", description: "Precise grids · electric blue", colors: ["#edeee8", "#234bdb", "#15252e"] },
  { id: "opal", name: "Liquid Opal", description: "Pearl surfaces · soft iridescence", colors: ["#e9e7f2", "#625b9f", "#7baba6"] }
] as const;

export type ThemeId = typeof THEMES[number]["id"];
export const NAV_POSITIONS = [
  { id: "top", name: "Top", description: "A familiar bar above your page" },
  { id: "bottom", name: "Bottom", description: "Keep controls close to your hands" },
  { id: "left", name: "Left", description: "A reading rail beside your page" },
  { id: "right", name: "Right", description: "Make room for a right-side rail" }
] as const;
export type NavPosition = typeof NAV_POSITIONS[number]["id"];
export interface ReaderPreferences {
  theme: ThemeId;
  navPosition: NavPosition;
  fontFamily: "serif" | "sans" | "mono";
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  readingWidth: number;
  paper: "theme" | "warm" | "sepia";
  mediaMode: "compact" | "full" | "collapsed";
  focusMode: boolean;
  presets?: ReaderPreset[];
}
export interface ReaderPreset {
  id: string;
  name: string;
  preferences: Omit<ReaderPreferences, "presets">;
}
export const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: "opal", navPosition: "top", fontFamily: "serif", fontSize: 17, lineHeight: 1.75,
  paragraphSpacing: 1, readingWidth: 76, paper: "theme", mediaMode: "compact", focusMode: false, presets: []
};
export const PREFERENCES_KEY = "vn-reader-preferences-v1";
const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === "string" && values.includes(value as T) ? value as T : fallback;

/** Validate persisted/imported preferences before they reach controls or CSS. */
export function normalizePreferences(value: unknown, includePresets = true): ReaderPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<ReaderPreferences> : {};
  const legacyTheme = String(candidate.theme);
  return {
    theme: choice(candidate.theme, THEMES.map(theme => theme.id), ["aurora", "signal"].includes(legacyTheme) ? "vercel" : DEFAULT_PREFERENCES.theme),
    navPosition: choice(candidate.navPosition, NAV_POSITIONS.map(position => position.id), DEFAULT_PREFERENCES.navPosition),
    fontFamily: choice(candidate.fontFamily, ["serif", "sans", "mono"], DEFAULT_PREFERENCES.fontFamily),
    fontSize: clamp(candidate.fontSize, DEFAULT_PREFERENCES.fontSize, 14, 26),
    lineHeight: clamp(candidate.lineHeight, DEFAULT_PREFERENCES.lineHeight, 1.3, 2.2),
    paragraphSpacing: clamp(candidate.paragraphSpacing, DEFAULT_PREFERENCES.paragraphSpacing, 0.25, 2),
    readingWidth: clamp(candidate.readingWidth, DEFAULT_PREFERENCES.readingWidth, 40, 120),
    paper: choice(candidate.paper, ["theme", "warm", "sepia"], DEFAULT_PREFERENCES.paper),
    mediaMode: choice(candidate.mediaMode, ["compact", "full", "collapsed"], DEFAULT_PREFERENCES.mediaMode),
    focusMode: typeof candidate.focusMode === "boolean" ? candidate.focusMode : false,
    presets: includePresets && Array.isArray(candidate.presets) ? candidate.presets.slice(0, 12).flatMap((preset) => {
      if (!preset || typeof preset !== "object" || typeof preset.name !== "string" || typeof preset.id !== "string") return [];
      const { presets: _presets, ...preferences } = normalizePreferences(preset.preferences, false);
      return [{ id: preset.id.slice(0, 80), name: preset.name.slice(0, 60), preferences }];
    }) : []
  };
}
/** Consult system appearance only when the reader has no saved choice. */
export function initialPreferences(): ReaderPreferences {
  let dark = false;
  try { dark = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { /* Light is the accessible fallback. */ }
  return { ...DEFAULT_PREFERENCES, theme: dark ? "vercel" : "opal", fontFamily: dark ? "sans" : "serif", presets: [] };
}
export function loadPreferences(): ReaderPreferences {
  const initial = initialPreferences();
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (stored) return normalizePreferences(JSON.parse(stored));
    const oldWidth = Number(localStorage.getItem("vn-reader-reading-width"));
    const preferences = { ...initial, readingWidth: oldWidth >= 40 && oldWidth <= 120 ? oldWidth : initial.readingWidth };
    // Remember the first visit so a later system change does not replace a reader's setup.
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Reading still works if browser storage is blocked. */ }
    return preferences;
  } catch { return initial; }
}
export function savePreferences(preferences: ReaderPreferences): void {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalizePreferences(preferences))); }
  catch { throw new Error("Could not save reading preferences. Your browser storage may be full or unavailable."); }
}
export function applyPreferences(preferences: ReaderPreferences): void {
  const prefs = normalizePreferences(preferences);
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  const iconMode = ["vercel", "editorial"].includes(prefs.theme) ? "dark" : "light";
  document.querySelector<HTMLLinkElement>("#reader-favicon")?.setAttribute("href", `/favicon-${iconMode}.svg`);
  document.querySelector<HTMLLinkElement>("#reader-touch-icon")?.setAttribute("href", `/apple-touch-icon-${iconMode}.png`);
  root.dataset.navPosition = prefs.navPosition;
  root.dataset.paper = prefs.paper;
  root.dataset.focus = String(prefs.focusMode);
  root.dataset.mediaMode = prefs.mediaMode;
  root.style.setProperty("--reader-font", `var(--${prefs.fontFamily})`);
  root.style.setProperty("--reader-font-size", `${prefs.fontSize}px`);
  root.style.setProperty("--reader-line-height", String(prefs.lineHeight));
  root.style.setProperty("--reader-paragraph-spacing", `${prefs.paragraphSpacing}em`);
  root.style.setProperty("--reading-width", `${prefs.readingWidth}ch`);
  window.dispatchEvent(new CustomEvent("vn-reader-appearance", { detail: prefs }));
}

/** Reject malformed backups instead of silently changing the reader's saved choices. */
export function validatePreferences(value: unknown): ReaderPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reader preferences in backup.");
  const candidate = value as Record<string, unknown>;
  // Older backups predate navigation placement. Only a missing field receives the default.
  if ("navPosition" in candidate && !NAV_POSITIONS.some(position => position.id === candidate.navPosition)) throw new Error("Invalid navPosition in reading backup.");
  const enums: Record<string, readonly string[]> = { theme: THEMES.map(theme => theme.id), fontFamily: ["serif", "sans", "mono"], paper: ["theme", "warm", "sepia"], mediaMode: ["compact", "full", "collapsed"] };
  for (const [field, choices] of Object.entries(enums)) {
    if (field === "theme" && ["aurora", "niti", "signal"].includes(String(candidate[field]))) continue;
    if (typeof candidate[field] !== "string" || !choices.includes(candidate[field] as string)) throw new Error(`Invalid ${field} in reading backup.`);
  }
  const limits: Record<string, [number, number]> = { fontSize: [14, 26], lineHeight: [1.3, 2.2], paragraphSpacing: [0.25, 2], readingWidth: [40, 120] };
  for (const [field, [min, max]] of Object.entries(limits)) {
    const number = candidate[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) throw new Error(`Invalid ${field} in reading backup.`);
  }
  if (typeof candidate.focusMode !== "boolean") throw new Error("Invalid focus mode in reading backup.");
  if (candidate.presets !== undefined) {
    if (!Array.isArray(candidate.presets) || candidate.presets.length > 12) throw new Error("Invalid reading presets in backup.");
    for (const preset of candidate.presets) {
      if (!preset || typeof preset !== "object" || typeof preset.id !== "string" || typeof preset.name !== "string") throw new Error("Invalid reading preset in backup.");
      validatePreferences(preset.preferences);
    }
  }
  return normalizePreferences(value);
}

import type { Answers, FormSchema } from "../../server/formLogic.mjs";
export type { Answers, AnswerValue, Condition, FieldOption, FieldType, FormField, FormPage as SchemaPage, FormSchema, Operator, Rule, SocialAccount } from "../../server/formLogic.mjs";

export interface FormTheme {
  accent: string; font: "aspekta" | "system" | "serif" | "rounded" | "mono" | "humanist" | "custom"; surface: "glass" | "solid" | "paper";
  mode: "auto" | "light" | "dark"; backdrop: "mono" | "aurora" | "saffron" | "ocean" | "emerald" | "dawn" | "ink" | "plain"; radius: number; layout: "classic" | "focus"; submitLabel: string; fontName?: string; hasCustomFont?: boolean;
}
export interface PublicForm {
  slug: string; title: string; description: string; availability: "open" | "closed" | "draft" | "soon" | "full"; schema: FormSchema; theme: FormTheme;
  settings: { access: "public" | "account"; oneResponse: "none" | "device" | "account"; requireApproval: boolean; showProgress: boolean; closedMessage: string; opensAt: string | null; hasReward: boolean; rewardLabel: string };
}
export interface Outcome { status: "pending" | "approved" | "rejected"; submittedAt: string; title: string; message: string; reward: { label: string; url: string | null } | null; notify?: { telegram: boolean; email: string } }
export interface TelegramContact { id: string; username: string | null }
export interface FormView { form: PublicForm; updates?: { telegram: string; email: boolean }; prefill: Record<string, string>; signedIn: boolean; outcome: Outcome | null }

export interface FormSettings {
  access: "public" | "account"; oneResponse: "none" | "device" | "account"; requireApproval: boolean; showProgress: boolean;
  reward: { enabled: boolean; label: string; url: string }; confirmation: { title: string; message: string };
  approvedMessage: string; rejectedMessage: string; closedMessage: string; opensAt: string | null; closesAt: string | null; responseLimit: number | null; notifyTelegram: boolean; timezone: string;
}
export interface AdminForm { id: string; slug: string; title: string; description: string; status: "draft" | "live" | "closed"; schema: FormSchema; settings: FormSettings; theme: FormTheme; createdAt: string; updatedAt: string }
export interface FormSummary { id: string; slug: string; title: string; description: string; status: AdminForm["status"]; updatedAt: string; questions: number; accent: string; counts: { total: number; pending: number; approved: number; rejected: number; latest: string | null } }
export interface FormResponse { id: string; formId: string; status: Outcome["status"]; state: string | null; link: string; device: string; durationMs: number | null; telegram: { id: string; username: string | null } | null; hasAccount: boolean; note: string; reviewedBy: string | null; reviewedAt: string | null; createdAt: string; synced: boolean; answers: Answers }
export interface NamedCount { name: string; count: number }
export interface QuestionInsight { id: string; label: string; type: string; required: boolean; answered: number; total: number; kind: "choice" | "number" | "text"; options?: NamedCount[]; stats?: { min: number; max: number; average: number; median: number } | null; buckets?: NamedCount[]; averageLength?: number; topWords?: NamedCount[] }
export interface PlaceCounts { count: number; approved: number; pending: number; rejected: number }
export interface PlaceStats extends PlaceCounts { daily: PlaceCounts; recent: PlaceCounts; previous: number; latest: number | null }
export interface DistrictStats extends PlaceStats { name: string }
export interface StateStats extends DistrictStats { districts: DistrictStats[] }
export interface PlacesData { totals: PlaceStats; states: StateStats[]; from: string; recentFrom: string; to: string }
export interface Insights {
  range: { from: string; to: string; timezone: string };
  totals: { responses: number; allTime: number; pending: number; approved: number; rejected: number; views: number; starts: number; completionRate: number | null; viewToSubmit: number | null; medianDurationMs: number | null; last7: number; prev7: number; states: number; telegramLinked: number };
  daily: Array<{ day: string; submitted: number; approved: number; views: number }>; hours: number[]; weekdays: number[];
  states: Array<NamedCount & { approved: number; pending: number }>; links: Array<{ code: string; label: string; views: number; starts: number; responses: number }>; devices: NamedCount[];
  questions: QuestionInsight[]; insights: Array<{ tone: "good" | "warn" | "info"; title: string; detail: string }>;
}
export interface ShareLink { code: string; label: string; prefill: Record<string, string>; active: boolean; createdAt: string; views: number; starts: number; responses: number }
export interface AdminMe { email: string; owner: boolean; permissions: string[]; formIds: string[] | null; catalog: Array<{ id: string; label: string; group: string }>; presets: Record<string, string[]> }
export interface TeamMember { email: string; name: string; permissions: string[]; formIds: string[] | null; active: boolean; expired?: boolean; expiresAt?: string | null; addedBy: string | null; addedAt: string }
export interface AdminSettings {
  telegram: { tokenSource: "console" | "server" | "none"; tokenHint: string; botUsername: string; backupChat: string; backupThread: string; notifyOnSubmit: boolean; dmOnDecision: boolean; webAppUrl: string };
  email?: { available: boolean; onDecision: boolean };
  r2: { enabled: boolean; bucket: string; reason: string; waiting: number };
}

export const BACKDROPS = [{ id: "mono", name: "Monochrome" }, { id: "aurora", name: "Aurora" }, { id: "saffron", name: "Saffron dusk" }, { id: "ocean", name: "Deep ocean" }, { id: "emerald", name: "Emerald grove" }] as const;
export class RequestError extends Error { constructor(message: string, public status: number, public errors?: Record<string, string>) { super(message); } }
/** `sample` asks the admin API for the console's sample data instead of real responses. */
export async function call<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; sample?: boolean } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), credentials: "same-origin", headers: { "Content-Type": "application/json", "X-VN-CSRF": "1", ...(options.sample ? { "X-VN-Sample": "1" } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch { throw new RequestError("You appear to be offline. Check your connection and try again.", 0); }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new RequestError("The server didn't respond as expected. Try again in a moment.", response.status || 503);
  const data = await response.json();
  if (!response.ok) throw new RequestError(typeof data?.detail === "string" ? data.detail : typeof data?.message === "string" ? data.message : "That didn't work. Try again.", response.status, data?.errors);
  return data as T;
}
export async function download(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", headers: { "X-VN-CSRF": "1" } });
  if (!response.ok) { let detail = "The export couldn't be created."; try { detail = (await response.json()).detail ?? detail; } catch { /* keep default */ } throw new RequestError(detail, response.status); }
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const store = { get(key: string) { try { return localStorage.getItem(key); } catch { return null; } }, set(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage is optional */ } } };
/** Every response sent from this browser, newest first. The active one is what the status page shows. */
export interface DeviceReceipt { receipt: string; at: number }
interface ReceiptBook { active: string | null; list: DeviceReceipt[] }
const readBook = (slug: string): ReceiptBook => {
  try { const book = JSON.parse(store.get(`vn-form-receipts:${slug}`) ?? "null"); if (book && Array.isArray(book.list)) return { active: typeof book.active === "string" ? book.active : null, list: book.list.filter((item: DeviceReceipt) => typeof item?.receipt === "string").slice(0, 20) }; } catch { /* rebuilt below */ }
  const legacy = store.get(`vn-form-receipt:${slug}`); // one receipt per form, from before several were kept
  return legacy ? { active: legacy, list: [{ receipt: legacy, at: Date.now() }] } : { active: null, list: [] };
};
const writeBook = (slug: string, book: ReceiptBook) => { store.set(`vn-form-receipts:${slug}`, JSON.stringify(book)); store.set(`vn-form-receipt:${slug}`, null); };
export const receipts = {
  get: (slug: string) => readBook(slug).active,
  list: (slug: string) => readBook(slug).list,
  /** Remember a receipt (new submission or a status link) and show it. */
  set(slug: string, receipt: string | null) {
    const book = readBook(slug);
    if (receipt === null) { writeBook(slug, { active: null, list: book.list }); return; }
    const list = book.list.some(item => item.receipt === receipt) ? book.list : [{ receipt, at: Date.now() }, ...book.list].slice(0, 20);
    writeBook(slug, { active: receipt, list });
  }
};
export const drafts = {
  get(slug: string): { answers: Answers; startedAt: number } | null { try { const value = JSON.parse(store.get(`vn-form-draft:${slug}`) ?? "null"); return value && typeof value.answers === "object" ? value : null; } catch { return null; } },
  set(slug: string, value: { answers: Answers; startedAt: number } | null) { store.set(`vn-form-draft:${slug}`, value ? JSON.stringify(value) : null); }
};

/** Telegram opens web apps with signed launch data in the URL fragment. Keep it for this tab. */
export function captureTelegramLaunch(): void {
  try {
    const data = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("tgWebAppData");
    if (data) sessionStorage.setItem("vn-tg-init", data);
    if (!data && !sessionStorage.getItem("vn-tg-init")) return;
    document.documentElement.dataset.telegram = "true";
    const post = (eventType: string, eventData: unknown = "") => {
      const proxy = (window as unknown as { TelegramWebviewProxy?: { postEvent(type: string, data: string): void } }).TelegramWebviewProxy;
      if (proxy) proxy.postEvent(eventType, JSON.stringify(eventData));
      else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), "https://web.telegram.org");
    };
    post("web_app_ready"); post("web_app_expand");
  } catch { /* Outside Telegram this is a no-op. */ }
}
export function telegramInitData(): string { try { return sessionStorage.getItem("vn-tg-init") ?? ""; } catch { return ""; } }
export function deviceKind(): string { if (telegramInitData()) return "telegram"; const width = window.innerWidth; return width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop"; }

export const FONT_STACKS: Record<FormTheme["font"], { label: string; stack: string }> = {
  aspekta: { label: "Aspekta (site default)", stack: '"Aspekta", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  system: { label: "System", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  humanist: { label: "Humanist", stack: 'Optima, Candara, "Gill Sans", "Noto Sans", "Trebuchet MS", sans-serif' },
  rounded: { label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Nunito, system-ui, sans-serif' },
  serif: { label: "Serif", stack: '"Iowan Old Style", "Source Serif Pro", Charter, Georgia, serif' },
  mono: { label: "Monospace", stack: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace' },
  custom: { label: "Uploaded font", stack: '"VN Form Custom", "Aspekta", system-ui, sans-serif' }
};
/** Pick black or white text for a given accent so buttons stay readable. */
export function inkOn(hex: string): string {
  const channel = (index: number) => { const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2) > 0.36 ? "#17130a" : "#ffffff";
}
export function themeStyle(theme: FormTheme): Record<string, string> {
  return { "--vg-accent": theme.accent, "--vg-on-accent": inkOn(theme.accent), "--vg-radius": `${theme.radius}px`, "--vg-font": FONT_STACKS[theme.font]?.stack ?? FONT_STACKS.aspekta.stack };
}

export interface R2AccountStats {
  label: string; configured: boolean; bucket?: string; publicBase?: string;
  objects?: number; bytesUsed?: number; bytesFree?: number; quotaBytes?: number;
  percentUsed?: number; accountId?: string; error?: string;
  classAUsed?: number; classApct?: number; classBUsed?: number; classBpct?: number;
  flags?: { pausedWrites: boolean; pausedReads: boolean; autoStopped: boolean; autoReason: string };
}
export interface R2StatsResponse {
  enabled: boolean; reason?: string;
  freeTierBytes?: number; freeTierClassA?: number; freeTierClassB?: number;
  autoSwitchPct?: number;
  accounts?: R2AccountStats[];
  localR2Rows?: { objects: number; bytes: number };
  monthlyCounters?: { month: string; bucket: string; class: string; count: number }[];
  flags?: { pausedWrites: boolean; pausedReads: boolean; autoStopped: boolean; autoReason: string };
  thresholds?: { warn90: number; warn95: number; autoStop98: number };
}
export interface R2AnalyticsResponse {
  enabled: boolean; reason?: string;
  storageHistory: { date: string; bytesUsed: number; objects: number }[];
  classSeries: { month: string; bucket: string; class: string; count: number }[];
  monthlyCounters: { month: string; bucket: string; class: string; count: number }[];
  topObjects: { sourceId: number; key: string; bucket: string; bytes: number | null }[];
  snapshot: Record<string, unknown> | null;
  flags: { pausedWrites: boolean; pausedReads: boolean; autoStopped: boolean; autoReason: string };
  thresholds: { warn90: number; warn95: number; autoStop98: number };
}
async function fetchAdminJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", headers: { "X-VN-CSRF": "1" } });
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) throw new Error("Admin storage service is not available.");
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not load storage status.");
  return data as T;
}
export function fetchR2Stats(): Promise<R2StatsResponse> {
  return fetchAdminJson<R2StatsResponse>("/api/admin/r2-stats");
}
export function fetchR2Analytics(): Promise<R2AnalyticsResponse> {
  return fetchAdminJson<R2AnalyticsResponse>("/api/admin/r2-analytics");
}
export async function postR2Control(action: string): Promise<{ ok: boolean; action: string; text?: string }> {
  const r = await fetch("/api/admin/r2-control", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-VN-CSRF": "1" },
    body: JSON.stringify({ action }),
  });
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) throw new Error("Control service unavailable.");
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.error || "Control failed.");
  if (data.action === "unauthorized") throw new Error("Not authorized.");
  return data;
}

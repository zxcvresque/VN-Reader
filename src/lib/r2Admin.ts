export interface R2AccountStats {
  label: string; configured: boolean; bucket?: string; publicBase?: string;
  objects?: number; bytesUsed?: number; bytesFree?: number; quotaBytes?: number;
  percentUsed?: number; accountId?: string; error?: string;
}
export interface R2StatsResponse {
  enabled: boolean; reason?: string;
  freeTierBytes?: number; autoSwitchPct?: number;
  accounts?: R2AccountStats[];
  localR2Rows?: { objects: number; bytes: number };
}
export async function fetchR2Stats(): Promise<R2StatsResponse> {
  const r = await fetch("/api/admin/r2-stats", { credentials: "same-origin", headers: { "X-VN-CSRF": "1" } });
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) throw new Error("Admin storage service is not available.");
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not load storage status.");
  return data as R2StatsResponse;
}

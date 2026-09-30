import type { ArchiveManifest, ArchiveMessage } from "../types";
import type { ReadingBackup } from "./backup";
export interface AccountUser { id: string | number; email: string }
export interface SiteConfig { accountsEnabled: boolean; archiveEnabled: boolean }
export interface CloudState { revision: number; data: ReadingBackup | null }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", "X-VN-CSRF": "1", ...options.headers } });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new ApiError("The account service is not connected yet. You can keep reading as a guest.", response.ok ? 503 : response.status);
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data.detail === "string" ? data.detail : typeof data.message === "string" ? data.message : "The request could not be completed.", response.status);
  return data as T;
}
export function authRequest<T>(action: string, body: unknown): Promise<T> {
  const input = body as Record<string, unknown>;
  const paths: Record<string,string> = {register:"sign-up/email",login:"sign-in/email",logout:"sign-out","verify-email":"email-otp/verify-email","resend-code":"email-otp/send-verification-otp","request-password-reset":"email-otp/request-password-reset","reset-password":"email-otp/reset-password"};
  const payload = action === "register" ? {...input,name:"Reader"} : action === "resend-code" ? {...input,type:"email-verification"} : ["verify-email","reset-password"].includes(action) ? {...input,otp:input.code,code:undefined} : input;
  return api<T>(`/auth/${paths[action]??action}`, {method:"POST",body:JSON.stringify(payload)});
}
export function loadCloudState(chatId: number): Promise<CloudState> { return api(`/state/${chatId}`); }
export function saveCloudState(chatId: number, data: ReadingBackup, revision: number, keepalive = false): Promise<CloudState> { return api(`/state/${chatId}`, { method: "PUT", headers: { "If-Match": String(revision) }, body: JSON.stringify({ data }), keepalive }); }
export function fetchSiteArchive(): Promise<{ manifest: ArchiveManifest; messages: ArchiveMessage[] }> { return api("/archive"); }

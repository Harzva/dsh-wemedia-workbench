import type { JsonObject } from "./json.ts";

export const ACCOUNT_CHANNELS = ["wechat", "zhihu", "xiaohongshu", "x"] as const;
export type AccountChannel = typeof ACCOUNT_CHANNELS[number];
export type AccountStatus = "unchecked" | "ready" | "login_required" | "expired" | "error" | "not_configured";
export type AccountLoginKind = "qr" | "browser" | "configuration" | "unsupported";
export interface AccountSummary extends JsonObject {
  channel: AccountChannel; name: string; status: AccountStatus; checkedAt: string | null;
  message: string; permission: "unknown" | "available" | "missing";
  credential: { kind: "api_key" | "cookies" | "oauth"; label: string; present: boolean | null; storage: "local_reference" };
  login: { kind: AccountLoginKind; supported: boolean; message: string };
}
export interface AccountOverview extends JsonObject {
  schemaVersion: "wemedia.accounts/v1"; accounts: AccountSummary[]; notice: string;
}
export interface AccountLogin extends JsonObject {
  loginId: string; channel: AccountChannel; kind: AccountLoginKind;
  status: "pending" | "ready" | "failed" | "expired" | "cancelled" | "unsupported";
  message: string; expiresAt: string | null; qrDataUrl?: string; url?: string;
}
export type AccountRequest = { operation: "account_list" }
  | { operation: "account_check"; channel: AccountChannel }
  | { operation: "account_login_start"; channel: AccountChannel }
  | { operation: "account_login_poll"; loginId: string }
  | { operation: "account_login_cancel"; loginId: string };

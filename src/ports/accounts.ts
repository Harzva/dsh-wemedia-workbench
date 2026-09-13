import type { AccountChannel, AccountLogin, AccountLoginKind, AccountStatus } from "../domain/accounts.ts";

export interface AccountCheckResult {
  status: AccountStatus; message: string; present: boolean | null;
  permission?: "unknown" | "available" | "missing";
  /** Private stable fingerprint, never a raw token or account identifier. */
  accountRef?: string;
}
export interface AccountLoginDriver {
  kind: AccountLoginKind; supported: boolean; message: string;
  start(loginId: string, signal: AbortSignal): Promise<AccountLogin>;
  poll(login: AccountLogin, signal: AbortSignal): Promise<AccountLogin>;
  cancel(login: AccountLogin): Promise<void>;
  dispose(): Promise<void>;
}
export interface AccountProvider {
  channel: AccountChannel; label: string; kind: "api_key" | "cookies" | "oauth";
  check(signal: AbortSignal): Promise<AccountCheckResult>;
  login: AccountLoginDriver;
}

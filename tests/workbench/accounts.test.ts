import { describe, expect, it, vi } from "vitest";
import { AccountManagementService } from "../../src/application/accountManagementService.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import { MemoryOverlayRepository } from "../../src/infrastructure/memoryRepositories.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { createWorkbenchTools } from "../../src/host/tools.ts";
import type { AccountLogin } from "../../src/domain/accounts.ts";
import type { AccountProvider } from "../../src/ports/accounts.ts";

const signal = () => new AbortController().signal;
function fixture(canLogin = true) {
  const store = new WorkbenchStore(new MemoryOverlayRepository());
  const clock = { nowIso: () => "2026-09-09T01:00:00.000Z", monotonicMs: () => 0 };
  const ids = { uuidV4: () => "11111111-1111-4111-8111-111111111111", opaqueId: (prefix: string) => `${prefix}:11111111-1111-4111-8111-111111111111` };
  const provider: AccountProvider = { channel: "xiaohongshu", label: "本地小红书凭证", kind: "cookies", check: vi.fn(async () => ({ status: "login_required" as const, message: "请扫码登录", present: true })), login: { kind: "qr", supported: true, message: "扫码登录", start: vi.fn(async (loginId: string): Promise<AccountLogin> => ({ loginId, channel: "xiaohongshu", kind: "qr", status: "pending", message: "等待扫码", expiresAt: "2099-01-01T00:00:00Z", qrDataUrl: "data:image/png;base64,cHJpdmF0ZQ==" })), poll: vi.fn(async (login: AccountLogin): Promise<AccountLogin> => ({ ...login, status: "ready" })), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } };
  const service = new AccountManagementService({ providers: [provider], store, canLogin: () => canLogin, clock, ids });
  const request = (value: Parameters<typeof service.request>[0]) => service.request(value, { kind: "user" }, signal());
  return { provider, service, store, request, clock, ids };
}
describe("account management boundary", () => {
  it("does not inspect credentials or claim online validity while listing", async () => {
    const f = fixture(), view = await f.service.list();
    expect(view.accounts).toHaveLength(4);
    expect(view.accounts.find(a => a.channel === "xiaohongshu")?.status).toBe("unchecked");
    expect(f.provider.check).not.toHaveBeenCalled();
    expect(view.accounts.find(a => a.channel === "x")?.status).toBe("not_configured");
  });
  it("stores only the checked status index and never login artifacts", async () => {
    const f = fixture(); await f.request({ operation: "account_check", channel: "xiaohongshu" });
    const login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    expect(login.qrDataUrl).toContain("data:image/png");
    const saved = JSON.stringify((await f.store.read()).extensions);
    expect(saved).toContain("login_required"); expect(saved).not.toContain("base64"); expect(saved).not.toContain("loginId");
    await f.service.dispose();
  });
  it("reports a missing connection without failing the check-all flow", async () => {
    const f = fixture();
    expect(await f.request({ operation: "account_check", channel: "wechat" })).toMatchObject({ status: "not_configured", checkedAt: null });
    expect(f.provider.check).not.toHaveBeenCalled();
  });
  it.each(["account_login_start", "account_login_poll", "account_login_cancel"] as const)("does not send %s authentication data to an Agent", async operation => {
    const f = fixture();
    const request = operation === "account_login_start" ? { operation, channel: "xiaohongshu" as const } : { operation, loginId: "unknown" };
    await expect(f.service.request(request, { kind: "agent", sessionId: "agent" }, signal())).rejects.toMatchObject({ code: "ACCOUNT_LOGIN_USER_REQUIRED" });
    expect(f.provider.login.start).not.toHaveBeenCalled();
  });
  it("blocks login while a publishing operation owns the account boundary", async () => {
    const f = fixture(false);
    await expect(f.request({ operation: "account_login_start", channel: "xiaohongshu" })).rejects.toMatchObject({ code: "ACCOUNT_BUSY" });
    expect(f.provider.login.start).not.toHaveBeenCalled();
  });
  it("reuses one active login instead of replacing a QR code on repeated clicks", async () => {
    const f = fixture(); const first = await f.request({ operation: "account_login_start", channel: "xiaohongshu" });
    expect(await f.request({ operation: "account_login_start", channel: "xiaohongshu" })).toEqual(first);
    expect(f.provider.login.start).toHaveBeenCalledTimes(1); expect(f.service.busy()).toBe(true);
    await f.service.dispose();
  });
  it("clears QR data on cancellation and does not claim to revoke upstream QR", async () => {
    const f = fixture(), login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    vi.mocked(f.provider.login.poll).mockResolvedValue({ ...login, status: "cancelled" });
    const ended = await f.request({ operation: "account_login_cancel", loginId: login.loginId });
    expect(ended).toMatchObject({ status: "cancelled" }); expect(ended).not.toHaveProperty("qrDataUrl");
    expect(ended.message).toContain("仍可能有效"); expect(f.provider.login.cancel).toHaveBeenCalledTimes(1);
  });
  it("preserves a committed login when cancellation arrives after credential save", async () => {
    const f = fixture(), login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    const answer = await f.request({ operation: "account_login_cancel", loginId: login.loginId });
    expect(answer.status).toBe("ready"); expect(answer).not.toHaveProperty("qrDataUrl"); expect(f.provider.check).toHaveBeenCalledTimes(1);
  });
  it("clears the login artifact even when the final cancelled-state poll fails", async () => {
    const f = fixture(), login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    vi.mocked(f.provider.login.poll).mockRejectedValue(new Error("private credential"));
    const answer = await f.request({ operation: "account_login_cancel", loginId: login.loginId });
    expect(answer.status).toBe("cancelled"); expect(answer).not.toHaveProperty("qrDataUrl"); expect(f.service.busy()).toBe(true);
  });
  it("holds the credential boundary until a cancelled upstream QR expires", async () => {
    const f = fixture(); let now = "2026-09-09T01:00:00Z";
    const clock = { ...f.clock, nowIso: () => now };
    const service = new AccountManagementService({ providers: [f.provider], store: f.store, canLogin: () => true, clock, ids: f.ids });
    vi.mocked(f.provider.login.start).mockImplementation(async loginId => ({ loginId, channel: "xiaohongshu", kind: "qr", status: "pending", message: "扫码", expiresAt: "2026-09-09T01:04:00Z", qrDataUrl: "data:image/png;base64,cHJpdmF0ZQ==" }));
    const login = await service.request({ operation: "account_login_start", channel: "xiaohongshu" }, { kind: "user" }, signal()) as AccountLogin;
    vi.mocked(f.provider.login.poll).mockResolvedValue({ ...login, status: "cancelled" });
    await service.request({ operation: "account_login_cancel", loginId: login.loginId }, { kind: "user" }, signal());
    expect(service.busy()).toBe(true);
    now = "2026-09-09T01:04:01Z"; expect(service.busy()).toBe(false);
  });
  it("removes QR from a completed login and separately checks the saved account", async () => {
    const f = fixture(), login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    const result = await f.request({ operation: "account_login_poll", loginId: login.loginId });
    expect(result).toMatchObject({ status: "ready" }); expect(result).not.toHaveProperty("qrDataUrl");
    expect(f.provider.check).toHaveBeenCalledTimes(1);
  });
  it("keeps an issued upstream QR lease when status polling fails", async () => {
    const f = fixture(), login = await f.request({ operation: "account_login_start", channel: "xiaohongshu" }) as AccountLogin;
    vi.mocked(f.provider.login.poll).mockResolvedValue({ ...login, status: "failed" });
    expect(await f.request({ operation: "account_login_poll", loginId: login.loginId })).not.toHaveProperty("qrDataUrl");
    expect(f.service.busy()).toBe(true);
  });
  it("does not trust persisted free-form messages or stale ready status", async () => {
    const f = fixture(); await f.store.update(s => { s.extensions.accounts = { xiaohongshu: { status: "ready", checkedAt: "2000-01-01T00:00:00Z", message: "private secret", present: true } }; });
    const view = await f.service.list(); expect(view.accounts[2]?.status).toBe("unchecked"); expect(JSON.stringify(view)).not.toContain("private secret");
  });
  it("sanitizes provider exceptions", async () => {
    const f = fixture(); vi.mocked(f.provider.check).mockRejectedValue(new Error("private credential"));
    const answer = await f.request({ operation: "account_check", channel: "xiaohongshu" }); expect(answer.status).toBe("error"); expect(JSON.stringify(answer)).not.toContain("private credential");
  });
  it("rejects secrets, invented platforms and malformed login identities at the RPC boundary", () => {
    for (const input of [{ operation: "account_check", channel: "douyin" }, { operation: "account_login_start", channel: "x", token: "secret" }, { operation: "account_login_poll", loginId: "../../secret" }]) expect(() => decodeWorkbenchRequest(input)).toThrow();
    expect(decodeWorkbenchRequest({ operation: "account_list" })).toEqual({ operation: "account_list" });
  });
  it("exposes status tools without exposing login or secret tools", () => {
    const tools = createWorkbenchTools({ request: vi.fn() }, { bind: () => ({ caller: { kind: "user" }, dispose() {} }) });
    const names = tools.map(tool => tool.name); expect(names).toContain("wemedia_accounts"); expect(names).toContain("wemedia_account_check"); expect(names.some(name => /login|credential|token/.test(name))).toBe(false);
  });
});

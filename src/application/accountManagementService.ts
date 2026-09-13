import { ACCOUNT_CHANNELS } from "../domain/accounts.ts";
import type { AccountChannel, AccountLogin, AccountOverview, AccountRequest, AccountStatus, AccountSummary } from "../domain/accounts.ts";
import { isJsonObject } from "../domain/json.ts";
import { WorkbenchFault } from "../domain/workbenchFault.ts";
import type { WorkbenchCaller } from "../domain/workbench.ts";
import type { AccountProvider } from "../ports/accounts.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { WorkbenchStateStore } from "../ports/repositories.ts";

const names = { wechat: "微信公众号", zhihu: "知乎", xiaohongshu: "小红书", x: "X / Twitter" };
const messages: Record<AccountStatus, string> = { unchecked: "尚未在线检查，请点击检查账号。", ready: "最近一次在线身份检查成功；发布权限会在提交前再次核验。", login_required: "需要登录后才能使用当前账号。", expired: "本地授权已过期，请重新登录或授权。", error: "账号检查暂未完成，请重试；不能据此判断已退出登录。", not_configured: "尚未配置该平台的本地连接。" };
const statuses = Object.keys(messages);

/** Stores only a status index. Credentials stay with the explicitly configured local provider. */
export class AccountManagementService {
  private readonly lifetime = new AbortController();
  private readonly sessions = new Map<string, AccountLogin>();
  private readonly upstreamQrLeases = new Map<string, number>();
  private readonly starting = new Map<AccountChannel, Promise<AccountLogin>>();
  private readonly checking = new Map<AccountChannel, Promise<AccountSummary>>();
  constructor(private readonly options: { providers: AccountProvider[]; store: WorkbenchStateStore; canLogin: () => boolean; clock: Clock; ids: IdGenerator }) {}
  private now(): string { return this.options.clock.nowIso(); }
  private provider(channel: AccountChannel): AccountProvider {
    return this.options.providers.find(p => p.channel === channel) ?? (() => { throw new WorkbenchFault("ACCOUNT_NOT_CONFIGURED", "当前平台尚未配置账号连接"); })();
  }
  private summary(channel: AccountChannel, saved?: unknown): AccountSummary {
    const provider = this.options.providers.find(p => p.channel === channel);
    const row = isJsonObject(saved) ? saved : {};
    const stamp = typeof row.checkedAt === "string" && Number.isFinite(Date.parse(row.checkedAt)) ? row.checkedAt : null;
    const recent = stamp !== null && Date.parse(this.now()) - Date.parse(stamp) < 24 * 60 * 60_000 && Date.parse(stamp) <= Date.parse(this.now()) + 60_000;
    const status: AccountStatus = !provider ? "not_configured" : recent && statuses.includes(String(row.status)) ? row.status as AccountStatus : "unchecked";
    return { channel, name: names[channel], status, checkedAt: stamp, message: channel === "wechat" && status === "unchecked" ? "公众号使用本地 AppID / Secret；此处检查配置是否齐全，不把它当作在线权限验证。" : messages[status], permission: "unknown",
      credential: { kind: provider?.kind ?? (channel === "wechat" ? "api_key" : channel === "x" ? "oauth" : "cookies"), label: provider?.label ?? "未连接本地凭证", present: typeof row.present === "boolean" ? row.present : null, storage: "local_reference" },
      login: { kind: provider?.login.kind ?? "unsupported", supported: provider?.login.supported ?? false, message: provider?.login.message ?? "请先配置该平台的本地连接。" } };
  }
  async list(): Promise<AccountOverview> {
    const state = (await this.options.store.read()).extensions.accounts;
    const saved = isJsonObject(state) ? state : {};
    return { schemaVersion: "wemedia.accounts/v1", accounts: ACCOUNT_CHANNELS.map(channel => this.summary(channel, saved[channel])), notice: "统一查看本机当前账号与凭证引用。密钥、Cookie 和令牌由本地连接保管，不进入文章、对话或浏览器存储；每个平台目前复用一个默认账号。" };
  }
  private check(channel: AccountChannel, signal: AbortSignal): Promise<AccountSummary> {
    if (!this.options.providers.some(provider => provider.channel === channel)) return Promise.resolve(this.summary(channel));
    const running = this.checking.get(channel); if (running) return running;
    const work = (async () => {
      const provider = this.provider(channel);
      let result: Awaited<ReturnType<AccountProvider["check"]>>;
      try { result = await provider.check(signal); }
      catch { if (signal.aborted) throw new WorkbenchFault("ACCOUNT_CHECK_CANCELLED", "账号检查已取消"); result = { status: "error", message: messages.error, present: null }; }
      if (signal.aborted) throw new WorkbenchFault("ACCOUNT_CHECK_CANCELLED", "账号检查已取消");
      const checkedAt = this.now();
      const saved = { checkedAt, status: statuses.includes(result.status) ? result.status : "error", present: result.present };
      await this.options.store.update(state => { const previous = state.extensions.accounts; state.extensions.accounts = { ...(isJsonObject(previous) ? previous : {}), [channel]: saved }; });
      return { ...this.summary(channel, saved), message: result.message, permission: result.permission ?? "unknown" };
    })().finally(() => { this.checking.delete(channel); });
    this.checking.set(channel, work); return work;
  }
  private publicLogin(login: AccountLogin): AccountLogin {
    if (login.status !== "pending") { const copy = { ...login }; delete copy.qrDataUrl; delete copy.url; return copy; }
    return structuredClone(login);
  }
  private remember(login: AccountLogin): void {
    if (login.channel === "xiaohongshu" && login.kind === "qr" && login.status === "pending" && login.qrDataUrl && login.expiresAt) this.upstreamQrLeases.set(login.loginId, Date.parse(login.expiresAt));
    if (login.status === "ready") this.upstreamQrLeases.delete(login.loginId);
    this.sessions.set(login.loginId, this.publicLogin(login));
  }
  private prune(): void {
    for (const [id, expiresAt] of this.upstreamQrLeases) if (expiresAt <= Date.parse(this.now())) this.upstreamQrLeases.delete(id);
    for (const [id, login] of this.sessions) if (login.expiresAt && Date.parse(login.expiresAt) <= Date.parse(this.now())) {
      void this.options.providers.find(p => p.channel === login.channel)?.login.cancel(login).catch(() => {});
      this.sessions.delete(id);
    }
    for (const [id, login] of this.sessions) if (this.sessions.size >= 16 && login.status !== "pending") this.sessions.delete(id);
  }
  async request(request: AccountRequest, caller: WorkbenchCaller, signal: AbortSignal): Promise<AccountOverview | AccountSummary | AccountLogin> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    if (signal.aborted) throw new WorkbenchFault("REQUEST_CANCELLED", "账号管理已停止");
    if (request.operation === "account_list") return this.list();
    if (request.operation === "account_check") return this.check(request.channel, signal);
    // Login artifacts and credential-writing flows belong to the human UI, never model logs.
    if (caller.kind !== "user") throw new WorkbenchFault("ACCOUNT_LOGIN_USER_REQUIRED", "请在账号管理页由用户发起登录，登录二维码不进入 Agent 对话");
    this.prune();
    if (request.operation === "account_login_start") {
      if (!this.options.canLogin()) throw new WorkbenchFault("ACCOUNT_BUSY", "请先结束正在进行的发布或设置操作，再登录账号");
      const provider = this.provider(request.channel);
      const pending = [...this.sessions.values()].find(s => s.channel === request.channel && s.status === "pending");
      if (pending) return this.publicLogin(pending);
      const previous = this.starting.get(request.channel); if (previous) return previous;
      const loginId = `accountlogin:${this.options.ids.uuidV4()}`;
      const work = (async () => {
        let login: AccountLogin;
        try { login = await provider.login.start(loginId, signal); }
        catch { throw new WorkbenchFault("ACCOUNT_LOGIN_FAILED", "登录入口暂时不可用，原有凭证保持不变，请重试"); }
        if (signal.aborted) { await provider.login.cancel(login); throw new WorkbenchFault("ACCOUNT_LOGIN_CANCELLED", "已关闭登录请求"); }
        if (login.loginId !== loginId || login.channel !== request.channel) throw new WorkbenchFault("ACCOUNT_LOGIN_INVALID", "登录会话身份无法核对");
        this.remember(login);
        if (login.status === "ready") await this.check(request.channel, signal);
        return this.publicLogin(login);
      })().finally(() => { this.starting.delete(request.channel); });
      this.starting.set(request.channel, work); return work;
    }
    const login = this.sessions.get(request.loginId);
    if (!login) throw new WorkbenchFault("ACCOUNT_LOGIN_EXPIRED", "登录窗口已关闭或过期，请重新发起登录");
    const provider = this.provider(login.channel);
    if (request.operation === "account_login_cancel") {
      await provider.login.cancel(login);
      const observed = await provider.login.poll(login, signal).catch(() => undefined);
      if (observed?.loginId === login.loginId && observed.channel === login.channel && observed.status === "ready") {
        this.remember(observed);
        await this.check(login.channel, signal);
        return this.publicLogin(observed);
      }
      const ended: AccountLogin = { ...login, status: "cancelled", message: login.channel === "xiaohongshu" ? "已停止状态检查；尚未过期的小红书二维码仍可能有效，请勿继续扫码。二维码到期前暂停发布，避免登录凭证同时变化。" : observed ? "已关闭登录流程，已保存的凭证保持不变。" : "已关闭登录窗口；请检查账号以确认最终授权状态。" };
      this.remember(ended); return this.publicLogin(ended);
    }
    if (login.status !== "pending") return this.publicLogin(login);
    const update = await provider.login.poll(login, signal);
    if (this.sessions.get(login.loginId)?.status !== "pending") return this.publicLogin(this.sessions.get(login.loginId)!);
    if (update.loginId !== login.loginId || update.channel !== login.channel) throw new WorkbenchFault("ACCOUNT_LOGIN_INVALID", "登录状态无法核对");
    this.remember(update);
    if (update.status === "ready") await this.check(login.channel, signal);
    return this.publicLogin(update);
  }
  busy(): boolean { this.prune(); return this.starting.size > 0 || this.upstreamQrLeases.size > 0 || [...this.sessions.values()].some(login => login.status === "pending"); }
  async dispose(): Promise<void> { this.lifetime.abort(); await Promise.allSettled(this.options.providers.map(provider => provider.login.dispose())); this.sessions.clear(); }
}

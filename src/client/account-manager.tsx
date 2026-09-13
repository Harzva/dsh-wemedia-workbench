import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AccountChannel, AccountLogin, AccountOverview, AccountStatus, AccountSummary } from "../domain/accounts.ts";
import type { WorkbenchValue } from "../domain/workbench.ts";
import type { WorkbenchController } from "./controller.ts";
import { useDialogFocus } from "./interactions.ts";
import { workbenchStyles } from "./styles.ts";
import { accountManagerStyles } from "./account-manager-styles.ts";

export type AccountManagerHost = Pick<WorkbenchController, "requestContent">;
type AccountRequest = Parameters<AccountManagerHost["requestContent"]>[0];
export interface AccountManagerState {
  overview: AccountOverview | null; loading: boolean; error: string | null; notice: string | null;
  busy: { channel: AccountChannel; action: "check" | "login" | "cancel" } | null; checkingAll: boolean;
  login: AccountLogin | null; loginBusy: boolean; loginError: string | null; pollLimitReached: boolean;
}
const emptyState = (): AccountManagerState => ({ overview: null, loading: false, error: null, notice: null, busy: null, checkingAll: false, login: null, loginBusy: false, loginError: null, pollLimitReached: false });
const statusLabels: Record<AccountStatus, string> = { unchecked: "未检查", ready: "已登录", login_required: "需要登录", expired: "已过期", error: "检查异常", not_configured: "未配置" };
const platformLabels: Record<AccountChannel, string> = { wechat: "微信公众号", zhihu: "知乎", xiaohongshu: "小红书", x: "X" };
const platformMarks: Record<AccountChannel, string> = { wechat: "微", zhihu: "知", xiaohongshu: "红", x: "𝕏" };
const kindLabels = { api_key: "API 凭证", cookies: "本地登录态", oauth: "OAuth 授权" };
const loginStatusLabels = { pending: "等待完成登录", ready: "登录已确认", failed: "登录未完成", expired: "本次登录已过期", cancelled: "登录已取消", unsupported: "暂不支持此登录方式" };
const formatTime = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未检查";

/** Only an inline raster image can become a QR source; never fetch arbitrary URLs. */
export function accountQrSource(value: string | undefined): string | undefined {
  return value && value.length <= 2_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) ? value : undefined;
}
export function accountLoginUrl(channel: AccountChannel, value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hosts: Record<AccountChannel, string[]> = { wechat: ["mp.weixin.qq.com"], zhihu: ["www.zhihu.com", "zhihu.com"], xiaohongshu: ["www.xiaohongshu.com", "creator.xiaohongshu.com"], x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"] };
    if (url.protocol !== "https:" || !hosts[channel].includes(url.hostname) || url.username || url.password || url.port || url.hash || value.length > 8192) return undefined;
    if (!url.search) return url.href;
    // The Host's X PKCE authorization link contains public client metadata and a
    // one-time challenge. Preserve that exact link; dropping its query breaks login.
    if (channel !== "x" || url.hostname !== "x.com" || url.pathname !== "/i/oauth2/authorize") return undefined;
    const keys = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"];
    if ([...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key))) return undefined;
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    return url.searchParams.get("response_type") === "code" && url.searchParams.get("code_challenge_method") === "S256" && redirect.protocol === "http:" && redirect.hostname === "127.0.0.1" && !!redirect.port && redirect.pathname === "/oauth/x/callback" && !redirect.search && !redirect.hash && !redirect.username && !redirect.password ? url.href : undefined;
  } catch { return undefined; }
}
function memoryLogin(value: AccountLogin, previous: AccountLogin | null): AccountLogin {
  const { qrDataUrl: _qr, url: _url, ...login } = value;
  const qr = value.status === "pending" ? accountQrSource(value.qrDataUrl ?? (previous?.loginId === value.loginId ? previous.qrDataUrl : undefined)) : undefined;
  const url = value.status === "pending" ? accountLoginUrl(value.channel, value.url) : undefined;
  return { ...login, ...(qr ? { qrDataUrl: qr } : {}), ...(url ? { url } : {}) };
}

/** One view lifetime owns all account requests and the transient login image. */
export class AccountManagerModel {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private requests = new Set<AbortController>();
  private epoch = 0;
  private enabled = false;
  constructor(private readonly host: AccountManagerHost) {}
  getSnapshot = (): AccountManagerState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(change: Partial<AccountManagerState>): void { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  setActive(active: boolean): void {
    if (active === this.enabled) return;
    this.enabled = active; this.epoch += 1;
    for (const request of this.requests) request.abort(); this.requests.clear();
    const login = this.state.login;
    this.state = emptyState(); for (const listener of this.listeners) listener();
    if (!active && login?.status === "pending") this.cancelDetached(login.loginId);
  }
  private cancelDetached(loginId: string): void {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    void Promise.resolve().then(() => this.host.requestContent({ operation: "account_login_cancel", loginId }, abort.signal)).catch(() => {}).finally(() => clearTimeout(timer));
  }
  private current(epoch: number): boolean { return this.enabled && this.epoch === epoch; }
  private async request<T extends WorkbenchValue>(request: AccountRequest): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    const abort = new AbortController(), epoch = this.epoch; this.requests.add(abort);
    try { const value = await this.host.requestContent<T>(request, abort.signal); return this.current(epoch) && !abort.signal.aborted ? value : undefined; }
    catch (error) { if (this.current(epoch) && !abort.signal.aborted) throw error; return undefined; }
    finally { this.requests.delete(abort); }
  }
  private mergeAccount(account: AccountSummary): void {
    if (this.state.overview) this.patch({ overview: { ...this.state.overview, accounts: this.state.overview.accounts.map(item => item.channel === account.channel ? account : item) } });
  }
  async load(): Promise<void> {
    if (!this.enabled || this.state.loading || this.state.busy || this.state.checkingAll) return;
    const epoch = this.epoch; this.patch({ loading: true, error: null, notice: null });
    try { const overview = await this.request<AccountOverview>({ operation: "account_list" }); if (overview) this.patch({ overview }); }
    catch { if (this.current(epoch)) this.patch({ error: "账号信息暂时无法读取，请重新加载。" }); }
    finally { if (this.current(epoch)) this.patch({ loading: false }); }
  }
  private async checkOne(channel: AccountChannel): Promise<boolean> {
    const epoch = this.epoch; this.patch({ busy: { channel, action: "check" } });
    try {
      const account = await this.request<AccountSummary>({ operation: "account_check", channel });
      if (!account) return false;
      if (account.channel !== channel) throw new Error("Account response mismatch");
      this.mergeAccount(account); return true;
    } catch { if (this.current(epoch)) this.patch({ error: `${platformLabels[channel]}检查未完成，保留上次状态，请稍后重试。` }); return false; }
    finally { if (this.current(epoch)) this.patch({ busy: null }); }
  }
  async check(channel: AccountChannel): Promise<void> {
    if (!this.enabled || this.state.loading || this.state.busy || this.state.checkingAll) return;
    this.patch({ error: null, notice: null }); await this.checkOne(channel);
  }
  async checkAll(): Promise<void> {
    if (!this.enabled || !this.state.overview || this.state.loading || this.state.busy || this.state.checkingAll || this.state.login?.status === "pending") return;
    const epoch = this.epoch, accounts = this.state.overview.accounts;
    this.patch({ checkingAll: true, error: null, notice: null }); let completed = 0;
    for (const account of accounts) { if (!this.current(epoch)) return; if (await this.checkOne(account.channel)) completed += 1; }
    if (this.current(epoch)) this.patch({ checkingAll: false, notice: `已完成 ${completed} / ${accounts.length} 个平台的登录检查。` });
  }
  async startLogin(channel: AccountChannel): Promise<void> {
    if (!this.enabled || this.state.loading || this.state.busy || this.state.checkingAll || this.state.login) return;
    const account = this.state.overview?.accounts.find(item => item.channel === channel);
    if (!account || (!account.login.supported && account.login.kind !== "configuration")) return;
    const epoch = this.epoch; this.patch({ busy: { channel, action: "login" }, error: null, notice: null, loginError: null, pollLimitReached: false });
    try {
      const login = await this.request<AccountLogin>({ operation: "account_login_start", channel });
      if (!login) return;
      if (login.channel !== channel) throw new Error("Login response mismatch");
      this.patch({ login: memoryLogin(login, null) });
      if (login.status === "ready") await this.checkOne(channel);
    } catch { if (this.current(epoch)) this.patch({ error: `${platformLabels[channel]}登录未能启动，请核对账号配置后重试。` }); }
    finally { if (this.current(epoch)) this.patch({ busy: null }); }
  }
  async pollLogin(): Promise<void> {
    const current = this.state.login;
    if (!this.enabled || !current || current.status !== "pending" || this.state.loginBusy) return;
    const epoch = this.epoch; this.patch({ loginBusy: true, loginError: null });
    try {
      const login = await this.request<AccountLogin>({ operation: "account_login_poll", loginId: current.loginId });
      if (!login || this.state.login?.loginId !== current.loginId || this.state.login.status !== "pending") return;
      if (login.loginId !== current.loginId || login.channel !== current.channel) throw new Error("Login response mismatch");
      this.patch({ login: memoryLogin(login, this.state.login) });
      if (login.status === "ready") await this.checkOne(current.channel);
    } catch { if (this.current(epoch) && this.state.login?.loginId === current.loginId) this.patch({ loginError: "登录状态暂时无法确认，请稍后手动检查。" }); }
    finally { if (this.current(epoch) && this.state.login?.loginId === current.loginId) this.patch({ loginBusy: false }); }
  }
  stopAutomaticPolling(): void { if (this.state.login?.status === "pending") this.patch({ pollLimitReached: true }); }
  expireLogin(): void {
    const login = this.state.login;
    if (login?.status === "pending") { this.patch({ login: memoryLogin({ ...login, status: "expired", message: "本次登录已过期，请关闭后重新登录。" }, null), loginBusy: false }); this.cancelDetached(login.loginId); }
  }
  async closeLogin(): Promise<void> {
    const login = this.state.login; if (!login) return;
    this.patch({ login: null, loginBusy: false, loginError: null, pollLimitReached: false });
    if (login.status !== "pending" || !this.enabled) return;
    const epoch = this.epoch; this.patch({ busy: { channel: login.channel, action: "cancel" }, notice: "正在结束本次登录…" });
    try {
      const result = await this.request<AccountLogin>({ operation: "account_login_cancel", loginId: login.loginId });
      if (result) this.patch({ notice: result.message });
    } catch { if (this.current(epoch)) this.patch({ notice: "登录面板已关闭；平台侧状态尚未确认，可使用检查登录核对。" }); }
    finally { if (this.current(epoch)) this.patch({ busy: null }); }
  }
}

const useContextEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function AccountManager({ host, connected, generationId, active = true, onExplorePlatforms }: { host: AccountManagerHost; connected: boolean; generationId: string; active?: boolean; onExplorePlatforms?: (() => void) | undefined }): ReactNode {
  const model = useMemo(() => new AccountManagerModel(host), [host, generationId]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useContextEffect(() => { model.setActive(active && connected); if (active && connected) void model.load(); return () => model.setActive(false); }, [model, active, connected]);
  useEffect(() => {
    if (!active || !connected || state.login?.status !== "pending") return;
    let stopped = false, polls = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => { if (!stopped) timer = setTimeout(() => void tick(), 3000); };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      const login = model.getSnapshot().login;
      if (login?.status !== "pending") return;
      if (login.expiresAt && Date.parse(login.expiresAt) <= Date.now()) { model.expireLogin(); return; }
      if (typeof document !== "undefined" && document.hidden) { model.stopAutomaticPolling(); return; }
      await model.pollLogin(); polls += 1;
      if (stopped || model.getSnapshot().login?.status !== "pending") return;
      if (polls >= 15) model.stopAutomaticPolling(); else schedule();
    };
    schedule(); return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, [model, active, connected, state.login?.loginId, state.login?.status]);
  useEffect(() => {
    if (!active || !connected || state.login?.status !== "pending" || !state.login.expiresAt) return;
    const delay = Date.parse(state.login.expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay > 2_147_483_647) return;
    const timer = setTimeout(() => model.expireLogin(), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [model, active, connected, state.login?.loginId, state.login?.status, state.login?.expiresAt]);
  if (!active) return null;
  return <AccountManagerPanel state={state} connected={connected} model={model} onExplorePlatforms={onExplorePlatforms} />;
}

export function AccountManagerPanel({ state, connected, model, onExplorePlatforms }: { state: AccountManagerState; connected: boolean; model: AccountManagerModel; onExplorePlatforms?: (() => void) | undefined }): ReactNode {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AccountStatus | "all">("all");
  const accounts = connected ? state.overview?.accounts ?? [] : [];
  const term = query.trim().toLocaleLowerCase();
  const visible = accounts.filter(account => (status === "all" || account.status === status) && (term === "x" ? account.channel === "x" : `${account.name} ${account.channel}`.toLocaleLowerCase().includes(term)));
  const disabled = !connected || state.loading || !!state.busy || state.checkingAll;
  return <section className="wm-account-manager" aria-label="账号管理" aria-busy={state.loading || state.checkingAll}>
    <style>{accountManagerStyles}</style>
    <header className="wm-account-heading"><div><span className="wm-eyebrow">内容分发 · 账号管理</span><h2>让每个平台，准备就绪</h2><p>集中管理本地凭证引用，检查账号登录状态。创作与发布复用这些账号。</p></div><div className="wm-account-heading-actions"><Button className="wm-native-button" variant="outline" disabled={disabled} onClick={() => void model.load()}>{state.loading ? "读取中…" : "刷新列表"}</Button><Button className="wm-native-button" variant="primary" disabled={disabled || !state.overview || state.login?.status === "pending"} onClick={() => void model.checkAll()}>{state.checkingAll ? "逐个检查中…" : "检查全部账号"}</Button></div></header>
    {!connected ? <div className="wm-account-banner" role="status">工作台连接后加载账号信息。</div> : <>
      {state.error && <div className="wm-account-banner" data-kind="error" role="alert">{state.error}</div>}
      {state.notice && <div className="wm-account-banner" role="status">{state.notice}</div>}
      {!state.overview ? <div className="wm-empty" role="status"><p>{state.loading ? "正在读取本地账号引用…" : "账号列表尚未加载。"}</p>{!state.loading && <Button className="wm-native-button" onClick={() => void model.load()}>重新加载</Button>}</div> : <>
        <div className="wm-account-summary" aria-label="账号状态概览"><div><strong>{accounts.length}</strong><span>支持的平台</span></div><div data-tone="ready"><strong>{accounts.filter(account => account.status === "ready").length}</strong><span>登录已确认</span></div><div data-tone="attention"><strong>{accounts.filter(account => ["login_required", "expired", "error", "not_configured"].includes(account.status)).length}</strong><span>需要处理</span></div><div><strong>{accounts.filter(account => account.status === "unchecked").length}</strong><span>等待检查</span></div></div>
        <div className="wm-account-filters"><label>搜索平台<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="微信、知乎、小红书、X" /></label><label>登录状态<select value={status} onChange={event => setStatus(event.target.value as AccountStatus | "all")}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span role="status">{visible.length} 个平台</span></div>
        <div className="wm-account-grid">{visible.map(account => <AccountCard key={account.channel} account={account} busy={state.busy?.channel === account.channel ? state.busy.action : null} disabled={disabled} loginOpen={!!state.login} onCheck={() => void model.check(account.channel)} onLogin={() => void model.startLogin(account.channel)} />)}</div>
        {!visible.length && <div className="wm-empty"><p>没有符合条件的账号，试试其他平台或状态。</p><Button className="wm-native-button" onClick={() => { setQuery(""); setStatus("all"); }}>清除筛选</Button></div>}
        <p className="wm-account-notice">{state.overview.notice}</p>
      </>}
    </>}
    <aside className="wm-account-research"><p>Ins、Threads、YouTube、B站等平台仍待接入，尚未提供账号登录或发布功能。可在平台扩展中查看接入条件。</p>{onExplorePlatforms && <Button className="wm-native-button" variant="outline" onClick={onExplorePlatforms}>查看平台扩展 ↗</Button>}</aside>
    <AccountLoginDialog login={connected ? state.login : null} busy={state.loginBusy} error={state.loginError} pollLimitReached={state.pollLimitReached} onCheck={() => void model.pollLogin()} onClose={() => void model.closeLogin()} />
  </section>;
}

function AccountCard({ account, busy, disabled, loginOpen, onCheck, onLogin }: { account: AccountSummary; busy: "check" | "login" | "cancel" | null; disabled: boolean; loginOpen: boolean; onCheck: () => void; onLogin: () => void }): ReactNode {
  const loginLabel = account.login.kind === "configuration" ? "查看配置方式" : account.status === "ready" ? "重新登录" : account.login.kind === "qr" ? "扫码登录" : "登录账号";
  return <article className="wm-account-card" aria-label={`${account.name}账号`} aria-busy={!!busy}>
    <div className="wm-account-card-header"><span className="wm-account-avatar" data-channel={account.channel} aria-hidden="true">{platformMarks[account.channel]}</span><div><h3>{account.name}</h3><p>{kindLabels[account.credential.kind]}</p></div><span className="wm-account-status" data-status={account.status}>{busy === "check" ? "检查中…" : statusLabels[account.status]}</span></div>
    <p className="wm-account-message">{account.message}</p>
    <div className="wm-account-credential"><div><span>本地凭证引用</span><span>{account.credential.present === true ? "已引用" : account.credential.present === false ? "未找到凭证" : "待确认"}</span></div><code>{account.credential.label}</code><p>创作与发布共用此引用</p></div>
    <dl className="wm-account-facts"><dt>最近检查</dt><dd>{formatTime(account.checkedAt)}</dd><dt>发布权限</dt><dd>{account.permission === "available" ? "已确认" : account.permission === "missing" ? "缺少所需权限" : "待单独核对"}</dd></dl>
    <div className="wm-account-card-actions"><Button className="wm-native-button" variant="outline" disabled={disabled} onClick={onCheck}>{busy === "check" ? "正在检查…" : "检查登录"}</Button><Button className="wm-native-button" variant={account.status === "ready" || account.login.kind === "configuration" ? "outline" : "primary"} disabled={disabled || loginOpen || (!account.login.supported && account.login.kind !== "configuration")} title={!account.login.supported ? account.login.message : undefined} onClick={onLogin}>{busy === "login" ? "准备登录中…" : busy === "cancel" ? "正在结束登录…" : loginLabel}</Button></div>
    <p className="wm-account-login-hint">{account.login.message}</p>
  </article>;
}

function AccountLoginDialog({ login, busy, error, pollLimitReached, onCheck, onClose }: { login: AccountLogin | null; busy: boolean; error: string | null; pollLimitReached: boolean; onCheck: () => void; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, !!login);
  return <Modal open={!!login} onClose={onClose} title={login ? `${platformLabels[login.channel]} · ${login.kind === "configuration" ? "账号配置" : "登录账号"}` : "登录账号"} closeLabel="关闭登录面板" className="wm-workbench wm-account-login-dialog" footer={<><Button className="wm-native-button" variant="outline" onClick={onClose}>{login?.status === "pending" ? "取消本次登录" : "关闭"}</Button>{login?.status === "pending" && <Button className="wm-native-button" variant="primary" disabled={busy} onClick={onCheck}>{busy ? "正在确认…" : "我已完成登录，检查状态"}</Button>}</>}>
    <style>{workbenchStyles}{accountManagerStyles}</style><div ref={ref} tabIndex={-1} className="wm-account-login-body">{login && <>
      <div className="wm-account-login-state" data-status={login.status} role="status">{login.kind === "configuration" ? "凭证配置说明" : loginStatusLabels[login.status]}</div><p>{login.message}</p>
      {login.status === "pending" && login.kind === "qr" && (login.qrDataUrl ? <div className="wm-account-qr"><img src={login.qrDataUrl} alt={`${platformLabels[login.channel]}本次登录二维码`} /></div> : <p role="alert">本次二维码尚不可用，请关闭后重新发起登录。</p>)}
      {login.status === "pending" && login.url && <p><a href={login.url} target="_blank" rel="noopener noreferrer">打开官方登录页面 ↗</a></p>}
      {login.status === "pending" && login.expiresAt && <p className="wm-account-login-time">有效期至 {formatTime(login.expiresAt)}</p>}
      {error && <p className="wm-error" role="alert">{error}</p>}
      {login.status === "pending" && pollLimitReached && <p role="status">自动检查已暂停。完成登录后，点击“检查状态”确认结果。</p>}
      {login.kind === "qr" && login.status === "pending" && <p className="wm-account-login-time">请使用手机扫码。关闭面板后，本次二维码会清除。</p>}
    </>}</div>
  </Modal>;
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CollectionKind, ReferenceCollection, ReferenceItem, ReferencePage } from "../domain/references.ts";
import { ClientFault, type WorkbenchController } from "./controller.ts";
import { useDialogFocus } from "./interactions.ts";
import { workbenchStyles } from "./styles.ts";
import { referenceLibraryStyles } from "./reference-library-styles.ts";

export type ReferenceLibraryHost = Pick<WorkbenchController, "requestContent">;
export type ReferenceAgentTask = (ids: string[], action: "analyze" | "write", instruction: string) => Promise<void>;
interface ReferenceError { text: string; code: string | null; account: boolean }
export interface ReferenceLibraryState {
  page: ReferencePage | null; loading: boolean; collecting: boolean; error: ReferenceError | null; notice: string | null;
  kind: CollectionKind; url: string; limit: number; selected: string[]; instruction: string; agentBusy: "analyze" | "write" | null;
  focusedId: string | null; detail: ReferenceItem | null; detailLoading: boolean; detailError: ReferenceError | null;
}
export interface ReferenceFilters { query: string; platform: "all" | ReferenceItem["platform"]; author: string; kind: "all" | ReferenceItem["kind"]; dateField: "collected" | "published"; from: string; to: string }
const emptyFilters = (): ReferenceFilters => ({ query: "", platform: "all", author: "", kind: "all", dateField: "collected", from: "", to: "" });
const emptyState = (): ReferenceLibraryState => ({ page: null, loading: false, collecting: false, error: null, notice: null, kind: "wechat_article", url: "", limit: 3, selected: [], instruction: "", agentBusy: null, focusedId: null, detail: null, detailLoading: false, detailError: null });
const platformLabels = { wechat: "微信公众号", xiaohongshu: "小红书" };
const kindLabels = { article: "文章", image_text: "图文", video: "视频" };
const collectionLabels: Record<CollectionKind, string> = { wechat_article: "微信公众号文章", xhs_note: "小红书单篇笔记", xhs_author: "小红书作者主页" };
const timeLabel = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
function calendarDay(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function filterReferences(items: ReferenceItem[], filters: ReferenceFilters): ReferenceItem[] {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return items.filter(item => {
    if (filters.platform !== "all" && item.platform !== filters.platform || filters.author && item.author !== filters.author || filters.kind !== "all" && item.kind !== filters.kind) return false;
    const searchable = [item.title, item.author, item.text, ...item.tags].join(" ").toLocaleLowerCase();
    if (!terms.every(term => searchable.includes(term))) return false;
    if (!filters.from && !filters.to) return true;
    const day = calendarDay(filters.dateField === "collected" ? item.collectedAt : item.publishedAt);
    return day !== null && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
  });
}

/** Public source links never carry transient XHS tokens or arbitrary destinations. */
export function referenceSourceUrl(item: Pick<ReferenceItem, "platform" | "url">): string | null {
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port || item.url.length > 8192) return null;
    if (item.platform === "xiaohongshu") {
      if (!["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname)) return null;
      const match = /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/u.exec(url.pathname);
      return match ? `https://www.xiaohongshu.com/explore/${match[1]}` : null;
    }
    if (url.hostname !== "mp.weixin.qq.com") return null;
    if (/^\/s\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname)) return `https://mp.weixin.qq.com${url.pathname}`;
    if (url.pathname !== "/s") return null;
    const rules: Record<string, RegExp> = { __biz: /^[A-Za-z0-9+/=]{1,180}$/u, mid: /^\d{1,32}$/u, idx: /^\d{1,3}$/u, sn: /^[a-f0-9]{32}$/iu };
    const query = new URLSearchParams();
    for (const [key, pattern] of Object.entries(rules)) { const value = url.searchParams.get(key); if (url.searchParams.getAll(key).length !== 1 || !value || !pattern.test(value)) return null; query.set(key, value); }
    return `https://mp.weixin.qq.com/s?${query}`;
  } catch { return null; }
}
function collectionError(error: unknown, fallback: string): ReferenceError {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : null;
  const account = !!code && !code.startsWith("WECHAT_") && /LOGIN|AUTH|ACCOUNT/u.test(code);
  const messages: Record<string, string> = {
    XHS_SHORT_LINK_UNSUPPORTED: "请先在浏览器打开小红书短链接，再复制完整的笔记或作者主页分享链接。",
    XHS_SHARE_TOKEN_REQUIRED: "请重新复制完整的小红书分享链接，保留其中的访问参数；临时参数不会保存到参考库。",
    SESSION_REQUIRED: "请先在 DSH 选择一个会话，再分析写法或参考创作。",
    TASK_BRIEF_STALE: "当前会话或参考页面已变化，请重新选择参考后提交。",
    PROMPT_NOT_ACCEPTED: "当前会话没有接受任务，请检查会话状态后重试。",
  };
  if (code && messages[code]) return { text: messages[code], code, account: false };
  if (error instanceof ClientFault && code && /^(?:WECHAT_|REFERENCE_)/u.test(code) && !account) return { text: error.message.slice(0, 500), code, account: false };
  return { text: account ? "平台登录状态或授权需要确认，请到账号管理检查后再采集。" : code && /URL|LINK/u.test(code) ? "链接无法采集，请确认平台、采集类型和原始链接是否正确。" : code && /TIMEOUT|TIMED_OUT/u.test(code) ? "采集等待超时，请稍后重试；也可以刷新参考库核对已保存的内容。" : fallback, code, account };
}
function inputError(kind: CollectionKind, value: string, limit: number): string | null {
  if (!value.trim()) return "先粘贴要采集的原文或作者主页链接。";
  try {
    const url = new URL(value.trim());
    if (kind !== "wechat_article" && ["xhslink.com", "www.xhslink.com"].includes(url.hostname)) return "请先在浏览器打开小红书短链接，再复制完整的笔记或作者主页分享链接。";
    const hosts = kind === "wechat_article" ? ["mp.weixin.qq.com"] : kind === "xhs_note" ? ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"] : ["www.xiaohongshu.com", "xiaohongshu.com"];
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password || url.port || value.length > 8192) return "请使用对应平台的 HTTPS 原文链接。";
  } catch { return "链接格式不正确，请粘贴完整的 HTTPS 链接。"; }
  return kind === "xhs_author" && (!Number.isInteger(limit) || limit < 1 || limit > 5) ? "每次从作者主页采集 1～5 篇笔记。" : null;
}

/** View-owned requests: late reads/collections cannot restore a cleared URL or detail. */
export class ReferenceLibraryModel {
  private state = emptyState(); private listeners = new Set<() => void>(); private enabled = false; private epoch = 0;
  private listRequest: AbortController | undefined; private collectRequest: AbortController | undefined; private detailRequest: AbortController | undefined;
  constructor(private readonly host: ReferenceLibraryHost) {}
  getSnapshot = (): ReferenceLibraryState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(change: Partial<ReferenceLibraryState>): void { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  private current(epoch: number, request?: AbortController): boolean { return this.enabled && epoch === this.epoch && !request?.signal.aborted; }
  setActive(active: boolean): void {
    if (active === this.enabled) return;
    this.enabled = active; this.epoch += 1; this.listRequest?.abort(); this.collectRequest?.abort(); this.detailRequest?.abort();
    this.listRequest = this.collectRequest = this.detailRequest = undefined;
    this.state = emptyState(); for (const listener of this.listeners) listener();
  }
  setInput(change: Partial<Pick<ReferenceLibraryState, "kind" | "url" | "limit">>): void {
    if (!this.enabled || this.state.collecting) return;
    this.patch({ ...change, error: null, ...(change.kind && change.kind !== this.state.kind ? { url: "" } : {}) });
  }
  setInstruction(instruction: string): void { if (this.enabled && !this.state.agentBusy) this.patch({ instruction: instruction.slice(0, 2000) }); }
  toggle(id: string): void {
    if (!this.enabled || this.state.agentBusy || !this.state.page?.items.some(item => item.id === id)) return;
    if (this.state.selected.includes(id)) this.patch({ selected: this.state.selected.filter(value => value !== id) });
    else if (this.state.selected.length < 5) this.patch({ selected: [...this.state.selected, id] });
    else this.patch({ notice: "每次最多选择 5 篇参考内容。" });
  }
  clearSelection(): void { if (!this.state.agentBusy) this.patch({ selected: [] }); }
  async load(preserveNotice = false): Promise<void> {
    if (!this.enabled || this.state.collecting || this.state.loading) return;
    const abort = new AbortController(), epoch = this.epoch; this.listRequest = abort;
    this.patch({ loading: true, error: null, ...(!preserveNotice ? { notice: null } : {}) });
    try {
      const page = await this.host.requestContent<ReferencePage>({ operation: "reference_list" }, abort.signal);
      if (!this.current(epoch, abort)) return;
      const selected = this.state.selected.filter(id => page.items.some(item => item.id === id));
      this.patch({ page, selected });
      if (this.state.focusedId && !page.items.some(item => item.id === this.state.focusedId)) this.closeDetail();
    } catch (error) { if (this.current(epoch, abort)) this.patch({ error: collectionError(error, "参考库暂时无法读取，请重新加载。") }); }
    finally { if (this.current(epoch, abort)) this.patch({ loading: false }); if (this.listRequest === abort) this.listRequest = undefined; }
  }
  async collect(): Promise<void> {
    if (!this.enabled || this.state.collecting || this.state.loading || this.state.agentBusy) return;
    const invalid = inputError(this.state.kind, this.state.url, this.state.limit);
    if (invalid) { this.patch({ error: { text: invalid, code: null, account: false } }); return; }
    const abort = new AbortController(), epoch = this.epoch; this.collectRequest = abort;
    const request = { operation: "reference_collect" as const, kind: this.state.kind, url: this.state.url.trim(), limit: this.state.kind === "xhs_author" ? this.state.limit : 1 };
    this.patch({ collecting: true, error: null, notice: null });
    try {
      const result = await this.host.requestContent<ReferenceCollection>(request, abort.signal);
      if (!this.current(epoch, abort)) return;
      const merged = new Map((this.state.page?.items ?? []).map(item => [item.id, item]));
      for (const item of result.items) merged.set(item.id, { ...item, text: item.text.slice(0, 300) });
      const items = [...merged.values()].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt)).slice(0, 100);
      this.patch({ page: { schemaVersion: "wemedia.references/v1", items, total: Math.max(this.state.page?.total ?? 0, items.length), notice: this.state.page?.notice ?? "" }, url: "", notice: `${result.partial ? "部分采集完成。" : "采集完成。"}${result.message} 新增 ${result.added} 篇，更新 ${result.updated} 篇。`, collecting: false });
      void this.load(true);
    } catch (error) { if (this.current(epoch, abort)) this.patch({ error: collectionError(error, "采集未完成，请核对链接或平台状态后重试；可刷新参考库查看已保存的内容。") }); }
    finally { if (this.current(epoch, abort)) this.patch({ collecting: false }); if (this.collectRequest === abort) this.collectRequest = undefined; }
  }
  cancelCollection(): void {
    if (!this.state.collecting) return;
    this.collectRequest?.abort(); this.collectRequest = undefined;
    this.patch({ collecting: false, url: "", notice: "已请求停止采集；已保存的内容可刷新参考库核对。" });
  }
  async openDetail(id: string): Promise<void> {
    if (!this.enabled || !this.state.page?.items.some(item => item.id === id)) return;
    this.detailRequest?.abort(); const abort = new AbortController(), epoch = this.epoch; this.detailRequest = abort;
    this.patch({ focusedId: id, detail: null, detailLoading: true, detailError: null });
    try {
      const detail = await this.host.requestContent<ReferenceItem>({ operation: "reference_read", id }, abort.signal);
      if (!this.current(epoch, abort) || this.state.focusedId !== id) return;
      if (detail.id !== id) throw new Error("Reference identity mismatch");
      this.patch({ detail });
    } catch (error) { if (this.current(epoch, abort) && this.state.focusedId === id) this.patch({ detailError: collectionError(error, "这篇参考内容暂时无法读取，请重试。") }); }
    finally { if (this.current(epoch, abort) && this.state.focusedId === id) this.patch({ detailLoading: false }); if (this.detailRequest === abort) this.detailRequest = undefined; }
  }
  closeDetail(): void { this.detailRequest?.abort(); this.detailRequest = undefined; this.patch({ focusedId: null, detail: null, detailLoading: false, detailError: null }); }
  async sendToAgent(action: "analyze" | "write", handler: ReferenceAgentTask | undefined): Promise<void> {
    if (!this.enabled || !handler || this.state.agentBusy || this.state.collecting || !this.state.selected.length || this.state.selected.length > 5) return;
    const epoch = this.epoch, ids = [...this.state.selected], instruction = this.state.instruction.trim();
    this.patch({ agentBusy: action, error: null, notice: null });
    try { await handler(ids, action, instruction); if (this.current(epoch)) this.patch({ notice: action === "analyze" ? "当前会话已接受分析任务，可在会话中查看写法分析。" : "当前会话已接受创作任务，可在会话中继续完善内容。" }); }
    catch (error) { if (this.current(epoch)) this.patch({ error: collectionError(error, "当前会话未接受任务，请确认会话可用后重试。") }); }
    finally { if (this.current(epoch)) this.patch({ agentBusy: null }); }
  }
}

const useContextEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function ReferenceLibrary({ host, connected, generationId, active = true, onAccounts, onAgentTask }: { host: ReferenceLibraryHost; connected: boolean; generationId: string; active?: boolean; onAccounts?: (() => void) | undefined; onAgentTask?: ReferenceAgentTask | undefined }): ReactNode {
  const model = useMemo(() => new ReferenceLibraryModel(host), [host, generationId]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useContextEffect(() => { model.setActive(active && connected); if (active && connected) void model.load(); return () => model.setActive(false); }, [model, active, connected]);
  if (!active) return null;
  return <ReferenceLibraryPanel model={model} state={state} connected={connected} onAccounts={onAccounts} onAgentTask={onAgentTask} />;
}

export function ReferenceLibraryPanel({ model, state, connected, onAccounts, onAgentTask }: { model: ReferenceLibraryModel; state: ReferenceLibraryState; connected: boolean; onAccounts?: (() => void) | undefined; onAgentTask?: ReferenceAgentTask | undefined }): ReactNode {
  const [filters, setFilters] = useState<ReferenceFilters>(emptyFilters);
  const items = connected ? state.page?.items ?? [] : [];
  const visible = useMemo(() => filterReferences(items, filters), [items, filters]);
  const authors = [...new Set(items.map(item => item.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const disabled = !connected || state.collecting || state.loading || !!state.agentBusy;
  const verificationUrl = state.error?.code === "WECHAT_VERIFICATION_REQUIRED" ? referenceSourceUrl({ platform: "wechat", url: state.url }) : null;
  const hiddenSelected = state.selected.filter(id => !visible.some(item => item.id === id)).length;
  const changeFilter = (change: Partial<ReferenceFilters>): void => setFilters(previous => ({ ...previous, ...change }));
  return <section className="wm-reference-library" aria-label="采集与参考库" aria-busy={state.loading || state.collecting}>
    <style>{referenceLibraryStyles}</style>
    <header className="wm-ref-heading"><div><span className="wm-eyebrow">内容创作 · 采集与参考</span><h2>收集好内容，形成自己的表达</h2><p>采集公众号文章、小红书笔记与作者内容，建立本地参考库。选择参考后，让当前会话分析写法或辅助创作。</p></div><Button className="wm-native-button" variant="outline" disabled={disabled} onClick={() => void model.load()}>{state.loading ? "读取中…" : "刷新参考库"}</Button></header>
    <form className="wm-ref-collector" onSubmit={event => { event.preventDefault(); void model.collect(); }}><h3>从链接采集</h3><div className="wm-ref-collector-fields"><label>采集类型<select value={state.kind} disabled={disabled} onChange={event => model.setInput({ kind: event.target.value as CollectionKind })}>{Object.entries(collectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wm-ref-url">{state.kind === "xhs_author" ? "作者主页链接" : "原文链接"}<input type="url" value={connected ? state.url : ""} onChange={event => model.setInput({ url: event.target.value })} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={8192} placeholder={state.kind === "wechat_article" ? "https://mp.weixin.qq.com/s/…" : state.kind === "xhs_author" ? "https://www.xiaohongshu.com/user/profile/…" : "https://www.xiaohongshu.com/explore/…"} aria-describedby="wm-ref-collection-hint" /></label>{state.kind === "xhs_author" && <label className="wm-ref-limit">采集篇数<select value={state.limit} disabled={disabled} onChange={event => model.setInput({ limit: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} 篇</option>)}</select></label>}<div className="wm-ref-collector-actions"><Button type="submit" className="wm-native-button" variant="primary" disabled={disabled || !state.url.trim()}>{state.collecting ? "正在采集…" : "采集到参考库"}</Button>{state.collecting && <Button type="button" className="wm-native-button" variant="outline" onClick={() => model.cancelCollection()}>取消采集</Button>}</div></div><p id="wm-ref-collection-hint" className="wm-ref-hint">{state.kind === "wechat_article" ? "采集可访问的公众号文章；需要登录或验证的内容会如实提示。" : state.kind === "xhs_author" ? "使用完整作者分享链接，按主页返回的顺序采集 1～5 篇笔记。" : "使用完整分享链接（含访问参数）；短链接请先打开再复制。临时参数仅用于本次采集。"}</p></form>
    {!connected ? <div className="wm-ref-banner" role="status"><p>工作台连接后加载参考库。</p></div> : <>
      {state.error && <div className="wm-ref-banner" data-kind="error" role="alert"><div><p>{state.error.text}</p>{state.error.code && <small>{state.error.code}</small>}</div>{verificationUrl && <a href={verificationUrl} target="_blank" rel="noopener noreferrer">打开原文核对 ↗</a>}{state.error.account && onAccounts && <Button className="wm-native-button" variant="outline" onClick={onAccounts}>查看账号管理</Button>}</div>}
      {state.notice && <div className="wm-ref-banner" role="status"><p>{state.notice}</p></div>}
      <section className="wm-ref-assistant" aria-label="使用选中的参考内容"><div className="wm-ref-assistant-head"><h3>已选择 {state.selected.length} / 5 篇参考{hiddenSelected ? ` · ${hiddenSelected} 篇位于其他筛选中` : ""}</h3><div className="wm-ref-agent-actions"><Button className="wm-native-button" variant="outline" disabled={disabled || !state.selected.length || !onAgentTask} onClick={() => void model.sendToAgent("analyze", onAgentTask)}>{state.agentBusy === "analyze" ? "正在交给会话…" : "分析写法"}</Button><Button className="wm-native-button" variant="primary" disabled={disabled || !state.selected.length || !onAgentTask} onClick={() => void model.sendToAgent("write", onAgentTask)}>{state.agentBusy === "write" ? "正在交给会话…" : "参考创作"}</Button><Button className="wm-native-button" disabled={!state.selected.length || !!state.agentBusy} onClick={() => model.clearSelection()}>清空选择</Button></div></div>{!!state.selected.length && <ul className="wm-ref-selected-list">{state.selected.map(id => <li key={id} title={items.find(item => item.id === id)?.title}>{items.find(item => item.id === id)?.title ?? "参考内容"}</li>)}</ul>}<label htmlFor="wm-ref-instruction">补充要求（可选）</label><textarea id="wm-ref-instruction" value={state.instruction} onChange={event => model.setInstruction(event.target.value)} disabled={!!state.agentBusy} maxLength={2000} rows={2} placeholder="例如：分析标题与叙事结构；面向科研读者，写一篇带明确来源的原创文章。" /><p>{!onAgentTask ? "当前入口尚未连接会话任务，请从工作台主视图打开。" : "使用当前会话的模型处理选中的参考；任务被会话接受后会给出确认。"}</p></section>
      <div className="wm-ref-filters"><label>搜索标题、作者或摘要<input type="search" value={filters.query} onChange={event => changeFilter({ query: event.target.value })} placeholder="关键词、主题、标签…" /></label><label>平台<select value={filters.platform} onChange={event => changeFilter({ platform: event.target.value as ReferenceFilters["platform"] })}><option value="all">全部平台</option>{Object.entries(platformLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>作者<select value={filters.author} onChange={event => changeFilter({ author: event.target.value })}><option value="">全部作者</option>{authors.map(author => <option key={author} value={author}>{author}</option>)}</select></label><label>内容类型<select value={filters.kind} onChange={event => changeFilter({ kind: event.target.value as ReferenceFilters["kind"] })}><option value="all">全部类型</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="wm-ref-date-filters"><label>时间依据<select value={filters.dateField} onChange={event => changeFilter({ dateField: event.target.value as ReferenceFilters["dateField"] })}><option value="collected">采集时间</option><option value="published">发布时间</option></select></label><label>开始日期<input type="date" value={filters.from} onChange={event => changeFilter({ from: event.target.value })} /></label><label>结束日期<input type="date" value={filters.to} min={filters.from || undefined} onChange={event => changeFilter({ to: event.target.value })} /></label><Button className="wm-native-button" size="sm" onClick={() => setFilters(emptyFilters())}>清除筛选</Button></div>
      {filters.from && filters.to && filters.from > filters.to && <p className="wm-ref-hint" data-error="true" role="alert">开始日期不能晚于结束日期。</p>}
      <p className="wm-ref-result-count" role="status">{state.loading ? "正在读取参考库…" : `显示 ${visible.length} / ${items.length} 篇${state.page && state.page.total > items.length ? ` · 库内共 ${state.page.total} 篇` : ""}`}</p>
      <div className="wm-ref-items">{visible.map(item => <ReferenceCard key={item.id} item={item} selected={state.selected.includes(item.id)} selectionDisabled={!!state.agentBusy || state.selected.length >= 5 && !state.selected.includes(item.id)} onSelect={() => model.toggle(item.id)} onOpen={() => void model.openDetail(item.id)} />)}</div>
      {!state.loading && !visible.length && <div className="wm-empty"><h3>{items.length ? "没有匹配的参考内容" : "从第一篇参考开始"}</h3><p>{items.length ? "试试其他关键词、作者或日期，已选参考仍然保留。" : "粘贴公众号文章或小红书链接，采集后即可阅读和使用。"}</p>{items.length > 0 && <Button className="wm-native-button" onClick={() => setFilters(emptyFilters())}>清除筛选</Button>}</div>}
      {!!state.page?.notice && <p className="wm-ref-notice">{state.page.notice}</p>}
    </>}
    <ReferenceDetail state={state} connected={connected} model={model} />
  </section>;
}

function ReferenceCard({ item, selected, selectionDisabled, onSelect, onOpen }: { item: ReferenceItem; selected: boolean; selectionDisabled: boolean; onSelect: () => void; onOpen: () => void }): ReactNode {
  const url = referenceSourceUrl(item);
  return <article className="wm-ref-item" data-selected={selected}><label className="wm-ref-choice"><input type="checkbox" checked={selected} disabled={selectionDisabled} onChange={onSelect} aria-label={`选择参考：${item.title}`} /></label><div className="wm-ref-item-content"><button type="button" className="wm-ref-item-title" onClick={onOpen}>{item.title || "未命名参考"}</button><div className="wm-ref-item-meta"><span className="wm-ref-badge">{platformLabels[item.platform]}</span><span>{item.author || "作者未知"}</span><span>{kindLabels[item.kind]}</span>{item.completeness === "partial" && <span className="wm-ref-badge" data-partial="true">部分内容</span>}</div><p className="wm-ref-excerpt">{item.text || "暂无文字摘要，点开查看已采集的信息。"}</p><div className="wm-ref-item-footer"><span>采集于 {timeLabel(item.collectedAt)}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">原文 ↗</a>}</div></div></article>;
}

function ReferenceDetail({ state, connected, model }: { state: ReferenceLibraryState; connected: boolean; model: ReferenceLibraryModel }): ReactNode {
  const ref = useRef<HTMLDivElement>(null), open = connected && !!state.focusedId;
  useDialogFocus(ref, open);
  const item = state.detail, listItem = state.page?.items.find(value => value.id === state.focusedId), selected = !!state.focusedId && state.selected.includes(state.focusedId);
  const url = item ? referenceSourceUrl(item) : null;
  return <Modal open={open} onClose={() => model.closeDetail()} title="参考内容" closeLabel="关闭参考详情" className="wm-workbench wm-ref-detail-dialog" footer={<><Button className="wm-native-button" variant="outline" onClick={() => model.closeDetail()}>关闭</Button>{listItem && <Button className="wm-native-button" variant={selected ? "outline" : "primary"} disabled={!!state.agentBusy || !selected && state.selected.length >= 5} onClick={() => model.toggle(listItem.id)}>{selected ? "移出本次参考" : "加入本次参考"}</Button>}</>}><style>{workbenchStyles}{referenceLibraryStyles}</style><div ref={ref} className="wm-ref-detail" tabIndex={-1} aria-busy={state.detailLoading}>{state.detailLoading ? <p role="status">正在读取完整参考内容…</p> : state.detailError ? <div role="alert"><p>{state.detailError.text}</p><Button className="wm-native-button" onClick={() => state.focusedId && void model.openDetail(state.focusedId)}>重新读取</Button></div> : item && <><h3>{item.title}</h3><div className="wm-ref-detail-meta"><span>{platformLabels[item.platform]}</span><span>{item.author || "作者未知"}</span><span>{kindLabels[item.kind]}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">打开原文 ↗</a>}</div><p className="wm-ref-hint">发布于 {timeLabel(item.publishedAt)} · 采集于 {timeLabel(item.collectedAt)}</p>{item.completeness === "partial" && <p className="wm-ref-detail-warning">当前为部分采集内容；分析和创作时需要核对原文缺失的部分。</p>}{!!item.tags.length && <div className="wm-ref-detail-tags">{item.tags.map(tag => <span key={tag} className="wm-ref-badge">{tag}</span>)}</div>}{!!item.media.length && <p className="wm-ref-detail-media">已记录 {item.media.filter(media => media.kind === "image").length} 张图片、{item.media.filter(media => media.kind === "video").length} 段视频的来源。可打开原文查看媒体。</p>}<div className="wm-ref-fulltext">{item.text || "这篇内容没有可读取的正文。请打开原文核对。"}</div></>}</div></Modal>;
}

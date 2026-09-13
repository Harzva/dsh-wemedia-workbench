import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Channel, ContentRef } from "../domain/primitives.ts";
import type { ContentMappingView, MappingApplyResult, MappingChangeInput, MappingOperation, MappingPreview, MappingSourceView } from "../domain/contentMapping.ts";
import { ClientFault, type WorkbenchController } from "./controller.ts";
import { publicationChannelLabel } from "./publication.tsx";
import { useDialogFocus } from "./interactions.ts";
import { workbenchStyles } from "./styles.ts";

export interface MappingViewState {
  view: ContentMappingView | null; sources: MappingSourceView[]; known: MappingSourceView[]; query: string;
  selected: string[]; retained: string[]; operation: MappingOperation; channel: Channel;
  preview: MappingPreview | null; reading: boolean; previewing: boolean; applying: boolean; error: string | null; notice: string | null;
}
export const mappingOperationLabels: Record<MappingOperation, string> = { select_canonical: "选择主稿", map_variant: "关联渠道版本", bind: "绑定为同一文章", separate: "分离文章身份" };

/** Mapping edits are explicit local intents; source text stays in the Host's read-only roots. */
export class MappingViewController {
  private state: MappingViewState = { view: null, sources: [], known: [], query: "", selected: [], retained: [], operation: "select_canonical", channel: "wechat", preview: null, reading: false, previewing: false, applying: false, error: null, notice: null };
  private listeners = new Set<() => void>(); private requests = new Map<string, AbortController>(); private stopped = false;
  constructor(readonly contentRef: ContentRef, private readonly request: WorkbenchController["requestContent"]) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(update: Partial<MappingViewState>) { if (this.stopped) return; this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(); }
  private owner(key: string) { this.requests.get(key)?.abort(); const owner = new AbortController(); this.requests.set(key, owner); return owner; }
  private current(key: string, owner: AbortController) { return !this.stopped && !owner.signal.aborted && this.requests.get(key) === owner; }
  private fail(error: unknown) { return error instanceof ClientFault ? error.message : "来源关系操作未完成，请刷新后重试。"; }
  dispose() { this.stopped = true; for (const request of this.requests.values()) request.abort(); this.requests.clear(); this.listeners.clear(); }
  discardPreview() { this.requests.get("preview")?.abort(); this.patch({ preview: null, previewing: false, error: null, notice: null }); }
  setOperation(operation: MappingOperation) { this.discardPreview(); this.patch({ operation, selected: [], retained: [] }); }
  setChannel(channel: Channel) { this.discardPreview(); this.patch({ channel }); }
  select(sourceRecordId: string, checked: boolean) {
    if (!this.state.known.some(source => source.sourceRecordId === sourceRecordId)) return;
    this.discardPreview();
    const previous = this.state.selected.filter(id => id !== sourceRecordId), single = ["select_canonical", "map_variant"].includes(this.state.operation);
    const selected = checked ? single ? [sourceRecordId] : previous.length < 50 ? [...previous, sourceRecordId] : this.state.selected : previous;
    this.patch({ selected, retained: this.state.retained.filter(id => selected.includes(id)) });
  }
  retain(sourceRecordId: string, checked: boolean) { if (!this.state.selected.includes(sourceRecordId)) return; this.discardPreview(); this.patch({ retained: checked ? [...new Set([...this.state.retained, sourceRecordId])] : this.state.retained.filter(id => id !== sourceRecordId) }); }
  selectLoadedBound() { this.discardPreview(); this.patch({ selected: this.state.sources.filter(source => source.contentRef === this.contentRef).slice(0, 50).map(source => source.sourceRecordId), retained: [] }); }
  async search(query: string): Promise<void> { this.discardPreview(); this.patch({ query: query.trim().slice(0, 500), sources: [] }); await this.inspect(); }
  async inspect(append = false): Promise<void> {
    if (this.stopped || append && !this.state.view?.nextCursor) return;
    const owner = this.owner("inspect"), previous = this.state.view;
    this.patch({ reading: true, error: null });
    try {
      const view = await this.request<ContentMappingView>({ operation: "mapping_inspect", contentRef: this.contentRef, ...(this.state.query ? { query: this.state.query } : {}), ...(append && previous?.nextCursor ? { cursor: previous.nextCursor } : {}), pageSize: 40 }, owner.signal);
      if (!this.current("inspect", owner)) return;
      if (append && previous && (view.revision !== previous.revision || view.generationId !== previous.generationId)) { await this.inspect(); return; }
      const sources = append ? [...new Map([...this.state.sources, ...view.sources].map(source => [source.sourceRecordId, source])).values()] : view.sources;
      this.patch({ view, sources, known: [...new Map([...this.state.known, ...view.sources].map(source => [source.sourceRecordId, source])).values()], ...(previous && (view.revision !== previous.revision || view.generationId !== previous.generationId) ? { preview: null } : {}) });
    } catch (error) {
      if (this.current("inspect", owner)) {
        if (append && error instanceof ClientFault && error.code === "CURSOR_STALE") { await this.inspect(); return; }
        this.patch({ error: this.fail(error) });
      }
    } finally { if (this.current("inspect", owner)) { this.requests.delete("inspect"); this.patch({ reading: false }); } }
  }
  get validSelection(): boolean {
    const { operation, selected, retained, view } = this.state;
    if (!selected.length) return false;
    if (operation === "select_canonical") return selected.length === 1 && this.state.known.find(source => source.sourceRecordId === selected[0])?.contentRef === this.contentRef;
    if (operation === "map_variant") return selected.length === 1 && !!view?.canonical && view.canonical.available && !view.canonical.stale;
    if (operation === "bind") return selected.length >= 2 && selected.some(id => this.state.known.find(source => source.sourceRecordId === id)?.contentRef === this.contentRef);
    return selected.length >= 2 && retained.length > 0 && retained.length < selected.length && (!view?.canonical || retained.includes(view.canonical.sourceRecordId));
  }
  async preview(): Promise<void> {
    if (!this.validSelection || this.state.applying || this.stopped) return;
    const owner = this.owner("preview"), change: MappingChangeInput = { contentRef: this.contentRef, operation: this.state.operation, sourceRecordIds: [...this.state.selected], ...(this.state.operation === "map_variant" ? { channel: this.state.channel } : {}), ...(this.state.operation === "separate" ? { retainedSourceRecordIds: [...this.state.retained] } : {}) };
    this.patch({ previewing: true, preview: null, error: null, notice: null });
    try { const preview = await this.request<MappingPreview>({ operation: "mapping_preview", change }, owner.signal); if (this.current("preview", owner)) this.patch({ preview }); }
    catch (error) { if (this.current("preview", owner)) this.patch({ error: this.fail(error) }); }
    finally { if (this.current("preview", owner)) { this.requests.delete("preview"); this.patch({ previewing: false }); } }
  }
  async apply(): Promise<boolean> {
    const preview = this.state.preview;
    if (!preview || this.state.applying || this.stopped) return false;
    if (preview.contentRef !== this.contentRef || preview.operation !== this.state.operation || preview.sideEffect !== "local_write" || preview.generationId !== this.state.view?.generationId || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) { this.patch({ preview: null, error: "来源关系预览已失效，请重新预览。" }); return false; }
    const owner = this.owner("apply"); this.patch({ applying: true, preview: null, error: null, notice: null });
    try {
      const result = await this.request<MappingApplyResult>({ operation: "mapping_apply", intentId: preview.intentId }, owner.signal);
      if (!this.current("apply", owner)) return false;
      this.patch({ selected: [], retained: [], query: "", notice: "来源关系已提交，正在回读核对。" }); await this.inspect();
      if (this.current("apply", owner)) this.patch({ notice: this.state.view && this.state.view.revision >= result.revision ? "来源关系已保存并回读核对。" : "来源关系已提交，尚需刷新核对当前状态。" });
      return true;
    } catch (error) { if (this.current("apply", owner)) this.patch({ error: this.fail(error), notice: "未自动重试，请先刷新核对当前来源关系。" }); return false; }
    finally { if (this.current("apply", owner)) { this.requests.delete("apply"); this.patch({ applying: false }); } }
  }
}

export const mappingStyles = `.wm-mapping-dialog{width:min(880px,calc(100vw - 24px));max-height:92vh}.wm-mapping-body{min-width:0;display:flex;flex-direction:column;gap:16px}.wm-mapping-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.wm-mapping-overview>section{padding:12px;border:1px solid var(--wm-border);border-radius:8px;min-width:0}.wm-mapping-overview h4{font-size:12px;margin:0 0 5px}.wm-mapping-overview p{font-size:11px;line-height:1.7;overflow-wrap:anywhere}.wm-mapping-search{display:flex;gap:8px}.wm-mapping-search input{min-width:0;flex:1}.wm-mapping-sources{display:flex;flex-direction:column;gap:6px;max-height:250px;overflow:auto}.wm-mapping-source{display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid var(--wm-border);border-radius:7px}.wm-mapping-source input{width:auto;flex:none;margin-top:3px}.wm-mapping-source>span{display:flex;flex-direction:column;gap:4px;min-width:0}.wm-mapping-source strong{font-size:12px;overflow-wrap:anywhere}.wm-mapping-source small{font-size:11px;color:var(--wm-muted);overflow-wrap:anywhere}.wm-mapping-preview{padding:14px;border:1px solid var(--wm-border);border-radius:8px}.wm-mapping-preview li{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.wm-mapping-retained{display:flex;flex-direction:column;gap:8px}.wm-mapping-retained label{display:flex;align-items:center;gap:8px;font-size:12px}.wm-mapping-retained input{width:auto}.wm-mapping-body .wm-row{flex-wrap:wrap}.wm-mapping-body select{min-width:0;max-width:100%}@media(max-width:500px){.wm-mapping-overview{grid-template-columns:minmax(0,1fr)}.wm-mapping-sources{max-height:210px}}`;

export function MappingPanel({ manager, disabled = false, onApplied }: { manager: MappingViewController; disabled?: boolean; onApplied?: () => void }): ReactNode {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const [query, setQuery] = useState(state.query);
  const locked = disabled || state.applying || state.previewing;
  const label = (id: string) => state.known.find(source => source.sourceRecordId === id)?.title ?? "尚未加载的来源";
  const retained = state.selected.flatMap(id => { const source = state.known.find(value => value.sourceRecordId === id); return source ? [source] : []; });
  return <div className="wm-mapping-body"><style>{mappingStyles}</style><div className="wm-row wm-between"><p className="wm-small wm-muted">明确主稿及各渠道版本的来源，原始正文不被改写。</p><Button size="sm" disabled={locked || state.reading} onClick={() => void manager.inspect()}>刷新来源关系</Button></div>{state.view && <><div className="wm-mapping-overview"><section><h4>当前主稿</h4><p>{state.view.canonical ? label(state.view.canonical.sourceRecordId) : "尚未选择"}</p>{state.view.canonical && <p>{!state.view.canonical.available ? "来源不可用" : state.view.canonical.stale ? "主稿已变化，需要重新确认" : "来源版本一致"}</p>}</section>{state.view.variants.map(variant => <section key={variant.channel}><h4>{publicationChannelLabel(variant.channel)}版本</h4><p>{label(variant.sourceRecordId)}</p><p>{!variant.available ? "来源不可用" : variant.dirty ? "版本正文已修改" : "正文与登记时一致"}</p><p>{variant.stale ? "主稿已变化，来源关系需复核" : "主稿来源一致"}</p></section>)}</div>{(state.view.conflicts.length > 0 || state.view.revalidationRequired) && <section className="wm-inline-note"><strong>来源身份需要核对</strong><p className="wm-small">{state.view.conflicts.length} 组冲突；{state.view.revalidationRequired ? "历史人工关联需要重新验证。" : "可选择绑定或分离，先查看精确变更。"}</p><details><summary>冲突依据</summary><ul>{state.view.conflicts.map((conflict, index) => <li key={index}>{label(conflict.leftRecordId)} / {label(conflict.rightRecordId)} · {conflict.evidenceCodes.join("、")}</li>)}</ul></details></section>}</>}<div className="wm-grid"><label className="wm-stack">关系操作<select aria-label="来源关系操作" value={state.operation} disabled={locked} onChange={event => manager.setOperation(event.target.value as MappingOperation)}>{Object.entries(mappingOperationLabels).map(([operation, label]) => <option key={operation} value={operation}>{label}</option>)}</select></label>{state.operation === "map_variant" && <label className="wm-stack">渠道<select aria-label="关联版本渠道" value={state.channel} disabled={locked} onChange={event => manager.setChannel(event.target.value as Channel)}>{(["wechat", "zhihu", "xiaohongshu", "x"] as Channel[]).map(channel => <option key={channel} value={channel}>{publicationChannelLabel(channel)}</option>)}</select></label>}</div><p className="wm-small wm-muted">{state.operation === "select_canonical" ? "选择已属于当前文章的一份来源作为主稿。" : state.operation === "map_variant" ? "先确定未过期的主稿，再选择渠道版本来源。" : state.operation === "bind" ? "勾选至少两份来源，其中须有当前文章的来源。" : "分离须包含当前全部来源，并明确保留组；需要时加载更多，预览会核对完整性。"}</p><form className="wm-mapping-search" onSubmit={event => { event.preventDefault(); void manager.search(query); }}><input aria-label="搜索文章来源" placeholder="搜索标题或目录标签" value={query} disabled={locked} onChange={event => setQuery(event.target.value)} /><Button type="submit" disabled={locked}>搜索</Button></form>{state.operation === "separate" && <Button size="sm" disabled={locked} onClick={() => manager.selectLoadedBound()}>勾选已加载的当前来源</Button>}<div className="wm-mapping-sources" aria-label="文章来源候选" aria-busy={state.reading}>{state.sources.map(source => <label key={source.sourceRecordId} className="wm-mapping-source"><input type="checkbox" aria-label={`选择来源：${source.title} · ${source.rootLabel}`} checked={state.selected.includes(source.sourceRecordId)} disabled={locked || (state.operation === "select_canonical" || state.operation === "separate") && source.contentRef !== manager.contentRef || state.selected.length >= 50 && !state.selected.includes(source.sourceRecordId)} onChange={event => manager.select(source.sourceRecordId, event.target.checked)} /><span><strong>{source.title || "未命名来源"}</strong><small>{source.rootLabel} · {source.contentRef === manager.contentRef ? "当前文章" : source.contentRef ? "其他文章身份" : "尚未关联"}</small><small title={source.digest}>来源版本 {source.digest.slice(-12)}</small></span></label>)}{!state.sources.length && !state.reading && <p className="wm-small wm-muted">没有匹配的文章来源。</p>}{state.reading && <p role="status">正在读取文章来源…</p>}{state.view?.nextCursor && <Button disabled={state.reading || locked} onClick={() => void manager.inspect(true)}>加载更多来源</Button>}</div><p className="wm-small wm-muted">已勾选 {state.selected.length} / 50 份来源</p>{state.operation === "separate" && retained.length > 0 && <section className="wm-mapping-retained" aria-label="保留原文章身份的来源"><strong>明确保留原文章身份的一组来源</strong>{retained.map(source => <label key={source.sourceRecordId}><input type="checkbox" checked={state.retained.includes(source.sourceRecordId)} disabled={locked} onChange={event => manager.retain(source.sourceRecordId, event.target.checked)} />{source.title}{source.sourceRecordId === state.view?.canonical?.sourceRecordId ? "（当前主稿须保留）" : ""}</label>)}</section>}<Button disabled={locked || state.reading || !manager.validSelection} onClick={() => void manager.preview()}>{state.previewing ? "正在预览关系变更…" : "预览来源关系变更"}</Button>{state.preview && <section className="wm-mapping-preview wm-stack" aria-label="来源关系变更预览"><h4>{mappingOperationLabels[state.preview.operation]}</h4><ul>{state.preview.expectedChanges.map((change, index) => <li key={index}>{change}</li>)}</ul><ul>{state.preview.sources.map(source => <li key={source.sourceRecordId}>{source.title} · {source.rootLabel}</li>)}</ul><Button variant="primary" disabled={state.applying || disabled} onClick={() => void manager.apply().then(applied => { if (applied) onApplied?.(); })}>确认保存来源关系</Button></section>}{state.notice && <p role="status" className="wm-inline-note">{state.notice}</p>}{state.error && <p role="alert" className="wm-error">{state.error}</p>}</div>;
}

export function MappingView({ controller, contentRef, onClose }: { controller: WorkbenchController; contentRef: ContentRef; onClose: () => void }): ReactNode {
  const host = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [manager] = useState(() => new MappingViewController(contentRef, (request, signal) => controller.requestContent(request, signal)));
  const ref = useRef<HTMLDivElement>(null); useDialogFocus(ref, true);
  useEffect(() => () => manager.dispose(), [manager]);
  useEffect(() => { if (host.connected) void manager.inspect(); }, [manager, host.connected, host.snapshot?.generationId]);
  return <Modal open title="主稿与渠道来源" onClose={onClose} closeLabel="关闭来源关系" className="wm-workbench wm-mapping-dialog"><style>{workbenchStyles}{mappingStyles}</style><div ref={ref} tabIndex={-1}><MappingPanel manager={manager} disabled={!host.connected || controller.dirty} onApplied={() => void controller.refresh()} /></div></Modal>;
}

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { LibraryItem } from "../domain/contentLibrary.ts";
import type { ContentRef } from "../domain/primitives.ts";
import { CONTENT_SELECTION_LIMIT, contentCategory, contentFilterCount, type ContentLibraryCategory, type ContentLibraryDatePreset, type ContentLibraryPublicationStatus, type ContentLibraryState, type ContentLibraryController } from "./content-library-controller.ts";
import { contentLibraryStyles } from "./content-library-styles.ts";
import { inertPreview } from "./preview.ts";
import { PublicationBadge, PublicationStatusPanel, publicationStatusLabel, publicationStyles, publicationChannelLabel } from "./publication.tsx";
import { ArticleTaxonomyChips, articleCategoryLabel, taxonomyStyles } from "./taxonomy.tsx";
import { ContentBatchBar, contentBatchStyles } from "./content-batch.tsx";
import type { Channel } from "../domain/primitives.ts";
import type { DraftBatchScope, WorkbenchController } from "./controller.ts";

export { ContentLibraryController } from "./content-library-controller.ts";
export type { ContentLibraryState, ContentLibraryRequest, ContentLibraryRequestFn } from "./content-library-controller.ts";

const kinds: Array<[ContentLibraryCategory, string]> = [["all", "全部"], ["article", "文章"], ["video", "视频"], ["image_text", "图文"], ["image", "图像"]];
const publicationStatuses: Array<[ContentLibraryPublicationStatus, string]> = [["all", "全部状态"], ["draft", "草稿"], ["ready", "待发布"], ["published", "已发布"], ["unknown", "状态未知"]];
const datePresets: Array<[ContentLibraryDatePreset, string]> = [["all", "不限时间"], ["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["custom", "自定义日期"]];
export const contentKindLabel = (kind: LibraryItem["kind"]): string => kinds.find(([value]) => value === kind)?.[1] ?? "内容";
export const contentBytesLabel = (bytes: number | null): string => bytes === null ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export const contentPublicationLabel = (item: LibraryItem): string => item.publicationType === "image_text" ? "图文" : item.kind === "image" ? "图像素材" : item.kind === "video" && item.origin === "local" ? "视频素材" : contentKindLabel(item.kind);
export const contentStatusLabel = (item: LibraryItem): string => publicationStatusLabel(item.publicationStatus);
export function contentUpdatedLabel(value: string | null): string {
  if (!value) return "更新时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "更新时间未知" : `更新于 ${date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}`;
}
export function contentEmptyMessage(state: ContentLibraryState): string {
  if (state.publicationType === "image_text" && !state.query && state.publicationStatus === "all" && state.channel === "all" && !state.updatedFrom && !state.updatedTo && state.category === "all" && !state.conference && state.year === "all" && !state.tag) return "尚无图文作品，单张图片属于图像素材。";
  if (state.publicationStatus === "published") return "没有匹配的已发布内容。只有确认发布成功的作品才会标记为已发布。";
  if (contentFilterCount(state)) return "没有符合这些条件的内容。调整筛选条件或清空筛选，当前打开的内容会保留。";
  return "还没有内容。将文章、图像或视频放入已配置的内容目录，再点击刷新。";
}

function ContentIcon({ kind }: { kind?: LibraryItem["kind"] | "search" }): ReactNode {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "video" ? <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></> : kind === "image" ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 5" /></> : kind === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></> : <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>}</svg>;
}

export interface ContentLibrarySidebarProps {
  controller: ContentLibraryController;
  workbench?: WorkbenchController;
  onSelect?: ((item: LibraryItem, select: () => void) => void) | undefined;
  onCreateArticle?: (() => void) | undefined;
  onDraftBatch?: ((scope: DraftBatchScope, contentRefs?: ContentRef[]) => void) | undefined;
}

export function ContentLibrarySidebar({ controller, workbench, onSelect, onCreateArticle, onDraftBatch }: ContentLibrarySidebarProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [query, setQuery] = useState(state.query);
  const [draftBatchOpen, setDraftBatchOpen] = useState(false);
  const filterCount = contentFilterCount(state);
  const timeLabel = state.timeField === "created" ? "创建" : state.timeField === "published" ? "发布" : "更新";
  useEffect(() => setQuery(state.query), [state.query]);
  useEffect(() => {
    if (query.trim() === state.query) return;
    const timer = setTimeout(() => { void controller.search(query); }, 200);
    return () => clearTimeout(timer);
  }, [controller, query, state.query]);
  const launchDraftBatch = (scope: DraftBatchScope, refs?: ContentRef[]): void => { setDraftBatchOpen(true); if (workbench) void workbench.listDraftBatches(); onDraftBatch?.(scope, refs); };
  return <aside className="wm-content wm-content-sidebar" aria-label="内容库"><style>{contentLibraryStyles}{publicationStyles}{taxonomyStyles}{contentBatchStyles}</style>
    <header className="wm-content-sidehead"><h2>内容<span className="wm-content-count">{state.total}</span></h2><div className="wm-content-actions"><Button variant="toolbar" size="sm" aria-label="刷新内容库" title="重新发现本地内容" disabled={!state.connected || state.listLoading} onClick={() => { void controller.refresh(); }}>↻</Button>{workbench && onDraftBatch && <Button size="sm" variant="outline" aria-label="发送待发送文章" title="预览当前所有待发送文章" disabled={!state.connected || workbench.dirty} onClick={() => launchDraftBatch("pending")}>发送待发送文章</Button>}{onCreateArticle && <Button variant="toolbar" size="sm" aria-label="新建内容" title="新建文章、视频或图文" onClick={onCreateArticle}>＋</Button>}</div></header>
    <nav className="wm-content-filters" aria-label="发布类型与图像素材">{kinds.map(([kind, label]) => <button key={kind} type="button" title={kind === "image" ? "图像素材" : kind === "image_text" ? "图文作品" : label} aria-pressed={contentCategory(state) === kind} onClick={() => { void controller.setCategory(kind); }}>{label}</button>)}</nav>
    <form className="wm-content-search" role="search" onSubmit={event => { event.preventDefault(); void controller.search(query); }}><ContentIcon kind="search" /><input aria-label="搜索内容" placeholder="搜索内容…" value={query} onChange={event => setQuery(event.target.value)} /></form>
    <label className="wm-content-categoryfield"><span>文章分类</span><select aria-label="文章分类" value={state.category} onChange={event => { void controller.setArticleCategory(event.target.value as ContentLibraryState["category"]); }}><option value="all">全部分类</option>{state.facets.categories.map(facet => <option key={facet.value} value={facet.value}>{articleCategoryLabel(facet.value)} · {facet.count}</option>)}{state.category !== "all" && !state.facets.categories.some(facet => facet.value === state.category) && <option value={state.category}>{articleCategoryLabel(state.category)}（当前筛选）</option>}</select></label>
    <div className="wm-content-filtertools"><details className="wm-content-advanced"><summary>筛选{filterCount > 0 && <span className="wm-content-filtercount" aria-label={`${filterCount} 项筛选已生效`}>{filterCount}</span>}</summary><div className="wm-content-filterfields">
      <label><span>会议</span><select aria-label="会议" value={state.conference} onChange={event => { void controller.setConference(event.target.value); }}><option value="">全部会议</option>{state.facets.conferences.map(facet => <option key={facet.value} value={facet.value}>{facet.value} · {facet.count}</option>)}{state.conference && !state.facets.conferences.some(facet => facet.value === state.conference) && <option value={state.conference}>{state.conference}（当前筛选）</option>}</select></label>
      <label><span>年份</span><select aria-label="来源年份" value={state.year} onChange={event => { void controller.setYear(event.target.value === "all" ? "all" : Number(event.target.value)); }}><option value="all">全部年份</option>{state.facets.years.map(facet => <option key={facet.value} value={facet.value}>{facet.value} · {facet.count}</option>)}{state.year !== "all" && !state.facets.years.some(facet => facet.value === state.year) && <option value={state.year}>{state.year}（当前筛选）</option>}</select></label>
      <label><span>主题标签</span><select aria-label="主题标签" value={state.tag} onChange={event => { void controller.setTag(event.target.value); }}><option value="">全部标签</option>{state.facets.tags.map(facet => <option key={facet.value} value={facet.value}>{facet.value} · {facet.count}</option>)}{state.tag && !state.facets.tags.some(facet => facet.value === state.tag) && <option value={state.tag}>{state.tag}（当前筛选）</option>}</select></label>
      <p className="wm-content-filterhint">分类与标签统计整个文章库，筛选条件同时生效。</p>
      <label><span>时间依据</span><select aria-label="时间依据" value={state.timeField} onChange={event => { void controller.setTimeField(event.target.value as ContentLibraryState["timeField"]); }}><option value="updated">更新时间</option><option value="created">创建时间</option><option value="published">正式发布时间</option></select></label>
      <label><span>日期范围</span><select aria-label={`${timeLabel}时间范围`} value={state.datePreset} onChange={event => { void controller.setDateRange(event.target.value as ContentLibraryDatePreset, state.dateFrom, state.dateTo); }}>{datePresets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {state.datePreset === "custom" && <div className="wm-content-daterange"><label><span>开始日期</span><input type="date" aria-label={`${timeLabel}开始日期`} value={state.dateFrom} onChange={event => { void controller.setDateRange("custom", event.target.value, state.dateTo); }} /></label><label><span>结束日期</span><input type="date" aria-label={`${timeLabel}结束日期`} value={state.dateTo} onChange={event => { void controller.setDateRange("custom", state.dateFrom, event.target.value); }} /></label></div>}
      {state.filterError && <p className="wm-content-filtererror" role="alert">{state.filterError} 当前列表仍按上一次有效日期筛选。</p>}
      <label><span>渠道</span><select aria-label="按渠道筛选" value={state.channel} onChange={event => { void controller.setChannel(event.target.value as ContentLibraryState["channel"]); }}><option value="all">全部渠道</option>{(["wechat", "zhihu", "xiaohongshu", "x"] as Channel[]).map(channel => <option value={channel} key={channel}>{publicationChannelLabel(channel)}</option>)}</select></label>
      <label><span>发布状态</span><select aria-label="发布状态" value={state.publicationStatus} onChange={event => { void controller.setPublicationStatus(event.target.value as ContentLibraryPublicationStatus); }}>{publicationStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>排序</span><select aria-label={`按${timeLabel}时间排序`} value={state.sort} onChange={event => { void controller.setSort(event.target.value as ContentLibraryState["sort"]); }}><option value="updated_desc">{`最近${timeLabel}优先`}</option><option value="updated_asc">{`最早${timeLabel}优先`}</option></select></label>
      <p className="wm-content-filterhint">日期按本地时区筛选{timeLabel}时间，缺少对应时间的内容不匹配日期范围。</p>
    </div></details>{(filterCount > 0 || state.sort !== "updated_desc" || state.timeField !== "updated" || state.filterError) && <button className="wm-content-clearfilters" type="button" onClick={() => { setQuery(""); void controller.clearFilters(); }}>清空筛选</button>}</div>
    <div className="wm-content-list" aria-label="内容列表" aria-busy={state.listLoading}>
      {state.items.map(item => <div className="wm-content-itemrow" key={item.itemId}>{(item.publicationRef || item.contentRef) && <input type="checkbox" className="wm-content-itemcheck" aria-label={`勾选检查：${item.title}`} checked={state.checked.some(value => value.contentRef === (item.publicationRef ?? item.contentRef))} disabled={state.checked.length >= CONTENT_SELECTION_LIMIT && !state.checked.some(value => value.contentRef === (item.publicationRef ?? item.contentRef))} onChange={event => controller.toggleChecked(item, event.target.checked)} />}<button className="wm-content-item" aria-current={state.selected === item.itemId ? "true" : undefined} onClick={() => { const select = (): void => { void controller.select(item.itemId); }; if (onSelect) onSelect(item, select); else select(); }}><span className="wm-content-thumb" data-kind={item.kind}>{item.kind === "image" && item.itemId === state.selected && state.mediaUrl ? <img src={state.mediaUrl} alt="" /> : <ContentIcon kind={item.kind} />}</span><span className="wm-content-itemcopy"><span className="wm-content-itemtitle">{item.title || "未命名内容"}</span><span className="wm-content-itemmeta"><span className="wm-content-type">{contentPublicationLabel(item)}</span>{item.kind === "image" ? <span>{contentBytesLabel(item.bytes) || "本地文件"}</span> : <PublicationBadge status={item.publicationStatus} />}{item.readOnly && (item.kind === "article" || !!item.publicationRef) && <span>{item.legacyReadOnly ? "旧稿只读" : "只读"}</span>}</span>{item.publicationType === "article" && <ArticleTaxonomyChips taxonomy={item.taxonomy} compact />}<span className="wm-content-itemmeta" title={item.rootLabel}><span>{contentUpdatedLabel(item.updatedAt)}</span></span></span></button></div>)}
      {!state.connected ? <div className="wm-content-listnotice" role="status"><p>正在连接内容服务…</p></div> : state.listError ? <div className="wm-content-listnotice" role="alert"><p>{state.listError}</p><Button size="sm" onClick={() => { void controller.refresh(); }}>重试</Button></div> : !state.items.length && !state.listLoading ? <div className="wm-content-listnotice" role="status"><p>{contentEmptyMessage(state)}</p>{!filterCount && onCreateArticle && <Button size="sm" onClick={onCreateArticle}>新建内容</Button>}</div> : null}
      {state.listLoading && <div className="wm-content-listnotice" role="status"><p>正在读取内容…</p><Button size="sm" variant="toolbar" onClick={() => controller.cancelSearch()}>取消</Button></div>}
      {state.nextCursor && !state.listLoading && <div className="wm-content-listfooter"><Button size="sm" variant="toolbar" onClick={() => { void controller.loadMore(); }}>加载更多</Button></div>}
    </div><ContentBatchBar controller={controller} workbench={workbench} draftOpen={draftBatchOpen} onDraftOpenChange={setDraftBatchOpen} onDraftBatch={(scope, refs) => launchDraftBatch(scope, refs)} />{!!state.issues.length && <details className="wm-content-listnote"><summary>内容目录提示 · {state.issues.length}</summary><ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}<p className="wm-content-listnote">{state.truncated ? "部分内容" : "本地内容"} · {state.items.length}{state.total > state.items.length ? ` / ${state.total}` : ""} 项{state.truncated ? " · 扫描达到上限" : ""}</p>
  </aside>;
}

/** The first policy precedes all untrusted markup; a later policy cannot relax it. */
export function contentPreviewDocument(html: string): string {
  if (typeof document !== "undefined") return inertPreview(html);
  // SSR never needs interactive article markup. Escape it when no inert DOM parser exists.
  const text = html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><pre>${text}</pre>`;
}

export function ContentLibraryDetail({ controller, onOpenArticle, onOpenMapping, active = true }: { controller: ContentLibraryController; onOpenArticle: (contentRef: ContentRef) => void; onOpenMapping?: (contentRef: ContentRef) => void; active?: boolean }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [mediaFailed, setMediaFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => () => controller.cancelPreview(), [controller]);
  useEffect(() => {
    if (active) return;
    video.current?.pause();
    // Keep completed media available when switching tools, but stop pending reads.
    if (state.detailLoading) controller.cancelPreview();
  }, [active, controller, state.detailLoading, state.mediaUrl]);
  useEffect(() => { setMediaFailed(false); }, [state.selected, state.mediaUrl]);
  const detail = state.detail;
  const item = detail?.item ?? state.items.find(candidate => candidate.itemId === state.selected);
  const retry = (): void => { if (state.selected) { setMediaFailed(false); void controller.select(state.selected); } };
  let body: ReactNode;
  if (!state.selected) body = <div className="wm-content-placeholder"><ContentIcon /><h3>选择一份内容</h3><p>从左侧打开文章、图像或视频。文章可以继续编辑，图像与视频可以直接预览。</p></div>;
  else if (state.detailLoading) body = <div className="wm-content-placeholder" role="status"><h3>{state.mediaTotalBytes ? "正在加载媒体" : "正在打开内容"}</h3>{state.mediaTotalBytes > 0 && <><progress className="wm-content-progress" max={state.mediaTotalBytes} value={state.mediaLoadedBytes} aria-label="媒体加载进度" /><p>{contentBytesLabel(state.mediaLoadedBytes)} / {contentBytesLabel(state.mediaTotalBytes)}</p></>}<Button size="sm" onClick={() => controller.cancelPreview()}>取消加载</Button></div>;
  else if (state.detailError || mediaFailed) body = <div className="wm-content-placeholder" role="alert"><h3>暂时无法预览</h3><p>{state.detailError ?? "浏览器无法解码这个媒体文件。可以重新加载，或使用本地播放器查看。"}</p><Button onClick={retry}>重新加载</Button></div>;
  else if (state.cancelled) body = <div className="wm-content-placeholder"><h3>已取消加载</h3><Button onClick={retry}>重新加载</Button></div>;
  else if (detail?.item.kind === "article" && detail.item.contentRef && !detail.item.legacyReadOnly) body = <div className="wm-content-placeholder"><ContentIcon /><h3>{detail.item.title}</h3><p>在文章编辑器里继续写作、查看版本和准备公众号草稿。</p><Button variant="primary" onClick={() => onOpenArticle(detail.item.contentRef!)}>打开文章编辑器</Button></div>;
  else if (detail?.item.kind === "article") body = <><div className="wm-content-readnote"><span>旧稿只读预览</span><span>保留原始文件</span></div>{detail.html ? <iframe className="wm-content-preview" title={`${detail.item.title} · 只读预览`} sandbox="" referrerPolicy="no-referrer" srcDoc={contentPreviewDocument(detail.html)} /> : <pre className="wm-content-markdown">{detail.markdown || "这份文章暂无可预览的正文。"}</pre>}</>;
  else if (detail && state.mediaUrl) body = <div className="wm-content-media">{detail.item.kind === "image" ? <img src={state.mediaUrl} alt={detail.item.title} onError={() => setMediaFailed(true)} /> : <video ref={video} key={state.mediaUrl} src={state.mediaUrl} controls preload="metadata" playsInline onError={() => setMediaFailed(true)}>当前浏览器不支持这个视频格式。</video>}</div>;
  else body = <div className="wm-content-placeholder" role="status"><p>{state.connected ? "内容尚未加载。" : "正在等待内容服务连接…"}</p>{state.connected && <Button onClick={retry}>加载内容</Button>}</div>;
  return <section className="wm-content wm-content-detail" aria-label="内容详情"><style>{contentLibraryStyles}{publicationStyles}{taxonomyStyles}{contentBatchStyles}</style>{item && <header className="wm-content-detailhead"><div><h2>{item.title || "未命名内容"}</h2><div className="wm-content-detailmeta"><span className="wm-content-badge">{contentPublicationLabel(item)}</span>{item.kind !== "image" && <PublicationBadge status={item.publicationStatus} />}<span>{contentUpdatedLabel(item.updatedAt)}</span><span>{item.rootLabel}</span>{item.bytes !== null && <span>{contentBytesLabel(item.bytes)}</span>}{item.readOnly && <span>只读</span>}</div>{item.kind === "article" && <>{item.publicationType === "article" && <ArticleTaxonomyChips taxonomy={item.taxonomy} />}<PublicationStatusPanel status={item.publicationStatus} records={item.publications} /></>}</div><div className="wm-content-actions">{item.mappingRef && onOpenMapping && <Button variant="toolbar" size="sm" onClick={() => onOpenMapping(item.mappingRef!)}>主稿与来源</Button>}<Button variant="toolbar" size="sm" aria-label="关闭当前内容" onClick={() => controller.clearSelection()}>×</Button></div></header>}<div className="wm-content-detailbody">{body}</div>{!!detail?.issues.length && <details className="wm-content-issues"><summary>内容提示 · {detail.issues.length}</summary><ul>{detail.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}</section>;
}

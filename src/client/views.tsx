import { WechatDraftGuide } from "./wechat-draft-guide.tsx";
import { ReferenceLibrary } from "./reference-library.tsx";
import { VersionHistoryView, CoverageSummary, EvidenceReader } from "./inspection.tsx";
import React, { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button, DiffBlock, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ActionIntent, GateReport } from "../domain/capability.ts";
import type { ArtifactRef } from "../domain/content.ts";
import type { WorkbenchAction, WorkbenchJob, WorkflowImportKind, WorkflowImportPreview } from "../domain/workbench.ts";
import { terminalJob, type ClientState, type CreateInput, type View, type WorkbenchController } from "./controller.ts";
import { ArticleMaterials, ArticleReviews } from "./evidence.tsx";
import { defaultWorkflowImportArtifact, relativeArtifactLabel } from "./evidence-model.ts";
import { useDialogFocus, useJobStatusTracking } from "./interactions.ts";
import { actionLabels, attentionJob, displayTime, editDiffs, shortId, statusLabel } from "./presentation.ts";
import { workbenchStyles } from "./styles.ts";
import { inertPreview } from "./preview.ts";
import { PublicationBadge, PublicationSourcesCard, PublicationStatusPanel, publicationChannelLabel, publicationStyles } from "./publication.tsx";
import { aggregatePublicationStatus, publicationStatusForWorkflow } from "../domain/publication.ts";
import { articleWorkflowStatus } from "../domain/articleWorkflowStatus.ts";
import { ArticleTaxonomyChips, taxonomyStyles } from "./taxonomy.tsx";
import { PublicationEditor } from "./publication-editor.tsx";
import { publicationEditorStyles } from "./publication-editor-styles.ts";
import { SetupView } from "./setup-view.tsx";
import { MappingView } from "./mapping-view.tsx";
import { AccountManager } from "./account-manager.tsx";
import { PlatformDirectory } from "./platform-directory.tsx";
import { ChannelActions } from "./channel-actions.tsx";

const busy = (state: ClientState, key: string): boolean => state.pending.includes(key);
const jobBusy = (state: ClientState, id: string): boolean => state.pending.some(key => key === `job-read:${id}` || key === `job-cancel:${id}`);
const views: Array<[View, string]> = [["articles", "文章"], ["references", "采集 / 参考库"], ["agent", "Agent 协作"], ["jobs", "任务中心"], ["accounts", "账号管理"], ["platforms", "平台扩展"], ["settings", "设置与能力"]];
const btn = "wm-native-button";

export class WorkbenchBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo): void { /* Never log article content. */ }
  render(): ReactNode {
    return this.state.failed ? <section className="wm-workbench wm-card" role="alert"><style>{workbenchStyles}</style><h3>工作台视图暂时不可用</h3><p>当前 DSH 会话保持不变，已保存的版本和任务不受影响。</p><Button className={btn} onClick={() => this.setState({ failed: false })}>重新渲染</Button>{this.props.onClose && <Button className={btn} onClick={() => { this.props.onClose?.(); this.setState({ failed: false }); }}>关闭工作台</Button>}</section> : this.props.children;
  }
}

function ViewTabs({ state, controller }: { state: ClientState; controller: WorkbenchController }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  return <nav ref={ref} className="wm-tabs" role="tablist" aria-label="工作台视图" onKeyDown={event => {
    const index = views.findIndex(([view]) => view === state.view);
    const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); controller.navigate(views[next]![0]); ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>{views.map(([view, title]) => <button key={view} id={`wm-tab-${view}`} type="button" role="tab" aria-selected={state.view === view} aria-controls={`wm-view-${view}`} tabIndex={state.view === view ? 0 : -1} onClick={() => controller.navigate(view)}>{title}{view === "jobs" && !!state.snapshot?.jobs.filter(job => !terminalJob(job)).length && <span className="wm-count">{state.snapshot.jobs.filter(job => !terminalJob(job)).length}</span>}</button>)}</nav>;
}

export function WorkbenchPanel({ controller, embedded = false, detailOnly = false, active = true }: { controller: WorkbenchController; embedded?: boolean; detailOnly?: boolean; active?: boolean }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useJobStatusTracking(controller, state);
  useEffect(() => {
    if (!state.open || embedded) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [state.open, embedded]);
  useEffect(() => {
    if (state.open && document.activeElement?.getAttribute("role") !== "tab") panelRef.current?.focus();
  }, [state.view]);
  useEffect(() => {
    if (!state.open || !controller.dirty) return;
    const guard = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [state.open, state.edit, state.publicationEdit, controller]);
  if (!state.open) return null;
  const activeJobs = state.snapshot?.jobs.filter(job => !terminalJob(job)).length ?? 0;
  return <div className={`wm-workbench ${embedded ? "wm-embedded" : "wm-overlay"}`}><style>{workbenchStyles}{publicationStyles}{taxonomyStyles}</style><section className="wm-panel" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : "false"} aria-label={embedded ? "内容编辑与任务" : undefined} aria-labelledby={embedded ? undefined : "wm-title"} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('[aria-modal="true"]')) return;
    if (event.defaultPrevented || state.leaveRequest || state.actionPreview || state.creation) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && state.view === "articles" && state.document) {
      event.preventDefault(); if (controller.dirty && !busy(state, "mutation")) void controller.previewAction("save_revision");
    }
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && !target.matches("input,textarea,select,[contenteditable=true]")) { event.stopPropagation(); controller.requestClose(); }
  }}>
    <header className="wm-header"><span className="wm-mark" aria-hidden="true">W</span><div className="wm-header-title"><div className="wm-row"><h1 id="wm-title">WeMedia 工作台</h1><span className="wm-tag">创作空间</span></div><p>专注内容 · 版本、证据与执行进度随手可见</p></div><span className="wm-connection" data-connected={state.connected}><i aria-hidden="true" />{state.connected ? "已连接" : "等待连接"}</span><Button className={btn} variant="toolbar" onClick={() => void controller.refresh()} disabled={!state.connected || busy(state, "snapshot")} aria-label="刷新工作台">↻<span className="wm-refresh-label"> {busy(state, "snapshot") ? "刷新中" : "刷新"}</span></Button><button ref={closeRef} className="wm-icon-button" aria-label="关闭工作台" onClick={() => controller.requestClose()}>✕</button></header>
    <div className="wm-nav-row"><ViewTabs state={state} controller={controller} /><span className="wm-nav-hint">{activeJobs ? `${activeJobs} 项任务进行中` : "发布前核对版本与账号"}</span></div>
    {!state.connected && <div className="wm-notice" role="status">正在等待 Host 服务。连接完成前不执行操作。</div>}
    {state.notice && <div className="wm-notice" data-kind={state.notice.kind} role={state.notice.kind === "error" ? "alert" : "status"}><div className="wm-notice-message"><p>{state.notice.text}</p>{state.notice.code && <details className="wm-notice-code"><summary>详细原因</summary><code>{state.notice.code}</code></details>}</div><button className="wm-icon-button" aria-label="关闭提示" onClick={() => controller.clearNotice()}>×</button></div>}
    <main ref={panelRef} tabIndex={-1} id={`wm-view-${state.view}`} role="tabpanel" aria-labelledby={`wm-tab-${state.view}`} className={`wm-body ${state.view === "articles" ? "wm-body-articles" : ""}`} aria-busy={state.pending.some(key => key !== "status")}>
      {state.view === "articles" && <Articles controller={controller} state={state} detailOnly={detailOnly} active={active} />}
      {state.view === "agent" && <AgentView controller={controller} state={state} />}
      {state.view === "jobs" && <Jobs controller={controller} state={state} />}
      {state.view === "references" && <ReferenceLibrary host={controller} connected={state.connected} generationId={state.snapshot?.generationId ?? ""} active={active} onAccounts={() => controller.navigate("accounts")} onAgentTask={(ids, action, instruction) => controller.queueReferenceTask(ids, action, instruction)} />}
      {state.view === "accounts" && <AccountManager host={controller} connected={state.connected} generationId={state.snapshot?.generationId ?? ""} active={active} onExplorePlatforms={() => controller.navigate("platforms")} />}
      {state.view === "platforms" && <PlatformDirectory host={controller} connected={state.connected} generationId={state.snapshot?.generationId ?? ""} active={active} />}
      {state.view === "settings" && <SettingsView state={state} controller={controller} />}
    </main>
  </section><LeaveConfirmation controller={controller} state={state} /></div>;
}

function LeaveConfirmation({ controller, state }: { controller: WorkbenchController; state: ClientState }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, !!state.leaveRequest);
  return <Modal open={!!state.leaveRequest} onClose={() => controller.cancelLeave()} title="还有未保存的修改" closeLabel="继续编辑" className="wm-workbench wm-confirm-dialog" description="这些修改尚未保存为文章版本。只有确认放弃后，工作台才会继续你的操作。" footer={<><Button className={btn} onClick={() => controller.cancelLeave()}>继续编辑</Button><Button className={`${btn} wm-danger`} variant="outline" onClick={() => void controller.confirmLeave()}>放弃修改并继续</Button></>}><style>{workbenchStyles}</style><div ref={ref} tabIndex={-1}><p className="wm-muted">已保存的文章和 Host 任务不会被删除或撤销。</p></div></Modal>;
}

function Articles({ controller, state, detailOnly = false, active = true }: { controller: WorkbenchController; state: ClientState; detailOnly?: boolean; active?: boolean }): ReactNode {
  const [query, setQuery] = useState(state.query);
  const [creating, setCreating] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(!state.document);
  useEffect(() => setQuery(state.query), [state.query]);
  return <div className="wm-article-workspace" data-library-open={libraryOpen} data-detail-only={detailOnly || undefined}>
    <div className="wm-mobile-library-bar"><Button className={btn} onClick={() => setLibraryOpen(!libraryOpen)} aria-expanded={libraryOpen}>{libraryOpen ? "收起文章库" : "切换文章"} · {state.page?.total ?? "—"}</Button><Button className={btn} onClick={() => setCreating(true)} disabled={!state.snapshot?.settings.hasWriteRoot}>＋ 新建</Button></div>
    <aside className="wm-library" aria-label="文章库"><div className="wm-library-top"><div className="wm-row wm-between"><h2>文章库</h2><span className="wm-muted wm-small">{state.page ? `${state.page.total} 篇` : "加载中"}</span></div><form className="wm-search" onSubmit={event => { event.preventDefault(); void controller.search(query); }}><input aria-label="搜索文章标题或文章 ID" placeholder="搜索标题或文章 ID" value={query} onChange={event => setQuery(event.target.value)} /><button className="wm-icon-button" type="submit" aria-label="搜索文章" disabled={!state.connected || busy(state, "search")}>搜索</button></form><Button className={`${btn} wm-new-article`} variant="outline" onClick={() => setCreating(true)} disabled={!state.snapshot?.settings.hasWriteRoot}>＋ 新建文章</Button></div>
      <div className="wm-list" aria-busy={busy(state, "search")}>{state.page?.items.map(item => <button key={item.contentRef} aria-pressed={state.selected === item.contentRef} className="wm-article-item" onClick={() => { void controller.select(item.contentRef); setLibraryOpen(false); }} disabled={busy(state, "mutation")}><span className="wm-list-title">{item.title || "未命名文章"}</span><span className="wm-row wm-small"><PublicationBadge status={aggregatePublicationStatus(item.publications, publicationStatusForWorkflow(item.status))} /><span className="wm-pill" data-status={item.status}>{statusLabel(item.status)}</span>{item.issueCount > 0 && <span className="wm-error">{item.issueCount} 项待处理</span>}</span><span className="wm-list-source">{item.rootLabel}{item.readOnlySource ? " · 只读来源" : ""}</span></button>)}{state.page?.items.length === 0 && <div className="wm-empty"><h3>没有找到文章</h3><p>试试其他关键词，或检查内容根目录。</p><Button className={btn} onClick={() => controller.navigate("settings")}>查看设置</Button></div>}</div>
      <div className="wm-library-bottom"><div className="wm-pagination"><Button className={btn} size="sm" aria-label="上一页文章" onClick={() => void controller.previousPage()} disabled={!state.cursors.length || busy(state, "search")}>上一页</Button><span>{state.cursors.length + 1}</span><Button className={btn} size="sm" aria-label="下一页文章" onClick={() => void controller.nextPage()} disabled={!state.page?.nextCursor || busy(state, "search")}>下一页</Button></div><p className="wm-small wm-muted">{state.snapshot?.settings.hasWriteRoot ? "来源保持不变，修改保存为独立版本。" : "尚未配置写入目录，新建与保存暂不可用。"}</p></div>
    </aside>
    <section className="wm-detail">{state.publication && state.publicationEdit ? <PublicationEditor key={state.publication.contentRef} controller={controller} state={state} active={active} /> : state.document ? <ArticleDetail key={state.document.contentRef} controller={controller} state={state} /> : <div className="wm-welcome"><span className="wm-welcome-mark" aria-hidden="true">W</span><h2>{busy(state, "article") ? "正在读取文章…" : "让创作有条不紊"}</h2><p>从文章库选择一篇内容，编辑、核对来源、保存证据，<br />再明确地准备你的下一步。</p><div className="wm-welcome-steps"><span>01 编辑版本</span><span>02 审阅证据</span><span>03 准备草稿</span></div><Button className={btn} variant="primary" disabled={!state.snapshot?.settings.hasWriteRoot} onClick={() => setCreating(true)}>新建第一篇文章</Button></div>}</section>
    <CreateArticle controller={controller} state={state} open={creating} onClose={() => { setCreating(false); controller.discardCreation(); }} />
  </div>;
}

export function CreateArticle({ controller, state, open, onClose, onCreated }: { controller: WorkbenchController; state: ClientState; open: boolean; onClose: () => void; onCreated?: (job: WorkbenchJob) => void }): ReactNode {
  const [input, setInput] = useState<CreateInput>({ title: "", sourceUrl: "", kind: "article" });
  const [type, setType] = useState<"article" | "paper" | "video" | "image_text">("article");
  const media = type === "video" || type === "image_text";
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const ref = useRef<HTMLDivElement>(null), previewRef = useRef<HTMLElement>(null);
  useDialogFocus(ref, open);
  const preview = media ? state.publicationCreation : state.creation?.preview;
  useEffect(() => { if (open && preview) previewRef.current?.focus(); }, [open, preview?.intent.intentId]);
  const clearPreview = () => { controller.discardCreation(); controller.discardPublicationCreation(); };
  const update = (change: Partial<CreateInput>): void => { setInput({ ...input, ...change }); clearPreview(); };
  const pending = busy(state, "mutation") || busy(state, "create-preview") || busy(state, "publication-create-preview");
  const locked = pending || state.snapshot?.settings.hasWriteRoot === false;
  const confirm = (): void => { void (media ? controller.confirmPublication(true) : controller.confirmCreation()).then(job => { if (job && live.current) { onClose(); onCreated?.(job); } }); };
  return <Modal open={open} onClose={() => { if (!pending) { clearPreview(); onClose(); } }} title="新建内容" closeLabel="关闭新建内容" className="wm-workbench wm-create-dialog" description="选择文章、视频或图文，先建立本地发布稿。"><style>{workbenchStyles}{publicationEditorStyles}</style><div ref={ref} tabIndex={-1} className="wm-stack"><form className="wm-stack" onSubmit={event => { event.preventDefault(); if (locked) return; if (type === "video" || type === "image_text") void controller.previewPublicationCreation(type, input.title); else void controller.previewCreation(input); }}><label>发布类型<select aria-label="新建发布类型" value={type} disabled={locked} onChange={event => { const next = event.target.value as typeof type; setType(next); if (next === "article" || next === "paper") setInput({ ...input, kind: next }); clearPreview(); }}><option value="article">文章</option><option value="paper">论文解读</option><option value="video">视频</option><option value="image_text">图文</option></select></label><label>{media ? "发布稿标题" : "文章标题"}<input data-initial-focus="true" aria-label="新建内容标题" required maxLength={media ? 200 : 256} placeholder="给这份内容一个清楚的主题" value={input.title} disabled={locked} onChange={event => update({ title: event.target.value })} /></label>{!media && <label>来源 URL（可选）<input type="url" placeholder="https://…" value={input.sourceUrl} disabled={locked} onChange={event => update({ sourceUrl: event.target.value })} /></label>}{media && <p className="wm-inline-note">创建后可编辑正文、选择本地{type === "video" ? "视频与封面" : "有序配图"}并保存版本。</p>}<Button className={btn} type="submit" variant="primary" disabled={locked || !input.title.trim()}>{pending ? "正在检查创建条件…" : "预览创建操作"}</Button></form>{preview && <section ref={previewRef} tabIndex={-1} aria-label="创建意图预览" className="wm-card wm-intent wm-stack"><Intent intent={preview.intent} summary={preview.summary} /><Button className={btn} variant="primary" disabled={locked || preview.intent.blockingGateCodes.length > 0} onClick={confirm}>{media ? "确认创建本地发布稿" : "确认创建本地文章"}</Button></section>}{state.notice?.kind === "error" && <p role="alert" className="wm-error">{state.notice.text}</p>}</div></Modal>;
}

type ArticleTab = "editor" | "materials" | "reviews" | "delivery" | "history";
function ArticleDetail({ controller, state }: { controller: WorkbenchController; state: ClientState }): ReactNode {
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState<ArticleTab>("editor");
  const [layout, setLayout] = useState<"edit" | "split" | "preview">(state.document?.html.trim() ? "preview" : "edit");
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1160px)").matches);
  const [workflowImportKind, setWorkflowImportKind] = useState<WorkflowImportKind | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1160px)");
    const change = (): void => setCompact(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const shownLayout = compact && layout === "split" ? "edit" : layout;
  const [targetRef, setTargetRef] = useState("");
  const [mappingOpen, setMappingOpen] = useState(false);
  const doc = state.document!; const edit = state.edit!;
  const diffs = useMemo(() => editDiffs(doc, edit), [doc, edit]);
  const locked = busy(state, "mutation");
  const reviewKinds = new Set(doc.reviews.filter(review => review.valid && review.revisionDigest === doc.revisionDigest).map(review => review.kind)).size;
  const sourceLabel = state.snapshot?.settings.roots.find(root => root.id === doc.document.rootId)?.label ?? state.page?.items.find(item => item.contentRef === doc.contentRef)?.rootLabel ?? (doc.readOnlySource ? "只读来源" : "独立写入区");
  const publicationStatus = aggregatePublicationStatus(doc.publications, publicationStatusForWorkflow(articleWorkflowStatus(doc)));
  const tabs: Array<[ArticleTab, string]> = [["editor", "文章预览与编辑"], ["materials", `素材与来源 · ${doc.assets.length}`], ["reviews", `发布前检查 · ${reviewKinds}/4`], ["delivery", "微信草稿箱"], ["history", "版本历史"]];
  return <div className="wm-article-detail" onClickCapture={event => { const target = event.target as HTMLElement; if (!target.closest('[aria-modal="true"]')) { const button = target.closest<HTMLButtonElement>("button"); if (button) actionTrigger.current = button; } }}><header className="wm-article-header"><div className="wm-row wm-between"><span className="wm-eyebrow">{doc.metadata.kind === "paper" ? "论文解读" : "文章"}</span><div className="wm-row"><Button className={btn} size="sm" variant="toolbar" disabled={locked || controller.dirty} onClick={() => setMappingOpen(true)}>主稿与来源</Button><Button className={btn} size="sm" variant="toolbar" disabled={locked || busy(state, "article")} onClick={() => void controller.select(doc.contentRef)}>刷新文章</Button></div></div><h2>{doc.metadata.title}</h2><div className="wm-context-line"><span className="wm-pill">{doc.readOnlySource ? "只读来源 · 独立修订" : "独立版本"}</span><span title={doc.revisionDigest}>版本 {shortId(doc.revisionDigest)}</span><span>来源：{sourceLabel}</span><span>{controller.dirty ? `${diffs.length} 项修改未保存` : "已保存"}</span></div><ArticleTaxonomyChips taxonomy={doc.taxonomy} /><div className="wm-article-next"><div><PublicationBadge status={publicationStatus} /><span>{controller.dirty ? "先保存修改，再继续发布准备" : doc.targets.some(target => target.verifiedRevision === doc.revisionDigest) ? "当前版本已在公众号草稿箱核对" : "先预览文章，再完成发布前检查"}</span></div><div className="wm-row"><Button className={btn} variant="outline" disabled={locked || controller.dirty || busy(state, "agent-task")} onClick={() => void controller.taskBrief("write_draft")}>让 AI 完善文章</Button><Button className={btn} variant="primary" onClick={() => setTab("delivery")}>去微信草稿箱</Button></div></div><details className="wm-article-records"><summary>查看各平台发布记录</summary><PublicationStatusPanel status={publicationStatus} records={doc.publications} dirty={controller.dirty} /></details></header>
    <nav className="wm-article-tabs" aria-label="文章工作区">{tabs.map(([id, title]) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{title}</button>)}</nav>
    <div className="wm-article-content">
      {tab === "editor" && <><div className="wm-editor-toolbar"><span className="wm-muted wm-small">{controller.dirty ? "编辑不会覆盖原始文章，保存后生成新版本。" : "从内容出发，修改完成后再确认保存。"}</span><div className="wm-segmented" role="group" aria-label="编辑器布局"><button aria-pressed={shownLayout === "edit"} onClick={() => setLayout("edit")}>编辑正文</button><button className="wm-split-option" aria-pressed={shownLayout === "split"} onClick={() => setLayout("split")}>对照预览</button><button aria-pressed={shownLayout === "preview"} onClick={() => setLayout("preview")}>阅读预览</button></div></div><div className="wm-edit-layout" data-mode={shownLayout}><div className="wm-editor-column wm-stack"><label>标题<input value={edit.metadata.title} disabled={locked} onChange={event => controller.updateEdit({ title: event.target.value })} /></label><label>纯文本摘要<textarea rows={3} value={edit.metadata.digest} disabled={locked} onChange={event => controller.updateEdit({ digest: event.target.value })} /></label><label className="wm-body-label"><span className="wm-row wm-between">正文 HTML（高级编辑） <span className="wm-muted">安全预览以已保存版本为准</span></span><textarea rows={19} className="wm-code-editor" value={edit.html} disabled={locked} spellCheck={false} onChange={event => controller.updateEdit({ html: event.target.value })} /></label></div><div className="wm-preview-column"><MobilePreview state={state} dirty={controller.dirty} /></div></div></>}
      {tab === "materials" && <div className="wm-section-content"><ArticleMaterials document={doc} /><CoverageSummary document={doc} disabled={controller.dirty} onRead={id => void controller.readEvidence(id)} /></div>}
      {tab === "reviews" && <div className="wm-section-content"><ArticleReviews document={doc} onReadEvidence={id => void controller.readEvidence(id)} report={state.gates} busy={busy(state, "preflight")} onPreflight={() => { void controller.preflight(); }} onAgent={() => controller.navigate("agent")} aiWorkflow={state.aiWorkflow} aiBusy={busy(state, "ai-inspect") || busy(state, "ai-preview")} aiDisabled={controller.dirty} onAiInspect={() => { void controller.aiInspect(); }} onAiPreview={() => { void controller.aiPreview(); }} onImportReview={() => setWorkflowImportKind("review")} importBusy={busy(state, "workflow-import-preview") || busy(state, "workflow-import-apply")} /></div>}
      {tab === "history" && <div className="wm-section-content"><VersionHistoryView state={state} controller={controller} /></div>}
      {tab === "delivery" && <div className="wm-section-content"><Delivery state={state} controller={controller} targetRef={targetRef} setTargetRef={value => { setTargetRef(value); controller.discardAction(); }} onReviews={() => setTab("reviews")} onImportDraft={() => setWorkflowImportKind("draft")} onEdit={() => { setTab("editor"); setLayout(controller.dirty ? "edit" : "preview"); }} /></div>}
    </div>
    <footer className="wm-savebar"><div className="wm-save-status"><span className="wm-state-dot" data-dirty={controller.dirty} /><div><strong>{controller.dirty ? `${diffs.length} 项修改未保存` : "当前版本已保存"}</strong><span>{controller.dirty ? "确认变更后，保存为独立新版本" : "审阅记录只对匹配的版本有效"}</span></div></div><div className="wm-row">{controller.dirty && <Button className={btn} disabled={locked} onClick={() => controller.requestDiscard()}>放弃修改</Button>}{controller.dirty ? <Button className={btn} variant="primary" disabled={locked || busy(state, "action-preview") || !state.snapshot?.settings.hasWriteRoot || !edit.metadata.title.trim()} onClick={() => void controller.previewAction("save_revision")}>{busy(state, "action-preview") ? "检查中…" : "查看变更并保存"}</Button> : <Button className={btn} variant="primary" disabled={locked} onClick={() => { if (tab === "delivery") { setTab("editor"); setLayout("preview"); } else setTab("delivery"); }}>{tab === "delivery" ? "返回文章预览" : "下一步：存入微信草稿箱"}</Button>}</div></footer>
    {mappingOpen && <MappingView controller={controller} contentRef={doc.contentRef} onClose={() => setMappingOpen(false)} />}
    <EvidenceReader controller={controller} state={state} trigger={actionTrigger} />
    <ActionConfirmation controller={controller} state={state} trigger={actionTrigger} />
    <WorkflowImportDialog controller={controller} state={state} kind={workflowImportKind} onClose={() => { setWorkflowImportKind(null); controller.discardWorkflowImport(); }} trigger={actionTrigger} />
  </div>;
}

function MobilePreview({ state, dirty }: { state: ClientState; dirty: boolean }): ReactNode {
  const holder = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const html = useMemo(() => state.mobile ? inertPreview(state.mobile.html) : "", [state.mobile]);
  useEffect(() => {
    const node = holder.current; if (!node) return;
    const measure = (): void => { if (node.clientWidth > 0) setScale(Math.min(1, node.clientWidth / 390)); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [state.mobile]);
  return <div className="wm-preview-card"><div className="wm-preview-heading"><span>移动预览</span><span className="wm-pill">已保存版本</span></div><p className="wm-preview-description">{dirty ? "这里仍是上一保存版本，确认保存后会更新。" : "390px 微信阅读布局 · 脚本与外部网络已禁用"}</p>{state.mobile ? <><div ref={holder} className="wm-mobile" style={{ height: Math.round(620 * scale) }}><iframe title="390px 已保存文章预览" sandbox="" referrerPolicy="no-referrer" srcDoc={html} tabIndex={-1} style={{ transform: `scale(${scale})` }} /></div><div className="wm-preview-footer"><span>{state.mobile.imageCount} 张已解析图片</span><span>390px · {Math.round(scale * 100)}%</span></div></> : <div className="wm-empty">{busy(state, "article") ? "正在装配受控预览…" : "预览尚不可用，请刷新文章。"}</div>}</div>;
}

function Delivery({ state, controller, targetRef, setTargetRef, onReviews, onImportDraft, onEdit }: { state: ClientState; controller: WorkbenchController; targetRef: string; setTargetRef: (value: string) => void; onReviews: () => void; onImportDraft: () => void; onEdit: () => void }): ReactNode {
  const locked = busy(state, "mutation") || busy(state, "action-preview");
  return <div className="wm-stack"><WechatDraftGuide state={state} controller={controller} targetRef={targetRef} setTargetRef={setTargetRef} onReviews={onReviews} onImportDraft={onImportDraft} onEdit={onEdit} /><details className="wm-other-channels"><summary>其他平台发布：知乎、小红书、X</summary><ChannelActions controller={controller} state={state} contentRef={state.document!.contentRef} revisionDigest={state.document!.revisionDigest} dirty={controller.dirty || locked} /></details></div>;
}

const workflowImportStatusLabels: Record<WorkflowImportPreview["material"]["status"], string> = {
  current: "当前版本材料",
  partial: "部分导入",
  historical: "历史材料",
  stale: "版本过期",
};

const workflowImportGateLabels: Record<string, string> = {
  DATA_DIR_REQUIRED: "尚未配置数据目录",
  DRAFT_IDENTITY_READ_REQUIRED: "需要先完成草稿身份只读核对",
  DRAFT_IDENTITY_REQUIRED: "需要先完成草稿身份核对",
  DRAFT_IDENTITY_UNAVAILABLE: "当前适配器不支持草稿身份核验",
  IMPORT_CALLER_CHANGED: "导入预览属于另一调用方",
  IMPORT_CALLER_UNAVAILABLE: "当前调用方身份不可用",
  TARGET_IMPORT_CONFLICT: "已有草稿绑定冲突",
  WECHAT_ACCOUNT_UNAVAILABLE: "公众号账号不可用",
  WORKFLOW_IMPORT_CHANGED: "文章、材料、账号或草稿绑定已变化",
  WORKFLOW_IMPORT_UNAVAILABLE: "当前仓库不支持材料导入",
};

export const displayImportEvidence = (value: string | null | undefined): string => value?.trim() || "未记录";

export const workflowImportBlockingReason = (codes: readonly string[]): string => {
  if (!codes.length) return "";
  const labels = codes.map(code => workflowImportGateLabels[code] ? `${workflowImportGateLabels[code]}（${code}）` : code);
  return `确认暂不可用：${labels.join("、")}。请先处理后重新预览。`;
};

function WorkflowImportDialog({ controller, state, kind, onClose, trigger }: { controller: WorkbenchController; state: ClientState; kind: WorkflowImportKind | null; onClose: () => void; trigger: React.RefObject<HTMLElement> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const open = kind !== null;
  const document = state.document;
  const [rootId, setRootId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const roots = state.snapshot?.settings.roots.filter(root => root.available) ?? [];
  const preview = kind && state.workflowImport?.kind === kind ? state.workflowImport.preview : null;
  const previewBusy = busy(state, "workflow-import-preview");
  const applying = busy(state, "workflow-import-apply");
  useDialogFocus(ref, open, trigger);
  useEffect(() => {
    if (!open || !kind || !document) return;
    const defaultArtifact = defaultWorkflowImportArtifact(document, kind);
    const defaultRoot = roots.find(root => root.id === defaultArtifact.rootId)?.id ?? roots[0]?.id ?? defaultArtifact.rootId;
    setRootId(defaultRoot);
    setRelativePath(defaultArtifact.relativePath);
    controller.discardWorkflowImport();
  }, [open, kind, document?.contentRef]);
  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview?.intent.intentId]);
  const invalidate = (): void => { if (!previewBusy && !applying) controller.discardWorkflowImport(); };
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!kind || !rootId || !relativePath.trim() || previewBusy || applying) return;
    void controller.previewWorkflowImport(kind, { rootId, relativePath: relativePath.trim() });
  };
  const confirm = async (): Promise<void> => {
    await controller.applyWorkflowImport();
    if (!controller.getSnapshot().workflowImport) onClose();
  };
  const blockingReason = workflowImportBlockingReason(preview?.intent.blockingGateCodes ?? []);
  const confirmDisabled = !preview || previewBusy || applying || Boolean(blockingReason) || !relativePath.trim();
  return <Modal open={open} onClose={() => { if (!applying) onClose(); }} title={kind === "draft" ? "导入已有草稿目标" : "导入旧审阅报告"} closeLabel="返回工作台" className="wm-workbench wm-import-dialog" contentClassName="wm-dialog-scroll" footer={<div className="wm-import-footer">{blockingReason && <span id="wm-workflow-import-blocking-reason" className="wm-import-footer-reason wm-small wm-error" role="status" aria-live="polite">{blockingReason}</span>}<div className="wm-import-footer-actions"><Button className={btn} disabled={applying} onClick={onClose}>取消</Button><Button className={btn} variant="primary" aria-describedby={blockingReason ? "wm-workflow-import-blocking-reason" : undefined} disabled={confirmDisabled} onClick={() => void confirm()}>{applying ? "正在绑定…" : kind === "draft" ? "确认只读核对并绑定" : "确认导入审阅材料"}</Button></div></div>}><style>{workbenchStyles}</style><div ref={ref} tabIndex={-1} className="wm-stack"><form className="wm-stack" onSubmit={submit}><div className="wm-inline-note"><strong>{kind === "draft" ? "只读身份核对" : "历史审阅材料"}</strong><p>{kind === "draft" ? "先读取并核对已有摘要的文章身份与版本，再绑定到当前文章；不会上传、更新或创建公众号草稿。" : "只导入已有报告的结构化材料，需先核对来源与版本；不会把历史或部分材料自动算作四类审阅通过。"}</p></div><div className="wm-grid"><label>内容根目录<select value={rootId} disabled={previewBusy || applying || !roots.length} onChange={event => { setRootId(event.target.value); invalidate(); }}><option value="">请选择可用根目录</option>{roots.map(root => <option key={root.id} value={root.id}>{root.label} · {root.id}</option>)}</select></label><label>材料 JSON 相对路径<input data-initial-focus="true" required value={relativePath} disabled={previewBusy || applying} placeholder={kind === "draft" ? "platform/aaai2026-agent-draft-summary.json" : "inspection/report.json"} onChange={event => { setRelativePath(event.target.value); invalidate(); }} /></label></div><p className="wm-small wm-muted">仅接受已配置且可用的根目录；路径由 Host 做安全解析，工作台不展示机器绝对路径。</p>{!roots.length && <p role="alert" className="wm-error">暂无可用内容根目录，无法预览导入。</p>}<Button className={btn} type="submit" variant="primary" disabled={previewBusy || applying || !rootId || !relativePath.trim()}>{previewBusy ? "正在读取材料…" : "预览导入"}</Button></form>{preview && <section ref={previewRef} tabIndex={-1} aria-label="工作流材料导入预览" className="wm-card wm-import-preview wm-stack"><div className="wm-row wm-between"><div><h3>材料预览</h3><p className="wm-small wm-muted">{preview.material.title || "未命名材料"}</p></div><span className="wm-pill" data-status={preview.material.status}>{workflowImportStatusLabels[preview.material.status]}</span></div><dl className="wm-evidence-meta"><div><dt>来源</dt><dd className="wm-code">{relativeArtifactLabel(preview.material.source)}</dd></div><div><dt>格式</dt><dd>{preview.material.sourceFormat || "未记录"}</dd></div><div><dt>绑定版本</dt><dd className="wm-code">{displayImportEvidence(preview.material.boundRevision)}</dd></div><div><dt>绑定 HTML 摘要</dt><dd className="wm-code">{displayImportEvidence(preview.material.boundHtmlDigest)}</dd></div></dl>{preview.summary.length > 0 && <div><h4>导入摘要</h4><ul>{preview.summary.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}{preview.material.findings.length > 0 && <div><h4>发现</h4><ul>{preview.material.findings.map((line, index) => <li key={`finding-${index}`}>{line}</li>)}</ul></div>}{preview.material.warnings.length > 0 && <div><h4>警告</h4><ul className="wm-gate-list">{preview.material.warnings.map((line, index) => <li key={`warning-${index}`}><span className="wm-pill" data-status="warn">提醒</span> {line}</li>)}</ul></div>}<Intent intent={preview.intent} summary={preview.summary} />{state.notice?.kind === "error" && <p role="alert" className="wm-error">{state.notice.text}</p>}</section>}</div></Modal>;
}

function ActionConfirmation({ controller, state, trigger }: { controller: WorkbenchController; state: ClientState; trigger: React.RefObject<HTMLElement> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, !!state.actionPreview, trigger);
  const preview = state.actionPreview;
  const locked = busy(state, "mutation");
  const diffs = useMemo(() => state.document && state.edit ? editDiffs(state.document, state.edit) : [], [state.document, state.edit]);
  return <Modal open={!!preview} onClose={() => { if (!locked) controller.discardAction(); }} title={preview?.action === "save_revision" ? "确认本次版本变更" : preview?.intent.sideEffect === "remote_draft" ? "确认存入微信草稿箱" : "确认本次操作"} closeLabel="返回工作台" className="wm-workbench wm-action-dialog" contentClassName="wm-dialog-scroll" footer={<><Button className={btn} disabled={locked} onClick={() => controller.discardAction()}>返回继续检查</Button><Button className={btn} variant="primary" disabled={locked || !!preview?.intent.blockingGateCodes.length} onClick={() => { const remoteDraft = preview?.intent.sideEffect === "remote_draft"; void controller.confirmAction().then(() => { const next = controller.getSnapshot(); if (remoteDraft && !next.actionPreview && next.notice?.kind === "info") controller.requestClose(); }); }}>{locked ? "正在提交…" : preview?.intent.sideEffect === "remote_draft" ? "继续到会话确认" : `确认${preview ? actionLabels[preview.action] : "操作"}`}</Button></>}><style>{workbenchStyles}</style><div ref={ref} tabIndex={-1} className="wm-stack">{preview && <><Intent intent={preview.intent} summary={preview.summary} issues={preview.gates.issues} />{preview.action === "save_revision" && <section aria-label="保存前后差异"><h3>本次修改 · {diffs.length} 项</h3><p className="wm-small wm-muted">红色为保存前，绿色为本次编辑；仅展示变化字段的完整前后内容。</p><DiffBlock diffs={diffs} maxLines={24} className="wm-native-diff" /></section>}{preview.target && <p>明确目标：{preview.target.label} · {preview.target.title}</p>}{preview.action === "save_revision" && preview.gates.status === "block" && !preview.intent.blockingGateCodes.length && <p className="wm-inline-note">本次本地保存允许执行；下列内容检查尚未通过，保存不等于草稿已就绪。</p>}<details open={preview.gates.status === "block" && preview.action !== "save_revision"}><summary>机械校验 · {statusLabel(preview.gates.status)}</summary><Gates report={preview.gates} /></details>{state.notice?.kind === "error" && <p role="alert" className="wm-error">{state.notice.text}</p>}</>}</div></Modal>;
}

function Intent({ intent, summary, issues = [] }: { intent: ActionIntent; summary: string[]; issues?: GateReport["issues"] }): ReactNode {
  const blocked = intent.blockingGateCodes.map(code => issues.find(issue => issue.code === code)?.safeMessage ?? "这项检查尚未通过，请查看下方检查结果");
  return <div className="wm-intent-summary"><div className="wm-row"><span className="wm-pill">{intent.sideEffect === "remote_draft" ? "远端草稿写入" : intent.sideEffect === "read" ? "只读操作" : "本地写入"}</span><span className="wm-small wm-muted">有效期至 {displayTime(intent.expiresAt)}</span></div><ul>{summary.map((line, index) => <li key={index}>{line}</li>)}</ul><p>{intent.targetSummary}</p><details className="wm-small"><summary>意图与版本绑定</summary><p className="wm-code">{intent.intentId}<br />{intent.contentRef}<br />输入摘要：{intent.inputDigest}</p></details>{intent.blockingGateCodes.length > 0 && <p className="wm-error" role="alert">需要先处理：{[...new Set(blocked)].join("；")}。</p>}</div>;
}

function Gates({ report }: { report: GateReport }): ReactNode {
  return <ul className="wm-gate-list">{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><span className="wm-pill" data-status={issue.status}>{statusLabel(issue.status)}</span> {issue.safeMessage}<details className="wm-small"><summary>检查代码</summary><code>{issue.code}</code></details></li>)}</ul>;
}

export function AgentView({ controller, state }: { controller: WorkbenchController; state: ClientState }): ReactNode {
  const selected = state.document ?? state.publication;
  const media = state.publication;
  const tasks = media ? [
    { action: "research", title: "研究素材与表达", text: "核查已有图像、视频素材与来源，整理配文和内容结构建议。", output: "产物：素材研究与表达建议" },
    { action: "write_draft", title: "撰写发布稿", text: "基于已有素材完善标题、正文、图片说明与素材顺序，先预览再保存本地版本。", output: "产物：发布稿文字与素材编排" },
    { action: "review", title: "审阅发布稿", text: "检查标题、正文、素材说明、封面与顺序，给出修改建议。媒体审阅建议不作为文章审阅证据。", output: "产物：审阅建议与待改项" },
  ] as const : [
    { action: "research", title: "研究来源与事实", text: "核查第一手来源、论点与证据，保留可追溯的参考链接。", output: "产物：来源与事实材料" },
    { action: "write_draft", title: "撰写完整初稿", text: "基于真实材料写作，保留必要的原论文图、公式与结果表。", output: "产物：独立文章版本" },
    { action: "review", title: "审阅并保存证据", text: "核对事实、编辑、原图公式与 390px 实际渲染，再提交当前版本的审阅材料。", output: "产物：版本绑定的审阅记录" },
  ] as const;
  return <div className="wm-page-content wm-stack"><div className="wm-page-heading"><span className="wm-eyebrow">延续当前 DSH 会话</span><h2>让 Agent 处理内容工作</h2><p>研究、写作、审阅沿用当前会话的模型与工具。PTC 编排检查，工作台保存版本和执行结果。</p></div><div className="wm-article-context">{selected ? <><span className="wm-pill">{media ? media.publicationType === "video" ? "视频发布稿" : "图文发布稿" : "当前文章"}</span><strong>{media?.title ?? state.document?.metadata.title}</strong><span className="wm-code wm-muted">{shortId(selected.revisionDigest)}</span><Button className={btn} onClick={() => controller.navigate("articles")}>回到内容</Button></> : <><p>先选择内容，再在 DSH 选择当前会话。</p><Button className={btn} onClick={() => controller.navigate("articles")}>前往内容库</Button></>}</div><div className="wm-agent-grid">{tasks.map((task, index) => <section className="wm-card wm-agent-card" key={task.action}><span className="wm-step-number">0{index + 1}</span><h3>{task.title}</h3><p className="wm-muted">{task.text}</p><p className="wm-small wm-muted">{task.output}</p><Button className={btn} variant="outline" disabled={!selected || controller.dirty || busy(state, "agent-task") || !!media && controller.publicationReadOnly && task.action === "write_draft"} onClick={() => void controller.taskBrief(task.action)}>交给当前 Agent</Button></section>)}</div>{controller.dirty && <p className="wm-inline-note">请先保存未完成的编辑，Agent 任务只读取已保存版本。</p>}{media && controller.publicationReadOnly && <p className="wm-inline-note">写入已停用，仍可研究素材与审阅已保存版本。</p>}<div className="wm-inline-note"><strong>排队不等于完成。</strong> 处理过程在当前会话查看，完成后回工作台刷新内容。没有当前会话时不会新建会话、切换模型或另设 AI 账户。</div></div>;
}

function Jobs({ controller, state }: { controller: WorkbenchController; state: ClientState }): ReactNode {
  const [filter, setFilter] = useState<"all" | "active" | "attention" | "done">("all");
  const jobs = state.snapshot?.jobs ?? [];
  const filtered = jobs.filter(job => filter === "all" || (filter === "active" && !terminalJob(job)) || (filter === "attention" && attentionJob(job)) || (filter === "done" && job.status === "succeeded"));
  const filters = [["all", "全部", jobs.length], ["active", "进行中", jobs.filter(job => !terminalJob(job)).length], ["attention", "需处理", jobs.filter(attentionJob).length], ["done", "已完成", jobs.filter(job => job.status === "succeeded").length]] as const;
  return <div className="wm-page-content wm-stack"><div className="wm-section-heading"><div className="wm-page-heading"><span className="wm-eyebrow">可靠执行，有据可查</span><h2>任务中心</h2><p>这里展示 Host 持久任务。页面可见时有限跟踪进行中的状态，只读取、不自动重试写入。</p></div><Button className={btn} variant="outline" disabled={busy(state, "status")} onClick={() => void controller.refreshStatus()}>刷新任务状态</Button></div><div className="wm-filter-row" role="group" aria-label="筛选任务">{filters.map(([value, title, count]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{title}<span>{count}</span></button>)}</div>{!state.snapshot ? <div className="wm-empty">尚未加载任务，请刷新工作台。</div> : !filtered.length ? <div className="wm-empty"><h3>这里暂时没有任务</h3><p>{filter === "all" ? "新建、保存或准备操作提交后，会在这里留下进度与结果。" : "当前筛选下没有任务，可以切换查看全部。"}</p></div> : <div className="wm-job-list">{filtered.map(job => <section className="wm-card wm-job" key={job.jobId}><div className="wm-row wm-between"><div className="wm-row"><span className="wm-state-dot" data-status={job.status} /><h3>{actionLabels[job.action as WorkbenchAction] ?? (job.action === "create_content" ? "新建本地文章" : job.action === "create_publication" ? "新建本地发布稿" : job.action === "save_publication" ? "保存发布稿版本" : job.action)}</h3></div><span className="wm-pill" data-status={job.status}>{statusLabel(job.status)}</span></div><p>{job.safeMessage}</p>{job.progress.total && job.progress.total > 0 ? <progress aria-label="任务进度" value={job.progress.current} max={job.progress.total} /> : <p className="wm-small wm-muted">进度：{job.progress.current} {job.progress.unit ?? ""}</p>}{job.status === "reconcile_required" && <p className="wm-inline-note wm-error">远端是否已写入尚未确认。先核对草稿结果，不要重新创建。</p>}<div className="wm-row wm-between"><p className="wm-small wm-muted">{displayTime(job.createdAt)}{job.finishedAt ? ` · 结束于 ${displayTime(job.finishedAt)}` : ""}</p><div className="wm-row"><Button className={btn} size="sm" disabled={jobBusy(state, job.jobId)} onClick={() => void controller.refreshJob(job.jobId)}>刷新</Button>{!terminalJob(job) && <Button className={`${btn} wm-danger`} size="sm" disabled={busy(state, `job-cancel:${job.jobId}`)} onClick={() => void controller.cancelJob(job.jobId)}>请求取消</Button>}<Button className={btn} size="sm" variant="outline" disabled={busy(state, "job-content")} onClick={() => void controller.openJobContent(job)}>查看内容</Button></div></div><details className="wm-job-details"><summary>任务标识与输出证据{job.artifactRefs.length ? ` · ${job.artifactRefs.length} 项` : ""}</summary><p className="wm-code">{job.jobId}<br />{job.contentRef}{job.resultCode ? ` · ${job.resultCode}` : ""}</p>{job.artifactRefs.length > 0 && <ul className="wm-code">{job.artifactRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}</details></section>)}</div>}<p className="wm-small wm-muted">取消不等于回滚。Agent 研究任务的排队与进度请在当前会话查看。</p></div>;
}

function SettingsView({ state, controller }: { state: ClientState; controller: WorkbenchController }): ReactNode {
  const snapshot = state.snapshot;
  if (!snapshot) return <div className="wm-empty">尚无 Host 配置快照，请连接后刷新。</div>;
  return <div className="wm-page-content wm-stack"><div className="wm-page-heading"><span className="wm-eyebrow">能力来自实际连接</span><h2>设置与能力</h2><Button className={btn} variant="outline" onClick={() => { controller.open(); controller.navigate("accounts"); }}>管理平台账号</Button><p>查看真实能力，预览并选择已有内容目录；连接重载后核对实际配置。</p></div><div className="wm-setup-grid">{[["数据目录", snapshot.settings.hasDataDir, "版本、证据与任务的持久存储"], ["写入目录", snapshot.settings.hasWriteRoot, "独立文章与新修订的受控位置"], ["原生审批", snapshot.settings.approvalAvailable, "服务可用仍需当前会话授权"]].map(([title, ready, description]) => <section className="wm-card" key={String(title)}><span className="wm-pill" data-status={ready ? "available" : "unavailable"}>{ready ? "已就绪" : title === "写入目录" && snapshot.settings.roots.some(root => root.id === "write" && root.mode === "read" && root.available) ? "已停用" : "未配置"}</span><h3>{title}</h3><p className="wm-small wm-muted">{description}</p></section>)}</div>{snapshot.settings.issues.length > 0 && <ul className="wm-inline-note wm-error">{snapshot.settings.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}<section className="wm-card"><h3>内容根目录</h3>{snapshot.settings.roots.length ? <ul className="wm-root-list">{snapshot.settings.roots.map(root => <li key={root.id}><strong>{root.label}</strong><span className="wm-pill">{root.mode === "read" ? "只读" : "可写"}</span><span className={root.available ? "wm-muted" : "wm-error"}>{root.available ? "可用" : "不可用"}</span><details><summary>根目录标识</summary><code>{root.id}</code></details></li>)}</ul> : <p className="wm-muted">未配置内容根目录。</p>}</section><SetupView controller={controller} />{snapshot.publicationSources && <PublicationSourcesCard summary={snapshot.publicationSources} />}<section className="wm-stack"><div><h3>适配器能力</h3><p className="wm-small wm-muted">支持渠道：{snapshot.supportedChannels.map(publicationChannelLabel).join("、") || "无"}。能力状态不等于账号已获授权。</p></div>{snapshot.capabilities.map(report => <section key={`${report.channel}:${report.adapter}`} className="wm-card"><div className="wm-row wm-between"><h3>{publicationChannelLabel(report.channel)} · {report.adapter}</h3><span className="wm-pill">{statusLabel(report.configured)}</span></div><div className="wm-capability-list">{report.actions.map(action => <details key={action.action}><summary><span>{action.action}</span><span className="wm-pill" data-status={action.status}>{statusLabel(action.status)}</span></summary><p>{action.safeMessage}</p><p className="wm-code wm-muted">{action.reasonCode} · {displayTime(action.checkedAt)}</p></details>)}</div></section>)}{!snapshot.capabilities.length && <div className="wm-empty">Host 未返回适配器能力，请刷新或检查配置。</div>}</section><details className="wm-small wm-muted"><summary>连接与版本详情</summary><p className="wm-code">快照 {snapshot.revision} · {snapshot.generationId}</p></details></div>;
}

export function SettingsCard({ controller }: { controller: WorkbenchController }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  return <section className="wm-workbench wm-settings-card wm-stack"><style>{workbenchStyles}</style><div><h3>WeMedia 工作台</h3><p>查看真实目录、能力与审批集成。完整创作空间从侧栏打开。</p><Button className={btn} variant="outline" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); if (!expanded) void controller.refresh(); }}>{expanded ? "收起设置与能力" : "查看设置与能力"}</Button></div>{expanded && <div>{!state.connected ? <p role="status">Host 连接尚未就绪。</p> : busy(state, "snapshot") ? <p role="status">正在读取配置与能力…</p> : state.notice?.kind === "error" ? <p role="alert">{state.notice.text}</p> : <SettingsView state={state} controller={controller} />}</div>}</section>;
}

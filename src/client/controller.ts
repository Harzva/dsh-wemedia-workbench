import type { VersionHistory, VersionComparison, EvidenceDetail } from "../domain/inspection.ts";
import type { ISessions, SessionFace } from "@deepseek-ai/dsh-client-runtime/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { GateReport, ActionIntent } from "../domain/capability.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { ArtifactRef } from "../domain/content.ts";
import type { ActionPreview, AiWorkflowResult, ArticleDocument, ArticleEdit, PreviewDocument, TaskBrief, WorkbenchAnswer, WorkbenchJob, WorkbenchPage, WorkbenchRequest, WorkbenchSnapshot, WorkbenchValue, WorkflowImportKind, WorkflowImportPreview } from "../domain/workbench.ts";
import type { WemediaRemote } from "../remote/descriptors.ts";
import type { MediaPublicationType, PublicationAsset, PublicationDraft, PublicationDraftPreview, PublicationEdit, PublicationRequest } from "../domain/publicationDraft.ts";
import { publicationEdit } from "../domain/publicationDraft.ts";
import type { ChannelInspection } from "../domain/channelPublishing.ts";

export type View = "articles" | "references" | "agent" | "jobs" | "accounts" | "platforms" | "settings";
export type SessionTarget = Pick<SessionFace, "prompt">;
/** Host and Client share Cordis's merged Context type, but only this Client face is used. */
export function resolveCurrentSession(service: unknown): SessionTarget | undefined {
  const sessions = service as Partial<Pick<ISessions, "list" | "binding">> | undefined;
  if (typeof sessions?.binding !== "function" || typeof sessions.list?.getSnapshot !== "function") return undefined;
  const current = sessions.list.getSnapshot().current;
  return current ? sessions.binding(current)?.session : undefined;
}
export type CreateInput = { title: string; sourceUrl: string; kind: "paper" | "article" };
export type CreationPreview = { intent: ActionIntent; summary: string[] };
export type WorkflowImportState = { kind: WorkflowImportKind; artifact: ArtifactRef; preview: WorkflowImportPreview | null };
export type LeaveRequest = { kind: "close" | "discard" | "navigate" } | { kind: "select"; contentRef: ContentRef };
type Observation = { sequence: number; generationId: string | null; connection: number };
export interface ClientState {
  history: VersionHistory | null;
  comparison: VersionComparison | null;
  evidence: EvidenceDetail | null;
  evidenceRequested: string | null;
  open: boolean;
  view: View;
  connected: boolean;
  query: string;
  cursors: string[];
  pending: string[];
  snapshot: WorkbenchSnapshot | null;
  page: WorkbenchPage | null;
  selected: ContentRef | null;
  document: ArticleDocument | null;
  edit: ArticleEdit | null;
  mobile: PreviewDocument | null;
  gates: GateReport | null;
  actionPreview: ActionPreview | null;
  aiWorkflow: AiWorkflowResult | null;
  workflowImport: WorkflowImportState | null;
  creation: { input: CreateInput; preview: CreationPreview } | null;
  publication: PublicationDraft | null;
  publicationEdit: PublicationEdit | null;
  publicationAssets: PublicationAsset[];
  publicationPreview: PublicationDraftPreview | null;
  publicationCreation: PublicationDraftPreview | null;
  publicationRevision: number;
  leaveRequest: LeaveRequest | null;
  notice: { kind: "error" | "info"; text: string; code?: string } | null;
}

export class ClientFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function unwrapRemote<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new ClientFault(result.error.code, "无法连接工作台服务，请检查连接后重试。");
  return result.value;
}

export function unwrapAnswer(result: RemoteResult<WorkbenchAnswer>): WorkbenchValue {
  const answer = unwrapRemote(result);
  if (!answer.ok) throw new ClientFault(answer.error.code, answer.error.safeMessage);
  return answer.value;
}

export const terminalJob = (job: WorkbenchJob): boolean => ["succeeded", "failed", "cancelled", "timed_out", "reconcile_required"].includes(job.status);

/** Browser presentation state only. Execution and durable state remain on Host. */
export class WorkbenchController {
  private state: ClientState = { history: null, comparison: null, evidence: null, evidenceRequested: null, open: false, view: "articles", connected: false, query: "", cursors: [], pending: [], snapshot: null, page: null, selected: null, document: null, edit: null, mobile: null, gates: null, actionPreview: null, aiWorkflow: null, workflowImport: null, creation: null, publication: null, publicationEdit: null, publicationAssets: [], publicationPreview: null, publicationCreation: null, publicationRevision: 0, leaveRequest: null, notice: null };
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private stopped = false;
  private remote: WemediaRemote | undefined;
  private handedOff = new Set<string>();
  private submittedEdits = new Map<string, { contentRef: ContentRef; edit: string }>();
  private submittedCreations = new Set<string>();
  private submittedPublications = new Map<string, { contentRef: ContentRef; edit: string | null }>();
  private publicationVersion = 0;
  private articleListRefreshPending = false;
  private connectionVersion = 0;
  private articleVersion = 0;
  private searchVersion = 0;
  private observationSequence = 0;
  private snapshotSequence = 0;
  private retiredGenerations = new Set<string>();
  private pendingNavigation: (() => void) | undefined;
  private jobObservations = new Map<string, { observation: Observation; job: WorkbenchJob }>();
  private reconciledWechatJobs = new Set<string>();
  constructor(private readonly currentSession: () => SessionTarget | undefined) {}
  getSnapshot = (): ClientState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(update: Partial<ClientState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  connect(remote: WemediaRemote): void {
    if (this.stopped) return;
    if (this.remote !== remote) {
      this.abortRequests();
      this.connectionVersion += 1;
      this.retiredGenerations.clear();
    }
    this.remote = remote;
    this.patch({ connected: true, pending: [...this.requests.keys()] });
    if (this.state.open) void this.refresh();
  }
  unavailable(code = "REMOTE_UNAVAILABLE"): void {
    this.abortRequests();
    this.connectionVersion += 1;
    this.remote = undefined;
    this.patch({ connected: false, pending: [], notice: { kind: "error", code, text: "工作台服务尚不可用；请检查插件与 Host 连接。" } });
  }
  open(view: View = "articles"): void {
    this.patch({ open: true, view });
    if (this.remote) void this.refresh();
  }
  close(): void {
    this.pendingNavigation = undefined;
    this.abortRequests();
    this.patch({ open: false, pending: [], leaveRequest: null, actionPreview: null, creation: null, publicationPreview: null, publicationCreation: null });
  }
  private abortRequests(): void {
    this.articleListRefreshPending = false;
    this.reconciledWechatJobs.clear();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.patch({ aiWorkflow: null, workflowImport: null, history: null, comparison: null, evidence: null, evidenceRequested: null });
  }
  requestClose(): void { if (this.dirty) this.patch({ leaveRequest: { kind: "close" } }); else this.close(); }
  requestDiscard(): void { if (this.dirty) this.patch({ leaveRequest: { kind: "discard" } }); else this.discardEdits(); }
  cancelLeave(): void { this.pendingNavigation = undefined; this.patch({ leaveRequest: null, ...(this.state.notice?.code === "UNSAVED_EDIT" ? { notice: null } : {}) }); }
  /** The content library must not switch selection behind an unsaved editor. */
  requestNavigation(continueNavigation: () => void): void {
    if (this.stopped) return;
    if (!this.dirty) { continueNavigation(); return; }
    this.pendingNavigation = continueNavigation;
    this.patch({ leaveRequest: { kind: "navigate" } });
  }
  async confirmLeave(): Promise<void> {
    const request = this.state.leaveRequest;
    if (!request) return;
    const continueNavigation = this.pendingNavigation;
    this.pendingNavigation = undefined;
    this.patch({ leaveRequest: null, notice: null });
    this.discardEdits();
    if (request.kind === "close") this.close();
    else if (request.kind === "select") await this.select(request.contentRef);
    else if (request.kind === "navigate") continueNavigation?.();
  }
  navigate(view: View): void { if (view !== "references") this.requests.get("reference-task")?.abort(); this.patch({ view }); }
  clearNotice(): void { this.patch({ notice: null }); }
  discardAction(): void { this.requests.get("action-preview")?.abort(); this.patch({ actionPreview: null }); }
  discardCreation(): void { this.requests.get("create-preview")?.abort(); this.patch({ creation: null }); }
  discardPublicationPreview(): void { this.requests.get("publication-preview")?.abort(); this.patch({ publicationPreview: null }); }
  discardPublicationCreation(): void { this.requests.get("publication-create-preview")?.abort(); this.patch({ publicationCreation: null }); }
  discardEdits(): void {
    const document = this.state.document;
    this.discardAction();
    this.abortWorkflowRequests();
    this.articleVersion += 1;
    this.publicationVersion += 1;
    this.discardPublicationPreview();
    if (this.state.publication) this.patch({ publicationEdit: publicationEdit(this.state.publication), publicationAssets: [...this.state.publication.media], leaveRequest: null });
    if (document) this.patch({ edit: { metadata: { ...document.metadata }, html: document.html, markdown: document.markdown }, leaveRequest: null, ...(this.state.notice?.code === "UNSAVED_EDIT" ? { notice: null } : {}) });
  }
  dispose(): void {
    this.close();
    this.stopped = true;
    this.listeners.clear();
    this.remote = undefined;
    this.handedOff.clear();
    this.submittedEdits.clear();
    this.submittedCreations.clear();
    this.submittedPublications.clear();
    this.jobObservations.clear();
    this.retiredGenerations.clear();
  }
  private async call<T extends WorkbenchValue>(request: WorkbenchRequest, signal: AbortSignal): Promise<T> {
    if (!this.remote) throw new ClientFault("REMOTE_UNAVAILABLE", "工作台服务尚未连接。");
    const result = await this.remote.request(request, signal);
    if (signal.aborted) throw new ClientFault("REQUEST_CANCELLED", "请求已取消。");
    return unwrapAnswer(result) as T;
  }
  channelRequest(request: WorkbenchRequest, signal: AbortSignal = new AbortController().signal): Promise<WorkbenchValue> {
    if (this.stopped) return Promise.reject(new ClientFault("GENERATION_DISPOSED", "工作台已卸载"));
    if (this.dirty && ["channel_preview_action", "channel_start_action"].includes(request.operation)) return Promise.reject(new ClientFault("UNSAVED_EDIT", "请先保存当前编辑"));
    return this.call(request, signal);
  }
  async handoffChannelIntent(intentId: string): Promise<void> {
    if (this.dirty || this.stopped || !this.remote) throw new ClientFault("UNSAVED_EDIT", "请先保存当前编辑并确认连接");
    const session = this.currentSession();
    if (!session) throw new ClientFault("SESSION_REQUIRED", "请先选择当前 DSH 会话");
    if (this.handedOff.has(intentId)) throw new ClientFault("INTENT_ALREADY_QUEUED", "该意图已经交给当前 Agent");
    const key = `channel-handoff:${intentId}`;
    if (this.requests.has(key)) throw new ClientFault("INTENT_ALREADY_QUEUED", "该意图正在交给当前 Agent");
    const controller = new AbortController(), signal = controller.signal;
    const selected = this.state.selected, generation = this.state.snapshot?.generationId;
    const revision = this.state.publication?.revisionDigest ?? this.state.document?.revisionDigest;
    this.requests.set(key, controller);
    try {
      const task = unwrapRemote(await this.remote.intentTask({ intentId }, signal));
      if (signal.aborted || this.stopped || this.dirty || this.state.selected !== selected || this.state.snapshot?.generationId !== generation || (this.state.publication?.revisionDigest ?? this.state.document?.revisionDigest) !== revision || this.currentSession() !== session) throw new ClientFault("INTENT_EXPIRED", "当前内容或会话已变化，请重新预览");
      if (!task.ok || !task.prompt) throw new ClientFault(task.code, "渠道意图已失效，请重新预览");
      this.handedOff.add(intentId);
      await this.queue(session, task.prompt, signal);
    } finally { if (this.requests.get(key) === controller) this.requests.delete(key); }
  }
  /** Library UI uses the same strict Host request and error boundary. */
  requestContent<T extends WorkbenchValue>(request: WorkbenchRequest | PublicationRequest, signal: AbortSignal): Promise<T> {
    return this.call<T>(request as WorkbenchRequest, signal);
  }
  private async run(key: string, work: (signal: AbortSignal) => Promise<void>, exclusive = false, clearNotice = true): Promise<void> {
    if (this.stopped || (exclusive && this.requests.has(key))) return;
    this.requests.get(key)?.abort();
    const controller = new AbortController();
    this.requests.set(key, controller);
    this.patch({ pending: [...this.requests.keys()], ...(clearNotice ? { notice: null } : {}) });
    try { await work(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted && !this.stopped) this.patch({ notice: error instanceof ClientFault ? { kind: "error", code: error.code, text: error.message } : { kind: "error", code: "CLIENT_REQUEST_FAILED", text: "请求未完成，请刷新核对状态后再试；不会自动重试写入。" } });
    } finally {
      if (this.requests.get(key) === controller) this.requests.delete(key);
      this.patch({ pending: [...this.requests.keys()] });
    }
  }
  private abortWorkflowRequests(): void {
    for (const key of ["ai-inspect", "ai-preview", "workflow-import-preview", "workflow-import-apply", "history", "comparison", "evidence"]) this.requests.get(key)?.abort();
    this.patch({ aiWorkflow: null, workflowImport: null, history: null, comparison: null, evidence: null, evidenceRequested: null });
  }

  private currentSavedContext(): { contentRef: ContentRef; revisionDigest: string; articleVersion: number; generationId: string | null } | null {
    if (!this.state.selected || !this.state.document) return null;
    if (this.dirty) {
      this.patch({ notice: { kind: "error", code: "UNSAVED_EDIT", text: "请先保存或放弃当前编辑，再读取版本、审阅材料或运行诊断。" } });
      return null;
    }
    return { contentRef: this.state.selected, revisionDigest: this.state.document.revisionDigest, articleVersion: this.articleVersion, generationId: this.state.snapshot?.generationId ?? null };
  }

  private contextIsCurrent(context: { contentRef: ContentRef; revisionDigest: string; articleVersion: number; generationId: string | null }): boolean {
    return this.state.selected === context.contentRef
      && this.state.document?.revisionDigest === context.revisionDigest
      && this.articleVersion === context.articleVersion
      && (this.state.snapshot?.generationId ?? null) === context.generationId
      && !this.dirty;
  }

  loadHistory(): Promise<void> {
    const context = this.currentSavedContext(); if (!context) return Promise.resolve();
    this.patch({ history: null, comparison: null });
    return this.run("history", async signal => {
      const history = await this.call<VersionHistory>({ operation: "history", contentRef: context.contentRef }, signal);
      if (this.contextIsCurrent(context) && history.contentRef === context.contentRef) this.patch({ history });
    });
  }
  compareVersions(fromId: string, toId: string): Promise<void> {
    const context = this.currentSavedContext(); if (!context) return Promise.resolve();
    this.patch({ comparison: null });
    return this.run("comparison", async signal => {
      const comparison = await this.call<VersionComparison>({ operation: "compare_versions", contentRef: context.contentRef, fromId, toId }, signal);
      if (this.contextIsCurrent(context) && comparison.from.id === fromId && comparison.to.id === toId) this.patch({ comparison });
    });
  }
  readEvidence(evidenceId: string): Promise<void> {
    const context = this.currentSavedContext(); if (!context) return Promise.resolve();
    this.patch({ evidence: null, evidenceRequested: evidenceId });
    return this.run("evidence", async signal => {
      const evidence = await this.call<EvidenceDetail>({ operation: "evidence_detail", contentRef: context.contentRef, evidenceId }, signal);
      if (this.contextIsCurrent(context) && this.state.evidenceRequested === evidenceId && evidence.id === evidenceId) this.patch({ evidence });
    });
  }
  closeEvidence(): void { this.requests.get("evidence")?.abort(); this.patch({ evidence: null, evidenceRequested: null }); }

  aiInspect(): Promise<void> {
    const context = this.currentSavedContext();
    if (!context) return Promise.resolve();
    return this.run("ai-inspect", async signal => {
      const result = await this.call<AiWorkflowResult>({ operation: "ai_inspect", contentRef: context.contentRef }, signal);
      if (!this.contextIsCurrent(context) || result.operation !== "ai_inspect" || result.revisionDigest !== context.revisionDigest) throw new ClientFault("AI_RESULT_STALE", "AI 检查结果对应的文章版本已变化，请重新运行。");
      this.patch({ aiWorkflow: result });
    }, true);
  }

  aiPreview(): Promise<void> {
    const context = this.currentSavedContext();
    if (!context) return Promise.resolve();
    return this.run("ai-preview", async signal => {
      const result = await this.call<AiWorkflowResult>({ operation: "ai_preview", contentRef: context.contentRef }, signal);
      if (!this.contextIsCurrent(context) || result.operation !== "ai_preview" || result.revisionDigest !== context.revisionDigest) throw new ClientFault("AI_RESULT_STALE", "AI 预览结果对应的文章版本已变化，请重新运行。");
      this.patch({ aiWorkflow: result });
    }, true);
  }

  discardWorkflowImport(): void {
    this.requests.get("workflow-import-preview")?.abort();
    this.requests.get("workflow-import-apply")?.abort();
    this.patch({ workflowImport: null });
  }

  previewWorkflowImport(kind: WorkflowImportKind, artifact: ArtifactRef): Promise<void> {
    const context = this.currentSavedContext();
    if (!context) return Promise.resolve();
    const current = this.state.workflowImport;
    const samePreview = current?.kind === kind && JSON.stringify(current.artifact) === JSON.stringify(artifact);
    if (samePreview && this.requests.has("workflow-import-preview")) return Promise.resolve();
    const previous = this.requests.get("workflow-import-preview");
    previous?.abort();
    if (previous) this.requests.delete("workflow-import-preview");
    this.patch({ workflowImport: { kind, artifact: { ...artifact }, preview: null } });
    return this.run("workflow-import-preview", async signal => {
      const preview = await this.call<WorkflowImportPreview>({ operation: "preview_workflow_import", contentRef: context.contentRef, kind, artifact }, signal);
      if (!this.contextIsCurrent(context) || preview.kind !== kind || preview.intent.contentRef !== context.contentRef) throw new ClientFault("WORKFLOW_IMPORT_STALE", "导入预览对应的文章版本已变化，请重新预览。");
      const current = this.state.workflowImport;
      if (!current || current.kind !== kind || JSON.stringify(current.artifact) !== JSON.stringify(artifact)) throw new ClientFault("WORKFLOW_IMPORT_STALE", "导入目标已变化，请重新预览。");
      this.patch({ workflowImport: { ...current, preview } });
    }, true);
  }

  applyWorkflowImport(): Promise<void> {
    const workflowImport = this.state.workflowImport;
    const preview = workflowImport?.preview;
    const context = this.currentSavedContext();
    if (!preview || !context) return Promise.resolve();
    return this.run("workflow-import-apply", async signal => {
      this.assertIntent(preview.intent);
      const document = await this.call<ArticleDocument>({ operation: "apply_workflow_import", intentId: preview.intent.intentId }, signal);
      if (!this.contextIsCurrent(context) || document.contentRef !== context.contentRef || document.revisionDigest !== context.revisionDigest) throw new ClientFault("WORKFLOW_IMPORT_STALE", "导入结果对应的文章版本已变化，未应用旧结果；请重新预览。");
      this.patch({ document, edit: { metadata: { ...document.metadata }, html: document.html, markdown: document.markdown }, gates: null, workflowImport: null, notice: { kind: "info", text: "已记录原工作流材料，适用范围请看版本状态；没有上传或更新公众号草稿。" } });
      this.articleListRefreshPending = true;
      this.refreshArticleList();
    }, true);
  }

  refresh(): Promise<void> {
    return this.run("snapshot", async signal => {
      const observation = this.observe();
      const searchVersion = this.searchVersion;
      const snapshot = await this.call<WorkbenchSnapshot>({ operation: "refresh" }, signal);
      const accepted = this.acceptSnapshot(snapshot, observation);
      if (!accepted && (observation.connection !== this.connectionVersion || snapshot.generationId !== this.state.snapshot?.generationId)) return;
      if (this.state.view === "articles" && this.searchVersion === searchVersion) await this.search(this.state.query, this.state.cursors);
    });
  }
  refreshStatus(): Promise<void> {
    return this.run("status", async signal => {
      const observation = this.observe();
      this.acceptSnapshot(await this.call<WorkbenchSnapshot>({ operation: "snapshot" }, signal), observation);
    }, true, false);
  }
  search(query: string, cursors: string[] = []): Promise<void> {
    return this.searchPage(query, cursors, true);
  }
  private searchPage(query: string, cursors: string[], clearNotice: boolean): Promise<void> {
    this.searchVersion += 1;
    const requestedCursors = [...cursors];
    return this.run("search", async signal => {
      const cursor = requestedCursors.at(-1);
      try {
        const page = await this.call<WorkbenchPage>({ operation: "search", query, pageSize: 20, ...(cursor ? { cursor } : {}) }, signal);
        this.patch({ query, cursors: requestedCursors, page });
      } catch (error) {
        if (!(error instanceof ClientFault) || error.code !== "CURSOR_STALE" || !cursor || signal.aborted) throw error;
        const page = await this.call<WorkbenchPage>({ operation: "search", query, pageSize: 20 }, signal);
        this.patch({ query, cursors: [], page, notice: { kind: "info", code: "CURSOR_STALE", text: "文章列表已变化，原分页已失效；已返回第一页，请重新选择分页。" } });
      }
    }, false, clearNotice).finally(() => this.refreshArticleList());
  }
  nextPage(): Promise<void> {
    const cursor = this.state.page?.nextCursor;
    return cursor ? this.search(this.state.query, [...this.state.cursors, cursor]) : Promise.resolve();
  }
  previousPage(): Promise<void> { return this.search(this.state.query, this.state.cursors.slice(0, -1)); }
  select(contentRef: ContentRef): Promise<void> {
    if (this.dirty) {
      this.patch({ leaveRequest: { kind: "select", contentRef }, notice: { kind: "error", code: "UNSAVED_EDIT", text: "当前有未保存编辑。请确认是否放弃编辑后切换或刷新文章。" } });
      return Promise.resolve();
    }
    this.requests.get("wechat-result")?.abort();
    this.requests.get("job-content")?.abort();
    this.requests.get("action-preview")?.abort();
    this.abortWorkflowRequests();
    this.articleVersion += 1;
    this.requests.get("publication-read")?.abort(); this.requests.get("publication-preview")?.abort(); this.publicationVersion += 1;
    this.patch({ selected: contentRef, document: null, edit: null, publication: null, publicationEdit: null, publicationAssets: [], publicationPreview: null, mobile: null, gates: null, actionPreview: null, aiWorkflow: null, workflowImport: null, leaveRequest: null });
    return this.run("article", async signal => {
      const document = await this.call<ArticleDocument>({ operation: "inspect", contentRef }, signal);
      this.patch({ document, edit: { metadata: { ...document.metadata }, html: document.html, markdown: document.markdown } });
      const mobile = await this.call<PreviewDocument>({ operation: "preview", contentRef }, signal);
      this.patch({ mobile });
    });
  }
  updateEdit(update: { title?: string; digest?: string; html?: string }): void {
    if (!this.state.edit) return;
    const resultRead = this.requests.get("wechat-result");
    if (resultRead && !resultRead.signal.aborted) { resultRead.abort(); this.wechatRefreshRequired(); }
    this.requests.get("action-preview")?.abort();
    this.abortWorkflowRequests();
    this.articleVersion += 1;
    const edit = this.state.edit;
    this.patch({ actionPreview: null, edit: { ...edit, metadata: { ...edit.metadata, ...(update.title !== undefined ? { title: update.title } : {}), ...(update.digest !== undefined ? { digest: update.digest } : {}) }, ...(update.html !== undefined ? { html: update.html } : {}) } });
  }
  get dirty(): boolean {
    return (!!this.state.document && !!this.state.edit && JSON.stringify(this.state.edit) !== JSON.stringify({ metadata: this.state.document.metadata, html: this.state.document.html, markdown: this.state.document.markdown })) || (!!this.state.publication && !!this.state.publicationEdit && JSON.stringify(this.state.publicationEdit) !== JSON.stringify(publicationEdit(this.state.publication)));
  }
  async selectPublication(contentRef: ContentRef): Promise<void> {
    if (this.dirty) { this.requestNavigation(() => { void this.selectPublication(contentRef); }); return; }
    this.requests.get("wechat-result")?.abort();
    this.requests.get("job-content")?.abort();
    this.requests.get("article")?.abort(); this.requests.get("action-preview")?.abort(); this.abortWorkflowRequests();
    this.discardPublicationPreview(); this.publicationVersion += 1;
    this.patch({ selected: contentRef, document: null, edit: null, mobile: null, publication: null, publicationEdit: null, publicationAssets: [], gates: null, actionPreview: null, leaveRequest: null });
    await this.run("publication-read", async signal => {
      const draft = await this.requestContent<PublicationDraft>({ operation: "publication_read", contentRef }, signal);
      if (this.state.selected === contentRef) this.patch({ publication: draft, publicationEdit: publicationEdit(draft), publicationAssets: [...draft.media] });
    });
  }
  /** Channel jobs cover both article and media drafts; resolve their actual saved type. */
  async openJobContent(job: Pick<WorkbenchJob, "contentRef" | "action">): Promise<void> {
    if (this.dirty) { this.requestNavigation(() => { void this.openJobContent(job); }); return; }
    if (["create_publication", "save_publication"].includes(job.action)) { this.navigate("articles"); await this.selectPublication(job.contentRef); return; }
    if (!job.action.startsWith("channel_")) { this.navigate("articles"); await this.select(job.contentRef); return; }
    const selected = this.state.selected, articleVersion = this.articleVersion, publicationVersion = this.publicationVersion, generationId = this.state.snapshot?.generationId;
    await this.run("job-content", async signal => {
      const inspection = await this.call<ChannelInspection>({ operation: "channel_inspect", contentRef: job.contentRef }, signal);
      if (this.state.selected !== selected || this.articleVersion !== articleVersion || this.publicationVersion !== publicationVersion || this.state.snapshot?.generationId !== generationId || this.dirty) throw new ClientFault("JOB_CONTENT_STALE", "内容选择或编辑已变化，请重新打开任务内容。");
      if (inspection.contentRef !== job.contentRef || !["article", "image_text", "video"].includes(inspection.publicationType)) throw new ClientFault("JOB_CONTENT_TYPE_INVALID", "尚未核实任务的内容类型，请刷新后重试。");
      this.navigate("articles");
      if (inspection.publicationType === "article") await this.select(job.contentRef); else await this.selectPublication(job.contentRef);
    });
  }
  get publicationReadOnly(): boolean { return this.state.publication?.readOnlySource === true || this.state.snapshot?.settings.hasWriteRoot === false; }
  private allowPublicationWrite(create = false): boolean {
    if (this.state.snapshot?.settings.hasWriteRoot !== false && (create || !this.state.publication?.readOnlySource)) return true;
    this.patch({ notice: { kind: "error", code: "WRITE_ROOT_MISSING", text: "写入已停用，当前发布稿可只读预览；未保存内容仍保留。" } });
    return false;
  }
  updatePublicationEdit(update: Partial<Pick<PublicationEdit, "title" | "body" | "media" | "coverItemId" | "channels">>, assets: PublicationAsset[] = []): void {
    if (!this.state.publicationEdit || !this.allowPublicationWrite()) return;
    this.discardPublicationPreview(); this.publicationVersion += 1;
    const edit = { ...this.state.publicationEdit, ...structuredClone(update) };
    const available = new Map([...this.state.publicationAssets, ...assets].map(asset => [asset.itemId, asset]));
    this.patch({ publicationEdit: edit, publicationAssets: edit.media.flatMap(selection => { const asset = available.get(selection.itemId); return asset ? [{ ...asset, ...selection }] : []; }) });
  }
  previewPublicationSave(): Promise<void> {
    const draft = this.state.publication, edit = this.state.publicationEdit, version = this.publicationVersion;
    if (!draft || !edit || !this.allowPublicationWrite()) return Promise.resolve();
    this.patch({ publicationPreview: null });
    return this.run("publication-preview", async signal => {
      const preview = await this.requestContent<PublicationDraftPreview>({ operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: structuredClone(edit) }, signal);
      if (this.state.publication?.contentRef === draft.contentRef && this.publicationVersion === version) this.patch({ publicationPreview: preview });
    });
  }
  previewPublicationCreation(publicationType: MediaPublicationType, title: string): Promise<void> {
    if (!this.allowPublicationWrite(true)) return Promise.resolve();
    this.patch({ publicationCreation: null });
    return this.run("publication-create-preview", async signal => {
      const preview = await this.requestContent<PublicationDraftPreview>({ operation: "create_publication", publicationType, title }, signal);
      this.patch({ publicationCreation: preview });
    });
  }
  async confirmPublication(create = false): Promise<WorkbenchJob | null> {
    const preview = create ? this.state.publicationCreation : this.state.publicationPreview;
    if (!preview || !this.allowPublicationWrite(create)) return null;
    let submitted: WorkbenchJob | null = null;
    await this.run("mutation", async signal => {
      this.assertIntent(preview.intent);
      if (preview.intent.sideEffect !== "local_write" || preview.intent.action !== (create ? "create_publication" : "save_publication") || preview.intent.contentRef !== preview.publication.contentRef || !create && preview.intent.contentRef !== this.state.publication?.contentRef) throw new ClientFault("INTENT_MISMATCH", "发布稿预览与当前本地操作不一致，请重新预览。");
      const observation = this.observe();
      this.submittedPublications.set(preview.intent.intentId, { contentRef: preview.intent.contentRef, edit: create ? null : JSON.stringify(this.state.publicationEdit) });
      const job = await this.call<WorkbenchJob>({ operation: "start_action", intentId: preview.intent.intentId }, signal);
      submitted = job; this.acceptJob(job, observation, true);
      this.patch({ publicationPreview: null, publicationCreation: null, notice: { kind: "info", text: "本地操作已提交，完成状态将在任务中心显示。" } });
    }, true);
    return submitted;
  }
  preflight(): Promise<void> {
    const contentRef = this.state.selected;
    if (!contentRef) return Promise.resolve();
    return this.run("preflight", async signal => {
      const gates = await this.call<GateReport>({ operation: "preflight", contentRef }, signal);
      if (this.state.selected === contentRef) this.patch({ gates });
    });
  }
  previewAction(action: ActionPreview["action"], targetRef?: string): Promise<void> {
    const contentRef = this.state.selected;
    if (!contentRef || !this.state.edit) return Promise.resolve();
    const edit = structuredClone(this.state.edit);
    this.patch({ actionPreview: null });
    return this.run("action-preview", async signal => {
      if (action !== "save_revision" && this.dirty) throw new ClientFault("UNSAVED_EDIT", "请先保存编辑并刷新文章，再预览后续操作。");
      const actionPreview = await this.call<ActionPreview>({ operation: "preview_action", contentRef, action, ...(targetRef ? { targetRef } : {}), ...(action === "save_revision" ? { edit } : {}) }, signal);
      if (this.state.selected === contentRef) this.patch({ actionPreview });
    });
  }
  confirmAction(): Promise<void> {
    const preview = this.state.actionPreview;
    if (!preview) return Promise.resolve();
    return this.run("mutation", async signal => {
      const intent = preview.intent;
      this.assertIntent(intent);
      if (preview.action === "create_draft" || preview.action === "update_draft") {
        await this.handoffIntent(intent, signal);
        this.patch({ actionPreview: null, notice: { kind: "info", text: "精确操作意图已排队交给当前 Agent，尚未执行完成。请在会话中处理原生审批，再刷新任务结果。" } });
      } else {
        const submittedEdit = preview.action === "save_revision" ? JSON.stringify(this.state.edit) : undefined;
        const observation = this.observe();
        // A concurrent snapshot may observe completion before this write response arrives.
        if (submittedEdit) this.submittedEdits.set(intent.intentId, { contentRef: intent.contentRef, edit: submittedEdit });
        const job = await this.call<WorkbenchJob>({ operation: "start_action", intentId: intent.intentId }, signal);
        this.acceptJob(job, observation, true);
        this.patch({ actionPreview: null, notice: { kind: "info", text: "Host 已接收操作。页面可见时会有限跟踪进度，也可手动刷新；任务完成前不代表保存成功。" } });
      }
    }, true);
  }
  private assertIntent(intent: ActionIntent): void {
    if (intent.blockingGateCodes.length) throw new ClientFault("GATES_BLOCKED", `操作仍被阻断：${intent.blockingGateCodes.join("、")}`);
    if (!Number.isFinite(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= Date.now()) throw new ClientFault("INTENT_EXPIRED", "预览已过期，请重新预览。");
  }
  private async handoffIntent(intent: ActionIntent, signal: AbortSignal): Promise<void> {
    const session = this.currentSession();
    if (!session) throw new ClientFault("SESSION_REQUIRED", "请先在 DSH 选择当前会话，再交给 Agent；工作台不会新建会话或切换模型。");
    if (this.handedOff.has(intent.intentId)) throw new ClientFault("INTENT_ALREADY_QUEUED", "该意图已交给 Agent，请先核对当前会话与任务结果，不要重复排队。");
    if (!this.remote) throw new ClientFault("REMOTE_UNAVAILABLE", "工作台服务尚未连接。");
    const contentRef = this.state.selected, revisionDigest = (this.state.document ?? this.state.publication)?.revisionDigest;
    const articleVersion = this.articleVersion, publicationVersion = this.publicationVersion, generationId = this.state.snapshot?.generationId;
    const task = unwrapRemote(await this.remote.intentTask({ intentId: intent.intentId }, signal));
    if (signal.aborted) throw new ClientFault("REQUEST_CANCELLED", "请求已取消。");
    if (this.currentSession() !== session || this.state.selected !== contentRef || intent.contentRef !== contentRef || (this.state.document ?? this.state.publication)?.revisionDigest !== revisionDigest || this.articleVersion !== articleVersion || this.publicationVersion !== publicationVersion || this.state.snapshot?.generationId !== generationId || this.dirty) throw new ClientFault("INTENT_EXPIRED", "当前会话、内容或编辑已变化，旧操作未排队；请重新预览。");
    if (!task.ok || !task.prompt.trim()) throw new ClientFault(task.code, "无法生成该操作的 Agent 任务，请重新预览。");
    await this.queue(session, task.prompt, signal);
    this.handedOff.add(intent.intentId);
  }
  private async queue(session: SessionTarget, prompt: string, signal: AbortSignal): Promise<void> {
    const result = await session.prompt([{ type: "text", text: prompt }], "queue", signal);
    if (signal.aborted) throw new ClientFault("REQUEST_CANCELLED", "请求已取消，请在当前会话核对是否已排队。");
    if (!result.ok || !result.value.accepted) throw new ClientFault(result.ok ? "PROMPT_NOT_ACCEPTED" : result.error.code, "当前会话未确认接收任务，请检查会话状态；尚不能视为已排队。");
  }
  async queueReferenceTask(ids: string[], action: "analyze" | "write", instruction: string): Promise<void> {
    const session = this.currentSession(), generationId = this.state.snapshot?.generationId, connection = this.connectionVersion;
    if (!session) throw new ClientFault("SESSION_REQUIRED", "请先在 DSH 选择一个会话，再交给当前模型分析或创作。");
    if (!this.state.connected || this.stopped) throw new ClientFault("REMOTE_UNAVAILABLE", "工作台连接已断开。");
    if (this.requests.has("reference-task")) throw new ClientFault("TASK_BUSY", "参考任务正在提交，请等待当前结果。");
    const abort = new AbortController(); this.requests.set("reference-task", abort);
    try {
      const brief = await this.call<import("../domain/references.ts").ReferenceBrief>({ operation: "reference_brief", ids, action, instruction }, abort.signal);
      if (abort.signal.aborted || this.currentSession() !== session || this.state.view !== "references" || this.state.snapshot?.generationId !== generationId || this.connectionVersion !== connection || brief.action !== action || JSON.stringify(brief.ids) !== JSON.stringify(ids)) throw new ClientFault("TASK_BRIEF_STALE", "当前会话或参考页面已变化，任务未提交，请重新选择。");
      await this.queue(session, brief.prompt, abort.signal);
    } finally { if (this.requests.get("reference-task") === abort) this.requests.delete("reference-task"); }
  }
  taskBrief(action: TaskBrief["action"]): Promise<void> {
    const contentRef = this.state.selected;
    const revisionDigest = (this.state.document ?? this.state.publication)?.revisionDigest;
    const articleVersion = this.articleVersion, publicationVersion = this.publicationVersion, generationId = this.state.snapshot?.generationId;
    if (!contentRef || !revisionDigest) return Promise.resolve();
    return this.run("agent-task", async signal => {
      const session = this.currentSession();
      if (!session) throw new ClientFault("SESSION_REQUIRED", "请先在 DSH 选择当前会话，工作台不会新建会话或切换模型。");
      if (this.dirty) throw new ClientFault("UNSAVED_EDIT", "请先保存当前编辑，Agent 任务只读取已保存版本。");
      if (this.state.publication && action === "write_draft" && !this.allowPublicationWrite()) return;
      const brief = await this.call<TaskBrief>({ operation: "task_brief", contentRef, action }, signal);
      if (this.currentSession() !== session || this.state.selected !== contentRef || (this.state.document ?? this.state.publication)?.revisionDigest !== revisionDigest || this.articleVersion !== articleVersion || this.publicationVersion !== publicationVersion || this.state.snapshot?.generationId !== generationId || this.dirty || brief.contentRef !== contentRef || brief.revisionDigest !== revisionDigest || brief.action !== action) throw new ClientFault("TASK_BRIEF_STALE", "当前会话、内容选择、版本或编辑已变化，旧任务未排队；请确认后重新生成任务。");
      if (this.state.publication && action === "write_draft" && !this.allowPublicationWrite()) return;
      await this.queue(session, brief.prompt, signal);
      this.patch({ notice: { kind: "info", text: "任务已排队到当前 Agent，尚未完成。请在会话查看研究、写作或审阅结果。" } });
    }, true);
  }
  previewCreation(input: CreateInput): Promise<void> {
    this.patch({ creation: null });
    return this.run("create-preview", async signal => {
      const preview = await this.call<CreationPreview>({ operation: "create_content", ...input }, signal);
      this.patch({ creation: { input: { ...input }, preview } });
    });
  }
  /** Return only this submission's acknowledged job; handled failures resolve null. */
  async confirmCreation(): Promise<WorkbenchJob | null> {
    const creation = this.state.creation;
    if (!creation) return null;
    let submitted: WorkbenchJob | null = null;
    await this.run("mutation", async signal => {
      this.assertIntent(creation.preview.intent);
      const observation = this.observe();
      // Register before awaiting submission: a status read can see this exact
      // intent finish before its original write response reaches the Client.
      this.submittedCreations.add(creation.preview.intent.intentId);
      const job = await this.call<WorkbenchJob>({ operation: "create_content", ...creation.input, applyIntentId: creation.preview.intent.intentId }, signal);
      this.acceptJob(job, observation, true);
      this.patch({ creation: null, notice: { kind: "info", text: "新建文章已提交为本地任务，不会上传。成功后会更新文章列表。" } });
      submitted = job;
    }, true);
    return submitted;
  }
  private observe(): Observation {
    return { sequence: ++this.observationSequence, generationId: this.state.snapshot?.generationId ?? null, connection: this.connectionVersion };
  }
  private mergeJob(job: WorkbenchJob, observation: Observation): { job: WorkbenchJob; accepted: boolean } {
    const previous = this.jobObservations.get(job.jobId);
    // Host revision belongs to the article index, not Job mutations. Sequence
    // orders overlapping reads; same-generation terminal states cannot regress
    // to a cached running/queued response. A new Host generation resets this.
    if (previous && (!previous.observation.generationId || previous.observation.generationId === observation.generationId)) {
      const sameJobGeneration = previous.job.generationId === job.generationId;
      const advancesToTerminal = sameJobGeneration && !terminalJob(previous.job) && terminalJob(job);
      if ((!advancesToTerminal && previous.observation.sequence > observation.sequence) || (sameJobGeneration && terminalJob(previous.job) && !terminalJob(job)) || (sameJobGeneration && previous.job.status === "running" && ["queued", "waiting_user"].includes(job.status))) return { job: previous.job, accepted: false };
      observation = { ...observation, sequence: Math.max(previous.observation.sequence, observation.sequence) };
    }
    this.jobObservations.set(job.jobId, { job, observation });
    return { job, accepted: true };
  }
  private acceptSnapshot(snapshot: WorkbenchSnapshot, observation: Observation): boolean {
    if (observation.connection !== this.connectionVersion || this.retiredGenerations.has(snapshot.generationId)) return false;
    const previousGeneration = this.state.snapshot?.generationId;
    if (observation.sequence < this.snapshotSequence) {
      if (previousGeneration === snapshot.generationId) for (const job of snapshot.jobs) {
        const previous = this.jobObservations.get(job.jobId)?.job;
        if (previous && previous.generationId === job.generationId && !terminalJob(previous) && terminalJob(job)) this.acceptJob(job, { ...observation, generationId: snapshot.generationId });
      }
      return false;
    }
    if (previousGeneration && previousGeneration !== snapshot.generationId) {
      this.requests.get("wechat-result")?.abort();
      this.reconciledWechatJobs.clear();
      this.abortWorkflowRequests();
      this.retiredGenerations.add(previousGeneration);
      this.jobObservations.clear();
    }
    this.snapshotSequence = observation.sequence;
    const currentObservation = { ...observation, generationId: snapshot.generationId };
    const jobs = snapshot.jobs.map(job => this.mergeJob(job, currentObservation).job);
    const ids = new Set(jobs.map(job => job.jobId));
    const newer = [...this.jobObservations.values()].filter(entry => !ids.has(entry.job.jobId) && entry.observation.sequence > observation.sequence && (!entry.observation.generationId || entry.observation.generationId === snapshot.generationId)).map(entry => entry.job);
    const merged = { ...snapshot, jobs: [...newer, ...jobs] };
    const retained = new Set(merged.jobs.map(job => job.jobId));
    for (const id of this.jobObservations.keys()) if (!retained.has(id)) this.jobObservations.delete(id);
    this.patch({ snapshot: merged, ...(previousGeneration && previousGeneration !== snapshot.generationId ? { actionPreview: null, creation: null, publicationPreview: null, publicationCreation: null, aiWorkflow: null, workflowImport: null, history: null, comparison: null, evidence: null, evidenceRequested: null } : {}) });
    for (const job of merged.jobs) this.reconcileSubmittedJob(job);
    return true;
  }
  private acceptJob(job: WorkbenchJob, observation: Observation, navigateToJobs = false): void {
    // Job.generationId records its creation generation and survives recovery;
    // reject late responses using the outer Host generation observed at send.
    const generationId = this.state.snapshot?.generationId;
    if (observation.connection !== this.connectionVersion || (generationId && observation.generationId && generationId !== observation.generationId)) return;
    const merged = this.mergeJob(job, { ...observation, generationId: generationId ?? observation.generationId });
    if (merged.accepted) {
      if (this.state.snapshot) this.patch({ snapshot: { ...this.state.snapshot, jobs: [merged.job, ...this.state.snapshot.jobs.filter(existing => existing.jobId !== job.jobId)] } });
      this.reconcileSubmittedJob(merged.job);
    }
    if (navigateToJobs) this.patch({ view: "jobs" });
  }
  private reconcileSubmittedJob(job: WorkbenchJob): void {
    if (!terminalJob(job)) return;
    this.reconcileWechatJob(job);
    const publication = this.submittedPublications.get(job.intentId);
    if (publication) {
      this.submittedPublications.delete(job.intentId);
      if (job.status === "succeeded") {
        this.patch({ publicationRevision: this.state.publicationRevision + 1 });
        if (publication.edit && this.state.open && this.state.connected && this.state.publication?.contentRef === publication.contentRef && JSON.stringify(this.state.publicationEdit) === publication.edit) {
          this.discardEdits(); void this.selectPublication(publication.contentRef);
        }
      }
    }
    if (job.action === "create_content" && this.submittedCreations.delete(job.intentId) && job.status === "succeeded" && this.state.open && this.state.connected) {
      this.articleListRefreshPending = true;
      this.refreshArticleList();
    }
    const saved = this.submittedEdits.get(job.intentId);
    if (!saved) return;
    this.submittedEdits.delete(job.intentId);
    if (job.status === "succeeded" && this.state.open && this.state.connected) {
      this.articleListRefreshPending = true;
      this.refreshArticleList();
    }
    // Only a verified successful exact intent can clear its unchanged browser edit.
    // Failed saves and edits made after submission always remain available.
    if (job.status === "succeeded" && this.state.selected === saved.contentRef && JSON.stringify(this.state.edit) === saved.edit) {
      this.discardEdits();
      void this.select(saved.contentRef);
    }
  }
  private wechatRefreshRequired(): void {
    this.patch({ notice: { kind: "info", code: "WECHAT_RESULT_REFRESH_REQUIRED", text: "公众号任务已结束，当前编辑保持不变。请先保存或放弃修改，再点击“刷新文章”核对草稿结果；不要直接重复创建。" } });
  }
  /** A terminal Agent job can change targets even when its submission was not owned by this Client. */
  private reconcileWechatJob(job: WorkbenchJob): void {
    if (!["create_draft", "update_draft", "sync"].includes(job.action)) return;
    const key = `${job.generationId}:${job.jobId}`;
    if (this.reconciledWechatJobs.has(key)) return;
    this.reconciledWechatJobs.add(key);
    if (!this.state.open || !this.state.connected || this.state.selected !== job.contentRef || this.state.document?.contentRef !== job.contentRef) return;
    if (this.dirty) { this.wechatRefreshRequired(); return; }
    const context = this.currentSavedContext()!, connection = this.connectionVersion;
    void this.run("wechat-result", async signal => {
      // A snapshot may contain several terminal jobs for this article. Coalesce
      // that batch without starting timers or retrying any Host operation.
      await Promise.resolve();
      const current = () => !signal.aborted && this.state.open && this.state.connected && this.connectionVersion === connection && this.contextIsCurrent(context);
      if (!current()) return;
      try {
        const document = await this.call<ArticleDocument>({ operation: "inspect", contentRef: context.contentRef }, signal);
        if (!current()) return;
        if (document.contentRef !== context.contentRef) throw new ClientFault("WECHAT_RESULT_MISMATCH", "文章身份不匹配");
        const mobile = await this.call<PreviewDocument>({ operation: "preview", contentRef: context.contentRef }, signal);
        if (!current()) return;
        if (mobile.revisionDigest !== document.revisionDigest) throw new ClientFault("WECHAT_RESULT_MISMATCH", "文章与预览版本不匹配");
        this.requests.get("action-preview")?.abort();
        const revisionChanged = document.revisionDigest !== context.revisionDigest;
        if (revisionChanged) this.articleVersion += 1;
        this.patch({ document, edit: { metadata: { ...document.metadata }, html: document.html, markdown: document.markdown }, mobile, actionPreview: null, publicationRevision: this.state.publicationRevision + 1,
          ...(revisionChanged ? { gates: null, aiWorkflow: null, workflowImport: null } : {}) });
      } catch {
        if (current()) this.patch({ notice: { kind: "error", code: "WECHAT_RESULT_REFRESH_FAILED", text: "公众号任务已结束，但文章与草稿结果尚未刷新。请点击“刷新文章”只读核对，勿重复创建；任务原有状态保持不变。" } });
      }
    }, false, false);
  }
  private refreshArticleList(): void {
    // Let an in-flight user search commit first, then read its current query and
    // cursor. A later explicit search can still supersede this read normally.
    if (!this.articleListRefreshPending || this.stopped || !this.state.open || !this.state.connected || this.requests.has("search")) return;
    this.articleListRefreshPending = false;
    void this.searchPage(this.state.query, this.state.cursors, false);
  }
  refreshJob(jobId: string): Promise<void> {
    return this.run(`job-read:${jobId}`, async signal => {
      const observation = this.observe();
      this.acceptJob(await this.call<WorkbenchJob>({ operation: "get_job", jobId }, signal), observation);
    });
  }
  cancelJob(jobId: string): Promise<void> {
    return this.run(`job-cancel:${jobId}`, async signal => {
      const observation = this.observe();
      this.acceptJob(await this.call<WorkbenchJob>({ operation: "cancel_job", jobId }, signal), observation);
      this.patch({ notice: { kind: "info", text: "取消请求已发送；请刷新确认最终状态。远端结果不确定时不可直接重试创建。" } });
    }, true);
  }
}

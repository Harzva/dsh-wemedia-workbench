import { DRAFT_BATCH_LIMIT, isDraftBatchId, type DraftBatch, type DraftBatchEntry, type DraftBatchPreview, type DraftBatchRequest, type DraftBatchScope } from "../domain/draftBatch.ts";
import { isJsonObject, type JsonObject } from "../domain/json.ts";
import { parseContentRef, type ContentRef } from "../domain/primitives.ts";
import type { ActionPreview, ArticleDocument, WorkbenchCaller, WorkbenchJob } from "../domain/workbench.ts";
import { WorkbenchFault } from "../domain/workbenchFault.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { WorkbenchStateStore } from "../ports/repositories.ts";

interface SavedBatch extends DraftBatch { ownerSessionId: string; sourceIntentId: string }
interface SavedPreview { value: DraftBatchPreview; batchId: string | null }
interface DraftBatchOptions {
  generationId: string;
  store: WorkbenchStateStore;
  clock: Clock;
  ids: IdGenerator;
  candidates(scope: DraftBatchScope, refs: ContentRef[] | undefined, signal: AbortSignal): Promise<DraftBatchEntry[]>;
  preview(entry: DraftBatchEntry, signal: AbortSignal): Promise<ActionPreview>;
  start(intentId: string, caller: WorkbenchCaller, signal: AbortSignal): Promise<WorkbenchJob>;
  jobs(): WorkbenchJob[];
  cancelJob(jobId: string): Promise<WorkbenchJob>;
  inspect(contentRef: ContentRef): Promise<ArticleDocument>;
}

const ENTRY_STATUSES = new Set(["pending", "skipped", "blocked", "running", "succeeded", "failed", "cancelled", "reconcile_required"]);
const ACTIVE_JOBS = new Set(["queued", "running", "waiting_user"]);
const STOP_CODES = new Set(["APPROVAL_DENIED", "APPROVAL_INVALID", "REQUEST_CANCELLED", "AGENT_APPROVAL_REQUIRED"]);
const BEFORE_DISPATCH_CODES = new Set(["INTENT_EXPIRED", "INTENT_CHANGED", "GATES_BLOCKED", "CONTENT_BUSY", "REFERENCE_BUSY", "ACCOUNT_BUSY", "RECONCILE_REQUIRED", "DRAFT_TARGET_EXISTS", ...STOP_CODES]);
const copy = <T>(value: T): T => structuredClone(value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length <= max;
const nullableId = (value: unknown): value is string | null => value === null || isDraftBatchId(value);

function invalidState(): never { throw new WorkbenchFault("BATCH_STATE_INVALID", "批量草稿记录损坏，已停止自动发送；请先核对原生任务记录"); }
function entry(value: unknown): DraftBatchEntry {
  if (!isJsonObject(value) || !text(value.contentRef) || !parseContentRef(value.contentRef).ok || !text(value.title, 500) || !(value.revisionDigest === null || text(value.revisionDigest)) || !(value.inputDigest === null || text(value.inputDigest)) || !text(value.status) || !ENTRY_STATUSES.has(value.status) || !text(value.code, 100) || !text(value.safeMessage, 1000) || !nullableId(value.jobId) || !nullableId(value.intentId) || !nullableId(value.targetRef)) return invalidState();
  if ((value.status === "pending" && (value.jobId !== null || value.intentId !== null || value.targetRef !== null || !value.revisionDigest || !value.inputDigest)) || (["running", "succeeded"].includes(value.status) && (value.intentId === null || !value.revisionDigest || !value.inputDigest)) || (value.status === "succeeded" && (value.jobId === null || value.targetRef === null))) return invalidState();
  return { contentRef: value.contentRef as ContentRef, title: value.title, revisionDigest: value.revisionDigest, inputDigest: value.inputDigest, status: value.status as DraftBatchEntry["status"], code: value.code, safeMessage: value.safeMessage, jobId: value.jobId, intentId: value.intentId, targetRef: value.targetRef };
}
function records(value: unknown): Record<string, SavedBatch> {
  if (value === undefined) return Object.create(null) as Record<string, SavedBatch>;
  if (!isJsonObject(value) || Object.keys(value).length > 1000) return invalidState();
  const result = Object.create(null) as Record<string, SavedBatch>;
  for (const [key, raw] of Object.entries(value)) {
    if (!isJsonObject(raw) || raw.schemaVersion !== "wemedia.draft-batch/v1" || !isDraftBatchId(raw.batchId) || key !== raw.batchId || !isDraftBatchId(raw.generationId) || !text(raw.ownerSessionId, 256) || !raw.ownerSessionId || !isDraftBatchId(raw.sourceIntentId) || !text(raw.createdAt, 40) || !Number.isFinite(Date.parse(raw.createdAt)) || !["running", "completed", "stopped"].includes(raw.status as string) || !Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > DRAFT_BATCH_LIMIT) return invalidState();
    const entries = raw.entries.map(entry);
    if (new Set(entries.map(item => item.contentRef)).size !== entries.length || entries.filter(item => item.status === "running").length > 1 || (raw.status !== "running" && entries.some(item => item.status === "pending")) || (raw.status === "completed" && entries.some(item => item.status === "running" || item.status === "reconcile_required"))) return invalidState();
    result[key] = { schemaVersion: "wemedia.draft-batch/v1", batchId: raw.batchId, generationId: raw.generationId, ownerSessionId: raw.ownerSessionId, sourceIntentId: raw.sourceIntentId, createdAt: raw.createdAt, status: raw.status as DraftBatch["status"], entries };
  }
  return result;
}
function dto(value: SavedBatch): DraftBatch {
  return { schemaVersion: value.schemaVersion, batchId: value.batchId, generationId: value.generationId, status: value.status, createdAt: value.createdAt, entries: copy(value.entries) };
}
function stop(batch: SavedBatch, code: string): void {
  batch.status = "stopped";
  for (const item of batch.entries) if (item.status === "pending") Object.assign(item, { status: "cancelled", code, safeMessage: "队列已停止，未发送此文章" });
}

export class DraftBatchService {
  private readonly previews = new Map<string, SavedPreview>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly dispatches = new Map<string, AbortController>();
  private readonly cancellationRequests = new Set<string>();
  private startReserved = false;
  private disposed = false;
  constructor(private readonly options: DraftBatchOptions) {}

  async request(request: DraftBatchRequest, caller: WorkbenchCaller, signal: AbortSignal): Promise<JsonObject> {
    if (this.disposed || signal.aborted) throw new WorkbenchFault("REQUEST_CANCELLED", "批量草稿请求已取消");
    switch (request.operation) {
      case "preview_draft_batch": return this.preview(request.scope, request.contentRefs, signal);
      case "start_draft_batch": return this.start(request.intentId, caller);
      case "advance_draft_batch": {
        this.agent(caller);
        return this.serial(request.batchId, () => this.advance(request.batchId, caller, signal));
      }
      case "get_draft_batch": return dto(await this.observe(await this.read(request.batchId)));
      case "list_draft_batches": {
        const all = await this.readAll();
        const batches: DraftBatch[] = [];
        const recent = Object.values(all).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.batchId.localeCompare(left.batchId)).slice(0, 20);
        for (const batch of recent) batches.push(dto(await this.observe(batch)));
        return { schemaVersion: "wemedia.draft-batch-list/v1", batches };
      }
      case "cancel_draft_batch": {
        this.cancellationRequests.add(request.batchId);
        this.dispatches.get(request.batchId)?.abort();
        try { return await this.serial(request.batchId, () => this.cancel(request.batchId)); }
        finally { this.cancellationRequests.delete(request.batchId); }
      }
    }
  }

  task(intentId: string): string {
    this.validPreview(intentId);
    return `请执行用户在 WeMedia 工作台预览的批量公众号草稿操作。先调用 wemedia_start_draft_batch，intentId=${JSON.stringify(intentId)}，然后仅使用返回的 batchId 操作该队列。每次调用 wemedia_advance_draft_batch 最多发送一篇，每篇都必须遵守现有 DSH 原生审批，禁止绕过审批、并行发送、替代适配器、自动重试、覆盖已有草稿或正式发布。只要任一 entry.status 为 running，先等待一个有限间隔，再调用 wemedia_get_draft_batch 查询，并以适度间隔继续只读查询，避免忙轮询；有活动子任务时不调用 advance。只有 batch.status 为 running、没有活动子任务且仍有 pending 项时，才调用 wemedia_advance_draft_batch 推进下一篇。只有 completed 或 stopped 才是批次终态；逐项 succeeded 仍必须以 WECHAT_DRAFT_VERIFIED 和当前版本目标核验为准。审批拒绝、取消、版本变化或 reconcile_required 时停止并说明，不新建替代意图或重发失败项。`;
  }

  dispose(): void {
    this.disposed = true;
    this.previews.clear();
    for (const controller of this.dispatches.values()) controller.abort();
  }

  private agent(caller: WorkbenchCaller): string {
    if (caller.kind !== "agent" || !caller.sessionId || caller.sessionId.length > 256) throw new WorkbenchFault("AGENT_APPROVAL_REQUIRED", "请交给当前 DSH Agent，逐篇使用原生审批发送草稿");
    return caller.sessionId;
  }
  private validPreview(id: string): SavedPreview {
    const saved = this.previews.get(id);
    if (this.disposed || !saved || saved.value.generationId !== this.options.generationId || Date.parse(saved.value.expiresAt) <= Date.parse(this.options.clock.nowIso())) throw new WorkbenchFault("BATCH_INTENT_EXPIRED", "批量预览已过期或工作台已重载，请重新预览");
    return saved;
  }
  private async preview(scope: DraftBatchScope, refs: ContentRef[] | undefined, signal: AbortSignal): Promise<DraftBatchPreview> {
    const now = Date.parse(this.options.clock.nowIso());
    for (const [id, saved] of this.previews) if (Date.parse(saved.value.expiresAt) <= now) this.previews.delete(id);
    if (this.previews.size >= 100) throw new WorkbenchFault("BATCH_PREVIEW_LIMIT", "批量预览过多，请等待旧预览过期");
    const candidates = await this.options.candidates(scope, refs ? [...refs] : undefined, signal);
    if (candidates.length > DRAFT_BATCH_LIMIT) throw new WorkbenchFault("BATCH_LIMIT", "单批最多 50 篇，请缩小选择范围");
    const entries = candidates.map(entry);
    if (new Set(entries.map(item => item.contentRef)).size !== entries.length || entries.some(item => !["pending", "skipped", "blocked"].includes(item.status) || item.jobId !== null || item.intentId !== null || (item.status !== "skipped" && item.targetRef !== null))) return invalidState();
    if (scope === "selected" && (!refs || refs.length !== entries.length || refs.some(ref => !entries.some(item => item.contentRef === ref)))) return invalidState();
    const previous = Object.values(await this.readAll());
    for (const item of entries) {
      if (item.status !== "pending") continue;
      const uncertain = previous.some(batch => batch.entries.some(old => old.contentRef === item.contentRef && (old.status === "reconcile_required" || (old.status === "running" && !this.findJob(old, batch.generationId)))));
      if (uncertain) Object.assign(item, { status: "blocked", code: "BATCH_RECONCILE_REQUIRED", safeMessage: "此前发送意图尚未确认，请先核对；此项不会重复创建" });
    }
    if (signal.aborted || this.disposed) throw new WorkbenchFault("REQUEST_CANCELLED", "批量预览已取消");
    if (this.previews.size >= 100) throw new WorkbenchFault("BATCH_PREVIEW_LIMIT", "批量预览过多，请等待旧预览过期");
    const value: DraftBatchPreview = { schemaVersion: "wemedia.draft-batch-preview/v1", intentId: this.options.ids.opaqueId("batchintent"), generationId: this.options.generationId, expiresAt: new Date(now + 10 * 60_000).toISOString(), scope, entries, eligibleCount: entries.filter(item => item.status === "pending").length };
    this.previews.set(value.intentId, { value: copy(value), batchId: null });
    return value;
  }
  private async start(intentId: string, caller: WorkbenchCaller): Promise<DraftBatch> {
    const ownerSessionId = this.agent(caller);
    const saved = this.validPreview(intentId);
    if (saved.batchId) {
      const previous = await this.read(saved.batchId);
      if (previous.ownerSessionId !== ownerSessionId) throw new WorkbenchFault("BATCH_CALLER_CHANGED", "该批次属于另一 Agent 会话");
      return dto(await this.observe(previous));
    }
    if (!saved.value.eligibleCount) throw new WorkbenchFault("BATCH_EMPTY", "没有通过预检且尚未入箱的文章");
    if (this.startReserved) throw new WorkbenchFault("BATCH_BUSY", "已有批量草稿队列正在启动或执行");
    this.startReserved = true;
    try {
      const all = await this.readAll();
      // A committed transaction can outlive a failed response to its caller.
      const previous = Object.values(all).filter(batch => batch.sourceIntentId === intentId);
      if (previous.length > 1) return invalidState();
      if (previous.length === 1) {
        const recovered = previous[0]!;
        if (recovered.generationId !== this.options.generationId) throw new WorkbenchFault("BATCH_INTENT_EXPIRED", "该预览属于旧工作台会话，请先核对已有批次");
        if (recovered.ownerSessionId !== ownerSessionId) throw new WorkbenchFault("BATCH_CALLER_CHANGED", "该批次属于另一 Agent 会话");
        saved.batchId = recovered.batchId;
        return dto(await this.observe(recovered));
      }
      const pendingRefs = new Set(saved.value.entries.filter(item => item.status === "pending").map(item => item.contentRef));
      for (const batch of Object.values(all)) {
        if (batch.status !== "running" && !batch.entries.some(item => item.status === "running" || (item.status === "reconcile_required" && pendingRefs.has(item.contentRef)))) continue;
        const current = await this.observe(batch);
        if (current.status !== batch.status || JSON.stringify(current.entries) !== JSON.stringify(batch.entries)) await this.save(current);
        if (current.status === "running" || current.entries.some(item => item.status === "running")) throw new WorkbenchFault("BATCH_BUSY", "已有批量草稿队列正在执行，请先处理");
        if (current.entries.some(item => item.status === "reconcile_required" && pendingRefs.has(item.contentRef))) throw new WorkbenchFault("BATCH_RECONCILE_REQUIRED", "所选文章有尚未确认的发送结果，请先核对；不会重复创建");
      }
      this.validPreview(intentId);
      const batch: SavedBatch = { schemaVersion: "wemedia.draft-batch/v1", batchId: this.options.ids.opaqueId("draftbatch"), generationId: this.options.generationId, status: "running", createdAt: this.options.clock.nowIso(), entries: copy(saved.value.entries), ownerSessionId, sourceIntentId: intentId };
      await this.save(batch);
      saved.batchId = batch.batchId;
      return dto(batch);
    } finally { this.startReserved = false; }
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(id, next);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private async readAll(): Promise<Record<string, SavedBatch>> { return records((await this.options.store.read()).extensions.wechatDraftBatches); }
  private async read(id: string): Promise<SavedBatch> {
    const all = await this.readAll();
    const value = Object.hasOwn(all, id) ? all[id] : undefined;
    if (!value) throw new WorkbenchFault("BATCH_NOT_FOUND", "未找到该批量草稿队列");
    return value;
  }
  private async save(batch: SavedBatch): Promise<void> {
    await this.options.store.update(state => {
      const all = records(state.extensions.wechatDraftBatches);
      if (!Object.hasOwn(all, batch.batchId) && Object.keys(all).length >= 1000) throw new WorkbenchFault("BATCH_STORAGE_LIMIT", "批量草稿记录已达存储上限，请先由维护者归档后再创建批次");
      all[batch.batchId] = copy(batch);
      state.extensions.wechatDraftBatches = all;
    });
  }
  private findJob(item: DraftBatchEntry, generationId: string): WorkbenchJob | undefined {
    const matches = this.options.jobs().filter(job => job.intentId === item.intentId);
    if (matches.length !== 1) return undefined;
    const job = matches[0]!;
    return job.generationId === generationId && job.contentRef === item.contentRef && job.inputDigest === item.inputDigest && job.action === "create_draft" && job.sideEffect === "remote_draft" && (job.channel === undefined || job.channel === "wechat") && (!item.jobId || job.jobId === item.jobId) ? job : undefined;
  }
  private async observe(batch: SavedBatch): Promise<SavedBatch> {
    const value = copy(batch);
    if (value.generationId !== this.options.generationId) stop(value, "BATCH_RESTARTED");
    for (const item of value.entries) {
      if (item.status !== "running" && item.status !== "reconcile_required" && item.status !== "succeeded") continue;
      const job = this.findJob(item, value.generationId);
      if (!job) {
        if (this.dispatches.has(value.batchId) && item.status === "running") continue;
        Object.assign(item, { status: "reconcile_required", code: "BATCH_CHILD_UNKNOWN", safeMessage: "已记录发送意图但无法确认原生任务，禁止自动重发" });
        stop(value, "BATCH_RECONCILE_REQUIRED");
        continue;
      }
      item.jobId = job.jobId;
      item.code = job.resultCode ?? "BATCH_CHILD_RUNNING";
      item.safeMessage = ACTIVE_JOBS.has(job.status) ? "原生草稿任务尚未完成" : "原生草稿任务已结束";
      if (ACTIVE_JOBS.has(job.status)) { item.status = "running"; continue; }
      if (job.status === "succeeded" && job.resultCode === "WECHAT_DRAFT_VERIFIED") {
        try {
          const document = await this.options.inspect(item.contentRef);
          const targets = document.targets.filter(target => target.verifiedRevision === item.revisionDigest && target.verifiedAt && target.targetRef);
          if (document.contentRef === item.contentRef && document.revisionDigest === item.revisionDigest && document.targets.length === 1 && targets.length === 1) {
            item.status = "succeeded"; item.targetRef = targets[0]!.targetRef; item.safeMessage = "当前文章版本已核验入草稿箱"; continue;
          }
        } catch { /* A missing document cannot establish remote delivery. */ }
      }
      if (job.status === "failed" && !BEFORE_DISPATCH_CODES.has(job.resultCode ?? "")) { item.status = "failed"; item.safeMessage = "草稿任务失败，此项不会自动重试"; continue; }
      if (job.status === "cancelled" || BEFORE_DISPATCH_CODES.has(job.resultCode ?? "")) {
        item.status = job.status === "cancelled" ? "cancelled" : "failed";
        item.safeMessage = "草稿任务已取消，或审批、发送前复检未通过";
        stop(value, "BATCH_STOPPED");
        continue;
      }
      item.status = "reconcile_required"; item.code = "BATCH_RESULT_UNVERIFIED"; item.safeMessage = "远端结果或当前版本目标未经确认，请先核对，禁止自动重发";
      stop(value, "BATCH_RECONCILE_REQUIRED");
    }
    if (value.status === "running" && !value.entries.some(item => item.status === "pending" || item.status === "running")) value.status = "completed";
    return value;
  }
  private async advance(id: string, caller: WorkbenchCaller, signal: AbortSignal): Promise<DraftBatch> {
    let batch = await this.read(id);
    if (batch.ownerSessionId !== this.agent(caller)) throw new WorkbenchFault("BATCH_CALLER_CHANGED", "只能由启动该批次的 Agent 会话推进");
    batch = await this.observe(batch);
    await this.save(batch);
    if (batch.status !== "running" || batch.entries.some(item => item.status === "running")) return dto(batch);
    const item = batch.entries.find(candidate => candidate.status === "pending");
    if (!item) return dto(batch);
    if (signal.aborted || this.disposed || this.cancellationRequests.has(id)) { stop(batch, "REQUEST_CANCELLED"); await this.save(batch); return dto(batch); }
    let preview: ActionPreview;
    try { preview = await this.options.preview(copy(item), signal); }
    catch {
      Object.assign(item, { status: "blocked", code: "BATCH_PREFLIGHT_FAILED", safeMessage: "发送前复检失败，请重新预览" });
      stop(batch, "BATCH_PREFLIGHT_FAILED"); await this.save(batch); return dto(batch);
    }
    if (preview.action !== "create_draft" || preview.intent.action !== "create_draft" || preview.intent.contentRef !== item.contentRef || preview.intent.generationId !== this.options.generationId || preview.intent.sideEffect !== "remote_draft" || preview.intent.artifactDigest !== item.revisionDigest || preview.intent.inputDigest !== item.inputDigest || preview.intent.blockingGateCodes.length || preview.gates.status === "block" || preview.target !== null) {
      Object.assign(item, { status: "blocked", code: "BATCH_INPUT_CHANGED", safeMessage: "文章、审阅、账号或草稿目标已变化，请重新预览" });
      stop(batch, "BATCH_INPUT_CHANGED"); await this.save(batch); return dto(batch);
    }
    Object.assign(item, { status: "running", intentId: preview.intent.intentId, code: "BATCH_DISPATCHING", safeMessage: "正在交给原生草稿任务审批" });
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || this.disposed || this.cancellationRequests.has(id)) controller.abort();
    this.dispatches.set(id, controller);
    try {
      // The intent association must be durable before native approval or remote dispatch.
      await this.save(batch);
      if (controller.signal.aborted) {
        Object.assign(item, { status: "cancelled", code: "REQUEST_CANCELLED", safeMessage: "尚未请求发送，队列已取消" });
        stop(batch, "REQUEST_CANCELLED"); await this.save(batch); return dto(batch);
      }
      try {
        const job = await this.options.start(preview.intent.intentId, caller, controller.signal);
        item.jobId = job.jobId;
      } catch (error) {
        const job = this.findJob(item, batch.generationId);
        if (job) item.jobId = job.jobId;
        else if (error instanceof WorkbenchFault && BEFORE_DISPATCH_CODES.has(error.code)) {
          Object.assign(item, { status: "failed", code: error.code, safeMessage: "原生任务未启动，此项不会自动重试" });
          stop(batch, "BATCH_STOPPED");
        } else {
          Object.assign(item, { status: "reconcile_required", code: "BATCH_START_UNCERTAIN", safeMessage: "无法确认原生任务是否启动，请先核对；不会自动重试" });
          stop(batch, "BATCH_RECONCILE_REQUIRED");
        }
      }
      this.dispatches.delete(id);
      batch = await this.observe(batch);
      await this.save(batch);
      return dto(batch);
    } finally { signal.removeEventListener("abort", abort); this.dispatches.delete(id); }
  }
  private async cancel(id: string): Promise<DraftBatch> {
    let batch = await this.observe(await this.read(id));
    if (batch.status === "completed") return dto(batch);
    stop(batch, "BATCH_CANCELLED");
    await this.save(batch);
    for (const item of batch.entries) {
      if (item.status !== "running") continue;
      const job = this.findJob(item, batch.generationId);
      if (job && ACTIVE_JOBS.has(job.status)) {
        try { await this.options.cancelJob(job.jobId); }
        catch { Object.assign(item, { status: "reconcile_required", code: "BATCH_CANCEL_UNCERTAIN", safeMessage: "取消结果未确认，请核对原生任务；取消不等于远端回滚" }); }
      }
    }
    batch = await this.observe(batch);
    await this.save(batch);
    return dto(batch);
  }
}

import { z } from "zod";
import type { ActionIntent, GateReport, CapabilityReport } from "../domain/capability.ts";
import { ADAPTER_ACTIONS } from "../domain/capability.ts";
import { CHANNEL_ACTIONS, PUBLISHING_CHANNELS, channelEffect } from "../domain/channelPublishing.ts";
import type { ChannelAction, ChannelCheck, ChannelInspection, ChannelPreview, ChannelRequest, ChannelTarget, PublishingChannel, PublishingType } from "../domain/channelPublishing.ts";
import type { ChannelBridgeResult, ChannelDocument, ChannelRemote, PublishingAdapter } from "../ports/channelPublishing.ts";
import type { WorkbenchApprovalProvider, WorkbenchDocuments, WorkbenchHasher } from "../ports/workbench.ts";
import type { PublicationDrafts } from "../ports/publicationDrafts.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { LedgerRepository, WorkbenchStateStore } from "../ports/repositories.ts";
import type { WorkbenchCaller, WorkbenchJob } from "../domain/workbench.ts";
import type { ContentRef } from "../domain/primitives.ts";
import { parseContentRef } from "../domain/primitives.ts";
import { WorkbenchFault } from "../domain/workbenchFault.ts";
import { REVIEW_KINDS } from "../domain/workbench.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "../domain/ledger.ts";
import type { LedgerEvent } from "../domain/ledger.ts";
import { channelUrl, decodeChannelRemote } from "../domain/channelRemote.ts";
import { articleChannelDocument, channelDocumentPayload } from "../domain/channelDocument.ts";
import type { JsonObject } from "../domain/json.ts";
import { canonicalJson, isJsonObject } from "../domain/json.ts";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const stamp = z.string().datetime({ offset: true });
const token = z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9-]{1,100}$/u);
const safeCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/u);
const artifactSchema = z.object({ rootId: z.literal("write"), relativePath: z.string().regex(/^\.wemedia-channel-[a-z0-9-]+\/(?!.*(?:\.\.|\\|\/\/))[A-Za-z0-9_./-]+$/u), digest: digest.optional() }).strict();
const jobSchema = z.object({ jobId: token, generationId: token, contentRef: z.string().refine(v => parseContentRef(v).ok), intentId: token, inputDigest: digest, channel: z.enum(PUBLISHING_CHANNELS), action: z.enum(["channel_prepare", "channel_stage", "channel_publish", "channel_sync"]), sideEffect: z.enum(["read", "local_write", "remote_draft", "remote_publish"]), status: z.enum(["queued", "running", "waiting_user", "succeeded", "failed", "cancelled", "timed_out", "reconcile_required"]), progress: z.object({ current: z.number().min(0).max(1), total: z.literal(1), unit: z.literal("operation") }).strict(), safeMessage: z.string().max(160), createdAt: stamp, retryable: z.literal(false), artifactRefs: z.array(z.string().max(1100)).max(100), startedAt: stamp.optional(), finishedAt: stamp.optional(), deadline: stamp.optional(), resultEventId: token.optional(), resultCode: safeCode.optional() }).strict();
const entrySchema = z.object({ job: jobSchema, revisionDigest: digest, documentDigest: digest.optional(), accountRef: z.string().max(100), targetRef: token, remote: z.json().optional(), status: z.enum(["prepared", "manual_handoff", "draft", "published", "reconcile_required"]).optional(), verifiedAt: z.union([stamp, z.literal("")]), artifacts: z.array(artifactSchema).max(100) }).strict();
interface Entry { job: WorkbenchJob; revisionDigest: string; documentDigest?: string | undefined; accountRef: string; targetRef: string; remote?: ChannelRemote | undefined; status?: ChannelBridgeResult["status"]; verifiedAt: string; artifacts: ChannelBridgeResult["artifacts"] }
interface Saved { preview: ChannelPreview; documentDigest: string; accountRef: string; target?: Entry | undefined; callerKey: string; consumed: boolean; request: Extract<ChannelRequest, { operation: "channel_preview_action" }> }
const terminal = (status: string) => ["succeeded", "failed", "cancelled", "timed_out", "reconcile_required"].includes(status);
const message = (status: string) => status === "succeeded" ? "渠道任务完成，请查看核验状态" : status === "waiting_user" ? "等待当前 DSH 原生批准" : status === "reconcile_required" ? "提交结果待核对，请勿重新发布；可粘贴作品链接只读核验" : status === "running" ? "渠道任务执行中" : status === "queued" ? "渠道任务已排队" : "渠道任务已停止，请查看结果代码";
function fault(code: string, text: string): never { throw new WorkbenchFault(code, text); }
const owner = (caller: WorkbenchCaller) => caller.kind === "agent" && caller.sessionId ? `agent:${caller.sessionId}` : caller.kind === "user" ? "user" : fault("CALLER_INVALID", "当前会话身份不可用");
function decodeEntry(value: unknown): Entry {
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success) return fault("CHANNEL_STATE_INVALID", "渠道任务状态损坏，已停止远端写入");
  const entry = parsed.data;
  if (!entry.job.jobId.startsWith("channeljob:") || entry.job.sideEffect !== channelEffect(entry.job.channel, entry.job.action.slice(8) as ChannelAction) || entry.accountRef && !new RegExp(`^${entry.job.channel}-account:[a-f0-9]{32}$`, "u").test(entry.accountRef)) return fault("CHANNEL_STATE_INVALID", "渠道任务身份无法核对");
  const remote = entry.remote === undefined ? undefined : decodeChannelRemote(entry.job.channel, entry.remote);
  if (entry.remote !== undefined && !remote || ["draft", "published"].includes(entry.status ?? "") && (!remote?.url || !entry.verifiedAt || !entry.accountRef || entry.job.status !== "succeeded")) return fault("CHANNEL_STATE_INVALID", "渠道核验记录不完整");
  return { ...entry, job: entry.job as WorkbenchJob, artifacts: entry.artifacts.map(a => ({ rootId: a.rootId, relativePath: a.relativePath, ...(a.digest ? { digest: a.digest } : {}) })), remote };
}

/** One shared execution boundary for UI, Native Tools and PTC; each entry commits atomically. */
export class ChannelPublishingService {
  private entries = new Map<string, Entry>();
  private intents = new Map<string, Saved>();
  private active = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  private pending = new Map<string, AbortController>();
  private locks = new Set<string>();
  private faults: string[] = [];
  private stopped = false;
  private lifetime = new AbortController();
  private ready?: Promise<void>;
  private capabilities: CapabilityReport[] = [];
  constructor(private readonly options: { generationId: string; adapters: PublishingAdapter[]; documents: WorkbenchDocuments; publications?: PublicationDrafts; store: WorkbenchStateStore; ledger: LedgerRepository; approvals: WorkbenchApprovalProvider; clock: Clock; ids: IdGenerator; hasher: WorkbenchHasher; writeAvailable: () => boolean; canStart?: () => boolean }) {}
  private eventKey(job: WorkbenchJob): string { return this.options.hasher.digest(`${job.intentId}:${job.inputDigest}`); }
  private async readJournal(entries: ReadonlyMap<string, Entry>): Promise<Map<string, { event: LedgerEvent; entry: Entry }>> {
    const journal = new Map<string, { event: LedgerEvent; entry: Entry }>();
    const eventIds = new Set<string>(), journalJobs = new Set<string>();
    for await (const result of this.options.ledger.readAll()) {
      if (!result.ok || journal.has(result.value.eventKey) || eventIds.has(result.value.eventId) || result.value.jobId && journalJobs.has(result.value.jobId)) fault("CHANNEL_LEDGER_INVALID", "渠道结果账本损坏");
      const e = result.value, entry = decodeEntry(e.remote?.entry);
      if (e.evidence.adapter !== "wemedia-channel" || e.evidence.adapterVersion !== "1.0.0" || e.eventKey !== this.eventKey(entry.job) || e.jobId !== entry.job.jobId || e.eventId !== entry.job.resultEventId || e.contentRef !== entry.job.contentRef || e.channel !== entry.job.channel || e.action !== entry.job.action || e.sideEffect !== entry.job.sideEffect || e.evidence.code !== entry.job.resultCode || !terminal(entry.job.status)) fault("CHANNEL_LEDGER_INVALID", "渠道账本绑定不一致");
      const current = entries.get(entry.job.jobId);
      if (!current || this.eventKey(current.job) !== e.eventKey) fault("CHANNEL_LEDGER_INVALID", "渠道结果账本缺少对应任务，已停止远端写入");
      journal.set(e.eventKey, { event: e, entry });
      eventIds.add(e.eventId); journalJobs.add(entry.job.jobId);
    }
    return journal;
  }
  initialize(): Promise<void> { return this.ready ??= this.initializeOnce(); }
  private async initializeOnce(): Promise<void> {
    try {
      const entries = new Map<string, Entry>();
      const state = (await this.options.store.read()).extensions.channelPublishing;
      if (state !== undefined) {
        if (!isJsonObject(state) || Object.keys(state).length > 5000) fault("CHANNEL_STATE_INVALID", "渠道状态无法读取");
        for (const [key, raw] of Object.entries(state)) { const entry = decodeEntry(raw); if (key !== entry.job.jobId) fault("CHANNEL_STATE_INVALID", "渠道任务键不一致"); entries.set(key, entry); }
      }
      const journal = await this.readJournal(entries);
      const recoveries: Entry[] = [];
      for (const current of entries.values()) {
        if (current.job.resultCode === "CHANNEL_LEDGER_CONFLICT") fault("CHANNEL_LEDGER_INVALID", "渠道账本存在已确认的提交冲突，已停止远端写入");
        const recovered = journal.get(this.eventKey(current.job))?.entry;
        if (terminal(current.job.status)) {
          if ((current.job.status === "succeeded" || current.job.resultEventId || recovered) && (!recovered || JSON.stringify(recovered) !== JSON.stringify(current))) fault("CHANNEL_LEDGER_INVALID", "已完成的渠道任务与账本不一致");
          continue;
        }
        if (recovered) {
          const boundJobFields = ["jobId", "generationId", "contentRef", "intentId", "inputDigest", "channel", "action", "sideEffect", "createdAt"] as const;
          if (boundJobFields.some(key => recovered.job[key] !== current.job[key]) || recovered.revisionDigest !== current.revisionDigest || recovered.documentDigest !== current.documentDigest || recovered.accountRef !== current.accountRef || recovered.targetRef !== current.targetRef) fault("CHANNEL_LEDGER_INVALID", "待恢复任务与账本不一致");
          recoveries.push(recovered);
        } else {
          if (current.job.resultEventId) fault("CHANNEL_LEDGER_INVALID", "待恢复任务缺少声明的账本证据");
          const status = current.job.status === "running" && current.job.sideEffect.startsWith("remote_") ? "reconcile_required" : "cancelled";
          recoveries.push({ ...current, ...(status === "reconcile_required" ? { status: "reconcile_required" as const } : {}), job: { ...current.job, status, safeMessage: message(status), finishedAt: this.options.clock.nowIso(), resultCode: "CHANNEL_INTERRUPTED" } });
        }
      }
      // Do not expose verified targets or mutate recovery state until both stores agree.
      this.entries = entries;
      for (const recovered of recoveries) await this.save(recovered);
    } catch (error) { this.faults.push(error instanceof WorkbenchFault ? error.code : "CHANNEL_RECOVERY_FAILED"); }
    await this.refresh();
  }
  async refresh(): Promise<void> {
    this.capabilities = await Promise.all(this.options.adapters.map(async adapter => { try { return await adapter.discover(this.lifetime.signal); } catch { return { channel: adapter.channel, adapter: `${adapter.channel}-bridge`, configured: "unknown" as const, actions: ADAPTER_ACTIONS.map(action => ({ action, status: "unavailable" as const, reasonCode: "CHANNEL_DISCOVERY_FAILED", safeMessage: "该渠道检查未完成", checkedAt: this.options.clock.nowIso() })) }; } }));
  }
  jobs(): WorkbenchJob[] { return [...this.entries.values()].map(e => structuredClone(e.job)); }
  reports(): CapabilityReport[] { return structuredClone(this.capabilities); }
  records(ref: ContentRef, revision: string, documentDigest?: string): import("../domain/publication.ts").PublicationRecord[] {
    return this.latest(ref).map(e => {
      const current = e.revisionDigest === revision && Boolean(e.documentDigest && e.documentDigest === documentDigest);
      return { channel: e.job.channel!, status: current && e.status === "published" ? "published" : current && e.status === "draft" ? "draft" : "unknown", publishedAt: null, checkedAt: current ? e.verifiedAt || null : null, url: e.remote?.url ?? null, evidence: current && e.status === "published" ? "remote_readback" : current && e.status === "draft" ? "draft_readback" : "none", note: e.status === "reconcile_required" ? "提交结果待确认，请粘贴精确作品链接只读核对；不要重复发表。" : !current ? `${e.documentDigest ? "当前全文或素材已与核验版本不同" : "历史记录缺少完整正文与素材绑定"}；历史作品链接保留，当前版本待只读核对，不能据此重复发表。` : `本次保存版本的${e.status === "published" ? "已发表作品" : "平台草稿"}已核对。${e.job.channel === "xiaohongshu" ? "小红书核对账号、正文、类型和媒体数量，未证明图片原字节一致。" : ""}平台未提供可信正式发布时间。` };
    });
  }
  busy(): boolean { return this.locks.size > 0; }
  issues(): string[] { return [...this.faults]; }
  private adapter(channel: PublishingChannel): PublishingAdapter { return this.options.adapters.find(a => a.channel === channel) ?? fault("CHANNEL_BRIDGE_MISSING", "该渠道尚未接通"); }
  private async save(entry: Entry): Promise<void> {
    const valid = decodeEntry(JSON.parse(JSON.stringify(entry)));
    await this.options.store.update(state => { const previous = state.extensions.channelPublishing; if (previous !== undefined && !isJsonObject(previous)) fault("CHANNEL_STATE_INVALID", "渠道状态无法提交"); state.extensions.channelPublishing = { ...(previous as JsonObject ?? {}), [valid.job.jobId]: JSON.parse(JSON.stringify(valid)) }; });
    this.entries.set(valid.job.jobId, valid);
  }
  async document(ref: ContentRef, signal: AbortSignal): Promise<ChannelDocument> {
    if (signal.aborted) fault("REQUEST_CANCELLED", "操作已取消");
    if (this.options.publications?.channelDocument) {
      try { return await this.options.publications.channelDocument(ref, signal); }
      catch (error) { if (!(error instanceof WorkbenchFault) || error.code !== "PUBLICATION_NOT_FOUND") throw error; }
    }
    const d = await this.options.documents.read(ref);
    return articleChannelDocument(d);
  }
  private latest(ref: ContentRef, channel?: PublishingChannel): Entry[] {
    const map = new Map<string, Entry>();
    for (const e of [...this.entries.values()].sort((a, b) => (a.job.finishedAt ?? a.job.createdAt).localeCompare(b.job.finishedAt ?? b.job.createdAt))) {
      if (e.job.contentRef === ref && (!channel || e.job.channel === channel) && ["draft", "published", "reconcile_required"].includes(e.status ?? "") && (e.remote || e.status === "reconcile_required")) map.set(e.targetRef, e);
    }
    return [...map.values()];
  }
  private publicTarget(e: Entry, documentDigest: string): ChannelTarget {
    const current = Boolean(e.documentDigest && e.documentDigest === documentDigest), verified = e.status === "published" || e.status === "draft";
    return { targetRef: e.targetRef, channel: e.job.channel as PublishingChannel, label: `${e.job.channel} · ${verified && !current ? "历史目标，当前全文待核对" : e.status === "published" ? "已发表" : e.status === "draft" ? "平台草稿" : "待核对"}`, url: e.remote?.url ?? "", status: current && verified ? e.status as "published" | "draft" : "reconcile_required", revisionDigest: e.revisionDigest, verifiedAt: current ? e.verifiedAt : "" };
  }
  async inspect(ref: ContentRef, signal: AbortSignal): Promise<ChannelInspection> {
    const d = await this.document(ref, signal);
    const matrix: ChannelInspection["matrix"] = [];
    for (const channel of ["wechat", ...PUBLISHING_CHANNELS, "csdn"] as const) for (const publicationType of ["article", "video", "image_text"] as const) for (const action of ADAPTER_ACTIONS) {
      const report = this.capabilities.find(v => v.channel === channel)?.actions.find(v => v.action === action);
      const supported = channel === "wechat" ? publicationType === "article" && !["stage", "publish"].includes(action) : channel !== "csdn" && action !== "draft" && (action === "discover" || this.adapter(channel).supports(publicationType, action as ChannelAction | "preflight"));
      matrix.push({ channel, publicationType, action, status: !supported ? "unsupported" : channel === "wechat" ? "existing_workflow" : report?.status ?? "unavailable", reasonCode: !supported ? "CHANNEL_TYPE_ACTION_UNSUPPORTED" : channel === "wechat" ? "USE_EXISTING_WECHAT_ACTIONS" : report?.reasonCode ?? "CHANNEL_BRIDGE_MISSING" });
    }
    return { contentRef: ref, revisionDigest: d.revisionDigest, publicationType: d.publicationType, capabilities: this.reports(), targets: this.latest(ref).map(e => this.publicTarget(e, this.options.hasher.digest(channelDocumentPayload(d)))), jobs: this.jobs().filter(j => j.contentRef === ref).slice(-30).reverse(), matrix, issues: this.issues() };
  }
  private report(result: ChannelBridgeResult, d: ChannelDocument): GateReport {
    const issues = result.issues.map(v => ({ ...v, gateId: "channel", version: "1", safeMessage: v.status === "block" ? "渠道检查阻断，请按代码处理后重新检查" : "渠道检查已完成", evidenceRefs: [], inputDigest: d.revisionDigest }));
    if (!result.ok && !issues.some(v => v.status === "block")) issues.push({ gateId: "channel", version: "1", status: "block", code: result.code, safeMessage: "渠道检查未通过", evidenceRefs: [], inputDigest: d.revisionDigest });
    return { status: issues.some(i => i.status === "block") ? "block" : issues.some(i => i.status === "warn") ? "warn" : "pass", inputDigest: d.revisionDigest, issues };
  }
  async preflight(ref: ContentRef, channel: PublishingChannel, online: boolean, signal: AbortSignal): Promise<ChannelCheck> {
    const d = await this.document(ref, signal), result = await this.adapter(channel).preflight(d, online, signal);
    return { contentRef: ref, channel, revisionDigest: d.revisionDigest, configured: result.configured, permission: result.permission ?? "unknown", gates: this.report(result, d) };
  }
  private async previewInputs(request: Saved["request"], signal: AbortSignal) {
    const d = await this.document(request.contentRef, signal), adapter = this.adapter(request.channel);
    const remote = channelEffect(request.channel, request.action).startsWith("remote_");
    const result = await adapter.preflight(d, remote || request.action === "sync", signal, request.action), gates = this.report(result, d);
    const block = (code: string, text: string) => gates.issues.push({ gateId: "channel-intent", version: "1", status: "block", code, safeMessage: text, evidenceRefs: [], inputDigest: d.revisionDigest });
    if (!adapter.supports(d.publicationType, request.action)) block("CHANNEL_TYPE_ACTION_UNSUPPORTED", "该平台不支持当前发布类型；请创建合适的渠道稿");
    if (request.action !== "sync" && !this.options.writeAvailable()) block("WRITE_ROOT_REQUIRED", "先启用独立写入目录");
    if ((remote || request.action === "sync") && !result.accountRef) block("CHANNEL_ACCOUNT_UNVERIFIED", "尚未核实当前账号，请检查登录状态");
    if (remote && this.faults.length) block("CHANNEL_RECOVERY_BLOCKED", "先处理渠道恢复错误");
    if (remote && !this.options.approvals.available()) block("AGENT_APPROVAL_REQUIRED", "当前实例缺少 DSH 原生批准");
    if (remote && d.publicationType === "article") {
      const article = await this.options.documents.read(d.contentRef);
      if (article.metadata.kind === "paper" && !REVIEW_KINDS.every(kind => article.reviews.some(v => v.kind === kind && v.valid && v.revisionDigest === d.revisionDigest))) block("ARTICLE_REVIEWS_REQUIRED", "论文稿需要当前版本的四类审阅");
    }
    let target = request.targetRef ? this.latest(d.contentRef, request.channel).find(e => e.targetRef === request.targetRef) : undefined;
    if (request.targetRef && !target) block("CHANNEL_TARGET_NOT_FOUND", "目标不存在或不属于当前渠道内容");
    if (request.targetUrl) {
      const url = channelUrl(request.channel, request.targetUrl);
      if (!url) block("CHANNEL_TARGET_URL_INVALID", "请填写该平台不含凭据参数的标准作品链接");
      else {
        const remoteId = new URL(url).pathname.split("/").filter(Boolean).filter(v => v !== "edit").at(-1)!;
        const prior = this.latest(d.contentRef, request.channel).find(e => e.remote?.remoteId === remoteId || !e.remote && e.status === "reconcile_required");
        target = { job: { channel: request.channel } as WorkbenchJob, accountRef: prior?.accountRef || result.accountRef || "", targetRef: prior?.targetRef ?? this.options.ids.opaqueId("channeltarget"), revisionDigest: d.revisionDigest, documentDigest: prior?.documentDigest, verifiedAt: "", artifacts: [], remote: { ...prior?.remote, remoteId, url } };
      }
    }
    if (target && target.accountRef !== result.accountRef) block("CHANNEL_ACCOUNT_CHANGED", "该目标属于另一账号");
    if (target && request.action === "publish" && (target.revisionDigest !== d.revisionDigest || target.documentDigest !== this.options.hasher.digest(channelDocumentPayload(d)))) block("CHANNEL_REVISION_CHANGED", "草稿全文或素材绑定已变化，需要先只读核对");
    if ((request.action === "sync" || request.channel === "zhihu" && request.action === "publish") && !target?.remote) block("CHANNEL_TARGET_REQUIRED", "请选择已有目标，或提供作品链接只读核对");
    if (request.action === "stage" && request.channel === "zhihu" && this.latest(d.contentRef, request.channel).length) block("CHANNEL_EXISTING_TARGET", "已有目标时不再新建草稿，请先核对现有目标");
    if (request.action === "publish" && this.latest(d.contentRef, request.channel).some(e => e.status === "reconcile_required" || e.status === "published")) block("CHANNEL_RECONCILE_OR_DUPLICATE", "已有发表或待确认结果，禁止重复提交；请只读核对");
    gates.status = gates.issues.some(v => v.status === "block") ? "block" : gates.issues.some(v => v.status === "warn") ? "warn" : "pass";
    return { d, result, gates, target };
  }
  async preview(request: Saved["request"], caller: WorkbenchCaller, signal: AbortSignal): Promise<ChannelPreview> {
    const { d, result, gates, target } = await this.previewInputs(request, signal);
    const inputDigest = this.options.hasher.digest(JSON.stringify({ request, document: d, accountRef: result.accountRef ?? "", target: target?.remote ?? null, targetRef: target?.targetRef ?? null, gates, owner: owner(caller) }));
    const effect = channelEffect(request.channel, request.action);
    const summary = [d.title, `${request.channel} · ${d.publicationType} · ${request.action}`, `素材 ${d.assets.length} 项，绑定当前已保存版本`, ...(result.accountRef ? [`账号指纹：${result.accountRef}`] : []), effect === "remote_publish" ? "将正式发表；需要当前 DSH 原生单次批准" : effect === "remote_draft" ? "将新建并填入平台草稿，不点击发表" : request.action === "sync" ? "只读核对明确作品身份，不会再次发表" : "仅生成独立本地材料，手工交接不代表发表", ...(request.channel === "x" ? ["文章按普通帖子线程准备，不代表 X Articles 权限"] : [])];
    const intent: ActionIntent = { intentId: this.options.ids.opaqueId("channelintent"), generationId: this.options.generationId, contentRef: d.contentRef, channel: request.channel, action: `channel_${request.action}`, sideEffect: effect, targetSummary: summary.join("；"), inputDigest, artifactDigest: d.revisionDigest, expectedChanges: summary, blockingGateCodes: gates.issues.filter(v => v.status === "block").map(v => v.code), expiresAt: new Date(Date.parse(this.options.clock.nowIso()) + 600_000).toISOString(), approved: false };
    const preview: ChannelPreview = { intent, channel: request.channel, action: request.action, publicationType: d.publicationType, gates, target: target ? this.publicTarget(target, this.options.hasher.digest(channelDocumentPayload(d))) : null, summary };
    this.intents.set(intent.intentId, { preview, documentDigest: this.options.hasher.digest(channelDocumentPayload(d)), request, target, accountRef: result.accountRef ?? "", callerKey: owner(caller), consumed: false });
    return preview;
  }
  private valid(id: string): Saved { const s = this.intents.get(id); if (!s || s.consumed || this.stopped || Date.parse(s.preview.intent.expiresAt) <= Date.parse(this.options.clock.nowIso())) fault("INTENT_EXPIRED", "渠道意图已使用、过期或属于旧运行代"); return s; }
  task(id: string): string { const s = this.valid(id); return `用户已查看渠道操作预览：${s.preview.summary.join("；")}。请先对同一contentRef ${s.preview.intent.contentRef}、渠道 ${s.preview.channel}、动作 ${s.preview.action}${s.request.targetRef ? `、targetRef ${s.request.targetRef}` : ""}${s.request.targetUrl ? `、targetUrl ${s.request.targetUrl}` : ""}调用 wemedia_channel_preview_action，核对artifactDigest必须等于${s.preview.intent.artifactDigest}、账号指纹必须仍为${s.accountRef || "未配置"}且无阻断，再调用 wemedia_channel_start_action消费你自己当前会话的精确intent；远端动作等待DSH原生单次批准。然后读取Job到终态。未知结果不重发，只读核对。不得改变版本、目标或临时放宽校验。`; }
  private assertCurrent(saved: Saved, signal: AbortSignal): void {
    if (this.stopped || signal.aborted || Date.parse(saved.preview.intent.expiresAt) <= Date.parse(this.options.clock.nowIso())) fault("INTENT_EXPIRED", "操作已取消、过期或运行代已卸载");
  }
  private async recheck(saved: Saved, signal: AbortSignal): Promise<ChannelDocument> {
    this.assertCurrent(saved, signal);
    const { d, result, gates, target } = await this.previewInputs(saved.request, signal);
    this.assertCurrent(saved, signal);
    // Explicit URL sync is a local binding candidate, never reconstructed by title.
    const currentTarget = target;
    if (d.revisionDigest !== saved.preview.intent.artifactDigest || this.options.hasher.digest(channelDocumentPayload(d)) !== saved.documentDigest || result.accountRef !== (saved.accountRef || undefined) || gates.status === "block" || saved.target && JSON.stringify(currentTarget?.remote) !== JSON.stringify(saved.target.remote)) fault("INTENT_CHANGED", "内容、账号、目标或渠道条件已变化，请重新预览");
    return d;
  }
  async start(id: string, caller: WorkbenchCaller, signal: AbortSignal): Promise<WorkbenchJob> {
    const saved = this.valid(id), intent = saved.preview.intent, remote = intent.sideEffect.startsWith("remote_");
    if (owner(caller) !== saved.callerKey) fault("CHANNEL_CALLER_CHANGED", "意图属于另一调用方，请在当前会话重新预览");
    if (intent.blockingGateCodes.length) fault("GATES_BLOCKED", "先处理阻断项再重新预览");
    const approval = remote && caller.kind === "agent" ? this.options.approvals.forCaller(caller) : undefined;
    if (remote && !approval) fault("AGENT_APPROVAL_REQUIRED", "请交给当前 Agent 申请原生批准");
    const lock = `${intent.contentRef}:${saved.preview.channel}`;
    if (this.locks.has(lock) || this.options.canStart?.() === false) fault("CONTENT_BUSY", "当前内容或设置操作尚未结束");
    this.locks.add(lock);
    const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) controller.abort();
    const job: WorkbenchJob = { jobId: this.options.ids.opaqueId("channeljob"), generationId: this.options.generationId, contentRef: intent.contentRef, channel: saved.preview.channel, intentId: id, inputDigest: intent.inputDigest, action: intent.action, sideEffect: intent.sideEffect, status: "queued", progress: { current: 0, total: 1, unit: "operation" }, safeMessage: message("queued"), createdAt: this.options.clock.nowIso(), retryable: false, artifactRefs: [] };
    let entry: Entry = { job, revisionDigest: intent.artifactDigest!, documentDigest: saved.documentDigest, accountRef: saved.accountRef, targetRef: saved.target?.targetRef ?? this.options.ids.opaqueId("channeltarget"), ...(saved.target?.remote ? { remote: saved.target.remote } : {}), verifiedAt: "", artifacts: [] };
    let dispatched = false, authorization: import("../ports/channelPublishing.ts").ChannelRunInput["authorization"];
    this.pending.set(job.jobId, controller);
    try {
      await this.recheck(saved, controller.signal); this.valid(id); saved.consumed = true;
      entry.job = { ...job, status: approval ? "waiting_user" : "queued", safeMessage: message(approval ? "waiting_user" : "queued") }; await this.save(entry);
      this.assertCurrent(saved, controller.signal);
      if (approval) {
        const decision = await approval.request(intent, controller.signal);
        this.assertCurrent(saved, controller.signal);
        if (!decision.ok || !decision.value.approved || !decision.value.reference) fault("APPROVAL_DENIED", "未获得当前操作批准");
        const verified = await approval.verify(intent, decision.value.reference);
        if (!verified.ok || !verified.value.approved) fault("APPROVAL_INVALID", "批准与当前意图不匹配");
        authorization = { action: saved.preview.action as "stage" | "publish", inputDigest: intent.artifactDigest!, reference: decision.value.reference };
        await this.recheck(saved, controller.signal);
      }
      entry.job = { ...entry.job, status: "queued", safeMessage: message("queued") }; await this.save(entry);
      this.assertCurrent(saved, controller.signal);
      signal.removeEventListener("abort", abort);
      const completion = Promise.resolve().then(() => this.execute(saved, entry, controller, authorization)).finally(() => { this.active.delete(job.jobId); this.pending.delete(job.jobId); this.locks.delete(lock); });
      this.active.set(job.jobId, { controller, completion }); dispatched = true;
      return structuredClone(entry.job);
    } catch (error) {
      if (this.entries.has(job.jobId)) await this.save({ ...entry, job: { ...entry.job, status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: this.options.clock.nowIso(), safeMessage: message("failed"), resultCode: error instanceof WorkbenchFault ? error.code : "CHANNEL_START_FAILED" } });
      throw error;
    } finally { signal.removeEventListener("abort", abort); if (!dispatched) { this.pending.delete(job.jobId); this.locks.delete(lock); } }
  }
  private async execute(saved: Saved, entry: Entry, controller: AbortController, authorization?: import("../ports/channelPublishing.ts").ChannelRunInput["authorization"]): Promise<void> {
    let dispatched = false, timedOut = false, journaled = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 300_000); timeout.unref?.();
    try {
      const document = await this.recheck(saved, controller.signal);
      entry.job = { ...entry.job, status: "running", safeMessage: message("running"), startedAt: this.options.clock.nowIso(), deadline: new Date(Date.parse(this.options.clock.nowIso()) + 300_000).toISOString() }; await this.save(entry);
      this.assertCurrent(saved, controller.signal);
      dispatched = true;
      const output = saved.preview.action !== "sync" ? { rootId: "write", relativePath: `.wemedia-channel-${entry.job.jobId.slice(11)}` } : undefined;
      const result = await this.adapter(saved.preview.channel).run(saved.preview.action, { document, ...(saved.accountRef ? { expectedAccountRef: saved.accountRef } : {}), ...(saved.target?.remote ? { target: saved.target.remote } : {}), ...(output ? { output } : {}), ...(authorization ? { authorization } : {}) }, controller.signal);
      const uncertain = result.reconcileRequired || result.remoteWriteAttempted && !result.ok || entry.job.sideEffect.startsWith("remote_") && (controller.signal.aborted || timedOut);
      const status = uncertain ? "reconcile_required" : result.ok ? "succeeded" : controller.signal.aborted ? "cancelled" : "failed";
      const latest = await this.document(document.contentRef, this.lifetime.signal);
      const current = latest.revisionDigest === document.revisionDigest && this.options.hasher.digest(channelDocumentPayload(latest)) === saved.documentDigest;
      entry = { ...entry, status: !current && result.remote ? "reconcile_required" : uncertain ? "reconcile_required" : result.status, ...(result.remote ? { remote: result.remote } : {}), verifiedAt: current ? result.verifiedAt ?? "" : "", artifacts: result.artifacts,
        job: { ...entry.job, status: !current && result.remote ? "reconcile_required" : status, safeMessage: message(status), finishedAt: this.options.clock.nowIso(), progress: { current: 1, total: 1, unit: "operation" }, resultCode: current ? result.code : "CHANNEL_REVISION_CHANGED", artifactRefs: result.artifacts.map(a => `${a.rootId}:${a.relativePath}`), resultEventId: this.options.ids.opaqueId("channelevent") } };
      const serialized = JSON.parse(JSON.stringify(entry)); decodeEntry(serialized);
      const candidate: LedgerEvent = { schemaVersion: LEDGER_EVENT_SCHEMA_VERSION, eventId: entry.job.resultEventId!, eventKey: this.eventKey(entry.job), jobId: entry.job.jobId, contentRef: entry.job.contentRef, channel: entry.job.channel!, action: entry.job.action, sideEffect: entry.job.sideEffect, occurredAt: this.options.clock.nowIso(), outcome: entry.job.status === "succeeded" ? "succeeded" : "failed", evidence: { adapter: "wemedia-channel", adapterVersion: "1.0.0", code: entry.job.resultCode! }, artifactDigests: [document.revisionDigest, ...document.assets.map(a => a.digest)], remote: { entry: serialized } };
      try {
        const proof = await this.options.ledger.append(candidate);
        if (!proof.ok) fault("CHANNEL_LEDGER_COMMIT_FAILED", "结果账本未提交，禁止重发");
      } catch (error) {
        let persisted: LedgerEvent | undefined;
        try {
          // An append can become durable before its sync/close acknowledgment fails.
          // Consume the entire ledger before trusting a match; a later broken row
          // or duplicate must not be hidden by an early event-key lookup.
          persisted = (await this.readJournal(this.entries)).get(candidate.eventKey)?.event;
          if (persisted && canonicalJson(persisted) !== canonicalJson(candidate)) fault("CHANNEL_LEDGER_INVALID", "已写入的渠道结果与本次提交不一致");
        } catch (verificationError) {
          this.faults.push("CHANNEL_RESULT_PERSISTENCE_FAILED");
          if (verificationError instanceof WorkbenchFault) this.faults.push(verificationError.code);
          if (persisted) {
            // A fully read but different candidate is a confirmed conflict. Make
            // that decision durable so a restart cannot accept the same proof.
            try { await this.save({ ...entry, status: "reconcile_required", verifiedAt: "", job: { ...entry.job, status: "reconcile_required", safeMessage: "渠道账本证据冲突，已停止远端写入", resultCode: "CHANNEL_LEDGER_CONFLICT" } }); } catch { /* The current instance remains blocked if quarantine storage also fails. */ }
          }
          // For an unreadable ledger, keep the durable running entry available
          // for recovery when storage is readable again.
          return;
        }
        if (!persisted) throw error;
      }
      journaled = true;
      await this.save(entry);
    } catch (error) {
      if (journaled) { this.faults.push("CHANNEL_RESULT_PERSISTENCE_FAILED"); return; }
      const uncertain = dispatched && entry.job.sideEffect.startsWith("remote_");
      const status = uncertain ? "reconcile_required" : timedOut ? "timed_out" : controller.signal.aborted ? "cancelled" : "failed";
      // Leave the durable running entry for ledger recovery if terminal storage fails.
      const next: Entry = { ...entry, status: uncertain ? "reconcile_required" : undefined, verifiedAt: "", job: { ...entry.job, status, safeMessage: message(status), finishedAt: this.options.clock.nowIso(), resultCode: timedOut ? "CHANNEL_TIMEOUT" : error instanceof WorkbenchFault ? error.code : "CHANNEL_ACTION_FAILED" } };
      delete next.job.resultEventId;
      try { await this.save(next); } catch { this.faults.push("CHANNEL_RESULT_PERSISTENCE_FAILED"); }
    } finally { clearTimeout(timeout); }
  }
  getJob(id: string): WorkbenchJob { return structuredClone(this.entries.get(id)?.job ?? fault("JOB_NOT_FOUND", "未找到渠道任务")); }
  cancel(id: string): WorkbenchJob { this.pending.get(id)?.abort(); return this.getJob(id); }
  async settle(id: string): Promise<WorkbenchJob> { await this.active.get(id)?.completion; return this.getJob(id); }
  async request(request: ChannelRequest, caller: WorkbenchCaller, signal: AbortSignal): Promise<ChannelInspection | ChannelCheck | ChannelPreview | WorkbenchJob> {
    await this.initialize();
    if (this.stopped || signal.aborted) fault("REQUEST_CANCELLED", "渠道服务已停止或请求已取消");
    switch (request.operation) {
      case "channel_inspect": return this.inspect(request.contentRef, signal);
      case "channel_preflight": return this.preflight(request.contentRef, request.channel, request.online ?? false, signal);
      case "channel_preview_action": return this.preview(request, caller, signal);
      case "channel_start_action": return this.start(request.intentId, caller, signal);
    }
  }
  async dispose(): Promise<void> { this.stopped = true; this.intents.clear(); this.lifetime.abort(); for (const c of this.pending.values()) c.abort(); await Promise.allSettled([...this.active.values()].map(v => v.completion)); }
}

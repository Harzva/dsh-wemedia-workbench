import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ClientState } from "./controller.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { WorkbenchJob, WorkbenchRequest, WorkbenchValue } from "../domain/workbench.ts";
import { CHANNEL_ACTIONS, PUBLISHING_CHANNELS, channelEffect } from "../domain/channelPublishing.ts";
import type { ChannelAction, ChannelCheck, ChannelInspection, ChannelPreview, PublishingChannel } from "../domain/channelPublishing.ts";
import { displayTime, statusLabel } from "./presentation.ts";
import { channelUrl } from "../domain/channelRemote.ts";
import { safeRelativeFile } from "../domain/artifactValidation.ts";

export interface ChannelActionsHost {
  channelRequest(request: WorkbenchRequest, signal?: AbortSignal): Promise<WorkbenchValue>;
  handoffChannelIntent(intentId: string): Promise<void>;
}
export interface ChannelActionsContext {
  contentRef: ContentRef; revisionDigest: string; connected: boolean; dirty: boolean;
  generationId: string | null; writable: boolean; approvalAvailable: boolean;
}
export interface ChannelActionsState {
  channel: PublishingChannel; inspection: ChannelInspection | null; check: ChannelCheck | null;
  preview: ChannelPreview | null; targetRef: string; targetUrl: string; jobs: WorkbenchJob[];
  pending: string | null; notice: string | null; error: string | null;
  checkOnline: boolean | null; checkedAt: string | null;
}
export const channelName = (channel: string): string => ({ wechat: "微信公众号", zhihu: "知乎", xiaohongshu: "小红书", x: "X", csdn: "CSDN" })[channel] ?? channel;
const actionName: Record<ChannelAction, string> = { prepare: "本地材料", stage: "平台草稿 / 手工准备", publish: "正式发布", sync: "只读核对" };
const terminal = (job: WorkbenchJob): boolean => ["succeeded", "failed", "cancelled", "timed_out", "reconcile_required"].includes(job.status);
const initial = (channel: PublishingChannel = "zhihu"): ChannelActionsState => ({ channel, inspection: null, check: null, preview: null, targetRef: "", targetUrl: "", jobs: [], pending: null, notice: null, error: null, checkOnline: null, checkedAt: null });
const codePattern = /^[A-Z][A-Z0-9_]{0,100}$/;
function code(error: unknown): string | null {
  const value = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof value === "string" && codePattern.test(value) ? value : null;
}
export function channelReason(value: string): string {
  const messages: Record<string, string> = {
    CHANNEL_TYPE_ACTION_UNSUPPORTED: "当前内容类型不支持此操作", CHANNEL_BRIDGE_MISSING: "尚未配置渠道连接", CHANNEL_DISCOVERY_FAILED: "渠道能力检查未完成",
    CHANNEL_PROTOCOL_AVAILABLE: "渠道入口已接通，操作前仍会检查内容和账号", ACCOUNT_PERMISSION_RECHECK_REQUIRED: "执行前核对账号权限，并申请本次原生审批",
    USE_EXISTING_WECHAT_ACTIONS: "使用文章中的公众号草稿入口", XHS_ACCOUNT_BINDING_MISSING: "本地小红书工具未提供稳定账号 ID，需升级后核对登录",
    XHS_LOGIN_REQUIRED: "请先在本地小红书工具登录", XHS_ACCOUNT_CHANGED: "小红书账号已变更，请重新核对",
    XHS_ARTICLE_AUTOPUBLISH_UNSUPPORTED: "文章可准备本地材料；自动发布需先制作图文或视频稿", XHS_TITLE_TOO_LONG: "小红书标题超过平台限制",
    XHS_BODY_TOO_LONG: "小红书正文超过平台限制", XHS_SUBMITTED_UNVERIFIED: "已提交，结果待核对；请粘贴作品链接只读核对，避免重复发送",
    XHS_REMOTE_RESULT_UNCERTAIN: "提交结果尚未确认，请只读核对作品", CHANNEL_PERMISSION_UNKNOWN: "权限尚未核实", SESSION_REQUIRED: "请先选择当前 DSH 会话",
    X_AUTH_EXPIRED: "X 的本地授权已过期，请重新授权后检查", X_AUTH_MISSING: "尚未配置 X 用户授权", X_PERMISSION_DENIED: "当前 X 授权缺少此操作权限", X_CREDITS_REQUIRED: "X API 当前要求可用额度", X_AUTH_REJECTED: "X 授权未通过验证，请重新授权", X_ACCOUNT_PERMISSION_UNKNOWN: "已找到本地授权引用，账号和权限仍需在线检查",
    ZHIHU_LOGIN_REQUIRED: "知乎登录已失效，请重新登录", ZHIHU_LOGIN_VERIFIED: "知乎当前账号已核对，发布权限会在执行前再次检查", ZHIHU_TARGET_PROOF_REQUIRED: "此知乎作品缺少工作台草稿核对记录，请先检查已有草稿", XHS_ACCOUNT_UNCHECKED: "本地材料可用，小红书账号尚未在线检查", XHS_PUBLISH_PERMISSION_UNPROVEN: "小红书账号已核对，尚未证明本次发布权限",
    UNSAVED_EDIT: "请先保存当前编辑", INTENT_ALREADY_QUEUED: "已交给当前 Agent，请查看任务状态", INTENT_EXPIRED: "操作预览已过期，请重新预览",
    REMOTE_UNAVAILABLE: "工作台服务尚未连接", INVALID_CHANNEL_RESPONSE: "渠道响应与当前内容不一致，请刷新",
    CHANNEL_ACCOUNT_UNVERIFIED: "当前账号尚未核实，请核对登录与权限", CHANNEL_ACCOUNT_CHANGED: "目标作品属于另一账号，请切回原账号后核对",
    CHANNEL_TARGET_REQUIRED: "请先选择已有作品；知乎正式发布需要已核对的平台草稿", CHANNEL_TARGET_NOT_FOUND: "作品记录已变化，请刷新后重新选择",
    CHANNEL_EXISTING_TARGET: "已有平台草稿或作品，请先核对现有结果", CHANNEL_RECONCILE_OR_DUPLICATE: "已有发表或待确认记录，请只读核对，避免重复提交",
    CHANNEL_REVISION_CHANGED: "当前保存版本已变化，请重新预览并核对作品", CHANNEL_RECOVERY_BLOCKED: "渠道记录恢复未完成，请先在任务中心处理待核对结果",
    CHANNEL_TIMEOUT: "操作超时，请刷新任务并核对结果", CHANNEL_INTERRUPTED: "执行被中断，请核对任务结果", CHANNEL_TARGET_URL_INVALID: "请使用此平台不含查询参数的完整作品链接",
    WRITE_ROOT_REQUIRED: "尚未配置独立可写目录", AGENT_APPROVAL_REQUIRED: "原生审批服务不可用", ARTICLE_REVIEWS_REQUIRED: "论文稿需要完成当前版本的四类审阅",
  };
  return messages[value] ?? (codePattern.test(value) ? `渠道提示：${value}` : "渠道状态待检查");
}

/** Public identifiers only: query credentials and XHS xsec tokens never leave this input. */
export function publicChannelUrl(channel: PublishingChannel, input: string): string | null {
  return channelUrl(channel, input.trim()) ?? null;
}

/** Owns presentation requests only. Host binds approvals, accounts, files and durable jobs. */
export class ChannelActionsController {
  private state: ChannelActionsState = initial();
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private epoch = 0;
  private active = true;
  private submitted = new Set<string>();
  constructor(private readonly host: ChannelActionsHost, private context: ChannelActionsContext, private readonly now = Date.now) {}
  getSnapshot = (): ChannelActionsState => this.state;
  getContext = (): ChannelActionsContext => this.context;
  hasContext(context: ChannelActionsContext): boolean {
    return (["contentRef", "revisionDigest", "connected", "dirty", "generationId", "writable", "approvalAvailable"] as const).every(key => context[key] === this.context[key]);
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(update: Partial<ChannelActionsState>): void { if (this.active) { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(); } }
  private invalidate(): void { this.epoch++; this.request?.abort(); this.request = null; }
  connect(): void { this.active = true; }
  disconnect(): void { this.invalidate(); this.state = initial(this.state.channel); this.active = false; }
  setContext(context: ChannelActionsContext): void {
    if (this.hasContext(context)) return;
    this.invalidate(); this.context = context; this.patch(initial(this.state.channel));
  }
  selectChannel(channel: PublishingChannel): void {
    if (channel === this.state.channel || !PUBLISHING_CHANNELS.includes(channel)) return;
    this.invalidate(); this.patch({ channel, targetRef: "", targetUrl: "", preview: null, check: null, checkOnline: null, checkedAt: null, pending: null, error: null, notice: null });
  }
  setTarget(targetRef: string): void { this.invalidate(); this.patch({ targetRef, targetUrl: "", preview: null, pending: null, error: null }); }
  setTargetUrl(targetUrl: string): void { this.invalidate(); this.patch({ targetRef: "", targetUrl, preview: null, pending: null, error: null }); }
  discardPreview(): void { this.invalidate(); this.patch({ preview: null, pending: null }); }
  private usable(): boolean { return this.active && this.context.connected && !this.context.dirty; }
  disabledReason(action: ChannelAction): string | null {
    if (!this.context.connected) return "工作台服务尚未连接";
    if (this.context.dirty) return "请先保存当前编辑";
    if (!this.state.inspection) return "请先刷新渠道能力";
    if (action !== "sync" && !this.context.writable) return "尚未配置可写目录";
    if (["remote_draft", "remote_publish"].includes(channelEffect(this.state.channel, action)) && !this.context.approvalAvailable) return "原生审批服务不可用";
    const entry = this.state.inspection.matrix.find(row => row.channel === this.state.channel && row.publicationType === this.state.inspection?.publicationType && row.action === action);
    if (!entry || ["unsupported", "unavailable"].includes(entry.status)) return channelReason(entry?.reasonCode ?? "CHANNEL_BRIDGE_MISSING");
    if (channelEffect(this.state.channel, action).startsWith("remote_") && this.state.checkOnline && this.state.check?.permission === "missing") return "账号授权不可用，请完成登录或授权后重新核对";
    if (action === "sync" && !this.state.targetRef && !publicChannelUrl(this.state.channel, this.state.targetUrl)) return "请选择已有作品，或填写不含查询参数的公开作品链接";
    return null;
  }
  private async run(key: string, work: (signal: AbortSignal, fresh: () => boolean) => Promise<void>): Promise<void> {
    if (!this.usable() || this.state.pending) return;
    const request = new AbortController(), epoch = this.epoch;
    this.request = request; this.patch({ pending: key, error: null, notice: null });
    const fresh = () => this.active && this.epoch === epoch && !request.signal.aborted;
    try { await work(request.signal, fresh); }
    catch (error) { if (fresh()) this.patch({ error: code(error) ? channelReason(code(error)!) : "请求未完成，请刷新核对状态。写入不会自动重试。" }); }
    finally { if (fresh()) { this.request = null; this.patch({ pending: null }); } }
  }
  private async readInspection(signal: AbortSignal, fresh: () => boolean, observed?: WorkbenchJob): Promise<void> {
    const value = await this.host.channelRequest({ operation: "channel_inspect", contentRef: this.context.contentRef }, signal) as ChannelInspection;
    if (!fresh()) return;
    if (value.contentRef !== this.context.contentRef || value.revisionDigest !== this.context.revisionDigest || !Array.isArray(value.matrix) || !Array.isArray(value.jobs) || !Array.isArray(value.targets)) throw { code: "INVALID_CHANNEL_RESPONSE" };
    const jobs = value.jobs.filter(job => job.contentRef === this.context.contentRef);
    // The terminal get_job response remains visible even if the list read is briefly stale.
    if (observed) { const index = jobs.findIndex(job => job.jobId === observed.jobId); if (index < 0) jobs.unshift(observed); else jobs[index] = observed; }
    const missingTarget = !!this.state.targetRef && !value.targets.some(target => target.channel === this.state.channel && target.targetRef === this.state.targetRef);
    this.patch({ inspection: value, jobs: jobs.slice(0, 30), preview: null, ...(missingTarget ? { targetRef: "", notice: "先前选择的作品记录已变化，请重新选择或填写公开作品链接。" } : {}) });
  }
  async inspect(): Promise<void> { await this.run("inspect", (signal, fresh) => this.readInspection(signal, fresh)); }
  private async refreshAfterTerminal(job: WorkbenchJob, signal: AbortSignal, fresh: () => boolean): Promise<void> {
    if (!terminal(job)) return;
    try { await this.readInspection(signal, fresh, job); }
    catch { if (fresh()) this.patch({ error: "任务状态已更新，但作品列表暂未刷新。请点击“刷新平台与任务”重新核对；当前作品状态仍是上次读取的结果。" }); }
  }
  async preflight(online = false): Promise<void> {
    await this.run("preflight", async (signal, fresh) => {
      const value = await this.host.channelRequest({ operation: "channel_preflight", contentRef: this.context.contentRef, channel: this.state.channel, online }, signal) as ChannelCheck;
      if (!fresh()) return;
      if (value.contentRef !== this.context.contentRef || value.revisionDigest !== this.context.revisionDigest || value.channel !== this.state.channel) throw { code: "INVALID_CHANNEL_RESPONSE" };
      this.patch({ check: value, checkOnline: online, checkedAt: new Date(this.now()).toISOString(), preview: null });
    });
  }
  async previewAction(action: ChannelAction): Promise<void> {
    const reason = this.disabledReason(action);
    if (reason) { this.patch({ error: reason }); return; }
    await this.run("preview", async (signal, fresh) => {
      const targetUrl = publicChannelUrl(this.state.channel, this.state.targetUrl);
      const value = await this.host.channelRequest({ operation: "channel_preview_action", contentRef: this.context.contentRef, channel: this.state.channel, action,
        ...(this.state.targetRef ? { targetRef: this.state.targetRef } : action === "sync" && targetUrl ? { targetUrl } : {}) }, signal) as ChannelPreview;
      if (!fresh()) return;
      if (!this.matches(value, action)) throw { code: "INVALID_CHANNEL_RESPONSE" };
      this.patch({ preview: value });
    });
  }
  private matches(preview: ChannelPreview, action = preview.action): boolean {
    return preview.channel === this.state.channel && preview.action === action && preview.intent?.contentRef === this.context.contentRef && preview.intent.artifactDigest === this.context.revisionDigest
      && preview.intent.generationId === this.context.generationId && preview.intent.channel === this.state.channel && preview.intent.action === `channel_${action}` && preview.intent.sideEffect === channelEffect(this.state.channel, action) && preview.gates.inputDigest === this.context.revisionDigest;
  }
  confirmationBlocked(): boolean {
    const preview = this.state.preview;
    return !this.usable() || !!this.state.pending || !preview || !this.matches(preview) || !!this.disabledReason(preview.action)
      || !Number.isFinite(Date.parse(preview.intent.expiresAt)) || Date.parse(preview.intent.expiresAt) <= this.now() || preview.gates.status === "block" || preview.gates.issues.some(issue => issue.status === "block") || !!preview.intent.blockingGateCodes.length || this.submitted.has(preview.intent.intentId);
  }
  async confirmPreview(): Promise<void> {
    if (this.confirmationBlocked()) return;
    const preview = this.state.preview!;
    this.submitted.add(preview.intent.intentId);
    await this.run("start", async (signal, fresh) => {
      this.patch({ preview: null });
      if (["remote_draft", "remote_publish"].includes(preview.intent.sideEffect)) {
        await this.host.handoffChannelIntent(preview.intent.intentId);
        if (fresh()) this.patch({ notice: "已交给当前 Agent，完成原生审批后执行。可刷新查看任务状态。" });
      } else {
        const job = await this.host.channelRequest({ operation: "channel_start_action", intentId: preview.intent.intentId }, signal) as WorkbenchJob;
        if (fresh()) { this.acceptJob(job); this.patch({ notice: terminal(job) ? "已收到任务结果，请查看下方任务与作品记录。" : preview.action === "sync" ? "已开始只读核对作品。" : "已开始准备独立本地材料。" }); await this.refreshAfterTerminal(job, signal, fresh); }
      }
    });
  }
  private acceptJob(job: WorkbenchJob, existing?: WorkbenchJob): void {
    if (!job.jobId || job.contentRef !== this.context.contentRef || job.generationId !== (existing?.generationId ?? this.context.generationId) || !job.action.startsWith("channel_") || existing && (job.jobId !== existing.jobId || job.channel !== existing.channel || job.action !== existing.action)) throw { code: "INVALID_CHANNEL_RESPONSE" };
    this.patch({ jobs: [job, ...this.state.jobs.filter(existing => existing.jobId !== job.jobId)].slice(0, 30) });
  }
  async refreshJob(jobId: string): Promise<void> {
    const existing = this.state.jobs.find(job => job.jobId === jobId);
    if (!existing) return;
    await this.run("job", async (signal, fresh) => { const job = await this.host.channelRequest({ operation: "get_job", jobId }, signal) as WorkbenchJob; if (fresh()) { this.acceptJob(job, existing); await this.refreshAfterTerminal(job, signal, fresh); } });
  }
  async cancelJob(jobId: string): Promise<void> {
    const existing = this.state.jobs.find(job => job.jobId === jobId);
    if (!existing || terminal(existing)) return;
    await this.run("cancel", async (signal, fresh) => { const job = await this.host.channelRequest({ operation: "cancel_job", jobId }, signal) as WorkbenchJob; if (fresh()) { this.acceptJob(job, existing); await this.refreshAfterTerminal(job, signal, fresh); } });
  }
}

export interface ChannelActionsProps {
  controller: ChannelActionsHost; state: Pick<ClientState, "connected" | "snapshot">;
  contentRef: ContentRef; revisionDigest: string; dirty: boolean;
}
const useContextLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Ten reads per observed job, with no timer while hidden, busy, or out of work. */
export function trackChannelJobs(model: ChannelActionsController, visible = () => typeof document === "undefined" || !document.hidden, onVisibility = (listener: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}): () => void {
  const reads = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const eligible = () => model.getSnapshot().jobs.find(job => !terminal(job) && (reads.get(job.jobId) ?? 0) < 10);
  const schedule = () => {
    clearTimeout(timer); timer = undefined;
    const context = model.getContext();
    if (stopped || !visible() || context.dirty || !context.connected || model.getSnapshot().pending || !eligible()) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const job = eligible();
      if (stopped || !visible() || !job) return;
      reads.set(job.jobId, (reads.get(job.jobId) ?? 0) + 1);
      await model.refreshJob(job.jobId);
      schedule();
    }, 2_000);
  };
  const unsubscribe = model.subscribe(schedule), removeVisibility = onVisibility(schedule);
  schedule();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); removeVisibility(); };
}

export function ChannelActions({ controller, state, contentRef, revisionDigest, dirty }: ChannelActionsProps) {
  const generationId = state.snapshot?.generationId ?? null, writable = !!state.snapshot?.settings.hasWriteRoot, approvalAvailable = !!state.snapshot?.settings.approvalAvailable;
  const context = useMemo(() => ({ contentRef, revisionDigest, dirty, connected: state.connected, generationId, writable, approvalAvailable }), [contentRef, revisionDigest, dirty, state.connected, generationId, writable, approvalAvailable]);
  const model = useMemo(() => new ChannelActionsController(controller, context), [controller, contentRef]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useContextLayoutEffect(() => { model.connect(); return () => model.disconnect(); }, [model]);
  // Keep the platform choice while invalidating old requests/intents before the next paint.
  useContextLayoutEffect(() => { model.setContext(context); }, [model, context]);
  useEffect(() => { void model.inspect(); }, [model, context]);
  useEffect(() => trackChannelJobs(model), [model]);
  return <ChannelActionsPanel model={model} view={view} context={context} />;
}

export function ChannelActionsPanel({ model, view, context: expectedContext }: { model: ChannelActionsController; view: ChannelActionsState; context?: ChannelActionsContext }) {
  // A concurrent render may see new props before layout effects commit. Never render an old intent in that gap.
  if (expectedContext && !model.hasContext(expectedContext)) return <section className="wm-card wm-stack wm-channel-actions" aria-label="多平台发布"><h3>多平台发布</h3><p role="status">正在切换到当前内容版本…</p></section>;
  const context = model.getContext(), locked = !context.connected || context.dirty || !!view.pending;
  const targets = view.inspection?.targets.filter(target => target.channel === view.channel) ?? [];
  const preview = view.preview, remotePreview = preview && ["remote_draft", "remote_publish"].includes(preview.intent.sideEffect);
  const matrix = view.inspection?.matrix.filter(row => row.publicationType === view.inspection?.publicationType && CHANNEL_ACTIONS.includes(row.action as ChannelAction)) ?? [];
  const selectedTarget = targets.find(target => target.targetRef === view.targetRef);
  const targetStatus = (status: string) => ({ draft: "平台草稿已核对", published: "已发布并核对", reconcile_required: "待核对结果" })[status] ?? "状态待核对";
  const restrictions = (["prepare", "stage", "publish"] as const).flatMap(action => { const reason = model.disabledReason(action); return reason ? [{ action, reason }] : []; });
  return <section className="wm-card wm-stack wm-channel-actions" aria-label="多平台发布">
    <div className="wm-row wm-between"><h3>多平台发布</h3><Button size="sm" disabled={locked} onClick={() => void model.inspect()}>刷新平台与任务</Button></div>
    <p className="wm-small wm-muted">以当前保存版本准备材料、发布与核对结果。微信公众号使用文章中的草稿入口。</p>
    {context.dirty && <p className="wm-inline-note" role="status">请先保存当前编辑，再操作发布渠道。</p>}
    {!context.connected && <p className="wm-inline-note" role="status">工作台服务尚未连接。</p>}
    <div className="wm-row"><label>发布平台 <select aria-label="发布平台" value={view.channel} disabled={!!view.pending} onChange={event => model.selectChannel(event.target.value as PublishingChannel)}>{PUBLISHING_CHANNELS.map(channel => <option key={channel} value={channel}>{channelName(channel)}</option>)}</select></label>
      <Button size="sm" disabled={locked} onClick={() => void model.preflight(false)}>本地检查</Button><Button size="sm" disabled={locked} onClick={() => void model.preflight(true)}>核对登录与权限</Button></div>
    {view.channel === "xiaohongshu" && <p className="wm-small wm-muted">小红书支持图文、视频自动发布；文章先准备本地材料，或在图文编辑器制作图文稿。</p>}
    {view.channel === "x" && <p className="wm-small wm-muted">X 的手工准备生成本地材料；正式发布按当前账号权限和平台长度限制检查。</p>}
    <div className="wm-row">{(["prepare", "stage", "publish"] as const).map(action => <Button key={action} size="sm" disabled={locked || !!model.disabledReason(action)} title={model.disabledReason(action) ?? undefined} onClick={() => void model.previewAction(action)}>{action === "prepare" ? "预览本地材料" : action === "stage" ? view.channel === "zhihu" ? "预览知乎草稿" : "预览手工准备" : "预览正式发布"}</Button>)}</div>
    {!!restrictions.length && <ul className="wm-small wm-muted" aria-label="操作限制">{restrictions.map(({ action, reason }) => <li key={action}>{actionName[action]}：{reason}</li>)}</ul>}
    <div className="wm-stack"><label>已有作品 <select aria-label="已有作品" value={view.targetRef} disabled={locked} onChange={event => model.setTarget(event.target.value)}><option value="">填写作品链接或选择已有作品</option>{targets.map(target => <option value={target.targetRef} key={target.targetRef}>{target.label}{target.revisionDigest !== context.revisionDigest ? " · 旧版本" : ""}</option>)}</select></label>
      {selectedTarget && <div className="wm-inline-note" aria-label="所选作品状态"><p>{targetStatus(selectedTarget.status)} · {selectedTarget.revisionDigest === context.revisionDigest ? "当前保存版本" : "此前保存版本，需要重新核对"}</p><p className="wm-small">{selectedTarget.verifiedAt ? `核对时间：${displayTime(selectedTarget.verifiedAt)}` : "尚无已核实的时间记录"}</p>{publicChannelUrl(view.channel, selectedTarget.url) && <a href={publicChannelUrl(view.channel, selectedTarget.url)!} target="_blank" rel="noopener noreferrer">查看平台作品</a>}</div>}
      <label>公开作品链接<input aria-label="公开作品链接" type="url" value={view.targetUrl} maxLength={500} disabled={locked} placeholder={view.channel === "xiaohongshu" ? "https://www.xiaohongshu.com/explore/作品ID" : view.channel === "zhihu" ? "https://zhuanlan.zhihu.com/p/作品ID" : "https://x.com/用户名/status/作品ID"} onChange={event => model.setTargetUrl(event.target.value)} /></label>
      <p className="wm-small wm-muted">链接仅用于只读核对和绑定结果。请使用完整公开链接，移除问号及其后的参数。</p>
      <Button size="sm" disabled={locked || !!model.disabledReason("sync")} title={model.disabledReason("sync") ?? undefined} onClick={() => void model.previewAction("sync")}>预览只读核对</Button></div>
    {view.check && <div className="wm-inline-note" aria-label="渠道检查结果"><p>{view.checkOnline ? "在线账号检查" : "本地配置检查"} · {view.checkedAt ? displayTime(view.checkedAt) : "时间未知"}</p><p>连接：{statusLabel(view.check.configured)} · 账号权限：{view.check.permission === "missing" ? "授权不可用" : view.check.permission === "available" ? "已核实本次检查权限" : "尚未核实"} · 检查：{statusLabel(view.check.gates.status)}</p>{!view.checkOnline && <p className="wm-small">本地检查不确认登录有效；发布前请核对登录与权限。</p>}<ul>{view.check.gates.issues.map((issue, index) => <li key={index}>{statusLabel(issue.status)} · {channelReason(issue.code)}</li>)}</ul></div>}
    {!!view.inspection?.issues.length && <ul className="wm-inline-note" aria-label="渠道服务提示">{view.inspection.issues.map(issue => <li key={issue}>{channelReason(issue)}</li>)}</ul>}
    {preview && <section className="wm-card wm-stack" aria-label="渠道操作预览"><h4>{channelName(preview.channel)} · {actionName[preview.action]}</h4><ul>{preview.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <p className="wm-small wm-muted">{remotePreview ? "下一步交给当前 Agent，使用原生审批确认此版本和目标账号。" : preview.action === "sync" ? "核对指定作品的账号、内容和发布状态。" : "生成独立本地材料，手工准备完成后仍需在平台发布。"}预览有效至 {displayTime(preview.intent.expiresAt)}。</p>
      {preview.gates.issues.some(issue => issue.status !== "pass") && <ul>{preview.gates.issues.filter(issue => issue.status !== "pass").map((issue, index) => <li key={index}>{statusLabel(issue.status)} · {channelReason(issue.code)}</li>)}</ul>}
      {!!preview.intent.blockingGateCodes.length && <p role="alert">操作被阻断：{preview.intent.blockingGateCodes.map(channelReason).join("；")}</p>}
      <div className="wm-row"><Button disabled={!!view.pending} onClick={() => model.discardPreview()}>关闭预览</Button><Button variant="primary" disabled={model.confirmationBlocked()} onClick={() => void model.confirmPreview()}>{remotePreview ? "交给当前 Agent 审批" : preview.action === "sync" ? "开始只读核对" : "确认准备本地材料"}</Button></div></section>}
    {view.pending && <p role="status" className="wm-small">正在{view.pending === "start" ? "提交操作" : view.pending === "cancel" ? "请求取消任务" : "读取渠道状态"}…</p>}
    {view.notice && <p role="status" className="wm-inline-note">{view.notice}</p>}{view.error && <p role="alert" className="wm-error">{view.error}</p>}
    {view.jobs.filter(job => job.channel === view.channel).map(job => <article key={job.jobId} className="wm-card" aria-label="渠道任务"><div className="wm-row wm-between"><strong>{actionName[job.action.replace("channel_", "") as ChannelAction] ?? "渠道任务"}</strong><span className="wm-pill">{statusLabel(job.status)}</span></div><p className="wm-small">{job.safeMessage}</p>
      {job.progress.total && job.progress.total > 0 ? <progress aria-label="渠道任务进度" value={job.progress.current} max={job.progress.total} /> : <p className="wm-small wm-muted">已处理 {job.progress.current}{job.progress.unit ? ` ${job.progress.unit}` : " 项"}</p>}
      {job.status === "reconcile_required" && <p className="wm-inline-note">提交结果待核对。请填写作品链接只读核对，避免重复发送。</p>}
      {job.channel === "xiaohongshu" && job.action === "channel_sync" && job.status === "succeeded" && <p className="wm-small wm-muted">账号/正文/媒体数量已核对，图片原字节未校验</p>}
      <p className="wm-small wm-muted">{displayTime(job.finishedAt ?? job.startedAt ?? job.createdAt)}{job.resultCode ? ` · ${channelReason(job.resultCode)}` : ""}</p>
      {!!job.artifactRefs.length && <details open={job.status === "succeeded"} aria-label="本地材料位置"><summary>本地材料 · {job.artifactRefs.length} 项</summary><p className="wm-small wm-muted">以下位置由工作台记录，格式为“目录标识:相对路径”。在“设置与能力”查看对应的内容根目录，再按相对路径查找；也可将材料位置交给当前 Agent。准备完成后仍需在平台完成发布。</p><ul className="wm-code" style={{ overflowWrap: "anywhere" }}>{job.artifactRefs.filter(ref => { const separator = ref.indexOf(":"); return separator > 0 && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ref.slice(0, separator)) && safeRelativeFile(ref.slice(separator + 1)); }).map(ref => <li key={ref}>{ref}</li>)}</ul></details>}
      <div className="wm-row"><Button size="sm" disabled={locked} onClick={() => void model.refreshJob(job.jobId)}>刷新任务状态</Button>{!terminal(job) && <Button size="sm" disabled={locked} onClick={() => void model.cancelJob(job.jobId)}>取消任务</Button>}</div></article>)}
    {view.jobs.some(job => !terminal(job)) && <p className="wm-small wm-muted">页面可见时，每个任务自动读取最多 10 次进度。较长任务可点击“刷新平台与任务”查看结果。</p>}
    {!!matrix.length && <details><summary>平台支持范围与不可用原因</summary><div style={{ overflowX: "auto" }}><table className="wm-small"><thead><tr><th>平台</th><th>操作</th><th>能力</th><th>说明</th></tr></thead><tbody>{matrix.map(row => <tr key={`${row.channel}:${row.action}`}><td>{channelName(row.channel)}</td><td>{actionName[row.action as ChannelAction]}</td><td>{row.status === "existing_workflow" ? "已有入口" : statusLabel(row.status)}</td><td>{channelReason(row.reasonCode)}</td></tr>)}</tbody></table></div></details>}
  </section>;
}

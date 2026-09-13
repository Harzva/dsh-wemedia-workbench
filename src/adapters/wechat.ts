import { ADAPTER_ACTIONS } from "../domain/capability.ts";
import type { CapabilityReport, GateIssue, GateReport } from "../domain/capability.ts";
import { isJsonObject } from "../domain/json.ts";
import type { JsonObject } from "../domain/json.ts";
import { safeRelativeFile, SHA256_PATTERN } from "../domain/wechatDocument.ts";
import { BRIDGE_SCHEMA } from "../domain/workbench.ts";
import type { AiWorkflowResult, ArticleDocument, DraftTarget } from "../domain/workbench.ts";
import type { CommandSpec, ProcessRunner } from "../ports/process.ts";
import type { WorkbenchAdapter, WorkbenchRemoteResult } from "../ports/workbench.ts";

export const WECHAT_READBACK_CHECKS = [
  "present", "title_matches", "topic_prefix_present", "digest_matches", "digest_plain_text",
  "content_text_matches", "result_table_count_matches", "result_table_cells_match", "content_deep",
  "image_count_matches", "images_uploaded", "images_match_approved_uploads", "image_upload_map_count_matches",
  "source_url_matches", "official_page_url_visible", "official_pdf_url_visible", "code_url_visible_or_not_required",
  "cover_present", "developer_notes_absent", "local_paths_absent",
] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,80}$/u;
const ACCOUNT = /^wechat-account:[a-f0-9]{32}$/u;
type Operation = "discover" | "preflight" | "draft_create" | "draft_update" | "draft_identity" | "sync" | AiWorkflowResult["operation"];
type DraftIdentityTarget = { mediaId: string; title: string; sourceUrl: string };
interface Envelope {
  ok: boolean; code: string; configured: CapabilityReport["configured"];
  accountRef?: string; revisionDigest?: string; remoteId?: string; verifiedAt?: string;
  issues: Array<{ status: "pass" | "warn" | "block"; code: string }>;
  uploads: NonNullable<WorkbenchRemoteResult["uploads"]>;
  reconcileRequired: boolean;
  identityVerified?: true;
  mode?: AiWorkflowResult["mode"];
  sourceKind?: AiWorkflowResult["sourceKind"];
  status?: AiWorkflowResult["status"];
  previewFidelity?: AiWorkflowResult["previewFidelity"];
}
function isWriteOperation(operation: Operation): boolean { return operation === "draft_create" || operation === "draft_update"; }
function isAiOperation(operation: Operation): operation is AiWorkflowResult["operation"] { return operation === "ai_inspect" || operation === "ai_preview"; }
function issueStatus(issues: Envelope["issues"]): AiWorkflowResult["status"] {
  return issues.some(issue => issue.status === "block") ? "block" : issues.some(issue => issue.status === "warn") ? "warn" : "pass";
}
function safeIdentityId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && !value.includes(".."); }
function safeIdentityTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function reject(code: string, reconcileRequired = false): Envelope {
  return { ok: false, code, configured: "unknown", issues: [], uploads: [], reconcileRequired };
}
function safeCdn(value: unknown): value is string {
  try {
    if (typeof value !== "string" || value.length > 4096) return false;
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname === "mmbiz.qpic.cn" && !url.username && !url.password && ![...url.searchParams.keys()].some(key => /token|secret|password|cookie|authorization|api.?key/iu.test(key));
  } catch { return false; }
}
export function decodeWechatBridge(text: string, operation: Operation, revision?: string): Envelope {
  const remote = isWriteOperation(operation);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return reject("WECHAT_JSON_INVALID", remote); }
  if (!isJsonObject(raw) || raw.schemaVersion !== BRIDGE_SCHEMA || raw.adapterVersion !== "1.0.0" || raw.operation !== operation || typeof raw.ok !== "boolean" || typeof raw.code !== "string" || !CODE.test(raw.code) || typeof raw.configured !== "string" || !["configured", "missing", "invalid", "unknown"].includes(raw.configured) || !Array.isArray(raw.issues) || !Array.isArray(raw.uploads) || typeof raw.remoteWriteAttempted !== "boolean") return reject("WECHAT_PROTOCOL_INVALID", remote);
  if (raw.reconcileRequired !== undefined && typeof raw.reconcileRequired !== "boolean") return reject("WECHAT_PROTOCOL_INVALID", remote);
  const result: Envelope = { ok: raw.ok, code: raw.code, configured: raw.configured as Envelope["configured"], issues: [], uploads: [], reconcileRequired: remote && (raw.reconcileRequired === true || (!raw.ok && raw.remoteWriteAttempted)) };
  if ((isAiOperation(operation) || operation === "draft_identity") && (raw.remoteWriteAttempted || raw.reconcileRequired === true || raw.uploads.length > 0)) return reject("WECHAT_RESULT_INCONSISTENT");
  for (const issue of raw.issues) {
    if (!isJsonObject(issue) || typeof issue.status !== "string" || !["pass", "warn", "block"].includes(issue.status) || typeof issue.code !== "string" || !CODE.test(issue.code)) return reject("WECHAT_ISSUE_INVALID", remote);
    result.issues.push({ status: issue.status as "pass" | "warn" | "block", code: issue.code });
  }
  for (const upload of raw.uploads) {
    if (!isJsonObject(upload) || !safeRelativeFile(upload.source) || typeof upload.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(upload.sha256) || typeof upload.media_id !== "string" || !ID.test(upload.media_id) || !safeCdn(upload.wechat_url)) return reject("WECHAT_UPLOAD_MAP_INVALID", remote);
    result.uploads.push({ source: upload.source, sha256: upload.sha256, media_id: upload.media_id, wechat_url: upload.wechat_url });
  }
  if (raw.accountRef !== undefined) {
    if (typeof raw.accountRef !== "string" || !ACCOUNT.test(raw.accountRef)) return reject("WECHAT_ACCOUNT_INVALID", remote);
    result.accountRef = raw.accountRef;
  }
  if (raw.revisionDigest !== undefined) {
    if (typeof raw.revisionDigest !== "string" || !SHA256_PATTERN.test(raw.revisionDigest) || raw.revisionDigest !== revision) return reject("WECHAT_REVISION_CHANGED", remote);
    result.revisionDigest = raw.revisionDigest;
  }
  if (raw.remoteId !== undefined) {
    if (typeof raw.remoteId !== "string" || !ID.test(raw.remoteId)) return reject("WECHAT_REMOTE_INVALID", remote);
    result.remoteId = raw.remoteId;
  }
  if (raw.verifiedAt !== undefined) {
    if (typeof raw.verifiedAt !== "string" || !Number.isFinite(Date.parse(raw.verifiedAt))) return reject("WECHAT_READBACK_INVALID", remote);
    result.verifiedAt = raw.verifiedAt;
  }
  if (result.ok && result.issues.some(issue => issue.status === "block")) return reject("WECHAT_RESULT_INCONSISTENT", remote);
  if (result.ok && operation !== "discover" && result.revisionDigest !== revision) return reject("WECHAT_REVISION_MISSING", remote);
  if (isAiOperation(operation)) {
    if (raw.mode !== "ai" || typeof raw.sourceKind !== "string" || !["markdown", "html"].includes(raw.sourceKind) || typeof raw.status !== "string" || !["pass", "warn", "block"].includes(raw.status) || typeof raw.previewFidelity !== "string" || !["exact", "degraded", "unavailable"].includes(raw.previewFidelity)) return reject("WECHAT_AI_RESULT_INVALID");
    if (!result.revisionDigest) return reject("WECHAT_REVISION_MISSING");
    if (raw.status !== issueStatus(result.issues) || result.ok !== (raw.status !== "block") || (raw.sourceKind === "html" && (raw.status === "pass" || raw.previewFidelity === "exact")) || (raw.previewFidelity === "unavailable" && result.ok) || (raw.previewFidelity === "degraded" && raw.status === "pass")) return reject("WECHAT_RESULT_INCONSISTENT");
    Object.assign(result, { mode: "ai", sourceKind: raw.sourceKind, status: raw.status, previewFidelity: raw.previewFidelity });
  }
  if (operation === "draft_identity" && result.ok) {
    if (raw.identityVerified !== true || !result.remoteId || !safeIdentityId(result.remoteId) || !result.accountRef || !result.revisionDigest || !result.verifiedAt || !safeIdentityTime(result.verifiedAt)) return reject("WECHAT_IDENTITY_INCOMPLETE");
    result.identityVerified = true;
  }
  if (result.ok && (remote || operation === "sync")) {
    if (!result.remoteId || !result.verifiedAt || !isJsonObject(raw.checks) || Object.keys(raw.checks).length !== WECHAT_READBACK_CHECKS.length || !WECHAT_READBACK_CHECKS.every(key => raw.checks && isJsonObject(raw.checks) && raw.checks[key] === true)) return { ...result, ok: false, code: "WECHAT_READBACK_INCOMPLETE", reconcileRequired: remote };
    if (remote && raw.draftMode !== (operation === "draft_create" ? "created" : "updated")) return reject("WECHAT_DRAFT_MODE_MISMATCH", true);
  }
  return result;
}

export class WechatAdapter implements WorkbenchAdapter {
  private account: string | undefined;
  constructor(private readonly options: {
    runner?: ProcessRunner;
    command?: CommandSpec;
    roots: Record<string, string>;
    privateState: (contentRef: ArticleDocument["contentRef"], target: DraftTarget | null) => Promise<{ target?: { mediaId: string; title: string; sourceUrl: string }; uploads: JsonObject[]; accountRef?: string }>;
    now: () => string;
  }) {}
  accountRef(): string | undefined { return this.account; }
  private async invoke(operation: Operation, document: ArticleDocument | undefined, signal: AbortSignal, target: DraftTarget | null = null, identityTarget?: DraftIdentityTarget): Promise<Envelope> {
    if (!this.options.runner || !this.options.command) return reject("WECHAT_NOT_CONFIGURED");
    if (signal.aborted) return reject("WECHAT_CANCELLED");
    const revision = document?.revisionDigest;
    const request: JsonObject = { schemaVersion: BRIDGE_SCHEMA, operation };
    if (document) Object.assign(request, { roots: this.options.roots, metadata: document.metadata, htmlArtifact: document.htmlArtifact, assets: document.assets, expectedRevision: document.revisionDigest });
    if (document && isAiOperation(operation)) request.markdownText = document.markdown;
    if (operation === "draft_identity") {
      if (!document || !this.account) return reject("WECHAT_ACCOUNT_UNAVAILABLE");
      if (!identityTarget || !safeIdentityId(identityTarget.mediaId) || identityTarget.sourceUrl !== document.metadata.sourceUrl) return reject("WECHAT_DRAFT_TARGET_INVALID");
      Object.assign(request, { target: { mediaId: identityTarget.mediaId, title: identityTarget.title, sourceUrl: identityTarget.sourceUrl }, accountRef: this.account, network: "drafts" });
    }
    if (operation === "draft_create" || operation === "draft_update" || operation === "sync") {
      if (!document || !this.account) return reject("WECHAT_ACCOUNT_UNAVAILABLE");
      const state = await this.options.privateState(document.contentRef, target);
      if (state.accountRef !== undefined && state.accountRef !== this.account) return reject("WECHAT_TARGET_ACCOUNT_CHANGED");
      Object.assign(request, { ...state, accountRef: this.account, network: "drafts" });
    }
    const isWrite = isWriteOperation(operation);
    try {
      const process = await this.options.runner.run({ ...this.options.command, stdinText: JSON.stringify(request) }, signal);
      if (!process.ok) return reject("WECHAT_PROCESS_FAILED", isWrite);
      const result = process.value;
      if (result.stdoutTruncated) return reject("WECHAT_OUTPUT_TRUNCATED", isWrite);
      const decoded = decodeWechatBridge(result.stdout, operation, revision);
      if (result.cancelled || signal.aborted || result.timedOut) return { ...decoded, ok: false, code: result.cancelled || signal.aborted ? "WECHAT_CANCELLED" : "WECHAT_TIMEOUT", reconcileRequired: decoded.reconcileRequired || isWrite, ...(isAiOperation(operation) ? { previewFidelity: "unavailable" as const } : {}) };
      if (result.exitCode !== 0 && decoded.ok) return reject("WECHAT_PROCESS_FAILED", isWrite);
      return decoded;
    } catch { return reject("WECHAT_PROCESS_FAILED", isWrite); }
  }
  async discover(signal: AbortSignal): Promise<CapabilityReport> {
    const result = await this.invoke("discover", undefined, signal);
    this.account = result.ok && result.configured === "configured" ? result.accountRef : undefined;
    const installed = result.ok;
    const checkedAt = this.options.now();
    return { channel: "wechat", adapter: "md2wechat-bridge", adapterVersion: "1.0.0", configured: installed ? result.configured : "missing", actions: ADAPTER_ACTIONS.map(action => {
      const status = action === "publish" || action === "stage" ? "unsupported" : !installed ? "unavailable" : action === "draft" ? this.account ? "approval_required" : "unavailable" : action === "sync" && !this.account ? "unavailable" : "ready";
      return { action, status, reasonCode: status === "unsupported" ? "WECHAT_ACTION_UNSUPPORTED" : status === "approval_required" ? "WECHAT_APPROVAL_REQUIRED" : status === "ready" ? "WECHAT_LOCAL_READY" : result.code, safeMessage: status === "ready" ? "本地适配入口可用" : status === "approval_required" ? "账户权限仍需实际请求验证；操作须经过审批" : status === "unsupported" ? "当前阶段不提供正式发布" : "请检查微信适配脚本和账户配置", checkedAt };
    }) };
  }
  async check(document: ArticleDocument, signal: AbortSignal): Promise<GateReport> {
    const result = await this.invoke("preflight", document, signal);
    const issues: GateIssue[] = result.issues.map(issue => ({ ...issue, gateId: "wechat-native", version: "1", safeMessage: issue.status === "pass" ? "本地检查通过" : "本地检查需要处理", evidenceRefs: [], inputDigest: document.revisionDigest }));
    if (!result.ok && !issues.some(issue => issue.status === "block")) issues.push({ gateId: "wechat-native", version: "1", status: "block", code: result.code, safeMessage: "微信本地校验未能通过", evidenceRefs: [], inputDigest: document.revisionDigest });
    return { status: issues.some(issue => issue.status === "block") ? "block" : issues.some(issue => issue.status === "warn") ? "warn" : "pass", inputDigest: document.revisionDigest, issues };
  }
  async inspectAi(operation: AiWorkflowResult["operation"], document: ArticleDocument, signal: AbortSignal): Promise<AiWorkflowResult> {
    const revisionDigest = document.revisionDigest, markdownText = document.markdown;
    let result = await this.invoke(operation, document, signal);
    const sourceKind = markdownText.trim() ? "markdown" : "html";
    if (document.revisionDigest !== revisionDigest || document.markdown !== markdownText) result = reject("WECHAT_REVISION_CHANGED");
    if (result.sourceKind !== undefined && result.sourceKind !== sourceKind) result = reject("WECHAT_AI_SOURCE_MISMATCH");
    const issues: GateIssue[] = result.issues.map(issue => ({ ...issue, gateId: "wechat-ai", version: "1", safeMessage: issue.status === "pass" ? "原生 AI 模式检查通过；不代表人工审读" : "原生 AI 模式检查需要处理", evidenceRefs: [], inputDigest: revisionDigest }));
    if (!result.ok && !issues.some(issue => issue.status === "block")) issues.push({ gateId: "wechat-ai", version: "1", status: "block", code: result.code, safeMessage: "微信 AI 模式检查未能完成", evidenceRefs: [], inputDigest: revisionDigest });
    return { operation, revisionDigest, mode: "ai", sourceKind, status: issueStatus(issues), code: result.code, previewFidelity: result.previewFidelity ?? "unavailable", issues };
  }
  async verifyDraftIdentity(document: ArticleDocument, target: DraftIdentityTarget, signal: AbortSignal): Promise<{ ok: boolean; code: string; accountRef?: string; verifiedAt?: string }> {
    const expectedTarget = { ...target }, expectedAccount = this.account, expectedRevision = document.revisionDigest;
    const result = await this.invoke("draft_identity", document, signal, null, expectedTarget);
    if (!result.ok) return { ok: false, code: result.code };
    if (!result.identityVerified || !result.verifiedAt || result.remoteId !== expectedTarget.mediaId || target.mediaId !== expectedTarget.mediaId || target.title !== expectedTarget.title || target.sourceUrl !== expectedTarget.sourceUrl) return { ok: false, code: "WECHAT_DRAFT_IDENTITY_MISMATCH" };
    if (!result.accountRef || result.accountRef !== expectedAccount || this.account !== expectedAccount) return { ok: false, code: "WECHAT_ACCOUNT_CHANGED" };
    if (result.revisionDigest !== expectedRevision || document.revisionDigest !== expectedRevision) return { ok: false, code: "WECHAT_REVISION_CHANGED" };
    return { ok: true, code: result.code, accountRef: result.accountRef, verifiedAt: result.verifiedAt };
  }
  async run(action: "create_draft" | "update_draft" | "sync", document: ArticleDocument, target: DraftTarget | null, signal: AbortSignal): Promise<WorkbenchRemoteResult> {
    const operation = action === "create_draft" ? "draft_create" : action === "update_draft" ? "draft_update" : "sync";
    const result = await this.invoke(operation, document, signal, target);
    const issues: GateIssue[] = result.issues.map(issue => ({ ...issue, gateId: "wechat-native", version: "1", safeMessage: issue.status === "pass" ? "微信检查通过" : "微信检查需要处理", evidenceRefs: [], inputDigest: document.revisionDigest }));
    return { ok: result.ok, code: result.code, phase: action === "sync" ? "sync" : "draft", channel: "wechat", sideEffect: action === "sync" ? "read" : "remote_draft", artifacts: [], issues, retryable: false, reconcileRequired: result.reconcileRequired, uploads: result.uploads, ...(result.remoteId ? { remote: { remoteId: result.remoteId } } : {}), ...(result.verifiedAt ? { verifiedAt: result.verifiedAt } : {}), ...(result.revisionDigest ? { revisionDigest: result.revisionDigest } : {}) };
  }
}

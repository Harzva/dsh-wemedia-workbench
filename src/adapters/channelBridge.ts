import type { CapabilityReport } from "../domain/capability.ts";
import { ADAPTER_ACTIONS } from "../domain/capability.ts";
import type { ChannelAction, PublishingChannel, PublishingType } from "../domain/channelPublishing.ts";
import { channelEffect } from "../domain/channelPublishing.ts";
import type { ChannelBridgeResult, ChannelDocument, ChannelRunInput, PublishingAdapter } from "../ports/channelPublishing.ts";
import type { ProcessRunner, CommandSpec } from "../ports/process.ts";
import { isJsonObject } from "../domain/json.ts";
import { safeRelativeFile, SHA256_PATTERN } from "../domain/wechatDocument.ts";

import { decodeChannelRemote } from "../domain/channelRemote.ts";
export { channelUrl, decodeChannelRemote } from "../domain/channelRemote.ts";

export const CHANNEL_BRIDGE_SCHEMA = "wemedia.channel-bridge/v1";
export interface ChannelBridgeOptions { runner?: ProcessRunner; command?: CommandSpec; roots: Record<string, string>; now: () => string }
const code = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(v);
const failed = (reason: string, uncertain = false): ChannelBridgeResult => ({ ok: false, code: reason, configured: "unknown", remoteWriteAttempted: uncertain, reconcileRequired: uncertain, issues: [{ code: reason, status: "block" }], artifacts: [] });
export function decodeChannelResult(raw: unknown, channel: PublishingChannel, operation: string, input?: ChannelRunInput): ChannelBridgeResult {
  if (!isJsonObject(raw) || Object.keys(raw).some(k => !["schemaVersion", "adapterVersion", "channel", "operation", "ok", "code", "configured", "accountRef", "permission", "status", "revisionDigest", "verifiedAt", "remoteWriteAttempted", "reconcileRequired", "issues", "artifacts", "remote"].includes(k)) || raw.schemaVersion !== CHANNEL_BRIDGE_SCHEMA || raw.adapterVersion !== "1.0.0" || raw.channel !== channel || raw.operation !== operation || typeof raw.ok !== "boolean" || !code(raw.code) || !["configured", "missing", "invalid", "unknown"].includes(String(raw.configured)) || typeof raw.remoteWriteAttempted !== "boolean" || typeof raw.reconcileRequired !== "boolean" || !Array.isArray(raw.issues) || raw.issues.length > 100 || !Array.isArray(raw.artifacts) || raw.artifacts.length > 100) throw new Error("envelope");
  if (raw.accountRef !== undefined && (typeof raw.accountRef !== "string" || !new RegExp(`^${channel}-account:[a-f0-9]{32}$`, "u").test(raw.accountRef))) throw new Error("account");
  if (raw.permission !== undefined && !["unknown", "available", "missing"].includes(String(raw.permission))) throw new Error("permission");
  if (raw.status !== undefined && !["prepared", "manual_handoff", "draft", "published", "reconcile_required"].includes(String(raw.status))) throw new Error("status");
  if (raw.revisionDigest !== undefined && (typeof raw.revisionDigest !== "string" || !SHA256_PATTERN.test(raw.revisionDigest) || input && raw.revisionDigest !== input.document.revisionDigest)) throw new Error("revision");
  if (raw.verifiedAt !== undefined && (typeof raw.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(raw.verifiedAt) || !Number.isFinite(Date.parse(raw.verifiedAt)))) throw new Error("time");
  const issues = raw.issues.map(v => { if (!isJsonObject(v) || Object.keys(v).length !== 2 || !code(v.code) || !["pass", "warn", "block"].includes(String(v.status))) throw new Error("issue"); return { code: v.code, status: v.status as "pass" | "warn" | "block" }; });
  const artifacts = raw.artifacts.map(v => { if (!isJsonObject(v) || Object.keys(v).some(k => !["rootId", "relativePath", "digest"].includes(k)) || !input?.output || v.rootId !== input.output.rootId || typeof v.relativePath !== "string" || !safeRelativeFile(v.relativePath) || !v.relativePath.startsWith(`${input.output.relativePath}/`) || v.digest !== undefined && (typeof v.digest !== "string" || !SHA256_PATTERN.test(v.digest))) throw new Error("artifact"); return { rootId: v.rootId as string, relativePath: v.relativePath, ...(v.digest ? { digest: v.digest as string } : {}) }; });
  const remote = raw.remote === undefined ? undefined : decodeChannelRemote(channel, raw.remote);
  if (raw.remote !== undefined && !remote) throw new Error("remote");
  if (remote && input?.expectedAccountRef && raw.accountRef !== undefined && raw.accountRef !== input.expectedAccountRef) throw new Error("account");
  if (raw.ok && (issues.some(v => v.status === "block") || raw.reconcileRequired || raw.status === "reconcile_required")) throw new Error("blocked");
  const verified = raw.status === "published" || raw.status === "draft";
  if (verified && (raw.ok !== true || !remote?.url || !raw.verifiedAt || !input?.expectedAccountRef || !raw.accountRef || raw.revisionDigest !== input.document.revisionDigest || raw.accountRef !== input.expectedAccountRef)) throw new Error("unverified");
  if (verified && (operation === "sync" || operation === "publish" && channel === "zhihu") && !input?.target) throw new Error("target");
  if (raw.status === "draft" && channel !== "zhihu" || raw.status === "published" && channel === "zhihu" && remote?.url?.endsWith("/edit")) throw new Error("effect");
  const localStage = operation === "stage" && channel !== "zhihu";
  if (["discover", "preflight", "prepare"].includes(operation) || localStage) {
    if (raw.remoteWriteAttempted || raw.reconcileRequired || remote || raw.verifiedAt) throw new Error("effect");
    const expected = operation === "prepare" ? "prepared" : localStage ? "manual_handoff" : undefined;
    if (raw.ok ? raw.status !== expected : raw.status !== undefined) throw new Error("effect");
    if (["discover", "preflight"].includes(operation) && artifacts.length) throw new Error("effect");
  } else if (operation === "sync") {
    if (raw.remoteWriteAttempted || artifacts.length || raw.ok && !verified || !raw.ok && raw.status !== undefined && raw.status !== "reconcile_required") throw new Error("effect");
  } else if (operation === "stage" || operation === "publish") {
    const expected = operation === "stage" ? "draft" : "published";
    if (raw.ok ? raw.status !== expected || !raw.remoteWriteAttempted : raw.status !== undefined && raw.status !== "reconcile_required") throw new Error("effect");
    if (raw.ok && operation === "stage" && !remote?.contentDigest) throw new Error("unverified");
  } else throw new Error("operation");
  if ((operation === "publish" || operation === "sync") && input?.target) {
    const target = decodeChannelRemote(channel, input.target);
    if (!target || remote && remote.remoteId !== target.remoteId) throw new Error("target");
    if (raw.ok && (!remote || target.remoteIds && JSON.stringify(remote.remoteIds) !== JSON.stringify(target.remoteIds) || target.contentDigest && remote.contentDigest !== target.contentDigest)) throw new Error("target");
  }
  return { ok: raw.ok, code: raw.code, configured: raw.configured as ChannelBridgeResult["configured"], issues, artifacts, remoteWriteAttempted: raw.remoteWriteAttempted, reconcileRequired: raw.reconcileRequired,
    ...(raw.accountRef ? { accountRef: raw.accountRef as string } : {}), ...(raw.permission ? { permission: raw.permission as NonNullable<ChannelBridgeResult["permission"]> } : {}), ...(raw.status ? { status: raw.status as NonNullable<ChannelBridgeResult["status"]> } : {}), ...(raw.revisionDigest ? { revisionDigest: raw.revisionDigest as string } : {}), ...(raw.verifiedAt ? { verifiedAt: raw.verifiedAt as string } : {}), ...(remote ? { remote } : {}) };
}

export class ChannelBridgeAdapter implements PublishingAdapter {
  constructor(readonly channel: PublishingChannel, private readonly options: ChannelBridgeOptions) {}
  /** Account inspection has no article payload and cannot upload or publish. */
  checkAccount(signal: AbortSignal): Promise<ChannelBridgeResult> { return this.invoke("discover", undefined, true, signal); }
  supports(type: PublishingType, action: ChannelAction | "preflight"): boolean {
    if (this.channel === "zhihu" && type === "video") return false;
    if (action === "prepare" || action === "preflight") return true;
    if (this.channel === "zhihu") return type !== "video";
    if (this.channel === "xiaohongshu") return action === "stage" || type !== "article";
    return true;
  }
  private async invoke(operation: string, input: ChannelRunInput | undefined, online: boolean, signal: AbortSignal): Promise<ChannelBridgeResult> {
    if (!this.options.runner || !this.options.command) return failed("CHANNEL_BRIDGE_MISSING");
    if (signal.aborted) return failed("CHANNEL_CANCELLED");
    const write = operation === "publish" || this.channel === "zhihu" && operation === "stage";
    if (write && (!input?.authorization || input.authorization.action !== operation || !SHA256_PATTERN.test(input.authorization.inputDigest) || !input.authorization.reference || !input.expectedAccountRef)) return failed("CHANNEL_APPROVAL_REQUIRED");
    if ((operation === "sync" || operation === "publish" && this.channel === "zhihu") && !input?.target) return failed("CHANNEL_TARGET_REQUIRED");
    try {
      const result = await this.options.runner.run({ ...this.options.command, stdinText: JSON.stringify({ schemaVersion: CHANNEL_BRIDGE_SCHEMA, channel: this.channel, operation, roots: this.options.roots, network: online ? "enabled" : "disabled", ...input }) }, signal);
      if (!result.ok) return failed("CHANNEL_PROCESS_FAILED", write);
      if (result.value.cancelled || result.value.timedOut || result.value.stdoutTruncated) return failed(result.value.timedOut ? "CHANNEL_TIMEOUT" : result.value.cancelled ? "CHANNEL_CANCELLED" : "CHANNEL_OUTPUT_LIMIT", write);
      const decoded = decodeChannelResult(JSON.parse(result.value.stdout), this.channel, operation, input);
      if (result.value.exitCode !== 0 && decoded.ok) return failed("CHANNEL_EXIT_MISMATCH", write);
      return decoded;
    } catch { return failed("CHANNEL_PROTOCOL_INVALID", write); }
  }
  async discover(signal: AbortSignal): Promise<CapabilityReport> {
    const result = await this.invoke("discover", undefined, false, signal);
    const available = Boolean(this.options.command && this.options.runner) && result.ok;
    return { channel: this.channel, adapter: `${this.channel}-bridge`, adapterVersion: "1.0.0", configured: result.configured,
      actions: ADAPTER_ACTIONS.map(action => ({ action, checkedAt: this.options.now(), status: action === "draft" ? "unsupported" : !available ? "unavailable" : action === "publish" || action === "stage" && this.channel === "zhihu" ? "approval_required" : "ready", reasonCode: action === "draft" ? "USE_EXPLICIT_STAGE" : !available ? result.code : action === "publish" ? "ACCOUNT_PERMISSION_RECHECK_REQUIRED" : "CHANNEL_PROTOCOL_AVAILABLE", safeMessage: action === "draft" ? "请使用明确的渠道准备动作" : !available ? "渠道桥接尚不可用" : action === "publish" ? "执行前重新核对账号权限并申请当次批准" : "渠道入口已接通，具体类型与账号仍需预检" })) };
  }
  preflight(document: ChannelDocument, online: boolean, signal: AbortSignal, action?: ChannelAction): Promise<ChannelBridgeResult> { return this.invoke("preflight", { document, ...(action ? { action } : {}) }, online, signal); }
  run(action: ChannelAction, input: ChannelRunInput, signal: AbortSignal): Promise<ChannelBridgeResult> { return this.invoke(action, input, channelEffect(this.channel, action) !== "local_write", signal); }
}

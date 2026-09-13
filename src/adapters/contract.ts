import type {
  AdapterAction,
  AdapterResult,
  Capability,
  CapabilityReport,
  CapabilityStatus,
  GateIssue,
  GateReport,
  SideEffectLevel,
} from "../domain/capability.ts";
import { ADAPTER_ACTIONS } from "../domain/capability.ts";
import type { ArtifactRef } from "../domain/content.ts";
import { isJsonObject } from "../domain/json.ts";
import type { Channel } from "../domain/primitives.ts";
import type { ApprovedActionInput } from "../ports/adapter.ts";
import type { CommandSpec, ProcessRunner } from "../ports/process.ts";

export const ADAPTER_COMMAND_SCHEMA_VERSION = "wemedia.adapter-command/v1" as const;

export interface AdapterCommandBinding {
  executable: string;
  cwdRootId: string;
  cwdRelativePath: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface AdapterRuntime {
  processRunner: ProcessRunner;
  command: AdapterCommandBinding;
  now: () => string;
  verifyApproval?: (input: ApprovedActionInput) => boolean | Promise<boolean>;
}

export interface DecodedAdapterEnvelope {
  ok: boolean;
  code: string;
  workflow: Channel;
  operation: string;
  configured: CapabilityReport["configured"];
  capabilities: Partial<Record<AdapterAction, CapabilityStatus>>;
  artifacts: AdapterResult["artifacts"];
  issues: Array<Pick<GateIssue, "status" | "code" | "evidenceRefs">>;
  remote?: NonNullable<AdapterResult["remote"]>;
}

export type AdapterInvocation =
  | { ok: true; envelope: DecodedAdapterEnvelope }
  | { ok: false; code: string; retryable: boolean };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^(?:fnv1a64:[0-9a-f]{16}|sha256:[0-9a-f]{64})$/u;
const CAPABILITY_STATUSES: readonly CapabilityStatus[] = ["ready", "unavailable", "unsupported", "degraded", "approval_required"];
const CONFIGURED_STATUSES: readonly CapabilityReport["configured"][] = ["configured", "missing", "invalid", "unknown"];
const ISSUE_STATUSES: readonly GateIssue["status"][] = ["pass", "warn", "block"];

export function isSafeRelativePath(value: string): boolean {
  if (value === "" || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\") || value !== value.normalize("NFC")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes(":"));
}

export function isSafeArtifact(artifact: ArtifactRef): boolean {
  return TOKEN_PATTERN.test(artifact.rootId) && isSafeRelativePath(artifact.relativePath);
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value) && !value.includes("..");
}

function decodeCapabilities(value: unknown): Partial<Record<AdapterAction, CapabilityStatus>> | undefined {
  if (value === undefined) return {};
  if (!isJsonObject(value)) return undefined;
  const capabilities: Partial<Record<AdapterAction, CapabilityStatus>> = {};
  for (const [action, status] of Object.entries(value)) {
    if (!(ADAPTER_ACTIONS as readonly string[]).includes(action) || typeof status !== "string" || !(CAPABILITY_STATUSES as readonly string[]).includes(status)) return undefined;
    capabilities[action as AdapterAction] = status as CapabilityStatus;
  }
  return capabilities;
}

function decodeArtifacts(value: unknown, allowedRootIds: ReadonlySet<string>): AdapterResult["artifacts"] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const artifacts: AdapterResult["artifacts"] = [];
  for (const item of value) {
    if (!isJsonObject(item) || !isToken(item.rootId) || !allowedRootIds.has(item.rootId) || typeof item.relativePath !== "string" || !isSafeRelativePath(item.relativePath)) return undefined;
    if (item.digest !== undefined && (typeof item.digest !== "string" || !DIGEST_PATTERN.test(item.digest))) return undefined;
    artifacts.push({ rootId: item.rootId, relativePath: item.relativePath, ...(item.digest === undefined ? {} : { digest: item.digest }) });
  }
  return artifacts.sort((left, right) => `${left.rootId}:${left.relativePath}`.localeCompare(`${right.rootId}:${right.relativePath}`));
}

function decodeIssues(value: unknown): DecodedAdapterEnvelope["issues"] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const issues: DecodedAdapterEnvelope["issues"] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item.status !== "string" || !(ISSUE_STATUSES as readonly string[]).includes(item.status) || !isCode(item.code) || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.every(isToken)) return undefined;
    issues.push({ status: item.status as GateIssue["status"], code: item.code, evidenceRefs: [...item.evidenceRefs].sort() });
  }
  return issues.sort((left, right) => `${left.status}:${left.code}:${left.evidenceRefs.join("|")}`.localeCompare(`${right.status}:${right.code}:${right.evidenceRefs.join("|")}`));
}

function decodeRemote(value: unknown): NonNullable<AdapterResult["remote"]> | undefined | false {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) return false;
  const remoteId = value.remoteId;
  const url = value.url;
  if (remoteId !== undefined && (typeof remoteId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(remoteId) || remoteId.includes(".."))) return false;
  if (url !== undefined) {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
      if ([...parsed.searchParams.keys()].some((key) => /token|secret|password|cookie|authorization|api.?key/iu.test(key))) return false;
    } catch {
      return false;
    }
  }
  if (remoteId === undefined && url === undefined) return false;
  return { ...(remoteId === undefined ? {} : { remoteId }), ...(url === undefined ? {} : { url }) };
}

export function decodeAdapterEnvelope(
  text: string,
  expected: { workflow: Channel; operation: string; allowedRootIds: readonly string[] },
): AdapterInvocation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "ADAPTER_JSON_INVALID", retryable: false };
  }
  if (!isJsonObject(value) || value.schemaVersion !== ADAPTER_COMMAND_SCHEMA_VERSION) {
    return { ok: false, code: "ADAPTER_SCHEMA_UNSUPPORTED", retryable: false };
  }
  if (value.workflow !== expected.workflow || value.operation !== expected.operation || typeof value.ok !== "boolean" || !isCode(value.code)) {
    return { ok: false, code: "ADAPTER_ENVELOPE_INVALID", retryable: false };
  }
  if (typeof value.configured !== "string" || !(CONFIGURED_STATUSES as readonly string[]).includes(value.configured)) {
    return { ok: false, code: "ADAPTER_ENVELOPE_INVALID", retryable: false };
  }
  const capabilities = decodeCapabilities(value.capabilities);
  const artifacts = decodeArtifacts(value.artifacts, new Set(expected.allowedRootIds));
  const issues = decodeIssues(value.issues);
  const remote = decodeRemote(value.remote);
  if (capabilities === undefined || artifacts === undefined || issues === undefined || remote === false) {
    return { ok: false, code: "ADAPTER_ENVELOPE_INVALID", retryable: false };
  }
  return {
    ok: true,
    envelope: {
      ok: value.ok,
      code: value.code,
      workflow: expected.workflow,
      operation: expected.operation,
      configured: value.configured as CapabilityReport["configured"],
      capabilities,
      artifacts,
      issues,
      ...(remote === undefined ? {} : { remote }),
    },
  };
}

function commandSpec(binding: AdapterCommandBinding, argv: string[]): CommandSpec {
  return {
    executable: binding.executable,
    argv,
    cwdRootId: binding.cwdRootId,
    cwdRelativePath: binding.cwdRelativePath,
    env: { ...binding.env },
    timeoutMs: binding.timeoutMs,
    maxOutputBytes: binding.maxOutputBytes,
  };
}

export async function invokeAdapterCommand(
  runtime: AdapterRuntime,
  expected: { workflow: Channel; operation: string; allowedRootIds: readonly string[] },
  argv: string[],
  signal: AbortSignal,
): Promise<AdapterInvocation> {
  if (signal.aborted) return { ok: false, code: "ADAPTER_CANCELLED", retryable: false };
  let result;
  try { result = await runtime.processRunner.run(commandSpec(runtime.command, argv), signal); }
  catch { return { ok: false, code: "ADAPTER_PROCESS_UNAVAILABLE", retryable: false }; }
  if (!result.ok) return { ok: false, code: "ADAPTER_PROCESS_UNAVAILABLE", retryable: true };
  if (result.value.cancelled) return { ok: false, code: "ADAPTER_CANCELLED", retryable: true };
  if (result.value.timedOut) return { ok: false, code: "ADAPTER_TIMEOUT", retryable: true };
  if (result.value.stdoutTruncated) return { ok: false, code: "ADAPTER_OUTPUT_TRUNCATED", retryable: false };
  const decoded = decodeAdapterEnvelope(result.value.stdout, expected);
  if (result.value.exitCode !== 0 && (!decoded.ok || decoded.envelope.ok)) return { ok: false, code: "ADAPTER_COMMAND_FAILED", retryable: false };
  return decoded;
}

function safeMessage(status: GateIssue["status"]): string {
  return status === "pass" ? "adapter check passed" : status === "warn" ? "adapter check requires review" : "adapter check blocked the action";
}

export function gateReportFromInvocation(invocation: AdapterInvocation, inputDigest: string, gateId: string): GateReport {
  if (!invocation.ok) {
    const issue: GateIssue = { gateId, version: "1", status: "block", code: invocation.code, safeMessage: "adapter preflight could not complete safely", evidenceRefs: [], inputDigest };
    return { status: "block", inputDigest, issues: [issue] };
  }
  const issues = invocation.envelope.issues.map((item) => ({ gateId, version: "1", status: item.status, code: item.code, safeMessage: safeMessage(item.status), evidenceRefs: item.evidenceRefs, inputDigest }));
  if (!invocation.envelope.ok && !issues.some(({ status }) => status === "block")) {
    issues.push({ gateId, version: "1", status: "block", code: invocation.envelope.code, safeMessage: "adapter preflight reported a blocking result", evidenceRefs: [], inputDigest });
  }
  if (issues.length === 0) issues.push({ gateId, version: "1", status: "pass", code: invocation.envelope.code, safeMessage: "adapter preflight passed", evidenceRefs: [], inputDigest });
  issues.sort((left, right) => `${left.status}:${left.code}:${left.evidenceRefs.join("|")}`.localeCompare(`${right.status}:${right.code}:${right.evidenceRefs.join("|")}`));
  const status: GateReport["status"] = issues.some((item) => item.status === "block") ? "block" : issues.some((item) => item.status === "warn") ? "warn" : "pass";
  return { status, inputDigest, issues };
}

export function adapterResultFromInvocation(
  invocation: AdapterInvocation,
  input: { channel: Channel; inputDigest: string },
  phase: AdapterAction,
  sideEffect: SideEffectLevel,
  options: { requireRemoteEvidence?: boolean } = {},
): AdapterResult {
  if (!invocation.ok) return failureResult(input.channel, input.inputDigest, phase, sideEffect, invocation.code, invocation.retryable);
  const envelope = invocation.envelope;
  if (options.requireRemoteEvidence === true && envelope.ok && envelope.remote === undefined) {
    return failureResult(input.channel, input.inputDigest, phase, sideEffect, "REMOTE_EVIDENCE_MISSING", false);
  }
  const issues: GateIssue[] = envelope.issues.map((item) => ({
    gateId: `${input.channel}-${phase}`,
    version: "1",
    status: item.status,
    code: item.code,
    safeMessage: safeMessage(item.status),
    evidenceRefs: item.evidenceRefs,
    inputDigest: input.inputDigest,
  }));
  return {
    ok: envelope.ok && !issues.some(({ status }) => status === "block"),
    code: envelope.code,
    phase,
    channel: input.channel,
    sideEffect,
    artifacts: envelope.artifacts,
    issues,
    retryable: !envelope.ok,
    ...(envelope.remote === undefined ? {} : { remote: envelope.remote }),
  };
}

export function failureResult(
  channel: Channel,
  inputDigest: string,
  phase: AdapterAction,
  sideEffect: SideEffectLevel,
  code: string,
  retryable = false,
): AdapterResult {
  return {
    ok: false,
    code,
    phase,
    channel,
    sideEffect,
    artifacts: [],
    issues: [{ gateId: `${channel}-${phase}`, version: "1", status: "block", code, safeMessage: "adapter action was rejected safely", evidenceRefs: [], inputDigest }],
    retryable,
  };
}

function effectiveStatus(defaultStatus: CapabilityStatus, reported: CapabilityStatus | undefined): CapabilityStatus {
  if (defaultStatus === "unsupported") return "unsupported";
  if (reported === undefined) return defaultStatus;
  if (defaultStatus === "approval_required" && reported === "ready") return "approval_required";
  return reported;
}

export function capabilityReportFromInvocation(
  channel: Channel,
  adapter: string,
  adapterVersion: string,
  invocation: AdapterInvocation,
  defaults: Readonly<Record<AdapterAction, CapabilityStatus>>,
  checkedAt: string,
): CapabilityReport {
  const actions: Capability[] = ADAPTER_ACTIONS.map((action) => {
    const status = invocation.ok && invocation.envelope.ok && invocation.envelope.configured !== "missing" && invocation.envelope.configured !== "invalid"
      ? effectiveStatus(defaults[action], invocation.envelope.capabilities[action])
      : defaults[action] === "unsupported" ? "unsupported" : "unavailable";
    return {
      action,
      status,
      reasonCode: invocation.ok ? `${adapter.toUpperCase()}_${status.toUpperCase()}` : invocation.code,
      safeMessage: status === "ready" ? "adapter action is ready" : status === "approval_required" ? "adapter action requires explicit approval" : status === "unsupported" ? "adapter action is not supported" : "adapter action is unavailable",
      checkedAt,
    };
  });
  return {
    channel,
    adapter,
    adapterVersion,
    configured: invocation.ok ? invocation.envelope.configured : "unknown",
    actions,
  };
}

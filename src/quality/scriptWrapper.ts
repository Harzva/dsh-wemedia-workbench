import type { GateIssue } from "../domain/capability.ts";
import type { CommandSpec, ProcessRunner } from "../ports/process.ts";

export interface ScriptGateRequest {
  gateId: string;
  version: string;
  inputDigest: string;
  command: CommandSpec;
  signal: AbortSignal;
}

interface ScriptPayload {
  ok?: boolean;
  errors?: unknown[];
  warnings?: unknown[];
}

function issue(request: ScriptGateRequest, status: GateIssue["status"], code: string, safeMessage: string, refs: string[] = []): GateIssue {
  return {
    gateId: request.gateId,
    version: request.version,
    status,
    code,
    safeMessage,
    evidenceRefs: refs,
    inputDigest: request.inputDigest,
  };
}

export class LegacyQualityScriptWrapper {
  constructor(private readonly processes: ProcessRunner) {}

  async run(request: ScriptGateRequest): Promise<GateIssue[]> {
    const result = await this.processes.run(request.command, request.signal);
    if (!result.ok) return [issue(request, "block", "QUALITY_SCRIPT_UNAVAILABLE", "quality script could not be started safely")];
    if (result.value.cancelled) return [issue(request, "block", "QUALITY_SCRIPT_CANCELLED", "quality script was cancelled")];
    if (result.value.timedOut) return [issue(request, "block", "QUALITY_SCRIPT_TIMEOUT", "quality script exceeded its deadline")];
    if (result.value.exitCode !== 0) return [issue(request, "block", "QUALITY_SCRIPT_FAILED", "quality script reported a failure")];

    let payload: ScriptPayload;
    try {
      const decoded: unknown = JSON.parse(result.value.stdout);
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("not an object");
      payload = decoded as ScriptPayload;
    } catch {
      return [issue(request, "block", "QUALITY_SCRIPT_JSON_INVALID", "quality script returned an invalid JSON envelope")];
    }

    const errors = Array.isArray(payload.errors) ? payload.errors.length : 0;
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.length : 0;
    if (payload.ok === false || errors > 0) {
      return [issue(request, "block", "QUALITY_SCRIPT_BLOCKED", "quality script found blocking issues", Array.from({ length: errors }, (_, index) => `script:error:${index + 1}`))];
    }
    if (warnings > 0) {
      return [issue(request, "warn", "QUALITY_SCRIPT_WARN", "quality script found warnings", Array.from({ length: warnings }, (_, index) => `script:warning:${index + 1}`))];
    }
    return [issue(request, "pass", "QUALITY_SCRIPT_OK", "quality script checks passed")];
  }
}

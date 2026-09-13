import type { DomainResult } from "../domain/errors.ts";
import type { JsonObject } from "../domain/json.ts";

export interface CommandSpec extends JsonObject {
  executable: string;
  argv: string[];
  cwdRootId: string;
  cwdRelativePath: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Host-created bounded JSON input; never accepted directly from Tool/RPC data. */
  stdinText?: string;
}

export interface ProcessResult extends JsonObject {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderrSummary: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  terminationSkipped: boolean;
}

export interface ProcessRunner {
  run(command: CommandSpec, signal: AbortSignal): Promise<DomainResult<ProcessResult>>;
}

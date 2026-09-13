import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import type { CommandSpec, ProcessResult, ProcessRunner } from "../ports/process.ts";
import { resolveReadablePath } from "./pathPolicy.ts";
import type { RootCapability } from "./pathPolicy.ts";
import { redactText, safeErrorSummary } from "./redaction.ts";

export interface ExecutablePolicy {
  path: string;
  allowedEnvKeys: readonly string[];
}

export interface SecureProcessRunnerOptions {
  roots: readonly RootCapability[];
  executables: Readonly<Record<string, ExecutablePolicy>>;
  baseEnv?: Readonly<Record<string, string>>;
  privatePaths?: readonly string[];
  secretValues?: readonly string[];
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
  terminationGraceMs?: number;
  verifyOwnership?: (pid: number, fingerprint: string) => boolean | Promise<boolean>;
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function processFailure<T>(reasonCode: string, safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage, { details: { reasonCode } });
}

function appendCapture(capture: Capture, chunk: Buffer, maximum: number): void {
  const remaining = maximum - capture.bytes;
  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining);
    capture.chunks.push(kept);
    capture.bytes += kept.length;
  }
  if (chunk.length > Math.max(remaining, 0)) capture.truncated = true;
}

function captureText(capture: Capture): string {
  return Buffer.concat(capture.chunks).toString("utf8");
}

export class SecureProcessRunner implements ProcessRunner {
  readonly #options: SecureProcessRunnerOptions;
  readonly #owned = new Map<number, string>();

  constructor(options: SecureProcessRunnerOptions) {
    this.#options = options;
  }

  async run(command: CommandSpec, signal: AbortSignal): Promise<DomainResult<ProcessResult>> {
    const policy = this.#options.executables[command.executable];
    if (policy === undefined) return processFailure("PROCESS_EXECUTABLE_DENIED", "executable is not allowed");
    if (!policy.path.startsWith("/")) return processFailure("PROCESS_EXECUTABLE_INVALID", "executable policy is invalid");
    if (command.argv.some((argument) => argument.includes("\0"))) {
      return processFailure("PROCESS_ARGV_INVALID", "command argument contains a forbidden character");
    }
    if (command.stdinText !== undefined && Buffer.byteLength(command.stdinText, "utf8") > (this.#options.maxInputBytes ?? 512 * 1_024)) {
      return processFailure("PROCESS_INPUT_LIMIT_INVALID", "command input exceeds the allowed size");
    }

    const timeoutLimit = this.#options.maxTimeoutMs ?? 120_000;
    const outputLimit = this.#options.maxOutputBytes ?? 256 * 1_024;
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > timeoutLimit) {
      return processFailure("PROCESS_TIMEOUT_INVALID", "command timeout is outside the allowed range");
    }
    if (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1 || command.maxOutputBytes > outputLimit) {
      return processFailure("PROCESS_OUTPUT_LIMIT_INVALID", "command output limit is outside the allowed range");
    }

    const root = this.#options.roots.find((candidate) => candidate.id === command.cwdRootId);
    if (root === undefined) return processFailure("PROCESS_CWD_ROOT_UNKNOWN", "working directory root is unavailable");
    const cwd = await resolveReadablePath(root, command.cwdRelativePath);
    if (!cwd.ok || cwd.value.kind !== "directory") {
      return processFailure("PROCESS_CWD_INVALID", "working directory is unavailable");
    }

    const allowedEnv = new Set(policy.allowedEnvKeys);
    for (const [key, value] of Object.entries(command.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !allowedEnv.has(key) || value.includes("\0")) {
        return processFailure("PROCESS_ENV_DENIED", "command environment contains a denied entry");
      }
    }

    if (signal.aborted) {
      return success({
        exitCode: null,
        signal: null,
        stdout: "",
        stderrSummary: "",
        timedOut: false,
        cancelled: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        terminationSkipped: false,
      });
    }

    const stdout: Capture = { chunks: [], bytes: 0, truncated: false };
    const stderr: Capture = { chunks: [], bytes: 0, truncated: false };
    const redaction = {
      secretValues: this.#options.secretValues ?? Object.values(command.env),
      privatePaths: [...(this.#options.privatePaths ?? []), ...this.#options.roots.map((candidate) => candidate.realPath)],
      maxLength: command.maxOutputBytes,
    };

    return await new Promise<DomainResult<ProcessResult>>((resolveResult) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let terminationSkipped = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const environment = { ...(this.#options.baseEnv ?? {}), ...command.env };
      const child = spawn(policy.path, command.argv, {
        cwd: cwd.value.absolutePath,
        env: environment,
        shell: false,
        stdio: [command.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([policy.path, command.argv, cwd.value.absolutePath]))
        .digest("hex");
      if (child.pid !== undefined) this.#owned.set(child.pid, fingerprint);
      // Never log stdin. The child may exit before reading it; EPIPE is not a
      // reason to leak the request or throw outside the owned process boundary.
      child.stdin?.on("error", () => undefined);
      if (command.stdinText !== undefined) child.stdin?.end(command.stdinText, "utf8");

      child.stdout?.on("data", (chunk: Buffer) => appendCapture(stdout, chunk, command.maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer) => appendCapture(stderr, chunk, command.maxOutputBytes));

      const owns = async (): Promise<boolean> => {
        if (child.pid === undefined || this.#owned.get(child.pid) !== fingerprint) return false;
        return (await this.#options.verifyOwnership?.(child.pid, fingerprint)) ?? true;
      };

      const terminate = async (): Promise<void> => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        if (!(await owns())) {
          terminationSkipped = true;
          return;
        }
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => {
          void owns().then((owned) => {
            if (owned && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            else if (!owned) terminationSkipped = true;
          });
        }, this.#options.terminationGraceMs ?? 250);
      };

      const onAbort = (): void => {
        cancelled = true;
        void terminate();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, command.timeoutMs);

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (child.pid !== undefined) this.#owned.delete(child.pid);
        resolveResult(processFailure("PROCESS_SPAWN_FAILED", safeErrorSummary(error, redaction)));
      });

      child.once("close", (exitCode, processSignal) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (child.pid !== undefined) this.#owned.delete(child.pid);
        resolveResult(success({
          exitCode,
          signal: processSignal,
          stdout: redactText(captureText(stdout), redaction),
          stderrSummary: redactText(captureText(stderr), redaction),
          timedOut,
          cancelled,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          terminationSkipped,
        }));
      });
    });
  }
}

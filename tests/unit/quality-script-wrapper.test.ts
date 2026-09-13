import { describe, expect, it } from "vitest";

import { failure, success } from "../../src/domain/errors.ts";
import type { DomainResult } from "../../src/domain/errors.ts";
import type { CommandSpec, ProcessResult, ProcessRunner } from "../../src/ports/process.ts";
import { LegacyQualityScriptWrapper } from "../../src/quality/scriptWrapper.ts";

const command: CommandSpec = {
  executable: "quality-hook",
  argv: ["--json"],
  cwdRootId: "workspace",
  cwdRelativePath: "",
  env: {},
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
};

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ ok: true, errors: [], warnings: [] }),
    stderrSummary: "",
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    terminationSkipped: false,
    ...overrides,
  };
}

class FakeRunner implements ProcessRunner {
  constructor(private readonly response: DomainResult<ProcessResult>) {}
  async run(): Promise<DomainResult<ProcessResult>> {
    return this.response;
  }
}

async function run(response: DomainResult<ProcessResult>) {
  return new LegacyQualityScriptWrapper(new FakeRunner(response)).run({
    gateId: "legacy",
    version: "1",
    inputDigest: "fnv1a64:0000000000000001",
    command,
    signal: new AbortController().signal,
  });
}

describe("legacy quality script JSON wrapper", () => {
  it("maps valid success, warnings and errors to safe stable issues", async () => {
    expect(await run(success(result()))).toEqual([expect.objectContaining({ status: "pass", code: "QUALITY_SCRIPT_OK" })]);
    expect(await run(success(result({ stdout: JSON.stringify({ ok: true, warnings: [{ path: "/private/hidden" }] }) })))).toEqual([
      expect.objectContaining({ status: "warn", code: "QUALITY_SCRIPT_WARN", evidenceRefs: ["script:warning:1"] }),
    ]);
    const blocked = await run(success(result({ stdout: JSON.stringify({ ok: false, errors: [{ secret: "fixture-sensitive" }] }) })));
    expect(blocked).toEqual([expect.objectContaining({ status: "block", code: "QUALITY_SCRIPT_BLOCKED", evidenceRefs: ["script:error:1"] })]);
    expect(JSON.stringify(blocked)).not.toContain("fixture-sensitive");
    expect(JSON.stringify(blocked)).not.toContain("/private/hidden");
  });

  it("contains invalid JSON, start failures, nonzero exits, cancellation and timeout", async () => {
    expect(await run(success(result({ stdout: "not-json" })))).toEqual([expect.objectContaining({ code: "QUALITY_SCRIPT_JSON_INVALID" })]);
    expect(await run(failure("SCHEMA_INVALID_VALUE", "unsafe detail"))).toEqual([expect.objectContaining({ code: "QUALITY_SCRIPT_UNAVAILABLE" })]);
    expect(await run(success(result({ exitCode: 1 })))).toEqual([expect.objectContaining({ code: "QUALITY_SCRIPT_FAILED" })]);
    expect(await run(success(result({ cancelled: true })))).toEqual([expect.objectContaining({ code: "QUALITY_SCRIPT_CANCELLED" })]);
    expect(await run(success(result({ timedOut: true })))).toEqual([expect.objectContaining({ code: "QUALITY_SCRIPT_TIMEOUT" })]);
  });
});

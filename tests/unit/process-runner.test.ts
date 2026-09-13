import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandSpec } from "../../src/ports/process.ts";
import { createRootCapability } from "../../src/infrastructure/pathPolicy.ts";
import { SecureProcessRunner } from "../../src/infrastructure/processRunner.ts";

const temporaryDirectories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "wm-process-"));
  temporaryDirectories.push(directory);
  const root = await createRootCapability({ id: "workspace", label: "Workspace", path: directory, mode: "read" });
  if (!root.ok) throw new Error("fixture root unavailable");
  return { directory, root: root.value };
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function command(argv: string[], overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    executable: "node",
    argv,
    cwdRootId: "workspace",
    cwdRelativePath: "",
    env: {},
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    ...overrides,
  };
}

describe("SecureProcessRunner", () => {
  it("passes metacharacters as argv without a shell and exposes only explicit environment", async () => {
    const { directory, root } = await fixture();
    const runner = new SecureProcessRunner({ roots: [root], executables: { node: { path: process.execPath, allowedEnvKeys: ["VISIBLE"] } } });
    const literal = "$(touch should-not-exist);echo injected";
    const result = await runner.run(command(["-e", "console.log(JSON.stringify({arg:process.argv[1],visible:process.env.VISIBLE==='yes',home:process.env.HOME??null}))", literal], { env: { VISIBLE: "yes" } }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, timedOut: false, cancelled: false } });
    if (!result.ok) return;
    expect(JSON.parse(result.value.stdout)).toEqual({ arg: literal, visible: true, home: null });
    const { access } = await import("node:fs/promises");
    await expect(access(resolve(directory, "should-not-exist"))).rejects.toThrow();
  });

  it("rejects unknown executables, environment keys and working roots", async () => {
    const { root } = await fixture();
    const runner = new SecureProcessRunner({ roots: [root], executables: { node: { path: process.execPath, allowedEnvKeys: [] } } });
    expect(await runner.run(command([], { executable: "shell" }), new AbortController().signal)).toMatchObject({ ok: false, error: { details: { reasonCode: "PROCESS_EXECUTABLE_DENIED" } } });
    expect(await runner.run(command([], { env: { HOME: "denied" } }), new AbortController().signal)).toMatchObject({ ok: false, error: { details: { reasonCode: "PROCESS_ENV_DENIED" } } });
    expect(await runner.run(command([], { cwdRootId: "missing" }), new AbortController().signal)).toMatchObject({ ok: false, error: { details: { reasonCode: "PROCESS_CWD_ROOT_UNKNOWN" } } });
  });

  it("bounds and redacts stdout and stderr without leaking configured values or paths", async () => {
    const { directory, root } = await fixture();
    const runner = new SecureProcessRunner({ roots: [root], executables: { node: { path: process.execPath, allowedEnvKeys: ["PRIVATE_TOKEN"] } } });
    const result = await runner.run(command(["-e", "console.log(process.env.PRIVATE_TOKEN); console.error(process.argv[1]); console.log('x'.repeat(100))", directory], {
      env: { PRIVATE_TOKEN: "fixture-sensitive-value" },
      maxOutputBytes: 32,
    }), new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(`${result.value.stdout}${result.value.stderrSummary}`).not.toContain("fixture-sensitive-value");
    expect(`${result.value.stdout}${result.value.stderrSummary}`).not.toContain(directory);
    expect(result.value.stdoutTruncated).toBe(true);
  });

  it("reports nonzero exits as results and handles cancellation and timeout", async () => {
    const { root } = await fixture();
    const runner = new SecureProcessRunner({ roots: [root], executables: { node: { path: process.execPath, allowedEnvKeys: [] } }, terminationGraceMs: 20 });
    const failed = await runner.run(command(["-e", "process.exit(7)"]), new AbortController().signal);
    expect(failed).toMatchObject({ ok: true, value: { exitCode: 7 } });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await runner.run(command(["-e", "setInterval(()=>{},1000)"]), controller.signal);
    expect(cancelled).toMatchObject({ ok: true, value: { cancelled: true } });

    const timedOut = await runner.run(command(["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 100 }), new AbortController().signal);
    expect(timedOut).toMatchObject({ ok: true, value: { timedOut: true, signal: "SIGKILL" } });
  });

  it("skips termination when the PID fingerprint cannot be verified", async () => {
    const { root } = await fixture();
    const runner = new SecureProcessRunner({
      roots: [root],
      executables: { node: { path: process.execPath, allowedEnvKeys: [] } },
      verifyOwnership: () => false,
      terminationGraceMs: 10,
    });
    const result = await runner.run(command(["-e", "setTimeout(()=>process.exit(0),80)"], { timeoutMs: 10 }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, timedOut: true, terminationSkipped: true } });
  });
});

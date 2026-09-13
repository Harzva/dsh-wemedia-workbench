import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import type { WorkbenchJob, WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const restarted: WorkbenchService[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => {
  await Promise.all(restarted.splice(0).map(service => service.dispose()));
  await Promise.all(fixtures.splice(0).map(f => f.cleanup()));
  vi.restoreAllMocks();
});
function job(overrides: Partial<WorkbenchJob> = {}): WorkbenchJob {
  return { jobId: "job:recovery-fixture", generationId: "generation:previous", contentRef: "wmc:10000000-0000-4000-8000-000000000001", intentId: "intent:previous", inputDigest: "sha256:fixture", channel: "wechat", action: "create_draft", sideEffect: "remote_draft", status: "queued", progress: { current: 0, total: 1, unit: "operation" }, safeMessage: "任务已排队", createdAt: "2026-09-05T00:00:00.000Z", retryable: false, artifactRefs: [], ...overrides };
}
function restart(f: Awaited<ReturnType<typeof fixture>>): WorkbenchService {
  const service = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 } });
  restarted.push(service);
  return service;
}

describe("durable workbench recovery", () => {
  it.each([
    { status: "waiting_user", action: "create_draft", sideEffect: "remote_draft", expected: "cancelled" },
    { status: "queued", action: "update_draft", sideEffect: "remote_draft", expected: "cancelled" },
    { status: "running", action: "create_draft", sideEffect: "remote_draft", expected: "reconcile_required" },
    { status: "running", action: "sync", sideEffect: "read", expected: "cancelled" },
    { status: "running", action: "prepare", sideEffect: "local_write", expected: "cancelled" },
  ] as const)("recovers $status $action as $expected without dispatching", async ({ status, action, sideEffect, expected }) => {
    const f = await setup();
    const prior = job({ status, action, sideEffect, ...(status === "running" ? { startedAt: "2026-09-05T00:00:01.000Z", deadline: "2026-09-05T00:10:01.000Z" } : {}) });
    await f.jobs.save(prior);
    const run = vi.spyOn(f.adapter, "run");
    const service = restart(f);
    await service.initialize();
    expect(await service.settle(prior.jobId)).toMatchObject({ status: expected, retryable: false, finishedAt: f.now() });
    expect((await f.jobs.loadAll())[0]).toMatchObject({ status: expected, retryable: false, finishedAt: f.now() });
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps terminal records and conservatively reconciles legacy running writes without startedAt", async () => {
    const f = await setup();
    await f.jobs.save(job({ status: "running" }));
    const terminal = job({ jobId: "job:terminal", status: "succeeded", progress: { current: 1, total: 1 }, finishedAt: "2026-09-05T00:01:00.000Z", resultCode: "WECHAT_DRAFT_VERIFIED" });
    await f.jobs.save(terminal);
    const service = restart(f); await service.initialize();
    expect(await service.settle("job:recovery-fixture")).toMatchObject({ status: "reconcile_required" });
    expect(await service.settle("job:terminal")).toEqual(terminal);
    expect(f.remoteCalls()).toBe(0);
  });
});

describe("stored workbench job public DTO boundary", () => {
  it("strips unknown top-level and nested fields before snapshot and get_job", async () => {
    const f = await setup();
    const publicJob = job({ status: "succeeded", progress: { current: 1, total: 1, unit: "operation" }, startedAt: "2026-09-05T00:00:01.000Z", deadline: "2026-09-05T00:10:01.000Z", finishedAt: "2026-09-05T00:01:00.000Z", resultEventId: "event:fixture", resultCode: "WECHAT_DRAFT_VERIFIED", artifactRefs: ["write:article/index.html"] });
    await f.store.update(state => { state.extensions.wechatJobs = { [publicJob.jobId]: { ...publicJob, remoteId: "synthetic-private-remote-id", rawOutput: "synthetic-private-output", credentials: { token: "synthetic-private-token" }, progress: { ...publicJob.progress, accessFile: "synthetic-private-access-file" } } }; });
    expect(await f.jobs.loadAll()).toEqual([publicJob]);
    const service = restart(f);
    const snapshot = await service.request({ operation: "snapshot" }, { kind: "user" });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    expect((snapshot.value as WorkbenchSnapshot).jobs).toEqual([publicJob]);
    const inspected = await service.request({ operation: "get_job", jobId: publicJob.jobId }, { kind: "user" });
    expect(inspected).toMatchObject({ ok: true, value: publicJob });
    expect(JSON.stringify([snapshot, inspected])).not.toContain("synthetic-private");
  });
  it("whitelists writes too, while preserving optional public fields", async () => {
    const f = await setup();
    const publicJob = job({ progress: { current: 0 } });
    delete publicJob.channel;
    await f.jobs.save({ ...publicJob, internalState: { token: "synthetic-private-token" }, progress: { current: 0, raw: "synthetic-private-progress" } });
    expect(await f.jobs.loadAll()).toEqual([publicJob]);
    const state = await f.store.read();
    expect(state.extensions.wechatJobs).toEqual({ [publicJob.jobId]: publicJob });
  });
  it.each([
    { action: "publish" },
    { channel: "other" },
    { sideEffect: "read" },
    { progress: {} },
    { progress: { current: "0" } },
    { progress: { current: -1 } },
    { progress: { current: 2, total: 1 } },
    { progress: { current: 0, unit: {} } },
    { createdAt: "not-a-date" },
    { startedAt: "not-a-date" },
    { deadline: "not-a-date" },
    { finishedAt: 42 },
    { resultCode: { raw: "not-public" } },
    { resultEventId: [] },
    { artifactRefs: [{}] },
    { status: "unknown" },
  ])("fails closed for malformed known fields: %j", async invalid => {
    const f = await setup(); const prior = job();
    await f.store.update(state => { state.extensions.wechatJobs = { [prior.jobId]: { ...prior, ...invalid } }; });
    await expect(f.jobs.loadAll()).rejects.toMatchObject({ code: "JOBS_INVALID" });
    expect(await restart(f).request({ operation: "snapshot" }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "JOBS_INVALID", retryable: false } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("rejects mismatched storage identity instead of recovering an ambiguous job", async () => {
    const f = await setup();
    await f.store.update(state => { state.extensions.wechatJobs = { "job:different": job() }; });
    await expect(f.jobs.loadAll()).rejects.toMatchObject({ code: "JOBS_INVALID" });
  });
});

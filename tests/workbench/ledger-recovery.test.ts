import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCatalogService } from "../../src/application/workbenchCatalog.ts";
import { IdentityService } from "../../src/application/identityService.ts";
import { IndexService } from "../../src/application/indexService.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import type { LedgerEvent } from "../../src/domain/ledger.ts";
import type { JsonObject } from "../../src/domain/json.ts";
import type { ActionPreview, ArticleDocument, DraftTarget, WorkbenchAnswer, WorkbenchJob, WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import { FileIndexCacheRepository } from "../../src/infrastructure/indexCacheRepository.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { FileOverlayRepository } from "../../src/infrastructure/overlayRepository.ts";
import { scanRoots } from "../../src/infrastructure/scanner.ts";
import { FileWorkbenchDocuments, sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { FileWorkbenchJobs } from "../../src/infrastructure/workbenchJobs.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import type { WorkbenchRemoteResult } from "../../src/ports/workbench.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const services: WorkbenchService[] = [];
const agent = { kind: "agent" as const, sessionId: "fixture", callId: "fixture-call" };
const user = { kind: "user" as const };
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(fixtures.splice(0).map(f => f.cleanup()));
  vi.restoreAllMocks();
});
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }

/** Both failure switches reject the real repository's atomic rename boundary. */
function build(f: Awaited<ReturnType<typeof fixture>>) {
  const faults = { projection: false, terminalJob: false, rejectCommit: false };
  const store = new WorkbenchStore(new FileOverlayRepository(resolve(f.dataPath, "overlay.json"), { beforeRename: async () => { if (faults.rejectCommit) throw new Error("synthetic overlay commit failure"); } }));
  const ids = { uuidV4: randomUUID, opaqueId: (prefix: string) => `${prefix}:${randomUUID()}` };
  const catalog = new WorkbenchCatalogService(new IndexService({ scan: () => scanRoots(f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })), { maxFileBytes: 1024 * 1024 }) }, new FileIndexCacheRepository(resolve(f.dataPath, "recovery-index.json"))), new IdentityService(ids), "ledger-fixture", f.now);
  class FaultDocuments extends FileWorkbenchDocuments {
    override async persistRemoteResult(document: ArticleDocument, result: WorkbenchRemoteResult, target: DraftTarget | null): Promise<void> {
      faults.rejectCommit = faults.projection;
      try { await super.persistRemoteResult(document, result, target); }
      finally { faults.rejectCommit = false; }
    }
  }
  class FaultJobs extends FileWorkbenchJobs {
    override async save(job: WorkbenchJob): Promise<void> {
      faults.rejectCommit = faults.terminalJob && !["queued", "waiting_user", "running"].includes(job.status);
      try { await super.save(job); }
      finally { faults.rejectCommit = false; }
    }
  }
  const documents = new FaultDocuments({ roots: f.roots, writeRoot: f.roots[1]!, store, catalog, now: f.now, settings: f.documents.settings() });
  const jobs = new FaultJobs(store);
  const ledgerPath = resolve(f.dataPath, "ledger.jsonl");
  const ledger = new FileLedgerRepository(ledgerPath);
  const service = new WorkbenchService({ documents, jobs, ledger, adapter: f.adapter, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids, hasher: { digest: sha256 } });
  services.push(service);
  return { f, faults, store, documents, jobs, ledger, ledgerPath, service };
}
async function setup() {
  const f = await fixture(); fixtures.push(f);
  const document = await f.create(); await f.reviewAll(document);
  const h = build(f); await h.service.initialize();
  return { ...h, document };
}
async function execute(h: ReturnType<typeof build>, document: ArticleDocument, action: "create_draft" | "update_draft" | "sync" = "create_draft", target?: DraftTarget) {
  const preview = value<ActionPreview>(await h.service.request({ operation: "preview_action", contentRef: document.contentRef, action, ...(target ? { targetRef: target.targetRef } : {}) }, agent));
  const started = value<WorkbenchJob>(await h.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));
  return h.service.settle(started.jobId);
}
async function event(h: ReturnType<typeof build>, job: WorkbenchJob): Promise<LedgerEvent> {
  const found = await h.ledger.findByEventKey(sha256(`${job.intentId}:${job.inputDigest}`));
  if (!found.ok || !found.value) throw new Error("fixture ledger event missing");
  return found.value;
}

describe("ledger-first workbench result recovery", () => {
  it.each(["projection", "terminalJob"] as const)("recovers a real %s commit failure without calling the remote adapter again", async fault => {
    const h = await setup(); h.faults[fault] = true;
    const job = await execute(h, h.document);
    expect(job.status).toBe("reconcile_required");
    expect(h.f.remoteCalls()).toBe(1);
    const proof = await event(h, job);
    expect(proof.artifactDigests).toContain(sha256(h.document.html));
    expect(proof.artifactDigests).not.toContain(job.inputDigest);
    const binding = proof.remote!.workbenchRecovery as JsonObject;
    expect(binding).toMatchObject({ schemaVersion: "wemedia.workbench-result/v1", revisionDigest: h.document.revisionDigest, originalTargetRef: null, status: "succeeded" });
    const before = (await h.jobs.loadAll()).find(item => item.jobId === job.jobId)!;
    expect(before.status).toBe(fault === "projection" ? "reconcile_required" : "running");
    if (fault === "terminalJob") expect(before.resultEventId).toBeUndefined();
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "succeeded", resultEventId: proof.eventId, resultCode: "WECHAT_DRAFT_VERIFIED", retryable: false });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([expect.objectContaining({ targetRef: binding.targetRef, verifiedRevision: h.document.revisionDigest })]);
    expect(run).not.toHaveBeenCalled();
    await reloaded.service.dispose();
    const twice = build(h.f); await twice.service.initialize();
    expect((await twice.documents.read(h.document.contentRef)).targets).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("restores the original update target instead of creating a second binding", async () => {
    const h = await setup();
    await h.documents.persistRemoteResult(h.document, { ok: true, code: "FIXTURE_BOUND", phase: "draft", channel: "wechat", sideEffect: "remote_draft", artifacts: [], issues: [], retryable: false, remote: { remoteId: "FixtureExistingMediaID" }, revisionDigest: h.document.revisionDigest, verifiedAt: h.f.now() }, null);
    const target = (await h.documents.read(h.document.contentRef)).targets[0]!;
    h.faults.projection = true;
    const job = await execute(h, h.document, "update_draft", target);
    const proof = await event(h, job);
    expect(proof.remote!.workbenchRecovery).toMatchObject({ originalTargetRef: target.targetRef, targetRef: target.targetRef });
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([expect.objectContaining({ targetRef: target.targetRef, verifiedRevision: h.document.revisionDigest })]);
    expect(await reloaded.documents.privateRemoteState(h.document.contentRef, target)).toMatchObject({ target: { mediaId: "FixtureMediaID" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves a committed unconfirmed update and its later successful sync across two restarts", async () => {
    const h = await setup();
    expect((await execute(h, h.document)).status).toBe("succeeded");
    const target = (await h.documents.read(h.document.contentRef)).targets[0]!;
    const original = h.f.adapter.run.bind(h.f.adapter);
    const run = vi.spyOn(h.f.adapter, "run").mockImplementationOnce(async (...args) => {
      const result = await original(...args); delete result.verifiedAt;
      return { ...result, ok: false, code: "WECHAT_READBACK_MISMATCH", reconcileRequired: true };
    });
    const unconfirmed = await execute(h, h.document, "update_draft", target);
    const proof = await event(h, unconfirmed);
    expect(unconfirmed).toMatchObject({ status: "reconcile_required", resultCode: "WECHAT_READBACK_MISMATCH", resultEventId: proof.eventId });
    expect(proof.remote!.workbenchRecovery).toMatchObject({ status: "reconcile_required", targetRef: target.targetRef });
    expect((await h.jobs.loadAll()).find(job => job.jobId === unconfirmed.jobId)).toEqual(unconfirmed);
    const pendingTarget = (await h.documents.read(h.document.contentRef)).targets[0]!;
    expect(pendingTarget.verifiedRevision).toBe("");
    h.f.setTime("2026-09-06T00:01:00.000Z");
    const synced = await execute(h, h.document, "sync", pendingTarget);
    expect(synced).toMatchObject({ status: "succeeded", resultCode: "WECHAT_DRAFT_VERIFIED" });
    const verifiedTarget = (await h.documents.read(h.document.contentRef)).targets[0]!;
    expect(verifiedTarget).toMatchObject({ targetRef: target.targetRef, verifiedRevision: h.document.revisionDigest, verifiedAt: h.f.now() });
    await h.service.dispose(); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(unconfirmed.jobId)).toEqual(unconfirmed);
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([verifiedTarget]);
    expect(value<WorkbenchSnapshot>(await reloaded.service.request({ operation: "snapshot" }, user)).settings.issues).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await reloaded.service.dispose();
    const twice = build(h.f); await twice.service.initialize();
    expect(await twice.service.settle(unconfirmed.jobId)).toEqual(unconfirmed);
    expect((await twice.documents.read(h.document.contentRef)).targets).toEqual([verifiedTarget]);
    expect(value<WorkbenchSnapshot>(await twice.service.request({ operation: "snapshot" }, user)).settings.issues).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    h.f.setTime("2026-09-06T00:02:00.000Z");
    expect((await execute(twice, h.document, "update_draft", verifiedTarget)).status).toBe("succeeded");
    expect(run).toHaveBeenCalledOnce();
  });
  it("recovers an unconfirmed result when a projection failure changed its terminal result code", async () => {
    const h = await setup(); h.faults.projection = true;
    const original = h.f.adapter.run.bind(h.f.adapter);
    const run = vi.spyOn(h.f.adapter, "run").mockImplementationOnce(async (...args) => {
      const result = await original(...args); delete result.verifiedAt;
      return { ...result, ok: false, code: "WECHAT_READBACK_MISMATCH", reconcileRequired: true };
    });
    const job = await execute(h, h.document);
    const proof = await event(h, job);
    expect(job).toMatchObject({ status: "reconcile_required", resultCode: "STORAGE_CONFLICT", resultEventId: proof.eventId });
    expect(proof.remote!.workbenchRecovery).toMatchObject({ status: "reconcile_required" });
    expect((await h.documents.read(h.document.contentRef)).targets).toEqual([]);
    await h.service.dispose(); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "WECHAT_READBACK_MISMATCH", resultEventId: proof.eventId });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([expect.objectContaining({ targetRef: (proof.remote!.workbenchRecovery as JsonObject).targetRef, verifiedRevision: "", verifiedAt: "" })]);
    expect(run).not.toHaveBeenCalled();
  });
  it("retains an old-version target but does not verify the current article revision", async () => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document);
    const changed = await h.documents.saveRevision(h.document.contentRef, h.document.revisionDigest, { metadata: { ...h.document.metadata, title: "Later article revision" }, html: "<p>Later independently saved article.</p>", markdown: "Later independently saved article." });
    expect(changed.revisionDigest).not.toBe(h.document.revisionDigest);
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    const recovered = await reloaded.documents.read(h.document.contentRef);
    expect(recovered.revisionDigest).toBe(changed.revisionDigest);
    expect(recovered.targets).toEqual([expect.objectContaining({ title: h.document.metadata.title, verifiedRevision: "", verifiedAt: "" })]);
    expect((await reloaded.documents.list()).find(item => item.contentRef === h.document.contentRef)?.status).toBe("needs_revalidation");
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "succeeded", resultCode: "LEDGER_RESULT_NEEDS_REVALIDATION" });
    expect(run).not.toHaveBeenCalled();
  });
  it("leaves an unproven remote result in reconciliation and never retries it", async () => {
    const h = await setup();
    vi.spyOn(h.ledger, "append").mockRejectedValueOnce(new Error("synthetic ledger unavailable"));
    const job = await execute(h, h.document);
    expect(job.status).toBe("reconcile_required");
    expect((await h.documents.read(h.document.contentRef)).targets).toEqual([]);
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", retryable: false });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not guess a target from legacy ledger records without the recovery schema", async () => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document); const proof = await event(h, job);
    delete proof.remote!.workbenchRecovery;
    await writeFile(h.ledgerPath, `${JSON.stringify(proof)}\n`);
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required" });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it("fails closed on damaged ledger data even if the lookup can still find a valid event", async () => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document);
    await appendFile(h.ledgerPath, "{damaged-tail");
    expect((await h.ledger.findByEventKey(sha256(`${job.intentId}:${job.inputDigest}`))).ok).toBe(true);
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f);
    await expect(reloaded.service.initialize()).resolves.toBeUndefined();
    const snapshot = value<WorkbenchSnapshot>(await reloaded.service.request({ operation: "snapshot" }, user));
    expect(snapshot.settings.issues.join(" ")).toContain("账本");
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required" });
    const preview = value<ActionPreview>(await reloaded.service.request({ operation: "preview_action", contentRef: h.document.contentRef, action: "create_draft" }, agent));
    expect(await reloaded.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "LEDGER_RECOVERY_BLOCKED" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps recovery commit failures local to the workbench and readable in snapshot", async () => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document); await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); reloaded.faults.projection = true;
    await expect(reloaded.service.initialize()).resolves.toBeUndefined();
    const snapshot = value<WorkbenchSnapshot>(await reloaded.service.request({ operation: "snapshot" }, user));
    expect(snapshot.settings.issues.length).toBeGreaterThan(0);
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", retryable: false });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not bind an old account's remote ID to a different current account", async () => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document); await h.service.dispose();
    h.f.setAccount(`wechat-account:${"b".repeat(32)}`);
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LEDGER_ACCOUNT_CHANGED" });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { revisionDigest: "not-a-revision" },
    { originalTargetRef: "target:forged" },
    { inputDigest: `sha256:${"a".repeat(64)}` },
    { title: "x".repeat(201) },
    { title: "Not the approved article title" },
    { schemaVersion: "wemedia.workbench-result/v99" },
    { rawOutput: "synthetic-private-value" },
  ])("rejects malformed or unknown recovery fields: %j", async invalid => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document); const proof = await event(h, job);
    proof.remote!.workbenchRecovery = { ...(proof.remote!.workbenchRecovery as JsonObject), ...invalid };
    await writeFile(h.ledgerPath, `${JSON.stringify(proof)}\n`);
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    const snapshot = await reloaded.service.request({ operation: "snapshot" }, user);
    expect(snapshot.ok).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-value");
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LEDGER_RECOVERY_INVALID" });
    expect((await reloaded.documents.read(h.document.contentRef)).targets).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it("writes only the private recovery whitelist, never arbitrary adapter data", async () => {
    const h = await setup();
    const original = h.f.adapter.run.bind(h.f.adapter);
    vi.spyOn(h.f.adapter, "run").mockImplementation(async (...args) => {
      const result = await original(...args);
      return { ...result, runtime: { marker: "synthetic-private-runtime" }, remote: { ...result.remote, credentials: "synthetic-private-credentials" } };
    });
    const job = await execute(h, h.document);
    expect(job.status).toBe("succeeded");
    expect(await readFile(h.ledgerPath, "utf8")).not.toContain("synthetic-private");
    const proof = await event(h, job);
    expect(Object.keys(proof.remote!).sort()).toEqual(["remoteId", "revisionDigest", "uploads", "verifiedAt", "workbenchRecovery"]);
    expect(proof.artifactDigests).not.toContain(job.inputDigest);
  });
  it("does not overwrite a target that has a later ledger result", async () => {
    const h = await setup(); h.faults.terminalJob = true;
    const olderJob = await execute(h, h.document);
    const target = (await h.documents.read(h.document.contentRef)).targets[0]!;
    h.faults.terminalJob = false;
    h.f.setTime("2026-09-06T00:01:00.000Z");
    const original = h.f.adapter.run.bind(h.f.adapter);
    vi.spyOn(h.f.adapter, "run").mockImplementation(async (...args) => ({ ...await original(...args), remote: { remoteId: "FixtureLaterMediaID" } }));
    const laterJob = await execute(h, h.document, "update_draft", target);
    expect(laterJob.status).toBe("succeeded");
    await h.service.dispose();
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    const reloaded = build(h.f); await reloaded.service.initialize();
    expect(await reloaded.service.settle(olderJob.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LEDGER_TARGET_CHANGED" });
    await expect(reloaded.documents.privateRemoteState(h.document.contentRef, target)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    const currentTarget = (await reloaded.documents.read(h.document.contentRef)).targets.find(value => value.targetRef === target.targetRef)!;
    expect(await reloaded.documents.privateRemoteState(h.document.contentRef, currentTarget)).toMatchObject({ target: { mediaId: "FixtureLaterMediaID" } });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["readAll", "findByEventKey"] as const)("contains a thrown %s failure within workbench diagnostics", async method => {
    const h = await setup(); h.faults.projection = true;
    const job = await execute(h, h.document); await h.service.dispose();
    const reloaded = build(h.f);
    if (method === "readAll") vi.spyOn(reloaded.ledger, "readAll").mockImplementation(async function* () { throw new Error("synthetic private ledger failure"); });
    else vi.spyOn(reloaded.ledger, "findByEventKey").mockRejectedValue(new Error("synthetic private ledger failure"));
    const run = vi.spyOn(h.f.adapter, "run"); run.mockClear();
    await expect(reloaded.service.initialize()).resolves.toBeUndefined();
    const snapshot = value<WorkbenchSnapshot>(await reloaded.service.request({ operation: "snapshot" }, user));
    expect(snapshot.settings.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic private ledger failure");
    expect(await reloaded.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required" });
    expect(run).not.toHaveBeenCalled();
  });
});

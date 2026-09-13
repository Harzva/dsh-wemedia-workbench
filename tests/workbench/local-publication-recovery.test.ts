import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture } from "./fixture.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { FilePublicationDrafts } from "../../src/infrastructure/publicationDrafts.ts";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { PublicationDraftPreview } from "../../src/domain/publicationDraft.ts";
import { WorkbenchFault } from "../../src/domain/workbench.ts";
import type { WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import type { LedgerEvent } from "../../src/domain/ledger.ts";
import { testPng } from "../fixtures/png.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const user = { kind: "user" as const };
const signal = () => new AbortController().signal;
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }

async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })) });
  const drafts = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library, now: f.now });
  const ledgerPath = resolve(f.dataPath, "local-publication-ledger.jsonl");
  const ledger = new FileLedgerRepository(ledgerPath);
  const createService = () => {
    const service = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, publicationDrafts: drafts, library, ledger, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => 0 }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 } });
    cleanups.push(() => service.dispose()); return service;
  };
  const service = createService();
  const preview = async () => value<PublicationDraftPreview>(await service.request({ operation: "create_publication", publicationType: "image_text", title: "Durable local draft" }, user));
  const start = async (draftPreview: PublicationDraftPreview) => {
    const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: draftPreview.intent.intentId }, user));
    return service.settle(job.jobId);
  };
  const restart = async () => { await service.dispose(); const next = createService(); await next.initialize(); return next; };
  const job = async (next: WorkbenchService, id: string) => value<WorkbenchJob>(await next.request({ operation: "get_job", jobId: id }, user));
  const events = async () => { const result = await ledger.snapshot(); if (!result.ok) throw new Error("fixture ledger unreadable"); return result.value.events; };
  return { ...f, library, drafts, ledger, ledgerPath, service, preview, start, restart, job, events, createService };
}

describe("local media publication ledger recovery", () => {
  it.each(["create", "save"] as const)("recovers %s after terminal Job storage fails, without copying media or repeating the save", async action => {
    const f = await setup(); let p = await f.preview();
    if (action === "save") {
      await f.start(p); const original = await f.drafts.read(p.intent.contentRef);
      p = value<PublicationDraftPreview>(await f.service.request({ operation: "preview_publication_save", contentRef: original.contentRef, expectedRevision: original.revisionDigest, edit: { ...publicationEdit(original), title: "New local revision" } }, user));
    }
    const commit = vi.spyOn(f.drafts, "commit");
    const save = f.jobs.save.bind(f.jobs); let injected = false;
    vi.spyOn(f.jobs, "save").mockImplementation(async job => { if (job.status === "succeeded" && !injected) { injected = true; throw new Error("synthetic terminal storage failure"); } await save(job); });
    const terminal = await f.start(p);
    expect(terminal).toMatchObject({ status: "reconcile_required", retryable: false, resultCode: "LOCAL_RESULT_NEEDS_RECONCILIATION" });
    expect(terminal.safeMessage).toContain("本地保存结果待核对"); expect(terminal.safeMessage).not.toContain("远端");
    expect((await f.events()).find(event => event.jobId === terminal.jobId)).toMatchObject({ outcome: "succeeded", remote: { localPublicationRecovery: { revisionDigest: p.publication.revisionDigest, inputDigest: terminal.inputDigest, intentId: terminal.intentId } } });
    expect(await f.drafts.read(p.intent.contentRef)).toMatchObject({ revisionDigest: p.publication.revisionDigest });
    const folders = await readdir(f.writePath);
    const next = await f.restart();
    expect(await f.job(next, terminal.jobId)).toMatchObject({ status: "succeeded", resultCode: "LOCAL_ACTION_COMPLETED", artifactRefs: [p.intent.contentRef], resultEventId: terminal.resultEventId });
    const again = await f.restart(); expect((await f.job(again, terminal.jobId)).status).toBe("succeeded");
    expect(await readdir(f.writePath)).toEqual(folders); expect(commit).toHaveBeenCalledTimes(1); expect(f.remoteCalls()).toBe(0);
  });

  it("recovers a durable running Job when both terminal and uncertainty writes failed", async () => {
    const f = await setup(), p = await f.preview(), save = f.jobs.save.bind(f.jobs);
    const failure = vi.spyOn(f.jobs, "save").mockImplementation(async job => { if (["succeeded", "reconcile_required"].includes(job.status)) throw new Error("synthetic repeated storage failure"); await save(job); });
    const terminal = await f.start(p); expect(terminal.status).toBe("reconcile_required");
    expect((await f.jobs.loadAll()).find(job => job.jobId === terminal.jobId)?.status).toBe("running");
    failure.mockRestore();
    expect((await f.job(await f.restart(), terminal.jobId)).status).toBe("succeeded"); expect(f.remoteCalls()).toBe(0);
  });

  it("recovers a success append whose acknowledgement was lost before the Job acquired its event ID", async () => {
    const f = await setup(), p = await f.preview(), append = f.ledger.append.bind(f.ledger);
    vi.spyOn(f.ledger, "append").mockImplementationOnce(async event => { await append(event); throw new Error("synthetic lost ledger acknowledgement"); });
    const terminal = await f.start(p);
    expect(terminal).toMatchObject({ status: "reconcile_required" }); expect(terminal.resultEventId).toBeUndefined();
    const commit = vi.spyOn(f.drafts, "commit");
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "succeeded", resultEventId: (await f.events())[0]!.eventId });
    expect(commit).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });

  it("reconciles previously misclassified failed Jobs only when their exact successful proof remains verifiable", async () => {
    const f = await setup(), p = await f.preview();
    const terminal = await f.start(p);
    await f.jobs.save({ ...terminal, status: "failed", resultCode: "ACTION_FAILED", safeMessage: "Previous version misclassified a storage error" });
    const commit = vi.spyOn(f.drafts, "commit");
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "succeeded", resultEventId: terminal.resultEventId, resultCode: "LOCAL_ACTION_COMPLETED" });
    expect(commit).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });

  it("does not claim cancellation rolled back a media commit that already updated the current pointer", async () => {
    const f = await setup(), p = await f.preview(), commit = f.drafts.commit.bind(f.drafts);
    let didCommit!: () => void;
    const committed = new Promise<void>(resolve => { didCommit = resolve; });
    vi.spyOn(f.drafts, "commit").mockImplementationOnce(async (plan, abort, assertCurrent) => {
      await commit(plan, abort, assertCurrent);
      await new Promise<void>(resolve => { abort.addEventListener("abort", () => resolve(), { once: true }); didCommit(); });
      throw new WorkbenchFault("REQUEST_CANCELLED", "Synthetic post-commit cancellation");
    });
    const queued = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: p.intent.intentId }, user));
    await committed; await f.service.request({ operation: "cancel_job", jobId: queued.jobId }, user);
    const terminal = await f.service.settle(queued.jobId);
    expect(terminal).toMatchObject({ status: "reconcile_required", retryable: false });
    expect(await f.drafts.read(p.intent.contentRef)).toMatchObject({ revisionDigest: p.publication.revisionDigest });
    expect(await f.events()).toEqual([]);
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LOCAL_RESULT_UNVERIFIED" });
    expect(f.drafts.commit).toHaveBeenCalledTimes(1); expect(f.remoteCalls()).toBe(0);
  });

  it("retains an explicit unresolved local result when no unambiguous successful ledger proof exists", async () => {
    const f = await setup(), p = await f.preview();
    vi.spyOn(f.ledger, "append").mockRejectedValueOnce(new Error("synthetic ledger failure"));
    const terminal = await f.start(p);
    expect(terminal.status).toBe("reconcile_required");
    expect(await f.drafts.read(p.intent.contentRef)).toMatchObject({ title: "Durable local draft" });
    expect(await f.events()).toEqual([]);
    const commit = vi.spyOn(f.drafts, "commit");
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LOCAL_RESULT_UNVERIFIED", retryable: false });
    expect(commit).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });

  it("does not replace a newer current revision to complete an older pending Job", async () => {
    const f = await setup(), p = await f.preview(), save = f.jobs.save.bind(f.jobs);
    const failure = vi.spyOn(f.jobs, "save").mockImplementation(async job => { if (job.status === "succeeded") throw new Error("synthetic terminal failure"); await save(job); });
    const terminal = await f.start(p); failure.mockRestore();
    const original = await f.drafts.read(p.intent.contentRef);
    const edited = await f.drafts.plan(original.contentRef, original.publicationType, original.revisionDigest, { ...publicationEdit(original), title: "Later independent revision" }, signal());
    await f.drafts.commit(edited, signal(), () => {});
    const commit = vi.spyOn(f.drafts, "commit");
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LOCAL_RESULT_REVISION_CHANGED" });
    expect(await f.drafts.read(original.contentRef)).toMatchObject({ title: "Later independent revision" }); expect(commit).not.toHaveBeenCalled();
  });

  it("rehashes the saved media rather than accepting the manifest's claimed digest", async () => {
    const f = await setup(), p = await f.preview(); await f.start(p);
    await writeFile(resolve(f.sourcePath, "photo.png"), testPng());
    const picture = (await f.library.list({ kind: "image" })).items[0]!;
    const original = await f.drafts.read(p.intent.contentRef);
    const updated = value<PublicationDraftPreview>(await f.service.request({ operation: "preview_publication_save", contentRef: original.contentRef, expectedRevision: original.revisionDigest, edit: { ...publicationEdit(original), body: "Saved picture", media: [{ source: "library", itemId: picture.itemId, revisionDigest: picture.revisionDigest, caption: "Caption" }] } }, user));
    const save = f.jobs.save.bind(f.jobs);
    const failure = vi.spyOn(f.jobs, "save").mockImplementation(async job => { if (job.status === "succeeded") throw new Error("synthetic terminal failure"); await save(job); });
    const terminal = await f.start(updated); failure.mockRestore();
    const state = await f.store.read(); const pointers = state.extensions.publicationDrafts as Record<string, { folder: string }>;
    const assetDirectory = resolve(f.writePath, pointers[original.contentRef]!.folder, "assets");
    const assetPath = resolve(assetDirectory, (await readdir(assetDirectory))[0]!);
    const bytes = await readFile(assetPath); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(assetPath, bytes);
    expect((await f.drafts.read(original.contentRef)).revisionDigest).toBe(updated.publication.revisionDigest);
    expect(await f.job(await f.restart(), terminal.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "PUBLICATION_MEDIA_CHANGED" }); expect(f.remoteCalls()).toBe(0);
  });

  it.each(["intent", "revision", "media", "unknown-field", "legacy"] as const)("does not trust %s corruption or legacy success without a recovery binding", async damage => {
    const f = await setup(), p = await f.preview(), save = f.jobs.save.bind(f.jobs);
    const failure = vi.spyOn(f.jobs, "save").mockImplementation(async job => { if (job.status === "succeeded") throw new Error("synthetic terminal failure"); await save(job); });
    const terminal = await f.start(p); failure.mockRestore();
    const proof = (await f.events())[0]! as LedgerEvent;
    const binding = proof.remote!.localPublicationRecovery as Record<string, unknown>;
    if (damage === "intent") binding.intentId = "intent:other";
    if (damage === "revision") binding.revisionDigest = `sha256:${"b".repeat(64)}`;
    if (damage === "media") proof.artifactDigests = [...proof.artifactDigests!, `sha256:${"b".repeat(64)}`];
    if (damage === "unknown-field") binding.privatePath = "PRIVATE_RECOVERY_MARKER";
    if (damage === "legacy") delete proof.remote;
    await writeFile(f.ledgerPath, `${JSON.stringify(proof)}\n`);
    const recovered = await f.job(await f.restart(), terminal.jobId);
    expect(recovered.status).toBe("reconcile_required"); expect(JSON.stringify(recovered)).not.toContain("PRIVATE_RECOVERY_MARKER");
    expect(await f.drafts.read(p.intent.contentRef)).toMatchObject({ revisionDigest: p.publication.revisionDigest }); expect(f.remoteCalls()).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { DraftBatchService } from "../../src/application/draftBatchService.ts";
import { decodeDraftBatchRequest, type DraftBatch, type DraftBatchEntry, type DraftBatchPreview } from "../../src/domain/draftBatch.ts";
import type { JsonObject } from "../../src/domain/json.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import type { OverlayV1 } from "../../src/domain/schema.ts";
import type { ActionPreview, ArticleDocument, WorkbenchCaller, WorkbenchJob } from "../../src/domain/workbench.ts";
import { WorkbenchFault } from "../../src/domain/workbenchFault.ts";
import type { WorkbenchStateStore } from "../../src/ports/repositories.ts";

const agent: WorkbenchCaller = { kind: "agent", sessionId: "session:owner" };
const user: WorkbenchCaller = { kind: "user" };
const signal = (): AbortSignal => new AbortController().signal;
const ref = (id: number): ContentRef => `wmc:00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
function candidate(id: number, status: DraftBatchEntry["status"] = "pending"): DraftBatchEntry {
  return { contentRef: ref(id), title: `Article ${id}`, revisionDigest: `revision:${id}`, inputDigest: `input:${id}`, status, code: "READY", safeMessage: "Ready", jobId: null, intentId: null, targetRef: null };
}
function fixture(entries = [candidate(1), candidate(2)]) {
  let overlay: OverlayV1 = { schemaVersion: "wemedia.overlay/v1", revision: 0, contentBindings: {}, manualDecisions: [], variantState: {}, jobs: {}, extensions: {} };
  let now = Date.parse("2026-09-13T00:00:00Z");
  let counter = 0;
  let saves = 0;
  let failSave = -1;
  let failAfterCommit = -1;
  const jobs: WorkbenchJob[] = [];
  const documents = new Map(entries.map(item => [item.contentRef, { contentRef: item.contentRef, revisionDigest: item.revisionDigest!, targets: [] } as unknown as ArticleDocument]));
  const previews = new Map<string, ActionPreview>();
  const store: WorkbenchStateStore = {
    read: async () => structuredClone(overlay),
    update: async change => {
      if (++saves === failSave) throw new Error("Synthetic persistence failure");
      const next = structuredClone(overlay);
      const result = await change(next);
      overlay = next;
      if (saves === failAfterCommit) throw new Error("Synthetic response failure after commit");
      return result;
    },
  };
  const candidates = vi.fn(async () => structuredClone(entries));
  const preview = vi.fn(async (item: DraftBatchEntry): Promise<ActionPreview> => {
    const value: ActionPreview = { action: "create_draft", intent: { intentId: `intent:${++counter}`, generationId: "generation:one", contentRef: item.contentRef, action: "create_draft", sideEffect: "remote_draft", targetSummary: "Draft only", inputDigest: item.inputDigest!, artifactDigest: item.revisionDigest!, expectedChanges: [], blockingGateCodes: [], expiresAt: new Date(now + 600_000).toISOString(), approved: false }, gates: { inputDigest: item.inputDigest!, status: "pass", issues: [] }, target: null, summary: [] };
    previews.set(value.intent.intentId, value);
    return value;
  });
  const start = vi.fn(async (intentId: string, _caller: WorkbenchCaller, _signal: AbortSignal): Promise<WorkbenchJob> => {
    const value = previews.get(intentId)!;
    const job: WorkbenchJob = { jobId: `job:${++counter}`, generationId: "generation:one", action: "create_draft", sideEffect: "remote_draft", status: "running", progress: { current: 0 }, safeMessage: "Running", createdAt: new Date(now).toISOString(), retryable: false, artifactRefs: [], contentRef: value.intent.contentRef, intentId, inputDigest: value.intent.inputDigest };
    jobs.push(job);
    return job;
  });
  const cancelJob = vi.fn(async (id: string) => {
    const job = jobs.find(value => value.jobId === id)!;
    job.status = "cancelled";
    return job;
  });
  const inspect = vi.fn(async (contentRef: ContentRef) => structuredClone(documents.get(contentRef)!));
  const options = { generationId: "generation:one", store, clock: { nowIso: () => new Date(now).toISOString(), monotonicMs: () => now }, ids: { uuidV4: () => "00000000-0000-4000-8000-000000000099", opaqueId: (prefix: string) => `${prefix}:${++counter}` }, candidates, preview, start, jobs: () => jobs, cancelJob, inspect };
  const service = new DraftBatchService(options);
  const requestPreview = async () => await service.request({ operation: "preview_draft_batch", scope: "pending" }, user, signal()) as DraftBatchPreview;
  const requestStart = async () => {
    const value = await requestPreview();
    return await service.request({ operation: "start_draft_batch", intentId: value.intentId }, agent, signal()) as DraftBatch;
  };
  const advance = async (batchId: string) => await service.request({ operation: "advance_draft_batch", batchId }, agent, signal()) as DraftBatch;
  const get = async (batchId: string) => await service.request({ operation: "get_draft_batch", batchId }, user, signal()) as DraftBatch;
  const succeed = (index = 0) => {
    const job = jobs[index]!;
    job.status = "succeeded"; job.resultCode = "WECHAT_DRAFT_VERIFIED";
    documents.get(job.contentRef)!.targets = [{ targetRef: `target:${index}`, label: "Wechat", title: "Verified", sourceUrl: "", verifiedRevision: entries.find(item => item.contentRef === job.contentRef)!.revisionDigest!, verifiedAt: new Date(now).toISOString() }];
  };
  return { service, options, jobs, documents, candidates, preview, start, cancelJob, inspect, requestPreview, requestStart, advance, get, succeed, state: () => structuredClone(overlay), setState: (value: OverlayV1) => { overlay = structuredClone(value); }, failNextSave: () => { failSave = saves + 1; }, failNextResponseAfterCommit: () => { failAfterCommit = saves + 1; }, failSaveAfter: (count: number) => { failSave = saves + count; }, elapse: (milliseconds: number) => { now += milliseconds; } };
}

describe("draft batch requests", () => {
  it("rejects malformed, duplicated, oversized and injected requests", () => {
    expect(decodeDraftBatchRequest({ operation: "preview_draft_batch", scope: "selected", contentRefs: [ref(1)] })).toEqual({ operation: "preview_draft_batch", scope: "selected", contentRefs: [ref(1)] });
    for (const input of [
      { operation: "preview_draft_batch", scope: "selected", contentRefs: [] },
      { operation: "preview_draft_batch", scope: "selected", contentRefs: [ref(1), ref(1)] },
      { operation: "preview_draft_batch", scope: "selected", contentRefs: ["wmc:invalid"] },
      { operation: "preview_draft_batch", scope: "selected", contentRefs: Array.from({ length: 51 }, (_, index) => ref(index)) },
      { operation: "preview_draft_batch", scope: "pending", contentRefs: [] },
      { operation: "start_draft_batch", intentId: "batchintent:1", ownerSessionId: "spoofed" },
      { operation: "get_draft_batch", batchId: "../private" },
      { operation: "get_draft_batch", batchId: "__proto__" },
      { operation: "get_draft_batch", batchId: "constructor" },
    ]) expect(() => decodeDraftBatchRequest(input)).toThrow(WorkbenchFault);
  });
});

describe("draft batch coordinator", () => {
  it("previews without dispatch, preserves skipped/blocked entries and freezes its DTO", async () => {
    const f = fixture([candidate(1), { ...candidate(2, "blocked"), inputDigest: null, revisionDigest: null }, { ...candidate(3, "skipped"), targetRef: "target:existing" }]);
    const preview = await f.requestPreview();
    expect(preview.eligibleCount).toBe(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.state().extensions.wechatDraftBatches).toBeUndefined();
    preview.entries[0]!.title = "Changed by caller";
    const batch = await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()) as DraftBatch;
    expect(batch.entries[0]!.title).toBe("Article 1");
    expect(batch.entries.map(item => item.status)).toEqual(["pending", "blocked", "skipped"]);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("supports empty pending preview but will not start it", async () => {
    const f = fixture([]);
    const preview = await f.requestPreview();
    expect(preview.entries).toEqual([]);
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toMatchObject({ code: "BATCH_EMPTY" });
  });
  it("enforces candidate limits and preview expiration", async () => {
    const f = fixture(Array.from({ length: 51 }, (_, index) => candidate(index)));
    await expect(f.requestPreview()).rejects.toMatchObject({ code: "BATCH_LIMIT" });
    const other = fixture();
    const preview = await other.requestPreview();
    other.elapse(600_000);
    await expect(other.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toMatchObject({ code: "BATCH_INTENT_EXPIRED" });
  });
  it("limits preview memory and frees expired entries", async () => {
    const f = fixture();
    for (let index = 0; index < 100; index++) await f.requestPreview();
    await expect(f.requestPreview()).rejects.toMatchObject({ code: "BATCH_PREVIEW_LIMIT" });
    f.elapse(600_001);
    expect((await f.requestPreview()).eligibleCount).toBe(2);
  });
  it("requires the owning Agent and delegates every item to native start", async () => {
    const f = fixture();
    const preview = await f.requestPreview();
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, user, signal())).rejects.toMatchObject({ code: "AGENT_APPROVAL_REQUIRED" });
    const batch = await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()) as DraftBatch;
    await expect(f.service.request({ operation: "advance_draft_batch", batchId: batch.batchId }, user, signal())).rejects.toMatchObject({ code: "AGENT_APPROVAL_REQUIRED" });
    await expect(f.service.request({ operation: "advance_draft_batch", batchId: batch.batchId }, { kind: "agent", sessionId: "session:other" }, signal())).rejects.toMatchObject({ code: "BATCH_CALLER_CHANGED" });
    await f.advance(batch.batchId);
    expect(f.start.mock.calls[0]![1]).toEqual(agent);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("is serial across repeated and concurrent advances and verifies each success", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    await Promise.all([f.advance(batch.batchId), f.advance(batch.batchId), f.advance(batch.batchId)]);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect((await f.get(batch.batchId)).status).toBe("running");
    f.succeed();
    expect((await f.advance(batch.batchId)).entries.map(item => item.status)).toEqual(["succeeded", "running"]);
    expect(f.start).toHaveBeenCalledTimes(2);
    f.succeed(1);
    const completed = await f.advance(batch.batchId);
    expect(completed.status).toBe("completed");
    expect(completed.entries.every(item => item.status === "succeeded" && item.targetRef)).toBe(true);
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(2);
  });
  it("makes duplicate start idempotent and prevents simultaneous queues", async () => {
    const f = fixture();
    const preview = await f.requestPreview();
    const first = await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal());
    expect(await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).toEqual(first);
    await expect(f.requestStart()).rejects.toMatchObject({ code: "BATCH_BUSY" });
    expect(f.start).not.toHaveBeenCalled();
    const fresh = fixture();
    const previews = await Promise.all([fresh.requestPreview(), fresh.requestPreview()]);
    const results = await Promise.allSettled(previews.map(item => fresh.service.request({ operation: "start_draft_batch", intentId: item.intentId }, agent, signal())));
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
  });
  it("recovers a committed start even after its response failed and the batch was cancelled", async () => {
    const f = fixture();
    const preview = await f.requestPreview();
    f.failNextResponseAfterCommit();
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toThrow("Synthetic response failure after commit");
    const batches = (await f.service.request({ operation: "list_draft_batches" }, user, signal())).batches as DraftBatch[];
    expect(batches).toHaveLength(1);
    await f.service.request({ operation: "cancel_draft_batch", batchId: batches[0]!.batchId }, user, signal());
    const recovered = await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()) as DraftBatch;
    expect(recovered.batchId).toBe(batches[0]!.batchId);
    expect(recovered.status).toBe("stopped");
    expect(Object.keys(f.state().extensions.wechatDraftBatches!)).toHaveLength(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("fails closed when persisted runs claim the same consumed preview", async () => {
    const f = fixture();
    const preview = await f.requestPreview();
    f.failNextResponseAfterCommit();
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toThrow();
    const snapshot = f.state();
    const saved = snapshot.extensions.wechatDraftBatches as Record<string, Record<string, unknown>>;
    const original = Object.values(saved)[0]!;
    saved["draftbatch:duplicate"] = { ...original, batchId: "draftbatch:duplicate" };
    f.setState(snapshot);
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toMatchObject({ code: "BATCH_STATE_INVALID" });
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects poisoned dictionary keys and never resolves inherited object keys", async () => {
    const f = fixture();
    await expect(f.get("constructor")).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
    const batch = await f.requestStart();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const snapshot = f.state();
      const original = (snapshot.extensions.wechatDraftBatches as Record<string, JsonObject>)[batch.batchId]!;
      snapshot.extensions.wechatDraftBatches = JSON.parse(JSON.stringify({ [key]: { ...original, batchId: key } }));
      f.setState(snapshot);
      await expect(f.get(batch.batchId)).rejects.toMatchObject({ code: "BATCH_STATE_INVALID" });
      snapshot.extensions.wechatDraftBatches = { [batch.batchId]: original };
      f.setState(snapshot);
    }
  });
  it.each(["revision", "input", "gate"])("stops before dispatch when %s changed", async field => {
    const f = fixture();
    const batch = await f.requestStart();
    const implementation = f.preview.getMockImplementation()!;
    f.preview.mockImplementation(async item => {
      const value = await implementation(item);
      if (field === "revision") value.intent.artifactDigest = "revision:changed";
      if (field === "input") value.intent.inputDigest = "input:changed";
      if (field === "gate") value.intent.blockingGateCodes = ["REVIEW_MISSING"];
      return value;
    });
    const result = await f.advance(batch.batchId);
    expect(result.status).toBe("stopped");
    expect(result.entries.map(item => item.status)).toEqual(["blocked", "cancelled"]);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("stops after denial and never bypasses or retries approval", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new WorkbenchFault("APPROVAL_DENIED", "Denied"));
    const batch = await f.requestStart();
    const result = await f.advance(batch.batchId);
    expect(result.status).toBe("stopped");
    expect(result.entries.map(item => item.status)).toEqual(["failed", "cancelled"]);
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("continues past a definitive failure without retrying that item", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    Object.assign(f.jobs[0]!, { status: "failed", resultCode: "WECHAT_VALIDATION_FAILED" });
    const result = await f.advance(batch.batchId);
    expect(result.entries.map(item => item.status)).toEqual(["failed", "running"]);
    expect(f.start).toHaveBeenCalledTimes(2);
  });
  it.each(["INTENT_EXPIRED", "INTENT_CHANGED", "GATES_BLOCKED", "CONTENT_BUSY", "REFERENCE_BUSY", "ACCOUNT_BUSY", "RECONCILE_REQUIRED", "DRAFT_TARGET_EXISTS"])("stops after a persisted child fails pre-dispatch revalidation with %s", async resultCode => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    Object.assign(f.jobs[0]!, { status: "failed", resultCode });
    const result = await f.advance(batch.batchId);
    expect(result.status).toBe("stopped");
    expect(result.entries.map(item => item.status)).toEqual(["failed", "cancelled"]);
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong_code", "missing_target", "changed_revision", "ambiguous_target"])("does not claim success with %s", async condition => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.succeed();
    const document = f.documents.get(ref(1))!;
    if (condition === "wrong_code") f.jobs[0]!.resultCode = "SUCCESS";
    if (condition === "missing_target") document.targets = [];
    if (condition === "changed_revision") document.revisionDigest = "revision:changed";
    if (condition === "ambiguous_target") document.targets.push({ ...document.targets[0]!, targetRef: "target:another" });
    const result = await f.advance(batch.batchId);
    expect(result.entries[0]!.status).toBe("reconcile_required");
    expect(result.status).toBe("stopped");
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("cancels queued items and requests cancellation without pretending remote rollback", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.cancelJob.mockImplementation(async () => { f.jobs[0]!.status = "reconcile_required"; return f.jobs[0]!; });
    const cancelled = await f.service.request({ operation: "cancel_draft_batch", batchId: batch.batchId }, user, signal()) as DraftBatch;
    expect(cancelled.status).toBe("stopped");
    expect(cancelled.entries.map(item => item.status)).toEqual(["reconcile_required", "cancelled"]);
    expect(f.cancelJob).toHaveBeenCalledTimes(1);
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("rechecks a previously completed batch against the current article revision", async () => {
    const f = fixture([candidate(1)]);
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.succeed();
    expect((await f.advance(batch.batchId)).status).toBe("completed");
    f.documents.get(ref(1))!.revisionDigest = "revision:later";
    expect((await f.get(batch.batchId)).entries[0]!.status).toBe("reconcile_required");
  });
  it.each(["contentRef", "action", "inputDigest", "generationId"])("rejects a recovered child with mismatched %s", async field => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    Object.assign(f.jobs[0]!, { [field]: field === "contentRef" ? ref(2) : "mismatched" });
    const value = await f.advance(batch.batchId);
    expect(value.entries[0]!.status).toBe("reconcile_required");
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("cancellation during preflight prevents the first native dispatch", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    const implementation = f.preview.getMockImplementation()!;
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.preview.mockImplementation(async item => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return implementation(item); });
    const advancing = f.advance(batch.batchId);
    await ready;
    const cancelling = f.service.request({ operation: "cancel_draft_batch", batchId: batch.batchId }, user, signal());
    resume();
    await advancing;
    expect((await cancelling as DraftBatch).status).toBe("stopped");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("allows observing and cancelling while native approval is pending", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    const implementation = f.start.getMockImplementation()!;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.start.mockImplementation(async (intentId, caller, childSignal) => {
      const job = await implementation(intentId, caller, childSignal);
      job.status = "waiting_user";
      entered();
      await new Promise<void>(resolve => childSignal.addEventListener("abort", () => { job.status = "cancelled"; resolve(); }, { once: true }));
      throw new WorkbenchFault("REQUEST_CANCELLED", "Cancelled");
    });
    const advancing = f.advance(batch.batchId);
    await ready;
    expect((await f.get(batch.batchId)).entries[0]!.status).toBe("running");
    const cancelled = await f.service.request({ operation: "cancel_draft_batch", batchId: batch.batchId }, user, signal()) as DraftBatch;
    await advancing;
    expect(cancelled.entries.map(item => item.status)).toEqual(["cancelled", "cancelled"]);
  });
  it("never dispatches if the durable intent association cannot be saved", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    f.failSaveAfter(2);
    await expect(f.advance(batch.batchId)).rejects.toThrow("Synthetic persistence failure");
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.get(batch.batchId)).entries[0]!.intentId).toBeNull();
  });
  it("recovers a child by intent after the job association save failed", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    f.failSaveAfter(3);
    await expect(f.advance(batch.batchId)).rejects.toThrow("Synthetic persistence failure");
    expect(f.start).toHaveBeenCalledTimes(1);
    expect((await f.get(batch.batchId)).entries[0]!.jobId).toBe(f.jobs[0]!.jobId);
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("recovers a child if start throws after creating it", async () => {
    const f = fixture();
    const implementation = f.start.getMockImplementation()!;
    f.start.mockImplementation(async (...args) => { await implementation(...args); throw new Error("Synthetic response interruption"); });
    const batch = await f.requestStart();
    const result = await f.advance(batch.batchId);
    expect(result.entries[0]!.jobId).toBe(f.jobs[0]!.jobId);
    expect(result.entries[0]!.status).toBe("running");
    await f.advance(batch.batchId);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("marks an unknown dispatch uncertain and never retries it", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("Synthetic transport failure"));
    const batch = await f.requestStart();
    const stale = await f.requestPreview();
    const result = await f.advance(batch.batchId);
    expect(result.entries[0]!.status).toBe("reconcile_required");
    expect(result.status).toBe("stopped");
    await f.advance(batch.batchId);
    await expect(f.service.request({ operation: "start_draft_batch", intentId: stale.intentId }, agent, signal())).rejects.toMatchObject({ code: "BATCH_RECONCILE_REQUIRED" });
    const fresh = await f.requestPreview();
    expect(fresh.entries[0]!.status).toBe("blocked");
    expect(fresh.entries[0]!.code).toBe("BATCH_RECONCILE_REQUIRED");
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("allows a disjoint batch after uncertainty without retrying the old article", async () => {
    const f = fixture([candidate(1)]);
    f.start.mockRejectedValue(new Error("Synthetic transport failure"));
    const batch = await f.requestStart();
    expect((await f.advance(batch.batchId)).entries[0]!.status).toBe("reconcile_required");
    f.candidates.mockResolvedValue([candidate(2)]);
    const next = await f.requestStart();
    expect(next.batchId).not.toBe(batch.batchId);
    expect(next.entries[0]!.contentRef).toBe(ref(2));
    expect((await f.get(batch.batchId)).entries[0]!.status).toBe("reconcile_required");
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("blocks only the uncertain article in a mixed preview", async () => {
    const f = fixture([candidate(1)]);
    f.start.mockRejectedValue(new Error("Synthetic transport failure"));
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.candidates.mockResolvedValue([candidate(1), candidate(2)]);
    const preview = await f.requestPreview();
    expect(preview.entries.map(item => item.status)).toEqual(["blocked", "pending"]);
    expect(preview.eligibleCount).toBe(1);
    const next = await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()) as DraftBatch;
    expect(next.entries.map(item => item.status)).toEqual(["blocked", "pending"]);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("does not let an old revised success block unrelated articles", async () => {
    const f = fixture([candidate(1)]);
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.succeed();
    await f.advance(batch.batchId);
    f.documents.get(ref(1))!.revisionDigest = "revision:changed-after-completion";
    expect((await f.advance(batch.batchId)).entries[0]!.status).toBe("reconcile_required");
    f.candidates.mockResolvedValue([candidate(2)]);
    expect((await f.requestStart()).entries[0]!.contentRef).toBe(ref(2));
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("observes only the 20 most recent batches while direct get reaches older records", async () => {
    const f = fixture([candidate(1)]);
    const original = await f.requestStart();
    const snapshot = f.state();
    const template = (snapshot.extensions.wechatDraftBatches as Record<string, JsonObject>)[original.batchId]!;
    const saved: Record<string, JsonObject> = {};
    for (let index = 0; index < 25; index++) {
      const batchId = `draftbatch:${String(index).padStart(3, "0")}`;
      saved[batchId] = { ...template, batchId, sourceIntentId: `batchintent:history${index}`, entries: [{ ...candidate(1), status: "running", intentId: `intent:history${index}` }] };
    }
    snapshot.extensions.wechatDraftBatches = saved;
    f.setState(snapshot);
    const jobs = vi.fn(() => [] as WorkbenchJob[]);
    const service = new DraftBatchService({ ...f.options, jobs });
    const result = await service.request({ operation: "list_draft_batches" }, user, signal());
    const batches = result.batches as DraftBatch[];
    expect(batches).toHaveLength(20);
    expect(batches[0]!.batchId).toBe("draftbatch:024");
    expect(batches[19]!.batchId).toBe("draftbatch:005");
    expect(jobs).toHaveBeenCalledTimes(20);
    expect((await service.request({ operation: "get_draft_batch", batchId: "draftbatch:000" }, user, signal())).batchId).toBe("draftbatch:000");
    expect(jobs).toHaveBeenCalledTimes(21);
  });
  it("rejects a 1001st stored batch without making existing records unreadable", async () => {
    const f = fixture([candidate(1)]);
    const original = await f.requestStart();
    const snapshot = f.state();
    const template = (snapshot.extensions.wechatDraftBatches as Record<string, JsonObject>)[original.batchId]!;
    const saved: Record<string, JsonObject> = {};
    for (let index = 0; index < 1000; index++) {
      const batchId = `draftbatch:history${index}`;
      saved[batchId] = { ...template, batchId, sourceIntentId: `batchintent:history${index}`, status: "stopped", entries: [{ ...candidate(1), status: "cancelled" }] };
    }
    snapshot.extensions.wechatDraftBatches = saved;
    f.setState(snapshot);
    await expect(f.requestStart()).rejects.toMatchObject({ code: "BATCH_STORAGE_LIMIT" });
    expect(Object.keys(f.state().extensions.wechatDraftBatches!)).toHaveLength(1000);
    expect((await f.get("draftbatch:history0")).status).toBe("stopped");
    expect((await f.service.request({ operation: "list_draft_batches" }, user, signal())).batches).toHaveLength(20);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("stops pending entries on restart while preserving a recovered native child", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    await f.advance(batch.batchId);
    f.service.dispose();
    const restarted = new DraftBatchService({ ...f.options, generationId: "generation:two" });
    const result = await restarted.request({ operation: "get_draft_batch", batchId: batch.batchId }, user, signal()) as DraftBatch;
    expect(result.status).toBe("stopped");
    expect(result.entries.map(item => item.status)).toEqual(["running", "cancelled"]);
    f.succeed();
    const recovered = await restarted.request({ operation: "advance_draft_batch", batchId: batch.batchId }, agent, signal()) as DraftBatch;
    expect(recovered.entries.map(item => item.status)).toEqual(["succeeded", "cancelled"]);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("fails closed for corrupted stored records and omits private fields from all DTOs", async () => {
    const f = fixture();
    const batch = await f.requestStart();
    const snapshot = f.state();
    const saved = (snapshot.extensions.wechatDraftBatches as Record<string, Record<string, unknown>>)[batch.batchId]!;
    saved.internalNote = "Private note";
    f.setState(snapshot);
    const value = await f.get(batch.batchId);
    expect(JSON.stringify(value)).not.toContain("session:owner");
    expect(JSON.stringify(value)).not.toContain("internalNote");
    value.entries[0]!.status = "succeeded";
    expect((await f.get(batch.batchId)).entries[0]!.status).toBe("pending");
    const list = await f.service.request({ operation: "list_draft_batches" }, user, signal());
    expect(JSON.stringify(list)).not.toContain("sourceIntentId");
    saved.entries = [{ ...candidate(1), status: "running", intentId: null }];
    f.setState(snapshot);
    await expect(f.get(batch.batchId)).rejects.toMatchObject({ code: "BATCH_STATE_INVALID" });
    await expect(f.requestStart()).rejects.toMatchObject({ code: "BATCH_STATE_INVALID" });
  });
  it("records local start persistence before returning a batch and exposes safe task guidance", async () => {
    const f = fixture();
    const preview = await f.requestPreview();
    const prompt = f.service.task(preview.intentId);
    expect(prompt).toContain("wemedia_start_draft_batch");
    expect(prompt).toContain("wemedia_advance_draft_batch");
    expect(prompt).toContain("原生审批");
    expect(prompt).toContain("自动重试");
    expect(prompt).toContain("有活动子任务时不调用 advance");
    expect(prompt).toContain("没有活动子任务且仍有 pending 项时");
    f.failNextSave();
    await expect(f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal())).rejects.toThrow("Synthetic persistence failure");
    expect(f.start).not.toHaveBeenCalled();
  });
});

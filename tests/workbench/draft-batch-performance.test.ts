import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import type { DraftBatch, DraftBatchPreview } from "../../src/domain/draftBatch.ts";
import type { GateReport } from "../../src/domain/capability.ts";
import type { QualityGateRunner, QualityInput } from "../../src/ports/quality.ts";
import type { WorkbenchAnswer, WorkbenchCaller } from "../../src/domain/workbench.ts";
import { fixture } from "./fixture.ts";

const user: WorkbenchCaller = { kind: "user" };
const agent: WorkbenchCaller = { kind: "agent", sessionId: "batch-performance-session", callId: "batch-performance-call" };
const signal = (): AbortSignal => new AbortController().signal;
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];

function value<T>(answer: WorkbenchAnswer): T {
  if (!answer.ok) throw new Error(answer.error.code);
  return answer.value as T;
}

function qualityRunner() {
  const run = vi.fn(async (input: QualityInput): Promise<GateReport> => ({ status: "pass", inputDigest: sha256(input.contentRef), issues: [] }));
  return { run, quality: { run } satisfies QualityGateRunner };
}

function serviceFor(f: Awaited<ReturnType<typeof fixture>>, quality: QualityGateRunner): WorkbenchService {
  let counter = 0;
  return new WorkbenchService({
    documents: f.documents,
    draftBatchStore: f.store,
    jobs: f.jobs,
    adapter: f.adapter,
    approvals: f.approvals,
    clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) },
    ids: {
      uuidV4: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      opaqueId: prefix => `${prefix}:${++counter}`,
    },
    hasher: { digest: sha256 },
    quality,
  });
}

afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); vi.restoreAllMocks(); });

describe("draft batch performance boundaries", () => {
  it("uses one request-local quality catalog snapshot for 50 selected articles", async () => {
    const f = await fixture(); fixtures.push(f);
    const refs: ContentRef[] = [];
    for (let index = 0; index < 50; index++) refs.push((await f.create()).contentRef);
    const { run, quality } = qualityRunner();
    const service = serviceFor(f, quality);
    await service.initialize();
    const list = vi.spyOn(f.documents, "list");

    const preview = value<DraftBatchPreview>(await service.request({ operation: "preview_draft_batch", scope: "selected", contentRefs: refs }, user, signal()));
    expect(preview.entries).toHaveLength(50);
    expect(list).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(50);
    expect(run.mock.calls.every(([input]) => input.existingRecords.length === 49)).toBe(true);
    await service.dispose();
  });

  it("does not reuse the batch quality snapshot for advance revalidation", async () => {
    const f = await fixture(); fixtures.push(f);
    f.adapter.discover = async () => ({ channel: "wechat", adapter: "fixture", configured: "configured", actions: [{ action: "draft", status: "approval_required", reasonCode: "FIXTURE_READY", safeMessage: "Synthetic adapter", checkedAt: f.now() }] });
    const document = await f.create();
    await f.reviewAll(document);
    const { quality } = qualityRunner();
    const service = serviceFor(f, quality);
    await service.initialize();
    const list = vi.spyOn(f.documents, "list");

    const preview = value<DraftBatchPreview>(await service.request({ operation: "preview_draft_batch", scope: "selected", contentRefs: [document.contentRef] }, user, signal()));
    expect(preview.entries[0]!.status).toBe("pending");
    expect(list).toHaveBeenCalledOnce();
    const batch = value<DraftBatch>(await service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()));
    await service.request({ operation: "advance_draft_batch", batchId: batch.batchId }, agent, signal());
    expect(list.mock.calls.length).toBeGreaterThan(1);
    await service.dispose();
  });

  it("rebuilds quality context after native approval when the catalog changes", async () => {
    const f = await fixture(); fixtures.push(f);
    f.adapter.discover = async () => ({ channel: "wechat", adapter: "fixture", configured: "configured", actions: [{ action: "draft", status: "approval_required", reasonCode: "FIXTURE_READY", safeMessage: "Synthetic adapter", checkedAt: f.now() }] });
    const document = await f.create();
    await f.reviewAll(document);
    const run = vi.fn(async (input: QualityInput): Promise<GateReport> => ({ status: "pass", inputDigest: sha256(JSON.stringify(input.existingRecords)), issues: [{ gateId: "test-quality", version: "1", status: "pass", code: "QUALITY_CONTEXT", safeMessage: "synthetic quality context", evidenceRefs: [], inputDigest: sha256(JSON.stringify(input.existingRecords)) }] }));
    const service = serviceFor(f, { run } satisfies QualityGateRunner);
    await service.initialize();
    const list = vi.spyOn(f.documents, "list");

    const preview = value<DraftBatchPreview>(await service.request({ operation: "preview_draft_batch", scope: "selected", contentRefs: [document.contentRef] }, user, signal()));
    expect(preview.entries[0]!.status).toBe("pending");
    expect(list).toHaveBeenCalledOnce();
    f.setAfterApproval(async () => { await f.create(); });
    const batch = value<DraftBatch>(await service.request({ operation: "start_draft_batch", intentId: preview.intentId }, agent, signal()));
    const result = value<DraftBatch>(await service.request({ operation: "advance_draft_batch", batchId: batch.batchId }, agent, signal()));
    expect(result.status).toBe("stopped");
    expect(result.entries[0]).toMatchObject({ status: "failed", code: "INTENT_CHANGED" });
    expect(f.remoteCalls()).toBe(0);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(run.mock.calls.at(-1)?.[0].existingRecords).toHaveLength(1);
    await service.dispose();
  });
});

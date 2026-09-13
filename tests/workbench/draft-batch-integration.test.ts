import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DraftBatch, DraftBatchPreview } from "../../src/domain/draftBatch.ts";
import type { ActionPreview, ArticleDocument, WorkbenchAnswer } from "../../src/domain/workbench.ts";
import { createWorkbenchTools } from "../../src/host/tools.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const user = { kind: "user" as const };
const agent = { kind: "agent" as const, sessionId: "batch-fixture-session", callId: "batch-fixture-call" };
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); vi.restoreAllMocks(); });
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
async function setup() {
  const f = await fixture(); fixtures.push(f);
  f.adapter.discover = async () => ({ channel: "wechat", adapter: "fixture", configured: "configured", actions: [{ action: "draft", status: "approval_required", reasonCode: "FIXTURE_READY", safeMessage: "Synthetic adapter", checkedAt: f.now() }] });
  const tools = createWorkbenchTools(f.service, { bind: () => ({ caller: agent, dispose() {} }) });
  const invoke = async <T>(name: string, args: unknown): Promise<T> => {
    const tool = tools.find(item => item.name === name)!;
    const answer = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext);
    expect(validateJsonSchemaValue(tool.output.schema, answer), name).toEqual([]);
    return value<T>(answer as WorkbenchAnswer);
  };
  const ready = async () => {
    const document = await f.create();
    await f.reviewAll(document);
    // Keep each article's synthetic evidence immutable while another is reviewed.
    for (const review of (await f.documents.read(document.contentRef)).reviews) {
      const file = `${document.metadata.articleId}-${review.artifact.relativePath}`;
      await copyFile(resolve(f.writePath, review.artifact.relativePath), resolve(f.writePath, file));
      await f.documents.recordReview(document.contentRef, { kind: review.kind, revisionDigest: document.revisionDigest, artifact: { rootId: "write", relativePath: file }, reviewer: "agent", summary: "Synthetic fixture evidence" });
    }
    return document;
  };
  const settle = async (batch: DraftBatch) => {
    for (const item of batch.entries) if (item.jobId) await f.service.settle(item.jobId);
    return invoke<DraftBatch>("wemedia_get_draft_batch", { batchId: batch.batchId });
  };
  return { ...f, invoke, ready, settle };
}

describe("batch drafts through the real shared workbench", () => {
  it("projects typed previews and serial native jobs, preserving per-article approval and verified targets", async () => {
    const f = await setup(); const first = await f.ready(), second = await f.ready(), blocked = await f.create();
    const approval = vi.spyOn(f.approvals, "forCaller");
    const preview = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "selected", contentRefs: [first.contentRef, blocked.contentRef, second.contentRef] });
    expect(preview.entries.map(item => item.status)).toEqual(["pending", "blocked", "pending"]);
    expect(preview.eligibleCount).toBe(2); expect(f.remoteCalls()).toBe(0);
    expect(f.service.intentTask(preview.intentId)).toContain("wemedia_start_draft_batch");
    expect(await f.service.request({ operation: "start_draft_batch", intentId: preview.intentId }, user)).toMatchObject({ ok: false });
    let batch = await f.invoke<DraftBatch>("wemedia_start_draft_batch", { intentId: preview.intentId });
    expect(f.remoteCalls()).toBe(0);
    batch = await f.settle(await f.invoke<DraftBatch>("wemedia_advance_draft_batch", { batchId: batch.batchId }));
    expect(batch.entries[0]!.status).toBe("succeeded"); expect(batch.entries[2]!.status).toBe("pending");
    batch = await f.settle(await f.invoke<DraftBatch>("wemedia_advance_draft_batch", { batchId: batch.batchId }));
    expect(batch.status).toBe("completed");
    expect(batch.entries.map(item => item.status)).toEqual(["succeeded", "blocked", "succeeded"]);
    expect(approval).toHaveBeenCalledTimes(2); expect(f.remoteCalls()).toBe(2);
    for (const item of batch.entries.filter(item => item.status === "succeeded")) {
      const current = await f.documents.read(item.contentRef);
      expect(current.targets).toHaveLength(1); expect(current.targets[0]!.verifiedRevision).toBe(current.revisionDigest);
    }
    await f.invoke("wemedia_advance_draft_batch", { batchId: batch.batchId });
    await f.invoke("wemedia_list_draft_batches", {});
    expect(f.remoteCalls()).toBe(2);
    const repeated = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "selected", contentRefs: [first.contentRef, second.contentRef] });
    expect(repeated.eligibleCount).toBe(0); expect(repeated.entries.every(item => item.status === "skipped")).toBe(true);
  });

  it("selects all ready articles from the authoritative catalog, not library pagination", async () => {
    const f = await setup(); const first = await f.ready(), second = await f.ready(); await f.create();
    const preview = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "pending" });
    expect(preview.entries.map(item => item.contentRef).sort()).toEqual([first.contentRef, second.contentRef].sort());
    expect(preview.eligibleCount).toBe(2); expect(f.remoteCalls()).toBe(0);
    expect(await f.service.request({ operation: "preview_draft_batch", scope: "pending", contentRefs: [first.contentRef] }, user)).toMatchObject({ ok: false });
  });

  it("does not dispatch when the account or article changes after the batch preview", async () => {
    const f = await setup(); const document = await f.ready();
    const preview = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "selected", contentRefs: [document.contentRef] });
    const batch = await f.invoke<DraftBatch>("wemedia_start_draft_batch", { intentId: preview.intentId });
    f.setAccount(`wechat-account:${"b".repeat(32)}`);
    const result = await f.invoke<DraftBatch>("wemedia_advance_draft_batch", { batchId: batch.batchId });
    expect(result.entries[0]!.status).toBe("blocked"); expect(f.remoteCalls()).toBe(0);
  });

  it("stops the remaining queue on native denial", async () => {
    const f = await setup(); const first = await f.ready(), second = await f.ready();
    const preview = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "selected", contentRefs: [first.contentRef, second.contentRef] });
    const batch = await f.invoke<DraftBatch>("wemedia_start_draft_batch", { intentId: preview.intentId });
    f.setGrant(false);
    const result = await f.invoke<DraftBatch>("wemedia_advance_draft_batch", { batchId: batch.batchId });
    expect(result.status).toBe("stopped"); expect(result.entries[1]!.status).toBe("cancelled");
    expect(f.remoteCalls()).toBe(0);
  });

  it("rejects a target that appears after preview, including during native approval", async () => {
    const f = await setup(); const document = await f.ready();
    const bind = async () => f.documents.persistRemoteResult(document, { ok: true, code: "FIXTURE_DRAFT_BOUND", phase: "draft", channel: "wechat", sideEffect: "remote_draft", artifacts: [], issues: [], retryable: false, remote: { remoteId: "FixtureBoundMediaID" }, revisionDigest: document.revisionDigest, verifiedAt: f.now() }, null);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: document.contentRef, action: "create_draft" }, user));
    f.setAfterApproval(bind);
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "DRAFT_TARGET_EXISTS" } });
    expect(f.remoteCalls()).toBe(0);
    const next = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: document.contentRef, action: "create_draft" }, user));
    expect(next.intent.blockingGateCodes).toContain("DRAFT_TARGET_EXISTS");
    expect((await f.documents.read(document.contentRef) as ArticleDocument).targets).toHaveLength(1);
  });

  it("stops the whole queue when a target appears during a child native approval", async () => {
    const f = await setup(); const first = await f.ready(), second = await f.ready();
    const preview = await f.invoke<DraftBatchPreview>("wemedia_preview_draft_batch", { scope: "selected", contentRefs: [first.contentRef, second.contentRef] });
    const batch = await f.invoke<DraftBatch>("wemedia_start_draft_batch", { intentId: preview.intentId });
    f.setAfterApproval(async () => { await f.documents.persistRemoteResult(first, { ok: true, code: "FIXTURE_DRAFT_BOUND", phase: "draft", channel: "wechat", sideEffect: "remote_draft", artifacts: [], issues: [], retryable: false, remote: { remoteId: "FixtureConcurrentMediaID" }, revisionDigest: first.revisionDigest, verifiedAt: f.now() }, null); });
    const result = await f.invoke<DraftBatch>("wemedia_advance_draft_batch", { batchId: batch.batchId });
    expect(result.status).toBe("stopped");
    expect(result.entries.map(item => item.status)).toEqual(["failed", "cancelled"]);
    expect(result.entries[0]!.code).toBe("DRAFT_TARGET_EXISTS");
    expect(result.entries[0]!.jobId).not.toBeNull();
    await f.invoke("wemedia_advance_draft_batch", { batchId: batch.batchId });
    expect(f.remoteCalls()).toBe(0);
    expect((await f.documents.read(second.contentRef)).targets).toEqual([]);
  });
});

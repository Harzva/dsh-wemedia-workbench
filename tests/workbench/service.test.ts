import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPreview, ArticleDocument, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { fixture } from "./fixture.ts";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const value = await fixture(); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.cleanup())); vi.restoreAllMocks(); vi.useRealTimers(); });
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
const user = { kind: "user" as const }, agent = { kind: "agent" as const, sessionId: "fixture", callId: "fixture-call" };
async function bindDraft(f: Awaited<ReturnType<typeof fixture>>, document: ArticleDocument) {
  await f.documents.persistRemoteResult(document, { ok: true, code: "FIXTURE_DRAFT_BOUND", phase: "draft", channel: "wechat", sideEffect: "remote_draft", artifacts: [], issues: [], retryable: false, remote: { remoteId: "FixtureBoundMediaID" }, revisionDigest: document.revisionDigest, verifiedAt: f.now() }, null);
  return (await f.documents.read(document.contentRef)).targets[0]!;
}

describe("shared workbench service", () => {
  it("rejects caller-forged approval and unknown request fields", () => {
    expect(() => decodeWorkbenchRequest({ operation: "start_action", intentId: "intent:x", approved: true })).toThrow();
    expect(() => decodeWorkbenchRequest({ operation: "inspect", contentRef: "wmc:bad" })).toThrow();
    expect(() => decodeWorkbenchRequest({ operation: "search", query: "", pageSize: 0 })).toThrow();
  });
  it("previews and executes a local creation once, with stable read-back", async () => {
    const f = await setup();
    const request = { operation: "create_content", title: "A new article", sourceUrl: "https://example.org/source", kind: "article" };
    const preview = value<{ intent: ActionPreview["intent"] }>(await f.service.request(request, user));
    const started = value<WorkbenchJob>(await f.service.request({ ...request, applyIntentId: preview.intent.intentId }, user));
    expect((await f.service.settle(started.jobId)).status).toBe("succeeded");
    expect((await f.documents.read(preview.intent.contentRef)).metadata.title).toBe("A new article");
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("blocks remote actions without current review evidence", async () => {
    const f = await setup(); const doc = await f.create();
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "create_draft" }, user));
    expect(preview.intent.blockingGateCodes).toEqual(expect.arrayContaining(["REVIEW_FACTS", "REVIEW_EDITORIAL", "REVIEW_IMAGES_FORMULAS", "REVIEW_MOBILE_VISUAL", "COVERAGE_FACTS", "COVERAGE_EDITORIAL", "COVERAGE_IMAGES_FORMULAS"]));
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "GATES_BLOCKED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("requires native Agent approval, supports denial, and hides remote IDs in inspected documents", async () => {
    const f = await setup(); const doc = await f.create(); await f.reviewAll(doc);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "create_draft" }, user));
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "AGENT_APPROVAL_REQUIRED" } });
    f.setGrant(false);
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "APPROVAL_DENIED" } });
    expect(f.remoteCalls()).toBe(0);
    f.setGrant(true);
    const next = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "create_draft" }, agent));
    const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: next.intent.intentId }, agent));
    expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
    const inspected = await f.service.request({ operation: "inspect", contentRef: doc.contentRef }, user);
    expect(JSON.stringify(inspected)).not.toContain("FixtureMediaID");
    expect((await f.documents.read(doc.contentRef)).targets).toHaveLength(1);
  });
  it("revalidates account and content after approval before any remote side effect", async () => {
    const f = await setup(); const doc = await f.create(); await f.reviewAll(doc);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "create_draft" }, agent));
    f.setAfterApproval(async () => { f.setAccount(`wechat-account:${"b".repeat(32)}`); });
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("rejects user remote writes even when the approval provider incorrectly returns a bridge", async () => {
    const f = await setup(); const doc = await f.create(); await f.reviewAll(doc);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "create_draft" }, user));
    const bridge = f.approvals.forCaller(agent);
    const forCaller = vi.spyOn(f.approvals, "forCaller").mockReturnValue(bridge);
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "AGENT_APPROVAL_REQUIRED" } });
    expect(forCaller).not.toHaveBeenCalled();
    expect(f.remoteCalls()).toBe(0);
  });
  it("allows read-only sync without reviews or approval and never dispatches a write", async () => {
    const f = await setup(); const doc = await f.create(); const target = await bindDraft(f, doc);
    const forCaller = vi.spyOn(f.approvals, "forCaller").mockImplementation(() => { throw new Error("sync must not request approval"); });
    const run = vi.spyOn(f.adapter, "run");
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "sync", targetRef: target.targetRef }, user));
    expect(preview.intent.sideEffect).toBe("read");
    expect(preview.intent.blockingGateCodes).toEqual([]);
    expect(preview.summary.join(" ")).not.toContain("将请求 DSH 原生审批");
    const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
    expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
    expect(forCaller).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledExactlyOnceWith("sync", expect.objectContaining({ contentRef: doc.contentRef }), target, expect.any(AbortSignal));
  });
  it.each(["account", "target", "revision"] as const)("still rejects a stale sync %s binding", async field => {
    const f = await setup(); const doc = await f.create(); const target = await bindDraft(f, doc);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "sync", targetRef: target.targetRef }, user));
    if (field === "account") f.setAccount(`wechat-account:${"b".repeat(32)}`);
    else {
      const current = await f.documents.read(doc.contentRef);
      vi.spyOn(f.documents, "read").mockResolvedValue(field === "target" ? { ...current, targets: [{ ...target, title: "Changed target" }] } : { ...current, revisionDigest: "sha256:changed" });
    }
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("requires a target and an available account for sync", async () => {
    const f = await setup(); const doc = await f.create(); const target = await bindDraft(f, doc);
    expect(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "sync" }, user)).toMatchObject({ ok: false, error: { code: "TARGET_REQUIRED" } });
    vi.spyOn(f.adapter, "accountRef").mockReturnValue(undefined);
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "sync", targetRef: target.targetRef }, user));
    expect(preview.intent.blockingGateCodes).toEqual(["WECHAT_ACCOUNT_UNAVAILABLE"]);
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "GATES_BLOCKED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("does not turn a failed read-only sync into a write reconciliation or automatic retry", async () => {
    const f = await setup(); const doc = await f.create(); const target = await bindDraft(f, doc);
    const run = vi.spyOn(f.adapter, "run").mockResolvedValue({ ok: false, code: "WECHAT_PROCESS_FAILED", phase: "sync", channel: "wechat", sideEffect: "read", artifacts: [], issues: [], retryable: false, reconcileRequired: true });
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "sync", targetRef: target.targetRef }, user));
    const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
    expect(await f.service.settle(job.jobId)).toMatchObject({ status: "failed", retryable: false });
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("sync");
  });
  it("persists startedAt and deadline with the first running record", async () => {
    const f = await setup(); const doc = await f.create();
    const save = vi.spyOn(f.jobs, "save");
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "prepare" }, user));
    const started = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
    expect((await f.service.settle(started.jobId)).status).toBe("succeeded");
    const running = save.mock.calls.find(([job]) => job.status === "running")![0];
    expect(running).toMatchObject({ startedAt: f.now(), deadline: "2026-09-06T00:10:00.000Z" });
    expect((await f.jobs.loadAll()).find(job => job.jobId === started.jobId)).toMatchObject({ startedAt: running.startedAt, deadline: running.deadline });
  });
  it.each(["sync", "create_draft"] as const)("aborts %s at its durable deadline without retrying", async action => {
    const f = await setup(); const doc = await f.create();
    const target = action === "sync" ? await bindDraft(f, doc) : undefined;
    if (action === "create_draft") await f.reviewAll(doc);
    let entered!: () => void;
    const startedRunning = new Promise<void>(resolve => { entered = resolve; });
    const run = vi.spyOn(f.adapter, "run").mockImplementation(async (_action, _document, _target, signal) => {
      entered();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("fixture adapter cancelled");
    });
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action, ...(target ? { targetRef: target.targetRef } : {}) }, agent));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));
    await startedRunning;
    f.setTime("2026-09-06T00:10:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await f.service.settle(job.jobId)).toMatchObject({ status: action === "sync" ? "timed_out" : "reconcile_required", resultCode: "JOB_TIMEOUT", retryable: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expires previews, rejects old-generation calls, and returns canonical pagination errors", async () => {
    const f = await setup(); const doc = await f.create();
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "prepare" }, user));
    f.setTime("2026-09-06T00:11:00.000Z");
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(await f.service.request({ operation: "search", query: "", cursor: "1:bad:0" }, user)).toMatchObject({ ok: false, error: { code: "CURSOR_STALE" } });
    await f.service.dispose();
    expect(await f.service.request({ operation: "snapshot" }, user)).toMatchObject({ ok: false, error: { code: "GENERATION_DISPOSED" } });
  });
});

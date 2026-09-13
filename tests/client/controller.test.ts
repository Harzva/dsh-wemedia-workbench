import { describe, expect, it, vi } from "vitest";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { ActionIntent, GateReport } from "../../src/domain/capability.ts";
import type { ArticleDocument, WorkbenchAnswer, WorkbenchJob, WorkbenchPage, WorkbenchRequest, WorkbenchSnapshot, WorkbenchValue } from "../../src/domain/workbench.ts";
import type { WemediaRemote } from "../../src/remote/descriptors.ts";
import { createSetupViewController } from "../../src/client/setup-view.tsx";
import { ClientFault, resolveCurrentSession, terminalJob, unwrapAnswer, WorkbenchController, type SessionTarget } from "../../src/client/controller.ts";
import type { ChannelInspection, PublishingType } from "../../src/domain/channelPublishing.ts";
import type { PublicationDraft } from "../../src/domain/publicationDraft.ts";

const ref = "wmc:11111111-1111-4111-8111-111111111111" as const;
const otherRef = "wmc:22222222-2222-4222-8222-222222222222" as const;
const metadata = { articleId: "article-test", title: "Original title", author: "", digest: "Original digest", kind: "article" as const, titlePrefix: "", sourceUrl: "https://example.org/source", pdfUrl: "", codeUrl: "" };
const document: ArticleDocument = { contentRef: ref, document: { rootId: "read", relativePath: "article/wechat-document.json" }, htmlArtifact: { rootId: "read", relativePath: "article/article.html" }, metadata, html: "<p>Body</p>", markdown: "Body", revisionDigest: "sha256:revision-a", assets: [], readOnlySource: true, reviews: [], targets: [], issues: [] };
const gates: GateReport = { status: "pass", inputDigest: "sha256:revision-a", issues: [] };
const snapshot: WorkbenchSnapshot = { schemaVersion: "wemedia.workbench/v1", generationId: "generation-test", revision: 1, settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: true, issues: [] }, capabilities: [], jobs: [], supportedChannels: ["wechat"] };
const page = (title = "First"): WorkbenchPage => ({ items: [{ contentRef: ref, title, articleId: "article-test", rootLabel: "Reader", channel: "wechat", readOnlySource: true, status: "discovered", issueCount: 0 }], total: 1, nextCursor: null, revision: 1 });
const intent = (action: string): ActionIntent => ({ intentId: `intent-${action}`, generationId: "generation-test", contentRef: ref, action, sideEffect: action === "create_draft" || action === "update_draft" ? "remote_draft" : action === "sync" ? "read" : "local_write", targetSummary: `Preview ${action}`, inputDigest: "sha256:exact-input", expectedChanges: [], blockingGateCodes: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false });
const job = (action = "save_revision"): WorkbenchJob => ({ jobId: "job-test", generationId: "generation-test", contentRef: ref, intentId: `intent-${action}`, inputDigest: "sha256:exact-input", action, sideEffect: "local_write", status: "queued", progress: { current: 0, total: 1 }, safeMessage: "Queued", createdAt: "2026-01-01T00:00:00Z", retryable: false, artifactRefs: [] });
const answer = (value: WorkbenchValue): RemoteResult<WorkbenchAnswer> => ({ ok: true, value: { ok: true, value, revision: 1 } });
const failedAnswer = (code: string): RemoteResult<WorkbenchAnswer> => ({ ok: true, value: { ok: false, error: { code, safeMessage: "Synthetic business failure", retryable: false } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function setup(session?: SessionTarget, respond?: (request: WorkbenchRequest) => WorkbenchValue) {
  const request = vi.fn(async (input: WorkbenchRequest, _signal?: AbortSignal): Promise<RemoteResult<WorkbenchAnswer>> => {
    if (respond) return answer(respond(input));
    switch (input.operation) {
      case "library_list": return answer({ items: [], total: 0, nextCursor: null, revisionDigest: "sha256:library" });
      case "library_read": case "library_media": throw new Error("Library preview is covered by its dedicated controller tests");
      case "refresh": case "snapshot": return answer(snapshot);
      case "search": return answer(page());
      case "inspect": return answer(document);
      case "preview": return answer({ revisionDigest: document.revisionDigest, html: "<p>Sandbox preview</p>", width: 390, imageCount: 0, issues: [] });
      case "preview_action": return answer({ intent: intent(input.action), action: input.action, gates, target: null, summary: ["Exact preview"] });
      case "start_action": case "get_job": case "cancel_job": return answer(job());
      case "create_content": return answer(input.applyIntentId ? job("create_content") : { intent: intent("create_content"), summary: ["Local only"] });
      case "task_brief": return answer({ contentRef: ref, action: input.action, revisionDigest: document.revisionDigest, prompt: `Exact Host brief: ${input.action}` });
      case "preflight": return answer(gates);
      case "history": case "compare_versions": case "evidence_detail": case "record_review": return answer({});
      case "ai_inspect": case "ai_preview": return answer({ operation: input.operation, revisionDigest: document.revisionDigest, mode: "ai", sourceKind: "html", status: "pass", code: "AI_OK", previewFidelity: input.operation === "ai_preview" ? "exact" : "unavailable", issues: [] });
      case "preview_workflow_import": return answer({ intent: intent("preview_workflow_import"), kind: input.kind, material: { id: "material-test", kind: input.kind, source: input.artifact, sourceDigest: "sha256:source", sourceFormat: "json", title: "Imported material", status: "current", boundRevision: document.revisionDigest, boundHtmlDigest: "sha256:html", reviewKind: input.kind === "review" ? "facts" : null, findings: [], warnings: [], recordedAt: "2026-01-01T00:00:00Z" }, requiresIdentityCheck: input.kind === "draft", summary: ["Imported material"] });
      case "apply_workflow_import": return answer({ ...document, workflowImports: [{ id: "material-test", kind: "review", source: { rootId: "read", relativePath: "report.json" }, sourceDigest: "sha256:source", sourceFormat: "json", title: "Imported material", status: "current", boundRevision: document.revisionDigest, boundHtmlDigest: "sha256:html", reviewKind: "facts", findings: [], warnings: [], recordedAt: "2026-01-01T00:00:00Z" }] });
      default: throw new Error(`Operation covered by its dedicated controller tests: ${input.operation}`);
    }
  });
  const intentTask = vi.fn(async (): ReturnType<WemediaRemote["intentTask"]> => ({ ok: true, value: { ok: true, code: "AGENT_TASK_READY", prompt: "Exact Host intent prompt" } }));
  const remote = { request, intentTask } satisfies WemediaRemote;
  const controller = new WorkbenchController(() => session);
  controller.connect(remote);
  return { controller, request, intentTask, remote };
}
const acceptPrompt = () => vi.fn<SessionTarget["prompt"]>().mockResolvedValue({ ok: true, value: { accepted: true } });

async function submitCreation() {
  const fixture = setup();
  fixture.controller.open(); await fixture.controller.refresh();
  await fixture.controller.previewCreation({ title: "New item", sourceUrl: "", kind: "article" });
  await fixture.controller.confirmCreation();
  return fixture;
}

describe("Workbench Client request and session boundaries", () => {
  it("unwraps both layers and never displays raw carrier diagnostics", () => {
    expect(unwrapAnswer(answer(page()))).toEqual(page());
    expect(() => unwrapAnswer({ ok: false, error: { code: "offline", message: "untrusted diagnostic", details: {} } })).toThrowError("无法连接工作台服务");
    try { unwrapAnswer({ ok: true, value: { ok: false, error: { code: "WRITE_ROOT_MISSING", safeMessage: "请配置写入目录", retryable: false } } }); }
    catch (error) { expect(error).toBeInstanceOf(ClientFault); expect(error).toMatchObject({ code: "WRITE_ROOT_MISSING", message: "请配置写入目录" }); }
  });

  it("resolves only the installed current-session binding without creating or switching", () => {
    const session = { prompt: acceptPrompt() };
    const binding = vi.fn().mockReturnValue({ session });
    expect(resolveCurrentSession({ list: { getSnapshot: () => ({ current: "current-id" }) }, binding })).toBe(session);
    expect(binding).toHaveBeenCalledExactlyOnceWith("current-id");
    expect(resolveCurrentSession(undefined)).toBeUndefined();
    expect(resolveCurrentSession({ list: { getSnapshot: () => ({ current: null }) }, binding })).toBeUndefined();
    expect(resolveCurrentSession({ get: () => session })).toBeUndefined();
  });

  it("requires the exact save preview before a local start, retaining source metadata", async () => {
    const { controller, request, intentTask } = setup();
    await controller.refresh();
    await controller.select(ref);
    controller.updateEdit({ title: "Revised", digest: "Summary", html: "<p>Revised body</p>" });
    await controller.confirmAction();
    expect(request.mock.calls.some(([request]) => request.operation === "start_action")).toBe(false);
    await controller.previewAction("save_revision");
    expect(request).toHaveBeenCalledWith({ operation: "preview_action", contentRef: ref, action: "save_revision", edit: { metadata: { ...metadata, title: "Revised", digest: "Summary" }, html: "<p>Revised body</p>", markdown: "Body" } }, expect.any(AbortSignal));
    await controller.confirmAction();
    expect(request).toHaveBeenCalledWith({ operation: "start_action", intentId: "intent-save_revision" }, expect.any(AbortSignal));
    expect(intentTask).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("queued");
    expect(controller.getSnapshot().notice?.text).not.toContain("已完成");
  });

  it("preserves unsaved edits when changing articles, and invalidates an edited preview", async () => {
    const { controller, request } = setup();
    await controller.select(ref);
    await controller.previewAction("save_revision");
    controller.updateEdit({ title: "Unsaved" });
    expect(controller.getSnapshot().actionPreview).toBeNull();
    const count = request.mock.calls.length;
    await controller.select("wmc:22222222-2222-4222-8222-222222222222");
    expect(request.mock.calls).toHaveLength(count);
    expect(controller.getSnapshot().notice?.code).toBe("UNSAVED_EDIT");
    expect(controller.getSnapshot().edit?.metadata.title).toBe("Unsaved");
    controller.discardEdits();
    expect(controller.dirty).toBe(false);
  });

  it.each(["create_draft", "update_draft"] as const)("never directly starts %s via user RPC", async action => {
    const prompt = acceptPrompt();
    const { controller, request, intentTask } = setup({ prompt });
    await controller.select(ref);
    await controller.previewAction(action, action === "update_draft" ? "target-test" : undefined);
    await controller.confirmAction();
    expect(intentTask).toHaveBeenCalledWith({ intentId: `intent-${action}` }, expect.any(AbortSignal));
    expect(prompt).toHaveBeenCalledWith([{ type: "text", text: "Exact Host intent prompt" }], "queue", expect.any(AbortSignal));
    expect(request.mock.calls.some(([request]) => request.operation === "start_action")).toBe(false);
    expect(controller.getSnapshot().notice?.text).toContain("尚未执行完成");
    await controller.previewAction(action);
    await controller.confirmAction();
    expect(controller.getSnapshot().notice?.code).toBe("INTENT_ALREADY_QUEUED");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("reports absent current session without fetching intent prompt or starting a job", async () => {
    const { controller, request, intentTask } = setup();
    await controller.select(ref);
    await controller.previewAction("create_draft");
    await controller.confirmAction();
    expect(controller.getSnapshot().notice?.code).toBe("SESSION_REQUIRED");
    expect(intentTask).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([request]) => request.operation === "start_action")).toBe(false);
  });

  it("does not report queued when the session rejects the task", async () => {
    const prompt = vi.fn<SessionTarget["prompt"]>().mockResolvedValue({ ok: false, error: { code: "internal", message: "private diagnostic", details: {} } });
    const { controller } = setup({ prompt });
    await controller.select(ref);
    await controller.taskBrief("research");
    expect(controller.getSnapshot().notice?.kind).toBe("error");
    expect(controller.getSnapshot().notice?.text).not.toContain("private diagnostic");
    expect(controller.getSnapshot().notice?.text).toContain("尚不能视为已排队");
  });

  it.each(["research", "write_draft", "review"] as const)("queues %s using only its exact Host task_brief", async action => {
    const prompt = acceptPrompt();
    const { controller, request } = setup({ prompt });
    await controller.select(ref);
    await controller.taskBrief(action);
    expect(request).toHaveBeenCalledWith({ operation: "task_brief", contentRef: ref, action }, expect.any(AbortSignal));
    expect(prompt).toHaveBeenCalledExactlyOnceWith([{ type: "text", text: `Exact Host brief: ${action}` }], "queue", expect.any(AbortSignal));
    expect(controller.getSnapshot().notice?.text).toContain("尚未完成");
  });

  it("creates content only through preview then an unchanged applyIntentId request", async () => {
    const { controller, request } = setup();
    const input = { title: "New article", sourceUrl: "https://example.org/paper", kind: "paper" as const };
    await controller.previewCreation(input);
    expect(request.mock.calls[0]?.[0]).toEqual({ operation: "create_content", ...input });
    expect(await controller.confirmCreation()).toEqual(job("create_content"));
    expect(request.mock.calls[1]?.[0]).toEqual({ operation: "create_content", ...input, applyIntentId: "intent-create_content" });
    expect(controller.getSnapshot().notice?.text).toContain("不会上传");
  });

  it("returns no creation acknowledgement for missing preview, failure, or an ignored late abort", async () => {
    const { controller, request } = setup();
    expect(await controller.confirmCreation()).toBeNull();
    await controller.previewCreation({ title: "Owned create", sourceUrl: "", kind: "article" });
    request.mockResolvedValueOnce(failedAnswer("CREATE_FAILED"));
    expect(await controller.confirmCreation()).toBeNull();
    expect(controller.getSnapshot().creation?.input.title).toBe("Owned create");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    request.mockReturnValueOnce(pending.promise);
    const submitted = controller.confirmCreation();
    // A second click has no submission of its own while mutation is exclusive.
    expect(await controller.confirmCreation()).toBeNull();
    controller.close();
    pending.resolve(answer(job("create_content")));
    expect(await submitted).toBeNull();
    expect(controller.getSnapshot().open).toBe(false);
  });

  it("does not treat another session's creation snapshot as this pending submission's acknowledgement", async () => {
    const { controller, request } = setup();
    await controller.previewCreation({ title: "My unfinished create", sourceUrl: "", kind: "article" });
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    const original = request.getMockImplementation()!;
    const otherJob = { ...job("create_content"), jobId: "another-job", intentId: "another-intent" };
    request.mockImplementation((input, signal) => input.operation === "create_content" && input.applyIntentId
      ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [otherJob] })) : original(input, signal));
    const completed = vi.fn();
    const submitted = controller.confirmCreation().then(completed);
    await controller.refreshStatus();
    expect(completed).not.toHaveBeenCalled();
    expect(controller.getSnapshot().creation?.input.title).toBe("My unfinished create");
    pending.resolve(answer(job("create_content"))); await submitted;
    expect(completed).toHaveBeenCalledExactlyOnceWith(job("create_content"));
  });

  it.each(["snapshot", "get_job"] as const)("refreshes the current list once when a submitted creation succeeds through %s, preserving the selected dirty article", async operation => {
    const { controller, request } = await submitCreation();
    await controller.search("current query", ["cursor-1"]); await controller.select(ref);
    controller.updateEdit({ title: "Still being edited" }); await controller.select(otherRef);
    controller.navigate("agent");
    const before = controller.getSnapshot(); const original = request.getMockImplementation()!;
    const created = { ...job("create_content"), contentRef: otherRef, status: "succeeded" as const };
    request.mockImplementation((input, signal) => input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [created] })) : input.operation === "get_job" ? Promise.resolve(answer(created)) : input.operation === "search" ? Promise.resolve(answer({ ...page("Updated list"), total: 2 })) : original(input, signal));
    request.mockClear();
    if (operation === "snapshot") await controller.refreshStatus(); else await controller.refreshJob(created.jobId);
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input)).toEqual([operation === "snapshot" ? { operation: "snapshot" } : { operation: "get_job", jobId: created.jobId }, { operation: "search", query: "current query", pageSize: 20, cursor: "cursor-1" }]);
    expect(controller.getSnapshot()).toMatchObject({ query: "current query", cursors: ["cursor-1"], view: "agent", selected: ref, page: { total: 2 } });
    expect(controller.getSnapshot().document).toBe(before.document);
    expect(controller.getSnapshot().edit).toBe(before.edit);
    // The background read preserves notices; an explicit job refresh retains
    // its existing behavior of clearing the previous notice before requesting.
    expect(controller.getSnapshot().notice).toBe(operation === "snapshot" ? before.notice : null);
    expect(controller.getSnapshot().leaveRequest).toBe(before.leaveRequest);
    expect(controller.dirty).toBe(true);
    request.mockClear(); await controller.refreshStatus(); await controller.refreshJob(created.jobId);
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["snapshot", "get_job"]);
  });

  it.each(["failed", "cancelled", "timed_out", "reconcile_required"] as const)("does not refresh the list for a submitted creation that is %s", async status => {
    const { controller, request } = await submitCreation();
    request.mockClear(); request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job("create_content"), status }] }));
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "snapshot" }, expect.any(AbortSignal));
  });

  it("does not refresh for historical successful creation jobs that this Client did not submit", async () => {
    const { controller, request } = setup(); controller.open(); await controller.refresh();
    request.mockClear(); request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] }));
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "snapshot" }, expect.any(AbortSignal));
  });

  it("keeps creation completion read-only while falling back from a stale current cursor", async () => {
    const { controller, request } = await submitCreation();
    await controller.search("current query", ["cursor-1"]);
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] })) : input.operation === "search" && input.cursor ? Promise.resolve(failedAnswer("CURSOR_STALE")) : original(input, signal));
    request.mockClear(); await controller.refreshStatus();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input)).toEqual([{ operation: "snapshot" }, { operation: "search", query: "current query", pageSize: 20, cursor: "cursor-1" }, { operation: "search", query: "current query", pageSize: 20 }]);
    expect(controller.getSnapshot()).toMatchObject({ query: "current query", cursors: [], notice: { kind: "info", code: "CURSOR_STALE" } });
  });

  it("does not interrupt an existing search when creation succeeds, then refreshes its newly committed query and cursor", async () => {
    const { controller, request } = await submitCreation();
    const searching = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    let searchSignal: AbortSignal | undefined; let searches = 0;
    request.mockImplementation((input, signal) => {
      if (input.operation === "snapshot") return Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] }));
      if (input.operation === "search") { searches += 1; if (searches === 1) { searchSignal = signal; return searching.promise; } return Promise.resolve(answer(page("Refreshed current search"))); }
      return original(input, signal);
    });
    request.mockClear(); const explicit = controller.search("new query", ["new-cursor"]);
    await controller.refreshStatus();
    expect(searchSignal?.aborted).toBe(false);
    expect(searches).toBe(1);
    searching.resolve(answer(page("User search"))); await explicit;
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.filter(([input]) => input.operation === "search").map(([input]) => input)).toEqual([{ operation: "search", query: "new query", pageSize: 20, cursor: "new-cursor" }, { operation: "search", query: "new query", pageSize: 20, cursor: "new-cursor" }]);
    expect(controller.getSnapshot()).toMatchObject({ query: "new query", cursors: ["new-cursor"], page: { items: [{ title: "Refreshed current search" }] } });
  });

  it("lets a newer explicit search supersede the creation refresh even if transport ignores its abort", async () => {
    const { controller, request } = await submitCreation();
    await controller.search("old query");
    const background = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    let backgroundSignal: AbortSignal | undefined;
    request.mockImplementation((input, signal) => {
      if (input.operation === "snapshot") return Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] }));
      if (input.operation === "search") { if (input.query === "old query") { backgroundSignal = signal; return background.promise; } return Promise.resolve(answer(page("Newest user search"))); }
      return original(input, signal);
    });
    request.mockClear(); await controller.refreshStatus();
    expect(backgroundSignal?.aborted).toBe(false);
    await controller.search("new query");
    expect(backgroundSignal?.aborted).toBe(true);
    background.resolve(answer(page("Late background page")));
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    await Promise.resolve(); await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ query: "new query", page: { items: [{ title: "Newest user search" }] } });
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(2);
  });

  it.each(["status", "deferred search", "background search"] as const)("does not commit or restart creation list observation after closing during %s", async closingDuring => {
    const { controller, request } = await submitCreation();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => {
      if (input.operation === "snapshot") return closingDuring === "status" ? pending.promise : Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] }));
      if (input.operation === "search") return pending.promise;
      return original(input, signal);
    });
    request.mockClear();
    const before = controller.getSnapshot().page;
    const explicit = closingDuring === "deferred search" ? controller.search("pending query") : undefined;
    const status = controller.refreshStatus();
    if (closingDuring !== "status") await status;
    const searchesBeforeClose = request.mock.calls.filter(([input]) => input.operation === "search").length;
    controller.close();
    pending.resolve(answer(closingDuring === "status" ? { ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] } : page("Late closed page")));
    await status; await explicit; await Promise.resolve(); await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ open: false, pending: [] });
    expect(controller.getSnapshot().page).toBe(before);
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(searchesBeforeClose);
  });

  it("reconciles an immediately successful creation response only once", async () => {
    const { controller, request } = setup(); controller.open(); await controller.refresh();
    await controller.previewCreation({ title: "New item", sourceUrl: "", kind: "article" });
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "create_content" && input.applyIntentId ? Promise.resolve(answer({ ...job("create_content"), status: "succeeded" })) : original(input, signal));
    request.mockClear(); await controller.confirmCreation();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["create_content", "search"]);
    request.mockClear(); request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] }));
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "snapshot" }, expect.any(AbortSignal));
  });

  it("does not duplicate the current-page search when a normal refresh observes creation success", async () => {
    const { controller, request } = await submitCreation(); controller.navigate("articles");
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "refresh" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] })) : original(input, signal));
    request.mockClear(); await controller.refresh();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["refresh", "search"]);
  });

  it("does not retry a failed creation list refresh on repeated terminal observations", async () => {
    const { controller, request } = await submitCreation();
    const before = controller.getSnapshot().page; const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] })) : input.operation === "search" ? Promise.resolve(failedAnswer("SEARCH_FAILED")) : original(input, signal));
    request.mockClear(); await controller.refreshStatus();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(controller.getSnapshot().page).toBe(before);
    expect(controller.getSnapshot().notice?.code).toBe("SEARCH_FAILED");
    await controller.refreshStatus();
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["snapshot", "search", "snapshot"]);
  });

  it("tracks creation success observed before the original submission response arrives", async () => {
    const { controller, request } = setup(); controller.open(); await controller.refresh();
    await controller.previewCreation({ title: "New item", sourceUrl: "", kind: "article" });
    const submitting = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "create_content" && input.applyIntentId ? submitting.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job("create_content"), status: "succeeded" }] })) : original(input, signal));
    request.mockClear(); const creation = controller.confirmCreation();
    await controller.refreshStatus();
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(1);
    submitting.resolve(answer(job("create_content"))); await creation; await controller.refreshStatus();
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded");
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => input.operation === "create_content" && input.applyIntentId)).toHaveLength(1);
  });

  it("allows exact read-only sync without requiring an Agent session", async () => {
    const { controller, request, intentTask } = setup();
    await controller.select(ref);
    await controller.previewAction("sync", "target-test");
    await controller.confirmAction();
    expect(request).toHaveBeenCalledWith({ operation: "start_action", intentId: "intent-sync" }, expect.any(AbortSignal));
    expect(intentTask).not.toHaveBeenCalled();
  });

  it("blocks gated intents before any start or handoff", async () => {
    const { controller, request, intentTask } = setup(undefined, input => input.operation === "inspect" ? document : input.operation === "preview" ? {} : { intent: { ...intent("create_draft"), blockingGateCodes: ["REVIEW_REQUIRED"] }, action: "create_draft", gates, target: null, summary: [] });
    await controller.select(ref);
    await controller.previewAction("create_draft");
    await controller.confirmAction();
    expect(controller.getSnapshot().notice?.code).toBe("GATES_BLOCKED");
    expect(request.mock.calls.some(([input]) => input.operation === "start_action")).toBe(false);
    expect(intentTask).not.toHaveBeenCalled();
  });

  it("expires previews before execution and requires a new preview", async () => {
    const { controller, remote } = setup();
    await controller.select(ref);
    remote.request.mockResolvedValueOnce(answer({ intent: { ...intent("save_revision"), expiresAt: "2000-01-01T00:00:00Z" }, action: "save_revision", gates, target: null, summary: [] }));
    await controller.previewAction("save_revision");
    const calls = remote.request.mock.calls.length;
    await controller.confirmAction();
    expect(remote.request.mock.calls).toHaveLength(calls);
    expect(controller.getSnapshot().notice?.code).toBe("INTENT_EXPIRED");
  });

  it("refreshes stale article readiness once after a successful submitted revision", async () => {
    const { controller, request } = setup(); controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Revised" }); await controller.previewAction("save_revision"); await controller.confirmAction();
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "get_job" ? Promise.resolve(answer({ ...job(), status: "succeeded" })) : input.operation === "search" ? Promise.resolve(answer({ ...page(), items: [{ ...page().items[0]!, status: "needs_review" }] })) : original(input, signal));
    request.mockClear(); await controller.refreshJob("job-test");
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(controller.getSnapshot().page?.items[0]?.status).toBe("needs_review");
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(1);
    await controller.refreshJob("job-test");
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(1);
  });

  it("preserves edits until the exact submitted save is verified successful", async () => {
    const { controller, remote } = setup();
    await controller.select(ref);
    controller.updateEdit({ title: "Saved title" });
    await controller.previewAction("save_revision");
    await controller.confirmAction();
    expect(controller.getSnapshot().edit?.metadata.title).toBe("Saved title");
    expect(controller.dirty).toBe(true);
    remote.request.mockResolvedValueOnce(answer({ ...job(), status: "succeeded" }));
    await controller.refreshJob("job-test");
    await Promise.resolve(); await Promise.resolve();
    expect(controller.dirty).toBe(false);
    expect(remote.request).toHaveBeenCalledWith({ operation: "inspect", contentRef: ref }, expect.any(AbortSignal));
  });

  it("suppresses stale search answers even when the transport ignores cancellation", async () => {
    const { controller, remote } = setup();
    let oldResolve!: (value: RemoteResult<WorkbenchAnswer>) => void;
    const request = vi.fn((input: WorkbenchRequest, _signal?: AbortSignal): Promise<RemoteResult<WorkbenchAnswer>> => input.operation === "search" && input.query === "old" ? new Promise(resolve => { oldResolve = resolve; }) : Promise.resolve(answer(page("New"))));
    controller.connect({ ...remote, request });
    const first = controller.search("old");
    await controller.search("new");
    expect(request.mock.calls[0]?.[1]?.aborted).toBe(true);
    oldResolve(answer(page("Old")));
    await first;
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("New");
    expect(controller.getSnapshot().query).toBe("new");
  });

  it("cleans subscriptions and aborts in-flight requests on dispose without late commits", async () => {
    const controller = new WorkbenchController(() => undefined);
    let signal: AbortSignal | undefined;
    let finish!: (value: RemoteResult<WorkbenchAnswer>) => void;
    controller.connect({ request: (_request, value) => { signal = value; return new Promise(resolve => { finish = resolve; }); }, intentTask: vi.fn() });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const search = controller.search("one");
    unsubscribe();
    const listenerCalls = listener.mock.calls.length;
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    finish(answer(page("Late")));
    await search;
    expect(controller.getSnapshot().page).toBeNull();
    expect(listener).toHaveBeenCalledTimes(listenerCalls);
  });

  it("uses get_job/cancel_job and preserves uncertain outcomes without retrying writes", async () => {
    const { controller, request } = setup();
    await controller.refresh();
    await controller.cancelJob("job-test");
    await controller.refreshJob("job-test");
    expect(request).toHaveBeenCalledWith({ operation: "cancel_job", jobId: "job-test" }, expect.any(AbortSignal));
    expect(request).toHaveBeenCalledWith({ operation: "get_job", jobId: "job-test" }, expect.any(AbortSignal));
    expect(terminalJob({ ...job(), status: "reconcile_required" })).toBe(true);
    expect(request.mock.calls.some(([request]) => request.operation === "start_action")).toBe(false);
  });

  it("does not change library selection behind an unsaved editor and consumes a confirmed transition once", async () => {
    const { controller } = setup(); await controller.select(ref);
    controller.updateEdit({ title: "Keep before selecting a video" });
    const navigate = vi.fn(); controller.requestNavigation(navigate);
    expect(controller.getSnapshot().leaveRequest).toEqual({ kind: "navigate" });
    expect(navigate).not.toHaveBeenCalled();
    controller.cancelLeave(); await controller.confirmLeave();
    expect(controller.dirty).toBe(true); expect(navigate).not.toHaveBeenCalled();
    controller.requestNavigation(navigate); await controller.confirmLeave(); await controller.confirmLeave();
    expect(controller.dirty).toBe(false); expect(navigate).toHaveBeenCalledTimes(1);
    controller.dispose(); controller.requestNavigation(navigate); expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("asks before closing dirty edits, supports cancellation, and discards only after confirmation", async () => {
    const { controller } = setup();
    controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Keep this unsaved title" });
    controller.requestClose();
    expect(controller.getSnapshot()).toMatchObject({ open: true, leaveRequest: { kind: "close" }, edit: { metadata: { title: "Keep this unsaved title" } } });
    controller.cancelLeave();
    expect(controller.getSnapshot().leaveRequest).toBeNull();
    expect(controller.getSnapshot().open).toBe(true);
    expect(controller.dirty).toBe(true);
    controller.requestClose(); await controller.confirmLeave();
    expect(controller.getSnapshot()).toMatchObject({ open: false, leaveRequest: null, notice: null });
    expect(controller.dirty).toBe(false);
    expect(controller.getSnapshot().edit?.metadata.title).toBe(metadata.title);
  });

  it("asks before discarding and keeps the article open after confirmation", async () => {
    const { controller } = setup();
    controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ html: "<p>Unsaved body</p>" });
    controller.requestDiscard();
    expect(controller.getSnapshot().leaveRequest).toEqual({ kind: "discard" });
    expect(controller.dirty).toBe(true);
    controller.cancelLeave();
    expect(controller.getSnapshot().edit?.html).toBe("<p>Unsaved body</p>");
    controller.requestDiscard(); await controller.confirmLeave();
    expect(controller.getSnapshot()).toMatchObject({ open: true, selected: ref, leaveRequest: null });
    expect(controller.dirty).toBe(false);
  });

  it("clears transient operation and creation intents on close without discarding edits", async () => {
    const { controller, request } = setup();
    controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Preserved edit" });
    await controller.previewAction("save_revision");
    await controller.previewCreation({ title: "New fixture", sourceUrl: "", kind: "article" });
    expect(controller.getSnapshot().actionPreview).not.toBeNull();
    expect(controller.getSnapshot().creation).not.toBeNull();
    controller.close();
    expect(controller.getSnapshot()).toMatchObject({ actionPreview: null, creation: null, edit: { metadata: { title: "Preserved edit" } } });
    request.mockClear();
    await controller.confirmAction(); await controller.confirmCreation();
    expect(request).not.toHaveBeenCalled();
  });

  it("loads a requested different article only after the unsaved-edit confirmation", async () => {
    const { controller, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "inspect" && input.contentRef === otherRef ? Promise.resolve(answer({ ...document, contentRef: otherRef, metadata: { ...metadata, title: "Other article" } })) : original(input, signal));
    await controller.select(ref); controller.updateEdit({ title: "Unsaved first article" });
    request.mockClear();
    await controller.select(otherRef);
    expect(controller.getSnapshot().leaveRequest).toEqual({ kind: "select", contentRef: otherRef });
    expect(request).not.toHaveBeenCalled();
    expect(controller.getSnapshot().selected).toBe(ref);
    controller.cancelLeave();
    expect(controller.getSnapshot().edit?.metadata.title).toBe("Unsaved first article");
    await controller.select(otherRef); await controller.confirmLeave();
    expect(controller.getSnapshot()).toMatchObject({ selected: otherRef, document: { contentRef: otherRef }, edit: { metadata: { title: "Other article" } }, leaveRequest: null, notice: null });
    expect(request).toHaveBeenCalledWith({ operation: "inspect", contentRef: otherRef }, expect.any(AbortSignal));
  });

  it("reads status without indexing, searching, changing view, or replacing unsaved edits and notices", async () => {
    const { controller, request } = setup();
    await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Still being edited" });
    await controller.select(otherRef);
    controller.navigate("settings");
    const before = controller.getSnapshot();
    request.mockClear();
    request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job(), status: "running" }] }));
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "snapshot" }, expect.any(AbortSignal));
    expect(controller.getSnapshot().view).toBe("settings");
    expect(controller.getSnapshot().edit).toBe(before.edit);
    expect(controller.getSnapshot().notice).toBe(before.notice);
    expect(controller.getSnapshot().leaveRequest).toEqual(before.leaveRequest);
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("running");
  });

  it("retains newer edits when status observes success for a previously submitted edit", async () => {
    const { controller, request } = setup();
    await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Submitted title" });
    await controller.previewAction("save_revision"); await controller.confirmAction();
    controller.navigate("articles"); controller.updateEdit({ title: "Newer unsaved title" });
    request.mockClear();
    request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job(), status: "succeeded" }] }));
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "snapshot" }, expect.any(AbortSignal));
    expect(controller.getSnapshot().view).toBe("articles");
    expect(controller.getSnapshot().edit?.metadata.title).toBe("Newer unsaved title");
    expect(controller.dirty).toBe(true);
  });

  it("reconciles the exact unchanged submitted save from status without navigating to jobs", async () => {
    const { controller, request } = setup();
    await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Submitted title" });
    await controller.previewAction("save_revision"); await controller.confirmAction();
    controller.navigate("agent");
    request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job(), status: "succeeded" }] }));
    await controller.refreshStatus(); await Promise.resolve(); await Promise.resolve();
    expect(controller.getSnapshot().view).toBe("agent");
    expect(controller.dirty).toBe(false);
  });

  it("keeps manual job reads and cancellation on the user's current view", async () => {
    const { controller } = setup();
    await controller.refresh(); controller.navigate("settings");
    await controller.refreshJob("job-test");
    expect(controller.getSnapshot().view).toBe("settings");
    await controller.cancelJob("job-test");
    expect(controller.getSnapshot().view).toBe("settings");
    await controller.previewCreation({ title: "A new item", kind: "article", sourceUrl: "" });
    await controller.confirmCreation();
    expect(controller.getSnapshot().view).toBe("jobs");
  });

  it("does not overlap status reads or clear an unrelated notice while a read is pending", async () => {
    const { controller, request } = setup();
    await controller.select(ref); controller.updateEdit({ title: "Pending edit" }); await controller.select(otherRef);
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    request.mockClear(); request.mockReturnValueOnce(pending.promise);
    const first = controller.refreshStatus();
    await controller.refreshStatus();
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().pending).toContain("status");
    expect(controller.getSnapshot().notice?.code).toBe("UNSAVED_EDIT");
    pending.resolve(answer(snapshot)); await first;
    expect(controller.getSnapshot().pending).not.toContain("status");
  });

  it("does not advance query or cursor history until search succeeds, and preserves the page on failure", async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce(answer({ ...page("First"), nextCursor: "cursor-1" }));
    await controller.search("committed");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(pending.promise);
    const next = controller.nextPage();
    expect(controller.getSnapshot().cursors).toEqual([]);
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("First");
    pending.resolve(answer({ ...page("Second"), nextCursor: "cursor-2" })); await next;
    expect(controller.getSnapshot().cursors).toEqual(["cursor-1"]);
    request.mockResolvedValueOnce(failedAnswer("SEARCH_FAILED")); await controller.nextPage();
    expect(controller.getSnapshot().cursors).toEqual(["cursor-1"]);
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("Second");
    request.mockResolvedValueOnce(failedAnswer("SEARCH_FAILED")); await controller.search("failed query");
    expect(controller.getSnapshot().query).toBe("committed");
    expect(controller.getSnapshot().cursors).toEqual(["cursor-1"]);
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("Second");
  });

  it("preserves the current pagination during refresh and reopening", async () => {
    const { controller, request } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "search" ? Promise.resolve(answer({ ...page(input.cursor ? "Second" : "First"), nextCursor: input.cursor ? null : "cursor-1" })) : original(input, signal));
    await controller.search("article"); await controller.nextPage();
    await controller.refresh();
    expect(controller.getSnapshot().cursors).toEqual(["cursor-1"]);
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("Second");
    controller.close(); request.mockClear(); controller.open();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request).toHaveBeenCalledWith({ operation: "search", query: "article", pageSize: 20, cursor: "cursor-1" }, expect.any(AbortSignal));
    expect(controller.getSnapshot().cursors).toEqual(["cursor-1"]);
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("Second");
  });

  it("resets a stale cursor to the first page with an explicit notice and no write retry", async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce(answer({ ...page("First"), nextCursor: "cursor-1" })); await controller.search("article");
    request.mockResolvedValueOnce(answer(page("Second"))); await controller.nextPage();
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "search" && input.cursor ? Promise.resolve(failedAnswer("CURSOR_STALE")) : original(input, signal));
    request.mockClear(); await controller.refresh();
    expect(controller.getSnapshot().cursors).toEqual([]);
    expect(controller.getSnapshot().notice).toMatchObject({ code: "CURSOR_STALE", kind: "info" });
    expect(request.mock.calls.filter(([input]) => input.operation === "search").map(([input]) => input)).toEqual([{ operation: "search", query: "article", pageSize: 20, cursor: "cursor-1" }, { operation: "search", query: "article", pageSize: 20 }]);
    expect(request.mock.calls.some(([input]) => input.operation === "start_action")).toBe(false);
  });

  it("does not let an earlier refresh abort a newer explicit search", async () => {
    const { controller, request } = setup();
    await controller.search("old");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "refresh" ? pending.promise : original(input, signal));
    const refreshing = controller.refresh(); await controller.search("new");
    request.mockClear(); pending.resolve(answer(snapshot)); await refreshing;
    expect(controller.getSnapshot().query).toBe("new");
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts and clears unavailable requests, ignoring late responses even after reconnecting", async () => {
    const { controller, remote } = setup();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    remote.request.mockReturnValueOnce(pending.promise);
    const old = controller.search("old connection");
    const signal = remote.request.mock.calls[0]![1]!;
    controller.unavailable();
    expect(signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ connected: false, pending: [] });
    const replacementRequest = vi.fn(async () => answer(page("New connection")));
    controller.connect({ ...remote, request: replacementRequest });
    await controller.search("new connection");
    pending.resolve(answer(page("Late old connection"))); await old;
    expect(controller.getSnapshot()).toMatchObject({ connected: true, query: "new connection", pending: [] });
    expect(controller.getSnapshot().page?.items[0]?.title).toBe("New connection");
    expect(replacementRequest).toHaveBeenCalledTimes(1);
  });

  it("force-closes safely without discarding dirty edits or accepting a late status response", async () => {
    const { controller, request } = setup();
    controller.open(); await controller.refresh(); await controller.select(ref); controller.updateEdit({ title: "Kept across unmount" });
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(pending.promise);
    const reading = controller.refreshStatus(); const signal = request.mock.calls.at(-1)![1]!;
    controller.close();
    expect(signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ open: false, pending: [], edit: { metadata: { title: "Kept across unmount" } } });
    pending.resolve(answer({ ...snapshot, jobs: [job()] })); await reading;
    expect(controller.getSnapshot().snapshot?.jobs).toEqual([]);
    expect(controller.dirty).toBe(true);
  });

  it.each(["snapshot-first", "job-first", "cancel-first"] as const)("merges %s concurrent responses without regressing succeeded to running at the same revision", async order => {
    const { controller, request } = setup(); await controller.refresh(); controller.navigate("agent");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    const original = request.getMockImplementation()!;
    const delayedOperation = order === "snapshot-first" ? "snapshot" : order === "job-first" ? "get_job" : "cancel_job";
    request.mockImplementation((input, signal) => input.operation === delayedOperation ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job(), status: "succeeded" }] })) : input.operation === "get_job" ? Promise.resolve(answer({ ...job(), status: "succeeded" })) : original(input, signal));
    const first = order === "snapshot-first" ? controller.refreshStatus() : order === "job-first" ? controller.refreshJob("job-test") : controller.cancelJob("job-test");
    if (order === "snapshot-first") await controller.refreshJob("job-test"); else await controller.refreshStatus();
    pending.resolve(answer(order === "snapshot-first" ? { ...snapshot, jobs: [{ ...job(), status: "running" }] } : { ...job(), status: "running" })); await first;
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded");
    expect(controller.getSnapshot().snapshot?.revision).toBe(1);
    expect(controller.getSnapshot().view).toBe("agent");
  });

  it("retains a confirmed terminal result over a newer same-generation nonterminal snapshot", async () => {
    const { controller, request } = setup(); await controller.refresh();
    request.mockResolvedValueOnce(answer({ ...job(), status: "succeeded" })); await controller.refreshJob("job-test");
    request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job(), status: "running" }] })); await controller.refreshStatus();
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded");
  });

  it("accepts terminal advancement from an older request without rolling back newer snapshot metadata", async () => {
    const { controller, request } = setup(); await controller.refresh(); controller.navigate("jobs");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>();
    request.mockReturnValueOnce(pending.promise);
    const olderRefresh = controller.refresh();
    request.mockResolvedValueOnce(answer({ ...snapshot, revision: 2, jobs: [{ ...job(), status: "running" }] }));
    await controller.refreshStatus();
    pending.resolve(answer({ ...snapshot, revision: 1, jobs: [{ ...job(), status: "succeeded" }] })); await olderRefresh;
    expect(controller.getSnapshot().snapshot?.revision).toBe(2);
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded");
  });

  it("retains a newly submitted job omitted from an older in-flight snapshot", async () => {
    const { controller, request } = setup(); await controller.refresh();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(pending.promise);
    const olderStatus = controller.refreshStatus();
    await controller.previewCreation({ title: "New item", sourceUrl: "", kind: "article" });
    await controller.confirmCreation();
    expect(controller.getSnapshot().snapshot?.jobs[0]?.action).toBe("create_content");
    pending.resolve(answer(snapshot)); await olderStatus;
    expect(controller.getSnapshot().snapshot?.jobs).toHaveLength(1);
    expect(controller.getSnapshot().snapshot?.jobs[0]?.action).toBe("create_content");
    expect(request.mock.calls.filter(([input]) => input.operation === "create_content" && input.applyIntentId)).toHaveLength(1);
  });

  it("keeps cancel writes independently busy while reads complete, and accepts their final outcome", async () => {
    const { controller, request } = setup(); await controller.refresh();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    let cancelSignal: AbortSignal | undefined;
    request.mockImplementation((input, signal) => {
      if (input.operation === "cancel_job") { cancelSignal = signal; return pending.promise; }
      if (input.operation === "get_job") return Promise.resolve(answer({ ...job(), status: "running" }));
      return original(input, signal);
    });
    const cancelling = controller.cancelJob("job-test");
    expect(controller.getSnapshot().pending).toContain("job-cancel:job-test");
    const reading = controller.refreshJob("job-test");
    expect(controller.getSnapshot().pending).toContain("job-read:job-test");
    await reading; await controller.cancelJob("job-test");
    expect(cancelSignal?.aborted).toBe(false);
    expect(controller.getSnapshot().pending).toEqual(["job-cancel:job-test"]);
    expect(request.mock.calls.filter(([input]) => input.operation === "cancel_job")).toHaveLength(1);
    pending.resolve(answer({ ...job(), status: "cancelled" })); await cancelling;
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("cancelled");
    expect(controller.getSnapshot().pending).toEqual([]);
  });

  it("accepts new-generation recovery and ignores an old-generation job response", async () => {
    const { controller, request } = setup(); await controller.refresh();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "get_job" ? pending.promise : original(input, signal));
    const oldReading = controller.refreshJob("job-test");
    request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "generation-new", jobs: [{ ...job(), status: "reconcile_required" }] }));
    await controller.refreshStatus();
    pending.resolve(answer({ ...job(), status: "succeeded" })); await oldReading;
    expect(controller.getSnapshot().snapshot).toMatchObject({ generationId: "generation-new", jobs: [{ status: "reconcile_required" }] });
    request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [{ ...job(), status: "running" }] })); await controller.refreshStatus();
    expect(controller.getSnapshot().snapshot?.generationId).toBe("generation-new");
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("reconcile_required");
  });

  it("allows a new-generation snapshot to replace the previous generation's terminal observations", async () => {
    const { controller, request } = setup(); await controller.refresh();
    request.mockResolvedValueOnce(answer({ ...job(), status: "reconcile_required" })); await controller.refreshJob("job-test");
    request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "generation-recovered", jobs: [{ ...job(), status: "succeeded" }] })); await controller.refreshStatus();
    expect(controller.getSnapshot().snapshot).toMatchObject({ generationId: "generation-recovered", jobs: [{ status: "succeeded" }] });
  });

  it.each(["select", "edit", "edit-then-discard", "reload"] as const)("does not queue an old task brief after %s changed the article context", async change => {
    const prompt = acceptPrompt(); const { controller, request } = setup({ prompt }); await controller.select(ref);
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "task_brief" ? pending.promise : original(input, signal));
    const task = controller.taskBrief("research");
    if (change === "select") await controller.select(otherRef);
    else if (change === "reload") await controller.select(ref);
    else { controller.updateEdit({ title: "Changed while brief was loading" }); if (change === "edit-then-discard") controller.discardEdits(); }
    pending.resolve(answer({ contentRef: ref, action: "research", revisionDigest: document.revisionDigest, prompt: "Obsolete saved-article brief" })); await task;
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice?.code).toBe("TASK_BRIEF_STALE");
  });

  it("does not queue a Host brief for a different saved revision", async () => {
    const prompt = acceptPrompt(); const { controller, request } = setup({ prompt }); await controller.select(ref);
    request.mockResolvedValueOnce(answer({ contentRef: ref, action: "review", revisionDigest: "sha256:another-revision", prompt: "Different revision brief" }));
    await controller.taskBrief("review");
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice?.code).toBe("TASK_BRIEF_STALE");
  });
});

describe("version and evidence reads follow selected article and Host generation", () => {
  const history = { contentRef: ref, versions: [], notes: [] };
  const evidence = { id: "review:fixture", revisionDigest: document.revisionDigest, current: true, format: "wemedia.review/v1", body: "Exact safe report", details: null, coverage: null, image: null, notes: [] };
  it("clears already visible history and evidence on Host replacement", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.select(ref);
    f.request.mockResolvedValueOnce(answer(history)); await f.controller.loadHistory();
    f.request.mockResolvedValueOnce(answer(evidence)); await f.controller.readEvidence(evidence.id);
    expect(f.controller.getSnapshot()).toMatchObject({ history, evidence, evidenceRequested: evidence.id });
    f.request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "generation-replaced" })); await f.controller.refreshStatus();
    expect(f.controller.getSnapshot()).toMatchObject({ history: null, comparison: null, evidence: null, evidenceRequested: null });
    f.controller.dispose();
  });
  it("does not show a late report after close, disconnect, or selecting another article", async () => {
    for (const reset of ["close", "disconnect", "select"] as const) {
      const f = setup(); await f.controller.refresh(); await f.controller.select(ref);
      const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); f.request.mockReturnValueOnce(delayed.promise);
      const pending = f.controller.readEvidence(evidence.id);
      if (reset === "close") f.controller.close(); else if (reset === "disconnect") f.controller.unavailable(); else await f.controller.select("wmc:11111111-1111-4111-8111-111111111111");
      delayed.resolve(answer(evidence)); await pending;
      expect(f.controller.getSnapshot(), reset).toMatchObject({ evidence: null, evidenceRequested: null });
      f.controller.dispose();
    }
  });
  it("cancels an evidence read explicitly without overwriting editor state or running a write", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.select(ref);
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); f.request.mockClear(); f.request.mockReturnValueOnce(delayed.promise);
    const pending = f.controller.readEvidence(evidence.id); f.controller.closeEvidence();
    delayed.resolve(answer(evidence)); await pending;
    expect(f.controller.getSnapshot().document).toBe(document);
    expect(f.controller.getSnapshot().evidence).toBeNull();
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(["evidence_detail"]);
    f.controller.dispose();
  });
});


describe("Setup readback preserves article editing", () => {
  it("updates the main snapshot after a directory reload without replacing current unsaved article fields", async () => {
    let generationId = snapshot.generationId, hasWriteRoot = true;
    const { controller, request } = setup(undefined, input => {
      if (input.operation === "snapshot" || input.operation === "refresh") return { ...snapshot, generationId, settings: { ...snapshot.settings, hasWriteRoot } };
      if (input.operation === "setup_inspect") return { schemaVersion: "wemedia.setup/v1", generationId, roots: [], writeRoots: [], selection: { rootIds: [], writeRootId: hasWriteRoot ? "write" : null }, dataDirAvailable: true, issues: [], inputDigest: "sha256:setup" };
      if (input.operation === "inspect") return document;
      if (input.operation === "preview") return { revisionDigest: document.revisionDigest, html: "<p>Sandbox preview</p>", width: 390, imageCount: 0, issues: [] };
      return page();
    });
    await controller.refresh(); await controller.select(ref); controller.updateEdit({ title: "Keep unsaved title", html: "<p>Keep unsaved body</p>" });
    const manager = createSetupViewController(controller); await manager.inspect();
    generationId = "generation-setup-reloaded"; hasWriteRoot = false; await manager.inspect();
    expect(controller.getSnapshot().snapshot?.generationId).toBe(generationId);
    expect(controller.getSnapshot().snapshot?.settings.hasWriteRoot).toBe(false);
    expect(controller.getSnapshot().selected).toBe(ref); expect(controller.getSnapshot().edit?.metadata.title).toBe("Keep unsaved title");
    expect(controller.getSnapshot().edit?.html).toBe("<p>Keep unsaved body</p>"); expect(controller.dirty).toBe(true);
    expect(request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(1);
    manager.dispose(); controller.dispose();
  });
});


describe("submission acknowledgement and Agent handoff races", () => {
  it.each(["snapshot", "get_job"] as const)("reconciles an article save observed through %s before its submission reply", async operation => {
    const { controller, request } = setup(); controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Saved title" }); await controller.previewAction("save_revision");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "start_action" ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job(), status: "succeeded" }] })) : input.operation === "get_job" ? Promise.resolve(answer({ ...job(), status: "succeeded" })) : original(input, signal));
    request.mockClear(); const saving = controller.confirmAction();
    if (operation === "snapshot") await controller.refreshStatus(); else await controller.refreshJob("job-test");
    pending.resolve(answer(job())); await saving; await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded"); expect(controller.dirty).toBe(false);
    expect(request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => input.operation === "search")).toHaveLength(1);
    await controller.refreshStatus(); expect(request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(1);
    controller.dispose();
  });
  it.each(["failed", "newer_edit"] as const)("retains article edits when early save evidence is %s", async mode => {
    const { controller, request } = setup(); controller.open(); await controller.refresh(); await controller.select(ref);
    controller.updateEdit({ title: "Submitted title" }); await controller.previewAction("save_revision");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "start_action" ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, jobs: [{ ...job(), status: mode === "failed" ? "failed" : "succeeded" }] })) : original(input, signal));
    const saving = controller.confirmAction(); if (mode === "newer_edit") controller.updateEdit({ title: "Newer title" });
    await controller.refreshStatus(); pending.resolve(answer(job())); await saving;
    expect(controller.dirty).toBe(true); expect(controller.getSnapshot().edit?.metadata.title).toBe(mode === "failed" ? "Submitted title" : "Newer title");
    controller.dispose();
  });
  it.each(["session", "generation"] as const)("does not queue a delayed Agent brief after changing %s", async change => {
    const first = { prompt: acceptPrompt() }, second = { prompt: acceptPrompt() }; let current: SessionTarget = first;
    const fixture = setup(); const controller = new WorkbenchController(() => current); controller.connect(fixture.remote); await controller.refresh(); await controller.select(ref);
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(), original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation((input, signal) => input.operation === "task_brief" ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, generationId: "new-generation" })) : original(input, signal));
    const work = controller.taskBrief("research"); if (change === "session") current = second; else await controller.refreshStatus();
    pending.resolve(answer({ contentRef: ref, action: "research", revisionDigest: document.revisionDigest, prompt: "Bound research brief" })); await work;
    expect(first.prompt).not.toHaveBeenCalled(); expect(second.prompt).not.toHaveBeenCalled(); expect(controller.getSnapshot().notice?.code).toBe("TASK_BRIEF_STALE");
    controller.dispose(); fixture.controller.dispose();
  });
  it.each(["session", "content", "edit_then_discard", "generation", "close", "disconnect"] as const)("does not hand off an old WeChat intent after %s changes", async change => {
    const first = { prompt: acceptPrompt() }, second = { prompt: acceptPrompt() }; let current: SessionTarget = first;
    const fixture = setup(); const controller = new WorkbenchController(() => current); controller.connect(fixture.remote); await controller.refresh(); await controller.select(ref); await controller.previewAction("create_draft");
    const pending = deferred<Awaited<ReturnType<WemediaRemote["intentTask"]>>>(); fixture.intentTask.mockImplementation(() => pending.promise);
    const work = controller.confirmAction();
    if (change === "session") current = second;
    else if (change === "content") await controller.select(otherRef);
    else if (change === "edit_then_discard") { controller.updateEdit({ title: "Temporary edit" }); controller.discardEdits(); }
    else if (change === "generation") { fixture.request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "new-generation" })); await controller.refreshStatus(); }
    else if (change === "close") controller.close(); else controller.unavailable();
    pending.resolve({ ok: true, value: { ok: true, code: "AGENT_TASK_READY", prompt: "Old article intent" } }); await work;
    expect(first.prompt).not.toHaveBeenCalled(); expect(second.prompt).not.toHaveBeenCalled();
    if (!["close", "disconnect"].includes(change)) expect(controller.getSnapshot().notice?.code).toBe("INTENT_EXPIRED");
    expect(fixture.request.mock.calls.some(([input]) => input.operation === "start_action")).toBe(false);
    controller.dispose(); fixture.controller.dispose();
  });
});

describe("job content navigation resolves article and media types", () => {
  const channel = (publicationType: PublishingType, contentRef = otherRef): ChannelInspection => ({ contentRef, publicationType, revisionDigest: "sha256:media", capabilities: [], targets: [], jobs: [], matrix: [], issues: [] });
  const media = (publicationType: "image_text" | "video"): PublicationDraft => ({ schemaVersion: "wemedia.publication-draft/v1", contentRef: otherRef, publicationType, title: "Media draft", body: "Body", media: [], coverItemId: null, channels: ["xiaohongshu"], revisionDigest: "sha256:media", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", readOnlySource: false, issues: [], publications: [] });
  it.each(["article", "image_text", "video"] as const)("opens a channel task's actual %s editor through read-only requests", async publicationType => {
    const { controller, request } = setup(); await controller.refresh(); controller.navigate("jobs"); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "channel_inspect" ? Promise.resolve(answer(channel(publicationType))) : input.operation === "publication_read" ? Promise.resolve(answer(media(publicationType as "image_text" | "video"))) : input.operation === "inspect" ? Promise.resolve(answer({ ...document, contentRef: otherRef })) : original(input, signal));
    request.mockClear(); await controller.openJobContent({ contentRef: otherRef, action: "channel_prepare" });
    expect(controller.getSnapshot().view).toBe("articles"); expect(controller.getSnapshot().selected).toBe(otherRef);
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(publicationType === "article" ? ["channel_inspect", "inspect", "preview"] : ["channel_inspect", "publication_read"]);
    expect(publicationType === "article" ? controller.getSnapshot().document?.contentRef : controller.getSnapshot().publication?.publicationType).toBe(publicationType === "article" ? otherRef : publicationType);
    expect(controller.getSnapshot().notice).toBeNull(); controller.dispose();
  });
  it("requires the unsaved-edit decision before probing or navigating away from a draft", async () => {
    const { controller, request } = setup(); await controller.select(ref); controller.updateEdit({ title: "Keep this" }); controller.navigate("jobs"); request.mockClear();
    await controller.openJobContent({ contentRef: otherRef, action: "channel_publish" });
    expect(request).not.toHaveBeenCalled(); expect(controller.getSnapshot().view).toBe("jobs"); expect(controller.getSnapshot().leaveRequest?.kind).toBe("navigate");
    controller.cancelLeave(); expect(controller.getSnapshot().edit?.metadata.title).toBe("Keep this"); controller.dispose();
  });
  it.each(["failure", "mismatched_content", "unsupported_type"] as const)("keeps the jobs page and avoids a guessed article read after %s", async failure => {
    const { controller, request } = setup(); await controller.refresh(); controller.navigate("jobs");
    request.mockResolvedValueOnce(failure === "failure" ? failedAnswer("CHANNEL_DISCOVERY_FAILED") : answer(failure === "mismatched_content" ? { ...channel("video"), contentRef: ref } : { ...channel("video"), publicationType: "unknown" }));
    request.mockClear(); await controller.openJobContent({ contentRef: otherRef, action: "channel_sync" });
    expect(controller.getSnapshot().view).toBe("jobs"); expect(controller.getSnapshot().notice?.kind).toBe("error"); expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["channel_inspect"]); controller.dispose();
  });
  it.each(["select", "edit", "close", "disconnect", "generation"] as const)("ignores a delayed type read after %s", async change => {
    const { controller, request } = setup(); await controller.refresh(); await controller.select(ref); controller.navigate("jobs");
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(), original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "channel_inspect" ? pending.promise : input.operation === "snapshot" ? Promise.resolve(answer({ ...snapshot, generationId: "new-generation" })) : original(input, signal));
    const opening = controller.openJobContent({ contentRef: otherRef, action: "channel_publish" });
    if (change === "select") await controller.select(ref); else if (change === "edit") controller.updateEdit({ title: "Still editing" }); else if (change === "close") controller.close(); else if (change === "disconnect") controller.unavailable(); else await controller.refreshStatus();
    request.mockClear(); pending.resolve(answer(channel("video"))); await opening;
    expect(controller.getSnapshot().selected).toBe(ref); expect(request.mock.calls.some(([input]) => input.operation === "publication_read")).toBe(false); controller.dispose();
  });
});


describe("reference-task handoff", () => {
  const ids = ["ref:11111111111111111111111111111111"];
  it("requires a selected native session", async () => {
    const f = setup(); f.controller.navigate("references");
    await expect(f.controller.queueReferenceTask(ids, "analyze", "")).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
  });
  it("reports completion only after native prompt acceptance", async () => {
    const prompt = acceptPrompt(), f = setup({ prompt }); f.controller.navigate("references");
    f.request.mockImplementation(async input => answer({ schemaVersion: "wemedia.reference-brief/v1", ids, action: "analyze", prompt: "Reference analysis" }));
    await f.controller.queueReferenceTask(ids, "analyze", "");
    expect(prompt).toHaveBeenCalledTimes(1);
    prompt.mockResolvedValue({ ok: false, error: { code: "internal", message: "Prompt rejected", details: {} } });
    await expect(f.controller.queueReferenceTask(ids, "analyze", "")).rejects.toMatchObject({ code: "internal" });
  });
  it("does not queue a late brief after the reference view closes", async () => {
    const prompt = acceptPrompt(), f = setup({ prompt }); f.controller.navigate("references");
    const response = deferred<RemoteResult<WorkbenchAnswer>>(); f.request.mockImplementation(() => response.promise);
    const task = f.controller.queueReferenceTask(ids, "analyze", "");
    f.controller.navigate("accounts"); response.resolve(answer({ schemaVersion: "wemedia.reference-brief/v1", ids, action: "analyze", prompt: "stale" }));
    await expect(task).rejects.toThrow(); expect(prompt).not.toHaveBeenCalled();
  });
});

describe("WeChat terminal jobs refresh the selected article", () => {
  const target = { targetRef: "wechat-target", title: metadata.title, label: "公众号草稿", sourceUrl: metadata.sourceUrl, verifiedRevision: document.revisionDigest, verifiedAt: "2026-09-10T00:00:00Z" };
  const refreshed: ArticleDocument = { ...document, targets: [target] };
  const mobile = { revisionDigest: document.revisionDigest, html: "<p>Refreshed preview</p>", width: 390 as const, imageCount: 0, issues: [] };
  const terminal = (action = "create_draft", status: WorkbenchJob["status"] = "succeeded"): WorkbenchJob => ({ ...job(action), status, sideEffect: action === "sync" ? "read" : "remote_draft", finishedAt: "2026-09-10T00:00:00Z" });
  async function fixture() {
    const f = setup(); f.controller.open(); await f.controller.refresh(); await f.controller.select(ref);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => input.operation === "inspect" ? Promise.resolve(answer(refreshed)) : input.operation === "preview" ? Promise.resolve(answer(mobile)) : original(input, signal));
    f.request.mockClear(); return f;
  }
  it("refreshes an Agent-created terminal job without changing the active view", async () => {
    const f = await fixture(); f.controller.navigate("agent");
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] }));
    await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.controller.getSnapshot().document?.targets).toEqual([target]));
    expect(f.controller.getSnapshot()).toMatchObject({ view: "agent", mobile, publicationRevision: 1 });
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(["snapshot", "inspect", "preview"]);
    f.controller.dispose();
  });
  it.each(["create_draft", "update_draft", "sync"].flatMap(action => (["succeeded", "failed", "cancelled", "timed_out", "reconcile_required"] as const).map(status => ({ action, status }))))("reads $action / $status once, without treating a failed job as success", async ({ action, status }) => {
    const f = await fixture(), result = terminal(action, status);
    f.request.mockResolvedValueOnce(answer(result)); await f.controller.refreshJob(result.jobId);
    await vi.waitFor(() => expect(f.controller.getSnapshot().mobile).toEqual(mobile));
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [result] })); await f.controller.refreshStatus();
    f.request.mockResolvedValueOnce(answer(result)); await f.controller.refreshJob(result.jobId);
    expect(f.request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(1);
    expect(f.request.mock.calls.filter(([input]) => input.operation === "preview")).toHaveLength(1);
    expect(f.controller.getSnapshot().publicationRevision).toBe(1);
    expect(f.controller.getSnapshot().snapshot?.jobs[0]?.status).toBe(status);
    expect(f.request.mock.calls.some(([input]) => ["start_action", "preview_action"].includes(input.operation))).toBe(false);
    f.controller.dispose();
  });
  it("preserves dirty edits and requests a manual refresh without starting a read loop", async () => {
    const f = await fixture(); f.controller.updateEdit({ title: "Keep my changes" });
    const before = f.controller.getSnapshot();
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    expect(f.controller.getSnapshot()).toMatchObject({ document: before.document, edit: before.edit, mobile: before.mobile, publicationRevision: 0, notice: { code: "WECHAT_RESULT_REFRESH_REQUIRED" } });
    expect(f.controller.dirty).toBe(true);
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(["snapshot", "snapshot"]);
    f.controller.dispose();
  });
  it("keeps an in-flight report and existing history open when only the draft target changes", async () => {
    const f = await fixture(), history = { contentRef: ref, versions: [], notes: [] };
    const report = { id: "review:wechat", revisionDigest: document.revisionDigest, current: true, format: "wemedia.review/v1", body: "Existing report", details: null, coverage: null, image: null, notes: [] };
    f.request.mockResolvedValueOnce(answer(history)); await f.controller.loadHistory();
    const pending = deferred<RemoteResult<WorkbenchAnswer>>(); f.request.mockReturnValueOnce(pending.promise);
    const read = f.controller.readEvidence(report.id), reportSignal = f.request.mock.calls.at(-1)?.[1];
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.controller.getSnapshot().mobile).toEqual(mobile));
    expect(reportSignal?.aborted).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({ history, evidenceRequested: report.id });
    pending.resolve(answer(report)); await read;
    expect(f.controller.getSnapshot().evidence).toEqual(report);
    f.controller.dispose();
  });
  it.each(["inspect", "preview"].flatMap(phase => ["select", "reselect", "edit", "edit_then_discard", "generation", "disconnect", "close"].map(change => ({ phase, change }))))("ignores a late $phase after $change", async ({ phase, change }) => {
    const f = await fixture(), pending = deferred<RemoteResult<WorkbenchAnswer>>(), original = f.request.getMockImplementation()!;
    let held = true;
    f.request.mockImplementation((input, signal) => input.operation === phase && held ? pending.promise : original(input, signal));
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([input]) => input.operation === phase)).toBe(true));
    const signal = f.request.mock.calls.find(([input]) => input.operation === phase)?.[1]; held = false;
    if (change === "select" || change === "reselect") {
      const selectedRef = change === "select" ? otherRef : ref;
      f.request.mockImplementation((input, nextSignal) => input.operation === "inspect" ? Promise.resolve(answer({ ...document, contentRef: selectedRef, metadata: { ...metadata, title: "New selection" } })) : original(input, nextSignal));
      await f.controller.select(selectedRef);
    } else if (change === "edit" || change === "edit_then_discard") { f.controller.updateEdit({ title: "New browser edit" }); if (change === "edit_then_discard") f.controller.discardEdits(); }
    else if (change === "generation") { f.request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "new-host" })); await f.controller.refreshStatus(); }
    else if (change === "disconnect") f.controller.unavailable(); else f.controller.close();
    const before = f.controller.getSnapshot();
    expect(signal?.aborted).toBe(true);
    pending.resolve(answer(phase === "inspect" ? refreshed : mobile));
    await vi.waitFor(() => expect(f.controller.getSnapshot().pending).not.toContain("wechat-result"));
    expect(f.controller.getSnapshot()).toMatchObject({ selected: before.selected, document: before.document, edit: before.edit, mobile: before.mobile, publicationRevision: before.publicationRevision });
    if (change === "edit" || change === "edit_then_discard") expect(f.controller.getSnapshot().notice?.code).toBe("WECHAT_RESULT_REFRESH_REQUIRED");
    f.controller.dispose();
  });
  it.each(["inspect_failure", "preview_failure", "content_mismatch", "revision_mismatch"])("keeps the original document and reports $0 without automatic retries", async failure => {
    const f = await fixture(), before = f.controller.getSnapshot(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, signal) => input.operation === "inspect" && failure === "inspect_failure" || input.operation === "preview" && failure === "preview_failure" ? Promise.resolve(failedAnswer("READ_FAILED")) : input.operation === "inspect" && failure === "content_mismatch" ? Promise.resolve(answer({ ...refreshed, contentRef: otherRef })) : input.operation === "preview" && failure === "revision_mismatch" ? Promise.resolve(answer({ ...mobile, revisionDigest: "different-revision" })) : original(input, signal));
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.controller.getSnapshot().notice?.code).toBe("WECHAT_RESULT_REFRESH_FAILED"));
    expect(f.controller.getSnapshot()).toMatchObject({ document: before.document, edit: before.edit, mobile: before.mobile, publicationRevision: 0 });
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    expect(f.request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(1);
    f.controller.dispose();
  });
  it("coalesces a snapshot's terminal jobs and skips unrelated contents and actions", async () => {
    const f = await fixture();
    const jobs = [terminal(), { ...terminal("update_draft", "failed"), jobId: "second-job" }, { ...terminal(), jobId: "other-article", contentRef: otherRef }, { ...terminal("channel_stage"), jobId: "other-channel" }];
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.controller.getSnapshot().mobile).toEqual(mobile));
    expect(f.request.mock.calls.map(([input]) => input.operation)).toEqual(["snapshot", "inspect", "preview"]);
    expect(f.controller.getSnapshot().publicationRevision).toBe(1);
    f.controller.dispose();
  });
  it("replaces an older result read when a new terminal job arrives", async () => {
    const f = await fixture(), pending = deferred<RemoteResult<WorkbenchAnswer>>(), original = f.request.getMockImplementation()!;
    let first = true;
    f.request.mockImplementation((input, signal) => { if (input.operation === "inspect" && first) { first = false; return pending.promise; } return original(input, signal); });
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal()] })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([input]) => input.operation === "inspect")).toBe(true));
    const oldSignal = f.request.mock.calls.find(([input]) => input.operation === "inspect")?.[1];
    f.request.mockResolvedValueOnce(answer({ ...snapshot, jobs: [terminal(), { ...terminal("sync"), jobId: "new-terminal" }] })); await f.controller.refreshStatus();
    await vi.waitFor(() => expect(f.controller.getSnapshot().mobile).toEqual(mobile));
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(answer(document)); await Promise.resolve(); await Promise.resolve();
    expect(f.controller.getSnapshot().document?.targets).toEqual([target]);
    expect(f.controller.getSnapshot().publicationRevision).toBe(1);
    expect(f.request.mock.calls.filter(([input]) => input.operation === "inspect")).toHaveLength(2);
    f.controller.dispose();
  });
});

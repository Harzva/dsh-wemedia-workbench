import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { WorkbenchController } from "../../src/client/controller.ts";
import type { ArtifactRef } from "../../src/domain/content.ts";
import type { AiWorkflowResult, ArticleDocument, WorkbenchAnswer, WorkbenchPage, WorkbenchRequest, WorkbenchSnapshot, WorkbenchValue, WorkflowImportKind, WorkflowImportPreview } from "../../src/domain/workbench.ts";
import type { WemediaRemote } from "../../src/remote/descriptors.ts";

const ref = "wmc:11111111-1111-4111-8111-111111111111" as const;
const otherRef = "wmc:22222222-2222-4222-8222-222222222222" as const;
const artifact: ArtifactRef = { rootId: "read", relativePath: "reports/review.json" };
const otherArtifact: ArtifactRef = { rootId: "read", relativePath: "reports/draft.json" };
const document: ArticleDocument = {
  contentRef: ref, document: { rootId: "read", relativePath: "article/wechat-document.json" }, htmlArtifact: { rootId: "read", relativePath: "article/article.html" },
  metadata: { articleId: "article-test", title: "Original title", author: "", digest: "Original digest", kind: "article", titlePrefix: "", sourceUrl: "https://example.org/source", pdfUrl: "", codeUrl: "" },
  html: "<p>Body</p>", markdown: "Body", revisionDigest: "sha256:revision-a", assets: [], readOnlySource: true, reviews: [], targets: [], issues: [],
};
const snapshot: WorkbenchSnapshot = { schemaVersion: "wemedia.workbench/v1", generationId: "generation-test", revision: 1, settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: true, issues: [] }, capabilities: [], jobs: [], supportedChannels: ["wechat"] };
const page = (title = "Original title"): WorkbenchPage => ({ items: [{ contentRef: ref, title, articleId: "article-test", rootLabel: "Reader", channel: "wechat", readOnlySource: true, status: "discovered", issueCount: 0 }], total: 1, nextCursor: null, revision: 1 });
const aiResult = (operation: AiWorkflowResult["operation"]): AiWorkflowResult => ({ operation, revisionDigest: document.revisionDigest, mode: "ai", sourceKind: "markdown", status: "pass", code: "AI_OK", previewFidelity: "exact", issues: [] });
const importPreview = (kind: WorkflowImportKind = "review", source: ArtifactRef = artifact): WorkflowImportPreview => ({
  intent: { intentId: `intent-import-${kind}`, generationId: snapshot.generationId, contentRef: ref, action: `import_${kind}`, sideEffect: "local_write", targetSummary: "Import existing material", inputDigest: "sha256:exact-input", expectedChanges: [], blockingGateCodes: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false },
  kind, material: { id: "material-test", kind, source, sourceDigest: "sha256:source", sourceFormat: "json", title: "Imported material", status: "current", boundRevision: document.revisionDigest, boundHtmlDigest: "sha256:html", reviewKind: kind === "review" ? "facts" : null, findings: [], warnings: [], recordedAt: "2026-01-01T00:00:00.000Z" },
  requiresIdentityCheck: kind === "draft", summary: ["Import existing material"],
});
const importedDocument = (): ArticleDocument => ({ ...document, workflowImports: [importPreview().material] });
const answer = (value: WorkbenchValue): RemoteResult<WorkbenchAnswer> => ({ ok: true, value: { ok: true, value, revision: 1 } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
const controllers: WorkbenchController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });
async function setup() {
  const request = vi.fn(async (input: WorkbenchRequest, _signal?: AbortSignal): Promise<RemoteResult<WorkbenchAnswer>> => {
    switch (input.operation) {
      case "snapshot": case "refresh": return answer(snapshot);
      case "search": return answer(page());
      case "inspect": return answer(input.contentRef === ref ? document : { ...document, contentRef: otherRef, metadata: { ...document.metadata, title: "Other article" } });
      case "preview": return answer({ revisionDigest: document.revisionDigest, html: "<p>Body</p>", width: 390, imageCount: 0, issues: [] });
      case "ai_inspect": case "ai_preview": return answer(aiResult(input.operation));
      case "preview_workflow_import": return answer(importPreview(input.kind, input.artifact));
      case "apply_workflow_import": return answer(importedDocument());
      default: throw new Error(`Unexpected workflow operation: ${input.operation}`);
    }
  });
  const intentTask = vi.fn<WemediaRemote["intentTask"]>().mockRejectedValue(new Error("Workflow reuse must not hand off a legacy action"));
  const remote = { request, intentTask } satisfies WemediaRemote;
  const controller = new WorkbenchController(() => undefined);
  controllers.push(controller); controller.connect(remote);
  await controller.refresh(); await controller.select(ref); request.mockClear();
  return { controller, request, intentTask, remote };
}

describe("Workbench Client native workflow reuse", () => {
  it("uses the four exact operations, then records imported material without a legacy job or Agent handoff", async () => {
    const { controller, request, intentTask } = await setup();
    await controller.aiInspect(); expect(controller.getSnapshot().aiWorkflow).toEqual(aiResult("ai_inspect"));
    await controller.aiPreview(); expect(controller.getSnapshot().aiWorkflow).toEqual(aiResult("ai_preview"));
    await controller.previewWorkflowImport("review", artifact);
    expect(controller.getSnapshot().workflowImport).toEqual({ kind: "review", artifact, preview: importPreview() });
    await controller.applyWorkflowImport();
    expect(request.mock.calls.map(([input]) => input)).toEqual([
      { operation: "ai_inspect", contentRef: ref }, { operation: "ai_preview", contentRef: ref },
      { operation: "preview_workflow_import", contentRef: ref, kind: "review", artifact },
      { operation: "apply_workflow_import", intentId: "intent-import-review" },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ document: importedDocument(), workflowImport: null, notice: { kind: "info" } });
    expect(controller.getSnapshot().snapshot?.jobs).toEqual([]);
    expect(controller.dirty).toBe(false); expect(intentTask).not.toHaveBeenCalled();
  });

  it("blocks all four entry points on unsaved edits without making a request", async () => {
    const { controller, request } = await setup();
    await controller.previewWorkflowImport("review", artifact);
    controller.updateEdit({ title: "Keep this edit" }); request.mockClear();
    await controller.aiInspect(); await controller.aiPreview();
    await controller.previewWorkflowImport("draft", otherArtifact); await controller.applyWorkflowImport();
    expect(request).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ edit: { metadata: { title: "Keep this edit" } }, notice: { code: "UNSAVED_EDIT" }, aiWorkflow: null, workflowImport: null });
  });

  it("coalesces double clicks for each exact operation while its first request is pending", async () => {
    const cases = [
      { operation: "ai_inspect", invoke: (c: WorkbenchController) => c.aiInspect(), result: aiResult("ai_inspect") },
      { operation: "ai_preview", invoke: (c: WorkbenchController) => c.aiPreview(), result: aiResult("ai_preview") },
      { operation: "preview_workflow_import", invoke: (c: WorkbenchController) => c.previewWorkflowImport("review", artifact), result: importPreview() },
      { operation: "apply_workflow_import", invoke: (c: WorkbenchController) => c.applyWorkflowImport(), result: importedDocument() },
    ];
    for (const testCase of cases) {
      const { controller, request } = await setup();
      if (testCase.operation === "apply_workflow_import") await controller.previewWorkflowImport("review", artifact);
      const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockClear(); request.mockReturnValueOnce(delayed.promise);
      const first = testCase.invoke(controller); await testCase.invoke(controller);
      expect(request.mock.calls.map(([input]) => input.operation), testCase.operation).toEqual([testCase.operation]);
      expect(request.mock.calls[0]?.[1]?.aborted, testCase.operation).toBe(false);
      delayed.resolve(answer(testCase.result)); await first;
      expect(controller.getSnapshot().pending, testCase.operation).toEqual([]);
    }
  });

  it("cancels an import preview and ignores its late response without enabling apply", async () => {
    const { controller, request } = await setup();
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(delayed.promise);
    const pending = controller.previewWorkflowImport("review", artifact);
    controller.discardWorkflowImport(); expect(request.mock.calls[0]?.[1]?.aborted).toBe(true);
    delayed.resolve(answer(importPreview())); await pending; await controller.applyWorkflowImport();
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ workflowImport: null, notice: null, pending: [] });
  });

  it("keeps the newer source and kind when an older import preview finishes late", async () => {
    const { controller, request } = await setup();
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(delayed.promise);
    const old = controller.previewWorkflowImport("review", artifact);
    await controller.previewWorkflowImport("draft", otherArtifact);
    expect(request.mock.calls[0]?.[1]?.aborted).toBe(true);
    delayed.resolve(answer(importPreview())); await old;
    expect(controller.getSnapshot().workflowImport).toEqual({ kind: "draft", artifact: otherArtifact, preview: importPreview("draft", otherArtifact) });
    expect(controller.getSnapshot().notice).toBeNull();
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["preview_workflow_import", "preview_workflow_import"]);
  });

  it("does not overwrite a newer edit or article selection with a late apply response", async () => {
    for (const change of ["edit", "selection"] as const) {
      const { controller, request } = await setup(); await controller.previewWorkflowImport("review", artifact);
      const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockClear(); request.mockReturnValueOnce(delayed.promise);
      const pending = controller.applyWorkflowImport();
      if (change === "edit") controller.updateEdit({ title: "Newer edit" }); else await controller.select(otherRef);
      const before = controller.getSnapshot(); expect(request.mock.calls[0]?.[1]?.aborted, change).toBe(true);
      delayed.resolve(answer(importedDocument())); await pending;
      expect(controller.getSnapshot().selected, change).toBe(before.selected);
      expect(controller.getSnapshot().document, change).toBe(before.document);
      expect(controller.getSnapshot().edit, change).toBe(before.edit);
      expect(controller.getSnapshot().workflowImport, change).toBeNull();
      expect(controller.getSnapshot().notice, change).toBe(before.notice);
      expect(request.mock.calls.some(([input]) => input.operation === "search"), change).toBe(false);
    }
  });

  it("clears workflow state on Host generation change and rejects an older in-flight AI result", async () => {
    const { controller, request } = await setup(); await controller.aiInspect(); await controller.previewWorkflowImport("review", artifact);
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockReturnValueOnce(delayed.promise);
    const pending = controller.aiPreview();
    request.mockResolvedValueOnce(answer({ ...snapshot, generationId: "generation-new" })); await controller.refreshStatus();
    expect(controller.getSnapshot()).toMatchObject({ aiWorkflow: null, workflowImport: null });
    delayed.resolve(answer(aiResult("ai_preview"))); await pending;
    const count = request.mock.calls.length; await controller.applyWorkflowImport();
    expect(request.mock.calls).toHaveLength(count);
    expect(controller.getSnapshot()).toMatchObject({ aiWorkflow: null, workflowImport: null, notice: null });
  });

  it("aborts workflow reads and clears their state on reconnect, disconnect, and close", async () => {
    for (const reset of ["reconnect", "disconnect", "close"] as const) {
      const { controller, request, remote } = await setup(); await controller.aiInspect(); await controller.previewWorkflowImport("review", artifact);
      const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); request.mockClear(); request.mockReturnValueOnce(delayed.promise);
      const pending = controller.aiPreview();
      if (reset === "reconnect") controller.connect({ ...remote });
      else if (reset === "disconnect") controller.unavailable(); else controller.close();
      const before = controller.getSnapshot(); expect(request.mock.calls[0]?.[1]?.aborted, reset).toBe(true);
      expect(before, reset).toMatchObject({ aiWorkflow: null, workflowImport: null });
      delayed.resolve(answer(aiResult("ai_preview"))); await pending;
      expect(controller.getSnapshot(), reset).toMatchObject({ aiWorkflow: null, workflowImport: null, pending: [] });
      expect(controller.getSnapshot().notice, reset).toBe(before.notice);
    }
  });

  it("rejects blocked, expired, and invalid-expiry import intents before applying", async () => {
    const { controller, request } = await setup();
    const cases: [Partial<Pick<WorkflowImportPreview["intent"], "blockingGateCodes" | "expiresAt">>, string][] = [
      [{ blockingGateCodes: ["IMPORT_BLOCKED"] }, "GATES_BLOCKED"],
      [{ expiresAt: "2000-01-01T00:00:00.000Z" }, "INTENT_EXPIRED"],
      [{ expiresAt: "not-a-date" }, "INTENT_EXPIRED"],
    ];
    for (const [change, code] of cases) {
      const preview = importPreview(); request.mockResolvedValueOnce(answer({ ...preview, intent: { ...preview.intent, ...change } }));
      await controller.previewWorkflowImport("review", artifact); request.mockClear(); await controller.applyWorkflowImport();
      expect(request, code).not.toHaveBeenCalled(); expect(controller.getSnapshot().notice?.code).toBe(code);
    }
  });

  it("rejects operation and revision mismatches for both AI entry points", async () => {
    const { controller, request } = await setup();
    for (const operation of ["ai_inspect", "ai_preview"] as const) for (const mismatch of ["operation", "revision"] as const) {
      const result = aiResult(operation);
      request.mockResolvedValueOnce(answer({ ...result, ...(mismatch === "operation" ? { operation: operation === "ai_inspect" ? "ai_preview" : "ai_inspect" } : { revisionDigest: "sha256:different" }) }));
      if (operation === "ai_inspect") await controller.aiInspect(); else await controller.aiPreview();
      expect(controller.getSnapshot().aiWorkflow, `${operation}/${mismatch}`).toBeNull();
      expect(controller.getSnapshot().notice?.code, `${operation}/${mismatch}`).toBe("AI_RESULT_STALE");
    }
  });

  it("refreshes the current list once after import while preserving query, cursor, selection, edits, and success notice", async () => {
    const { controller, request } = await setup(); controller.open(); await controller.refresh();
    await controller.search("current query", ["cursor-1"]); controller.navigate("agent");
    await controller.previewWorkflowImport("review", artifact);
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!;
    request.mockImplementation((input, signal) => input.operation === "search" ? delayed.promise : original(input, signal)); request.mockClear();
    await controller.applyWorkflowImport(); controller.updateEdit({ title: "Edited during list refresh" });
    const before = controller.getSnapshot(); expect(before.notice?.kind).toBe("info");
    delayed.resolve(answer(page("Updated list status"))); await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input)).toEqual([{ operation: "apply_workflow_import", intentId: "intent-import-review" }, { operation: "search", query: "current query", pageSize: 20, cursor: "cursor-1" }]);
    expect(controller.getSnapshot()).toMatchObject({ query: "current query", cursors: ["cursor-1"], selected: ref, view: "agent", page: { items: [{ title: "Updated list status" }] } });
    expect(controller.getSnapshot().document).toBe(before.document); expect(controller.getSnapshot().edit).toBe(before.edit);
    expect(controller.getSnapshot().notice).toBe(before.notice); expect(controller.dirty).toBe(true);
    await controller.applyWorkflowImport(); expect(request).toHaveBeenCalledTimes(2);
  });

  it("lets an existing user search settle before refreshing its newly committed query after import", async () => {
    const { controller, request } = await setup(); controller.open(); await controller.refresh();
    await controller.previewWorkflowImport("review", artifact);
    const delayed = deferred<RemoteResult<WorkbenchAnswer>>(); const original = request.getMockImplementation()!; let searches = 0;
    request.mockImplementation((input, signal) => input.operation === "search" && ++searches === 1 ? delayed.promise : original(input, signal)); request.mockClear();
    const searching = controller.search("new query", ["new-cursor"]); await controller.applyWorkflowImport();
    expect(searches).toBe(1); expect(request.mock.calls[0]?.[1]?.aborted).toBe(false);
    const notice = controller.getSnapshot().notice;
    delayed.resolve(answer(page("User search"))); await searching; await vi.waitFor(() => expect(controller.getSnapshot().pending).toEqual([]));
    expect(request.mock.calls.map(([input]) => input)).toEqual([
      { operation: "search", query: "new query", pageSize: 20, cursor: "new-cursor" }, { operation: "apply_workflow_import", intentId: "intent-import-review" },
      { operation: "search", query: "new query", pageSize: 20, cursor: "new-cursor" },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ query: "new query", cursors: ["new-cursor"], selected: ref });
    expect(controller.getSnapshot().notice).toBe(notice);
  });
});

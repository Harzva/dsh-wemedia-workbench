import { Context } from "@deepseek-ai/cordis";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiWorkflowResult, ArticleDocument, WorkbenchAnswer, WorkbenchCaller, WorkflowImportPreview, WorkflowMaterial } from "../../src/domain/workbench.ts";
import { createWorkbenchTools, registerWorkbenchTools, WORKBENCH_TOOL_NAMES } from "../../src/host/tools.ts";
import type { WorkbenchAdapter } from "../../src/ports/workbench.ts";
import { fixture } from "../workbench/fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const newTools = ["wemedia_ai_inspect", "wemedia_ai_preview", "wemedia_preview_workflow_import", "wemedia_apply_workflow_import"] as const;
const revision = `sha256:${"a".repeat(64)}`;
const material: WorkflowMaterial = { id: "import:fixture", kind: "review", source: { rootId: "write", relativePath: "review.json" }, sourceDigest: revision, sourceFormat: "wemedia.review/v1", title: "Review fixture", status: "current", boundRevision: revision, boundHtmlDigest: "", reviewKind: "facts", findings: ["Source facts checked"], warnings: [], recordedAt: "2026-09-07T00:00:00.000Z" };
const diagnostics = (operation: AiWorkflowResult["operation"], revisionDigest = revision): AiWorkflowResult => ({ operation, revisionDigest, mode: "ai", sourceKind: "markdown", status: "warn", code: "WECHAT_AI_DEGRADED", previewFidelity: "degraded", issues: [{ gateId: "wechat-ai", version: "1", status: "warn", code: "WECHAT_AI_DEGRADED", safeMessage: "Native preview is degraded", inputDigest: revisionDigest, evidenceRefs: [] }] });
function success<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const tools = createWorkbenchTools(f.service, { bind: () => ({ caller: { kind: "agent", sessionId: "workflow-fixture" }, dispose() {} }) });
  const tool = (name: string) => tools.find(entry => entry.name === name)!;
  const invoke = async (name: string, args: unknown): Promise<WorkbenchAnswer> => {
    const selected = tool(name);
    const result = await selected.execute(args, { signal: new AbortController().signal } as ToolRunContext);
    expect(validateJsonSchemaValue(selected.output.schema, result)).toEqual([]);
    return result as WorkbenchAnswer;
  };
  const validate = (name: string, value: unknown) => validateJsonSchemaValue(tool(name).output.schema, { ok: true, value, revision: 1 });
  return { ...f, tools, tool, invoke, validate };
}

describe("history and evidence native tool parity", () => {
  it("uses the shared service and strict canonical schemas for history, compare and full evidence", async () => {
    const f = await setup(), doc = await f.create();
    await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: { ...doc.metadata, title: "Second tool version" }, html: doc.html, markdown: doc.markdown });
    const current = await f.documents.read(doc.contentRef); await f.reviewAll(current);
    const history = success<import("../../src/domain/inspection.ts").VersionHistory>(await f.invoke("wemedia_history", { contentRef: doc.contentRef }));
    const compared = await f.invoke("wemedia_compare_versions", { contentRef: doc.contentRef, fromId: history.versions[1]!.id, toId: history.versions[0]!.id });
    expect(compared).toMatchObject({ ok: true, value: { fields: [{ path: "标题", oldText: doc.metadata.title, newText: current.metadata.title }] } });
    const reviewed = await f.documents.read(doc.contentRef);
    const detail = await f.invoke("wemedia_evidence_detail", { contentRef: doc.contentRef, evidenceId: reviewed.reviews[0]!.id });
    expect(detail).toMatchObject({ ok: true, value: { current: true, coverage: { complete: true } } });
    expect(f.remoteCalls()).toBe(0);
    expect(f.validate("wemedia_evidence_detail", { ...success<any>(detail), secret: "not-allowed" }).length).toBeGreaterThan(0);
  });
});

describe("workflow Host tools and strict canonical values", () => {
  it.each(newTools)("delegates %s to the shared service with the real caller and signal", async name => {
    const caller: WorkbenchCaller = { kind: "agent", sessionId: "real-fixture", callId: "trusted-call" };
    const request = vi.fn(async (): Promise<WorkbenchAnswer> => ({ ok: false, error: { code: "FIXTURE_BLOCK", safeMessage: "Fixture", retryable: false } }));
    const dispose = vi.fn();
    const bind = vi.fn(() => ({ caller, dispose }));
    const tool = createWorkbenchTools({ request }, { bind }).find(entry => entry.name === name)!;
    const signal = new AbortController().signal;
    const operation = name.slice("wemedia_".length);
    const args = operation === "apply_workflow_import" ? { intentId: "intent:fixture" } : operation === "preview_workflow_import" ? { contentRef: "wmc:fixture", kind: "review", artifact: material.source } : { contentRef: "wmc:fixture" };
    const exec = { signal } as ToolRunContext;
    const answer = await tool.execute(args, exec);
    expect(request).toHaveBeenCalledExactlyOnceWith({ ...args, operation }, caller, signal);
    expect(bind).toHaveBeenCalledExactlyOnceWith(exec);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(validateJsonSchemaValue(tool.output.schema, answer)).toEqual([]);
  });
  it.each(["ai_inspect", "ai_preview"] as const)("returns revision-bound %s diagnostics without writing review evidence", async operation => {
    const f = await setup(); const document = await f.create();
    const inspect = vi.fn<NonNullable<WorkbenchAdapter["inspectAi"]>>(async (action, doc) => diagnostics(action, doc.revisionDigest));
    f.adapter.inspectAi = inspect;
    const answer = success<AiWorkflowResult>(await f.invoke(`wemedia_${operation}`, { contentRef: document.contentRef }));
    expect(answer).toEqual(diagnostics(operation, document.revisionDigest));
    expect(inspect.mock.calls[0]?.[0]).toBe(operation);
    expect((await f.documents.read(document.contentRef)).reviews).toEqual([]);
    expect(f.remoteCalls()).toBe(0);
    expect(JSON.stringify(answer)).not.toMatch(/htmlArtifact|markdownText|remoteId|accountRef/u);
  });
  it.each(["ai_inspect", "ai_preview"] as const)("rejects undeclared or malformed %s output fields", async operation => {
    const f = await setup();
    const valid = diagnostics(operation);
    expect(f.validate(`wemedia_${operation}`, valid)).toEqual([]);
    for (const fields of [{ operation: operation === "ai_inspect" ? "ai_preview" : "ai_inspect" }, { mode: "api" }, { sourceKind: "text" }, { status: "success" }, { previewFidelity: "rendered" }, { html: "<p>Undeclared raw source</p>" }, { output_file: "raw-preview.html" }, { issues: [{ ...valid.issues[0], raw: "Undeclared native log" }] }, { issues: [{ status: "warn", code: "INCOMPLETE" }] }]) {
      expect(f.validate(`wemedia_${operation}`, { ...valid, ...fields }).length).toBeGreaterThan(0);
    }
  });
  it("strictly types optional document workflowImports without requiring them on old documents", async () => {
    const f = await setup(); const document = await f.create();
    const { workflowImports: _, ...legacy } = document;
    expect(f.validate("wemedia_inspect_content", legacy)).toEqual([]);
    expect(f.validate("wemedia_apply_workflow_import", { ...legacy, workflowImports: [] })).toEqual([]);
    for (const status of ["current", "partial", "historical", "stale"] as const) {
      expect(f.validate("wemedia_apply_workflow_import", { ...legacy, workflowImports: [{ ...material, status, reviewKind: null }] })).toEqual([]);
    }
    for (const fields of [{ remoteId: "PrivateRemoteID" }, { accountRef: "private-account" }, { uploads: [] }, { target: {} }, { source: { ...material.source, absolutePath: "private-source.json" } }, { status: "approved" }, { kind: "upload" }, { reviewKind: "unknown" }, { findings: [true] }, { warnings: "invalid" }]) {
      expect(f.validate("wemedia_apply_workflow_import", { ...legacy, workflowImports: [{ ...material, ...fields }] }).length).toBeGreaterThan(0);
    }
    for (const workflowImports of [null, {}, [null], [{ id: material.id }]]) expect(f.validate("wemedia_inspect_content", { ...legacy, workflowImports }).length).toBeGreaterThan(0);
  });
  it("previews and applies a current review through the real import service only once", async () => {
    const f = await setup(); const document = await f.create();
    await writeFile(resolve(f.writePath, "review.json"), JSON.stringify({ schemaVersion: "wemedia.review/v1", kind: "facts", revisionDigest: document.revisionDigest, verdict: "pass", findings: ["Fixture sources checked"] }));
    const preview = success<WorkflowImportPreview>(await f.invoke("wemedia_preview_workflow_import", { contentRef: document.contentRef, kind: "review", artifact: material.source }));
    expect(preview).toMatchObject({ kind: "review", material: { status: "current", reviewKind: "facts", boundRevision: document.revisionDigest }, requiresIdentityCheck: false, intent: { action: "import_review", sideEffect: "local_write", approved: false } });
    expect((await f.documents.read(document.contentRef)).workflowImports ?? []).toEqual([]);
    const imported = success<ArticleDocument>(await f.invoke("wemedia_apply_workflow_import", { intentId: preview.intent.intentId }));
    expect(imported.workflowImports).toHaveLength(1);
    expect(imported.reviews).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "facts", reviewer: "agent", valid: true })]));
    expect(await f.invoke("wemedia_apply_workflow_import", { intentId: preview.intent.intentId })).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(f.remoteCalls()).toBe(0);
    for (const fields of [{ target: { mediaId: "PrivateRemoteID" } }, { material: { ...preview.material, uploads: [] } }, { requiresIdentityCheck: "true" }, { material: { ...preview.material, source: { ...preview.material.source, absolutePath: "private.json" } } }]) {
      expect(f.validate("wemedia_preview_workflow_import", { ...preview, ...fields }).length).toBeGreaterThan(0);
    }
  });
  it("imports an exact draft identity without exposing it or claiming current-content readback", async () => {
    const f = await setup(); const seed = await f.create();
    const document = await f.documents.create({ contentRef: `wmc:${randomUUID()}`, metadata: { ...seed.metadata, articleId: "aaai26-12345", sourceUrl: "https://ojs.aaai.org/index.php/AAAI/article/view/12345" } });
    await writeFile(resolve(f.writePath, "drafts.json"), JSON.stringify({ schema: "aaai2026-agent-draft-summary.v1", conference: "AAAI 2026", batch: "Fixture batch", article_count: 1, results: [{ article_id: document.metadata.articleId, media_id: "PrivateRemoteIdentity", title: "Original remote title" }] }));
    const identity = vi.fn(async () => ({ ok: true, code: "WECHAT_DRAFT_IDENTITY_VERIFIED", accountRef: f.adapter.accountRef()!, verifiedAt: f.now() }));
    f.adapter.verifyDraftIdentity = identity;
    const preview = success<WorkflowImportPreview>(await f.invoke("wemedia_preview_workflow_import", { contentRef: document.contentRef, kind: "draft", artifact: { rootId: "write", relativePath: "drafts.json" } }));
    expect(preview.requiresIdentityCheck).toBe(true);
    expect(identity).not.toHaveBeenCalled();
    const imported = success<ArticleDocument>(await f.invoke("wemedia_apply_workflow_import", { intentId: preview.intent.intentId }));
    expect(identity).toHaveBeenCalledTimes(1);
    expect(imported.targets).toEqual([expect.objectContaining({ title: "Original remote title", verifiedRevision: "", verifiedAt: "" })]);
    expect(JSON.stringify([preview, imported])).not.toMatch(/PrivateRemoteIdentity|accountRef|media_id|uploads/u);
    expect(f.remoteCalls()).toBe(0);
  });
  it.each(newTools)("rejects forged caller, authorization and operation fields for %s", async name => {
    const f = await setup(); const document = await f.create();
    const args = name === "wemedia_apply_workflow_import" ? { intentId: "intent:fixture" } : name === "wemedia_preview_workflow_import" ? { contentRef: document.contentRef, kind: "review", artifact: material.source } : { contentRef: document.contentRef };
    for (const extra of [{ caller: { kind: "user" } }, { approved: true }, { operation: "apply_workflow_import" }]) {
      expect(await f.invoke(name, { ...args, ...extra })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    }
    await expect(f.invoke(name, {})).rejects.toThrow();
    expect(f.remoteCalls()).toBe(0);
  });
  it("rejects invalid import artifact kinds and nested private fields before service work", async () => {
    const f = await setup(); const document = await f.create();
    for (const fields of [{ kind: "upload" }, { artifact: { ...material.source, absolutePath: "private.json" } }, { artifact: { rootId: 1, relativePath: "review.json" } }]) {
      await expect(f.invoke("wemedia_preview_workflow_import", { contentRef: document.contentRef, kind: "review", artifact: material.source, ...fields })).rejects.toThrow();
    }
    for (const relativePath of ["../review.json", "/review.json", "review.txt"]) {
      expect(await f.invoke("wemedia_preview_workflow_import", { contentRef: document.contentRef, kind: "review", artifact: { rootId: "write", relativePath } })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    }
  });
  it.each(newTools)("disposes the caller binding when %s fails unexpectedly", async name => {
    const dispose = vi.fn();
    const tools = createWorkbenchTools({ request: async () => { throw new Error("Fixture failure"); } }, { bind: () => ({ caller: { kind: "agent" }, dispose }) });
    const args = name === "wemedia_apply_workflow_import" ? { intentId: "intent:fixture" } : name === "wemedia_preview_workflow_import" ? { contentRef: "wmc:fixture", kind: "review", artifact: material.source } : { contentRef: "wmc:fixture" };
    await expect(tools.find(tool => tool.name === name)!.execute(args, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow("Fixture failure");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it.each(newTools)("rolls back only owned registrations when %s collides", name => {
    const registered = new Set<string>([name]);
    const ctx = { tools: { register: vi.fn((tool: ToolDefinition) => {
      if (registered.has(tool.name)) throw new Error("Fixture collision");
      registered.add(tool.name);
      return () => { registered.delete(tool.name); };
    }) } } as unknown as Context;
    expect(() => registerWorkbenchTools(ctx, { request: async () => ({ ok: false, error: { code: "FIXTURE", safeMessage: "Fixture", retryable: false } }) }, { bind: () => ({ caller: { kind: "agent" }, dispose() {} }) })).toThrow("Fixture collision");
    expect([...registered]).toEqual([name]);
  });
  it("registers all tools and disposes all owned registrations exactly once", () => {
    const disposers = WORKBENCH_TOOL_NAMES.map(() => vi.fn());
    let index = 0;
    const register = vi.fn(() => disposers[index++]!);
    const dispose = registerWorkbenchTools({ tools: { register } } as unknown as Context, { request: async () => ({ ok: false, error: { code: "FIXTURE", safeMessage: "Fixture", retryable: false } }) }, { bind: () => ({ caller: { kind: "agent" }, dispose() {} }) });
    expect(register).toHaveBeenCalledTimes(WORKBENCH_TOOL_NAMES.length);
    dispose(); dispose();
    for (const callback of disposers) expect(callback).toHaveBeenCalledTimes(1);
  });
});

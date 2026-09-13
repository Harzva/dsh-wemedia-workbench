import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, renderToolsSdk, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolExecutionInput, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../src/domain/json.ts";
import type { LibraryDetail, LibraryItem, LibraryMediaChunk, LibraryPage } from "../../src/domain/contentLibrary.ts";
import type { PublicationDraft, PublicationDraftPreview, PublicationEdit } from "../../src/domain/publicationDraft.ts";
import type { BatchPreflightResult } from "../../src/domain/batchPreflight.ts";
import type { ContentMappingView, MappingApplyResult, MappingPreview } from "../../src/domain/contentMapping.ts";
import type { SetupApplyResult, SetupInspection, SetupPreview } from "../../src/domain/setup.ts";
import type { WorkbenchAnswer } from "../../src/domain/workbench.ts";
import { WorkbenchFault } from "../../src/domain/workbench.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { createWorkbenchTools, registerWorkbenchTools, WORKBENCH_TOOL_NAMES } from "../../src/host/tools.ts";

const contentRef = "wmc:11111111-1111-4111-8111-111111111111" as const;
const digest = `sha256:${"a".repeat(64)}`;
const itemId = `library:${"b".repeat(64)}`;
const assetId = `publication-asset:${"c".repeat(64)}`;
const time = "2026-09-08T08:00:00Z";
const publication = { channel: "wechat", status: "draft", publishedAt: null, checkedAt: time, url: null, evidence: "local_draft", note: "Local draft" } as const;
const item: LibraryItem = { itemId, title: "CVPR article", kind: "article", publicationType: "article", publicationStatus: "draft", publications: [publication], taxonomy: { category: "conference", conference: "CVPR", year: 2026, tags: ["Agent"] }, origin: "local", rootLabel: "Articles", readOnly: true, legacyReadOnly: false, contentRef: null, mappingRef: contentRef, publicationRef: contentRef, createdAt: time, publishedAt: null, mediaType: null, bytes: 12, revisionDigest: digest, status: "draft", updatedAt: time };
const page: LibraryPage = { items: [item], facets: { categories: [{ value: "conference", count: 1 }], conferences: [{ value: "CVPR", count: 1 }], years: [{ value: 2026, count: 1 }], tags: [{ value: "Agent", count: 1 }] }, total: 1, nextCursor: null, revisionDigest: digest, issues: [], truncated: false };
const detail: LibraryDetail = { item, html: "<p>Local article</p>", markdown: null, issues: [] };
const chunk: LibraryMediaChunk = { itemId, revisionDigest: digest, offset: 0, totalBytes: 3, mediaType: "image/png", dataBase64: "YWJj", eof: true };
const edit: PublicationEdit = { title: "Image text", body: "Public text", media: [{ source: "library", itemId, revisionDigest: digest, caption: "Figure caption" }], coverItemId: itemId, channels: ["wechat", "zhihu", "xiaohongshu", "x"] };
const draft: PublicationDraft = { schemaVersion: "wemedia.publication-draft/v1", contentRef, publicationType: "image_text", ...edit, media: [{ ...edit.media[0]!, source: "draft", itemId: assetId, title: "Figure", kind: "image", mediaType: "image/png", bytes: 3 }], coverItemId: assetId, revisionDigest: digest, createdAt: time, updatedAt: time, readOnlySource: false, issues: [], publications: [publication] };
const draftPreview: PublicationDraftPreview = { publication: draft, summary: ["Save local draft"], intent: { intentId: "intent:publication", generationId: "generation:fixture", contentRef, action: "save_publication", sideEffect: "local_write", targetSummary: "Local publication draft", inputDigest: digest, expectedChanges: ["Save revision"], blockingGateCodes: [], expiresAt: time, approved: false } };
const batch: BatchPreflightResult = { schemaVersion: "wemedia.batch-preflight/v1", checkedAt: time, cancelled: false, results: [{ contentRef, publicationType: "image_text", revisionDigest: digest, channel: "xiaohongshu", status: "block", code: "ADAPTER_UNAVAILABLE", safeMessage: "No ready adapter", issues: ["Requires adapter"] }, { contentRef, publicationType: null, revisionDigest: null, channel: "zhihu", status: "warn", code: "SOURCE_UNAVAILABLE", safeMessage: "Source unavailable", issues: [] }] };
const source = { sourceRecordId: "source:one", title: "Source", rootId: "articles", rootLabel: "Articles", contentRef, digest };
const mapping: ContentMappingView = { schemaVersion: "wemedia.content-mapping/v1", generationId: "generation:fixture", revision: 3, contentRef, canonical: { sourceRecordId: source.sourceRecordId, sourceDigest: digest, selectedAt: time, available: true, stale: false, currentDigest: digest }, variants: [{ sourceRecordId: "source:variant", derivedFromRecordId: source.sourceRecordId, sourceDigest: digest, generatedDigest: digest, mappedAt: time, provenance: "explicit_mapping", channel: "zhihu", available: true, dirty: true, stale: false, currentDigest: digest }], sources: [source, { ...source, sourceRecordId: "source:unbound", contentRef: null }], total: 2, nextCursor: null, conflicts: [{ leftRecordId: "source:one", rightRecordId: "source:variant", evidenceCodes: ["SOURCE_CONFLICT"] }], revalidationRequired: true };
const mappingPreview: MappingPreview = { intentId: "intent:mapping", generationId: "generation:fixture", contentRef, operation: "map_variant", sideEffect: "local_write", inputDigest: digest, expiresAt: time, expectedRevision: 3, expectedChanges: ["Record variant"], sources: [source] };
const mappingApplied: MappingApplyResult = { intentId: "intent:mapping", contentRef, operation: "separate", revision: 4, detachedContentRefs: ["wmc:22222222-2222-4222-8222-222222222222"] };
const selection = { rootIds: ["articles"], writeRootId: "write" };
const setup: SetupInspection = { schemaVersion: "wemedia.setup/v1", generationId: "generation:fixture", roots: [{ id: "articles", label: "Articles", available: true, selected: true }], writeRoots: [{ id: "write", label: "New drafts", available: true, selected: true }], selection, dataDirAvailable: true, issues: [], inputDigest: digest };
const setupPreview: SetupPreview = { schemaVersion: "wemedia.setup/v1", generationId: "generation:fixture", intentId: "intent:setup", sideEffect: "local_write", inputDigest: digest, expiresAt: time, before: selection, after: { rootIds: [], writeRootId: null }, changes: ["Disable selected roots"], blockingCodes: [] };
const setupApplied: SetupApplyResult = { applied: true, selection: setupPreview.after, requiresReconnect: true };
const mediaRange = { itemId, revisionDigest: digest, offset: 0, length: 3 };
const cases: Array<{ operation: string; args: JsonObject; value: JsonObject; readOnly?: true }> = [
  { operation: "library_list", args: { channel: "wechat", timeField: "published", category: "conference", conference: "CVPR", year: 2026, tag: "Agent", query: "", publicationType: "article", updatedFrom: "2026-01-01T00:00:00Z", updatedTo: time, pageSize: 100 }, value: page, readOnly: true },
  { operation: "library_read", args: { itemId }, value: detail, readOnly: true },
  { operation: "library_media", args: mediaRange, value: chunk, readOnly: true },
  { operation: "publication_read", args: { contentRef }, value: draft, readOnly: true },
  { operation: "publication_media", args: { ...mediaRange, contentRef, itemId: assetId }, value: { ...chunk, itemId: assetId }, readOnly: true },
  { operation: "create_publication", args: { publicationType: "image_text", title: "Local draft" }, value: draftPreview },
  { operation: "preview_publication_save", args: { contentRef, expectedRevision: digest, edit }, value: draftPreview },
  { operation: "batch_preflight", args: { contentRefs: [contentRef], channels: ["wechat", "zhihu"] }, value: batch, readOnly: true },
  { operation: "mapping_inspect", args: { contentRef, query: "", pageSize: 100 }, value: mapping, readOnly: true },
  { operation: "mapping_preview", args: { change: { contentRef, operation: "map_variant", sourceRecordIds: ["source:variant"], channel: "zhihu" } }, value: mappingPreview },
  { operation: "mapping_apply", args: { intentId: "intent:mapping" }, value: mappingApplied },
  { operation: "setup_inspect", args: {}, value: setup, readOnly: true },
  { operation: "setup_preview", args: selection, value: setupPreview },
  { operation: "setup_apply", args: { intentId: "intent:setup" }, value: setupApplied },
];
const answer = (value: JsonObject): WorkbenchAnswer => ({ ok: true, value, revision: 3 });
function harness() {
  const request = vi.fn(async (input: unknown): Promise<WorkbenchAnswer> => {
    try { const decoded = decodeWorkbenchRequest(input); return answer(cases.find(test => test.operation === decoded.operation)!.value); }
    catch (error) { if (error instanceof WorkbenchFault) return { ok: false, error: { code: error.code, safeMessage: error.safeMessage, retryable: false } }; throw error; }
  });
  const dispose = vi.fn();
  const binder = { bind: () => ({ caller: { kind: "agent" as const, sessionId: "session:fixture" }, dispose }) };
  const target = { request }; const tools = createWorkbenchTools(target, binder);
  const tool = (operation: string): ToolDefinition => tools.find(tool => tool.name === `wemedia_${operation}`)!;
  const call = (operation: string, args: unknown) => tool(operation).execute(args, { signal: new AbortController().signal } as ToolRunContext);
  return { target, tools, tool, call, dispose, binder, request };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("P6 typed publication, mapping and setup tools", () => {
  it("projects exactly 45 tools and a deterministic fully structured Native/PTC SDK", () => {
    const f = harness();
    expect(WORKBENCH_TOOL_NAMES).toHaveLength(45); expect(new Set(WORKBENCH_TOOL_NAMES).size).toBe(45);
    const definitions = f.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema }));
    const sdk = renderToolsSdk(definitions); expect(sdk).toBe(renderToolsSdk([...definitions].reverse()));
    for (const field of ["publicationRef", "mappingRef", "facets", "timeField", "caption", "coverItemId", "generatedDigest", "dirty", "retainedSourceRecordIds", "blockingCodes", "requiresReconnect", "dataBase64"]) expect(sdk).toContain(field);
    for (const test of cases) {
      expect(WORKBENCH_TOOL_NAMES).toContain(`wemedia_${test.operation}`);
      expect(f.tool(test.operation).isConcurrencySafe?.(test.args)).toBe(test.readOnly ? true : undefined);
    }
    expect(WORKBENCH_TOOL_NAMES).not.toContain("run_code");
  });
  it.each(cases)("preserves every typed $operation field and rejects undeclared success fields", async test => {
    const f = harness(); const result = await f.call(test.operation, test.args);
    expect(result).toEqual(answer(test.value));
    expect(validateJsonSchemaValue(f.tool(test.operation).output.schema, result)).toEqual([]);
    expect(validateJsonSchemaValue(f.tool(test.operation).output.schema, answer({ ...test.value, privatePath: "UNDECLARED" })).length).toBeGreaterThan(0);
    expect(validateJsonSchemaValue(f.tool(test.operation).output.schema, answer({})).length).toBeGreaterThan(0);
    expect(f.request).toHaveBeenCalledWith({ ...test.args, operation: test.operation }, { kind: "agent", sessionId: "session:fixture" }, expect.any(AbortSignal));
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid nested output enums and fields instead of hiding them in generic JSON", () => {
    const f = harness();
    const invalid: Array<[string, JsonObject]> = [
      ["library_list", { ...page, items: [{ ...item, taxonomy: { category: "paper", conference: null, year: null, tags: [] } }] }],
      ["library_list", { ...page, facets: { ...page.facets!, tags: [{ value: "Agent", count: "one" }] } }],
      ["library_read", { ...detail, item: { ...item, mappingRef: {} } }],
      ["publication_read", { ...draft, media: [{ ...draft.media[0]!, absolutePath: "UNDECLARED" }] }],
      ["publication_read", { ...draft, publications: [{ ...publication, evidence: "approved" }] }],
      ["create_publication", { ...draftPreview, publication: { ...draft, readOnlySource: "true" } }],
      ["batch_preflight", { ...batch, results: [{ ...batch.results[0]!, status: "published" }] }],
      ["mapping_inspect", { ...mapping, canonical: { ...mapping.canonical!, sourcePath: "UNDECLARED" } }],
      ["mapping_inspect", { ...mapping, variants: [{ ...mapping.variants[0]!, dirty: "false" }] }],
      ["mapping_preview", { ...mappingPreview, sources: [{ ...source, digest: 1 }] }],
      ["mapping_apply", { ...mappingApplied, operation: "move_remote_history" }],
      ["setup_inspect", { ...setup, roots: [{ ...setup.roots[0]!, absolutePath: "UNDECLARED" }] }],
      ["setup_preview", { ...setupPreview, after: { rootIds: "articles", writeRootId: null } }],
      ["setup_apply", { ...setupApplied, requiresReconnect: false }],
    ];
    for (const [operation, value] of invalid) expect(validateJsonSchemaValue(f.tool(operation).output.schema, answer(value)).length, operation).toBeGreaterThan(0);
  });
  it.each(cases)("rejects top-level authorization injection and disposes the $operation caller", async test => {
    const f = harness();
    for (const extra of [{ caller: { kind: "user" } }, { approved: true }, { operation: "setup_apply" }]) expect(await f.call(test.operation, { ...test.args, ...extra })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    expect(f.dispose).toHaveBeenCalledTimes(3);
  });
  it("strictly discriminates mapping changes and nested publication fields before execution", async () => {
    const f = harness();
    for (const change of [
      { contentRef, operation: "map_variant", sourceRecordIds: ["one"] },
      { contentRef, operation: "bind", sourceRecordIds: ["one", "two"], channel: "wechat" },
      { contentRef, operation: "separate", sourceRecordIds: ["one", "two"] },
      { contentRef, operation: "select_canonical", sourceRecordIds: ["one"], absolutePath: "UNDECLARED" },
    ]) await expect(f.call("mapping_preview", { change })).rejects.toThrow();
    for (const modified of [{ ...edit, approved: true }, { ...edit, media: [{ ...edit.media[0]!, title: "Injected" }] }, { ...edit, channels: ["youtube"] }]) await expect(f.call("preview_publication_save", { contentRef, expectedRevision: digest, edit: modified })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
  });
  it("keeps semantic limits in the shared strict decoder for every new input family", async () => {
    const f = harness();
    const invalid: Array<[string, JsonObject]> = [
      ["library_list", { pageSize: 0 }], ["library_list", { pageSize: 101 }], ["library_list", { year: 2100 }],
      ["library_list", { updatedFrom: "2026-02-30T00:00:00Z" }], ["library_list", { updatedFrom: time, updatedTo: time }],
      ["library_read", { itemId: "/article.md" }], ["library_media", { ...mediaRange, length: 262145 }], ["library_media", { ...mediaRange, offset: -1 }],
      ["publication_read", { contentRef: "wmc:invalid" }], ["publication_media", { ...mediaRange, contentRef }],
      ["create_publication", { title: "x".repeat(201), publicationType: "video" }],
      ["preview_publication_save", { contentRef, expectedRevision: digest, edit: { ...edit, media: [...edit.media, ...edit.media] } }],
      ["preview_publication_save", { contentRef, expectedRevision: digest, edit: { ...edit, body: "x".repeat(30001) } }],
      ["preview_publication_save", { contentRef, expectedRevision: digest, edit: { ...edit, coverItemId: assetId } }],
      ["batch_preflight", { contentRefs: [contentRef, contentRef], channels: ["wechat"] }],
      ["batch_preflight", { contentRefs: [contentRef], channels: [] }],
      ["batch_preflight", { contentRefs: [contentRef], channels: ["wechat", "wechat"] }],
      ["mapping_inspect", { contentRef, pageSize: 101 }], ["mapping_preview", { change: { contentRef, operation: "select_canonical", sourceRecordIds: [] } }],
      ["mapping_preview", { change: { contentRef, operation: "bind", sourceRecordIds: ["one", "one"] } }],
      ["mapping_apply", { intentId: "" }], ["setup_preview", { rootIds: ["../articles"], writeRootId: null }],
      ["setup_preview", { rootIds: ["articles", "articles"], writeRootId: null }], ["setup_apply", { intentId: "" }],
    ];
    for (const [operation, args] of invalid) expect(await f.call(operation, args), operation).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
  });
  it("passes complete canonical values through actual Native and PTC validation, including policy denial", async () => {
    const f = harness(); const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(ToolRuntime, { mode: "both", maxParallelSubCalls: 2 }).await();
    await ctx.plugin(WorkerThreadCodeRuntime, { computeMs: 1000, maxWallMs: 10_000, maxOutputBytes: 512 * 1024, maxOldGenerationSizeMb: 128 }).await();
    ctx.effect(() => registerWorkbenchTools(ctx, f.target, f.binder));
    let id = 0;
    const call = (name: string, args: unknown) => ctx.tools.execute({ callId: `p6-${++id}` as ToolExecutionInput["callId"], name, arguments: args, signal: new AbortController().signal });
    for (const test of cases) {
      const direct = await call(`wemedia_${test.operation}`, test.args);
      const nested = await call("run_code", { code: `return await tools.wemedia_${test.operation}(${JSON.stringify(test.args)});`, description: "P6 offline typed contract" });
      expect(direct.isError, test.operation).toBe(false); expect(nested.isError, test.operation).toBe(false);
      expect(direct.value).toEqual(answer(test.value)); expect(nested.value).toEqual({ logs: [], result: direct.value });
    }
    // Disabling writes preserves readable saved drafts and the same typed media projection.
    f.request.mockImplementation(async () => answer({ ...draft, readOnlySource: true }));
    const readOnlyDirect = await call("wemedia_publication_read", { contentRef });
    const readOnlyPtc = await call("run_code", { code: `return await tools.wemedia_publication_read({contentRef:${JSON.stringify(contentRef)}});`, description: "P6 saved read-only draft" });
    expect(readOnlyDirect.isError).toBe(false); expect(readOnlyPtc.isError).toBe(false);
    expect(readOnlyDirect.value).toEqual(answer({ ...draft, readOnlySource: true }));
    expect(readOnlyPtc.value).toEqual({ logs: [], result: readOnlyDirect.value });
    f.request.mockClear();
    ctx.tools.guard(exec => exec.name === "wemedia_mapping_apply" ? "P6_POLICY_DENY" : undefined);
    for (const [name, args] of [["wemedia_mapping_apply", { intentId: "intent:mapping" }], ["run_code", { code: 'return await tools.wemedia_mapping_apply({intentId:"intent:mapping"});', description: "P6 policy contract" }]] as const) {
      const denied = await call(name, args); expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain("P6_POLICY_DENY");
    }
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockImplementation(async () => answer({ ...draft, media: [{ ...draft.media[0]!, absolutePath: "PRIVATE_FIELD_MUST_NOT_ESCAPE" }] }));
    for (const [name, args] of [["wemedia_publication_read", { contentRef }], ["run_code", { code: `return await tools.wemedia_publication_read({contentRef:${JSON.stringify(contentRef)}});`, description: "P6 output boundary" }]] as const) {
      const rejected = await call(name, args); expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).not.toContain("PRIVATE_FIELD_MUST_NOT_ESCAPE");
    }
  });
});

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArticleDocument, WorkflowImportPreview, WorkbenchAnswer } from "../../src/domain/workbench.ts";
import { isJsonObject } from "../../src/domain/json.ts";
import type { JsonObject } from "../../src/domain/json.ts";
import type { WorkbenchAdapter } from "../../src/ports/workbench.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
const value = <T>(answer: WorkbenchAnswer): T => { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; };
async function report(f: Awaited<ReturnType<typeof fixture>>, document: ArticleDocument, changes = {}) {
  const artifact = { rootId: "source", relativePath: "review.json" };
  const raw = { schemaVersion: "wemedia.review/v1", kind: "facts", revisionDigest: document.revisionDigest, verdict: "pass", findings: ["Source statement and cited figure were checked."], ...changes };
  await writeFile(resolve(f.sourcePath, artifact.relativePath), JSON.stringify(raw));
  return artifact;
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, document: ArticleDocument, artifact: { rootId: string; relativePath: string }, kind: "review" | "draft" = "review") {
  return value<WorkflowImportPreview>(await f.service.request({ operation: "preview_workflow_import", contentRef: document.contentRef, kind, artifact }, { kind: "user" }));
}
async function aaai(f: Awaited<ReturnType<typeof fixture>>, articleId = "aaai26-40226", uploadMapFile = "aaai26-40226.upload-map.json") {
  const doc = await f.documents.create({ contentRef: `wmc:${randomUUID()}`, metadata: { articleId, title: "Current article", author: "Editor", digest: "Article summary", kind: "paper", sourceUrl: "https://ojs.aaai.org/index.php/AAAI/article/view/40226", pdfUrl: "", codeUrl: "", titlePrefix: "" } });
  const artifact = { rootId: "source", relativePath: "summary.json" };
  const summary = { schema: "aaai2026-agent-draft-summary.v1", conference: "AAAI 2026", batch: "batch-18", article_count: 1, results: [{ article_id: doc.metadata.articleId, title: "Old article title", media_id: "OldFixtureMedia", created: true, updated: true, reused_existing: true, upload_map: `legacy/platform/${uploadMapFile}`, local_draft: "private opaque value discarded" }] };
  const map = [{ source: "figure.png", sha256: "b".repeat(64), media_id: "ImageFixtureMedia", wechat_url: "https://mmbiz.qpic.cn/fixture/640?wx_fmt=png", preflight: { private: "discarded" }, reused: true }];
  await writeFile(resolve(f.sourcePath, artifact.relativePath), JSON.stringify(summary));
  await writeFile(resolve(f.sourcePath, uploadMapFile), JSON.stringify(map));
  const identity = vi.fn<NonNullable<WorkbenchAdapter["verifyDraftIdentity"]>>(async () => ({ ok: true, code: "WECHAT_DRAFT_IDENTITY_VERIFIED", accountRef: f.adapter.accountRef()!, verifiedAt: f.now() }));
  f.adapter.verifyDraftIdentity = identity;
  return { doc, artifact, summary, map, identity };
}

describe("original workflow import closure", () => {
  it("previews without writing; atomically records current native report once without changing source", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc);
    const before = await readFile(resolve(f.sourcePath, artifact.relativePath));
    const proposed = await preview(f, doc, artifact);
    expect(proposed.material).toMatchObject({ status: "current", reviewKind: "facts" });
    expect((await f.documents.read(doc.contentRef)).workflowImports).toEqual([]);
    expect((await f.documents.read(doc.contentRef)).reviews).toEqual([]);
    const apply = () => f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" });
    const imported = value<ArticleDocument>(await apply());
    expect(imported.reviews).toHaveLength(1); expect(imported.reviews[0]).toMatchObject({ valid: true, reviewer: "user", kind: "facts" });
    expect(imported.workflowImports).toHaveLength(1);
    expect(await apply()).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    const again = await preview(f, doc, artifact);
    value(await f.service.request({ operation: "apply_workflow_import", intentId: again.intent.intentId }, { kind: "user" }));
    expect((await f.documents.read(doc.contentRef)).reviews).toHaveLength(1);
    expect(await readFile(resolve(f.sourcePath, artifact.relativePath))).toEqual(before);
    expect(f.remoteCalls()).toBe(0);
  });

  it("keeps stale native reports as history, without promoting gates, and marks changed sources stale", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc, { revisionDigest: `sha256:${"e".repeat(64)}` });
    const proposed = await preview(f, doc, artifact);
    expect(proposed.material.status).toBe("stale");
    const imported = value<ArticleDocument>(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }));
    expect(imported.reviews).toEqual([]);
    expect(imported.workflowImports?.[0]?.status).toBe("stale");
    expect(value<{ status: string }>(await f.service.request({ operation: "preflight", contentRef: doc.contentRef }, { kind: "user" })).status).toBe("block");
    await writeFile(resolve(f.sourcePath, artifact.relativePath), "{}");
    expect((await f.documents.read(doc.contentRef)).workflowImports?.[0]?.warnings).toContain("IMPORTED_SOURCE_OR_REVISION_CHANGED");
  });

  it("reuses HTML-bound Codex findings only as partial, never as full-version or visual review", async () => {
    const f = await setup(), doc = await f.create();
    const artifact = await report(f, doc);
    await writeFile(resolve(f.sourcePath, artifact.relativePath), JSON.stringify({ article_id: doc.metadata.articleId, generated_at: f.now(), ok: true, checks: { rows_match: true, images_unchanged: true }, content_sha256: sha256(doc.html).slice(7), source_tables: [], image_checks: [], formula_errors: [], diagnostics: { path: "/tmp/private-not-returned" } }));
    const proposed = await preview(f, doc, artifact);
    expect(proposed.material).toMatchObject({ status: "partial", reviewKind: null, boundHtmlDigest: sha256(doc.html) });
    expect(JSON.stringify(proposed)).not.toContain("private-not-returned");
    const imported = value<ArticleDocument>(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }));
    expect(imported.reviews).toEqual([]);
  });

  it("imports a static 390 report only as historical, not an actual screenshot", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc);
    await writeFile(resolve(f.sourcePath, artifact.relativePath), JSON.stringify({ schema: "justagent.conference-agent-mobile-390-static.v1", viewport_width: 390, articles: [{ article_id: doc.metadata.articleId, viewport_width: 390, css_sha256: "c".repeat(64), checks: { viewport_meta: true, responsive_images: true, image_count: 9 }, visual_screenshot_gate: "required_when_browser_file_access_is_available" }] }));
    const proposed = await preview(f, doc, artifact);
    expect(proposed.material.status).toBe("historical"); expect(proposed.material.warnings).toContain("STATIC_REPORT_IS_NOT_SCREENSHOT");
  });

  it.each(["source", "revision"])("rejects %s changes after preview, without recording partial evidence", async change => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc), proposed = await preview(f, doc, artifact);
    if (change === "source") await report(f, doc, { findings: ["Changed findings"] });
    else await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: { ...doc.metadata, title: "Changed" }, html: doc.html, markdown: doc.markdown });
    expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "WORKFLOW_IMPORT_CHANGED" } });
    expect((await f.documents.read(doc.contentRef)).reviews).toEqual([]);
    expect((await f.documents.read(doc.contentRef)).workflowImports).toEqual([]);
  });

  it("expires and binds preview caller without exposing private candidate state", async () => {
    const f = await setup(), data = await aaai(f), proposed = await preview(f, data.doc, data.artifact, "draft");
    const dto = JSON.stringify(proposed);
    expect(dto).not.toContain("OldFixtureMedia"); expect(dto).not.toContain("ImageFixtureMedia"); expect(dto).not.toContain("wechat-account:"); expect(dto).not.toContain("private opaque");
    expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "agent", sessionId: "different" })).toMatchObject({ ok: false, error: { code: "IMPORT_CALLER_CHANGED" } });
    f.setTime("2026-09-06T00:11:00.000Z");
    expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(data.identity).not.toHaveBeenCalled();
  });

  it("binds only a uniquely read-back old target, preserves old title, pins account, and does not verify new content", async () => {
    const f = await setup(), data = await aaai(f), proposed = await preview(f, data.doc, data.artifact, "draft");
    expect(data.identity).not.toHaveBeenCalled(); expect((await f.documents.read(data.doc.contentRef)).targets).toEqual([]);
    expect(proposed.intent.sideEffect).toBe("local_write");
    const imported = value<ArticleDocument>(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }));
    expect(data.identity).toHaveBeenCalledTimes(1);
    expect(data.identity.mock.calls[0]?.[1]).toMatchObject({ mediaId: "OldFixtureMedia", title: "Old article title", sourceUrl: data.doc.metadata.sourceUrl });
    expect(imported.targets).toHaveLength(1); expect(imported.targets[0]).toMatchObject({ title: "Old article title", verifiedRevision: "", verifiedAt: "" });
    const state = await f.documents.privateRemoteState(data.doc.contentRef, imported.targets[0]!);
    expect(state.accountRef).toBe(f.adapter.accountRef()); expect(state.uploads).toHaveLength(1); expect(state.uploads[0]).not.toHaveProperty("preflight");
    expect(imported.workflowImports?.[0]?.warnings).not.toContain("DRAFT_IDENTITY_READ_REQUIRED");
    expect(imported.workflowImports?.[0]?.warnings).toContain("DRAFT_IDENTITY_VERIFIED_NOT_CONTENT");
    expect(imported.workflowImports?.[0]?.status).toBe("partial");
    expect(imported.reviews).toEqual([]); expect(f.remoteCalls()).toBe(0);
  });

  it.each([
    ["AAAI26-40226", "aaai26-40226.upload-map.json"],
    ["aaai26-40226", "AAAI26-40226.upload-map.json"],
    ["AaAi26-40226", "aAaI26-40226.upload-map.json"],
  ])("imports the exact %s article with declared map %s without rewriting either identity", async (articleId, uploadMapFile) => {
    const f = await setup(), data = await aaai(f, articleId, uploadMapFile);
    const sourceBefore = await readFile(resolve(f.sourcePath, data.artifact.relativePath));
    const mapBefore = await readFile(resolve(f.sourcePath, uploadMapFile));
    const candidate = await f.documents.previewWorkflowImport(data.doc.contentRef, "draft", data.artifact);
    expect(candidate.dependencies?.[0]?.artifact).toEqual({ rootId: "source", relativePath: uploadMapFile });
    const proposed = await preview(f, data.doc, data.artifact, "draft");
    expect(proposed.material.status).toBe("historical");
    expect(data.identity).not.toHaveBeenCalled();
    const imported = value<ArticleDocument>(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }));
    expect(imported.metadata.articleId).toBe(articleId);
    expect(imported.targets).toHaveLength(1);
    expect(imported.targets[0]).toMatchObject({ verifiedRevision: "", verifiedAt: "" });
    expect((await f.documents.privateRemoteState(data.doc.contentRef, imported.targets[0]!)).uploads).toHaveLength(1);
    expect(imported.reviews).toEqual([]);
    expect(data.identity).toHaveBeenCalledTimes(1);
    expect(await readFile(resolve(f.sourcePath, data.artifact.relativePath))).toEqual(sourceBefore);
    expect(await readFile(resolve(f.sourcePath, uploadMapFile))).toEqual(mapBefore);
    expect(f.remoteCalls()).toBe(0);
  });

  it.each([
    ["article ID with different case", { article_id: "aaai26-40226" }],
    ["another article", { article_id: "AAAI26-99999" }],
    ["another article's map", { upload_map: "legacy/platform/aaai26-99999.upload-map.json" }],
    ["a zero-padded article's map", { upload_map: "legacy/platform/aaai26-040226.upload-map.json" }],
    ["another conference's map", { upload_map: "legacy/platform/ijcai26-40226.upload-map.json" }],
    ["a differently cased map suffix", { upload_map: "legacy/platform/aaai26-40226.UPLOAD-MAP.json" }],
  ])("keeps uppercase article import strict for %s", async (_label, changes) => {
    const f = await setup(), data = await aaai(f, "AAAI26-40226");
    await writeFile(resolve(f.sourcePath, data.artifact.relativePath), JSON.stringify({ ...data.summary, results: [{ ...data.summary.results[0], ...changes }] }));
    expect(await f.service.request({ operation: "preview_workflow_import", contentRef: data.doc.contentRef, kind: "draft", artifact: data.artifact }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "WORKFLOW_FORMAT_UNSUPPORTED" } });
    expect(await f.documents.read(data.doc.contentRef)).toMatchObject({ targets: [], reviews: [], workflowImports: [] });
    expect(data.identity).not.toHaveBeenCalled();
    expect(f.remoteCalls()).toBe(0);
  });

  it.each(["article", "media"])("still rejects duplicate %s identities for uppercase article import", async duplicate => {
    const f = await setup(), data = await aaai(f, "AAAI26-40226");
    const second = { ...data.summary.results[0], ...(duplicate === "article" ? { media_id: "AnotherFixtureMedia" } : { article_id: "AAAI26-99999" }) };
    await writeFile(resolve(f.sourcePath, data.artifact.relativePath), JSON.stringify({ ...data.summary, article_count: 2, results: [...data.summary.results, second] }));
    expect(await f.service.request({ operation: "preview_workflow_import", contentRef: data.doc.contentRef, kind: "draft", artifact: data.artifact }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "WORKFLOW_FORMAT_UNSUPPORTED" } });
    expect(data.identity).not.toHaveBeenCalled();
    expect(await f.documents.read(data.doc.contentRef)).toMatchObject({ targets: [], reviews: [], workflowImports: [] });
  });

  it.each(["identity", "account", "mapping", "cancel"])("rejects %s changes and leaves no binding or material behind", async mode => {
    const f = await setup(), data = await aaai(f), proposed = await preview(f, data.doc, data.artifact, "draft"), controller = new AbortController();
    if (mode === "identity") data.identity.mockImplementation(async () => ({ ok: false, code: "MISMATCH", accountRef: f.adapter.accountRef()!, verifiedAt: f.now() }));
    if (mode === "account") f.setAccount(`wechat-account:${"d".repeat(32)}`);
    if (mode === "mapping" || mode === "cancel") data.identity.mockImplementation(async () => {
      if (mode === "mapping") await writeFile(resolve(f.sourcePath, "aaai26-40226.upload-map.json"), "[]");
      else controller.abort();
      return { ok: true, code: "OK", accountRef: f.adapter.accountRef()!, verifiedAt: f.now() };
    });
    expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }, controller.signal)).toMatchObject({ ok: false });
    const doc = await f.documents.read(data.doc.contentRef); expect(doc.targets).toEqual([]); expect(doc.workflowImports).toEqual([]); expect(f.remoteCalls()).toBe(0);
  });

  it("rejects duplicate article/media identities and unsafe map references", async () => {
    const f = await setup(), data = await aaai(f);
    for (const invalid of [
      { ...data.summary, article_count: 2, results: [...data.summary.results, ...data.summary.results] },
      { ...data.summary, results: [{ ...data.summary.results[0], upload_map: "../outside.json" }] },
      { ...data.summary, results: [{ ...data.summary.results[0], article_id: "aaai26-99999" }] },
    ]) {
      await writeFile(resolve(f.sourcePath, data.artifact.relativePath), JSON.stringify(invalid));
      expect(await f.service.request({ operation: "preview_workflow_import", contentRef: data.doc.contentRef, kind: "draft", artifact: data.artifact }, { kind: "user" })).toMatchObject({ ok: false });
    }
    expect(data.identity).not.toHaveBeenCalled();
  });

  it("fails closed on an existing conflicting target and rolls back material in the same store transaction", async () => {
    const f = await setup(), data = await aaai(f);
    await f.documents.persistRemoteResult(data.doc, { ok: true, code: "FIXTURE", channel: "wechat", phase: "draft", sideEffect: "remote_draft", remote: { remoteId: "OtherFixture" }, artifacts: [], issues: [], retryable: false, verifiedAt: f.now() }, null);
    const proposed = await preview(f, data.doc, data.artifact, "draft");
    expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "TARGET_IMPORT_CONFLICT" } });
    const doc = await f.documents.read(data.doc.contentRef); expect(doc.workflowImports).toEqual([]); expect(doc.targets).toHaveLength(1); expect(doc.targets[0]?.verifiedRevision).toBe(data.doc.revisionDigest);
  });

  it("does not reuse a readback report as current online or human review", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc);
    const checks = Object.fromEntries(["present", "title_matches", "topic_prefix_present", "digest_matches", "digest_plain_text", "content_text_matches", "result_table_count_matches", "result_table_cells_match", "content_deep", "image_count_matches", "images_uploaded", "images_match_approved_uploads", "image_upload_map_count_matches", "source_url_matches", "official_page_url_visible", "official_pdf_url_visible", "code_url_visible_or_not_required", "cover_present", "developer_notes_absent", "local_paths_absent"].map(key => [key, true]));
    await writeFile(resolve(f.sourcePath, artifact.relativePath), JSON.stringify({ schema: "aaai2026-agent-draft-readback.v1", checks: [{ article_id: doc.metadata.articleId, media_id: "FixturePrivate", expected_revision_sha256: doc.revisionDigest.slice(7), verified_at: f.now(), ok: true, checks }, { article_id: "OTHER-ARTICLE", media_id: "OtherFixturePrivate", ok: false, checks: Object.fromEntries(Object.keys(checks).map(key => [key, false])) }] }));
    const proposed = await preview(f, doc, artifact); expect(proposed.material.status).toBe("current"); expect(proposed.material.reviewKind).toBeNull(); expect(proposed.material.warnings).toContain("REMOTE_READBACK_NOT_REFRESHED");
    await f.documents.commitWorkflowImport(doc.contentRef, await f.documents.previewWorkflowImport(doc.contentRef, "review", artifact), "user");
    const detail = await f.documents.evidenceDetail(doc.contentRef, proposed.material.id);
    expect(JSON.parse(detail.body).checks).toEqual(checks);
    expect(detail.body).not.toContain("false"); expect(detail.body).not.toContain("FixturePrivate");
  });

  it("marks imported current reports stale when the current article changes", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc), proposed = await preview(f, doc, artifact);
    value(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" }));
    const changed = await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: { ...doc.metadata, title: "New title" }, html: doc.html, markdown: doc.markdown });
    expect(changed.workflowImports?.[0]?.status).toBe("stale"); expect(changed.reviews[0]?.valid).toBe(false);
  });
});

describe("workflow import privacy and final commit boundaries", () => {
  const unsafeFindings = [
    ["Linux home path", "/home/test/private"],
    ["root home path", "/root/private"],
    ["URL credentials", "https://fixture-user:fixture-pass@example.org/"],
    ["password assignment", "password=fixture-value"],
    ["token assignment", "token=fixture-value"],
  ] as const;

  it.each(unsafeFindings)("rejects a native report containing %s without leaking its raw finding", async (_label, finding) => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc, { findings: [finding] });
    const response = await f.service.request({ operation: "preview_workflow_import", contentRef: doc.contentRef, kind: "review", artifact }, { kind: "user" });
    expect(response).toMatchObject({ ok: false, error: { code: "WORKFLOW_FORMAT_UNSUPPORTED" } });
    expect(JSON.stringify(response)).not.toContain(finding);
    expect(await f.documents.read(doc.contentRef)).toMatchObject({ reviews: [], workflowImports: [] });
    expect(f.remoteCalls()).toBe(0);
  });

  it("rejects an unknown nested JSON secret property in a native report without leaking its value", async () => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc, { extra: { secret: "fixture-value" } });
    const response = await f.service.request({ operation: "preview_workflow_import", contentRef: doc.contentRef, kind: "review", artifact }, { kind: "user" });
    expect(response).toMatchObject({ ok: false, error: { code: "WORKFLOW_FORMAT_UNSUPPORTED" } });
    expect(JSON.stringify(response)).not.toContain("fixture-value");
    expect(await f.documents.read(doc.contentRef)).toMatchObject({ reviews: [], workflowImports: [] });
  });

  const invalidStoredFields: Array<[string, JsonObject]> = [
    ["source digest", { sourceDigest: "sha256:invalid" }],
    ["bound revision digest", { boundRevision: "sha256:invalid" }],
    ["bound HTML digest", { boundHtmlDigest: "sha256:invalid" }],
    ["unknown source format", { sourceFormat: "unsupported-fixture-format" }],
    ["invalid ID", { id: "invalid id" }],
    ["invalid timestamp", { recordedAt: "not-a-timestamp" }],
    ["impossible calendar date", { recordedAt: "2026-02-30T00:00:00.000Z" }],
    ["oversize title", { title: "x".repeat(10_001) }],
    ["oversize finding", { findings: ["x".repeat(2001)] }],
    ["too many findings", { findings: Array.from({ length: 101 }, () => "Fixture finding") }],
    ["unknown secret property", { extra: { secret: "fixture-value" } }],
    ...unsafeFindings.map(([label, finding]): [string, JsonObject] => [`unsafe finding: ${label}`, { findings: [finding] }]),
  ];

  it.each(invalidStoredFields)("drops stored material with %s while retaining a valid adjacent record", async (_label, changes) => {
    const f = await setup(), doc = await f.create(), artifact = await report(f, doc), proposed = await preview(f, doc, artifact);
    await f.store.update(state => {
      const documents = state.extensions.wechatDocuments;
      if (!isJsonObject(documents)) throw new Error("Fixture document missing");
      const saved = documents[doc.contentRef];
      if (!isJsonObject(saved)) throw new Error("Fixture document missing");
      documents[doc.contentRef] = { ...saved, workflowImports: [{ ...proposed.material, ...changes }, proposed.material] };
    });
    const readback = await f.documents.read(doc.contentRef);
    expect(readback.workflowImports).toEqual([proposed.material]);
    expect(readback.reviews).toEqual([]); expect(readback.targets).toEqual([]);
    expect(JSON.stringify(readback)).not.toContain("fixture-value");
  });

  it.each(["source", "upload map", "account"] as const)("rejects a %s change on the final pre-put read after commit re-preview", async change => {
    const f = await setup(), data = await aaai(f), proposed = await preview(f, data.doc, data.artifact, "draft");
    const before = await f.store.read();
    const originalCommit = f.documents.commitWorkflowImport.bind(f.documents);
    const originalPreview = f.documents.previewWorkflowImport.bind(f.documents);
    const originalRead = f.documents.read.bind(f.documents);
    let committing = false, candidateRechecked = false, injected = false;
    // Forward every argument, including the service's optional final guard.
    const commit = vi.spyOn(f.documents, "commitWorkflowImport").mockImplementation(async (...args) => {
      committing = true;
      try { return await originalCommit(...args); } finally { committing = false; }
    });
    vi.spyOn(f.documents, "previewWorkflowImport").mockImplementation(async (...args) => {
      const candidate = await originalPreview(...args);
      if (committing) candidateRechecked = true;
      return candidate;
    });
    vi.spyOn(f.documents, "read").mockImplementation(async contentRef => {
      const current = await originalRead(contentRef);
      if (contentRef === data.doc.contentRef && committing && candidateRechecked && !injected) {
        injected = true;
        if (change === "source") await writeFile(resolve(f.sourcePath, data.artifact.relativePath), JSON.stringify({ ...data.summary, results: [{ ...data.summary.results[0], title: "Changed at final commit read" }] }));
        else if (change === "upload map") await writeFile(resolve(f.sourcePath, "aaai26-40226.upload-map.json"), JSON.stringify(data.map.map(row => ({ ...row, media_id: "ChangedFixtureImage" }))));
        else f.setAccount(`wechat-account:${"d".repeat(32)}`);
      }
      return current;
    });
    const response = await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" });
    expect(commit).toHaveBeenCalledTimes(1); expect(candidateRechecked).toBe(true); expect(injected).toBe(true);
    expect(data.identity).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ ok: false, error: { code: "WORKFLOW_IMPORT_CHANGED" } });
    expect(await originalRead(data.doc.contentRef)).toMatchObject({ reviews: [], workflowImports: [], targets: [] });
    expect((await f.store.read()).extensions.wechatDocuments).toEqual(before.extensions.wechatDocuments);
    expect(f.remoteCalls()).toBe(0);
  });
});

describe("original AI workflow entry", () => {
  it("returns native diagnostics without creating reviews or remote jobs", async () => {
    const f = await setup(), doc = await f.create();
    f.adapter.inspectAi = vi.fn<NonNullable<WorkbenchAdapter["inspectAi"]>>(async operation => ({ operation, revisionDigest: doc.revisionDigest, mode: "ai", sourceKind: "markdown", status: "warn", code: "AI_DEGRADED", previewFidelity: "degraded", issues: [] }));
    expect(await f.service.request({ operation: "ai_preview", contentRef: doc.contentRef }, { kind: "user" })).toMatchObject({ ok: true, value: { mode: "ai", previewFidelity: "degraded" } });
    expect((await f.documents.read(doc.contentRef)).reviews).toEqual([]); expect(await f.jobs.loadAll()).toEqual([]); expect(f.remoteCalls()).toBe(0);
  });

  it("rejects a changed Markdown source even though the original article revision excludes Markdown", async () => {
    const f = await setup(), doc = await f.create();
    const raw = JSON.parse(await readFile(resolve(f.writePath, doc.document.relativePath), "utf8"));
    expect(isJsonObject(raw)).toBe(true);
    f.adapter.inspectAi = async operation => {
      const path = resolve(f.writePath, doc.document.relativePath, "..", raw.markdownFile);
      await writeFile(path, "A changed Markdown source");
      return { operation, revisionDigest: doc.revisionDigest, mode: "ai", sourceKind: "markdown", status: "pass", code: "AI_OK", previewFidelity: "exact", issues: [] };
    };
    expect(await f.service.request({ operation: "ai_inspect", contentRef: doc.contentRef }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "AI_REVISION_CHANGED" } });
  });
});

it("rejects workflow import expiry while awaiting identity verification", async () => {
  const f = await setup(), data = await aaai(f);
  const proposed = await preview(f, data.doc, data.artifact, "draft");
  data.identity.mockImplementationOnce(async () => {
    f.setTime("2026-09-06T00:11:00.000Z");
    return { ok: true, code: "WECHAT_DRAFT_IDENTITY_VERIFIED", accountRef: f.adapter.accountRef()!, verifiedAt: f.now() };
  });
  expect(await f.service.request({ operation: "apply_workflow_import", intentId: proposed.intent.intentId }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  expect((await f.documents.read(data.doc.contentRef)).workflowImports).toEqual([]);
  expect((await f.documents.read(data.doc.contentRef)).targets).toEqual([]);
  expect(f.remoteCalls()).toBe(0);
});

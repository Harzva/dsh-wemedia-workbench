import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { testPng, pngChunk } from "../fixtures/png.ts";
import { afterEach, describe, expect, it } from "vitest";
import { articleParagraphs, assetDifferences, decodeReviewDetails } from "../../src/domain/inspection.ts";
import type { ReviewDetails } from "../../src/domain/inspection.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { screenshotProjection } from "../../src/infrastructure/workbenchInspection.ts";
import { fixture } from "./fixture.ts";
import type { ArticleDocument } from "../../src/domain/workbench.ts";
import { htmlImageSources, rewriteImageSources } from "../../src/domain/wechatDocument.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const value = await fixture(); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
function detailsFor(doc: ArticleDocument): ReviewDetails {
  return { body: "完整核验报告\n\n逐条检查本地合成示例。", markdownDigest: sha256(doc.markdown), sources: [{ id: "paper", title: "Synthetic paper", url: "https://example.org/paper", page: "3", figure: "Figure 2" }], paragraphs: articleParagraphs(doc.html).map((_, i) => i + 1), facts: articleParagraphs(doc.html).map((claim, i) => ({ id: `f${i}`, paragraph: i + 1, claim, disposition: "supported", sourceIds: ["paper"], note: "Synthetic fixture source association." })), assets: [] };
}
async function record(f: Awaited<ReturnType<typeof fixture>>, doc: ArticleDocument, details = detailsFor(doc)) {
  const report = { schemaVersion: "wemedia.review/v1", kind: "facts", revisionDigest: doc.revisionDigest, verdict: "pass", findings: ["Synthetic fixture findings"], details };
  await writeFile(resolve(f.writePath, "rich-report.json"), JSON.stringify(report));
  return f.documents.recordReview(doc.contentRef, { kind: "facts", revisionDigest: doc.revisionDigest, artifact: { rootId: "write", relativePath: "rich-report.json" }, reviewer: "user", summary: "Synthetic full report" });
}

describe("version history and exact evidence inspection", () => {
  it("registers only successful versions, preserves Markdown-only differences and survives refresh", async () => {
    const f = await setup(), first = await f.create();
    const second = await f.documents.saveRevision(first.contentRef, first.revisionDigest, { metadata: first.metadata, html: first.html, markdown: "New independent Markdown" });
    expect(second.revisionDigest).toBe(first.revisionDigest);
    await f.documents.refresh();
    const history = await f.documents.history(first.contentRef);
    expect(history.versions).toHaveLength(2); expect(history.versions.every(v => v.available)).toBe(true);
    const diff = await f.documents.compareVersions(first.contentRef, history.versions[1]!.id, history.versions[0]!.id);
    expect(diff.fields).toEqual([{ path: "Markdown", oldText: first.markdown, newText: second.markdown }]);
    await expect(f.documents.saveRevision(first.contentRef, "sha256:stale", { metadata: first.metadata, html: first.html, markdown: "wrong" })).rejects.toMatchObject({ code: "REVISION_CHANGED" });
    expect((await f.documents.history(first.contentRef)).versions).toHaveLength(2);
  });
  it("rejects cross-article version IDs and altered historical bytes", async () => {
    const f = await setup(), first = await f.create(), other = await f.create();
    await f.documents.saveRevision(first.contentRef, first.revisionDigest, { metadata: { ...first.metadata, title: "Second title" }, html: first.html, markdown: first.markdown });
    const history = await f.documents.history(first.contentRef), foreign = await f.documents.history(other.contentRef);
    await expect(f.documents.compareVersions(first.contentRef, foreign.versions[0]!.id, history.versions[0]!.id)).rejects.toMatchObject({ code: "HISTORY_UNKNOWN" });
    await writeFile(resolve(f.writePath, first.htmlArtifact.relativePath), "changed historical bytes");
    expect((await f.documents.history(first.contentRef)).versions[1]!.available).toBe(false);
    await expect(f.documents.compareVersions(first.contentRef, history.versions[1]!.id, history.versions[0]!.id)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
  });
  it("matches copied image bytes despite version-local filenames and shows additions/removals", async () => {
    const f = await setup(), doc = await f.create();
    await writeFile(resolve(f.writePath, "a.png"), "image-a"); await writeFile(resolve(f.writePath, "b.png"), "image-b");
    const first = await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: doc.metadata, html: '<p>Images</p><img src="a.png"><img src="b.png">', markdown: "Images" });
    const second = await f.documents.saveRevision(doc.contentRef, first.revisionDigest, { metadata: doc.metadata, html: `<p>Images</p><img src="${first.assets[1]!.source}">`, markdown: "Images" });
    expect(assetDifferences(first.assets, second.assets)).toMatchObject([{ change: "removed", before: { digest: first.assets[0]!.digest }, after: null }]);
    const third = await f.documents.saveRevision(doc.contentRef, second.revisionDigest, { metadata: doc.metadata, html: `${second.html}<img src="a.png">`, markdown: "Images" });
    expect(assetDifferences(second.assets, third.assets)).toMatchObject([{ change: "added", before: null, after: { digest: first.assets[0]!.digest } }]);
  });
  it("uses matching extraction and rewrite semantics for valid HTML image attributes", async () => {
    const f = await setup(), doc = await f.create();
    await writeFile(resolve(f.writePath, "new.png"), "fixture image");
    for (const html of ['<img SRC = "new.png">', "<IMG class='figure' src = 'new.png'>", '<img src=new.png data-src="ignored.png">', '<img alt="a > b" src="new.png">', `<img alt='look src="decoy.png"' src="new.png">`]) {
      const current = await f.documents.read(doc.contentRef);
      const saved = await f.documents.saveRevision(doc.contentRef, current.revisionDigest, { metadata: doc.metadata, html, markdown: "Image" });
      expect(saved.assets).toHaveLength(1); expect(saved.issues).toEqual([]);
      expect(saved.assets[0]!.source).toMatch(/^assets\//u);
      const preview = await f.documents.preview(doc.contentRef);
      expect(preview.html).toContain("data:image/png;base64,");
    }
  });
  it("ignores commented and raw-text images and preserves other quoted attributes", () => {
    const html = `<!-- <img src="comment.png"> --><script>"<img src='script.png'>"</script><textarea><img src="text.png"></textarea><img alt='look src="decoy.png" > text' src="a&amp;b.png" src="duplicate.png">`;
    expect(htmlImageSources(html)).toEqual(["a&b.png"]);
    const rewritten = rewriteImageSources(html, () => "assets/copied.png");
    expect(rewritten).toBe(html.replace('src="a&amp;b.png"', 'src="assets/copied.png"'));
  });
  it("reads a complete report with source/fact coverage and rejects unknown IDs", async () => {
    const f = await setup(), doc = await f.create(), review = await record(f, doc);
    const inspected = await f.documents.read(doc.contentRef);
    expect(inspected.paragraphs).toHaveLength(2);
    expect(inspected.reviews[0]!.coverage).toMatchObject({ complete: true, paragraphs: [1, 2], paragraphTotal: 2 });
    const detail = await f.documents.evidenceDetail(doc.contentRef, review.id);
    expect(detail.body).toBe(detailsFor(doc).body); expect(detail.details?.facts).toHaveLength(2); expect(detail.current).toBe(true);
    await expect(f.documents.evidenceDetail(doc.contentRef, "../rich-report.json")).rejects.toMatchObject({ code: "EVIDENCE_UNKNOWN" });
    expect(f.remoteCalls()).toBe(0);
  });
  it("preserves incomplete coverage without claiming a full pass", async () => {
    const f = await setup(), doc = await f.create(), details = detailsFor(doc); details.facts = details.facts.slice(0, 1);
    await record(f, doc, details);
    expect((await f.documents.read(doc.contentRef)).reviews[0]!.coverage?.complete).toBe(false);
    const answer = await f.service.request({ operation: "preflight", contentRef: doc.contentRef }, { kind: "user" });
    expect(JSON.stringify(answer)).toContain("COVERAGE_FACTS"); expect(JSON.stringify(answer)).toContain('"status":"block"');
  });
  it("invalidates coverage on Markdown changes even when legacy HTML revision stays equal", async () => {
    const f = await setup(), doc = await f.create(), review = await record(f, doc);
    await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: doc.metadata, html: doc.html, markdown: "changed Markdown" });
    const current = await f.documents.read(doc.contentRef);
    expect(current.revisionDigest).toBe(doc.revisionDigest); expect(current.reviews[0]!.valid).toBe(false);
    const detail = await f.documents.evidenceDetail(doc.contentRef, review.id);
    expect(detail.current).toBe(false); expect(detail.coverage).toBeNull();
  });
  it("downgrades imported native details after Markdown changes", async () => {
    const f = await setup(), doc = await f.create(); await record(f, doc);
    const artifact = { rootId: "write", relativePath: "rich-report.json" };
    const candidate = await f.documents.previewWorkflowImport(doc.contentRef, "review", artifact);
    await f.documents.commitWorkflowImport(doc.contentRef, candidate, "user");
    await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: doc.metadata, html: doc.html, markdown: "Changed independent Markdown" });
    expect((await f.documents.read(doc.contentRef)).workflowImports?.[0]?.status).toBe("stale");
    expect(await f.documents.evidenceDetail(doc.contentRef, candidate.material.id)).toMatchObject({ current: false, coverage: null });
    expect((await f.documents.previewWorkflowImport(doc.contentRef, "review", artifact)).material.status).toBe("stale");
  });
  it("refuses replaced evidence and does not return its new contents", async () => {
    const f = await setup(), doc = await f.create(), review = await record(f, doc);
    await writeFile(resolve(f.writePath, "rich-report.json"), "Untrusted replacement report");
    await expect(f.documents.evidenceDetail(doc.contentRef, review.id)).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
  });
  it("rejects private text, unknown fields, duplicate sources and dangling references", async () => {
    const f = await setup(), doc = await f.create(), base = detailsFor(doc);
    for (const bad of [
      // Construct synthetic rejection markers; no real credential or machine path is stored.
      { ...base, body: ["secret", "synthetic-placeholder"].join("=") }, { ...base, body: ["", "Users", "fixture", "report"].join("/") }, { ...base, hidden: "unknown" },
      { ...base, sources: [base.sources[0], base.sources[0]] }, { ...base, facts: [{ ...base.facts[0], sourceIds: ["missing"] }] },
      { ...base, sources: [{ ...base.sources[0], url: "https://example.org/?token=synthetic" }] },
    ]) expect(() => decodeReviewDetails(bad)).toThrow();
    const outside = { ...base, paragraphs: [999] };
    await expect(record(f, doc, outside)).rejects.toMatchObject({ code: "REVIEW_REPORT_INVALID" });
  });
  it("requires original image locators, formula source and exact rendered asset digests", async () => {
    const f = await setup(), doc = await f.create();
    await writeFile(resolve(f.writePath, "equation.png"), "synthetic rendered formula");
    const saved = await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: doc.metadata, html: '<p>Formula</p><img src="equation.png">', markdown: "Formula" });
    const base = detailsFor(saved), asset = saved.assets[0]!;
    base.assets = [{ source: asset.source, digest: asset.digest, kind: "formula", sourceIds: ["paper"], formulaSource: "E = mc^2", note: "Synthetic rendering association" }];
    expect(decodeReviewDetails(base).assets[0]!.formulaSource).toBe("E = mc^2");
    expect(() => decodeReviewDetails({ ...base, assets: [{ ...base.assets[0], formulaSource: "" }] })).toThrow();
    expect(() => decodeReviewDetails({ ...base, sources: [{ ...base.sources[0], page: "" }], assets: [{ ...base.assets[0], kind: "original" }] })).toThrow();
    await expect(record(f, saved, { ...base, assets: [{ ...base.assets[0]!, digest: sha256("wrong") }] })).rejects.toMatchObject({ code: "REVIEW_REPORT_INVALID" });
  });
  it("does not expose unknown nested legacy fields such as API keys or bearer values", async () => {
    const f = await setup(), doc = await f.create();
    const artifact = { rootId: "write", relativePath: "legacy-public.json" };
    await writeFile(resolve(f.writePath, artifact.relativePath), JSON.stringify({ article_id: doc.metadata.articleId, generated_at: f.now(), ok: true, checks: { rows_match: true }, content_sha256: sha256(doc.html).slice(7), source_tables: [], image_checks: [{ ["api_key"]: "synthetic-private-value", bearer: "synthetic-bearer-value", caption: "Safe fixture caption", note: ["", "Users", "fixture", "example"].join("/") }], formula_errors: [] }));
    const candidate = await f.documents.previewWorkflowImport(doc.contentRef, "review", artifact);
    await f.documents.commitWorkflowImport(doc.contentRef, candidate, "user");
    const detail = await f.documents.evidenceDetail(doc.contentRef, candidate.material.id);
    expect(detail.body).toContain("Safe fixture caption");
    expect(detail.body).not.toMatch(/synthetic-private-value|synthetic-bearer-value|api_key|bearer|Users/u);
    expect(detail.current).toBe(false);
  });
  it("rejects array enum coercion and correctly CRC-signed but invalid image data", async () => {
    const f = await setup(), doc = await f.create(), base = detailsFor(doc);
    for (const kind of [["original"], ["formula"], {}, true]) expect(() => decodeReviewDetails({ ...base, assets: [{ source: "figure.png", digest: sha256("fixture"), kind, sourceIds: [], formulaSource: "", note: "Invalid enum" }] })).toThrow();
    const png = testPng(), invalid = Buffer.concat([png.subarray(0, 33), pngChunk("IDAT", Buffer.from("not-zlib-data")), pngChunk("IEND", Buffer.alloc(0))]);
    expect(() => screenshotProjection(invalid)).toThrow();
    await writeFile(resolve(f.writePath, "broken.png"), invalid);
    await expect(f.documents.recordReview(doc.contentRef, { kind: "mobile_visual", revisionDigest: doc.revisionDigest, artifact: { rootId: "write", relativePath: "broken.png" }, reviewer: "user", summary: "Synthetic invalid file" })).rejects.toMatchObject({ code: "VISUAL_EVIDENCE_INVALID" });
  });
  it("binds newly referenced image bytes to the confirmed save intent", async () => {
    const f = await setup(), doc = await f.create();
    await writeFile(resolve(f.writePath, "new.png"), "first image");
    const preview = await f.service.request({ operation: "preview_action", contentRef: doc.contentRef, action: "save_revision", edit: { metadata: doc.metadata, html: '<p>Fixture</p><img src="new.png">', markdown: "Fixture" } }, { kind: "user" });
    if (!preview.ok) throw new Error(preview.error.code);
    await writeFile(resolve(f.writePath, "new.png"), "different image");
    const intent = preview.value.intent as { intentId: string };
    expect(await f.service.request({ operation: "start_action", intentId: intent.intentId }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
    expect((await f.documents.read(doc.contentRef)).document).toEqual(doc.document);
  });
  it("projects only validated PNG raster chunks and provides a real image detail", async () => {
    const f = await setup(), doc = await f.create(), png = testPng();
    await writeFile(resolve(f.writePath, "screen.png"), png);
    const review = await f.documents.recordReview(doc.contentRef, { kind: "mobile_visual", revisionDigest: doc.revisionDigest, artifact: { rootId: "write", relativePath: "screen.png" }, reviewer: "user", summary: "Synthetic PNG fixture, not visual acceptance" });
    const detail = await f.documents.evidenceDetail(doc.contentRef, review.id);
    expect(detail.image).toMatchObject({ width: 390, height: 200 });
    expect(Buffer.from(detail.image!.dataUrl.split(",")[1]!, "base64").includes(Buffer.from("private metadata"))).toBe(false);
    const broken = Buffer.from(png); broken[40] = broken[40]! ^ 1;
    expect(() => screenshotProjection(broken)).toThrow(); expect(() => screenshotProjection(png.subarray(0, 24))).toThrow();
  });
});

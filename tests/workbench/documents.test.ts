import { constants } from "node:fs";
import { mkdir, open, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "../../src/domain/json.ts";
import type { JsonObject } from "../../src/domain/json.ts";
import type { ArticleDocument, DraftTarget } from "../../src/domain/workbench.ts";
import type { WorkbenchRemoteResult } from "../../src/ports/workbench.ts";
import { fixture } from "./fixture.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const value = await fixture(); fixtures.push(value); return value; }
afterEach(async () => { vi.mocked(open).mockImplementation(actualFs.open); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(value => value.cleanup())); });
async function overlay(f: Awaited<ReturnType<typeof fixture>>, doc: ArticleDocument, change: JsonObject): Promise<void> {
  await f.store.update(state => {
    const documents = state.extensions.wechatDocuments;
    if (!isJsonObject(documents)) throw new Error("missing fixture documents");
    const saved = documents[doc.contentRef];
    if (!isJsonObject(saved)) throw new Error("missing fixture document");
    documents[doc.contentRef] = { ...saved, ...change };
  });
}
function targetFixture(doc: ArticleDocument, now: string) {
  const stored = { targetRef: "target:fixture", mediaId: "FixtureMediaID", title: doc.metadata.title, sourceUrl: doc.metadata.sourceUrl, verifiedRevision: doc.revisionDigest, verifiedAt: now };
  const target: DraftTarget = { targetRef: stored.targetRef, label: `微信草稿 · ${stored.title}`, title: stored.title, sourceUrl: stored.sourceUrl, verifiedRevision: stored.verifiedRevision, verifiedAt: stored.verifiedAt };
  return { stored, target };
}

describe("versioned WeChat document repository", () => {
  it("retains upload evidence after empty and partial failures, while a successful result replaces the map", async () => {
    const f = await setup(), doc = await f.create();
    const first = { source: "assets/first.png", sha256: "a".repeat(64), media_id: "FirstMedia", wechat_url: "https://mmbiz.qpic.cn/first" };
    const second = { source: "assets/second.png", sha256: "b".repeat(64), media_id: "SecondMedia", wechat_url: "https://mmbiz.qpic.cn/second" };
    const replacement = { ...first, sha256: "c".repeat(64), media_id: "ReplacementMedia", wechat_url: "https://mmbiz.qpic.cn/replacement" };
    const failed: WorkbenchRemoteResult = { ok: false, code: "WECHAT_RATE_LIMITED", phase: "sync", channel: "wechat", sideEffect: "read", artifacts: [], issues: [], retryable: false, uploads: [] };
    await overlay(f, doc, { uploads: [first, second] });
    await f.documents.persistRemoteResult(doc, failed, null);
    expect((await f.documents.privateRemoteState(doc.contentRef, null)).uploads).toEqual([first, second]);
    await f.documents.persistRemoteResult(doc, { ...failed, uploads: [replacement] }, null);
    expect((await f.documents.privateRemoteState(doc.contentRef, null)).uploads).toEqual([replacement, second]);
    await f.documents.persistRemoteResult(doc, { ...failed, ok: true, uploads: [replacement] }, null);
    expect((await f.documents.privateRemoteState(doc.contentRef, null)).uploads).toEqual([replacement]);
  });
  it("creates stable content identities across scans and saves without replacing old files", async () => {
    const f = await setup();
    const original = await f.create();
    const old = await readFile(resolve(f.writePath, original.htmlArtifact.relativePath), "utf8");
    const changed = await f.documents.saveRevision(original.contentRef, original.revisionDigest, { metadata: { ...original.metadata, title: "Updated title" }, html: "<h1>Updated title</h1><p>Revised article.</p>", markdown: "# Updated title\nRevised article." });
    expect(changed.document.relativePath).not.toBe(original.document.relativePath);
    expect(await readFile(resolve(f.writePath, original.htmlArtifact.relativePath), "utf8")).toBe(old);
    await f.documents.refresh(); await f.documents.refresh();
    expect(await f.documents.list()).toHaveLength(1);
    expect((await f.documents.list())[0]!.contentRef).toBe(original.contentRef);
    expect((await f.documents.read(original.contentRef)).metadata.title).toBe("Updated title");
  });
  it("rejects stale saves, article identity mutation, unsafe HTML and symlink escape", async () => {
    const f = await setup(); const doc = await f.create();
    const edit = { metadata: doc.metadata, html: doc.html, markdown: doc.markdown };
    await expect(f.documents.saveRevision(doc.contentRef, "sha256:stale", edit)).rejects.toMatchObject({ code: "REVISION_CHANGED" });
    await expect(f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { ...edit, metadata: { ...doc.metadata, articleId: "Other" } })).rejects.toMatchObject({ code: "ARTICLE_ID_IMMUTABLE" });
    await expect(f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { ...edit, html: "<script>alert(1)</script>" })).rejects.toMatchObject({ code: "ACTIVE_CONTENT_REJECTED" });
    await writeFile(resolve(f.directory, "outside.png"), "outside");
    await symlink(resolve(f.directory, "outside.png"), resolve(f.writePath, "escape.png"));
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "escape.png" })).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
  });
  it("copies referenced images into new revisions and renders a network-denied preview", async () => {
    const f = await setup(); const doc = await f.create();
    await writeFile(resolve(f.writePath, "figure.png"), Buffer.from("fixture-image-bytes"));
    const saved = await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: doc.metadata, html: '<p>Article</p><img src="figure.png">', markdown: "Article" });
    expect(saved.assets).toHaveLength(1); expect(saved.assets[0]!.source).toMatch(/^assets\//u);
    await writeFile(resolve(f.writePath, "figure.png"), "changed original");
    expect((await f.documents.read(doc.contentRef)).revisionDigest).toBe(saved.revisionDigest);
    const preview = await f.documents.preview(doc.contentRef);
    expect(preview.width).toBe(390); expect(preview.html).toContain("default-src 'none'"); expect(preview.html).toContain("data:image/png;base64,");
    expect(preview.html).not.toContain(f.writePath);
  });
  it("invalidates reviews when article or evidence changes and requires structured reports", async () => {
    const f = await setup(); const doc = await f.create();
    await f.reviewAll(doc);
    expect((await f.documents.read(doc.contentRef)).reviews.every(value => value.valid)).toBe(true);
    await writeFile(resolve(f.writePath, "facts.json"), "changed evidence");
    expect((await f.documents.read(doc.contentRef)).reviews.find(value => value.kind === "facts")?.valid).toBe(false);
    const changed = await f.documents.saveRevision(doc.contentRef, doc.revisionDigest, { metadata: { ...doc.metadata, title: "Changed" }, html: doc.html, markdown: doc.markdown });
    expect(changed.reviews.every(value => !value.valid)).toBe(true);
    await expect(f.documents.recordReview(doc.contentRef, { kind: "editorial", revisionDigest: doc.revisionDigest, artifact: { rootId: "write", relativePath: "editorial.json" }, reviewer: "user", summary: "Reviewed" })).rejects.toMatchObject({ code: "REVIEW_STALE" });
  });

  it("uses no-follow/nonblocking reads and rejects a final symlink swapped immediately before open", async () => {
    const f = await setup();
    const path = resolve(f.writePath, "race.txt"), outside = resolve(f.directory, "outside.txt");
    await writeFile(path, "inside fixture"); await writeFile(outside, "outside fixture");
    let flags: string | number | undefined;
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      flags = mode;
      await unlink(path); await symlink(outside, path);
      return actualFs.open(file, mode, permissions);
    });
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "race.txt" })).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    expect(typeof flags).toBe("number");
    expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it("rejects an ancestor swapped to an outside directory even though no-follow covers only the final component", async () => {
    const f = await setup();
    const folder = resolve(f.writePath, "race"), outside = resolve(f.directory, "outside-folder");
    await mkdir(folder); await mkdir(outside);
    await writeFile(resolve(folder, "article.txt"), "inside!"); await writeFile(resolve(outside, "article.txt"), "outside");
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      await rename(folder, resolve(f.writePath, "race-retained")); await symlink(outside, folder);
      return actualFs.open(file, mode, permissions);
    });
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "race/article.txt" })).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
  });

  it("rechecks path and inode after reading and closes the handle if the named file was replaced", async () => {
    const f = await setup();
    const path = resolve(f.writePath, "changing.txt");
    await writeFile(path, "original");
    let closed = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      const handle = await actualFs.open(file, mode, permissions);
      closed = vi.spyOn(handle, "close");
      const originalRead = handle.read.bind(handle);
      let changed = false;
      vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await originalRead(buffer, offset, length, position);
        if (!changed) { changed = true; await rename(path, resolve(f.writePath, "retained.txt")); await writeFile(path, "replaced"); }
        return result;
      }) as FileHandle["read"]);
      return handle;
    });
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "changing.txt" })).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-length rewrite during a read rather than trusting byte count alone", async () => {
    const f = await setup(); const path = resolve(f.writePath, "rewritten.txt");
    await writeFile(path, "original");
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      const handle = await actualFs.open(file, mode, permissions), originalRead = handle.read.bind(handle);
      let changed = false;
      vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await originalRead(buffer, offset, length, position);
        if (!changed) { changed = true; await writeFile(path, "modified"); }
        return result;
      }) as FileHandle["read"]);
      return handle;
    });
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "rewritten.txt" })).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
  });

  it("retains bounded stable reads, including empty files, without leaking raw filesystem errors", async () => {
    const f = await setup();
    await writeFile(resolve(f.writePath, "empty.txt"), ""); await writeFile(resolve(f.writePath, "large.txt"), "four");
    expect(await f.documents.readBytes({ rootId: "write", relativePath: "empty.txt" }, 0)).toEqual(Buffer.alloc(0));
    expect((await f.documents.readBytes({ rootId: "write", relativePath: "large.txt" }, 4)).toString()).toBe("four");
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "large.txt" }, 3)).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    await expect(f.documents.readBytes({ rootId: "write", relativePath: "large.txt" }, Infinity)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("does not classify figures or formulas from filenames", async () => {
    const f = await setup(); const doc = await f.create();
    const folder = dirname(resolve(f.writePath, doc.htmlArtifact.relativePath));
    const names = ["original-paper-figure.png", "formula.png", "equation.png", "image.png"];
    for (const name of names) await writeFile(resolve(folder, name), "fixture image bytes");
    await writeFile(resolve(f.writePath, doc.htmlArtifact.relativePath), names.map(name => `<img src="${name}">`).join(""));
    expect((await f.documents.read(doc.contentRef)).assets.map(asset => [asset.source, asset.kind])).toEqual(names.map(name => [name, "other"]));
  });

  it("projects only bounded validated targets and keeps an unverified target explicitly unverified", async () => {
    const f = await setup(); const doc = await f.create(); const { stored, target } = targetFixture(doc, f.now());
    await overlay(f, doc, { targets: [stored] });
    expect((await f.documents.read(doc.contentRef)).targets).toEqual([target]);
    expect(await f.documents.privateRemoteState(doc.contentRef, target)).toEqual({ target: { mediaId: stored.mediaId, title: stored.title, sourceUrl: stored.sourceUrl }, uploads: [] });
    const unverified = { ...stored, verifiedRevision: "", verifiedAt: "" };
    await overlay(f, doc, { targets: [unverified] });
    expect((await f.documents.read(doc.contentRef)).targets).toEqual([{ ...target, verifiedRevision: "", verifiedAt: "" }]);
    await expect(f.documents.privateRemoteState(doc.contentRef, target)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
  });

  it("hides malformed target overlays and refuses to forward them to the bridge", async () => {
    const f = await setup(); const doc = await f.create(); const { stored, target } = targetFixture(doc, f.now());
    const invalid: JsonObject[] = [
      { targetRef: "x".repeat(257) }, { targetRef: "../target" }, { mediaId: "" }, { mediaId: "x".repeat(257) }, { mediaId: { arbitrary: "object" } },
      { title: "x".repeat(201) }, { title: "unsafe\ncontrol" }, { title: "file:///example/private" }, { title: "authorization=synthetic-test-only" },
      { sourceUrl: "http://example.org" }, { sourceUrl: "javascript:alert(1)" }, { sourceUrl: "https://user:pass@example.org" }, { sourceUrl: "https://example.org?access_token=synthetic" }, { sourceUrl: "https://example.org/#access_token=synthetic-test-only" },
      { verifiedRevision: "sha256:invalid" }, { verifiedAt: "2026-02-30T00:00:00Z" }, { verifiedAt: "September 6, 2026" }, { verifiedAt: "" }, { verifiedRevision: "" }, { unknown: "untrusted overlay field" },
    ];
    for (const change of invalid) {
      await overlay(f, doc, { targets: [{ ...stored, ...change }] });
      const changed = await f.documents.read(doc.contentRef);
      expect(changed.targets, JSON.stringify(change)).toEqual([]);
      expect(changed.issues).toContain("TARGET_BINDING_INVALID");
      await expect(f.documents.privateRemoteState(doc.contentRef, target)).rejects.toMatchObject({ code: "TARGET_UNKNOWN" });
      await expect(f.documents.privateRemoteState(doc.contentRef, null)).rejects.toMatchObject({ code: "TARGET_UNKNOWN" });
    }
  });

  it("rejects duplicate target bindings and stale public target metadata", async () => {
    const f = await setup(); const doc = await f.create(); const { stored, target } = targetFixture(doc, f.now());
    await overlay(f, doc, { targets: [stored, { ...stored, mediaId: "FixtureOtherMediaID" }] });
    expect((await f.documents.read(doc.contentRef)).targets).toEqual([]);
    await expect(f.documents.privateRemoteState(doc.contentRef, target)).rejects.toMatchObject({ code: "TARGET_UNKNOWN" });
    await overlay(f, doc, { targets: [{ ...stored, title: "Different verified title" }] });
    await expect(f.documents.privateRemoteState(doc.contentRef, target)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    await overlay(f, doc, { targets: Array.from({ length: 501 }, (_, index) => ({ ...stored, targetRef: `target:${index}` })) });
    expect((await f.documents.read(doc.contentRef)).targets).toEqual([]);
  });

  it("validates the existing upload-map contract and never forwards arbitrary overlay objects", async () => {
    const f = await setup(); const doc = await f.create();
    const upload = { source: "assets/figure.png", sha256: "a".repeat(64), media_id: "FixtureImageID", wechat_url: "https://mmbiz.qpic.cn/fixture" };
    const httpUpload = { ...upload, source: "assets/figure-http.png", wechat_url: "http://mmbiz.qpic.cn/fixture" };
    await overlay(f, doc, { uploads: [upload, httpUpload] });
    expect(await f.documents.privateRemoteState(doc.contentRef, null)).toEqual({ uploads: [upload, httpUpload] });
    const invalid: JsonObject[] = [{ arbitrary: "overlay payload" }, { source: "../outside.png" }, { sha256: "sha256:bad" }, { media_id: "x".repeat(257) }, { wechat_url: "https://example.org/fixture" }, { wechat_url: "https://mmbiz.qpic.cn/fixture?token=synthetic" }, { wechat_url: "https://user:pass@mmbiz.qpic.cn/fixture" }, { wechat_url: "https://mmbiz.qpic.cn:8443/fixture" }];
    for (const change of invalid) {
      await overlay(f, doc, { uploads: [{ ...upload, ...change }] });
      await expect(f.documents.privateRemoteState(doc.contentRef, null)).rejects.toMatchObject({ code: "UPLOAD_STATE_INVALID" });
    }
    await overlay(f, doc, { uploads: [upload, upload] });
    await expect(f.documents.privateRemoteState(doc.contentRef, null)).rejects.toMatchObject({ code: "UPLOAD_STATE_INVALID" });
  });
});

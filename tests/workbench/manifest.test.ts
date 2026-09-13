import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWechatDocument, revisionPayload } from "../../src/domain/wechatDocument.ts";
import { decodeIndexCache, INDEX_CACHE_SCHEMA_VERSION } from "../../src/domain/schema.ts";
import { scanRoots } from "../../src/infrastructure/scanner.ts";
import { createRootCapability } from "../../src/infrastructure/pathPolicy.ts";

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const legacy = {
  schema: "justagent.local-wechat-draft.v1", article_id: "PAPER-123", title: "A research article", author: "Editor",
  digest: "A short description of the paper and its results.", content_file: "article.html", preview_file: "article.preview.html",
  content_source_url: "https://example.org/papers/123", official_pdf_url: "https://example.org/papers/123.pdf",
};

describe("WeChat source indexing", () => {
  it("reads only supported manifests and preserves their type through cache decode", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wm-wechat-index-")); dirs.push(dir);
    await mkdir(resolve(dir, "batch"));
    const file = resolve(dir, "batch/article.local-wechat-draft.json");
    const before = JSON.stringify(legacy); await writeFile(file, before);
    await writeFile(resolve(dir, "batch/private.json"), JSON.stringify({ title: "Not a content manifest" }));
    const cap = await createRootCapability({ id: "old", label: "Old articles", path: dir, mode: "read" });
    if (!cap.ok) throw new Error("fixture unavailable");
    const result = await scanRoots([{ ...cap.value, enabled: true, include: [], exclude: [] }], { maxFileBytes: 65536 });
    expect(result.issues).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ recordKind: "wechat_manifest", articleId: "PAPER-123", contentPath: "batch/article.html", sourceIds: ["wechat:paper-123"] });
    const decoded = decodeIndexCache({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION, generationId: "generation-test", builtAt: "2026-09-06T00:00:00.000Z", sources: result.sources });
    expect(decoded).toMatchObject({ ok: true, value: { sources: [{ recordKind: "wechat_manifest", articleId: "PAPER-123" }] } });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects traversal, active credentials in source URLs and unsupported shapes", () => {
    expect(() => decodeWechatDocument({ ...legacy, content_file: "../escape.html" })).toThrow();
    expect(() => decodeWechatDocument({ ...legacy, content_source_url: "https://example.org/?access_token=hidden" })).toThrow();
    expect(() => decodeWechatDocument({ schema: "unknown", content_file: "article.html" })).toThrow();
  });

  it("preserves the existing public-field revision contract", () => {
    const metadata = decodeWechatDocument(legacy).metadata;
    const htmlDigest = createHash("sha256").update("<p>Article</p>").digest("hex");
    const imageDigest = "a".repeat(64);
    const actual = revisionPayload(metadata, `sha256:${htmlDigest}`, [{ source: "figure.png", digest: `sha256:${imageDigest}` }]);
    expect(JSON.parse(actual)).toEqual([
      "wemedia.article-revision.v1",
      [["article_id", "PAPER-123"], ["title", legacy.title], ["title_prefix", ""], ["author", "Editor"], ["digest", legacy.digest], ["content_source_url", legacy.content_source_url], ["official_pdf_url", legacy.official_pdf_url], ["code_url", ""]],
      htmlDigest, [["figure.png", imageDigest]],
    ]);
  });
});

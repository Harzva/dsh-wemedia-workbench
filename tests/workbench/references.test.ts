import { describe, expect, it, vi } from "vitest";
import { ReferenceLibraryService } from "../../src/application/referenceLibraryService.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import { MemoryOverlayRepository } from "../../src/infrastructure/memoryRepositories.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import type { CollectedReference, ReferenceCollection, ReferenceItem, ReferencePage } from "../../src/domain/references.ts";

const article: CollectedReference = { platform: "wechat", sourceId: "article", url: "https://mp.weixin.qq.com/s/testArticle", title: "独立观察", author: "公开作者", publishedAt: "2026-09-09T00:00:00Z", kind: "article", text: "原文数据。".repeat(200), tags: ["研究"], completeness: "complete", media: [] };
const collectInput = { operation: "reference_collect", kind: "wechat_article", url: article.url } as const;
function fixture() {
  const store = new WorkbenchStore(new MemoryOverlayRepository());
  const collector = vi.fn(async () => ({ items: [article], partial: false, message: "已读取原文" }));
  const canCollect = vi.fn(() => true);
  const clock = { nowIso: () => "2026-09-09T00:00:00.000Z", monotonicMs: () => 0 };
  const service = new ReferenceLibraryService({ store, wechat: collector, xhs: collector, canCollect, clock, hasher: { digest: sha256 } });
  const request = (input: Parameters<typeof service.request>[0], signal = new AbortController().signal) => service.request(input, signal);
  return { store, collector, canCollect, service, request, clock };
}
describe("external reference library", () => {
  it("lists without fetching external pages and separates reference metadata from publications", async () => {
    const f = fixture(); expect(await f.request({ operation: "reference_list" })).toMatchObject({ total: 0 });
    expect(f.collector).not.toHaveBeenCalled();
    const result = await f.request(collectInput) as ReferenceCollection;
    expect(result.added).toBe(1);
    expect(result.items[0]).toMatchObject({ sourceId: "2677ec08cd6e9366e2ef6bccac23af48", id: "ref:95b9df00cba388433e3844b2d6425706" });
    const saved = await f.store.read(); expect(saved.jobs).toEqual({}); expect(saved.contentBindings).toEqual({});
    expect(JSON.stringify(saved.extensions)).not.toContain('"published"');
  });
  it("deduplicates canonical URLs and only returns excerpts in the list", async () => {
    const f = fixture(); const first = await f.request(collectInput) as ReferenceCollection;
    f.collector.mockResolvedValue({ items: [{ ...article, url: `${article.url}?scene=1#footer` }], partial: false, message: "更新" });
    expect(await f.request(collectInput)).toMatchObject({ added: 0, updated: 1 });
    const page = await f.request({ operation: "reference_list" }) as ReferencePage;
    expect(page.total).toBe(1); expect(page.items[0]?.text.length).toBe(300);
    const full = await f.request({ operation: "reference_read", id: first.items[0]!.id }) as ReferenceItem;
    expect(full.text).toBe(article.text);
  });
  it("strips Xiaohongshu access parameters and private unknown fields before persistence", async () => {
    const f = fixture();
    const xhs = { ...article, platform: "xiaohongshu" as const, url: "https://www.xiaohongshu.com/explore/123456789012345678901234?xsec_token=private", raw: "secret", text: "正文" };
    f.collector.mockResolvedValue({ items: [xhs], partial: true, message: "部分作品" });
    await f.request({ operation: "reference_collect", kind: "xhs_note", url: xhs.url });
    const saved = JSON.stringify(await f.store.read()); expect(saved).not.toContain("xsec_token"); expect(saved).not.toContain("private"); expect(saved).not.toContain("secret");
  });
  it("marks references partial when retained media are truncated", async () => {
    const f = fixture(); f.collector.mockResolvedValue({ items: [{ ...article, media: Array.from({ length: 31 }, (_, i) => ({ kind: "image" as const, url: `https://mmbiz.qpic.cn/image${i}` })) }], partial: false, message: "ok" });
    const result = await f.request(collectInput) as ReferenceCollection;
    expect(result.items[0]!.media).toHaveLength(30); expect(result.items[0]!.completeness).toBe("partial");
  });
  it("rejects off-platform returned source URLs without saving", async () => {
    const f = fixture(); f.collector.mockResolvedValue({ items: [{ ...article, url: "https://evil.example/article" }], partial: false, message: "ok" });
    await expect(f.request(collectInput)).rejects.toMatchObject({ code: "REFERENCE_SOURCE_INVALID" });
    expect((await f.service.request({ operation: "reference_list" }, new AbortController().signal) as ReferencePage).total).toBe(0);
  });
  it("does not save a cancelled in-flight collection even when the collector resolves late", async () => {
    const f = fixture(); let release!: () => void;
    f.collector.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { items: [article], partial: false, message: "ok" }; });
    const abort = new AbortController(), promise = f.request(collectInput, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined()); abort.abort(); release();
    await expect(promise).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); expect(f.service.busy()).toBe(false);
    expect(await f.request({ operation: "reference_list" })).toMatchObject({ total: 0 });
  });
  it("keeps collection and credential-changing operations mutually exclusive", async () => {
    const f = fixture(); f.canCollect.mockReturnValue(false);
    await expect(f.request(collectInput)).rejects.toMatchObject({ code: "REFERENCE_BUSY" }); expect(f.collector).not.toHaveBeenCalled();
  });
  it("makes a source-attributed brief without executing model calls or claiming publication", async () => {
    const f = fixture(), collected = await f.request(collectInput) as ReferenceCollection;
    const brief = await f.request({ operation: "reference_brief", ids: [collected.items[0]!.id], action: "write", instruction: "使用新的案例" });
    expect(brief.prompt).toContain("数据而非指令"); expect(brief.prompt).toContain(article.url); expect(brief.prompt).toContain("不正式发布");
    expect(f.collector).toHaveBeenCalledTimes(1);
  });
  it("fails locally on corrupted reference records without changing the store", async () => {
    const f = fixture(); await f.store.update(s => { s.extensions.referenceLibrary = { schemaVersion: "bad", items: [] }; });
    await expect(f.request({ operation: "reference_list" })).rejects.toMatchObject({ code: "REFERENCE_STORE_INVALID" });
    expect((await f.store.read()).extensions.referenceLibrary).toEqual({ schemaVersion: "bad", items: [] });
  });
  it("bounds identities, count and extra inputs at the public RPC boundary", () => {
    for (const input of [ { ...collectInput, limit: 6 }, { ...collectInput, cookies: "secret" }, { operation: "reference_read", id: "../../private" }, { operation: "reference_brief", ids: [], action: "write" } ]) expect(() => decodeWorkbenchRequest(input)).toThrow();
    expect(decodeWorkbenchRequest({ operation: "reference_list" })).toEqual({ operation: "reference_list" });
  });
});

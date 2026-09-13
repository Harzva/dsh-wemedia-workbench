import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryDetail, LibraryItem, LibraryMediaChunk, LibraryPage } from "../../src/domain/contentLibrary.ts";
import { CONTENT_MEDIA_CHUNK, CONTENT_MEDIA_LIMIT, ContentLibraryController, contentCategory, contentDateRange, contentFilterCount, decodeContentMediaChunk, type ContentLibraryRequestFn } from "../../src/client/content-library-controller.ts";
import { ContentLibraryDetail, ContentLibrarySidebar, contentEmptyMessage, contentPreviewDocument, contentPublicationLabel, contentStatusLabel, contentUpdatedLabel } from "../../src/client/content-library.tsx";

// Use the native Client's already-installed React renderer, without another UI dependency.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const item = (id = "a", kind: LibraryItem["kind"] = "article"): LibraryItem => ({ itemId: `library:${id.repeat(64)}`, title: `Content ${id}`, kind, publicationType: kind === "image" ? null : kind, publicationStatus: kind === "article" ? "draft" : "unknown", origin: kind === "article" ? "legacy" : "local", rootLabel: "本地内容", readOnly: true, legacyReadOnly: kind === "article", contentRef: null, mediaType: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : null, bytes: kind === "article" ? null : 3, revisionDigest: `sha256:${id}`, status: "local", updatedAt: null });
const detail = (entry = item()): LibraryDetail => ({ item: entry, html: "<p>Legacy article</p>", markdown: null, issues: [] });
const page = (items = [item()], cursor: string | null = null, revisionDigest = "sha256:inventory"): LibraryPage => ({ items, total: items.length, nextCursor: cursor, revisionDigest, issues: [], truncated: false });
const chunk = (entry: LibraryItem, input: Partial<LibraryMediaChunk> = {}): LibraryMediaChunk => ({ itemId: entry.itemId, revisionDigest: entry.revisionDigest, offset: 0, totalBytes: entry.bytes!, mediaType: entry.mediaType!, dataBase64: Buffer.from("abc").toString("base64"), eof: true, ...input });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }
function setup(respond?: ContentLibraryRequestFn) {
  const request = vi.fn<ContentLibraryRequestFn>(respond ?? (async input => input.operation === "library_list" ? page() : detail()));
  const urls = { create: vi.fn((_blob: Blob) => "blob:local-preview"), revoke: vi.fn() };
  const controller = new ContentLibraryController(request, urls); controller.connect();
  return { controller, request, urls };
}

describe("Content library request ownership", () => {
  it("filters and searches through the Host and ignores an older inventory answer", async () => {
    const old = deferred<LibraryPage>();
    const fixture = setup(async input => input.operation === "library_list" && !input.kind ? old.promise : page([item("b", "image")]));
    const first = fixture.controller.refresh();
    await fixture.controller.setKind("image");
    expect(fixture.request.mock.calls[0]?.[1].aborted).toBe(true);
    old.resolve(page()); await first;
    expect(fixture.controller.getSnapshot().items[0]?.kind).toBe("image");
    await fixture.controller.search("  local  ");
    expect(fixture.request).toHaveBeenLastCalledWith({ operation: "library_list", kind: "image", query: "local", pageSize: 50 }, expect.any(AbortSignal));
    fixture.controller.dispose();
  });

  it("does not mix pagination from a changed inventory", async () => {
    let first = true;
    const fixture = setup(async input => {
      if (input.operation !== "library_list") return detail();
      if (input.cursor) return page([item("c")], null, "sha256:new");
      const result = first ? page([item("a")], "cursor") : page([item("b")], null, "sha256:new"); first = false; return result;
    });
    await fixture.controller.refresh(); await fixture.controller.loadMore();
    expect(fixture.controller.getSnapshot().items.map(value => value.itemId)).toEqual([item("b").itemId]);
    fixture.controller.dispose();
  });

  it("keeps a late article response from replacing a newly selected article", async () => {
    const old = deferred<LibraryDetail>();
    const fixture = setup(async input => input.operation === "library_read" && input.itemId === item().itemId ? old.promise : detail(item("b")));
    const first = fixture.controller.select(item().itemId);
    await fixture.controller.select(item("b").itemId);
    old.resolve(detail()); await first;
    expect(fixture.request.mock.calls[0]?.[1].aborted).toBe(true);
    expect(fixture.controller.getSnapshot().detail?.item.itemId).toBe(item("b").itemId);
    fixture.controller.dispose();
  });

  it("cancels an in-flight media read on switch without creating a stale object URL", async () => {
    const media = item("a", "video"); const pending = deferred<LibraryMediaChunk>();
    const fixture = setup(async input => input.operation === "library_media" ? pending.promise : detail(input.operation === "library_read" && input.itemId === media.itemId ? media : item("b")));
    const first = fixture.controller.select(media.itemId);
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2));
    const mediaSignal = fixture.request.mock.calls[1]![1];
    await fixture.controller.select(item("b").itemId);
    expect(mediaSignal.aborted).toBe(true);
    pending.resolve(chunk(media)); await first;
    expect(fixture.urls.create).not.toHaveBeenCalled();
    expect(fixture.controller.getSnapshot().detail?.item.itemId).toBe(item("b").itemId);
    fixture.controller.dispose();
  });

  it("assembles bounded chunks in order and releases the Blob exactly once on close", async () => {
    const media = { ...item("a", "video"), bytes: CONTENT_MEDIA_CHUNK + 3 };
    const fixture = setup(async input => input.operation === "library_media" ? chunk(media, { offset: input.offset, dataBase64: Buffer.alloc(input.offset ? 3 : CONTENT_MEDIA_CHUNK, 97).toString("base64"), eof: input.offset > 0 }) : detail(media));
    await fixture.controller.select(media.itemId);
    expect(fixture.request.mock.calls.filter(([input]) => input.operation === "library_media").map(([input]) => input.operation === "library_media" ? input.offset : -1)).toEqual([0, CONTENT_MEDIA_CHUNK]);
    const blob = fixture.urls.create.mock.calls[0]![0];
    expect(blob.size).toBe(media.bytes); expect(blob.type).toBe("video/mp4");
    expect(fixture.controller.getSnapshot().mediaUrl).toBe("blob:local-preview");
    fixture.controller.close(); fixture.controller.dispose();
    expect(fixture.urls.revoke).toHaveBeenCalledExactlyOnceWith("blob:local-preview");
  });

  it.each(["close", "dispose", "unavailable", "cancelPreview"] as const)("%s aborts detail loading and discards late completion", async method => {
    const pending = deferred<LibraryDetail>(); const fixture = setup(async () => pending.promise);
    const loading = fixture.controller.select(item().itemId); const signal = fixture.request.mock.calls[0]![1];
    fixture.controller[method](); expect(signal.aborted).toBe(true);
    pending.resolve(detail()); await loading;
    expect(fixture.controller.getSnapshot().detail).toBeNull();
    expect(fixture.controller.getSnapshot().detailLoading).toBe(false);
    fixture.controller.dispose();
  });

  it("exposes cancellation and supports a fresh retry", async () => {
    const fixture = setup(); fixture.controller.cancelPreview();
    expect(fixture.controller.getSnapshot().cancelled).toBe(true);
    await fixture.controller.select(item().itemId);
    expect(fixture.controller.getSnapshot().cancelled).toBe(false);
    expect(fixture.controller.getSnapshot().detail).not.toBeNull(); fixture.controller.dispose();
  });

  it("does not display raw error diagnostics and recovers after a retry", async () => {
    let failed = true;
    const fixture = setup(async input => { if (failed) throw new Error("private-token-and-path"); return input.operation === "library_list" ? page() : detail(); });
    await fixture.controller.refresh(); await fixture.controller.select(item().itemId);
    expect(JSON.stringify(fixture.controller.getSnapshot())).not.toContain("private-token-and-path");
    expect(fixture.controller.getSnapshot().detailError).toContain("重试");
    failed = false; await fixture.controller.refresh(); await fixture.controller.select(item().itemId);
    expect(fixture.controller.getSnapshot().listError).toBeNull(); expect(fixture.controller.getSnapshot().detailError).toBeNull(); fixture.controller.dispose();
  });
});

describe("Content publication and time filters", () => {
  it("keeps every effective filter in search, refresh and pagination requests", async () => {
    const fixture = setup(async input => input.operation === "library_list" ? page([item()], "next") : detail());
    await fixture.controller.setCategory("article");
    await fixture.controller.setPublicationStatus("draft");
    await fixture.controller.setDateRange("custom", "2026-09-01", "2026-09-08");
    await fixture.controller.setSort("updated_asc");
    const expected = { operation: "library_list", publicationType: "article", publicationStatus: "draft", updatedFrom: new Date(2026, 8, 1).toISOString(), updatedTo: new Date(2026, 8, 9).toISOString(), sort: "updated_asc", pageSize: 50 };
    await fixture.controller.search("  开发日记  ");
    expect(fixture.request).toHaveBeenLastCalledWith({ ...expected, query: "开发日记" }, expect.any(AbortSignal));
    await fixture.controller.refresh();
    expect(fixture.request).toHaveBeenLastCalledWith({ ...expected, query: "开发日记" }, expect.any(AbortSignal));
    await fixture.controller.loadMore();
    expect(fixture.request).toHaveBeenLastCalledWith({ ...expected, query: "开发日记", cursor: "next" }, expect.any(AbortSignal));
    expect(contentFilterCount(fixture.controller.getSnapshot())).toBe(4);
    fixture.controller.dispose();
  });

  it("switches atomically between publication types and image assets", async () => {
    const fixture = setup();
    for (const publicationType of ["article", "video", "image_text"] as const) {
      await fixture.controller.setCategory(publicationType);
      expect(fixture.request).toHaveBeenLastCalledWith({ operation: "library_list", publicationType, pageSize: 50 }, expect.any(AbortSignal));
      expect(contentCategory(fixture.controller.getSnapshot())).toBe(publicationType);
    }
    await fixture.controller.setCategory("image");
    expect(fixture.request).toHaveBeenLastCalledWith({ operation: "library_list", kind: "image", pageSize: 50 }, expect.any(AbortSignal));
    await fixture.controller.setCategory("all");
    expect(fixture.request).toHaveBeenLastCalledWith({ operation: "library_list", pageSize: 50 }, expect.any(AbortSignal));
    fixture.controller.dispose();
  });

  it("discards a late page after filters change and preserves the selected media preview", async () => {
    const media = item("b", "video"); const pending = deferred<LibraryPage>();
    const fixture = setup(async input => input.operation === "library_media" ? chunk(media) : input.operation === "library_read" ? detail(media) : input.operation === "library_list" && input.cursor ? pending.promise : page([media], "next"));
    await fixture.controller.refresh(); await fixture.controller.select(media.itemId);
    const selected = fixture.controller.getSnapshot().detail;
    const first = fixture.controller.loadMore();
    const pageSignal = fixture.request.mock.calls.at(-1)![1];
    await fixture.controller.setPublicationStatus("published");
    pending.resolve(page([item("c")], null)); await first;
    expect(pageSignal.aborted).toBe(true);
    expect(fixture.controller.getSnapshot().items).toEqual([media]);
    expect(fixture.controller.getSnapshot().detail).toBe(selected);
    expect(fixture.controller.getSnapshot().mediaUrl).toBe("blob:local-preview");
    expect(fixture.urls.revoke).not.toHaveBeenCalled();
    expect(fixture.request.mock.calls.filter(([input]) => input.operation === "library_read")).toHaveLength(1);
    fixture.controller.dispose();
  });

  it("clears filter payloads, search and pagination while preserving selection", async () => {
    const fixture = setup(async input => input.operation === "library_list" ? page([item()], "next") : detail());
    await fixture.controller.setCategory("article"); await fixture.controller.search("text");
    await fixture.controller.setPublicationStatus("ready"); await fixture.controller.setSort("updated_asc");
    await fixture.controller.setDateRange("today", "", "", new Date(2026, 8, 8, 15));
    await fixture.controller.select(item().itemId);
    const selected = fixture.controller.getSnapshot().detail;
    await fixture.controller.clearFilters();
    expect(fixture.request).toHaveBeenLastCalledWith({ operation: "library_list", pageSize: 50 }, expect.any(AbortSignal));
    expect(contentFilterCount(fixture.controller.getSnapshot())).toBe(0);
    expect(fixture.controller.getSnapshot()).toMatchObject({ query: "", datePreset: "all", sort: "updated_desc", selected: item().itemId });
    expect(fixture.controller.getSnapshot().detail).toBe(selected);
    fixture.controller.dispose();
  });

  it.each(["cancel", "failure"] as const)("never reuses rows or pagination from a previous filter after %s", async outcome => {
    const pending = deferred<LibraryPage>();
    const fixture = setup(async input => {
      if (input.operation !== "library_list") return detail();
      if (!input.publicationType) return page([item()], "article-cursor");
      if (outcome === "failure") throw new Error("remote failure");
      return pending.promise;
    });
    await fixture.controller.refresh(); await fixture.controller.select(item().itemId);
    const loading = fixture.controller.setCategory("video");
    if (outcome === "cancel") { fixture.controller.cancelSearch(); pending.resolve(page([item("b", "video")])); }
    await loading;
    expect(fixture.controller.getSnapshot()).toMatchObject({ publicationType: "video", items: [], total: 0, nextCursor: null, selected: item().itemId });
    expect(fixture.controller.getSnapshot().detail?.item.itemId).toBe(item().itemId);
    expect(fixture.controller.getSnapshot().listError).toContain("重试");
    const count = fixture.request.mock.calls.length;
    await fixture.controller.loadMore(); expect(fixture.request.mock.calls).toHaveLength(count);
    fixture.controller.dispose();
  });

  it.each([["today", "2026-09-08"], ["7d", "2026-09-02"], ["30d", "2026-08-10"]] as const)("converts %s into inclusive local calendar days", (preset, dateFrom) => {
    const range = contentDateRange(preset, "", "", new Date(2026, 8, 8, 15, 45));
    expect(range.dateFrom).toBe(dateFrom); expect(range.dateTo).toBe("2026-09-08");
    expect(range.updatedTo).toBe(new Date(2026, 8, 9).toISOString());
    expect(new Date(range.updatedFrom!).getHours()).toBe(0);
  });

  it("accepts open custom ranges and rejects invalid calendar dates without changing effective filters", async () => {
    expect(contentDateRange("custom", "2026-09-01")).toMatchObject({ updatedFrom: new Date(2026, 8, 1).toISOString(), updatedTo: null });
    expect(contentDateRange("custom", "", "2026-09-01")).toMatchObject({ updatedFrom: null, updatedTo: new Date(2026, 8, 2).toISOString() });
    const fixture = setup(); await fixture.controller.setDateRange("custom", "2026-09-01", "2026-09-08");
    const count = fixture.request.mock.calls.length;
    for (const invalid of [["2026-02-30", "2026-09-08"], ["2026-09-09", "2026-09-08"], ["invalid", ""]]) {
      await fixture.controller.setDateRange("custom", invalid[0], invalid[1]);
      expect(fixture.controller.getSnapshot().filterError).toBeTruthy();
      expect(fixture.controller.getSnapshot().updatedFrom).toBe(new Date(2026, 8, 1).toISOString());
      expect(fixture.request.mock.calls).toHaveLength(count);
    }
    await fixture.controller.clearFilters(); expect(fixture.controller.getSnapshot().filterError).toBeNull(); fixture.controller.dispose();
  });

  it("renders collapsed filters with accurate publication labels and empty states", async () => {
    const fixture = setup(async () => page([])); await fixture.controller.setCategory("image_text");
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    expect(html).toContain('<details class="wm-content-advanced">');
    expect(html).toContain("1 项筛选已生效"); expect(html).toContain("清空筛选");
    for (const label of ["图文", "图像", "更新时间范围", "发布状态", "最近更新优先", "最早更新优先", "今天", "近 7 天", "近 30 天", "自定义日期"]) expect(html).toContain(label);
    expect(html).toContain("尚无图文作品，单张图片属于图像素材。");
    expect(contentPublicationLabel(item("b", "image"))).toBe("图像素材");
    expect(contentPublicationLabel(item("c", "video"))).toBe("视频素材");
    expect(contentStatusLabel(item("c", "video"))).toBe("状态未知");
    expect(contentStatusLabel({ ...item(), status: "draft_verified" })).toBe("草稿");
    expect(contentUpdatedLabel(null)).toBe("更新时间未知");
    await fixture.controller.setPublicationStatus("published");
    expect(contentEmptyMessage(fixture.controller.getSnapshot())).toContain("只有确认发布成功");
    fixture.controller.dispose();
  });
});

describe("Content library preview boundary", () => {
  it("shows readonly video publication drafts in the content list", async () => {
    const entry: LibraryItem = { ...item("v", "video"), publicationRef: "wmc:33333333-3333-4333-8333-333333333333" };
    const fixture = setup(async () => page([entry])); await fixture.controller.refresh();
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    expect(html).toContain("只读"); fixture.controller.dispose();
  });

  it("keeps image-text publication drafts out of article taxonomy badges", async () => {
    const entry: LibraryItem = { ...item(), publicationType: "image_text", publicationRef: "wmc:33333333-3333-4333-8333-333333333333", legacyReadOnly: false };
    const fixture = setup(async input => input.operation === "library_list" ? page([entry]) : detail(entry));
    await fixture.controller.refresh(); await fixture.controller.select(entry.itemId);
    const sidebar = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    expect(sidebar.slice(sidebar.indexOf('class="wm-content-item"'))).not.toContain('aria-label="文章分类与标签"');
    fixture.controller.dispose();
  });

  it("offers source mapping for read-only legacy content without opening the writable article editor", async () => {
    const entry: LibraryItem = { ...item(), mappingRef: "wmc:55555555-5555-4555-8555-555555555555" };
    const fixture = setup(async () => detail(entry)); await fixture.controller.select(entry.itemId);
    const html = renderToStaticMarkup(createElement(ContentLibraryDetail, { controller: fixture.controller, onOpenArticle: vi.fn(), onOpenMapping: vi.fn() }));
    expect(html).toContain("主稿与来源"); expect(html).toContain("旧稿只读预览"); expect(html).not.toContain("打开文章编辑器");
    fixture.controller.dispose();
  });

  it("shows per-platform publication evidence beside legacy article content and in its list badge", async () => {
    const entry: LibraryItem = { ...item(), publications: [{ channel: "wechat", status: "draft", evidence: "draft_readback", note: "公众号草稿已核对。", publishedAt: null, checkedAt: "2026-09-08T01:02:03Z", url: null }, { channel: "zhihu", status: "failed", evidence: "local_receipt", note: "知乎需要登录后重试。", publishedAt: null, checkedAt: null, url: null }] };
    const fixture = setup(async input => input.operation === "library_list" ? page([entry]) : detail(entry));
    await fixture.controller.refresh(); await fixture.controller.select(entry.itemId);
    const sidebar = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    expect(sidebar).toContain('aria-label="发布状态：草稿"');
    const html = renderToStaticMarkup(createElement(ContentLibraryDetail, { controller: fixture.controller, onOpenArticle: vi.fn() }));
    expect(html).toContain('aria-label="文章发布状态"'); expect(html).toContain("平台草稿已核对");
    expect(html).toContain("知乎需要登录后重试"); expect(html).toContain("发布失败");
    expect(html).not.toContain('aria-label="发布状态：已发布"');
    expect(html).toContain('sandbox=""');
    fixture.controller.dispose();
  });

  it.each([
    { bytes: CONTENT_MEDIA_LIMIT + 1, mediaType: "image/png" },
    { bytes: 3, mediaType: "image/svg+xml" },
    { bytes: 3, mediaType: "text/html" },
    { bytes: -1, mediaType: "image/png" },
  ])("rejects unsupported media before reading bytes: %j", async change => {
    const media = { ...item("a", "image"), ...change }; const fixture = setup(async () => detail(media));
    await fixture.controller.select(media.itemId);
    expect(fixture.request).toHaveBeenCalledTimes(1); expect(fixture.urls.create).not.toHaveBeenCalled();
    expect(fixture.controller.getSnapshot().detailError).not.toBeNull(); fixture.controller.dispose();
  });

  it.each([
    { itemId: item("b").itemId }, { revisionDigest: "sha256:changed" }, { offset: 1 }, { totalBytes: 4 },
    { mediaType: "text/html" }, { dataBase64: "%%%%" }, { dataBase64: "YQ==" }, { eof: false },
  ])("rejects a mismatched or corrupt media chunk: %j", patch => {
    const media = item("a", "image"); expect(() => decodeContentMediaChunk(chunk(media, patch), media, 0, 3)).toThrow();
  });

  it("renders legacy HTML only inside an opaque sandbox and escapes SSR markup", async () => {
    const malicious = '<script>evil()</script><a href="https://outside.invalid">outside</a>';
    const fixture = setup(async () => ({ ...detail(), html: malicious })); await fixture.controller.select(item().itemId);
    const html = renderToStaticMarkup(createElement(ContentLibraryDetail, { controller: fixture.controller, onOpenArticle: vi.fn() }));
    expect(html).toContain('sandbox=""'); expect(html).toContain('referrerPolicy="no-referrer"'); expect(html).not.toContain("<script>");
    expect(contentPreviewDocument(malicious)).toContain("&lt;script&gt;");
    expect(contentPreviewDocument(malicious)).toContain("default-src 'none'"); fixture.controller.dispose();
  });

  it("renders all content types with a real selected item and native video controls", async () => {
    const media = item("c", "video"); const fixture = setup(async input => input.operation === "library_list" ? page([item(), item("b", "image"), media]) : input.operation === "library_media" ? chunk(media) : detail(media));
    await fixture.controller.refresh(); await fixture.controller.select(media.itemId);
    const sidebar = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    for (const label of ["全部", "文章", "视频", "图像", "搜索内容", "刷新内容库"]) expect(sidebar).toContain(label);
    expect(sidebar).toContain('aria-current="true"');
    const html = renderToStaticMarkup(createElement(ContentLibraryDetail, { controller: fixture.controller, onOpenArticle: vi.fn() }));
    expect(html).toContain("<video"); expect(html).toContain('controls=""'); expect(html).toContain('src="blob:local-preview"');
    expect(html).not.toContain("autoplay"); fixture.controller.dispose();
  });

  it("does not claim a complete inventory when discovery was truncated or a root failed", async () => {
    const fixture = setup(async () => ({ ...page(), truncated: true, issues: ["某个内容目录暂时无法读取。"] }));
    await fixture.controller.refresh();
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: fixture.controller }));
    expect(html).toContain("部分内容"); expect(html).toContain("扫描达到上限"); expect(html).toContain("某个内容目录暂时无法读取。");
    fixture.controller.dispose();
  });
});

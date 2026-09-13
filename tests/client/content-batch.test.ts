import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryItem, LibraryPage } from "../../src/domain/contentLibrary.ts";
import type { BatchPreflightResult } from "../../src/domain/batchPreflight.ts";
import { ContentLibraryController, type ContentLibraryRequestFn } from "../../src/client/content-library-controller.ts";
import { ContentLibrarySidebar } from "../../src/client/content-library.tsx";
import { ContentBatchResults } from "../../src/client/content-batch.tsx";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const item = (number = 1): LibraryItem => ({ itemId: `library:${String(number).padStart(64, "0")}`, contentRef: `wmc:00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, title: `文章 ${number}`, kind: "article", publicationType: "article", publicationStatus: "draft", readOnly: true, legacyReadOnly: false, rootLabel: "本地文章", origin: "workbench", mediaType: null, bytes: null, status: "drafting", updatedAt: null, revisionDigest: "sha256:revision" });
const page = (): LibraryPage => ({ items: [item()], total: 1, nextCursor: "next", revisionDigest: "sha256:page", issues: [], truncated: false });
const result = (): BatchPreflightResult => ({ schemaVersion: "wemedia.batch-preflight/v1", checkedAt: "2026-09-08T00:00:00Z", cancelled: false, results: [{ contentRef: item().contentRef!, publicationType: "article", revisionDigest: "sha256:revision", channel: "wechat", status: "pass", code: "READY", safeMessage: "公众号本地条件通过", issues: [] }, { contentRef: item().contentRef!, publicationType: "article", revisionDigest: "sha256:revision", channel: "zhihu", status: "block", code: "UNCONFIGURED", safeMessage: "知乎尚未配置适配器", issues: ["仅影响知乎"] }] });
function setup(respond?: ContentLibraryRequestFn) { const request = vi.fn<ContentLibraryRequestFn>(respond ?? (async input => input.operation === "batch_preflight" ? result() : page())); const controller = new ContentLibraryController(request); controller.connect(); return { request, controller }; }

describe("Channel and timestamp basis filters", () => {
  it("keeps timestamp and channel conditions through search, refresh and pagination without changing date instants", async () => {
    const f = setup(); await f.controller.setCategory("article"); await f.controller.setChannel("zhihu"); await f.controller.setPublicationStatus("published"); await f.controller.setTimeField("published"); await f.controller.setDateRange("custom", "2026-09-01", "2026-09-08"); await f.controller.search("论文");
    const expected = { operation: "library_list", publicationType: "article", channel: "zhihu", publicationStatus: "published", timeField: "published", updatedFrom: new Date(2026, 8, 1).toISOString(), updatedTo: new Date(2026, 8, 9).toISOString(), query: "论文", pageSize: 50 };
    expect(f.request).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal)); await f.controller.refresh(); expect(f.request).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal)); await f.controller.loadMore(); expect(f.request).toHaveBeenLastCalledWith({ ...expected, cursor: "next" }, expect.any(AbortSignal));
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller: f.controller }));
    for (const label of ["时间依据", "创建时间", "正式发布时间", "按渠道筛选", "发布时间范围", "发布开始日期", "最近发布优先", "缺少对应时间的内容不匹配日期范围"]) expect(html).toContain(label);
    await f.controller.clearFilters(); expect(f.request).toHaveBeenLastCalledWith({ operation: "library_list", pageSize: 50 }, expect.any(AbortSignal)); expect(f.controller.getSnapshot()).toMatchObject({ channel: "all", timeField: "updated" }); f.controller.dispose();
  });
});

describe("Read-only batch preflight", () => {
  it("only permits executable article/publication refs and caps independent selection at twenty", () => {
    const f = setup(); f.controller.toggleChecked({ ...item(), contentRef: null }, true); expect(f.controller.getSnapshot().checked).toHaveLength(0);
    for (let number = 1; number <= 21; number++) f.controller.toggleChecked(item(number), true);
    expect(f.controller.getSnapshot().checked).toHaveLength(20); expect(f.request).not.toHaveBeenCalled();
    f.controller.toggleChecked(item(1), false); f.controller.toggleChecked({ ...item(21), contentRef: null, publicationRef: item(21).contentRef! }, true);
    expect(f.controller.getSnapshot().checked.at(-1)?.contentRef).toBe(item(21).contentRef); expect(f.controller.getSnapshot().selected).toBeNull(); f.controller.dispose();
  });

  it("preserves checked refs across filters and clear-filters, then issues only a read operation", async () => {
    const f = setup(); f.controller.toggleChecked(item(), true); f.controller.toggleChecked(item(2), true);
    await f.controller.setArticleCategory("arxiv"); await f.controller.clearFilters(); expect(f.controller.getSnapshot().checked).toHaveLength(2);
    f.controller.setBatchChannels(["wechat", "zhihu"]); await f.controller.runBatchPreflight();
    expect(f.request).toHaveBeenLastCalledWith({ operation: "batch_preflight", contentRefs: [item().contentRef, item(2).contentRef], channels: ["wechat", "zhihu"] }, expect.any(AbortSignal));
    expect(f.controller.getSnapshot().batchResult?.results.map(value => value.status)).toEqual(["pass", "block"]);
    expect(f.request.mock.calls.every(([request]) => ["library_list", "batch_preflight"].includes(request.operation))).toBe(true); f.controller.clearChecked(); expect(f.controller.getSnapshot().batchResult).toBeNull(); f.controller.dispose();
  });

  it("ignores a late cancelled batch response and keeps errors free of raw diagnostics", async () => {
    let finish!: (value: BatchPreflightResult) => void; const pending = new Promise<BatchPreflightResult>(resolve => { finish = resolve; });
    const f = setup(async () => pending); f.controller.toggleChecked(item(), true); const reading = f.controller.runBatchPreflight(); const signal = f.request.mock.calls.at(-1)![1];
    f.controller.cancelBatch(); finish(result()); await reading; expect(signal.aborted).toBe(true); expect(f.controller.getSnapshot().batchResult).toBeNull(); expect(f.controller.getSnapshot().batchLoading).toBe(false);
    f.request.mockRejectedValueOnce(new Error("sensitive raw process output")); await f.controller.runBatchPreflight(); expect(f.controller.getSnapshot().batchError).toBe("批量检查未完成，请重试。"); f.controller.dispose();
  });

  it("does not run a batch without both content and channel selections", async () => {
    const f = setup(); await f.controller.runBatchPreflight(); f.controller.toggleChecked(item(), true); f.controller.setBatchChannels([]); await f.controller.runBatchPreflight(); expect(f.request).not.toHaveBeenCalled(); f.controller.dispose();
  });

  it("renders channel failures separately from successful channels", () => {
    const html = renderToStaticMarkup(createElement(ContentBatchResults, { result: result(), checked: [{ contentRef: item().contentRef!, title: "同一篇文章" }] }));
    expect(html).toContain("同一篇文章 · 微信公众号"); expect(html).toContain("同一篇文章 · 知乎"); expect(html).toContain('data-status="pass"'); expect(html).toContain('data-status="block"'); expect(html).toContain("公众号本地条件通过"); expect(html).toContain("仅影响知乎");
  });
});

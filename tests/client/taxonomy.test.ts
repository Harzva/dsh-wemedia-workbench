import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ArticleFacets, ArticleTaxonomy } from "../../src/domain/articleTaxonomy.ts";
import type { LibraryDetail, LibraryItem, LibraryPage } from "../../src/domain/contentLibrary.ts";
import { ContentLibraryController, contentFilterCount, type ContentLibraryRequestFn } from "../../src/client/content-library-controller.ts";
import { ContentLibraryDetail, ContentLibrarySidebar, contentEmptyMessage } from "../../src/client/content-library.tsx";
import { ArticleTaxonomyChips } from "../../src/client/taxonomy.tsx";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const taxonomy: ArticleTaxonomy = { category: "conference", conference: "NeurIPS", year: 2026, tags: ["记忆", "工具调用", "评测"] };
const facets: ArticleFacets = { categories: [{ value: "conference", count: 12 }, { value: "arxiv", count: 36 }, { value: "other", count: 2 }], conferences: [{ value: "NeurIPS", count: 10 }, { value: "ICLR", count: 2 }], years: [{ value: 2026, count: 45 }, { value: 2025, count: 5 }], tags: [{ value: "记忆", count: 18 }, { value: "工具调用", count: 12 }] };
const item: LibraryItem = { itemId: `library:${"a".repeat(64)}`, title: "会议论文解读", kind: "article", publicationType: "article", publicationStatus: "draft", origin: "legacy", rootLabel: "本地文章", readOnly: true, legacyReadOnly: true, contentRef: null, mediaType: null, bytes: null, revisionDigest: "sha256:item", status: "local", updatedAt: null, taxonomy };
const detail: LibraryDetail = { item, html: null, markdown: "本地正文", issues: [] };
const page = (changes: Partial<LibraryPage> = {}): LibraryPage => ({ items: [item], total: 1, nextCursor: "next", revisionDigest: "sha256:list", issues: [], truncated: false, facets, ...changes });
function setup(respond?: ContentLibraryRequestFn) {
  const request = vi.fn<ContentLibraryRequestFn>(respond ?? (async input => input.operation === "library_list" ? page() : detail));
  const controller = new ContentLibraryController(request); controller.connect(); return { request, controller };
}

describe("Article taxonomy filters", () => {
  it("carries all taxonomy, publication and date conditions through search, refresh and pagination", async () => {
    const { controller, request } = setup();
    await controller.setCategory("article"); await controller.setPublicationStatus("draft");
    await controller.setDateRange("custom", "2026-09-01", "2026-09-08");
    await controller.setArticleCategory("conference"); await controller.setConference("NeurIPS");
    await controller.setYear(2026); await controller.setTag("记忆"); await controller.search("  论文  ");
    const expected = { operation: "library_list", pageSize: 50, publicationType: "article", publicationStatus: "draft", category: "conference", conference: "NeurIPS", year: 2026, tag: "记忆", query: "论文", updatedFrom: new Date(2026, 8, 1).toISOString(), updatedTo: new Date(2026, 8, 9).toISOString() };
    expect(request).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal));
    await controller.refresh(); expect(request).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal));
    await controller.loadMore(); expect(request).toHaveBeenLastCalledWith({ ...expected, cursor: "next" }, expect.any(AbortSignal));
    expect(contentFilterCount(controller.getSnapshot())).toBe(8);
    controller.dispose();
  });

  it("uses whole-library facets when the filtered page is empty and retains selection while clearing filters", async () => {
    const { controller, request } = setup(async input => input.operation === "library_list" ? page(input.category ? { items: [], total: 0, nextCursor: null } : {}) : detail);
    await controller.refresh(); await controller.select(item.itemId);
    const selected = controller.getSnapshot().detail;
    await controller.setArticleCategory("arxiv"); await controller.setConference("NeurIPS"); await controller.setYear(2025); await controller.setTag("记忆");
    expect(controller.getSnapshot()).toMatchObject({ total: 0, items: [], facets, selected: item.itemId });
    expect(controller.getSnapshot().detail).toBe(selected);
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller }));
    for (const value of ["arXiv · 36", "NeurIPS · 10", "ICLR · 2", "2026 · 45", "记忆 · 18", "分类与标签统计整个文章库", "没有符合这些条件的内容"]) expect(html).toContain(value);
    await controller.clearFilters();
    expect(request).toHaveBeenLastCalledWith({ operation: "library_list", pageSize: 50 }, expect.any(AbortSignal));
    expect(contentFilterCount(controller.getSnapshot())).toBe(0);
    expect(controller.getSnapshot().detail).toBe(selected);
    expect(controller.getSnapshot().facets).toEqual(facets);
    expect(request.mock.calls.filter(([input]) => input.operation === "library_read")).toHaveLength(1);
    controller.dispose();
  });

  it("discards stale taxonomy facets from cancelled pagination", async () => {
    let resolve!: (value: LibraryPage) => void;
    const pending = new Promise<LibraryPage>(finish => { resolve = finish; });
    const { controller, request } = setup(async input => input.operation !== "library_list" ? detail : input.cursor ? pending : page());
    await controller.refresh(); const first = controller.loadMore(); const previousSignal = request.mock.calls.at(-1)![1];
    await controller.setArticleCategory("arxiv");
    resolve(page({ facets: { ...facets, conferences: [{ value: "stale", count: 1 }] } })); await first;
    expect(previousSignal.aborted).toBe(true); expect(controller.getSnapshot().facets).toEqual(facets);
    controller.dispose();
  });

  it("does not invent conference or topic choices for an older Host without facets", async () => {
    const { controller } = setup(async () => { const result = page(); delete result.facets; return result; });
    await controller.refresh();
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller }));
    expect(html).toContain('aria-label="文章分类"'); expect(html).toContain("全部会议"); expect(html).toContain("全部年份"); expect(html).toContain("全部标签");
    expect(html).not.toContain('option value="NeurIPS"'); expect(html).not.toContain('option value="conference"');
    expect(controller.getSnapshot().facets).toEqual({ categories: [], conferences: [], years: [], tags: [] });
    controller.dispose();
  });

  it("retains a selected taxonomy value when it disappears from the latest inventory", async () => {
    const { controller } = setup(async () => page({ facets: { ...facets, conferences: [], tags: [], years: [], categories: [] } }));
    await controller.setArticleCategory("arxiv"); await controller.setConference("COLM"); await controller.setYear(2024); await controller.setTag("推理");
    const html = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller }));
    for (const value of ["arXiv（当前筛选）", "COLM（当前筛选）", "2024（当前筛选）", "推理（当前筛选）"]) expect(html).toContain(value);
    controller.dispose();
  });

  it("uses the combined empty state when a taxonomy filter excludes image-text publications", async () => {
    const { controller } = setup(async () => page({ items: [], total: 0 }));
    await controller.setCategory("image_text"); await controller.setTag("记忆");
    expect(contentEmptyMessage(controller.getSnapshot())).toContain("没有符合这些条件"); controller.dispose();
  });
});

describe("Article taxonomy presentation", () => {
  it("shows full article taxonomy in detail while limiting list topics to two", async () => {
    const { controller } = setup(); await controller.refresh(); await controller.select(item.itemId);
    const sidebar = renderToStaticMarkup(createElement(ContentLibrarySidebar, { controller }));
    const itemMarkup = sidebar.slice(sidebar.indexOf('class="wm-content-item"'));
    expect(itemMarkup).toContain("NeurIPS 2026"); expect(itemMarkup).toContain("记忆"); expect(itemMarkup).toContain("工具调用"); expect(itemMarkup).toContain("另外 1 个标签"); expect(itemMarkup).not.toContain("评测");
    const html = renderToStaticMarkup(createElement(ContentLibraryDetail, { controller, onOpenArticle: vi.fn() }));
    for (const label of ["文章分类与标签", "会议", "NeurIPS 2026", "记忆", "工具调用", "评测"]) expect(html).toContain(label);
    controller.dispose();
  });

  it("renders unknown taxonomy honestly and escapes label markup", () => {
    const empty = renderToStaticMarkup(createElement(ArticleTaxonomyChips)); expect(empty).toContain("未分类"); expect(empty).toContain("暂无主题标签");
    const html = renderToStaticMarkup(createElement(ArticleTaxonomyChips, { taxonomy: { category: "arxiv", conference: null, year: 2025, tags: ['<script>alert("tag")</script>'] } }));
    expect(html).toContain("arXiv"); expect(html).toContain("2025"); expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  });
});

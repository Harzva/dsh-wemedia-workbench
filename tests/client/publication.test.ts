import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { PublicationRecord } from "../../src/domain/publication.ts";
import { PublicationSourcesCard, PublicationStatusPanel, publicPublicationUrl } from "../../src/client/publication.tsx";
import { WorkbenchPanel } from "../../src/client/views.tsx";
import { WorkbenchController } from "../../src/client/controller.ts";
import type { ArticleDocument, WorkbenchValue } from "../../src/domain/workbench.ts";
import { REVIEW_KINDS } from "../../src/domain/workbench.ts";
import { articleWorkflowStatus } from "../../src/domain/articleWorkflowStatus.ts";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const record = (patch: Partial<PublicationRecord> = {}): PublicationRecord => ({ channel: "wechat", status: "draft", publishedAt: null, checkedAt: null, url: null, evidence: "local_draft", note: "", ...patch });

describe("Article publication evidence presentation", () => {
  it.each([
    ["local_draft", "drafting", "草稿"],
    ["current_reviews", "ready", "待发布"],
    ["incomplete_reviews", "needs_review", "草稿"],
    ["stale_reviews", "needs_review", "草稿"],
    ["stale_target", "needs_revalidation", "状态未知"],
    ["verified_target", "draft_verified", "草稿"],
  ] as const)("derives %s from the selected document when it is absent from the current article page", async (scenario, workflowStatus, publicationLabel) => {
    const contentRef = "wmc:22222222-2222-4222-8222-222222222222" as const;
    const doc: ArticleDocument = { contentRef, document: { rootId: "read", relativePath: "conference/wechat-document.json" }, htmlArtifact: { rootId: "read", relativePath: "conference/article.html" }, metadata: { articleId: "conference", title: "分页外的会议文章", author: "", digest: "", kind: "paper", titlePrefix: "", sourceUrl: "", pdfUrl: "", codeUrl: "" }, html: "<p>Body</p>", markdown: "Body", revisionDigest: "sha256:current", assets: [], readOnlySource: true, reviews: [], targets: [], issues: [], publications: [record({ evidence: "local_draft" })] };
    if (scenario !== "local_draft") doc.reviews = REVIEW_KINDS.map(kind => ({ id: kind, kind, revisionDigest: scenario === "stale_reviews" ? "sha256:old" : doc.revisionDigest, artifact: { rootId: "read", relativePath: `reviews/${kind}.json` }, artifactDigest: "sha256:review", reviewer: "agent", summary: "Review fixture", recordedAt: "2026-09-08T01:02:03Z", valid: true, coverage: { paragraphs: [0], paragraphTotal: 1, assets: [], assetTotal: 0, complete: scenario !== "incomplete_reviews" } }));
    if (scenario === "stale_target" || scenario === "verified_target") doc.targets = [{ targetRef: "target", label: "已有草稿", title: doc.metadata.title, sourceUrl: "", verifiedRevision: scenario === "verified_target" ? doc.revisionDigest : "sha256:old", verifiedAt: "2026-09-08T01:02:03Z" }];
    const controller = new WorkbenchController(() => undefined);
    controller.connect({
      request: async input => {
        let value: WorkbenchValue;
        if (input.operation === "snapshot" || input.operation === "refresh") value = { schemaVersion: "wemedia.workbench/v1", generationId: "test", revision: 1, settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: false, issues: [] }, capabilities: [], jobs: [], supportedChannels: ["wechat"] };
        else if (input.operation === "search") value = { items: [], total: 0, nextCursor: null, revision: 1 };
        else if (input.operation === "inspect") value = doc;
        else if (input.operation === "preview") return { ok: true, value: { ok: false, error: { code: "PREVIEW_FIXTURE_UNAVAILABLE", safeMessage: "此测试不装配浏览器预览。", retryable: false } } };
        else throw new Error(`Unexpected operation: ${input.operation}`);
        return { ok: true, value: { ok: true, value, revision: 1 } };
      },
      intentTask: async () => ({ ok: true, value: { ok: false, prompt: "", code: "UNAVAILABLE" } }),
    });
    controller.open(); await controller.refresh(); await controller.select(contentRef);
    expect(controller.getSnapshot().page?.items).toEqual([]);
    expect(articleWorkflowStatus(doc)).toBe(workflowStatus);
    const html = renderToStaticMarkup(createElement(WorkbenchPanel, { controller, embedded: true, detailOnly: true }));
    expect(html).toContain(`aria-label="发布状态：${publicationLabel}"`);
    expect(html).not.toContain('aria-label="发布状态：已发布"');
    controller.dispose();
  });

  it("keeps publication state distinct from local edits and draft targets in the real article editor", async () => {
    const contentRef = "wmc:11111111-1111-4111-8111-111111111111" as const;
    const doc: ArticleDocument = { contentRef, document: { rootId: "write", relativePath: "article/wechat-document.json" }, htmlArtifact: { rootId: "write", relativePath: "article/article.html" }, metadata: { articleId: "test", title: "文章发布状态验收", author: "", digest: "", kind: "article", titlePrefix: "", sourceUrl: "", pdfUrl: "", codeUrl: "" }, html: "<p>Body</p>", markdown: "Body", revisionDigest: "sha256:revision", assets: [], readOnlySource: false, reviews: [], targets: [{ targetRef: "target", label: "已有草稿", title: "文章发布状态验收", sourceUrl: "", verifiedRevision: "sha256:revision", verifiedAt: "2026-09-08T01:02:03Z" }], issues: [], publications: [record({ evidence: "draft_readback" })], taxonomy: { category: "conference", conference: "ICLR", year: 2026, tags: ["记忆", "评测"] } };
    const controller = new WorkbenchController(() => undefined);
    controller.connect({
      request: async input => {
        let value: WorkbenchValue;
        if (input.operation === "snapshot" || input.operation === "refresh") value = { schemaVersion: "wemedia.workbench/v1", generationId: "test", revision: 1, settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: false, issues: [] }, capabilities: [], jobs: [], supportedChannels: ["wechat"] };
        else if (input.operation === "search") value = { items: [{ contentRef, title: doc.metadata.title, articleId: "test", rootLabel: "本地文章", channel: "wechat", readOnlySource: false, status: "draft_verified", issueCount: 0 }], total: 1, nextCursor: null, revision: 1 };
        else if (input.operation === "inspect") value = doc;
        // This Node render exercises the article editor; browser-only preview is unavailable here.
        else if (input.operation === "preview") return { ok: true, value: { ok: false, error: { code: "PREVIEW_FIXTURE_UNAVAILABLE", safeMessage: "此测试不装配浏览器预览。", retryable: false } } };
        else throw new Error(`Unexpected operation: ${input.operation}`);
        return { ok: true, value: { ok: true, value, revision: 1 } };
      },
      intentTask: async () => ({ ok: true, value: { ok: false, prompt: "", code: "UNAVAILABLE" } }),
    });
    controller.open(); await controller.refresh(); await controller.select(contentRef);
    let html = renderToStaticMarkup(createElement(WorkbenchPanel, { controller, embedded: true, detailOnly: true }));
    expect(html).toContain('aria-label="文章发布状态"');
    expect(html).toContain('aria-label="文章分类与标签"'); expect(html).toContain("ICLR 2026"); expect(html).toContain("记忆");
    expect(html).toContain("本地已保存"); expect(html).toContain("平台草稿已核对");
    expect(html).not.toContain('aria-label="发布状态：已发布"');
    controller.updateEdit({ title: "未保存的新标题" });
    html = renderToStaticMarkup(createElement(WorkbenchPanel, { controller, embedded: true, detailOnly: true }));
    expect(html).toContain("当前修改未保存"); expect(html).toContain('value="未保存的新标题"');
    expect(controller.dirty).toBe(true); expect(controller.getSnapshot().document?.metadata.title).toBe("文章发布状态验收");
    controller.dispose();
  });

  it("distinguishes saved content and verified platform drafts from publication", () => {
    const html = renderToStaticMarkup(createElement(PublicationStatusPanel, { status: "draft", records: [record(), record({ channel: "zhihu", evidence: "draft_readback", checkedAt: "2026-09-08T01:02:03Z", note: "只读核对了已有草稿。" })] }));
    for (const label of ["文章发布状态", "本地已保存", "微信公众号", "本地草稿", "知乎", "平台草稿", "平台草稿已核对", "核对时间", "本地保存和平台草稿均不代表正式发布"]) expect(html).toContain(label);
    expect(html).not.toContain('aria-label="发布状态：已发布"');
    expect(html).not.toContain("发布时间：");
    expect(html).not.toContain("<select");
  });

  it("labels historical receipts without claiming current revision or live platform verification", () => {
    const html = renderToStaticMarkup(createElement(PublicationStatusPanel, { status: "published", dirty: true, records: [record({ channel: "xiaohongshu", status: "published", evidence: "local_receipt", publishedAt: "2026-09-07T01:02:03Z", url: "https://www.xiaohongshu.com/explore/test", note: "历史记录中的已发布图文。" })] }));
    expect(html).toContain("当前修改未保存"); expect(html).not.toContain("本地已保存");
    expect(html).toContain("本地发布记录 · 未实时核验");
    expect(html).toContain("历史发布记录不表示当前修订已发布");
    expect(html).toContain("小红书"); expect(html).toContain("发布时间：");
    expect(html).toContain('href="https://www.xiaohongshu.com/explore/test"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("preserves blocked and removed channel outcomes instead of presenting success", () => {
    const html = renderToStaticMarkup(createElement(PublicationStatusPanel, { status: "unknown", records: [record({ channel: "zhihu", status: "failed", evidence: "local_receipt", note: "需要登录后重试。" }), record({ channel: "x", status: "removed", evidence: "remote_readback" })] }));
    expect(html).toContain("发布失败"); expect(html).toContain("需要登录后重试");
    expect(html).toContain("已下架"); expect(html).toContain("平台回读记录");
    expect(html).not.toContain('aria-label="发布状态：已发布"');
  });

  it("has an honest empty state when an older Host has no publication projection", () => {
    const html = renderToStaticMarkup(createElement(PublicationStatusPanel, { status: "unknown" }));
    expect(html).toContain("暂无可核验的渠道发布记录");
    expect(html).toContain('aria-label="发布状态：状态未知"');
    expect(html).not.toContain("微信公众号"); expect(html).not.toContain("小红书");
  });

  it("shows existing inventory separately from login and publishing capabilities", () => {
    const html = renderToStaticMarkup(createElement(PublicationSourcesCard, { summary: { available: true, checkedAt: "2026-09-08T01:02:03Z", counts: { ledgerRecords: 6, zhihuArticles: 8, xiaohongshuRecords: 2 }, channels: ["zhihu", "xiaohongshu"], issues: ["部分历史记录缺少时间。"] } }));
    for (const value of ["本地发布记录", "知乎、小红书", "跨平台记录", "6 条", "知乎文章库存", "8 篇", "小红书记录", "2 条", "知乎库存同步于", "读取成功不代表账号已登录或自动发布可用", "部分历史记录缺少时间"]) expect(html).toContain(value);
    expect(html).not.toContain("<button");
    const unavailable = renderToStaticMarkup(createElement(PublicationSourcesCard, { summary: { available: false, checkedAt: null, counts: { ledgerRecords: 0, zhihuArticles: 0, xiaohongshuRecords: 0 }, channels: [], issues: [] } }));
    expect(unavailable).toContain("暂不可用"); expect(unavailable).toContain("时间未记录");
    expect(unavailable).not.toContain("0 条"); expect(unavailable).not.toContain("已复用");
  });

  it("preserves ordinary public article links and harmless query parameters", () => {
    expect(publicPublicationUrl("https://zhuanlan.zhihu.com/p/12345")).toBe("https://zhuanlan.zhihu.com/p/12345");
    expect(publicPublicationUrl("https://example.org/article?id=123&source=library")).toBe("https://example.org/article?id=123&source=library");
  });

  it.each(["javascript:alert(1)", "data:text/html,example", "file:///tmp/article.html", "https://name:secret@example.org/path", "not a URL", ...["token", "access_token", "secret", "password", "cookie", "authorization", "api_key", "API-Key", "%74oken"].map(key => `https://example.org/article?${key}=synthetic-value`)])("does not activate unsafe receipt link %s", url => {
    expect(publicPublicationUrl(url)).toBeNull();
    const html = renderToStaticMarkup(createElement(PublicationStatusPanel, { status: "draft", records: [record({ url, note: "<img src=x onerror=alert(1)>" })] }));
    expect(html).not.toContain("href="); expect(html).not.toContain("<img"); expect(html).toContain("&lt;img");
  });
});

import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../../src/domain/job.ts";
import type { ArticleDocument, ArticleEdit, WorkbenchJob } from "../../src/domain/workbench.ts";
import { attentionJob, editDiffs, statusLabel } from "../../src/client/presentation.ts";

function article(): ArticleDocument {
  return {
    contentRef: "wmc:11111111-1111-4111-8111-111111111111",
    document: { rootId: "read", relativePath: "article/manifest.json" },
    htmlArtifact: { rootId: "read", relativePath: "article/article.html" },
    metadata: { articleId: "article-one", title: "旧标题", author: "原作者", digest: "原摘要", kind: "paper", titlePrefix: "原前缀", sourceUrl: "https://example.org/source", pdfUrl: "https://example.org/paper.pdf", codeUrl: "https://example.org/code" },
    html: "<p>原始正文</p>\n", markdown: "# 原始正文\n", revisionDigest: "sha256:original",
    assets: [], readOnlySource: true, reviews: [], targets: [], issues: [],
  };
}

const editable = (document: ArticleDocument): ArticleEdit => ({ metadata: { ...document.metadata }, html: document.html, markdown: document.markdown });
const job = (status: WorkbenchJob["status"]): WorkbenchJob => ({
  jobId: "job-one", generationId: "generation-one", contentRef: "wmc:11111111-1111-4111-8111-111111111111",
  intentId: "intent-one", inputDigest: "sha256:input", action: "save_revision", sideEffect: "local_write", status,
  progress: { current: 0 }, safeMessage: "任务状态来自 Host", createdAt: "2026-09-06T12:00:00.000Z", retryable: false, artifactRefs: [],
});

describe("Native edit diff presentation boundary", () => {
  it("returns no hunks when editable content is unchanged", () => {
    const document = article();
    expect(editDiffs(document, editable(document))).toStrictEqual([]);
  });

  it.each([
    ["title", "标题", "新标题"],
    ["digest", "纯文本摘要", "新摘要\n第二行"],
    ["author", "作者", "新作者"],
    ["articleId", "文章 ID", "article-two"],
    ["kind", "内容类型", "article"],
    ["titlePrefix", "标题前缀", "新前缀"],
    ["sourceUrl", "来源 URL", "https://example.org/revised-source"],
    ["pdfUrl", "PDF URL", "https://example.org/revised.pdf"],
    ["codeUrl", "代码 URL", "https://example.org/revised-code"],
  ] as const)("includes only the changed public metadata field %s", (key, path, value) => {
    const document = article();
    const edit = editable(document);
    edit.metadata = { ...edit.metadata, [key]: value };
    expect(editDiffs(document, edit)).toStrictEqual([{ path, oldText: document.metadata[key], newText: value }]);
  });

  it.each([["html", "正文 HTML"], ["markdown", "Markdown"]] as const)("preserves the exact %s before and after values without normalizing whitespace or markup", (key, path) => {
    const document = article();
    const edit = editable(document);
    const value = "  <strong>新内容 &amp; 公式 α</strong>\r\n\n";
    edit[key] = value;
    expect(editDiffs(document, edit)).toStrictEqual([{ path, oldText: document[key], newText: value }]);
  });

  it("includes simultaneous metadata, HTML and Markdown changes without unrelated fields or input mutation", () => {
    const document = article();
    const edit = editable(document);
    edit.metadata.title = "新标题";
    edit.metadata.sourceUrl = "";
    edit.html = "<p>新正文</p>";
    edit.markdown = "新正文";
    const beforeDocument = structuredClone(document);
    const beforeEdit = structuredClone(edit);
    expect(editDiffs(document, edit)).toStrictEqual([
      { path: "标题", oldText: "旧标题", newText: "新标题" },
      { path: "来源 URL", oldText: "https://example.org/source", newText: "" },
      { path: "正文 HTML", oldText: "<p>原始正文</p>\n", newText: "<p>新正文</p>" },
      { path: "Markdown", oldText: "# 原始正文\n", newText: "新正文" },
    ]);
    expect(document).toStrictEqual(beforeDocument);
    expect(edit).toStrictEqual(beforeEdit);
  });

  it.each([["title", "标题"], ["html", "正文 HTML"], ["markdown", "Markdown"]] as const)("preserves undefined old/new %s values as explicit hunk properties", (key, path) => {
    // Defensive presentation coverage for an incomplete runtime payload. Valid
    // Host DTOs require these strings; the view must not stringify missing data.
    for (const [oldText, newText] of [[undefined, "新增内容"], ["原内容", undefined]] as const) {
      const document = article();
      const edit = editable(document);
      const before = (key === "title" ? document.metadata : document) as unknown as Record<string, unknown>;
      const after = (key === "title" ? edit.metadata : edit) as unknown as Record<string, unknown>;
      before[key] = oldText;
      after[key] = newText;
      const diffs = editDiffs(document, edit);
      expect(diffs).toStrictEqual([{ path, oldText, newText }]);
      expect(Object.hasOwn(diffs[0]!, "oldText")).toBe(true);
      expect(Object.hasOwn(diffs[0]!, "newText")).toBe(true);
    }
  });

  it("does not manufacture changes for fields missing on both sides", () => {
    const document = article();
    const edit = editable(document);
    for (const value of [document.metadata, edit.metadata]) delete (value as unknown as Record<string, unknown>).title;
    for (const value of [document, edit]) {
      delete (value as unknown as Record<string, unknown>).html;
      delete (value as unknown as Record<string, unknown>).markdown;
    }
    expect(editDiffs(document, edit)).toStrictEqual([]);
  });

  it("does not serialize private or unknown metadata and unrelated DTO fields", () => {
    const document = article();
    document.metadata.internalOnly = "non-display-metadata-old";
    document.internalOnly = "non-display-document-old";
    const edit: ArticleEdit = {
      ...editable(document),
      metadata: { ...document.metadata, title: "公开新标题", internalOnly: "non-display-metadata-new" },
      internalOnly: "non-display-document-new",
      revisionDigest: "non-display-revision",
      targets: [{ targetRef: "non-display-target" }],
      assets: [{ source: "non-display-asset" }],
    };
    const diffs = editDiffs(document, edit);
    expect(diffs).toStrictEqual([{ path: "标题", oldText: "旧标题", newText: "公开新标题" }]);
    expect(JSON.stringify(diffs)).not.toContain("non-display");
    edit.metadata.title = document.metadata.title;
    expect(editDiffs(document, edit)).toStrictEqual([]);
  });
});

describe("Status labels and attention filters", () => {
  it("gives distinct labels to active, approval, success and recovery states", () => {
    const expected: Record<string, string> = {
      queued: "排队中", running: "执行中", waiting_user: "等待原生审批", succeeded: "已完成",
      failed: "失败", cancelled: "已取消", timed_out: "已超时", reconcile_required: "需要核对结果",
      needs_review: "待审阅", draft_verified: "草稿已核对", pass: "通过", warn: "提醒", block: "阻断",
      unavailable: "不可用", unsupported: "不支持", approval_required: "需要审批",
    };
    for (const [status, label] of Object.entries(expected)) expect(statusLabel(status)).toBe(label);
  });

  it.each(["future_status", "", "constructor", "toString", "__proto__"])("preserves the unknown status %j as a string instead of guessing or reading object prototypes", value => {
    expect(statusLabel(value)).toBe(value);
    expect(typeof statusLabel(value)).toBe("string");
  });

  it("flags exactly approval waiting, failure, timeout and unresolved results across all Job states", () => {
    const expected: Record<WorkbenchJob["status"], boolean> = {
      queued: false, running: false, waiting_user: true, succeeded: false,
      failed: true, cancelled: false, timed_out: true, reconcile_required: true,
    };
    for (const status of JOB_STATUSES) expect(attentionJob(job(status))).toBe(expected[status]);
  });

  it("does not infer attention from retryability, diagnostics or stale result codes", () => {
    expect(attentionJob({ ...job("queued"), retryable: true, safeMessage: "failed-looking text", resultCode: "OLD_FAILURE" })).toBe(false);
    expect(attentionJob({ ...job("failed"), retryable: false, safeMessage: "Succeeded-looking text", resultCode: "OLD_SUCCESS" })).toBe(true);
  });
});

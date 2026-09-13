import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ArticleDocument, ReviewEvidence } from "../../src/domain/workbench.ts";
import { articleMaterialsModel, articleReviewsModel, documentIssueView, formatAssetBytes, gateStatusLabel, relativeArtifactLabel, safeHttpsLink } from "../../src/client/evidence-model.ts";
import { ArticleMaterials, ArticleReviews } from "../../src/client/evidence.tsx";

const document: ArticleDocument = {
  contentRef: "wmc:11111111-1111-4111-8111-111111111111",
  document: { rootId: "read", relativePath: "article/manifest.json" },
  htmlArtifact: { rootId: "read", relativePath: "article/article.html" },
  metadata: { articleId: "article", title: "Test article", author: "", digest: "", kind: "paper", titlePrefix: "", sourceUrl: "https://example.org/paper", pdfUrl: "", codeUrl: "http://example.org/code" },
  html: "", markdown: "", revisionDigest: "sha256:current", assets: [], readOnlySource: true, reviews: [], targets: [], issues: [],
};

const review = (change: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  id: "review-1", kind: "facts", revisionDigest: document.revisionDigest,
  artifact: { rootId: "write", relativePath: "evidence/facts.json" }, artifactDigest: "sha256:report",
  reviewer: "user", summary: "核对摘要中的两项结论", recordedAt: "2026-09-06T12:30:00.000Z", valid: true,
  ...change,
});

function elements(node: ReactNode, type: string): Array<ReactElement<Record<string, unknown>>> {
  const matches: Array<ReactElement<Record<string, unknown>>> = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (child.type === type) matches.push(child);
    matches.push(...elements(child.props.children as ReactNode, type));
  }
  return matches;
}

describe("Article evidence presentation model", () => {
  it("offers only explicit credential-free HTTPS source links", () => {
    expect(safeHttpsLink("https://example.org/paper?id=1#figure-2")).toBe("https://example.org/paper?id=1#figure-2");
    for (const invalid of ["http://example.org", "javascript:alert(1)", "data:text/html,test", "file:///absolute/file.pdf", "//example.org", "https://user:pass@example.org", "https://example.org\\private", "https://example.org/\nother", "https:", ""]) expect(safeHttpsLink(invalid)).toBeNull();
  });

  it("shows missing and rejected sources without echoing unsafe URL values", () => {
    const model = articleMaterialsModel(document);
    expect(model.author).toBe("未记录作者");
    expect(model.kind).toBe("论文解读");
    expect(model.sources.map(source => source.status)).toEqual(["ready", "missing", "unsupported"]);
    expect(model.sources[2]).toMatchObject({ href: null, description: "仅展示无凭据的 HTTPS 链接" });
    expect(JSON.stringify(model)).not.toContain("http://example.org/code");
    expect(model.sourceNote).toContain("来源文件只读");
    expect(model.sourceNote).toContain("不覆盖原始文件");
    expect(articleMaterialsModel({ ...document, readOnlySource: false }).sourceNote).toContain("新修订");
  });

  it("does not infer original or formula provenance from filenames", () => {
    const assets = ["original-figure.png", "formula-proof.png"].map(name => ({ source: name, artifact: { rootId: "read", relativePath: `article/${name}` }, digest: `sha256:${name}`, mediaType: "image/png", kind: "other" as const, bytes: 1536 }));
    const model = articleMaterialsModel({ ...document, assets });
    expect(model.assets.map(asset => asset.kind)).toEqual(["来源类别未标注", "来源类别未标注"]);
    expect(model.assets[0]).toMatchObject({ name: "original-figure.png", mediaType: "image/png", size: "1.5 KB", artifact: "read:article/original-figure.png", digest: "sha256:original-figure.png" });
    expect(articleMaterialsModel(document).assets).toEqual([]);
  });

  it("preserves only explicit asset classifications as labels, not verification claims", () => {
    const assets = (["original", "formula"] as const).map(kind => ({ source: "figure.png", artifact: { rootId: "read", relativePath: `article/${kind}.png` }, digest: "sha256:image", mediaType: "image/png", kind, bytes: 1 }));
    expect(articleMaterialsModel({ ...document, assets }).assets.map(asset => asset.kind)).toEqual(["原图（来源标注）", "公式（来源标注）"]);
  });

  it("keeps machine paths and traversal out of relative artifact labels", () => {
    expect(relativeArtifactLabel({ rootId: "read", relativePath: "材料/图 1.png" })).toBe("read:材料/图 1.png");
    for (const relativePath of ["/absolute/figure.png", "../figure.png", "article/../figure.png", "C:\\figure.png", "file:///figure.png", "article//figure.png", ""]) expect(relativeArtifactLabel({ rootId: "read", relativePath })).toBe("材料引用不可展示");
    expect(relativeArtifactLabel({ rootId: "/absolute", relativePath: "figure.png" })).toBe("材料引用不可展示");
    const model = articleMaterialsModel({ ...document, assets: [{ source: "/absolute/figure.png", artifact: { rootId: "read", relativePath: "/absolute/figure.png" }, digest: "sha256:image", mediaType: "image/png", kind: "other", bytes: 1 }] });
    expect(JSON.stringify(model)).not.toContain("/absolute");
  });

  it("formats actual sizes without manufacturing unknown byte counts", () => {
    expect([0, 1023, 1024, 1.5 * 1024 * 1024].map(formatAssetBytes)).toEqual(["0 B", "1023 B", "1 KB", "1.5 MB"]);
    for (const invalid of [-1, NaN, Infinity, 1.5]) expect(formatAssetBytes(invalid)).toBe("大小未记录");
  });

  it("always exposes all four review categories, including explicit pending states", () => {
    const model = articleReviewsModel(document);
    expect(model.categories.map(category => category.kind)).toEqual(["facts", "editorial", "images_formulas", "mobile_visual"]);
    expect(model.categories.every(category => category.currentCount === 0 && category.staleCount === 0)).toBe(true);
    expect(model.records).toEqual([]);
  });

  it("requires both Host validity and current revision without promoting stale evidence", () => {
    const reviews = [review(), review({ id: "stale", revisionDigest: "sha256:old", valid: false }), review({ id: "invalid-artifact", valid: false }), review({ id: "mismatched", revisionDigest: "sha256:old", valid: true })];
    const model = articleReviewsModel({ ...document, reviews });
    expect(model.categories[0]).toMatchObject({ kind: "facts", currentCount: 1, staleCount: 3 });
    expect(model.records.map(record => record.current)).toEqual([true, false, false, false]);
    expect(reviews[3]?.valid).toBe(true);
  });

  it("keeps complete evidence metadata and honest summaries for record inspection", () => {
    const model = articleReviewsModel({ ...document, reviews: [review(), review({ id: "agent", reviewer: "agent", summary: "", recordedAt: "not-a-time" })] });
    expect(model.records[0]).toEqual({ id: "review-1", category: "资料与事实", current: true, reviewer: "用户", recordedAt: "2026-09-06T12:30:00.000Z", summary: "核对摘要中的两项结论", revisionDigest: "sha256:current", artifactDigest: "sha256:report", artifact: "write:evidence/facts.json" });
    expect(model.records[1]).toMatchObject({ reviewer: "Agent", summary: "未填写审读摘要", recordedAt: "记录时间格式无法识别" });
  });

  it("humanizes known document issues and keeps unknown codes secondary", () => {
    expect(documentIssueView("IMAGE_UNAVAILABLE")).toMatchObject({ message: expect.stringContaining("图片未能读取"), code: "IMAGE_UNAVAILABLE" });
    expect(documentIssueView("TARGET_BINDING_INVALID").message).toContain("核对草稿身份");
    expect(documentIssueView("FUTURE_ISSUE")).toMatchObject({ message: expect.stringContaining("待处理问题"), code: "FUTURE_ISSUE" });
    expect(documentIssueView("需要补充来源")).toEqual({ message: "需要补充来源", code: null });
    expect((["pass", "warn", "block"] as const).map(gateStatusLabel)).toEqual(["通过", "提醒", "阻断"]);
  });

  it("renders user-activated safe links and an empty material state without fabricated media", () => {
    const node = ArticleMaterials({ document });
    const links = elements(node, "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.props).toMatchObject({ href: "https://example.org/paper", target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" });
    expect(elements(node, "img")).toHaveLength(0);
    expect(elements(node, "iframe")).toHaveLength(0);
    expect(elements(node, "p").some(element => element.props.role === "status" && String(element.props.children).includes("暂无已解析素材"))).toBe(true);
  });

  it("renders pending categories, actual gate messages and bounded action controls", () => {
    const onPreflight = vi.fn(); const onAgent = vi.fn();
    const props = { document, report: { status: "block" as const, inputDigest: "sha256:gate", issues: [{ gateId: "materials", version: "1", status: "block" as const, code: "MISSING_IMAGE", safeMessage: "补齐缺失图片后重新检查", evidenceRefs: [], inputDigest: "sha256:gate" }] }, onPreflight, onAgent, busy: true };
    const node = ArticleReviews(props);
    expect(elements(node, "div").filter(element => element.props["data-review-state"] === "pending")).toHaveLength(4);
    expect(elements(node, "p").some(element => Children.toArray(element.props.children as ReactNode).includes("补齐缺失图片后重新检查"))).toBe(true);
    const busyButton = elements(node, "button").find(element => element.props.children === "正在校验…");
    expect(busyButton?.props).toMatchObject({ type: "button", disabled: true, onClick: onPreflight });
    const ready = ArticleReviews({ ...props, busy: false });
    const buttons = elements(ready, "button");
    const run = buttons.find(element => element.props.children === "运行机械校验");
    expect(run?.props.disabled).toBe(false);
    (run?.props.onClick as () => void)();
    const agent = buttons.find(element => element.props.children === "进入 Agent 审阅");
    (agent?.props.onClick as () => void)();
    expect(onPreflight).toHaveBeenCalledOnce();
    expect(onAgent).toHaveBeenCalledOnce();
  });
});

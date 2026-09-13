import { describe, expect, it } from "vitest";
import { classifyArticle, isTaxonomyLabel, readArticleFrontmatter } from "../../src/domain/articleTaxonomy.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";

describe("local article taxonomy", () => {
  it.each(["arxiv:2410.07095", '"arxiv:2410.07095"', '["arxiv:2410.07095", "github:fixture"]', "['arxiv:2410.07095']", "\n  - arxiv:2410.07095\n  - github:fixture"])("reads existing frontmatter source_ids form %s", source => {
    const markdown = `---\ntitle: 论文精读\nsource_ids: ${source}\n---\n# 论文精读\n`;
    expect(classifyArticle({ title: "论文精读", markdown })).toMatchObject({ category: "arxiv", year: 2024 });
  });
  it("preserves conference identity when its paper also has an arXiv version", () => {
    expect(classifyArticle({ title: "工具调用的评测", path: "daily/aaai2026-agent-core-batch-01/article.local-wechat-draft.json", metadata: { source_ids: "arxiv:2410.07095", agent_topic_key: "tool", agent_topic_full: "工具调用" } })).toEqual({ category: "conference", conference: "AAAI", year: 2026, tags: ["工具调用"] });
  });
  it("uses explicit registry topics and venue instead of scanning citations", () => {
    expect(classifyArticle({ title: "A video system", metadata: { conference: "CVPR", year: 2026, tags: ["视频 Agent", "专题导航"] }, markdown: "# 文章\n\n## 参考文献\nICLR 2025, arxiv:2501.12345" })).toEqual({ category: "conference", conference: "CVPR", year: 2026, tags: ["视频 Agent", "专题导航"] });
    expect(classifyArticle({ title: "如何阅读论文", markdown: "# 如何阅读论文\n\n## 参考文献\narxiv:2501.12345 (ICLR 2025)" }).category).toBe("other");
  });
  it("recognizes explicit arXiv series and keeps absent dates unknown", () => {
    expect(classifyArticle({ title: "CARD", metadata: { series: "arXiv Agent 论文精读" }, markdown: "# CARD\n\narXiv:2608.20763\n\n## 方法" })).toMatchObject({ category: "arxiv", year: 2026 });
    expect(classifyArticle({ title: "普通文章" })).toEqual({ category: "other", conference: null, year: null, tags: [] });
  });
  it("recognizes explicit source metadata in a paper introduction, never a later reference section", () => {
    const information = "- 类型：具身 Agent 安全 benchmark，arXiv v1，2026 年 7 月 16 日";
    expect(classifyArticle({ title: "SafeRelBench", path: "2026-07-18-paper.md", markdown: `# SafeRelBench\n\n**核心信息**\n${information}\n\n## 01 方法` })).toMatchObject({ category: "arxiv", year: 2026 });
    expect(classifyArticle({ title: "写作经验", markdown: `# 写作经验\n\n## 参考文献\n${information}` }).category).toBe("other");
  });
  it("bounds labels and ignores private, active or unstructured metadata", () => {
    const taxonomy = classifyArticle({ title: "记忆与评测", metadata: { tags: ["记忆", "记忆", "MEMORY", "memory", "/Users/example/private", "https://example.test", "<script>", "a".repeat(81), "cookie=private"] } });
    expect(taxonomy.tags).toEqual(["记忆", "MEMORY"]);
    expect(isTaxonomyLabel("GUI/Web/文档")).toBe(true);
    expect(readArticleFrontmatter("---\n__proto__: broken\nconstructor: bad\ntitle: '你好：世界'\ntags:\n  - 多智能体\n---\n")).toEqual({ title: "你好：世界", tags: ["多智能体"] });
  });
  it("keeps explicit venue year separate from local file update year", () => {
    expect(classifyArticle({ title: "ICLR 2025｜论文", path: "2026-09-08/article.md" })).toMatchObject({ conference: "ICLR", year: 2025 });
    expect(classifyArticle({ title: "NeurIPS 2026: Memory" })).toMatchObject({ conference: "NeurIPS", year: 2026 });
    expect(classifyArticle({ title: "论文", metadata: { conference: "CVPR", title_prefix: "CVPR2025专题" }, path: "2026-09-08/article.md" })).toMatchObject({ conference: "CVPR", year: 2025 });
    expect(classifyArticle({ title: "论文", metadata: { conference: "CVPR", year: 2025 }, path: "cvpr2026/article.md" }).year).toBe(2025);
    expect(classifyArticle({ title: "通用综述", markdown: "# 通用综述\n◆ 01｜方法\n参考文献\n- arXiv:2501.12345" }).category).toBe("other");
    expect(classifyArticle({ title: "通用综述", markdown: "# 通用综述\n参考资料\n- arXiv:2501.12345" }).category).toBe("other");
  });
  it.each([
    { title: "GUI-CEval：中文手机 Agent 评测", markdown: "# GUI-CEval：中文手机 Agent 评测\n\nJustAgent CVPR-2026 系列\n\n## 方法", conference: "CVPR", year: 2026 },
    { title: "AppWorld：应用世界评测编程Agent", markdown: "◆ 01｜核心信息：AppWorld 评测的是应用状态\n\nAppWorld 是 ACL 2024 Long Paper，并获得最佳资源论文奖。\n\n◆ 02｜方法", conference: "ACL", year: 2024 },
    { title: "AgentBench：多环境Agent评测", markdown: "◆ 01｜核心信息\n\n原论文 AgentBench: Evaluating LLMs as Agents 发表在 ICLR 2024。arXiv 页面显示最早版本提交于 2023 年。\n\n◆ 02｜交互环境", conference: "ICLR", year: 2024 },
    { title: "科研Agent先过102题", markdown: "# 科研Agent先过102题\n\n这篇 ICLR 2025 论文值得单独读，不是因为它又造了一个 Agent。\n\n◆ 01｜科研任务", conference: "ICLR", year: 2025 },
  ])("recognizes an authored source declaration for $conference $year", ({ title, markdown, conference, year }) => {
    expect(classifyArticle({ title, path: "daily/2026-09-08/article.md", markdown })).toMatchObject({ category: "conference", conference, year });
  });
  it("keeps a comparison of multiple source conferences ambiguous", () => {
    const markdown = "# WorkArena\n\narXiv:2403.07718\n\n◆ 01｜核心信息\n\n会议与版本：WorkArena 为 ICML 2024；WorkArena++ 为 NeurIPS 2024。\n\n◆ 02｜方法";
    expect(classifyArticle({ title: "WorkArena", markdown })).toMatchObject({ category: "other", conference: null });
    expect(classifyArticle({ title: "WorkArena", metadata: { conference: "ICML", year: 2024 }, markdown })).toMatchObject({ category: "conference", conference: "ICML", year: 2024 });
    expect(classifyArticle({ title: "比较论文", markdown: "# 比较论文\n这篇 ICLR 2024 论文提供评测。\n这篇 ICLR 2025 论文扩展评测。" })).toMatchObject({ category: "other", conference: null });
  });
  it.each([
    "# 写作经验\n本文提到 CVPR 2026 的论文。\n我们比较 AppWorld，它是 ACL 2024 Long Paper。",
    "# 写作经验\n\n## 参考文献\n这篇 ICLR 2025 论文值得阅读。",
    "# 写作经验\n\n参考资料\nJustAgent CVPR-2026 系列",
    "# 写作经验\n\n◆ 01｜背景\n讨论论文阅读。\n\n◆ 02｜核心信息\n会议：ICLR 2025",
    "# 写作经验\n\n◆ 01｜核心信息\nAppWorld 是 ACL 2024 Long Paper。\n\n◆ 02｜对比\n这篇 ICLR 2025 论文值得阅读。",
    "# 写作经验\n\n```markdown\nJustAgent CVPR-2026 系列\n这篇 ICLR 2025 论文值得阅读。\n```",
    "# 写作经验\n> 这篇 ICLR 2025 论文值得阅读。",
  ])("does not turn examples, citations or a different paper into the article venue", markdown => {
    expect(classifyArticle({ title: "写作经验", markdown })).toMatchObject({ category: "other", conference: null });
  });
  it("validates the shared RPC taxonomy filter contract", () => {
    const input = { operation: "library_list", category: "conference", conference: "CVPR", year: 2026, tag: "视频 Agent" };
    expect(decodeWorkbenchRequest(input)).toEqual(input);
    for (const field of [{ category: "paper" }, { category: ["conference"] }, { conference: "" }, { conference: "../private" }, { year: "2026" }, { year: 2200 }, { tag: "cookie=private" }]) expect(() => decodeWorkbenchRequest({ operation: "library_list", ...field })).toThrow();
  });
});

import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture(); fixtures.push(f);
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: ["**/excluded/**"] })) });
  const put = async (path: string, value: string | Buffer | object): Promise<void> => {
    const target = resolve(f.sourcePath, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  return { ...f, library, put };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe("local article taxonomy and canonical discovery", () => {
  it("discovers titled Markdown drafts and excludes operational files, unsupported JSON and arbitrary HTML", async () => {
    const f = await setup();
    await f.put("daily/arxiv-agent-2026-09-08.md", '---\ntitle: "论文精读"\nsource_ids: ["arxiv:2609.01234"]\ntags: ["多智能体", "评测"]\n---\n\n文章正文');
    await f.put("daily/another.md", "# 另一个明确标题\n正文");
    for (const path of ["README.md", "AGENTS.md", "prompts/article.md", "daily/publish-record.md", "daily/completion-report.md", "daily/demo.md", "daily/conference-series-status.md", "daily/conference-master-plan.md", "daily/publication-backlog.md", "daily/upgrade-roadmap.md", "daily/reupload-command.md", "excluded/article.md", "assets/figure-notes.md", "assets/paper-ocr/mineru/paper.md", "research/papers/source.md"]) await f.put(path, "# 管理文档\n正文");
    await f.put("daily/no-title.md", "普通正文中没有标题");
    await f.put("daily/arbitrary.html", "<h1>不作为文章入口</h1>");
    await f.put("daily/arbitrary.draft.json", { articles: [{ title: "副本", content: "<p>正文</p>" }] });
    const page = await f.library.list({ kind: "article" });
    expect(page.total).toBe(2);
    expect(page.items.find(item => item.title === "论文精读")).toMatchObject({ origin: "local", readOnly: true, contentRef: null, publicationStatus: "draft", taxonomy: { category: "arxiv", conference: null, year: 2026, tags: ["多智能体", "评测"] } });
    const detail = await f.library.read(page.items.find(item => item.title === "论文精读")!.itemId);
    expect(detail.markdown).toContain("文章正文");
    expect(detail.html).toContain("Content-Security-Policy");
    expect(JSON.stringify(detail)).not.toContain(f.directory);
    expect(f.remoteCalls()).toBe(0);
  });

  it("uses only exact CVPR registry HTML references and preserves distinct articles with the same title", async () => {
    const f = await setup();
    await f.put("daily/cvpr2026/one.html", '<p onclick="run()">正文一</p><script>PRIVATE_SCRIPT</script><img src="image.png"><img src="https://outside.invalid/tracker.png">');
    await f.put("daily/cvpr2026/two.html", "<h1>正文二</h1>");
    await f.put("daily/cvpr2026/nav.html", "<h1>专题导航</h1>");
    await f.put("daily/cvpr2026/image.png", testPng());
    await f.put("cvpr2026-series-links.json", { schema: "cvpr2026-series-link-registry.v1", topics: [{ title: "视觉智能体", navigation: { title: "CVPR 2026 专题导航", local_html: "daily/cvpr2026/nav.html" }, articles: [{ title: "同标题", local_html: "daily/cvpr2026/one.html", wechat_url: "https://private.invalid/DO_NOT_PROJECT" }, { title: "同标题", local_html: "daily/cvpr2026/two.html" }, { title: "重复路径", local_html: "daily/cvpr2026/one.html" }] }] });
    await f.put("daily/cvpr2026/one.draft.json", { articles: [{ title: "同标题", content: "<p>历史副本</p>" }] });
    const page = await f.library.list({ kind: "article" });
    expect(page.total).toBe(3);
    expect(page.items.filter(item => item.title === "同标题")).toHaveLength(2);
    expect(page.facets?.conferences).toEqual([{ value: "CVPR", count: 3 }]);
    expect(page.facets?.tags).toContainEqual({ value: "专题导航", count: 1 });
    expect(page.items.every(item => item.taxonomy?.year === 2026 && item.publicationStatus === "draft")).toBe(true);
    expect(JSON.stringify(page)).not.toContain("DO_NOT_PROJECT");
    const details = await Promise.all(page.items.filter(item => item.title === "同标题").map(item => f.library.read(item.itemId)));
    const detail = details.find(item => item.html?.includes("正文一"))!;
    expect(detail.html).toContain("data:image/png;base64,");
    for (const value of ["onclick", "PRIVATE_SCRIPT", "outside.invalid", "<script"]) expect(detail.html).not.toContain(value);
  });

  it("rejects registry escapes, links, malformed UTF-8 and oversized content", async () => {
    const f = await setup();
    await f.put("valid.html", "<p>正文</p>");
    await f.put("private-cookie.html", "PRIVATE_COOKIE");
    await f.put("invalid.html", Buffer.from([0xff, 0xfe, 0x41]));
    await f.put("large.html", "x".repeat(1024 * 1024 + 1));
    await symlink(resolve(f.sourcePath, "valid.html"), resolve(f.sourcePath, "linked.html"));
    await f.put("cvpr2026-series-links.json", { schema: "cvpr2026-series-link-registry.v1", topics: [{ title: "CVPR 专题", articles: ["valid.html", "private-cookie.html", "invalid.html", "large.html", "linked.html", "/etc/passwd", "../write/outside.html"].map((local_html, index) => ({ title: `文章${index}`, local_html })) }] });
    const page = await f.library.list({ kind: "article" });
    expect(page.total).toBe(1);
    expect(page.items[0]?.title).toBe("文章0");
    const detail = await f.library.read(page.items[0]!.itemId);
    expect(detail.html).toContain("正文");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_COOKIE");
  });

  it("recognizes the explicit inline local-draft schema without returning private manifest metadata", async () => {
    const f = await setup();
    await f.put("daily/arxiv-agent-2026/article.wechat-local-draft.json", { schema: "wemedia.wechat.local_draft.v1.internal", title: "记忆论文", series: "arXiv Agent 论文精读", content: '<p>正文</p><img src="image.png">', thumb_media_id: "PRIVATE_REMOTE_ID" });
    await f.put("daily/arxiv-agent-2026/image.png", testPng());
    const item = (await f.library.list({ kind: "article" })).items[0]!;
    expect(item).toMatchObject({ title: "记忆论文", origin: "local", taxonomy: { category: "arxiv", tags: ["记忆"] } });
    const detail = await f.library.read(item.itemId);
    expect(detail.html).toContain("data:image/png;base64,");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_REMOTE_ID");
  });

  it("deduplicates only declared Markdown artifacts while preserving unrelated same-title drafts", async () => {
    const f = await setup();
    await f.put("old/article.wechat-local-draft.json", { schema: "wemedia.wechat.local_draft.v1", title: "相同标题", article: "article.md", preview_html: "article.html" });
    await f.put("old/article.md", "# 相同标题\n这是清单声明的原稿");
    await f.put("old/article.html", "<p>这是清单声明的原稿</p>");
    await f.put("unrelated.md", "# 相同标题\n这是独立稿件");
    const native = await f.create();
    const page = await f.library.list({ kind: "article" });
    expect(page.total).toBe(3);
    expect(page.items.filter(item => item.title === "相同标题")).toHaveLength(2);
    expect(page.items.filter(item => item.contentRef === native.contentRef)).toHaveLength(1);
  });

  it("never lets a broken native manifest claim a same-named artifact in another directory", async () => {
    const f = await setup();
    await f.put("body.html", "<p>独立正文</p>");
    await f.put("article.md", "# 独立 Markdown 文章\n正文");
    await f.put("broken/article.local-wechat-draft.json", { schema: "justagent.local-wechat-draft.v1", article_id: "broken-article", title: "无正文的清单", content_file: "body.html", preview_file: "article.md" });
    await f.put("invalid.md", Buffer.from([0x23, 0x20, 0xff, 0xfe]));
    const page = await f.library.list({ kind: "article" });
    expect(page.items.map(item => item.title)).toEqual(["独立 Markdown 文章"]);
  });

  it("preserves same-named drafts in different roots when a legacy reference only matches an ancestor fallback", async () => {
    const f = await setup();
    await f.put("nested/article.wechat-local-draft.json", { schema: "wemedia.wechat.local_draft.v1", title: "引用尚未确认的清单", article: "write/article.md" });
    await f.put("nested/article.md", "# 同名独立文章\n第一个目录中的稿件");
    await writeFile(resolve(f.writePath, "article.md"), "# 同名独立文章\n另一个根中的稿件");
    const page = await f.library.list({ kind: "article" });
    expect(page.total).toBe(3);
    expect(page.items.filter(item => item.title === "同名独立文章")).toHaveLength(2);
    const drafts = await Promise.all(page.items.filter(item => item.title === "同名独立文章").map(item => f.library.read(item.itemId)));
    expect(drafts.map(item => item.markdown)).toEqual(expect.arrayContaining([expect.stringContaining("第一个目录"), expect.stringContaining("另一个根")]));
  });

  it("counts facets across the whole article library and combines taxonomy filters with AND semantics", async () => {
    const f = await setup();
    await f.put("cvpr2026/one.md", '---\ntitle: 视觉论文\ntags: ["规划推理", "评测"]\n---\n正文');
    await f.put("aaai2025/two.md", '---\ntitle: 推理论文\ntags: ["规划推理"]\n---\n正文');
    await f.put("arxiv-agent-2026/three.md", '---\ntitle: 最新论文\nsource_ids: ["arxiv:2609.01234"]\ntags: ["评测"]\n---\n正文');
    await f.put("picture.png", testPng());
    const selected = await f.library.list({ kind: "article", category: "conference", conference: "CVPR", year: 2026, tag: "规划推理" });
    expect(selected.total).toBe(1);
    expect(selected.items[0]?.title).toBe("视觉论文");
    expect(selected.facets?.categories).toEqual([{ value: "arxiv", count: 1 }, { value: "conference", count: 2 }]);
    expect(selected.facets?.years).toEqual([{ value: 2026, count: 2 }, { value: 2025, count: 1 }]);
    expect(selected.facets?.tags).toEqual([{ value: "规划推理", count: 2 }, { value: "评测", count: 2 }]);
    expect((await f.library.list({ query: "评测" })).total).toBe(2);
    expect((await f.library.list({ conference: "CVPR", tag: "不存在" })).total).toBe(0);
    expect((await f.library.list({ kind: "image", category: "conference" })).total).toBe(0);
    expect((await f.library.list({ kind: "image" })).facets).toEqual(selected.facets);
  });

  it.each([{ category: "conference" as const }, { conference: "CVPR" }, { year: 2026 }, { tag: "评测" }])("binds pagination to every taxonomy filter: %j", async filter => {
    const f = await setup();
    for (const name of ["a", "b"]) await f.put(`cvpr2026/${name}.md`, `---\ntitle: ${name}\ntags: ["评测"]\n---\n正文`);
    const page = await f.library.list({ pageSize: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(f.library.list({ ...filter, pageSize: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "CURSOR_STALE" });
  });

  it("revalidates local article identities, observes cancellation and never writes source drafts", async () => {
    const f = await setup();
    const original = "# 原始文章\n正文";
    await f.put("article.md", original);
    const page = await f.library.list();
    await f.library.read(page.items[0]!.itemId);
    expect(await readFile(resolve(f.sourcePath, "article.md"), "utf8")).toBe(original);
    await rename(resolve(f.sourcePath, "article.md"), resolve(f.sourcePath, "moved.md"));
    await symlink(resolve(f.sourcePath, "moved.md"), resolve(f.sourcePath, "article.md"));
    await expect(f.library.read(page.items[0]!.itemId)).rejects.toMatchObject({ code: "LIBRARY_PATH_REJECTED" });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(f.library.list({}, cancelled.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(f.library.list({ year: 1800 })).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(f.library.list({ tag: "/Users/private/tag" })).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});

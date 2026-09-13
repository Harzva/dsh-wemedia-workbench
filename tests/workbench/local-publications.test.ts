import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPublications, safePublicationUrl } from "../../src/infrastructure/localPublications.ts";

const dirs: string[] = [];
const publishedUrl = "https://zhuanlan.zhihu.com/p/123456789";
const checkedAt = "2026-08-25T06:25:09.482Z";
const created = 1787631900;
async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "wemedia-publications-")));
  dirs.push(root);
  await Promise.all([mkdir(resolve(root, "zhihu")), mkdir(resolve(root, "xiaohongshu")), mkdir(resolve(root, "wechat"))]);
  await Promise.all([
    writeFile(resolve(root, "publishing-ledger.jsonl"), ""),
    writeFile(resolve(root, "xiaohongshu/published-notes.jsonl"), ""),
    writeFile(resolve(root, "zhihu/published-articles.json"), JSON.stringify({ fetched_at: checkedAt, account: { id: "PRIVATE_ACCOUNT_ID", token: "SECRET_TOKEN" }, articles: [{ id: "123456789", title: "PRIVATE_TITLE", url: publishedUrl, created_time: created, metrics: { private: "SECRET" } }] })),
  ]);
  const writeLedger = async (rows: unknown[]) => writeFile(resolve(root, "publishing-ledger.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const options = { workspaceRoot: root, ledgerPath: "publishing-ledger.jsonl", zhihuInventoryPath: "zhihu/published-articles.json", xiaohongshuLedgerPath: "xiaohongshu/published-notes.jsonl" };
  const reader = new LocalPublications(options);
  const lookup = () => reader.lookup({ sourcePaths: [resolve(root, "wechat/article.md")] });
  return { root, options, writeLedger, reader, lookup };
}
function receipt(status: string, additional: Record<string, unknown> = {}) {
  return { title: "PRIVATE_TITLE", created_at: "2026-08-26T00:00:00Z", platforms: { wechat: { status: "draft_created", article_path: "wechat/article.md" }, zhihu: { status, article_path: "zhihu/article.md", ...additional } } };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("local publication evidence", () => {
  it("joins channel variants only through an exact receipt path and corroborates the URL against inventory", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    const result = await f.lookup();
    expect(result.issues).toEqual([]);
    expect(result.publications).toMatchObject([{ channel: "wechat", status: "draft", evidence: "local_draft" }, { channel: "zhihu", status: "published", evidence: "remote_readback", url: publishedUrl, checkedAt, publishedAt: null }]);
    expect(result.publications[1]?.note).toContain("不证明当前版本");
    const serialized = JSON.stringify(result);
    for (const privateValue of [f.root, "PRIVATE_TITLE", "PRIVATE_ACCOUNT_ID", "SECRET_TOKEN", "article.md", "metrics"]) expect(serialized).not.toContain(privateValue);
  });

  it("never matches identical titles or the inventory alone", async () => {
    const f = await fixture();
    await f.writeLedger([{ title: "PRIVATE_TITLE", platforms: { zhihu: { status: "published", article_path: "zhihu/other.md", url: publishedUrl } } }]);
    expect((await f.lookup()).publications).toEqual([]);
    expect((await f.reader.lookup({ sourcePaths: ["zhihu/article.md"] })).publications).toEqual([]);
  });

  it("keeps blocked and staged receipts distinct from a public result even if a URL exists", async () => {
    const f = await fixture();
    for (const [status, expected] of [["blocked_auth", "failed"], ["online_edit_blocked_selector_timeout", "failed"], ["staged_local", "ready"], ["draft_prepared", "draft"], ["ready_after_visual_fix_not_published", "ready"], ["publish_clicked", "unknown"], ["not_started", "unknown"]]) {
      await f.writeLedger([receipt(status!, { url: publishedUrl })]);
      expect((await f.lookup()).publications.find(record => record.channel === "zhihu")).toMatchObject({ status: expected, publishedAt: null, checkedAt: null, url: null });
    }
  });

  it("does not treat an empty PostID or an MCP success label as verified publication", async () => {
    const f = await fixture();
    await writeFile(resolve(f.root, "xiaohongshu/published-notes.jsonl"), JSON.stringify({ record_path: "wechat/article.md", status: "published_via_xhs_mcp", post_id: "", visibility: "公开可见", mcp_result: { text: "SECRET; success" } }));
    expect((await f.lookup()).publications).toMatchObject([{ channel: "xiaohongshu", status: "unknown", evidence: "local_receipt", url: null }]);
  });

  it("does not invent publication time from a receipt creation, fetch time or file mtime", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: "https://zhuanlan.zhihu.com/p/999999" })]);
    expect((await f.lookup()).publications[1]).toMatchObject({ status: "published", evidence: "local_receipt", publishedAt: null, checkedAt: null });
    await f.writeLedger([receipt("published", { url: "https://zhuanlan.zhihu.com/p/999999", published_at: "2026-08-20T12:00:00+08:00" })]);
    expect((await f.lookup()).publications[1]?.publishedAt).toBe("2026-08-20T04:00:00.000Z");
  });

  it("uses only explicit publication dates when a corroborating inventory also has a creation time", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl, published_at: "2026-08-20T12:00:00+08:00" })]);
    expect((await f.lookup()).publications[1]).toMatchObject({ status: "published", evidence: "remote_readback", publishedAt: "2026-08-20T04:00:00.000Z", checkedAt });
    await writeFile(resolve(f.root, "zhihu/published-articles.json"), JSON.stringify({ fetched_at: checkedAt, articles: [{ url: publishedUrl, created_time: created, published_at: "2026-08-21T12:00:00+08:00" }] }));
    expect((await f.lookup()).publications[1]?.publishedAt).toBe("2026-08-21T04:00:00.000Z");
  });

  it("keeps a published receipt through failed retries and honors an explicit removal", async () => {
    const f = await fixture();
    const later = (status: string) => ({ ...receipt(status), created_at: "2026-08-27T00:00:00Z" });
    await f.writeLedger([receipt("published", { url: publishedUrl }), later("blocked_auth")]);
    expect((await f.lookup()).publications[1]?.status).toBe("published");
    await f.writeLedger([receipt("published", { url: publishedUrl }), later("removed")]);
    expect((await f.lookup()).publications[1]).toMatchObject({ status: "removed", url: null });
  });

  it("rereads changed records and uses replacement URLs when explicitly recorded", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("draft_prepared")]);
    expect((await f.lookup()).publications[1]?.status).toBe("draft");
    await f.writeLedger([receipt("published_replacement", { url: "https://zhuanlan.zhihu.com/p/99999", replacement_url: publishedUrl })]);
    expect((await f.lookup()).publications[1]).toMatchObject({ status: "published", url: publishedUrl, checkedAt });
  });

  it("isolates invalid JSONL rows without leaking their contents", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("draft_prepared")]);
    const before = await readFile(resolve(f.root, "publishing-ledger.jsonl"), "utf8");
    await writeFile(resolve(f.root, "publishing-ledger.jsonl"), `${before}{PRIVATE_BROKEN\n`);
    const result = await f.lookup();
    expect(result.publications[1]?.status).toBe("draft");
    expect(result.issues).toEqual(["LOCAL_PUBLICATION_LEDGER_UNAVAILABLE"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BROKEN");
  });

  it("does not trust an inventory with an invalid synchronization date", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    await writeFile(resolve(f.root, "zhihu/published-articles.json"), JSON.stringify({ fetched_at: "2026-08-25", articles: [{ url: publishedUrl, created_time: created }] }));
    const result = await f.lookup();
    expect(result.publications[1]).toMatchObject({ evidence: "local_receipt", checkedAt: null, publishedAt: null });
    expect(result.issues).toContain("LOCAL_ZHIHU_INVENTORY_UNAVAILABLE");
  });

  it("rejects symlinked files, symlinked directories and out-of-root evidence paths", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    await symlink(resolve(f.root, "publishing-ledger.jsonl"), resolve(f.root, "linked.jsonl"));
    const linked = new LocalPublications({ ...f.options, ledgerPath: "linked.jsonl" });
    expect((await linked.lookup({ sourcePaths: ["wechat/article.md"] })).publications).toEqual([]);
    await symlink(resolve(f.root, "zhihu"), resolve(f.root, "linked-dir"));
    const linkedDirectory = new LocalPublications({ ...f.options, zhihuInventoryPath: "linked-dir/published-articles.json" });
    expect((await linkedDirectory.readSummary()).counts.zhihuArticles).toBe(0);
    const outside = new LocalPublications({ ...f.options, ledgerPath: "../publishing-ledger.jsonl" });
    expect((await outside.lookup({ sourcePaths: ["wechat/article.md"] })).publications).toEqual([]);
    expect((await f.reader.lookup({ sourcePaths: [resolve(f.root, "../wechat/article.md")] })).publications).toEqual([]);
  });

  it("rejects private filenames and oversized receipt files before parsing", async () => {
    const f = await fixture();
    await writeFile(resolve(f.root, "cookies.json"), JSON.stringify(receipt("published", { url: publishedUrl })));
    const privateReader = new LocalPublications({ ...f.options, ledgerPath: "cookies.json" });
    expect((await privateReader.lookup({ sourcePaths: ["wechat/article.md"] })).publications).toEqual([]);
    await writeFile(resolve(f.root, "publishing-ledger.jsonl"), " ".repeat(8 * 1024 * 1024 + 1));
    expect((await f.lookup()).publications).toEqual([]);
    expect((await f.reader.readSummary()).issues).toContain("LOCAL_PUBLICATION_LEDGER_UNAVAILABLE");
  });

  it("exposes only aggregate inventory information and the actual saved synchronization date", async () => {
    const f = await fixture();
    const summary = await f.reader.readSummary();
    expect(summary).toEqual({ available: true, checkedAt, counts: { ledgerRecords: 0, zhihuArticles: 1, xiaohongshuRecords: 0 }, channels: ["zhihu"], issues: [] });
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SECRET|article\.md|123456789/u);
  });

  it("accepts only public platform post addresses and strips incidental URL parameters", () => {
    expect(safePublicationUrl(`${publishedUrl}?token=SECRET#private`, "zhihu")).toBe(publishedUrl);
    expect(safePublicationUrl("https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=SECRET", "xiaohongshu")).toBe("https://www.xiaohongshu.com/explore/0123456789abcdef01234567");
    for (const url of ["http://zhuanlan.zhihu.com/p/123", "https://user:pass@zhuanlan.zhihu.com/p/123", "https://zhuanlan.zhihu.com.evil.invalid/p/123", "https://zhuanlan.zhihu.com/signin", "https://127.0.0.1/p/123"]) expect(safePublicationUrl(url, "zhihu")).toBeNull();
  });

  it("downgrades publication evidence when a later ledger row is damaged", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    const before = await readFile(resolve(f.root, "publishing-ledger.jsonl"), "utf8");
    await writeFile(resolve(f.root, "publishing-ledger.jsonl"), `${before}{"status":"removed"`);
    expect((await f.lookup()).publications.find(record => record.channel === "zhihu")).toMatchObject({ status: "unknown", evidence: "none", url: null });
  });

  it("does not resurrect a newer removal from an older platform-specific receipt", async () => {
    const f = await fixture();
    const xhsUrl = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
    await f.writeLedger([{ created_at: "2026-08-28T00:00:00Z", platforms: { xiaohongshu: { status: "removed", note_path: "wechat/article.md", url: xhsUrl } } }]);
    await writeFile(resolve(f.root, "xiaohongshu/published-notes.jsonl"), JSON.stringify({ created_at: "2026-08-26T00:00:00Z", record_path: "wechat/article.md", status: "published_via_visible_creator", url: xhsUrl }));
    expect((await f.lookup()).publications[0]?.status).toBe("removed");
    // Reversing physical append order in a source must not reverse time.
    await f.writeLedger([{ created_at: "2026-08-28T00:00:00Z", platforms: { xiaohongshu: { status: "removed", note_path: "wechat/article.md", url: xhsUrl } } }, { created_at: "2026-08-26T00:00:00Z", platforms: { xiaohongshu: { status: "published", note_path: "wechat/article.md", url: xhsUrl } } }]);
    expect((await f.lookup()).publications[0]?.status).toBe("removed");
  });

  it("reports unknown when conflicting sources have no trustworthy time ordering", async () => {
    const f = await fixture();
    const xhsUrl = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
    await f.writeLedger([{ platforms: { xiaohongshu: { status: "removed", note_path: "wechat/article.md", url: xhsUrl } } }]);
    await writeFile(resolve(f.root, "xiaohongshu/published-notes.jsonl"), JSON.stringify({ record_path: "wechat/article.md", status: "published_via_visible_creator", url: xhsUrl }));
    expect((await f.lookup()).publications[0]).toMatchObject({ status: "unknown", url: null, evidence: "none" });
  });

  it("requires an explicit safe workspace and does not scan unconfigured evidence sources", async () => {
    for (const workspaceRoot of ["", ".", "/"]) expect(() => new LocalPublications({ workspaceRoot })).toThrow("绝对工作区目录");
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    const unconfigured = new LocalPublications({ workspaceRoot: f.root });
    expect(await unconfigured.readSummary()).toEqual({ available: false, checkedAt: null, counts: { ledgerRecords: 0, zhihuArticles: 0, xiaohongshuRecords: 0 }, channels: [], issues: [] });
    expect((await unconfigured.lookup({ sourcePaths: ["wechat/article.md"] })).publications).toEqual([]);
  });

  it("does not trust another source's older success when the ledger contains only a damaged newer row", async () => {
    const f = await fixture();
    const xhsUrl = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
    await writeFile(resolve(f.root, "publishing-ledger.jsonl"), '{"created_at":"2026-08-28T00:00:00Z","platforms":{"xiaohongshu":{"status":"removed"');
    await writeFile(resolve(f.root, "xiaohongshu/published-notes.jsonl"), JSON.stringify({ created_at: "2026-08-26T00:00:00Z", record_path: "wechat/article.md", status: "published_via_visible_creator", url: xhsUrl }));
    const result = await f.lookup();
    expect(result.publications[0]).toMatchObject({ channel: "xiaohongshu", status: "unknown", url: null, checkedAt: null, publishedAt: null, evidence: "none" });
    expect(result.issues).toContain("LOCAL_PUBLICATION_LEDGER_UNAVAILABLE");
  });

  it("limits an unreadable Xiaohongshu source to Xiaohongshu evidence and ignores unconfigured sources", async () => {
    const f = await fixture();
    const xhsUrl = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
    const row = receipt("published", { url: publishedUrl });
    await f.writeLedger([{ ...row, platforms: { ...row.platforms, xiaohongshu: { status: "published", url: xhsUrl } } }]);
    await writeFile(resolve(f.root, "xiaohongshu/published-notes.jsonl"), '{"status":"removed"');
    const result = await f.lookup();
    expect(result.publications.find(record => record.channel === "xiaohongshu")?.status).toBe("unknown");
    expect(result.publications.find(record => record.channel === "zhihu")?.status).toBe("published");
    const unconfigured = new LocalPublications({ workspaceRoot: f.root, ledgerPath: f.options.ledgerPath, zhihuInventoryPath: f.options.zhihuInventoryPath });
    expect((await unconfigured.lookup({ sourcePaths: ["wechat/article.md"] })).publications.find(record => record.channel === "xiaohongshu")?.status).toBe("published");
  });

  it("accepts qualified manifest workspace identities without opening their content", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    // No body exists at this exact identity; only the explicitly configured receipts are read.
    const result = await f.reader.lookup({ sourcePaths: [], workspaceRelativePaths: ["./wechat/article.md"] });
    expect(result.publications.find(record => record.channel === "zhihu")?.status).toBe("published");
  });

  it("rejects ambiguous, private, escaped and remote manifest identities", async () => {
    const f = await fixture();
    await f.writeLedger([receipt("published", { url: publishedUrl })]);
    for (const path of ["article.md", "./article.md", "../wechat/article.md", "wechat/../wechat/article.md", "wechat//article.md", "/wechat/article.md", "https://example.invalid/wechat/article.md", "file:wechat/article.md", "wechat/article.md\u0000", "wechat/%61rticle.md", "././wechat/article.md", "wechat/cookies.json", "wechat\\article.md", " wechat/article.md"]) {
      expect((await f.reader.lookup({ sourcePaths: [], workspaceRelativePaths: [path] })).publications).toEqual([]);
    }
  });
});

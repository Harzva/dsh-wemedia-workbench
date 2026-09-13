import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { composeWorkbench } from "../../src/host/compose.ts";
import { createDefaultConfig } from "../../src/config.ts";
import type { WorkbenchService } from "../../src/application/workbenchService.ts";
import type { LibraryPage, LibraryDetail } from "../../src/domain/contentLibrary.ts";
import type { WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import { aggregatePublicationStatus } from "../../src/domain/publication.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function value<T>(service: WorkbenchService, input: unknown): Promise<T> {
  const answer = await service.request(input, { kind: "user" });
  if (!answer.ok) throw new Error(answer.error.code);
  return answer.value as T;
}

describe("composed publication status read model", () => {
  it("joins an exact local article to channel receipts, exposes them through the workbench, and invalidates filtered pagination on removal", async () => {
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), "wm-publication-integration-")));
    const source = resolve(directory, "articles");
    await mkdir(source);
    const originals = new Map<string, string>();
    for (const id of ["first", "same-title"]) {
      const folder = resolve(source, id); await mkdir(folder);
      originals.set(resolve(folder, "article.md"), "# Same title\n\nSource text");
      originals.set(resolve(folder, "article.wechat-local-draft.json"), JSON.stringify({ schema: "wemedia.wechat.local_draft.v1", title: "Same title", article: "article.md" }));
    }
    for (const [path, content] of originals) await writeFile(path, content);
    const url = "https://zhuanlan.zhihu.com/p/123456789";
    const ledger = resolve(directory, "publishing-ledger.jsonl");
    const row = { created_at: "2026-09-07T00:00:00Z", platforms: { wechat: { status: "draft_prepared", article_path: "articles/first/article.md" }, zhihu: { status: "published", url } } };
    await writeFile(ledger, JSON.stringify(row) + "\n");
    const inventory = resolve(directory, "zhihu-inventory.json");
    await writeFile(inventory, JSON.stringify({ fetched_at: "2026-09-08T01:00:00Z", account: { private: "NOT_FOR_PUBLIC_DTO" }, articles: [{ title: "Same title", url, created_time: 1788825600 }] }));
    const config = createDefaultConfig();
    config.dataDir = resolve(directory, "state");
    config.roots = [{ id: "articles", label: "Articles", path: source, enabled: true, mode: "read", include: [], exclude: [] }];
    config.publicationSources = { workspaceRoot: directory, ledgerPath: ledger, zhihuInventoryPath: inventory };
    const service = await composeWorkbench(config, { available: () => false, forCaller: () => undefined });
    cleanup.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
    const first = await value<LibraryPage>(service, { operation: "library_list", publicationType: "article", pageSize: 1 });
    expect(first.total).toBe(2); expect(first.nextCursor).toBeTruthy();
    const published = await value<LibraryPage>(service, { operation: "library_list", publicationStatus: "published" });
    expect(published.total).toBe(1);
    const item = published.items[0]!;
    const zhihu = item.publications?.find(record => record.channel === "zhihu");
    expect(zhihu).toMatchObject({ status: "published", url, evidence: "remote_readback", checkedAt: "2026-09-08T01:00:00.000Z" });
    expect(zhihu?.publishedAt).not.toBe(row.created_at);
    const detail = await value<LibraryDetail>(service, { operation: "library_read", itemId: item.itemId });
    expect(detail.item.publications).toEqual(item.publications);
    const snapshot = await value<WorkbenchSnapshot>(service, { operation: "snapshot" });
    expect(snapshot.publicationSources?.counts).toEqual({ ledgerRecords: 1, zhihuArticles: 1, xiaohongshuRecords: 0 });
    expect(snapshot.supportedChannels).toEqual(["wechat", "zhihu", "xiaohongshu", "x"]);
    // Channel routes now exist; historical receipts do not configure their bridges.
    for (const channel of ["zhihu", "xiaohongshu", "x"]) expect(snapshot.capabilities.find(v => v.channel === channel)?.actions.every(v => ["unavailable", "unsupported"].includes(v.status))).toBe(true);
    expect(JSON.stringify([published, detail, snapshot])).not.toContain(directory);
    expect(JSON.stringify([published, detail, snapshot])).not.toContain("NOT_FOR_PUBLIC_DTO");
    const removal = { ...row, created_at: "2026-09-08T02:00:00Z", platforms: { ...row.platforms, zhihu: { status: "removed", url } } };
    await writeFile(ledger, JSON.stringify(row) + "\n" + JSON.stringify(removal) + "\n");
    expect((await value<LibraryPage>(service, { operation: "library_list", publicationStatus: "published" })).total).toBe(0);
    const stale = await service.request({ operation: "library_list", publicationType: "article", pageSize: 1, cursor: first.nextCursor! }, { kind: "user" });
    expect(stale).toMatchObject({ ok: false, error: { code: "CURSOR_STALE" } });
    for (const [path, content] of originals) expect(await readFile(path, "utf8")).toBe(content);
  });

  it("keeps ready article workflow status when its only channel record is a local draft", () => {
    expect(aggregatePublicationStatus([{ channel: "wechat", status: "draft", publishedAt: null, checkedAt: null, url: null, evidence: "local_draft", note: "" }], "ready")).toBe("ready");
  });
});

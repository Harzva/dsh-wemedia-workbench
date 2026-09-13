import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { requestSchema } from "../../src/remote/schemas.ts";
import type { LibraryListInput } from "../../src/domain/contentLibrary.ts";
import type { WorkbenchContentSummary } from "../../src/domain/workbench.ts";
import { testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture(); fixtures.push(f);
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })) });
  return { ...f, library };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function modified(path: string, timestamp: string) { await utimes(path, new Date(timestamp), new Date(timestamp)); }

describe("content publication and time filtering", () => {
  it("separates image assets from publications and never treats a draft receipt as publication evidence", async () => {
    const f = await setup(); await f.create();
    await mkdir(resolve(f.sourcePath, "old"));
    await writeFile(resolve(f.sourcePath, "old", "article.wechat-local-draft.json"), JSON.stringify({ schema: "wemedia.wechat.local_draft.v1", title: "旧草稿", status: "published", published: true }));
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24); mp4.write("ftypisom", 4);
    await writeFile(resolve(f.sourcePath, "video.mp4"), mp4);
    const articles = await f.library.list({ publicationType: "article", publicationStatus: "draft" });
    expect(articles.items).toHaveLength(2);
    expect(articles.items.every(item => item.kind === "article")).toBe(true);
    expect((await f.library.list({ publicationType: "video" })).items).toEqual([expect.objectContaining({ kind: "video", publicationType: "video", publicationStatus: "unknown" })]);
    expect((await f.library.list({ kind: "image" })).items).toEqual([expect.objectContaining({ publicationType: null, publicationStatus: "unknown" })]);
    expect((await f.library.list({ publicationType: "image_text" })).total).toBe(0);
    expect((await f.library.list({ publicationStatus: "published" })).total).toBe(0);
    expect(f.remoteCalls()).toBe(0);
  });

  it("maps only known workbench readiness, keeps unknown time last in either sort, and excludes it from date ranges", async () => {
    const f = await setup(); await f.create();
    const source = (await f.documents.list())[0]!;
    const rows: WorkbenchContentSummary[] = ["drafting", "needs_review", "ready", "draft_verified", "needs_revalidation", "discovered"].map((status, index) => ({ ...source, contentRef: `wmc:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: status, status: status as WorkbenchContentSummary["status"], updatedAt: index === 0 ? null : `2026-09-0${index}T00:00:00.000Z` }));
    vi.spyOn(f.documents, "list").mockResolvedValue(rows);
    const asc = await f.library.list({ sort: "updated_asc" });
    const desc = await f.library.list({ sort: "updated_desc" });
    expect(asc.items.map(item => item.title)).toEqual(["needs_review", "ready", "draft_verified", "needs_revalidation", "discovered", "drafting"]);
    expect(desc.items.map(item => item.title)).toEqual(["discovered", "needs_revalidation", "draft_verified", "ready", "needs_review", "drafting"]);
    expect((await f.library.list({ publicationStatus: "ready" })).items.map(item => item.title)).toEqual(["ready"]);
    expect((await f.library.list({ publicationStatus: "draft" })).items.map(item => item.title)).toEqual(["draft_verified", "needs_review", "drafting"]);
    expect((await f.library.list({ publicationStatus: "unknown" })).items.map(item => item.title)).toEqual(["discovered", "needs_revalidation"]);
    expect((await f.library.list({ updatedFrom: "2026-09-01T00:00:00Z" })).items).toHaveLength(5);
  });

  it("filters absolute instants with inclusive start and exclusive end across timezones", async () => {
    const f = await setup();
    const dates = ["2026-09-07T15:59:59.999Z", "2026-09-07T16:00:00.000Z", "2026-09-08T15:59:59.999Z", "2026-09-08T16:00:00.000Z"];
    for (const [index, date] of dates.entries()) {
      const file = resolve(f.sourcePath, `${index}.png`); await writeFile(file, testPng()); await modified(file, date);
    }
    const input: LibraryListInput = { updatedFrom: "2026-09-08T00:00:00+08:00", updatedTo: "2026-09-09T00:00:00+08:00", sort: "updated_asc" };
    expect((await f.library.list(input)).items.map(item => item.title)).toEqual(["1.png", "2.png"]);
    expect((await f.library.list({ ...input, updatedFrom: "2026-09-07T16:00:00Z", updatedTo: "2026-09-08T16:00:00Z" })).items.map(item => item.title)).toEqual(["1.png", "2.png"]);
  });

  it("uses verified content-file modification times for standard articles and ignores the scan clock", async () => {
    const f = await setup(); const doc = await f.create();
    const folder = resolve(f.writePath, dirname(doc.document.relativePath));
    for (const file of ["wechat-document.json", "article.html", "article.md"]) await modified(resolve(folder, file), "2026-08-01T00:00:00Z");
    await modified(resolve(folder, "article.html"), "2026-08-02T00:00:00Z");
    expect((await f.documents.read(doc.contentRef)).updatedAt).toBe("2026-08-02T00:00:00.000Z");
    const item = (await f.library.list({})).items[0]!;
    expect(item.updatedAt).toBe("2026-08-02T00:00:00.000Z");
    expect((await f.library.read(item.itemId)).item.updatedAt).toBe(item.updatedAt);
    f.setTime("2030-01-01T00:00:00Z");
    expect((await f.library.list({})).items[0]!.updatedAt).toBe(item.updatedAt);
    await modified(resolve(folder, "article.md"), "2026-08-03T00:00:00Z");
    expect((await f.library.list({ updatedFrom: "2026-08-03T00:00:00Z" })).items[0]!.updatedAt).toBe("2026-08-03T00:00:00.000Z");
    await f.reviewAll(await f.documents.read(doc.contentRef));
    expect((await f.library.list({ publicationType: "article" })).items[0]).toMatchObject({ updatedAt: "2026-08-03T00:00:00.000Z", publicationStatus: "ready" });
  });

  it("includes a verified article image modification in content time", async () => {
    const f = await setup(); const initial = await f.create();
    await writeFile(resolve(f.writePath, "picture.png"), testPng());
    const doc = await f.documents.saveRevision(initial.contentRef, initial.revisionDigest, { metadata: initial.metadata, html: `${initial.html}<img src="picture.png">`, markdown: initial.markdown });
    const folder = resolve(f.writePath, dirname(doc.document.relativePath));
    for (const file of ["wechat-document.json", "article.html", "article.md"]) await modified(resolve(folder, file), "2026-08-01T00:00:00Z");
    await modified(resolve(f.writePath, doc.assets[0]!.artifact.relativePath), "2026-08-04T00:00:00Z");
    expect((await f.library.list({ publicationType: "article" })).items[0]!.updatedAt).toBe("2026-08-04T00:00:00.000Z");
  });

  it("binds pagination to all filters and sort even when the result set is unchanged", async () => {
    const f = await setup();
    for (const name of ["a.png", "b.png"]) await writeFile(resolve(f.sourcePath, name), testPng());
    const page = await f.library.list({ pageSize: 1 });
    for (const change of [{ publicationStatus: "unknown" }, { sort: "updated_asc" }, { updatedFrom: "2000-01-01T00:00:00Z" }, { updatedTo: "2100-01-01T00:00:00Z" }] satisfies LibraryListInput[]) {
      await expect(f.library.list({ pageSize: 1, cursor: page.nextCursor!, ...change })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    }
  });
});

describe("shared publication filter request validation", () => {
  it("accepts all filters without differing between service and RPC codecs", () => {
    const request = { operation: "library_list", publicationType: "image_text", publicationStatus: "published", updatedFrom: "2024-02-29T00:00:00+08:00", updatedTo: "2024-03-01T00:00:00+08:00", sort: "updated_asc" };
    expect(decodeWorkbenchRequest(request)).toEqual(request);
    expect(requestSchema.parse(request)).toEqual(request);
  });
  it.each([
    { publicationType: "image" }, { publicationType: ["article"] }, { publicationType: null },
    { publicationStatus: "draft_verified" }, { publicationStatus: ["published"] }, { sort: "title" }, { sort: ["updated_asc"] }, { kind: ["article"] },
    ...["2026-09-08", "2026-09-08T00:00:00", "2026-02-29T00:00:00Z", "2026-09-31T00:00:00Z", "2026-09-08T24:00:00Z", "2026-09-08T00:00:00+14:01", "2026-09-08T00:00:00+15:00", "invalid", 123].map(updatedFrom => ({ updatedFrom })),
    { updatedFrom: "2026-09-08T00:00:00Z", updatedTo: "2026-09-08T00:00:00Z" },
    { updatedFrom: "2026-09-08T00:00:00Z", updatedTo: "2026-09-08T00:00:00+08:00" },
    { updatedTo: "2026-09-08" },
  ])("rejects ambiguous, malformed or inverted filters %#", fields => {
    const request = { operation: "library_list", ...fields };
    expect(() => decodeWorkbenchRequest(request)).toThrow();
    expect(requestSchema.safeParse(request).success).toBe(false);
  });
});

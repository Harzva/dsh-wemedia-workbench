import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FilePublicationDrafts } from "../../src/infrastructure/publicationDrafts.ts";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { PublicationDraftPreview, PublicationEdit } from "../../src/domain/publicationDraft.ts";
import type { BatchPreflightResult } from "../../src/domain/batchPreflight.ts";
import type { WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { pngChunk, testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const user = { kind: "user" as const };
const signal = () => new AbortController().signal;
const empty: PublicationEdit = { title: "图文样稿", body: "", media: [], coverItemId: null, channels: [] };
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  let drafts: FilePublicationDrafts;
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })), publicationDrafts: () => drafts.catalog() });
  drafts = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library, now: f.now });
  const service = new WorkbenchService({ documents: f.documents, library, publicationDrafts: drafts, jobs: f.jobs, adapter: f.adapter, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => 0 }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 } });
  cleanups.push(() => service.dispose());
  const ref = `wmc:${randomUUID()}` as ContentRef;
  const create = async (type: "image_text" | "video" = "image_text", edit = empty) => drafts.commit(await drafts.plan(ref, type, null, edit, signal()), signal(), () => {});
  const picture = async (name = "image.png", bytes = testPng()) => {
    await writeFile(resolve(f.sourcePath, name), bytes);
    const item = (await library.list({ kind: "image" })).items.find(item => item.title.includes(name.replace(/\.[^.]+$/u, ""))) ?? (await library.list({ kind: "image" })).items[0]!;
    return { source: "library" as const, itemId: item.itemId, revisionDigest: item.revisionDigest, caption: "原图说明" };
  };
  return { ...f, library, drafts, service, ref, create, picture };
}
it("creates through one-use Job and reopens after a fresh repository instance", async () => {
  const f = await setup();
  const preview = value<PublicationDraftPreview>(await f.service.request({ operation: "create_publication", publicationType: "image_text", title: "新图文" }, user));
  expect(preview.intent.channel).toBeUndefined();
  expect(await f.drafts.list()).toEqual([]);
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
  expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
  expect(job.channel).toBeUndefined();
  const reloaded = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library: f.library, now: f.now });
  expect(await reloaded.read(preview.intent.contentRef)).toMatchObject({ title: "新图文", issues: expect.arrayContaining(["图文尚未添加图片"]) });
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  const page = await f.library.list({ publicationType: "image_text" });
  expect(page.total).toBe(1); expect(page.items[0]).toMatchObject({ publicationRef: preview.intent.contentRef, contentRef: null, readOnly: false });
  expect(f.remoteCalls()).toBe(0);
});
it("copies ordered media and cover into immutable versions without changing source bytes", async () => {
  const f = await setup(); const first = await f.picture("first.png"); const second = await f.picture("second.png", Buffer.concat([testPng().subarray(0, -12), pngChunk("tEXt", Buffer.from("Description\0Second fixture")), testPng().subarray(-12)]));
  const original = await readFile(resolve(f.sourcePath, "first.png"));
  const draft = await f.create("image_text", { ...empty, body: "会议论文配图", media: [second, first], coverItemId: first.itemId, channels: ["xiaohongshu", "zhihu"] });
  expect(draft.media.map(asset => asset.caption)).toEqual(["原图说明", "原图说明"]);
  expect(draft.coverItemId).toBe(draft.media[1]!.itemId);
  await rm(resolve(f.sourcePath, "first.png"));
  const media = await f.drafts.media({ contentRef: f.ref, itemId: draft.coverItemId!, revisionDigest: draft.revisionDigest, offset: 0, length: original.length }, signal());
  expect(Buffer.from(media.dataBase64, "base64")).toEqual(original);
  f.setTime("2026-09-07T00:00:00.000Z");
  const changed = { ...publicationEdit(draft), title: "调整顺序", media: [...publicationEdit(draft).media].reverse() };
  const saved = await f.drafts.commit(await f.drafts.plan(f.ref, "image_text", draft.revisionDigest, changed, signal()), signal(), () => {});
  expect(saved.createdAt).toBe(draft.createdAt); expect(saved.updatedAt).not.toBe(draft.updatedAt);
  expect(saved.media[0]!.itemId).toBe(draft.media[1]!.itemId);
  expect((await readdir(f.writePath)).filter(name => name.startsWith(".wemedia-publication-"))).toHaveLength(2);
  expect((await f.library.list({ publicationType: "image_text", channel: "xiaohongshu", timeField: "created", updatedFrom: "2026-09-06T00:00:00Z", updatedTo: "2026-09-07T00:00:00Z" })).total).toBe(1);
  expect((await f.library.list({ publicationType: "image_text", timeField: "published", updatedFrom: "2026-09-01T00:00:00Z" })).total).toBe(0);
  expect((await f.library.list({ publicationType: "image_text", channel: "x" })).total).toBe(0);
  expect((await f.library.list({ publicationType: "image_text", channel: "xiaohongshu", publicationStatus: "draft" })).total).toBe(1);
  expect((await f.library.list({ publicationType: "image_text", channel: "xiaohongshu", publicationStatus: "published" })).total).toBe(0);
});
it("rejects a stale selected source and stale expected draft revision before registering a write", async () => {
  const f = await setup(); const selected = await f.picture();
  const plan = await f.drafts.plan(f.ref, "image_text", null, { ...empty, media: [selected] }, signal());
  await writeFile(resolve(f.sourcePath, "image.png"), Buffer.concat([testPng().subarray(0, -12), pngChunk("tEXt", Buffer.from("Description\0Changed fixture")), testPng().subarray(-12)]));
  await expect(f.drafts.commit(plan, signal(), () => {})).rejects.toMatchObject({ code: "PUBLICATION_MEDIA_CHANGED" });
  expect(await f.drafts.list()).toEqual([]);
  const draft = await f.create();
  await expect(f.drafts.plan(f.ref, "image_text", `sha256:${"0".repeat(64)}`, publicationEdit(draft), signal())).rejects.toMatchObject({ code: "REVISION_CHANGED" });
});
it("detects changed or symlinked saved media even after a cached preview", async () => {
  const f = await setup(); const selected = await f.picture(); const draft = await f.create("image_text", { ...empty, media: [selected] });
  const request = { contentRef: f.ref, itemId: draft.media[0]!.itemId, revisionDigest: draft.revisionDigest, offset: 0, length: 32 };
  await f.drafts.media(request, signal());
  const folder = (await readdir(f.writePath)).find(name => name.startsWith(".wemedia-publication-"))!;
  const asset = resolve(f.writePath, folder, "assets", (await readdir(resolve(f.writePath, folder, "assets")))[0]!);
  const bytes = await readFile(asset); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(asset, bytes);
  await expect(f.drafts.media(request, signal())).rejects.toMatchObject({ code: "PUBLICATION_MEDIA_CHANGED" });
  await rm(asset); await symlink(resolve(f.sourcePath, "image.png"), asset);
  await expect(f.drafts.media(request, signal())).rejects.toMatchObject({ code: "PUBLICATION_PATH_INVALID" });
});
it("leaves unregistered versions hidden after overlay failure; never automatically adopts them", async () => {
  const f = await setup(); const plan = await f.drafts.plan(f.ref, "image_text", null, empty, signal());
  const commit = vi.spyOn(f.store, "update").mockRejectedValueOnce(new Error("fixture storage failure"));
  await expect(f.drafts.commit(plan, signal(), () => {})).rejects.toThrow("fixture storage failure");
  commit.mockRestore();
  expect(await f.drafts.list()).toEqual([]); expect((await f.library.list({})).total).toBe(0);
  expect((await readdir(f.writePath)).filter(name => name.startsWith(".wemedia-publication-"))).toHaveLength(1);
});
it("rejects expired publication intents and never writes after cancellation", async () => {
  const f = await setup(); const preview = value<PublicationDraftPreview>(await f.service.request({ operation: "create_publication", publicationType: "video", title: "视频样稿" }, user));
  f.setTime("2026-09-06T00:11:00.000Z");
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  const controller = new AbortController(); controller.abort();
  await expect(f.drafts.plan(f.ref, "video", null, empty, controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(await f.drafts.list()).toEqual([]);
});
it("isolates unsupported channels and missing items in readonly batch checks", async () => {
  const f = await setup(); const draft = await f.create(); const missing = `wmc:${randomUUID()}`;
  const answer = value<BatchPreflightResult>(await f.service.request({ operation: "batch_preflight", contentRefs: [draft.contentRef, missing], channels: ["wechat", "zhihu"] }, user));
  expect(answer.results).toHaveLength(4);
  expect(answer.results.slice(0, 2).every(entry => entry.code === "MEDIA_PUBLISHER_UNAVAILABLE")).toBe(true);
  expect(answer.results.slice(2).every(entry => entry.status === "block")).toBe(true);
  expect(f.remoteCalls()).toBe(0);
});
it.each([
  { operation: "create_publication", publicationType: "image", title: "x" },
  { operation: "create_publication", publicationType: "video", title: "x", approved: true },
  { operation: "batch_preflight", contentRefs: [], channels: ["wechat"] },
  { operation: "batch_preflight", contentRefs: [`wmc:${randomUUID()}`], channels: ["wechat", "wechat"] },
  { operation: "library_list", timeField: "mtime", channel: "wechat" },
])("rejects forged publication/batch inputs %#", input => { expect(() => decodeWorkbenchRequest(input)).toThrow(); });

it("builds revision-bound media Agent briefs using the current shared tools without making model or platform calls", async () => {
  const f = await setup(); const draft = await f.create("video");
  for (const action of ["research", "write_draft", "review"]) {
    const brief = value<{ contentRef: string; revisionDigest: string; action: string; prompt: string }>(await f.service.request({ operation: "task_brief", contentRef: draft.contentRef, action }, user));
    expect(brief).toMatchObject({ contentRef: draft.contentRef, revisionDigest: draft.revisionDigest, action });
    expect(brief.prompt).toContain("wemedia_publication_read");
    expect(brief.prompt).toContain("当前 DSH 会话模型");
    expect(brief.prompt).not.toContain(f.directory);
  }
  expect(f.remoteCalls()).toBe(0);
});

it("isolates a damaged registered media draft while retaining healthy drafts, articles and source assets", async () => {
  const f = await setup();
  await writeFile(resolve(f.sourcePath, "healthy.md"), "# Healthy article\nReadable source.\n");
  await f.picture();
  const damaged = await f.create();
  const healthyRef = `wmc:${randomUUID()}` as ContentRef;
  await f.drafts.commit(await f.drafts.plan(healthyRef, "video", null, { ...empty, title: "Healthy video" }, signal()), signal(), () => {});
  const state = await f.store.read();
  const pointer = (state.extensions.publicationDrafts as Record<string, { folder: string }>)[damaged.contentRef]!;
  await writeFile(resolve(f.writePath, pointer.folder, "manifest.json"), "{damaged");
  const page = await f.library.list();
  expect(page.items.some(item => item.publicationRef === healthyRef)).toBe(true);
  expect(page.items.some(item => item.publicationRef === damaged.contentRef)).toBe(false);
  const article = page.items.find(item => item.title === "Healthy article")!;
  expect(article).toBeDefined();
  expect(page.items.some(item => item.kind === "image")).toBe(true);
  expect(page.issues.join(" ")).toContain("1 份已登记发布稿");
  expect((await f.library.read(article.itemId)).markdown).toContain("Readable source");
  expect((await f.library.list({ publicationType: "article" })).items).toContainEqual(article);
  await expect(f.drafts.read(damaged.contentRef)).rejects.toThrow();
  expect(await readFile(resolve(f.writePath, pointer.folder, "manifest.json"), "utf8")).toBe("{damaged");
});

it("keeps the article library available when the entire media index cannot be read", async () => {
  const f = await setup();
  await writeFile(resolve(f.sourcePath, "healthy.md"), "# Healthy article\nReadable source.\n");
  vi.spyOn(f.drafts, "catalog").mockRejectedValue(new Error("private failure details"));
  const page = await f.library.list({ publicationType: "article" });
  expect(page.total).toBe(1);
  expect(page.issues.join(" ")).toContain("媒体发布稿索引暂不可读取");
  expect(JSON.stringify(page)).not.toContain("private failure details");
  expect((await f.library.read(page.items[0]!.itemId)).markdown).toContain("Readable source");
});

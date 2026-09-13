import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { PublicationAsset, PublicationDraft, PublicationDraftPreview, PublicationEdit } from "../../src/domain/publicationDraft.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { WorkbenchAnswer, WorkbenchJob, WorkbenchRequest, WorkbenchValue } from "../../src/domain/workbench.ts";
import type { LibraryMediaChunk } from "../../src/domain/contentLibrary.ts";
import { WorkbenchController, type SessionTarget } from "../../src/client/controller.ts";
import { PublicationEditor, movePublicationMedia, publicationChanges } from "../../src/client/publication-editor.tsx";
import { AgentView } from "../../src/client/views.tsx";
import { createSetupViewController } from "../../src/client/setup-view.tsx";
import { readPublicationAsset } from "../../src/client/publication-media.tsx";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const ref = "wmc:33333333-3333-4333-8333-333333333333" as const;
const asset = (id = "asset:a", source: PublicationAsset["source"] = "draft"): PublicationAsset => ({ itemId: id, source, revisionDigest: "sha256:asset", caption: "原始说明", title: "第一张图片", kind: "image", mediaType: "image/png", bytes: 3 });
const draft = (): PublicationDraft => ({ schemaVersion: "wemedia.publication-draft/v1", contentRef: ref, publicationType: "image_text", title: "图文测试稿", body: "原始正文", media: [asset()], coverItemId: "asset:a", channels: ["xiaohongshu"], revisionDigest: "sha256:original", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", readOnlySource: false, issues: [], publications: [] });
const preview = (value = draft(), create = false): PublicationDraftPreview => ({ publication: value, summary: ["独立本地版本"], intent: { intentId: create ? "intent-create-publication" : "intent-save-publication", generationId: "test", contentRef: ref, action: create ? "create_publication" : "save_publication", sideEffect: "local_write", targetSummary: "保存精确图文版本", inputDigest: "sha256:edit", expectedChanges: [], blockingGateCodes: [], expiresAt: "2200-01-01T00:00:00Z", approved: false } });
const job = (status: WorkbenchJob["status"] = "queued", action = "save_publication"): WorkbenchJob => ({ jobId: "publication-job", intentId: action === "create_publication" ? "intent-create-publication" : "intent-save-publication", contentRef: ref, generationId: "test", action, status, createdAt: "2026-09-08T00:00:00Z", ...(status !== "queued" ? { finishedAt: "2026-09-08T00:01:00Z" } : {}), retryable: false, progress: { current: 0 }, safeMessage: "本地任务", artifactRefs: [], sideEffect: "local_write", inputDigest: "sha256:edit", cancellationRequested: false });
const answer = (value: WorkbenchValue): RemoteResult<WorkbenchAnswer> => ({ ok: true, value: { ok: true, value, revision: 1 } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }
function setup(custom?: (input: WorkbenchRequest, signal: AbortSignal) => Promise<WorkbenchValue>, session?: SessionTarget) {
  let current = draft(); let jobs: WorkbenchJob[] = []; let generationId = "test", hasWriteRoot = true;
  const request = vi.fn(async (input: WorkbenchRequest, signal: AbortSignal): Promise<RemoteResult<WorkbenchAnswer>> => {
    if (custom && !["snapshot", "refresh", "search"].includes(input.operation)) return answer(await custom(input, signal));
    if (input.operation === "snapshot" || input.operation === "refresh") return answer({ schemaVersion: "wemedia.workbench/v1", generationId, revision: 1, settings: { roots: [], hasWriteRoot, hasDataDir: true, approvalAvailable: false, issues: [] }, capabilities: [], jobs, supportedChannels: ["wechat"] });
    if (input.operation === "search") return answer({ items: [], total: 0, nextCursor: null, revision: 1 });
    if (input.operation === "publication_read") return answer(current);
    if (input.operation === "task_brief") return answer({ contentRef: current.contentRef, action: input.action, revisionDigest: current.revisionDigest, prompt: `Host media brief: ${input.action}` });
    if (input.operation === "preview_publication_save") return answer(preview({ ...current, ...input.edit, media: current.media }));
    if (input.operation === "create_publication") return answer(preview({ ...current, title: input.title, publicationType: input.publicationType, media: [] }, true));
    if (input.operation === "start_action") return answer(job("queued", input.intentId === "intent-create-publication" ? "create_publication" : "save_publication"));
    throw new Error(`Unexpected fixture operation ${input.operation}`);
  });
  const intentTask = vi.fn(); const controller = new WorkbenchController(() => session); controller.connect({ request, intentTask });
  return { controller, request, intentTask, setSettings: (nextGeneration: string, writeEnabled: boolean) => { generationId = nextGeneration; hasWriteRoot = writeEnabled; }, setCurrent: (value: PublicationDraft) => { current = value; }, setJobs: (value: WorkbenchJob[]) => { jobs = value; } };
}

describe("Publication draft controller", () => {
  it.each(["draft", "settings"] as const)("locks media mutation from %s read-only state while keeping previews", async source => {
    const f = setup();
    f.setCurrent({ ...draft(), readOnlySource: source === "draft" });
    if (source === "settings") { f.setSettings("disabled", false); await f.controller.refresh(); }
    await f.controller.selectPublication(ref);
    f.controller.updatePublicationEdit({ title: "must not change", media: [], coverItemId: null, channels: [] });
    await f.controller.previewPublicationSave();
    expect(f.controller.getSnapshot().publicationEdit).toEqual(publicationEdit(draft()));
    expect(f.request.mock.calls.some(([input]) => input.operation === "preview_publication_save")).toBe(false);
    const html = renderToStaticMarkup(createElement(PublicationEditor, { controller: f.controller, state: f.controller.getSnapshot() }));
    expect(html).toContain("只读预览");
    for (const field of ["发布稿标题", "发布稿正文", "素材 1 说明"]) expect(html).toMatch(new RegExp(`aria-label="${field}"[^>]*disabled=""`));
    expect(html.match(/<button[^>]*aria-label="预览素材 1"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(html).toContain("原始正文"); f.controller.dispose();
  });

  it("preserves unsaved media on write-root shutdown and blocks creating or submitting a prior preview", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.selectPublication(ref);
    f.controller.updatePublicationEdit({ body: "still unsaved" }); await f.controller.previewPublicationSave();
    f.setSettings("test", false); await f.controller.refresh();
    await f.controller.confirmPublication(); await f.controller.previewPublicationCreation("video", "blocked");
    expect(f.controller.getSnapshot().publicationEdit?.body).toBe("still unsaved"); expect(f.controller.dirty).toBe(true);
    expect(f.request.mock.calls.some(([input]) => ["start_action", "create_publication"].includes(input.operation))).toBe(false);
    expect(f.controller.getSnapshot().notice?.code).toBe("WRITE_ROOT_MISSING"); f.controller.dispose();
  });

  it.each(["research", "write_draft", "review"] as const)("queues media %s using the selected publication revision and current session", async action => {
    const prompt = vi.fn<SessionTarget["prompt"]>().mockResolvedValue({ ok: true, value: { accepted: true } });
    const f = setup(undefined, { prompt }); await f.controller.selectPublication(ref); await f.controller.taskBrief(action);
    expect(f.request).toHaveBeenCalledWith({ operation: "task_brief", contentRef: ref, action }, expect.any(AbortSignal));
    expect(prompt).toHaveBeenCalledExactlyOnceWith([{ type: "text", text: `Host media brief: ${action}` }], "queue", expect.any(AbortSignal));
    expect(f.intentTask).not.toHaveBeenCalled(); f.controller.dispose();
  });

  it("does not queue a media brief after editing and restoring the same saved body", async () => {
    const pending = deferred<WorkbenchValue>();
    const prompt = vi.fn<SessionTarget["prompt"]>().mockResolvedValue({ ok: true, value: { accepted: true } });
    const f = setup(async input => input.operation === "publication_read" ? draft() : pending.promise, { prompt });
    await f.controller.selectPublication(ref); const briefing = f.controller.taskBrief("research");
    f.controller.updatePublicationEdit({ body: "changed" }); f.controller.updatePublicationEdit({ body: draft().body });
    expect(f.controller.dirty).toBe(false);
    pending.resolve({ contentRef: ref, action: "research", revisionDigest: draft().revisionDigest, prompt: "late brief" }); await briefing;
    expect(prompt).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().notice?.code).toBe("TASK_BRIEF_STALE"); f.controller.dispose();
  });

  it("guards unsaved media before requesting any Agent brief and shows media-specific tasks", async () => {
    const prompt = vi.fn<SessionTarget["prompt"]>(); const f = setup(undefined, { prompt }); await f.controller.selectPublication(ref);
    let html = renderToStaticMarkup(createElement(AgentView, { controller: f.controller, state: f.controller.getSnapshot() }));
    for (const label of ["图文测试稿", "图文发布稿", "研究素材与表达", "撰写发布稿", "审阅发布稿"]) expect(html).toContain(label);
    expect(html).not.toContain("审阅并保存证据");
    expect((html.match(/交给当前 Agent/g) ?? []).length).toBe(3);
    expect(html).not.toContain('disabled=""');
    f.controller.updatePublicationEdit({ body: "unsaved" }); await f.controller.taskBrief("review");
    expect(f.request.mock.calls.some(([input]) => input.operation === "task_brief")).toBe(false);
    expect(f.controller.getSnapshot().notice?.code).toBe("UNSAVED_EDIT");
    html = renderToStaticMarkup(createElement(AgentView, { controller: f.controller, state: f.controller.getSnapshot() }));
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3); f.controller.dispose();
  });

  it("refreshes parent settings on setup generation readback without replacing unsaved media", async () => {
    let generationId = "test", writeRootId: string | null = "write";
    const f = setup(async input => input.operation === "publication_read" ? draft() : {
      schemaVersion: "wemedia.setup/v1", generationId, roots: [], writeRoots: [], selection: { rootIds: [], writeRootId }, dataDirAvailable: true, issues: [], inputDigest: "sha256:settings",
    });
    await f.controller.refresh(); await f.controller.selectPublication(ref); f.controller.updatePublicationEdit({ body: "keep this edit" });
    const manager = createSetupViewController(f.controller); await manager.inspect();
    const before = f.request.mock.calls.filter(([input]) => input.operation === "refresh").length;
    generationId = "reloaded"; writeRootId = null; f.setSettings(generationId, false); await manager.inspect();
    expect(f.controller.getSnapshot().snapshot?.generationId).toBe("reloaded"); expect(f.controller.getSnapshot().snapshot?.settings.hasWriteRoot).toBe(false);
    expect(f.controller.getSnapshot().selected).toBe(ref); expect(f.controller.getSnapshot().publicationEdit?.body).toBe("keep this edit"); expect(f.controller.dirty).toBe(true);
    await manager.inspect();
    expect(f.request.mock.calls.filter(([input]) => input.operation === "refresh")).toHaveLength(before + 1);
    manager.dispose(); f.controller.dispose();
  });

  it("previews creation without a write and explicitly submits the exact local intent", async () => {
    const f = setup(); await f.controller.previewPublicationCreation("video", "新的视频稿");
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: "create_publication", publicationType: "video", title: "新的视频稿" }, expect.any(AbortSignal));
    expect(f.controller.getSnapshot().publicationCreation?.publication.title).toBe("新的视频稿");
    expect(await f.controller.confirmPublication(true)).toMatchObject({ action: "create_publication", status: "queued" });
    expect(f.request).toHaveBeenLastCalledWith({ operation: "start_action", intentId: "intent-create-publication" }, expect.any(AbortSignal));
    expect(f.intentTask).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().publicationCreation).toBeNull();
    f.controller.dispose();
  });

  it("binds save preview to the saved revision and invalidates it on every editing dimension", async () => {
    const f = setup(); await f.controller.selectPublication(ref);
    const changes: Array<Partial<Pick<PublicationEdit, "title" | "body" | "coverItemId" | "channels" | "media">>> = [{ title: "新标题" }, { body: "新正文" }, { coverItemId: null }, { channels: ["zhihu", "xiaohongshu"] }, { media: [{ ...asset(), caption: "新说明" }] }, { media: [] }];
    for (const change of changes) {
      await f.controller.previewPublicationSave(); expect(f.controller.getSnapshot().publicationPreview).not.toBeNull();
      f.controller.updatePublicationEdit(change); expect(f.controller.getSnapshot().publicationPreview).toBeNull(); expect(f.controller.dirty).toBe(true);
    }
    await f.controller.previewPublicationSave();
    expect(f.request).toHaveBeenLastCalledWith({ operation: "preview_publication_save", contentRef: ref, expectedRevision: "sha256:original", edit: f.controller.getSnapshot().publicationEdit }, expect.any(AbortSignal));
    f.controller.dispose();
  });

  it("keeps an edited draft after navigation is cancelled and discards only after explicit confirmation", async () => {
    const f = setup(); await f.controller.selectPublication(ref); f.controller.updatePublicationEdit({ body: "未保存正文" });
    const go = vi.fn(); f.controller.requestNavigation(go); expect(go).not.toHaveBeenCalled();
    f.controller.cancelLeave(); expect(f.controller.getSnapshot().publicationEdit?.body).toBe("未保存正文");
    f.controller.requestNavigation(go); await f.controller.confirmLeave(); expect(go).toHaveBeenCalledOnce(); expect(f.controller.dirty).toBe(false);
    f.controller.dispose();
  });

  it("ignores a late save preview after the current draft changes", async () => {
    const pending = deferred<WorkbenchValue>(); const f = setup(async input => input.operation === "publication_read" ? draft() : pending.promise);
    await f.controller.selectPublication(ref); const reading = f.controller.previewPublicationSave(); const signal = f.request.mock.calls.at(-1)![1];
    f.controller.updatePublicationEdit({ body: "之后输入的正文" }); pending.resolve(preview()); await reading;
    expect(signal.aborted).toBe(true); expect(f.controller.getSnapshot().publicationPreview).toBeNull(); f.controller.dispose();
  });

  it.each(["failed", "succeeded"] as const)("only clears the unchanged submitted edit when its job %s", async status => {
    const f = setup(); f.controller.open(); await f.controller.refresh(); await f.controller.selectPublication(ref);
    f.controller.updatePublicationEdit({ title: "提交的新标题" }); await f.controller.previewPublicationSave(); await f.controller.confirmPublication();
    expect(f.controller.dirty).toBe(true);
    f.setCurrent({ ...draft(), title: "提交的新标题", revisionDigest: "sha256:saved" }); f.setJobs([job(status)]); await f.controller.refreshStatus();
    if (status === "succeeded") { await vi.waitFor(() => expect(f.controller.getSnapshot().publication?.revisionDigest).toBe("sha256:saved")); expect(f.controller.dirty).toBe(false); }
    else { expect(f.controller.getSnapshot().publicationEdit?.title).toBe("提交的新标题"); expect(f.controller.dirty).toBe(true); }
    f.controller.dispose();
  });

  it("does not erase text written after the submitted save", async () => {
    const f = setup(); f.controller.open(); await f.controller.refresh(); await f.controller.selectPublication(ref);
    f.controller.updatePublicationEdit({ title: "提交的标题" }); await f.controller.previewPublicationSave(); await f.controller.confirmPublication();
    f.controller.updatePublicationEdit({ body: "提交后继续写的文字" }); f.setJobs([job("succeeded")]); await f.controller.refreshStatus();
    expect(f.controller.getSnapshot().publicationEdit?.body).toBe("提交后继续写的文字"); expect(f.controller.dirty).toBe(true); f.controller.dispose();
  });

  it("blocks expired preview submission without sending any write", async () => {
    const f = setup(async input => input.operation === "publication_read" ? draft() : { ...preview(), intent: { ...preview().intent, expiresAt: "2000-01-01T00:00:00Z" } });
    await f.controller.selectPublication(ref); await f.controller.previewPublicationSave(); f.request.mockClear();
    expect(await f.controller.confirmPublication()).toBeNull(); expect(f.request).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().notice?.code).toBe("INTENT_EXPIRED"); f.controller.dispose();
  });

  it.each(["side_effect", "action", "target"] as const)("rejects a %s mismatch instead of executing another intent", async mismatch => {
    const intent = { ...preview().intent, ...(mismatch === "side_effect" ? { sideEffect: "remote_publish" as const } : mismatch === "action" ? { action: "publish" } : { contentRef: "wmc:44444444-4444-4444-8444-444444444444" as const }) };
    const f = setup(async input => input.operation === "publication_read" ? draft() : { ...preview(), intent });
    await f.controller.selectPublication(ref); await f.controller.previewPublicationSave(); f.request.mockClear();
    expect(await f.controller.confirmPublication()).toBeNull(); expect(f.request).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().notice?.code).toBe("INTENT_MISMATCH"); f.controller.dispose();
  });

  it("retains succeeded job state when the original save acknowledgment arrives late", async () => {
    const pending = deferred<WorkbenchValue>();
    const f = setup(async input => input.operation === "publication_read" ? draft() : input.operation === "preview_publication_save" ? preview() : pending.promise);
    f.controller.open(); await f.controller.refresh(); await f.controller.selectPublication(ref);
    f.controller.updatePublicationEdit({ title: "提交时标题" }); await f.controller.previewPublicationSave();
    const submitting = f.controller.confirmPublication();
    f.controller.updatePublicationEdit({ body: "后续编辑不能被吞掉" });
    f.setJobs([job("succeeded")]); await f.controller.refreshStatus();
    pending.resolve(job("queued")); await submitting;
    expect(f.controller.getSnapshot().snapshot?.jobs[0]?.status).toBe("succeeded");
    expect(f.controller.getSnapshot().publicationRevision).toBe(1);
    expect(f.controller.getSnapshot().publicationEdit?.body).toBe("后续编辑不能被吞掉");
    expect(f.request.mock.calls.filter(([input]) => input.operation === "start_action")).toHaveLength(1); f.controller.dispose();
  });
});

describe("Publication editor presentation", () => {
  it("renders ordered captions, cover controls, target intentions and a distinct local save flow", async () => {
    const f = setup(); await f.controller.selectPublication(ref); f.controller.updatePublicationEdit({ body: "预览正文" });
    const html = renderToStaticMarkup(createElement(PublicationEditor, { controller: f.controller, state: f.controller.getSnapshot() }));
    for (const label of ["图文发布稿", "发布稿标题", "发布稿正文", "有序配图", "添加配图", "素材 1 说明", "上移素材 1", "下移素材 1", "移除素材 1", "取消指定封面", "目标渠道", "发布稿预览", "预览正文", "查看变更并保存发布稿"]) expect(html).toContain(label);
    expect(html).not.toContain("立即发布"); expect(html).not.toContain("autoplay"); f.controller.dispose();
  });


  it("makes caption, cover, order and target changes reviewable before saving", () => {
    const original = { ...draft(), media: [asset(), { ...asset("asset:b"), title: "第二张图片" }] };
    const edit = publicationEdit(original); edit.title = "改后标题"; edit.body = "改后正文"; edit.channels = ["zhihu"]; edit.coverItemId = "asset:b"; edit.media = movePublicationMedia(edit.media, 0, 1); edit.media[0]!.caption = "改后说明";
    const changes = publicationChanges(original, edit, original.media);
    expect(changes.map(value => value.label)).toEqual(["标题", "正文", "素材与顺序", "封面", "目标渠道"]);
    expect(changes.find(value => value.label === "素材与顺序")?.after).toContain("1. 第二张图片 · sha256:asset\n说明：改后说明");
    expect(movePublicationMedia(edit.media, 0, -1)).toBe(edit.media); expect(movePublicationMedia(edit.media, 1, 1)).toBe(edit.media);
  });

  it("shows the digest difference when two selected files have the same display name", () => {
    const original = draft(), replacement = { ...asset("asset:new", "library"), revisionDigest: "sha256:different" };
    const edit = { ...publicationEdit(original), media: [replacement], coverItemId: replacement.itemId };
    const changes = publicationChanges(original, edit, [replacement]);
    expect(changes.map(value => value.label)).toEqual(["素材与顺序", "封面"]);
    expect(changes[0]!.after).toContain("56:different");
  });
});

describe("Publication media reads", () => {
  const chunk = (id: string, revisionDigest: string): LibraryMediaChunk => ({ itemId: id, revisionDigest, offset: 0, totalBytes: 3, mediaType: "image/png", dataBase64: "YWJj", eof: true });
  it.each(["draft", "library"] as const)("reads %s media with the correct revision authority", async source => {
    const media = asset("asset:a", source), itemRevision = source === "draft" ? draft().revisionDigest : media.revisionDigest;
    const requestContent = vi.fn(async () => chunk(media.itemId, itemRevision)) as unknown as WorkbenchController["requestContent"];
    const signal = new AbortController().signal;
    const blob = await readPublicationAsset({ requestContent }, media, draft(), signal); expect(await blob.text()).toBe("abc");
    expect(requestContent).toHaveBeenCalledExactlyOnceWith({ operation: source === "draft" ? "publication_media" : "library_media", ...(source === "draft" ? { contentRef: ref } : {}), itemId: media.itemId, revisionDigest: itemRevision, offset: 0, length: 256 * 1024 }, signal);
  });
  it("rejects changed media before allocating a usable preview", async () => {
    const requestContent = vi.fn(async () => chunk("different", draft().revisionDigest)) as unknown as WorkbenchController["requestContent"];
    await expect(readPublicationAsset({ requestContent }, asset(), draft(), new AbortController().signal)).rejects.toThrow("MEDIA_CHANGED");
  });
  it("does not read oversized, active-content or cancelled assets", async () => {
    const requestContent = vi.fn() as unknown as WorkbenchController["requestContent"];
    await expect(readPublicationAsset({ requestContent }, { ...asset(), bytes: 65 * 1024 * 1024 }, draft(), new AbortController().signal)).rejects.toThrow();
    await expect(readPublicationAsset({ requestContent }, { ...asset(), mediaType: "image/svg+xml" }, draft(), new AbortController().signal)).rejects.toThrow();
    const owner = new AbortController(); owner.abort(); await expect(readPublicationAsset({ requestContent }, asset(), draft(), owner.signal)).rejects.toThrow();
    expect(requestContent).not.toHaveBeenCalled();
  });
});

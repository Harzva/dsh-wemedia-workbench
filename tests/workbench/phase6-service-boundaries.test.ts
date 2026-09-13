import { randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import type { ActionPreview, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import type { CapabilityReport } from "../../src/domain/capability.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import type { BatchPreflightResult } from "../../src/domain/batchPreflight.ts";
import type { PublicationDraftPreview, PublicationEdit } from "../../src/domain/publicationDraft.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { SetupPreview } from "../../src/domain/setup.ts";
import type { MappingPreview } from "../../src/domain/contentMapping.ts";
import type { SetupPort, SetupState } from "../../src/ports/setup.ts";
import type { ContentMappings, MappingSnapshot } from "../../src/ports/contentMapping.ts";
import { LIBRARY_MEDIA_MAX_BYTES } from "../../src/domain/contentLibrary.ts";
import { success } from "../../src/domain/errors.ts";
import { FilePublicationDrafts } from "../../src/infrastructure/publicationDrafts.ts";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { IsolatedNotifier } from "../../src/infrastructure/localNotifier.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const user = { kind: "user" as const };
const agent = { kind: "agent" as const, sessionId: "phase6-session", callId: "phase6-call" };
const signal = () => new AbortController().signal;
const empty: PublicationEdit = { title: "Fixture publication", body: "", media: [], coverItemId: null, channels: [] };
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); return f; }
function compose(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<ConstructorParameters<typeof WorkbenchService>[0]> = {}) {
  const service = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 }, ...extra });
  cleanups.push(() => service.dispose()); return service;
}
async function mediaSetup() {
  const f = await setup();
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })) });
  const drafts = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library, now: f.now });
  const service = compose(f, { library, publicationDrafts: drafts });
  const ref = `wmc:${randomUUID()}` as ContentRef;
  const imageDraft = async () => {
    await writeFile(resolve(f.sourcePath, "fixture.png"), testPng());
    const image = (await library.list({ kind: "image" })).items[0]!;
    const edit = { ...empty, media: [{ source: "library" as const, itemId: image.itemId, revisionDigest: image.revisionDigest, caption: "Fixture" }] };
    return drafts.commit(await drafts.plan(ref, "image_text", null, edit, signal()), signal(), () => {});
  };
  return { ...f, library, drafts, service, ref, imageDraft };
}
async function remotePreview(f: Awaited<ReturnType<typeof fixture>>, service = f.service) {
  const document = await f.create(); await f.reviewAll(document);
  return value<ActionPreview>(await service.request({ operation: "preview_action", contentRef: document.contentRef, action: "create_draft" }, agent));
}

it("expires an intent while native approval is open before any remote dispatch", async () => {
  const f = await setup(), preview = await remotePreview(f);
  f.setAfterApproval(async () => f.setTime(preview.intent.expiresAt));
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  expect(f.remoteCalls()).toBe(0);
  expect(await f.jobs.loadAll()).toEqual([expect.objectContaining({ status: "failed", resultCode: "INTENT_EXPIRED", retryable: false })]);
});

it.each(["create", "save"] as const)("binds media %s to its Agent session while allowing a later call in that session", async operation => {
  const f = await mediaSetup();
  const draft = operation === "save" ? await f.imageDraft() : undefined;
  const request = draft ? { operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: { ...publicationEdit(draft), title: "Session-bound save" } } : { operation: "create_publication", publicationType: "image_text", title: "Session-bound create" };
  const preview = value<PublicationDraftPreview>(await f.service.request(request, agent));
  for (const caller of [user, { ...agent, sessionId: "another-session" }]) {
    expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, caller)).toMatchObject({ ok: false, error: { code: "PUBLICATION_CALLER_CHANGED" } });
  }
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, { kind: "agent" })).toMatchObject({ ok: false, error: { code: "PUBLICATION_CALLER_UNAVAILABLE" } });
  expect(await f.jobs.loadAll()).toEqual([]);
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, { ...agent, callId: "later-call" }));
  expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
  expect(f.remoteCalls()).toBe(0);
});

it.each(["create", "save"] as const)("prevents an Agent from applying a user's media %s preview", async operation => {
  const f = await mediaSetup(), draft = operation === "save" ? await f.imageDraft() : undefined;
  const request = draft ? { operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: publicationEdit(draft) } : { operation: "create_publication", publicationType: "video", title: "User-owned preview" };
  const preview = value<PublicationDraftPreview>(await f.service.request(request, user));
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "PUBLICATION_CALLER_CHANGED" } });
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, { kind: "user", sessionId: "different-user-scope" })).toMatchObject({ ok: false, error: { code: "PUBLICATION_CALLER_CHANGED" } });
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
  expect((await f.service.settle(job.jobId)).status).toBe("succeeded"); expect(f.remoteCalls()).toBe(0);
});

it.each(["create", "save"] as const)("rejects a media %s preview without an Agent session", async operation => {
  const f = await mediaSetup(), draft = operation === "save" ? await f.imageDraft() : undefined;
  const request = draft ? { operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: publicationEdit(draft) } : { operation: "create_publication", publicationType: "image_text", title: "Missing session" };
  for (const caller of [{ kind: "agent" as const }, { kind: "agent" as const, sessionId: " " }, { kind: "agent" as const, sessionId: "x".repeat(201) }]) {
    expect(await f.service.request(request, caller)).toMatchObject({ ok: false, error: { code: "PUBLICATION_CALLER_UNAVAILABLE" } });
  }
  expect(await f.jobs.loadAll()).toEqual([]); expect(f.remoteCalls()).toBe(0);
});

it("includes the media preview owner in the intent digest without exposing its session", async () => {
  const f = await mediaSetup(), draft = await f.imageDraft();
  const request = { operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: publicationEdit(draft) };
  const first = value<PublicationDraftPreview>(await f.service.request(request, agent));
  const second = value<PublicationDraftPreview>(await f.service.request(request, { ...agent, sessionId: "second-session" }));
  expect(first.intent.artifactDigest).toBe(second.intent.artifactDigest);
  expect(first.intent.inputDigest).not.toBe(second.intent.inputDigest);
  expect(JSON.stringify(first)).not.toContain(agent.sessionId);
  expect(first.intent).not.toHaveProperty("callerKey");
});

it("preserves the article UI-to-Agent approval handoff", async () => {
  const f = await setup(), document = await f.create(); await f.reviewAll(document);
  const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: document.contentRef, action: "create_draft" }, user));
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));
  expect((await f.service.settle(job.jobId)).status).toBe("succeeded"); expect(f.remoteCalls()).toBe(1);
});

it.each(["adapterVersion", "status", "configured", "reasonCode"] as const)("invalidates approval when adapter %s changes", async field => {
  const f = await setup();
  const capability: CapabilityReport = { channel: "wechat", adapter: "fixture", adapterVersion: "1", configured: "configured", actions: [{ action: "draft", status: "ready", reasonCode: "READY", safeMessage: "Ready", checkedAt: f.now() }] };
  vi.spyOn(f.adapter, "discover").mockImplementation(async () => structuredClone(capability));
  const preview = await remotePreview(f);
  f.setAfterApproval(async () => {
    if (field === "adapterVersion") capability.adapterVersion = "2";
    if (field === "status") capability.actions[0]!.status = "degraded";
    if (field === "configured") capability.configured = "missing";
    if (field === "reasonCode") capability.actions[0]!.reasonCode = "ACCOUNT_CHANGED";
  });
  expect(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
  expect(f.remoteCalls()).toBe(0);
});

it("allows a freshly checked capability whose material identity is unchanged", async () => {
  const f = await setup(); let count = 0;
  vi.spyOn(f.adapter, "discover").mockImplementation(async () => ({ channel: "wechat", adapter: "fixture", adapterVersion: "1", configured: "configured", actions: [{ action: "draft", status: "ready", reasonCode: "READY", safeMessage: "Ready", checkedAt: new Date(Date.parse(f.now()) + count++).toISOString() }] }));
  const preview = await remotePreview(f);
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));
  expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
  expect(f.remoteCalls()).toBe(1);
});

it.each(["throw", "timeout"] as const)("isolates a notification %s from approval and durable completion", async failure => {
  const f = await setup();
  const notify = vi.fn(async () => { if (failure === "throw") throw new Error("Synthetic notifier failure"); return await new Promise<never>(() => {}); });
  const service = compose(f, { notifier: new IsolatedNotifier({ notify }, 5) });
  const preview = await remotePreview(f, service);
  const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));
  expect(await service.settle(job.jobId)).toMatchObject({ status: "succeeded", resultCode: "WECHAT_DRAFT_VERIFIED" });
  expect(await f.jobs.loadAll()).toEqual([expect.objectContaining({ status: "succeeded", resultCode: "WECHAT_DRAFT_VERIFIED" })]);
  expect(notify).toHaveBeenCalledTimes(2); expect(f.remoteCalls()).toBe(1);
});

it("keeps batch errors independent and cancellation local to its request", async () => {
  const f = await setup(), document = await f.create();
  const missing = `wmc:${randomUUID()}`;
  const first = value<BatchPreflightResult>(await f.service.request({ operation: "batch_preflight", contentRefs: [missing, document.contentRef], channels: ["zhihu"] }, user));
  expect(first.results).toHaveLength(2);
  expect(first.results[1]).toMatchObject({ contentRef: document.contentRef, code: "CHANNEL_UNSUPPORTED" });
  const cancellation = new AbortController();
  const check = vi.spyOn(f.adapter, "check").mockImplementation(async doc => { cancellation.abort(); return { inputDigest: doc.revisionDigest, status: "pass", issues: [] }; });
  const cancelled = value<BatchPreflightResult>(await f.service.request({ operation: "batch_preflight", contentRefs: [document.contentRef], channels: ["zhihu", "wechat", "xiaohongshu"] }, user, cancellation.signal));
  expect(cancelled).toMatchObject({ cancelled: true, results: [expect.objectContaining({ channel: "zhihu" })] });
  expect(check).toHaveBeenCalledTimes(1);
  expect(value<BatchPreflightResult>(await f.service.request({ operation: "batch_preflight", contentRefs: [document.contentRef], channels: ["zhihu"] }, user)).cancelled).toBe(false);
  expect(await f.jobs.loadAll()).toEqual([]); expect(f.remoteCalls()).toBe(0);
});

it("retains completed multimedia Jobs and reconciles interrupted writes without replay", async () => {
  const f = await mediaSetup(); const ledger = new FileLedgerRepository(resolve(f.dataPath, "ledger.jsonl"));
  const service = compose(f, { publicationDrafts: f.drafts, library: f.library, ledger });
  const preview = value<PublicationDraftPreview>(await service.request({ operation: "create_publication", publicationType: "video", title: "Video fixture" }, user));
  const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
  const done = await service.settle(job.jobId); expect(done.status).toBe("succeeded"); expect(done.resultEventId).toBeDefined();
  const interrupted: WorkbenchJob = { ...done, jobId: `job:${randomUUID()}`, intentId: `intent:${randomUUID()}`, action: "save_publication", status: "running", progress: { current: 0, total: 1 } };
  delete interrupted.finishedAt; delete interrupted.resultEventId;
  await f.jobs.save(interrupted); await service.dispose();
  const commit = vi.spyOn(f.drafts, "commit"), run = vi.spyOn(f.adapter, "run");
  const restored = compose(f, { publicationDrafts: f.drafts, library: f.library, ledger }); await restored.initialize();
  expect(await restored.settle(done.jobId)).toMatchObject({ status: "succeeded", resultEventId: done.resultEventId });
  expect(await restored.settle(interrupted.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "LOCAL_RESULT_UNVERIFIED", retryable: false });
  expect((await f.drafts.read(preview.intent.contentRef)).title).toBe("Video fixture");
  expect(commit).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  const events = []; for await (const event of ledger.readAll()) events.push(event);
  expect(events).toHaveLength(1);
});

it("does not expose a terminal Job before its durable save completes", async () => {
  const f = await mediaSetup(); let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = { loadAll: () => f.jobs.loadAll(), save: async (job: WorkbenchJob) => { if (job.status === "succeeded") { entered = true; await gate; } await f.jobs.save(job); } };
  const service = compose(f, { publicationDrafts: f.drafts, library: f.library, jobs });
  const preview = value<PublicationDraftPreview>(await service.request({ operation: "create_publication", publicationType: "image_text", title: "Durable boundary" }, user));
  const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect((await f.jobs.loadAll()).find(item => item.jobId === job.jobId)?.status).toBe("running");
    expect(value<WorkbenchJob>(await service.request({ operation: "get_job", jobId: job.jobId }, user))).toMatchObject({ status: "running", progress: { current: 0 } });
  } finally { release(); await service.settle(job.jobId); }
  expect(value<WorkbenchJob>(await service.request({ operation: "get_job", jobId: job.jobId }, user)).status).toBe("succeeded");
});

it("releases a completed Job before notification and never unlocks the next Job when that notice ends", async () => {
  const f = await mediaSetup();
  let notificationEntered = false, secondEntered = false, releaseNotification!: () => void, releaseSecond!: () => void, notices = 0;
  const notificationGate = new Promise<void>(resolve => { releaseNotification = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const notifier = { notify: async () => { if (notices++ === 0) { notificationEntered = true; await notificationGate; } return success(undefined); } };
  const state: SetupState = { roots: [], writeRoots: [], selection: { rootIds: [], writeRootId: null }, dataDirAvailable: true, issues: [], signature: "fixture-configuration" };
  const setupPort: SetupPort = { inspect: async () => structuredClone(state), preview: async selection => ({ state: structuredClone(state), selection, blockingCodes: [] }), apply: async (_selection, _signature, current) => current() };
  const service = compose(f, { publicationDrafts: f.drafts, library: f.library, notifier, setup: setupPort });
  const preview = value<PublicationDraftPreview>(await service.request({ operation: "create_publication", publicationType: "image_text", title: "Notification boundary" }, user));
  const firstJob = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));
  let secondJob: WorkbenchJob | undefined;
  try {
    await vi.waitFor(() => expect(notificationEntered).toBe(true));
    expect(value<WorkbenchJob>(await service.request({ operation: "get_job", jobId: firstJob.jobId }, user)).status).toBe("succeeded");
    const firstSetup = value<SetupPreview>(await service.request({ operation: "setup_preview", rootIds: [], writeRootId: null }, user));
    expect(await service.request({ operation: "setup_apply", intentId: firstSetup.intentId }, user)).toMatchObject({ ok: true });
    const draft = await f.drafts.read(preview.intent.contentRef);
    const savePreview = value<PublicationDraftPreview>(await service.request({ operation: "preview_publication_save", contentRef: draft.contentRef, expectedRevision: draft.revisionDigest, edit: { ...publicationEdit(draft), title: "Next save" } }, user));
    const commit = f.drafts.commit.bind(f.drafts);
    vi.spyOn(f.drafts, "commit").mockImplementationOnce(async (...args) => { secondEntered = true; await secondGate; return commit(...args); });
    secondJob = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: savePreview.intent.intentId }, user));
    await vi.waitFor(() => expect(secondEntered).toBe(true));
    releaseNotification(); await service.settle(firstJob.jobId);
    expect(value<WorkbenchJob>(await service.request({ operation: "get_job", jobId: secondJob.jobId }, user)).status).toBe("running");
    const nextSetup = value<SetupPreview>(await service.request({ operation: "setup_preview", rootIds: [], writeRootId: null }, user));
    expect(await service.request({ operation: "setup_apply", intentId: nextSetup.intentId }, user)).toMatchObject({ ok: false, error: { code: "CONTENT_BUSY" } });
  } finally { releaseNotification(); releaseSecond(); await service.settle(firstJob.jobId); if (secondJob) await service.settle(secondJob.jobId); }
  expect((await f.drafts.read(preview.intent.contentRef)).title).toBe("Next save");
});

it("rejects replacement of the confirmed write root before an empty-media commit", async () => {
  const f = await mediaSetup(); const plan = await f.drafts.plan(f.ref, "image_text", null, empty, signal());
  await rename(f.writePath, `${f.writePath}-original`); await mkdir(f.writePath);
  await expect(f.drafts.commit(plan, signal(), () => {})).rejects.toMatchObject({ code: "PUBLICATION_ROOT_CHANGED" });
  expect(await readdir(f.writePath)).toEqual([]); expect(await f.drafts.list()).toEqual([]);
});

it("rejects a replaced root even if identical registered versions are copied back", async () => {
  const f = await mediaSetup(); const draft = await f.imageDraft();
  const input = { contentRef: f.ref, itemId: draft.media[0]!.itemId, revisionDigest: draft.revisionDigest, offset: 0, length: 100 };
  await f.drafts.media(input, signal());
  await rename(f.writePath, `${f.writePath}-original`); await cp(`${f.writePath}-original`, f.writePath, { recursive: true });
  await expect(f.drafts.read(f.ref)).rejects.toMatchObject({ code: "PUBLICATION_ROOT_CHANGED" });
  await expect(f.drafts.media(input, signal())).rejects.toMatchObject({ code: "PUBLICATION_ROOT_CHANGED" });
});

it("binds a plan to its directory identity across repository instances", async () => {
  const f = await mediaSetup(); const plan = await f.drafts.plan(f.ref, "image_text", null, empty, signal());
  await rename(f.writePath, `${f.writePath}-original`); await mkdir(f.writePath);
  const replacement = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library: f.library, now: f.now });
  await expect(replacement.commit(plan, signal(), () => {})).rejects.toMatchObject({ code: "INTENT_CHANGED" });
  expect(await readdir(f.writePath)).toEqual([]);
});

it("rechecks the root after waiting for the overlay transaction queue", async () => {
  const f = await mediaSetup(), plan = await f.drafts.plan(f.ref, "image_text", null, empty, signal());
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), update = f.store.update.bind(f.store);
  vi.spyOn(f.store, "update").mockImplementationOnce(change => update(async state => { entered = true; await gate; return change(state); }));
  const committing = f.drafts.commit(plan, signal(), () => {});
  const rejected = expect(committing).rejects.toMatchObject({ code: "PUBLICATION_ROOT_CHANGED" });
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await rename(f.writePath, `${f.writePath}-original`); await mkdir(f.writePath);
  } finally { release(); }
  await rejected;
  expect((await f.store.read()).extensions.publicationDrafts).toBeUndefined();
  expect(await readdir(f.writePath)).toEqual([]);
});

it.each(["setup", "mapping"] as const)("excludes new Jobs and other configuration commits during %s apply", async operation => {
  const f = await setup(), ref = (await f.create()).contentRef;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const pause = async (assertCurrent?: () => void): Promise<void> => { entered = true; await gate; assertCurrent?.(); };
  const state: SetupState = { roots: [], writeRoots: [], selection: { rootIds: [], writeRootId: null }, dataDirAvailable: true, issues: [], signature: "fixture-configuration" };
  const setupPort: SetupPort = { inspect: async () => structuredClone(state), preview: async selection => ({ state: structuredClone(state), selection, blockingCodes: [] }), apply: async (_selection, _signature, current) => pause(current) };
  const snapshot: MappingSnapshot = { revision: 1, sources: [{ record: { recordId: "fixture-source", rootId: "source", relativePath: "article.md", digest: sha256("fixture"), title: "Fixture", sourceIds: [] }, rootLabel: "Fixture", digest: sha256("fixture"), bytesDigest: sha256("fixture") }], bindings: { "fixture-source": ref }, manualDecisions: [], mappings: { schemaVersion: "wemedia.content-mapping/v1", entries: {} }, knownContentRefs: [ref], conflicts: [] };
  const mappings: ContentMappings = { read: async () => structuredClone(snapshot), commit: async (_expected, _mutation, current) => { await pause(current); return 2; } };
  const service = compose(f, { setup: setupPort, mappings });
  const jobPreview = await remotePreview(f, service);
  const setupPreview = value<SetupPreview>(await service.request({ operation: "setup_preview", rootIds: [], writeRootId: null }, user));
  const mappingPreview = value<MappingPreview>(await service.request({ operation: "mapping_preview", change: { contentRef: ref, operation: "select_canonical", sourceRecordIds: ["fixture-source"] } }, user));
  const setupRequest = { operation: "setup_apply", intentId: setupPreview.intentId }, mappingRequest = { operation: "mapping_apply", intentId: mappingPreview.intentId };
  const pending = service.request(operation === "setup" ? setupRequest : mappingRequest, user);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await service.request({ operation: "start_action", intentId: jobPreview.intent.intentId }, agent)).toMatchObject({ ok: false, error: { code: "CONTENT_BUSY" } });
    expect(await service.request(operation === "setup" ? mappingRequest : setupRequest, user)).toMatchObject({ ok: false, error: { code: "CONTENT_BUSY" } });
    expect((await service.request({ operation: "snapshot" }, user)).ok).toBe(true);
    expect(f.remoteCalls()).toBe(0);
  } finally { release(); await pending; }
  const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: jobPreview.intent.intentId }, agent));
  expect((await service.settle(job.jobId)).status).toBe("succeeded");
  expect(f.remoteCalls()).toBe(1);
});

it("rejects oversized stored assets from metadata before allocating their contents", async () => {
  const f = await mediaSetup(), draft = await f.imageDraft();
  const folder = (await readdir(f.writePath)).find(name => name.startsWith(".wemedia-publication-"))!;
  const asset = resolve(f.writePath, folder, "assets", `${draft.media[0]!.itemId.slice(18)}.png`);
  const handle = await open(asset, "r+"); try { await handle.truncate(LIBRARY_MEDIA_MAX_BYTES + 1); } finally { await handle.close(); }
  await expect(f.drafts.media({ contentRef: f.ref, itemId: draft.media[0]!.itemId, revisionDigest: draft.revisionDigest, offset: 0, length: 100 }, signal())).rejects.toMatchObject({ code: "PUBLICATION_MEDIA_CHANGED" });
});

it("permits read-only media validation but rejects the low-level commit when writes are disabled", async () => {
  const f = await mediaSetup(), draft = await f.imageDraft();
  const readonly = new FilePublicationDrafts({ root: { ...f.roots[1]!, mode: "read" }, store: f.store, library: f.library, now: f.now });
  expect(await readonly.read(f.ref)).toMatchObject({ readOnlySource: true, revisionDigest: draft.revisionDigest });
  expect((await readonly.media({ contentRef: f.ref, itemId: draft.media[0]!.itemId, revisionDigest: draft.revisionDigest, offset: 0, length: 100 }, signal())).totalBytes).toBe(testPng().length);
  const plan = await readonly.plan(f.ref, "image_text", draft.revisionDigest, publicationEdit(draft), signal());
  expect(plan.publication.readOnlySource).toBe(true);
  const before = await readdir(f.writePath);
  await expect(readonly.commit(plan, signal(), () => {})).rejects.toMatchObject({ code: "WRITE_ROOT_MISSING" });
  expect(await readdir(f.writePath)).toEqual(before);
});

it.each(["extra-field", "wrong-body", "unknown-type", "too-many-assets", "broken-json"] as const)("contains a %s manifest failure at the request boundary", async mutation => {
  const f = await mediaSetup(); await f.imageDraft();
  const folder = (await readdir(f.writePath)).find(name => name.startsWith(".wemedia-publication-"))!;
  const path = resolve(f.writePath, folder, "manifest.json"); const raw = JSON.parse(await readFile(path, "utf8"));
  if (mutation === "extra-field") raw.unrecognized = "fixture";
  if (mutation === "wrong-body") raw.bodyFile = "../source/private.txt";
  if (mutation === "unknown-type") raw.publicationType = "archive";
  if (mutation === "too-many-assets") raw.media = Array.from({ length: 19 }, () => raw.media[0]);
  await writeFile(path, mutation === "broken-json" ? "{" : JSON.stringify(raw));
  const answer = await f.service.request({ operation: "publication_read", contentRef: f.ref }, user);
  expect(answer.ok).toBe(false); expect(JSON.stringify(answer)).not.toContain(f.directory); expect(f.remoteCalls()).toBe(0);
});

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelPublishingService } from "../../src/application/channelPublishingService.ts";
import { ADAPTER_ACTIONS } from "../../src/domain/capability.ts";
import { channelEffect } from "../../src/domain/channelPublishing.ts";
import { articleChannelDocument, channelDocumentPayload } from "../../src/domain/channelDocument.ts";
import type { ChannelAction, ChannelPreview, PublishingChannel } from "../../src/domain/channelPublishing.ts";
import { failure, success } from "../../src/domain/errors.ts";
import type { JsonObject } from "../../src/domain/json.ts";
import type { ArticleDocument, WorkbenchCaller, WorkbenchJob } from "../../src/domain/workbench.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { FileOverlayRepository } from "../../src/infrastructure/overlayRepository.ts";
import { FileWorkbenchDocuments, sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import { FilePublicationDrafts } from "../../src/infrastructure/publicationDrafts.ts";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { PublicationDrafts } from "../../src/ports/publicationDrafts.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import type { ChannelBridgeResult, ChannelDocument, ChannelRemote, ChannelRunInput, PublishingAdapter } from "../../src/ports/channelPublishing.ts";
import type { WorkbenchApprovalProvider } from "../../src/ports/workbench.ts";
import { fixture } from "./fixture.ts";
import { testPng } from "../fixtures/png.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const services: ChannelPublishingService[] = [];
const agent = { kind: "agent" as const, sessionId: "channel-fixture", callId: "fixture-call" };
const user = { kind: "user" as const };
const signal = () => new AbortController().signal;
const channels = ["zhihu", "xiaohongshu", "x"] as const;
const account = (channel: PublishingChannel, character = "a") => `${channel}-account:${character.repeat(32)}`;
const remote = (channel: PublishingChannel): ChannelRemote => channel === "zhihu" ? { remoteId: "12345", url: "https://zhuanlan.zhihu.com/p/12345/edit", contentDigest: sha256("fixture-staged-body") } : channel === "x" ? { remoteId: "23456", url: "https://x.com/i/web/status/23456", remoteIds: ["23456"], contentDigest: sha256("fixture-thread-media-proof") } : { remoteId: "abcdef0123456789abcdef01", url: "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01" };
const result = (extra: Partial<ChannelBridgeResult> = {}): ChannelBridgeResult => ({ ok: true, code: "FIXTURE_OK", configured: "configured", permission: "unknown", remoteWriteAttempted: false, reconcileRequired: false, issues: [], artifacts: [], ...extra });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(fixtures.splice(0).map(f => f.cleanup()));
  vi.restoreAllMocks();
});

function adapter(f: Awaited<ReturnType<typeof fixture>>, channel: PublishingChannel) {
  const state = { accountRef: account(channel), remote: remote(channel) };
  const discover = vi.fn(async () => ({ channel, adapter: "synthetic-channel", adapterVersion: "1.0.0", configured: "configured" as const, actions: ADAPTER_ACTIONS.map(action => ({ action, status: "ready" as const, reasonCode: "FIXTURE_AVAILABLE", safeMessage: "Synthetic offline fixture", checkedAt: f.now() })) }));
  const preflight = vi.fn(async (document: ChannelDocument, online: boolean) => result({ revisionDigest: document.revisionDigest, ...(online ? { accountRef: state.accountRef } : {}) }));
  const run = vi.fn(async (action: ChannelAction, input: ChannelRunInput, _signal: AbortSignal): Promise<ChannelBridgeResult> => {
    if (channelEffect(channel, action) === "local_write") {
      if (!input.output) throw new Error("fixture output required");
      const path = resolve(f.writePath, input.output.relativePath); await mkdir(path, { recursive: true });
      const body = JSON.stringify({ revision: input.document.revisionDigest, title: input.document.title }); await writeFile(resolve(path, "prepared.json"), body);
      return result({ code: "FIXTURE_PREPARED", status: action === "stage" ? "manual_handoff" : "prepared", revisionDigest: input.document.revisionDigest, artifacts: [{ rootId: "write", relativePath: `${input.output.relativePath}/prepared.json`, digest: sha256(body) }] });
    }
    return result({ code: "FIXTURE_REMOTE_VERIFIED", status: channel === "zhihu" && action !== "publish" ? "draft" : "published", accountRef: state.accountRef, revisionDigest: input.document.revisionDigest, verifiedAt: f.now(), remote: { ...state.remote }, remoteWriteAttempted: action !== "sync" });
  });
  return { channel, state, discover, preflight, run, supports: (_type: string, _action: string) => true } satisfies PublishingAdapter & { state: typeof state };
}
function build(f: Awaited<ReturnType<typeof fixture>>, existingAdapters?: ReturnType<typeof adapter>[], publications?: PublicationDrafts) {
  const faults = { beforeRename: false };
  const overlayPath = resolve(f.dataPath, "overlay.json"), ledgerPath = resolve(f.dataPath, "channel-ledger.jsonl");
  const store = new WorkbenchStore(new FileOverlayRepository(overlayPath, { beforeRename: async () => { if (faults.beforeRename) throw new Error("synthetic atomic rename failure"); } }));
  const ledger = new FileLedgerRepository(ledgerPath);
  const adapters = existingAdapters ?? channels.map(channel => adapter(f, channel));
  const approval = { request: vi.fn(async () => success({ approved: true, reference: "fixture-native-approval" })), verify: vi.fn(async () => success({ approved: true })) };
  const approvals: WorkbenchApprovalProvider = { available: () => true, forCaller: caller => caller.kind === "agent" ? approval : undefined };
  const writeAvailable = vi.fn(() => true);
  const canStart = vi.fn(() => true);
  const service = new ChannelPublishingService({ generationId: `generation:${randomUUID()}`, adapters, documents: f.documents, ...(publications ? { publications } : {}), store, ledger, approvals, clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 }, writeAvailable, canStart });
  services.push(service);
  return { f, service, adapters, store, ledger, ledgerPath, overlayPath, faults, approval, approvals, writeAvailable, canStart, channel: (name: PublishingChannel) => adapters.find(a => a.channel === name)! };
}
type Harness = ReturnType<typeof build> & { document: ArticleDocument };
async function setup(): Promise<Harness> {
  const f = await fixture(); fixtures.push(f); const document = await f.create();
  const h = build(f); await h.service.initialize(); return { ...h, document };
}
async function preview(h: Harness, channel: PublishingChannel, action: ChannelAction, extra: { targetRef?: string; targetUrl?: string } = {}, caller: WorkbenchCaller = agent): Promise<ChannelPreview> {
  return h.service.preview({ operation: "channel_preview_action", contentRef: h.document.contentRef, channel, action, ...extra }, caller, signal());
}
async function execute(h: Harness, channel: PublishingChannel, action: ChannelAction, extra: { targetRef?: string; targetUrl?: string } = {}, caller: WorkbenchCaller = agent) {
  const p = await preview(h, channel, action, extra, caller);
  const started = await h.service.start(p.intent.intentId, caller, signal());
  return h.service.settle(started.jobId);
}
async function reboot(h: Harness): Promise<Harness> {
  await h.service.dispose(); const next = build(h.f, h.adapters); await next.service.initialize(); return { ...next, document: h.document };
}
async function event(h: Pick<Harness, "ledger">, job: WorkbenchJob) {
  const snapshot = await h.ledger.snapshot(); if (!snapshot.ok) throw new Error("fixture journal unreadable");
  const found = snapshot.value.events.find(entry => entry.jobId === job.jobId); if (!found) throw new Error("fixture event missing"); return found;
}
async function replaceMarkdownOnly(h: Harness) {
  // The legacy article revision intentionally excludes Markdown. Exercise that
  // real compatibility boundary instead of fabricating a ChannelDocument.
  const manifestPath = resolve(h.f.writePath, h.document.document.relativePath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(resolve(dirname(manifestPath), manifest.markdownFile), "A materially different synthetic publication body.\n");
  const changed = await h.f.documents.read(h.document.contentRef);
  expect(changed.revisionDigest).toBe(h.document.revisionDigest); expect(changed.markdown).not.toBe(h.document.markdown);
}

describe("channel publishing with real overlay and append-only ledger", () => {
  it.each(channels)("prepares %s material locally without approval, source writes or publication status", async channel => {
    const h = await setup(); const before = await readdir(h.f.sourcePath);
    const job = await execute(h, channel, "prepare", {}, user);
    expect(job).toMatchObject({ status: "succeeded", action: "channel_prepare", sideEffect: "local_write", retryable: false });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.channel(channel).preflight.mock.calls.every(call => call[1] === false)).toBe(true);
    expect(await readdir(h.f.sourcePath)).toEqual(before); expect(job.artifactRefs).toHaveLength(1);
    expect(h.service.records(h.document.contentRef, h.document.revisionDigest)).toEqual([]);
    expect((await event(h, job)).remote?.entry).toMatchObject({ status: "prepared", revisionDigest: h.document.revisionDigest });
    const next = await reboot(h); expect(next.service.getJob(job.jobId)).toEqual(job); expect(next.service.issues()).toEqual([]);
  });
  it.each(["xiaohongshu", "x"] as const)("%s manual stage only writes a local handoff", async channel => {
    const h = await setup(); const job = await execute(h, channel, "stage", {}, user);
    expect(job).toMatchObject({ status: "succeeded", sideEffect: "local_write" });
    expect((await event(h, job)).remote?.entry).toMatchObject({ status: "manual_handoff" });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.service.records(h.document.contentRef, h.document.revisionDigest)).toEqual([]);
  });
  it("requires and verifies a native approval before Zhihu stage, then binds its platform draft", async () => {
    const h = await setup(); const job = await execute(h, "zhihu", "stage");
    expect(job).toMatchObject({ status: "succeeded", sideEffect: "remote_draft" });
    expect(h.approval.request).toHaveBeenCalledOnce(); expect(h.approval.verify).toHaveBeenCalledOnce();
    expect(h.channel("zhihu").run.mock.calls[0]?.[1]).toMatchObject({ expectedAccountRef: account("zhihu"), authorization: { action: "stage", inputDigest: h.document.revisionDigest, reference: "fixture-native-approval" } });
    expect((await h.service.inspect(h.document.contentRef, signal())).targets).toEqual([expect.objectContaining({ channel: "zhihu", status: "draft", url: remote("zhihu").url })]);
    expect((await preview(h, "zhihu", "stage")).intent.blockingGateCodes).toContain("CHANNEL_EXISTING_TARGET");
  });
  it.each(["xiaohongshu", "x"] as const)("does not call %s publish without native approval", async channel => {
    const h = await setup(); const p = await preview(h, channel, "publish", {}, user);
    await expect(h.service.start(p.intent.intentId, user, signal())).rejects.toMatchObject({ code: "AGENT_APPROVAL_REQUIRED" });
    expect(h.channel(channel).run).not.toHaveBeenCalled(); expect(h.approval.request).not.toHaveBeenCalled();
    const a = await preview(h, channel, "publish"); h.approval.request.mockResolvedValueOnce(success({ approved: false, reference: "" }));
    await expect(h.service.start(a.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect(h.channel(channel).run).not.toHaveBeenCalled();
  });
  it("rejects native approval references which do not verify", async () => {
    const h = await setup(); h.approval.verify.mockResolvedValueOnce(success({ approved: false })); const p = await preview(h, "x", "publish");
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("binds previews to their caller and runtime generation", async () => {
    const h = await setup(); const p = await preview(h, "x", "publish");
    await expect(h.service.start(p.intent.intentId, { kind: "agent", sessionId: "other", callId: "other" }, signal())).rejects.toMatchObject({ code: "CHANNEL_CALLER_CHANGED" });
    const next = await reboot(h);
    await expect(next.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_EXPIRED" });
    expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it.each(["before", "after"] as const)("rechecks account drift %s native approval without calling publish", async phase => {
    const h = await setup(); const p = await preview(h, "x", "publish");
    if (phase === "before") h.channel("x").state.accountRef = account("x", "b");
    else h.approval.request.mockImplementationOnce(async () => { h.channel("x").state.accountRef = account("x", "b"); return success({ approved: true, reference: "fixture-approved-before-change" }); });
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_CHANGED" });
    expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it.each(["before", "after"] as const)("rechecks saved article version drift %s native approval", async phase => {
    const h = await setup(); const p = await preview(h, "x", "publish");
    const change = async () => { await h.f.documents.saveRevision(h.document.contentRef, h.document.revisionDigest, { metadata: { ...h.document.metadata, title: "New saved version" }, html: "<p>A new synthetic version.</p>", markdown: "A new synthetic version." }); };
    if (phase === "before") await change(); else h.approval.request.mockImplementationOnce(async () => { await change(); return success({ approved: true, reference: "fixture-approved-before-save" }); });
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_CHANGED" }); expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it.each(["before", "after"] as const)("binds the complete Markdown body even when legacy revision remains unchanged %s approval", async phase => {
    const h = await setup(); const p = await preview(h, "x", "publish");
    if (phase === "before") await replaceMarkdownOnly(h);
    else h.approval.request.mockImplementationOnce(async () => { await replaceMarkdownOnly(h); return success({ approved: true, reference: "fixture-old-body-approval" }); });
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_CHANGED" }); expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("rejects a stale target binding after an independently completed read-only sync", async () => {
    const h = await setup(); await execute(h, "zhihu", "stage");
    const target = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!;
    const p = await preview(h, "zhihu", "publish", { targetRef: target.targetRef });
    h.f.setTime("2026-09-06T00:01:00.000Z"); h.channel("zhihu").state.remote.contentDigest = sha256("new verified remote body");
    expect((await execute(h, "zhihu", "sync", { targetRef: target.targetRef })).status).toBe("succeeded");
    h.channel("zhihu").run.mockClear();
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_CHANGED" }); expect(h.channel("zhihu").run).not.toHaveBeenCalled();
  });
  it("rechecks target provenance even when the preview used an explicit URL", async () => {
    const h = await setup(); await execute(h, "x", "publish");
    const target = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!;
    const p = await preview(h, "x", "sync", { targetUrl: target.url }, user);
    h.channel("x").state.remote.contentDigest = sha256("subsequently verified provenance"); h.f.setTime("2026-09-06T00:01:00.000Z");
    await execute(h, "x", "sync", { targetRef: target.targetRef }, user); h.channel("x").run.mockClear();
    await expect(h.service.start(p.intent.intentId, user, signal())).rejects.toMatchObject({ code: "INTENT_CHANGED" });
    expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("binds an explicit sync URL to the selected account and passes only the parsed target", async () => {
    const h = await setup(); const job = await execute(h, "x", "sync", { targetUrl: remote("x").url! }, user);
    expect(job).toMatchObject({ status: "succeeded", sideEffect: "read" }); expect(h.approval.request).not.toHaveBeenCalled();
    expect(h.channel("x").run.mock.calls[0]?.[1]).toMatchObject({ target: { remoteId: "23456", url: remote("x").url }, expectedAccountRef: account("x") });
    expect(h.channel("x").run.mock.calls[0]?.[1]).not.toHaveProperty("output");
    expect((await h.service.inspect(h.document.contentRef, signal())).targets).toEqual([expect.objectContaining({ status: "published", url: remote("x").url })]);
  });
  it.each(["https://evil.example/status/23456", "https://x.com/test/status/23456?token=private", "https://name:pass@x.com/test/status/23456"])("blocks unsafe or cross-platform explicit sync URL %s", async targetUrl => {
    const h = await setup(); const p = await preview(h, "x", "sync", { targetUrl });
    expect(p.intent.blockingGateCodes).toContain("CHANNEL_TARGET_URL_INVALID");
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" }); expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("preserves known X thread IDs and media provenance when the exact existing URL is pasted for sync", async () => {
    const h = await setup(); h.channel("x").state.remote.remoteIds = ["23456", "23457"]; await execute(h, "x", "publish");
    h.channel("x").run.mockClear(); h.f.setTime("2026-09-06T00:01:00.000Z");
    await execute(h, "x", "sync", { targetUrl: remote("x").url! }, user);
    expect(h.channel("x").run.mock.calls[0]?.[1].target).toEqual(h.channel("x").state.remote);
  });
  it.each(["succeeded", "reconcile_required"] as const)("never republishes a %s result, including after restart", async outcome => {
    const h = await setup();
    if (outcome === "reconcile_required") h.channel("x").run.mockResolvedValueOnce(result({ ok: false, code: "FIXTURE_POST_TIMEOUT", remoteWriteAttempted: true, reconcileRequired: true, status: "reconcile_required" }));
    const p = await preview(h, "x", "publish"); const job = await h.service.start(p.intent.intentId, agent, signal());
    expect((await h.service.settle(job.jobId)).status).toBe(outcome);
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_EXPIRED" });
    const next = await reboot(h); const duplicate = await preview(next, "x", "publish");
    expect(duplicate.intent.blockingGateCodes).toContain("CHANNEL_RECONCILE_OR_DUPLICATE");
    await expect(next.service.start(duplicate.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" }); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("blocks a stored target when the authenticated account changes", async () => {
    const h = await setup(); await execute(h, "zhihu", "stage"); const targetRef = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!.targetRef;
    h.channel("zhihu").state.accountRef = account("zhihu", "b"); h.channel("zhihu").run.mockClear();
    const p = await preview(h, "zhihu", "sync", { targetRef }); expect(p.intent.blockingGateCodes).toContain("CHANNEL_ACCOUNT_CHANGED");
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" }); expect(h.channel("zhihu").run).not.toHaveBeenCalled();
  });
  it("stops cancelled or expired previews before approval and adapter dispatch", async () => {
    const h = await setup(); const p = await preview(h, "x", "publish"); const controller = new AbortController(); controller.abort();
    await expect(h.service.start(p.intent.intentId, agent, controller.signal)).rejects.toMatchObject({ code: "INTENT_EXPIRED" });
    h.f.setTime("2026-09-06T00:11:00.000Z"); await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "INTENT_EXPIRED" });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.channel("x").run).not.toHaveBeenCalled(); expect(h.service.busy()).toBe(false);
  });
  it("cancels an outstanding approval and releases the channel lock without dispatching", async () => {
    const h = await setup(); const p = await preview(h, "x", "publish"); const competing = await preview(h, "x", "publish");
    let entered!: () => void; const begun = new Promise<void>(resolve => { entered = resolve; }); let release!: () => void;
    h.approval.request.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return success({ approved: true, reference: "fixture-delayed-approval" }); });
    const starting = h.service.start(p.intent.intentId, agent, signal()); const rejected = expect(starting).rejects.toMatchObject({ code: "INTENT_EXPIRED" }); await begun;
    expect(h.service.busy()).toBe(true); await expect(h.service.start(competing.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "CONTENT_BUSY" });
    const pending = h.service.jobs()[0]!; expect(pending.status).toBe("waiting_user"); h.service.cancel(pending.jobId); release(); await rejected;
    expect(h.service.getJob(pending.jobId).status).toBe("cancelled"); expect(h.service.busy()).toBe(false); expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("fails a real initial overlay commit before requesting approval or invoking the adapter", async () => {
    const h = await setup(); const p = await preview(h, "x", "publish"); h.faults.beforeRename = true;
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.channel("x").run).not.toHaveBeenCalled(); expect(h.service.busy()).toBe(false);
  });
  it("honors the parent workbench's synchronous start lock before approval or dispatch", async () => {
    const h = await setup(); const p = await preview(h, "x", "publish"); h.canStart.mockReturnValue(false);
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "CONTENT_BUSY" });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.channel("x").run).not.toHaveBeenCalled(); expect(h.service.jobs()).toEqual([]);
  });
  it("requires current paper reviews before a remote action while allowing local preparation", async () => {
    const h = await setup(); h.document = await h.f.documents.saveRevision(h.document.contentRef, h.document.revisionDigest, { metadata: { ...h.document.metadata, kind: "paper" }, html: "<p>A synthetic paper-review fixture.</p>", markdown: "A synthetic paper-review fixture." });
    const p = await preview(h, "x", "publish"); expect(p.intent.blockingGateCodes).toContain("ARTICLE_REVIEWS_REQUIRED");
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" }); expect(h.channel("x").run).not.toHaveBeenCalled();
    expect((await execute(h, "x", "prepare", {}, user)).status).toBe("succeeded");
    await h.f.reviewAll(h.document); expect((await preview(h, "x", "publish")).intent.blockingGateCodes).not.toContain("ARTICLE_REVIEWS_REQUIRED");
  });
  it("does not let one channel's failed discovery or preflight stop a different channel", async () => {
    const h = await setup(); h.channel("xiaohongshu").discover.mockRejectedValueOnce(new Error("synthetic private discovery failure"));
    h.channel("xiaohongshu").preflight.mockResolvedValueOnce(result({ ok: false, code: "FIXTURE_CHANNEL_UNAVAILABLE", issues: [{ code: "FIXTURE_CHANNEL_UNAVAILABLE", status: "block" }] }));
    await h.service.refresh(); expect(h.service.reports().find(r => r.channel === "xiaohongshu")?.actions[0]?.status).toBe("unavailable");
    expect((await preview(h, "xiaohongshu", "publish")).gates.status).toBe("block");
    expect((await execute(h, "x", "prepare", {}, user)).status).toBe("succeeded");
    expect(JSON.stringify(h.service.reports())).not.toContain("synthetic private");
  });
  it.each(["prepare", "publish"] as const)("cancels a running %s and never retries the dispatched operation", async action => {
    const h = await setup(); let entered!: () => void; const begun = new Promise<void>(resolve => { entered = resolve; });
    h.channel("x").run.mockImplementationOnce(async (_action, _input, abort) => { entered(); await new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("synthetic cancelled")), { once: true })); return result(); });
    const p = await preview(h, "x", action); const job = await h.service.start(p.intent.intentId, agent, signal()); await begun; h.service.cancel(job.jobId);
    expect((await h.service.settle(job.jobId)).status).toBe(action === "publish" ? "reconcile_required" : "cancelled");
    expect(h.channel("x").run).toHaveBeenCalledOnce(); expect(h.service.busy()).toBe(false);
    const next = await reboot(h); expect(next.service.getJob(job.jobId).retryable).toBe(false); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("times out a dispatched remote operation into reconciliation instead of retrying", async () => {
    const h = await setup(); let entered!: () => void; const begun = new Promise<void>(resolve => { entered = resolve; });
    h.channel("x").run.mockImplementationOnce(async (_action, _input, abort) => { entered(); await new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true })); return result(); });
    const p = await preview(h, "x", "publish"); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const job = await h.service.start(p.intent.intentId, agent, signal()); await begun; await vi.advanceTimersByTimeAsync(300_001);
    expect(await h.service.settle(job.jobId)).toMatchObject({ status: "reconcile_required", resultCode: "CHANNEL_TIMEOUT", retryable: false });
    expect(h.channel("x").run).toHaveBeenCalledOnce(); vi.useRealTimers();
  });
  it.each(["preflight", "running-save"] as const)("does not dispatch after the approved intent expires while awaiting %s", async boundary => {
    const h = await setup(); const p = await preview(h, "x", "publish");
    if (boundary === "preflight") {
      const original = h.channel("x").preflight.getMockImplementation()!;
      h.channel("x").preflight.mockImplementation(async (...args) => {
        const answer = await original(...args);
        if (h.approval.verify.mock.calls.length && h.service.jobs().some(job => job.status === "queued")) h.f.setTime("2026-09-06T00:11:00.000Z");
        return answer;
      });
    } else {
      const update = h.store.update.bind(h.store);
      vi.spyOn(h.store, "update").mockImplementation(async change => {
        const answer = await update(change); const state = await h.store.read();
        const entries = state.extensions.channelPublishing as JsonObject | undefined;
        if (entries && Object.values(entries).some(entry => (entry as JsonObject).job && ((entry as JsonObject).job as JsonObject).status === "running")) h.f.setTime("2026-09-06T00:11:00.000Z");
        return answer;
      });
    }
    const started = await h.service.start(p.intent.intentId, agent, signal());
    expect(await h.service.settle(started.jobId)).toMatchObject({ status: "failed", resultCode: "INTENT_EXPIRED" }); expect(h.channel("x").run).not.toHaveBeenCalled();
  });
  it("does not claim the newly saved article was published when a revision changes during adapter execution", async () => {
    const h = await setup(); const original = h.channel("x").run.getMockImplementation()!;
    h.channel("x").run.mockImplementationOnce(async (...args) => {
      const answer = await original(...args); await h.f.documents.saveRevision(h.document.contentRef, h.document.revisionDigest, { metadata: { ...h.document.metadata, title: "Saved while publishing" }, html: "<p>A later synthetic revision.</p>", markdown: "A later synthetic revision." }); return answer;
    });
    expect(await execute(h, "x", "publish")).toMatchObject({ status: "reconcile_required", resultCode: "CHANNEL_REVISION_CHANGED" });
    expect((await h.service.inspect(h.document.contentRef, signal())).targets[0]).toMatchObject({ status: "reconcile_required", verifiedAt: "" });
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("does not verify a changed Markdown body after remote execution merely because its legacy revision matches", async () => {
    const h = await setup(); const original = h.channel("x").run.getMockImplementation()!;
    h.channel("x").run.mockImplementationOnce(async (...args) => { const answer = await original(...args); await replaceMarkdownOnly(h); return answer; });
    expect(await execute(h, "x", "publish")).toMatchObject({ status: "reconcile_required", resultCode: "CHANNEL_REVISION_CHANGED" });
    expect((await h.service.inspect(h.document.contentRef, signal())).targets[0]).toMatchObject({ status: "reconcile_required", verifiedAt: "" }); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("binds publication projections to complete current Markdown after success and restart", async () => {
    const h = await setup(); const original = await execute(h, "x", "publish");
    let activeService = h.service;
    const projectedDocuments = new FileWorkbenchDocuments({ roots: h.f.roots, writeRoot: h.f.roots[1]!, store: h.store, settings: h.f.documents.settings(), now: h.f.now,
      catalog: { refresh: async () => { throw new Error("this read-only test does not scan"); } },
      channelRecords: (ref, revision, documentDigest) => activeService.records(ref, revision, documentDigest),
    });
    expect((await projectedDocuments.read(h.document.contentRef)).publications?.find(record => record.channel === "x")).toMatchObject({ status: "published", evidence: "remote_readback", note: expect.stringContaining("本次保存版本") });
    expect((await event(h, original)).remote?.entry).toMatchObject({ documentDigest: sha256(channelDocumentPayload(articleChannelDocument(h.document))) });
    await replaceMarkdownOnly(h);
    const changed = await projectedDocuments.read(h.document.contentRef);
    expect(changed.revisionDigest).toBe(h.document.revisionDigest);
    expect(changed.publications?.find(record => record.channel === "x")).toMatchObject({ status: "unknown", evidence: "none", checkedAt: null, url: remote("x").url, note: expect.stringContaining("当前全文或素材已与核验版本不同") });
    const inspect = await h.service.inspect(h.document.contentRef, signal());
    expect(inspect.targets[0]).toMatchObject({ status: "reconcile_required", verifiedAt: "", label: expect.stringContaining("当前全文待核对") });
    const next = await reboot(h); activeService = next.service;
    expect(next.service.issues()).toEqual([]);
    expect((await projectedDocuments.read(h.document.contentRef)).publications?.find(record => record.channel === "x")?.status).toBe("unknown");
    expect((await preview(next, "x", "publish")).intent.blockingGateCodes).toContain("CHANNEL_RECONCILE_OR_DUPLICATE");
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("blocks publishing a Zhihu draft whose complete Markdown binding has changed", async () => {
    const h = await setup(); await execute(h, "zhihu", "stage");
    const target = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!;
    await replaceMarkdownOnly(h);
    const p = await preview(h, "zhihu", "publish", { targetRef: target.targetRef });
    expect(p.intent.blockingGateCodes).toContain("CHANNEL_REVISION_CHANGED");
    expect(p.target).toMatchObject({ status: "reconcile_required", verifiedAt: "" });
    await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" });
    expect(h.channel("zhihu").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(0);
  });
  it("uses the same full media payload for publication records and the approved adapter input", async () => {
    const f = await fixture(); fixtures.push(f);
    const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })) });
    let activeService: ChannelPublishingService | undefined;
    const drafts = new FilePublicationDrafts({ root: f.roots[1]!, store: f.store, library, now: f.now, channelRecords: (ref, revision, documentDigest) => activeService?.records(ref, revision, documentDigest) ?? [] });
    await writeFile(resolve(f.sourcePath, "binding-fixture.png"), testPng());
    const image = (await library.list({ kind: "image" })).items[0]!;
    const ref = `wmc:${randomUUID()}` as ContentRef;
    const draft = await drafts.commit(await drafts.plan(ref, "image_text", null, { title: "Saved media fixture", body: "Caption approved for publication.", coverItemId: image.itemId, media: [{ source: "library", itemId: image.itemId, revisionDigest: image.revisionDigest, caption: "Fixture image" }], channels: ["x"] }, signal()), signal(), () => {});
    const h = build(f, undefined, drafts); activeService = h.service; await h.service.initialize();
    const p = await h.service.preview({ operation: "channel_preview_action", contentRef: ref, channel: "x", action: "publish" }, agent, signal());
    const started = await h.service.start(p.intent.intentId, agent, signal());
    expect((await h.service.settle(started.jobId)).status).toBe("succeeded");
    expect((await drafts.read(ref)).publications[0]).toMatchObject({ status: "published", evidence: "remote_readback" });
    const input = h.channel("x").run.mock.calls[0]![1];
    expect((await event(h, started)).remote?.entry).toMatchObject({ documentDigest: sha256(channelDocumentPayload(input.document)) });
    const changed = await drafts.commit(await drafts.plan(ref, "image_text", draft.revisionDigest, { ...publicationEdit(draft), body: "A later unpublished caption." }, signal()), signal(), () => {});
    expect((await drafts.read(ref)).publications[0]).toMatchObject({ status: "unknown", evidence: "none" });
    expect(changed.revisionDigest).not.toBe(draft.revisionDigest);
    expect((await h.service.inspect(ref, signal())).targets[0]).toMatchObject({ status: "reconcile_required", verifiedAt: "" });
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("keeps legacy results without a complete document digest historical until a fresh read-only sync", async () => {
    const h = await setup(); const original = await execute(h, "x", "publish");
    await h.store.update(state => { delete ((state.extensions.channelPublishing as JsonObject)[original.jobId] as JsonObject).documentDigest; });
    const rows = (await readFile(h.ledgerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const row of rows) delete row.remote.entry.documentDigest;
    await writeFile(h.ledgerPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const next = await reboot(h), currentDigest = sha256(channelDocumentPayload(articleChannelDocument(h.document)));
    expect(next.service.issues()).toEqual([]);
    expect(next.service.records(h.document.contentRef, h.document.revisionDigest, currentDigest)[0]).toMatchObject({ status: "unknown", evidence: "none", note: expect.stringContaining("历史记录缺少完整正文与素材绑定") });
    expect((await next.service.inspect(h.document.contentRef, signal())).targets[0]).toMatchObject({ status: "reconcile_required", verifiedAt: "" });
    expect((await preview(next, "x", "publish")).intent.blockingGateCodes).toContain("CHANNEL_RECONCILE_OR_DUPLICATE");
    h.f.setTime("2026-09-06T00:01:00.000Z");
    expect((await execute(next, "x", "sync", { targetUrl: remote("x").url! }, user)).status).toBe("succeeded");
    const twice = await reboot(next);
    expect(twice.service.records(h.document.contentRef, h.document.revisionDigest, currentDigest)[0]).toMatchObject({ status: "published", evidence: "remote_readback" });
    expect((await twice.service.inspect(h.document.contentRef, signal())).targets[0]?.status).toBe("published");
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(1);
  });
  it("recovers a committed ledger result after a real overlay rename failure without re-running the adapter", async () => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async e => { const saved = await append(e); h.faults.beforeRename = true; return saved; });
    const job = await execute(h, "x", "publish"); expect(job.status).toBe("running");
    expect(h.service.issues()).toContain("CHANNEL_RESULT_PERSISTENCE_FAILED"); expect((await event(h, job)).remote?.entry).toMatchObject({ status: "published" });
    const next = await reboot(h); expect(next.service.getJob(job.jobId)).toMatchObject({ status: "succeeded", resultCode: "FIXTURE_REMOTE_VERIFIED" });
    expect(next.service.issues()).toEqual([]); expect((await next.service.inspect(h.document.contentRef, signal())).targets[0]?.status).toBe("published");
    const twice = await reboot(next); expect(twice.service.getJob(job.jobId).status).toBe("succeeded"); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it.each([
    { acknowledgment: "throw", action: "publish", uncertain: false },
    { acknowledgment: "failure", action: "publish", uncertain: false },
    { acknowledgment: "throw", action: "prepare", uncertain: false },
    { acknowledgment: "failure", action: "publish", uncertain: true },
  ] as const)("preserves the exact journaled $action result after a lost $acknowledgment acknowledgment (uncertain=$uncertain)", async ({ acknowledgment, action, uncertain }) => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    if (uncertain) h.channel("x").run.mockResolvedValueOnce(result({ ok: false, code: "FIXTURE_RESULT_UNKNOWN", remoteWriteAttempted: true, reconcileRequired: true, status: "reconcile_required" }));
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async candidate => {
      expect((await append(candidate)).ok).toBe(true);
      if (acknowledgment === "throw") throw new Error("synthetic lost append acknowledgment");
      return failure("SCHEMA_INVALID_VALUE", "synthetic lost append acknowledgment");
    });
    const job = await execute(h, "x", action, {}, action === "prepare" ? user : agent);
    expect(job.status).toBe(uncertain ? "reconcile_required" : "succeeded");
    expect((await event(h, job)).remote?.entry).toMatchObject({ job });
    expect(h.service.issues()).toEqual([]);
    const next = await reboot(h); const twice = await reboot(next);
    expect(twice.service.getJob(job.jobId)).toEqual(job); expect(twice.service.issues()).toEqual([]);
    expect(h.ledger.append).toHaveBeenCalledOnce(); expect(h.channel("x").run).toHaveBeenCalledOnce();
    expect((await h.ledger.snapshot())).toMatchObject({ ok: true, value: { events: [expect.objectContaining({ jobId: job.jobId })] } });
  });
  it("leaves a durable running job when an append acknowledgment is lost and its journal cannot be read", async () => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async candidate => {
      expect((await append(candidate)).ok).toBe(true);
      vi.spyOn(h.ledger, "readAll").mockImplementationOnce(async function* () { throw new Error("synthetic journal read outage"); });
      throw new Error("synthetic lost append acknowledgment");
    });
    const job = await execute(h, "x", "publish"); expect(job.status).toBe("running"); expect(job.resultEventId).toBeUndefined();
    expect(h.service.issues()).toContain("CHANNEL_RESULT_PERSISTENCE_FAILED");
    expect((await h.service.inspect(h.document.contentRef, signal())).targets).toEqual([]);
    expect((await preview(h, "zhihu", "stage")).intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED");
    const next = await reboot(h); expect(next.service.getJob(job.jobId).status).toBe("succeeded"); expect(next.service.issues()).toEqual([]);
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it.each(["damaged-tail", "duplicate"] as const)("rejects %s evidence after a lost append acknowledgment without rewriting the durable running job", async damage => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async candidate => {
      expect((await append(candidate)).ok).toBe(true);
      if (damage === "damaged-tail") await appendFile(h.ledgerPath, "{synthetic-broken-tail");
      else await appendFile(h.ledgerPath, await readFile(h.ledgerPath, "utf8"));
      return failure("SCHEMA_INVALID_VALUE", "synthetic lost append acknowledgment");
    });
    const job = await execute(h, "x", "publish"); expect(job.status).toBe("running"); expect(job.resultEventId).toBeUndefined();
    expect(h.service.issues()).toContain("CHANNEL_LEDGER_INVALID"); expect(h.service.issues()).toContain("CHANNEL_RESULT_PERSISTENCE_FAILED");
    const stored = (await h.store.read()).extensions.channelPublishing as JsonObject;
    expect((stored[job.jobId] as JsonObject).job).toMatchObject({ status: "running" });
    expect((await h.service.inspect(h.document.contentRef, signal())).targets).toEqual([]);
    expect((await preview(h, "zhihu", "stage")).intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED");
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it.each(["remote", "event-metadata"] as const)("quarantines conflicting %s proof across two restarts after a lost append acknowledgment", async damage => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async candidate => {
      expect((await append(candidate)).ok).toBe(true);
      const changed = JSON.parse(await readFile(h.ledgerPath, "utf8"));
      if (damage === "remote") changed.remote.entry.remote.contentDigest = sha256("conflicting journaled remote body");
      else changed.artifactDigests = [sha256("conflicting journaled artifact")];
      await writeFile(h.ledgerPath, `${JSON.stringify(changed)}\n`);
      return failure("SCHEMA_INVALID_VALUE", "synthetic lost append acknowledgment");
    });
    const job = await execute(h, "x", "publish");
    expect(job).toMatchObject({ status: "reconcile_required", resultCode: "CHANNEL_LEDGER_CONFLICT" });
    expect(h.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    expect((await h.service.inspect(h.document.contentRef, signal())).targets.every(target => target.status === "reconcile_required")).toBe(true);
    const next = await reboot(h); const twice = await reboot(next);
    expect(twice.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    expect((await twice.service.inspect(h.document.contentRef, signal())).targets).toEqual([]);
    expect((await preview(twice, "zhihu", "stage")).intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED");
    expect(h.channel("x").run).toHaveBeenCalledOnce(); expect(h.ledger.append).toHaveBeenCalledOnce();
  });
  it("recovers a lost append acknowledgment even when the subsequent terminal overlay commit also fails", async () => {
    const h = await setup(); const append = h.ledger.append.bind(h.ledger);
    vi.spyOn(h.ledger, "append").mockImplementationOnce(async candidate => {
      expect((await append(candidate)).ok).toBe(true); h.faults.beforeRename = true;
      throw new Error("synthetic lost append acknowledgment");
    });
    const job = await execute(h, "x", "publish"); expect(job.status).toBe("running");
    expect(h.service.issues()).toContain("CHANNEL_RESULT_PERSISTENCE_FAILED");
    const next = await reboot(h); const twice = await reboot(next);
    expect(twice.service.getJob(job.jobId).status).toBe("succeeded"); expect(twice.service.issues()).toEqual([]);
    expect(h.channel("x").run).toHaveBeenCalledOnce(); expect(h.ledger.append).toHaveBeenCalledOnce();
  });
  it("retains an unknown historical terminal result while later sync remains verified through two restarts", async () => {
    const h = await setup(); h.channel("x").run.mockResolvedValueOnce(result({ ok: false, code: "FIXTURE_RESULT_UNKNOWN", remoteWriteAttempted: true, reconcileRequired: true, status: "reconcile_required" }));
    const unknown = await execute(h, "x", "publish"); expect(unknown.status).toBe("reconcile_required");
    const targetRef = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!.targetRef;
    h.f.setTime("2026-09-06T00:01:00.000Z"); const synced = await execute(h, "x", "sync", { targetUrl: remote("x").url! }, user); expect(synced.status).toBe("succeeded");
    const verified = (await h.service.inspect(h.document.contentRef, signal())).targets; expect(verified).toEqual([expect.objectContaining({ targetRef, status: "published" })]);
    const next = await reboot(h); expect(next.service.getJob(unknown.jobId)).toEqual(unknown); expect((await next.service.inspect(h.document.contentRef, signal())).targets).toEqual(verified);
    const twice = await reboot(next); expect(twice.service.getJob(unknown.jobId)).toEqual(unknown); expect((await twice.service.inspect(h.document.contentRef, signal())).targets).toEqual(verified); expect(twice.service.issues()).toEqual([]);
    expect(h.channel("x").run).toHaveBeenCalledTimes(2);
  });
  it("allows repeated fresh read-only sync jobs without append-key conflicts", async () => {
    const h = await setup(); await execute(h, "x", "publish"); const targetRef = (await h.service.inspect(h.document.contentRef, signal())).targets[0]!.targetRef;
    for (let i = 1; i <= 3; i++) { h.f.setTime(`2026-09-06T00:0${i}:00.000Z`); expect((await execute(h, "x", "sync", { targetRef }, user)).status).toBe("succeeded"); }
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(1);
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "sync")).toHaveLength(3);
    expect((await reboot(h)).service.issues()).toEqual([]);
  });
  it("retains an unjournaled remote attempt as uncertain and blocks republishing after restart", async () => {
    const h = await setup(); vi.spyOn(h.ledger, "append").mockRejectedValueOnce(new Error("synthetic private journal failure"));
    const job = await execute(h, "x", "publish"); expect(job.status).toBe("reconcile_required");
    const next = await reboot(h); expect(next.service.getJob(job.jobId).status).toBe("reconcile_required");
    expect((await preview(next, "x", "publish")).intent.blockingGateCodes).toContain("CHANNEL_RECONCILE_OR_DUPLICATE"); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("can reconcile a known remote result after an append failure without leaving a fictitious ledger reference", async () => {
    const h = await setup(); vi.spyOn(h.ledger, "append").mockRejectedValueOnce(new Error("synthetic journal outage"));
    const unknown = await execute(h, "x", "publish"); expect(unknown.status).toBe("reconcile_required");
    expect(unknown.resultEventId).toBeUndefined();
    const next = await reboot(h); expect(next.service.issues()).toEqual([]); h.f.setTime("2026-09-06T00:01:00.000Z");
    expect((await execute(next, "x", "sync", { targetUrl: remote("x").url! }, user)).status).toBe("succeeded");
    const twice = await reboot(next); expect(twice.service.issues()).toEqual([]); expect((await twice.service.inspect(h.document.contentRef, signal())).targets[0]?.status).toBe("published");
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(1);
  });
  it.each(["ledger", "channel-state", "overlay"] as const)("blocks remote writes when durable %s storage is damaged", async kind => {
    const h = await setup(); await execute(h, "x", "prepare", {}, user); await h.service.dispose();
    if (kind === "ledger") await appendFile(h.ledgerPath, "{synthetic-broken-tail");
    else if (kind === "channel-state") await h.store.update(state => { state.extensions.channelPublishing = { bogus: { unsafe: "synthetic private marker" } }; });
    else await writeFile(h.overlayPath, "{synthetic-broken-overlay");
    const next = build(h.f, h.adapters); await expect(next.service.initialize()).resolves.toBeUndefined(); expect(next.service.issues().length).toBeGreaterThan(0);
    if (kind === "overlay") await expect(preview({ ...next, document: h.document }, "x", "publish")).rejects.toMatchObject({ code: "STORAGE_READ_ONLY" });
    else { const p = await preview({ ...next, document: h.document }, "x", "publish"); expect(p.intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED"); await expect(next.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" }); }
    expect(h.channel("x").run).toHaveBeenCalledOnce(); expect(JSON.stringify(next.service.issues())).not.toContain("synthetic private");
  });
  it("detects mismatched terminal overlay evidence instead of silently trusting a forged result code", async () => {
    const h = await setup(); const job = await execute(h, "x", "publish");
    await h.store.update(state => { const entries = state.extensions.channelPublishing as JsonObject; const entry = entries[job.jobId] as JsonObject; (entry.job as JsonObject).resultCode = "FORGED_RESULT_CODE"; });
    const next = await reboot(h); expect(next.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    const p = await preview(next, "zhihu", "stage"); expect(p.intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED"); expect(h.channel("zhihu").run).not.toHaveBeenCalled();
  });
  it.each(["missing-proof", "duplicate-proof"] as const)("blocks %s in a previously committed terminal result", async damage => {
    const h = await setup(); await execute(h, "x", "publish");
    if (damage === "missing-proof") await writeFile(h.ledgerPath, ""); else await appendFile(h.ledgerPath, await readFile(h.ledgerPath, "utf8"));
    const next = await reboot(h); expect(next.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    expect((await preview(next, "zhihu", "stage")).intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED"); expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it.each(["entry", "extension"] as const)("blocks a journaled publish when its overlay %s is missing", async missing => {
    const h = await setup(); const original = await execute(h, "x", "publish");
    await h.store.update(state => {
      if (missing === "entry") delete (state.extensions.channelPublishing as JsonObject)[original.jobId];
      else delete state.extensions.channelPublishing;
    });
    const next = await reboot(h);
    expect(next.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    const again = await preview(next, "x", "publish");
    expect(again.intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED");
    await expect(next.service.start(again.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "GATES_BLOCKED" });
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(1);
    expect((await event(h, original)).remote?.entry).toMatchObject({ status: "published" });
  });
  it.each(["missing-id", "altered-target", "missing-id-and-proof"] as const)("does not expose unverified overlay results after %s", async damage => {
    const h = await setup(); const original = await execute(h, "x", "publish");
    await h.store.update(state => {
      const entry = (state.extensions.channelPublishing as JsonObject)[original.jobId] as JsonObject;
      delete (entry.job as JsonObject).resultEventId;
      if (damage === "altered-target") entry.remote = { remoteId: "99999", url: "https://x.com/i/web/status/99999", remoteIds: ["99999"], contentDigest: sha256("not the journaled post") };
    });
    if (damage === "missing-id-and-proof") await writeFile(h.ledgerPath, "");
    const next = await reboot(h);
    expect(next.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    expect((await next.service.inspect(h.document.contentRef, signal())).targets).toEqual([]);
    expect((await preview(next, "x", "publish")).intent.blockingGateCodes).toContain("CHANNEL_RECOVERY_BLOCKED");
    expect(h.channel("x").run).toHaveBeenCalledOnce();
  });
  it("validates the whole recovery set before exposing any verified target", async () => {
    const h = await setup(); await execute(h, "x", "publish"); const damaged = await execute(h, "zhihu", "stage");
    await h.store.update(state => { delete (((state.extensions.channelPublishing as JsonObject)[damaged.jobId] as JsonObject).job as JsonObject).resultEventId; });
    const next = await reboot(h);
    expect(next.service.issues()).toContain("CHANNEL_LEDGER_INVALID");
    expect((await next.service.inspect(h.document.contentRef, signal())).targets).toEqual([]);
  });
  it.each(["denied", "local-failure"] as const)("preserves a legitimate unjournaled %s without blocking future work", async outcome => {
    const h = await setup();
    if (outcome === "denied") {
      const p = await preview(h, "x", "publish"); h.approval.request.mockResolvedValueOnce(success({ approved: false, reference: "" }));
      await expect(h.service.start(p.intent.intentId, agent, signal())).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    } else {
      h.channel("x").run.mockRejectedValueOnce(new Error("synthetic local prepare failure"));
      expect((await execute(h, "x", "prepare", {}, user)).status).toBe("failed");
    }
    const original = h.service.jobs()[0]!; expect(original.resultEventId).toBeUndefined();
    const next = await reboot(h);
    expect(next.service.getJob(original.jobId)).toEqual(original); expect(next.service.issues()).toEqual([]);
    expect((await preview(next, "x", "publish")).intent.blockingGateCodes).toEqual([]);
    expect(h.channel("x").run.mock.calls.filter(call => call[0] === "publish")).toHaveLength(0);
  });
});

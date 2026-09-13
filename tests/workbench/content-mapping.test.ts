import { randomUUID } from "node:crypto";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentMappingService } from "../../src/application/contentMappingService.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { IdentityService } from "../../src/application/identityService.ts";
import { IndexService } from "../../src/application/indexService.ts";
import { WorkbenchCatalogService } from "../../src/application/workbenchCatalog.ts";
import { FileContentMappings } from "../../src/infrastructure/contentMappings.ts";
import { MemoryIndexRepository } from "../../src/infrastructure/memoryRepositories.ts";
import { scanRoots } from "../../src/infrastructure/scanner.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import type { ContentMappings } from "../../src/ports/contentMapping.ts";
import type { MappingChangeInput } from "../../src/domain/contentMapping.ts";
import { fixture } from "./fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const user = { kind: "user" as const };
const agent = { kind: "agent" as const, sessionId: "fixture-session" };
async function setup() {
  const f = await fixture(); fixtures.push(f);
  for (const name of ["main", "variant", "other"]) await writeFile(resolve(f.sourcePath, `${name}.md`), `# ${name}\n\n原创正文 ${name}`);
  await f.documents.refresh();
  const ids = { uuidV4: randomUUID, opaqueId: (prefix: string) => `${prefix}:${randomUUID()}` };
  const catalog = new WorkbenchCatalogService(new IndexService({ scan: () => scanRoots(f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })), { maxFileBytes: 1024 * 1024 }) }, new MemoryIndexRepository()), new IdentityService(ids), "mapping-catalog", f.now);
  const mappings = new FileContentMappings({ catalog, store: f.store, roots: f.roots, readBytes: f.documents.readBytes.bind(f.documents) });
  const options = { mappings, generationId: "mapping-generation", clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids, hasher: { digest: sha256 } };
  const service = new ContentMappingService(options);
  const snapshot = await mappings.read();
  const sources = Object.fromEntries(snapshot.sources.map(source => [source.record.relativePath.replace(/\.md$/u, ""), source.record.recordId]));
  const contentRef = snapshot.bindings[sources.main!]!;
  const apply = async (change: Omit<MappingChangeInput, "contentRef">) => service.apply((await service.preview({ ...change, contentRef }, user)).intentId, user);
  return { ...f, service, mappings, options, sources, contentRef, apply };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe("controlled local content mappings", () => {
  it("previews and applies canonical/variant mappings without changing source files or invoking adapters", async () => {
    const f = await setup();
    const before = await Promise.all(["main", "variant", "other"].map(name => readFile(resolve(f.sourcePath, `${name}.md`))));
    const preview = await f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    expect(preview).toMatchObject({ sideEffect: "local_write", generationId: "mapping-generation", expectedRevision: (await f.store.read()).revision });
    expect((await f.service.inspect({ contentRef: f.contentRef })).canonical).toBeNull();
    await f.service.apply(preview.intentId, user);
    await f.apply({ operation: "map_variant", channel: "zhihu", sourceRecordIds: [f.sources.variant!] });
    const view = await f.service.inspect({ contentRef: f.contentRef });
    expect(view.canonical).toMatchObject({ sourceRecordId: f.sources.main, stale: false, available: true });
    expect(view.variants).toMatchObject([{ channel: "zhihu", sourceRecordId: f.sources.variant, derivedFromRecordId: f.sources.main, provenance: "explicit_mapping", dirty: false, stale: false }]);
    expect(JSON.stringify(view)).not.toContain(f.directory);
    expect(await Promise.all(["main", "variant", "other"].map(name => readFile(resolve(f.sourcePath, `${name}.md`))))).toEqual(before);
    expect(f.remoteCalls()).toBe(0);
    const restarted = new ContentMappingService({ ...f.options, generationId: "new-generation" });
    expect((await restarted.inspect({ contentRef: f.contentRef })).variants).toEqual(view.variants);
  });

  it("retains the generated baseline and marks human edits dirty and changed canonical inputs stale after restart", async () => {
    const f = await setup();
    await f.apply({ operation: "select_canonical", sourceRecordIds: [f.sources.main!] });
    await f.apply({ operation: "map_variant", channel: "zhihu", sourceRecordIds: [f.sources.variant!] });
    const baseline = (await f.service.inspect({ contentRef: f.contentRef })).variants[0]!.generatedDigest;
    await writeFile(resolve(f.sourcePath, "variant.md"), "# variant\n人工修改必须保留");
    const restarted = new ContentMappingService({ ...f.options, generationId: "reloaded" });
    expect((await restarted.inspect({ contentRef: f.contentRef })).variants[0]).toMatchObject({ dirty: true, stale: false, generatedDigest: baseline });
    await expect(restarted.preview({ contentRef: f.contentRef, operation: "map_variant", channel: "zhihu", sourceRecordIds: [f.sources.variant!] }, user)).rejects.toMatchObject({ code: "MAPPING_VARIANT_DIRTY" });
    await writeFile(resolve(f.sourcePath, "main.md"), "# main\n主稿的新内容");
    const changed = await restarted.inspect({ contentRef: f.contentRef });
    expect(changed.canonical?.stale).toBe(true);
    expect(changed.variants[0]).toMatchObject({ stale: true, dirty: true, generatedDigest: baseline });
    expect(await readFile(resolve(f.sourcePath, "variant.md"), "utf8")).toContain("人工修改必须保留");
  });

  it("binds and separates explicit sources while keeping the old identity, saved documents and remote history in place", async () => {
    const f = await setup();
    await f.store.update(state => { state.extensions.wechatDocuments = { [f.contentRef]: { targets: [{ targetRef: "fixture-target", mediaId: "PRIVATE_REMOTE_ID" }], history: ["fixture-history"] } }; });
    const original = structuredClone((await f.store.read()).extensions.wechatDocuments);
    await f.apply({ operation: "bind", sourceRecordIds: [f.sources.main!, f.sources.other!] });
    await f.apply({ operation: "select_canonical", sourceRecordIds: [f.sources.main!] });
    expect((await f.mappings.read()).bindings[f.sources.other!]).toBe(f.contentRef);
    const separated = await f.apply({ operation: "separate", sourceRecordIds: [f.sources.main!, f.sources.other!], retainedSourceRecordIds: [f.sources.main!] });
    expect(separated.detachedContentRefs).toHaveLength(1);
    expect(separated.detachedContentRefs[0]).not.toBe(f.contentRef);
    await f.documents.refresh();
    const after = await f.mappings.read();
    expect(after.bindings[f.sources.main!]).toBe(f.contentRef);
    expect(after.bindings[f.sources.other!]).toBe(separated.detachedContentRefs[0]);
    expect((await f.store.read()).extensions.wechatDocuments).toEqual(original);
    expect(JSON.stringify(await f.service.inspect({ contentRef: f.contentRef }))).not.toContain("PRIVATE_REMOTE_ID");
  });

  it("retains manual bindings across content edits and exposes revalidation instead of silently moving history", async () => {
    const f = await setup();
    await f.apply({ operation: "bind", sourceRecordIds: [f.sources.main!, f.sources.other!] });
    await writeFile(resolve(f.sourcePath, "other.md"), "# other\n身份材料有更新");
    await f.documents.refresh();
    const view = await f.service.inspect({ contentRef: f.contentRef });
    expect(view.revalidationRequired).toBe(true);
    expect(view.sources.find(source => source.sourceRecordId === f.sources.other)?.contentRef).toBe(f.contentRef);
    expect((await f.store.read()).manualDecisions[0]?.status).toBe("needs_revalidation");
  });

  it.each(["caller", "expiry", "file", "revision", "generation"])("rejects a changed %s before mutation", async mode => {
    const f = await setup();
    const preview = await f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, agent);
    let service = f.service;
    let caller = agent;
    if (mode === "caller") caller = { ...agent, sessionId: "different-session" };
    if (mode === "expiry") f.setTime("2026-09-06T00:11:00.000Z");
    if (mode === "file") await writeFile(resolve(f.sourcePath, "main.md"), "# main\nchanged before apply");
    if (mode === "revision") await f.store.update(state => { state.extensions.otherSubsystem = true; });
    if (mode === "generation") service = new ContentMappingService({ ...f.options, generationId: "different-generation" });
    await expect(service.apply(preview.intentId, caller)).rejects.toMatchObject({ code: { caller: "MAPPING_CALLER_CHANGED", expiry: "MAPPING_INTENT_EXPIRED", file: "MAPPING_INPUT_CHANGED", revision: "MAPPING_INPUT_CHANGED", generation: "MAPPING_INTENT_INVALID" }[mode]! });
    expect((await f.store.read()).extensions.contentMappings).toBeUndefined();
  });

  it("consumes an intent once under concurrent apply and rejects unknown or cross-session mutation attempts", async () => {
    const f = await setup();
    const preview = await f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    const outcomes = await Promise.allSettled([f.service.apply(preview.intentId, user), f.service.apply(preview.intentId, user)]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    await expect(f.service.apply("unknown-intent", user)).rejects.toMatchObject({ code: "MAPPING_INTENT_INVALID" });
    await expect(f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, { kind: "agent" })).rejects.toMatchObject({ code: "MAPPING_CALLER_UNAVAILABLE" });
  });

  it("does not commit when the source read waits beyond the intent expiry", async () => {
    const f = await setup();
    const before = await f.store.read();
    let pauseRead = false, commitCalls = 0;
    const entered = deferred(), release = deferred();
    const queued: ContentMappings = {
      read: async () => {
        const snapshot = await f.mappings.read();
        if (pauseRead) { entered.resolve(); await release.promise; }
        return snapshot;
      },
      commit: async (...args) => { commitCalls++; return f.mappings.commit(...args); },
    };
    const service = new ContentMappingService({ ...f.options, mappings: queued });
    const preview = await service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    pauseRead = true;
    const applied = expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "MAPPING_INTENT_EXPIRED" });
    await entered.promise;
    f.setTime(preview.expiresAt); release.resolve();
    await applied;
    expect(commitCalls).toBe(0);
    expect(await f.store.read()).toEqual(before);
    expect(f.remoteCalls()).toBe(0);
  });

  it.each(["expiry", "cancellation"] as const)("rechecks %s after waiting for the shared overlay commit queue and writes nothing", async mode => {
    const f = await setup();
    const before = await f.store.read();
    const entered = deferred(), release = deferred(), commitQueued = deferred();
    const queued: ContentMappings = {
      read: () => f.mappings.read(),
      commit: (...args) => { const committed = f.mappings.commit(...args); commitQueued.resolve(); return committed; },
    };
    const service = new ContentMappingService({ ...f.options, mappings: queued });
    const preview = await service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    const controller = new AbortController();
    // Hold the real shared writer; abort this unrelated transaction without persisting it.
    const blocker = f.store.update(async () => { entered.resolve(); await release.promise; throw new Error("Fixture transaction cancelled"); }).catch(() => undefined);
    await entered.promise;
    const applied = expect(service.apply(preview.intentId, user, controller.signal)).rejects.toMatchObject({ code: mode === "expiry" ? "MAPPING_INTENT_EXPIRED" : "REQUEST_CANCELLED" });
    await commitQueued.promise;
    if (mode === "expiry") f.setTime(preview.expiresAt); else controller.abort();
    release.resolve();
    await blocker; await applied;
    expect(await f.store.read()).toEqual(before);
    expect(f.remoteCalls()).toBe(0);
  });

  it.each(["inspect", "preview", "apply"] as const)("propagates request cancellation through mapping_%s and stops after a queued source read", async operation => {
    const f = await setup();
    let pauseRead = false, commitCalls = 0;
    const entered = deferred(), release = deferred();
    const queued: ContentMappings = {
      read: async () => {
        const snapshot = await f.mappings.read();
        if (pauseRead) { entered.resolve(); await release.promise; }
        return snapshot;
      },
      commit: async (...args) => { commitCalls++; return f.mappings.commit(...args); },
    };
    const host = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, approvals: f.approvals, mappings: queued, clock: f.options.clock, ids: f.options.ids, hasher: f.options.hasher });
    try {
      await host.initialize();
      const change = { contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] };
      const preview = await host.request({ operation: "mapping_preview", change }, user);
      if (!preview.ok) throw new Error(preview.error.code);
      const request = operation === "inspect" ? { operation: "mapping_inspect", contentRef: f.contentRef } : operation === "preview" ? { operation: "mapping_preview", change } : { operation: "mapping_apply", intentId: (preview.value as { intentId: string }).intentId };
      const before = await f.store.read();
      pauseRead = true;
      const controller = new AbortController(), result = host.request(request, user, controller.signal);
      await entered.promise; controller.abort(); release.resolve();
      expect(await result).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } });
      expect(commitCalls).toBe(0);
      expect(await f.store.read()).toEqual(before);
      expect(f.remoteCalls()).toBe(0);
    } finally { release.resolve(); await host.dispose(); }
  });

  it("rechecks source bytes and generation inside the shared store transaction", async () => {
    const f = await setup();
    const raced: ContentMappings = { read: () => f.mappings.read(), commit: async (expected, mutation, current) => {
      await writeFile(resolve(f.sourcePath, "main.md"), "# main\nchanged at commit boundary");
      return f.mappings.commit(expected, mutation, current);
    } };
    const service = new ContentMappingService({ ...f.options, mappings: raced });
    const preview = await service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "MAPPING_INPUT_CHANGED" });
    expect((await f.store.read()).extensions.contentMappings).toBeUndefined();
    let stopping: ContentMappingService;
    const stopAtCommit: ContentMappings = { read: () => f.mappings.read(), commit: async (expected, mutation, current) => { stopping.dispose(); return f.mappings.commit(expected, mutation, current); } };
    stopping = new ContentMappingService({ ...f.options, mappings: stopAtCommit });
    const stoppedPreview = await stopping.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    await expect(stopping.apply(stoppedPreview.intentId, user)).rejects.toMatchObject({ code: "GENERATION_DISPOSED" });
    expect((await f.store.read()).extensions.contentMappings).toBeUndefined();
  });

  it("rejects symlink replacements and invalid mapping state without changing files or other overlay fields", async () => {
    const f = await setup();
    const preview = await f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.main!] }, user);
    await rename(resolve(f.sourcePath, "main.md"), resolve(f.sourcePath, "moved.md"));
    await symlink(resolve(f.sourcePath, "moved.md"), resolve(f.sourcePath, "main.md"));
    await expect(f.service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "MAPPING_INPUT_CHANGED" });
    await f.store.update(state => { state.extensions.contentMappings = { schemaVersion: "future-unsupported", entries: {} }; state.extensions.keep = "unrelated"; });
    await expect(f.service.inspect({ contentRef: f.contentRef })).rejects.toMatchObject({ code: "MAPPING_STATE_INVALID" });
    expect((await f.store.read()).extensions.keep).toBe("unrelated");
  });

  it("paginates candidates and invalidates a cursor after filter or source changes", async () => {
    const f = await setup();
    const page = await f.service.inspect({ contentRef: f.contentRef, pageSize: 1 });
    expect(page.total).toBe(3); expect(page.nextCursor).not.toBeNull();
    expect((await f.service.inspect({ contentRef: f.contentRef, pageSize: 1, cursor: page.nextCursor! })).sources).toHaveLength(1);
    await expect(f.service.inspect({ contentRef: f.contentRef, query: "main", pageSize: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    await writeFile(resolve(f.sourcePath, "variant.md"), "# variant\nchanged");
    await expect(f.service.inspect({ contentRef: f.contentRef, pageSize: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    await expect(f.service.inspect({ contentRef: f.contentRef, pageSize: 101 })).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("requires explicit binding, canonical choice and complete separation inputs", async () => {
    const f = await setup();
    await expect(f.service.preview({ contentRef: f.contentRef, operation: "select_canonical", sourceRecordIds: [f.sources.other!] }, user)).rejects.toMatchObject({ code: "MAPPING_BINDING_REQUIRED" });
    await expect(f.service.preview({ contentRef: f.contentRef, operation: "map_variant", channel: "zhihu", sourceRecordIds: [f.sources.variant!] }, user)).rejects.toMatchObject({ code: "MAPPING_CANONICAL_REQUIRED" });
    await f.apply({ operation: "bind", sourceRecordIds: [f.sources.main!, f.sources.other!] });
    await f.apply({ operation: "select_canonical", sourceRecordIds: [f.sources.main!] });
    await expect(f.service.preview({ contentRef: f.contentRef, operation: "separate", sourceRecordIds: [f.sources.main!, f.sources.other!], retainedSourceRecordIds: [f.sources.other!] }, user)).rejects.toMatchObject({ code: "MAPPING_CANONICAL_RETENTION_REQUIRED" });
  });

  it("can explicitly map a newly discovered variant without exposing transient content identities", async () => {
    const f = await setup();
    await f.apply({ operation: "select_canonical", sourceRecordIds: [f.sources.main!] });
    await writeFile(resolve(f.sourcePath, "fresh.md"), "# Fresh variant\n新建变体正文");
    const first = await f.service.inspect({ contentRef: f.contentRef, query: "Fresh" });
    const second = await f.service.inspect({ contentRef: f.contentRef, query: "Fresh" });
    expect(first.sources).toEqual(second.sources);
    expect(first.sources[0]?.contentRef).toBeNull();
    await f.apply({ operation: "map_variant", channel: "xiaohongshu", sourceRecordIds: [first.sources[0]!.sourceRecordId] });
    expect((await f.service.inspect({ contentRef: f.contentRef })).variants[0]).toMatchObject({ channel: "xiaohongshu", dirty: false });
  });
});

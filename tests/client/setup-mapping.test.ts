import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SetupInspection, SetupPreview, SetupSelection } from "../../src/domain/setup.ts";
import type { ContentMappingView, MappingPreview } from "../../src/domain/contentMapping.ts";
import type { WorkbenchRequest, WorkbenchValue } from "../../src/domain/workbench.ts";
import { ClientFault, WorkbenchController } from "../../src/client/controller.ts";
import { SetupView, SetupViewController } from "../../src/client/setup-view.tsx";
import { MappingPanel, MappingViewController } from "../../src/client/mapping-view.tsx";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const ref = "wmc:55555555-5555-4555-8555-555555555555" as const;
const before: SetupSelection = { rootIds: ["articles"], writeRootId: null };
const after: SetupSelection = { rootIds: ["articles", "other"], writeRootId: "drafts" };
const setup = (generationId = "first", selection = before): SetupInspection => ({ schemaVersion: "wemedia.setup/v1", generationId, roots: [{ id: "articles", label: "文章库", available: true, selected: selection.rootIds.includes("articles") }, { id: "other", label: "其他内容", available: true, selected: selection.rootIds.includes("other") }], writeRoots: [{ id: "drafts", label: "独立草稿", available: true, selected: selection.writeRootId === "drafts" }], selection, dataDirAvailable: true, issues: [], inputDigest: "sha256:setup" });
const setupPreview = (selection = after): SetupPreview => ({ schemaVersion: "wemedia.setup/v1", generationId: "first", intentId: "setup:exact", sideEffect: "local_write", inputDigest: "sha256:proposal", expiresAt: "2200-01-01T00:00:00Z", before, after: selection, changes: ["启用内容根：其他内容", "选择已配置的独立写入根"], blockingCodes: [] });
const mapping = (): ContentMappingView => ({ schemaVersion: "wemedia.content-mapping/v1", generationId: "first", revision: 3, contentRef: ref, canonical: { sourceRecordId: "source:a", sourceDigest: "sha256:a", selectedAt: "2026-09-08T00:00:00Z", available: true, stale: false, currentDigest: "sha256:a" }, variants: [{ channel: "zhihu", sourceRecordId: "source:b", derivedFromRecordId: "source:a", sourceDigest: "sha256:a", generatedDigest: "sha256:b", mappedAt: "2026-09-08T00:00:00Z", provenance: "explicit_mapping", available: true, dirty: true, stale: true, currentDigest: "sha256:changed" }], sources: [{ sourceRecordId: "source:a", title: "当前主稿", rootId: "articles", rootLabel: "文章库", contentRef: ref, digest: "sha256:a" }, { sourceRecordId: "source:b", title: "知乎版本", rootId: "other", rootLabel: "其他内容", contentRef: ref, digest: "sha256:b" }, { sourceRecordId: "source:c", title: "独立来源", rootId: "other", rootLabel: "其他内容", contentRef: null, digest: "sha256:c" }], total: 3, nextCursor: null, conflicts: [{ leftRecordId: "source:a", rightRecordId: "source:b", evidenceCodes: ["IDENTITY_CONFLICT"] }], revalidationRequired: true });
const mappingPreview = (operation: MappingPreview["operation"] = "select_canonical"): MappingPreview => ({ intentId: "mapping:exact", generationId: "first", contentRef: ref, operation, sideEffect: "local_write", inputDigest: "sha256:change", expiresAt: "2200-01-01T00:00:00Z", expectedRevision: 3, expectedChanges: ["只更新主稿与来源关系"], sources: mapping().sources });
const requestFn = (respond: (input: WorkbenchRequest, signal: AbortSignal) => Promise<WorkbenchValue>) => vi.fn(respond) as unknown as WorkbenchController["requestContent"];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }

describe("Setup selection and reconnect verification", () => {
  it("retries only readback after transient reload without requiring a transport reconnect", async () => {
    vi.useFakeTimers();
    let applied = false, readsAfterApply = 0;
    const refreshed = vi.fn(async () => {});
    const request = requestFn(async input => {
      if (input.operation === "setup_preview") return setupPreview();
      if (input.operation === "setup_apply") { applied = true; return { applied: true, selection: after, requiresReconnect: true }; }
      if (!applied) return setup();
      if (++readsAfterApply === 1) throw new ClientFault("REMOTE_UNAVAILABLE", "正在重载");
      return setup("second", after);
    });
    const manager = new SetupViewController(request, async inspection => { if (inspection.generationId === "second") await refreshed(); });
    try {
      await manager.inspect(); manager.change(after); await manager.preview(); await manager.apply();
      expect(manager.getSnapshot().pending).not.toBeNull(); expect(refreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.getSnapshot().pending).toBeNull(); expect(manager.getSnapshot().notice).toContain("核对生效");
      expect(manager.getSnapshot().error).toBeNull(); expect(refreshed).toHaveBeenCalledOnce();
      expect(vi.mocked(request).mock.calls.filter(([input]) => input.operation === "setup_apply")).toHaveLength(1);
      const count = vi.mocked(request).mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(vi.mocked(request)).toHaveBeenCalledTimes(count);
    } finally { manager.dispose(); vi.useRealTimers(); }
  });

  it.each(["dispose", "limit"] as const)("cleans pending setup readback at %s without retrying apply", async finish => {
    vi.useFakeTimers(); let applied = false;
    const request = requestFn(async input => {
      if (input.operation === "setup_preview") return setupPreview();
      if (input.operation === "setup_apply") { applied = true; return { applied: true, selection: after, requiresReconnect: true }; }
      if (applied) throw new ClientFault("REMOTE_UNAVAILABLE", "正在重载");
      return setup();
    });
    const manager = new SetupViewController(request);
    try {
      await manager.inspect(); manager.change(after); await manager.preview(); await manager.apply();
      if (finish === "dispose") manager.dispose();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(vi.mocked(request).mock.calls.filter(([input]) => input.operation === "setup_inspect")).toHaveLength(finish === "dispose" ? 2 : 22);
      expect(vi.mocked(request).mock.calls.filter(([input]) => input.operation === "setup_apply")).toHaveLength(1);
      if (finish === "limit") expect(manager.getSnapshot().notice).toContain("自动核对已结束");
      expect(vi.getTimerCount()).toBe(0);
    } finally { manager.dispose(); vi.useRealTimers(); }
  });

  it("submits only configured IDs after preview and waits for a new generation to verify success", async () => {
    let current = setup();
    const request = requestFn(async input => input.operation === "setup_inspect" ? current : input.operation === "setup_preview" ? setupPreview() : { applied: true, selection: after, requiresReconnect: true });
    const manager = new SetupViewController(request); await manager.inspect(); manager.change(after); await manager.preview(); await manager.apply();
    expect(request).toHaveBeenCalledWith({ operation: "setup_preview", ...after }, expect.any(AbortSignal));
    expect(request).toHaveBeenCalledWith({ operation: "setup_apply", intentId: "setup:exact" }, expect.any(AbortSignal));
    expect(manager.getSnapshot().notice).toContain("等待重新连接"); expect(manager.getSnapshot().pending).not.toBeNull();
    current = setup("second", after); await manager.inspect(); expect(manager.getSnapshot().notice).toBe("目录选择已在重新连接后核对生效。"); expect(manager.getSnapshot().pending).toBeNull(); manager.dispose();
  });

  it("invalidates a pending preview when a directory choice changes", async () => {
    const pending = deferred<SetupPreview>(); const request = requestFn(async input => input.operation === "setup_inspect" ? setup() : pending.promise);
    const manager = new SetupViewController(request); await manager.inspect(); manager.change(after); const reading = manager.preview(); manager.change(before); pending.resolve(setupPreview()); await reading;
    expect(manager.getSnapshot().preview).toBeNull(); expect(manager.getSnapshot().selection).toEqual(before); manager.dispose();
  });

  it("checks actual configuration after a connection failure instead of retrying a write", async () => {
    let current = setup(); const request = requestFn(async input => { if (input.operation === "setup_inspect") return current; if (input.operation === "setup_preview") return setupPreview(); throw new ClientFault("CONNECTION_LOST", "连接已断开"); });
    const manager = new SetupViewController(request); await manager.inspect(); manager.change(after); await manager.preview(); await manager.apply();
    expect(manager.getSnapshot().pending).not.toBeNull(); current = setup("second", after); await manager.inspect(); expect(manager.getSnapshot().notice).toContain("核对生效");
    expect(vi.mocked(request).mock.calls.filter(([input]) => input.operation === "setup_apply")).toHaveLength(1); manager.dispose();
  });

  it("does not report success when reconnected configuration differs from the accepted proposal", async () => {
    let current = setup(); const request = requestFn(async input => input.operation === "setup_inspect" ? current : input.operation === "setup_preview" ? setupPreview() : { applied: true, selection: after, requiresReconnect: true });
    const manager = new SetupViewController(request); await manager.inspect(); manager.change(after); await manager.preview(); await manager.apply(); current = setup("second", before); await manager.inspect();
    expect(manager.getSnapshot().notice).toContain("与提案不同"); expect(manager.getSnapshot().notice).not.toContain("核对生效"); expect(manager.getSnapshot().selection).toEqual(before); manager.dispose();
  });

  it("shows existing candidates without inventing a write directory or path input", async () => {
    const request = requestFn(async () => ({ ...setup(), writeRoots: [] })); const manager = new SetupViewController(request); await manager.inspect();
    const controller = new WorkbenchController(() => undefined);
    const html = renderToStaticMarkup(createElement(SetupView, { controller, manager }));
    for (const value of ["内容目录设置", "文章库", "其他内容", "独立写入目录", "暂无写入目录候选", "DSH 原生配置"]) expect(html).toContain(value);
    expect(html).not.toContain('type="text"'); expect(html).not.toContain('value="drafts"'); manager.dispose(); controller.dispose();
  });
});

describe("Explicit content mapping changes", () => {
  it("previews nested binding changes with exact source IDs and invalidates on another choice", async () => {
    const request = requestFn(async input => input.operation === "mapping_inspect" ? mapping() : mappingPreview("bind"));
    const manager = new MappingViewController(ref, request); await manager.inspect(); manager.setOperation("bind"); manager.select("source:b", true); manager.select("source:c", true); await manager.preview();
    expect(request).toHaveBeenLastCalledWith({ operation: "mapping_preview", change: { contentRef: ref, operation: "bind", sourceRecordIds: ["source:b", "source:c"] } }, expect.any(AbortSignal));
    expect(manager.getSnapshot().preview).not.toBeNull(); manager.select("source:c", false); expect(manager.getSnapshot().preview).toBeNull(); expect(manager.validSelection).toBe(false); manager.dispose();
  });

  it("requires a retained proper subset including the canonical source before separation", async () => {
    const request = requestFn(async input => input.operation === "mapping_inspect" ? mapping() : mappingPreview("separate"));
    const manager = new MappingViewController(ref, request); await manager.inspect(); manager.setOperation("separate"); manager.selectLoadedBound(); expect(manager.getSnapshot().selected).toEqual(["source:a", "source:b"]);
    expect(manager.validSelection).toBe(false); manager.retain("source:b", true); expect(manager.validSelection).toBe(false); manager.retain("source:b", false); manager.retain("source:a", true); expect(manager.validSelection).toBe(true); await manager.preview();
    expect(request).toHaveBeenLastCalledWith({ operation: "mapping_preview", change: { contentRef: ref, operation: "separate", sourceRecordIds: ["source:a", "source:b"], retainedSourceRecordIds: ["source:a"] } }, expect.any(AbortSignal)); manager.dispose();
  });

  it("requires current canonical ownership and never overwrites a changed variant in the Client", async () => {
    const request = requestFn(async () => mapping()); const manager = new MappingViewController(ref, request); await manager.inspect(); manager.select("source:c", true); expect(manager.validSelection).toBe(false);
    manager.setOperation("map_variant"); manager.select("source:b", true); manager.setChannel("zhihu"); expect(manager.validSelection).toBe(true);
    const html = renderToStaticMarkup(createElement(MappingPanel, { manager }));
    for (const value of ["当前主稿", "知乎版本", "版本正文已修改", "主稿已变化", "来源身份需要核对", "关联版本渠道", "文章来源候选", "来源关系操作"]) expect(html).toContain(value);
    expect(vi.mocked(request).mock.calls.every(([input]) => input.operation === "mapping_inspect")).toBe(true); manager.dispose();
  });

  it("applies one exact mapping intent and reads back the advanced revision", async () => {
    let current = mapping(); const request = requestFn(async input => { if (input.operation === "mapping_inspect") return current; if (input.operation === "mapping_preview") return mappingPreview(); current = { ...current, revision: 4 }; return { intentId: "mapping:exact", contentRef: ref, operation: "select_canonical", revision: 4, detachedContentRefs: [] }; });
    const manager = new MappingViewController(ref, request); await manager.inspect(); manager.select("source:a", true); await manager.preview(); expect(await manager.apply()).toBe(true);
    expect(request).toHaveBeenCalledWith({ operation: "mapping_apply", intentId: "mapping:exact" }, expect.any(AbortSignal)); expect(manager.getSnapshot().notice).toBe("来源关系已保存并回读核对。"); expect(manager.getSnapshot().selected).toEqual([]); expect(manager.getSnapshot().preview).toBeNull(); manager.dispose();
  });

  it("preserves chosen source identity while searching and paginating candidates", async () => {
    const request = requestFn(async input => input.operation === "mapping_inspect" && input.cursor ? { ...mapping(), sources: [mapping().sources[2]!], nextCursor: null } : { ...mapping(), sources: mapping().sources.slice(0, 2), nextCursor: "cursor" });
    const manager = new MappingViewController(ref, request); await manager.inspect(); manager.select("source:a", true); await manager.search("标题"); await manager.inspect(true);
    expect(request).toHaveBeenLastCalledWith({ operation: "mapping_inspect", contentRef: ref, query: "标题", cursor: "cursor", pageSize: 40 }, expect.any(AbortSignal)); expect(manager.getSnapshot().selected).toEqual(["source:a"]); expect(manager.getSnapshot().sources).toHaveLength(3); manager.dispose();
  });

  it("rejects a stale or nonlocal mapping preview before any apply request", async () => {
    const request = requestFn(async input => input.operation === "mapping_inspect" ? mapping() : { ...mappingPreview(), generationId: "old" });
    const manager = new MappingViewController(ref, request); await manager.inspect(); manager.select("source:a", true); await manager.preview(); expect(await manager.apply()).toBe(false);
    expect(vi.mocked(request).mock.calls.some(([input]) => input.operation === "mapping_apply")).toBe(false); expect(manager.getSnapshot().error).toContain("已失效"); manager.dispose();
  });
});

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { filterPlatforms, loadPlatformDirectory, PlatformDirectoryPanel } from "../../src/client/platform-directory.tsx";
import type { PlatformDirectoryHost, PlatformDirectoryState } from "../../src/client/platform-directory.tsx";
import { getPlatformCatalog } from "../../src/domain/platformCatalog.ts";
import type { WorkbenchValue } from "../../src/domain/workbench.ts";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("platform directory read-only interaction", () => {
  it("combines case-insensitive search terms with content type and can clear empty results", () => {
    const catalog = getPlatformCatalog();
    expect(filterPlatforms(catalog, "  InS  ", "image_text").map(item => item.id)).toContain("instagram");
    expect(filterPlatforms(catalog, "instagram", "article")).toEqual([]);
    expect(filterPlatforms(catalog, "B站", "video").map(item => item.id)).toEqual(["bilibili"]);
    expect(filterPlatforms(catalog, "  ", "all")).toHaveLength(8);
    expect(filterPlatforms(catalog, "instagram 不存在", "all")).toHaveLength(0);
  });
  it("loads only the shared read-only operation and disposes its signal", async () => {
    const catalog = getPlatformCatalog();
    const requestContent = vi.fn(async () => catalog) as unknown as PlatformDirectoryHost["requestContent"];
    const publish = vi.fn(); const stop = loadPlatformDirectory({ requestContent }, publish);
    expect(publish).toHaveBeenCalledWith({ catalog: null, loading: true, error: null });
    await flush(); expect(publish).toHaveBeenLastCalledWith({ catalog, loading: false, error: null });
    expect(requestContent).toHaveBeenCalledExactlyOnceWith({ operation: "platform_catalog" }, expect.any(AbortSignal));
    const signal = vi.mocked(requestContent).mock.calls[0]![1]; stop(); expect(signal.aborted).toBe(true);
  });
  it.each(["resolve", "reject"] as const)("ignores a late %s after unmount, hide, disconnect or generation change", async mode => {
    const pending = deferred<WorkbenchValue>(); const publish = vi.fn();
    const stop = loadPlatformDirectory({ requestContent: vi.fn(() => pending.promise) as unknown as PlatformDirectoryHost["requestContent"] }, publish);
    stop(); if (mode === "resolve") pending.resolve(getPlatformCatalog()); else pending.reject(new Error("private host data"));
    await flush(); expect(publish).toHaveBeenCalledTimes(1);
  });
  it("can retry independently and never displays raw errors", async () => {
    const publish = vi.fn();
    loadPlatformDirectory({ requestContent: vi.fn(async () => { throw new Error("private secret path"); }) }, publish);
    await flush(); expect(publish).toHaveBeenLastCalledWith({ catalog: null, loading: false, error: "平台目录暂时不可用，请重试。" });
    const state = publish.mock.calls.at(-1)![0] as PlatformDirectoryState;
    const html = renderToStaticMarkup(createElement(PlatformDirectoryPanel, { state, connected: true, onRetry: vi.fn() }));
    expect(html).toContain('role="alert"'); expect(html).toContain("重新加载"); expect(html).not.toContain("private secret path");
  });
  it("renders eight explicitly unconnected cards with formats, sources and license details", () => {
    const html = renderToStaticMarkup(createElement(PlatformDirectoryPanel, { state: { catalog: getPlatformCatalog(), loading: false, error: null }, connected: true, onRetry: vi.fn() }));
    expect(html.match(/<article /gu)).toHaveLength(8);
    for (const text of ["Instagram", "Threads", "YouTube", "Pinterest", "待接入", "当前还不能从工作台发布", "接入条件", "参考源码与许可", "内容类型", "搜索平台"]) expect(html).toContain(text);
    expect(html).toContain('rel="noopener noreferrer"'); expect(html).not.toContain("立即发布");
  });
  it("shows disconnected status instead of stale catalog cards", () => {
    const html = renderToStaticMarkup(createElement(PlatformDirectoryPanel, { state: { catalog: getPlatformCatalog(), loading: false, error: null }, connected: false, onRetry: vi.fn() }));
    expect(html).toContain("工作台连接后加载目录"); expect(html).not.toContain("<article");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { installWorkbenchSlots, mountWorkbenchRemote } from "../../src/client/lifecycle.ts";

const renderers = { overlay: () => null, settings: () => null };
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("Workbench additive Slot lifecycle", () => {
  it("keeps the namespace settings and owned overlay without the old footer launcher", () => {
    const disposers = [vi.fn(), vi.fn()];
    const register = vi.fn().mockImplementation(() => disposers[register.mock.calls.length - 1]);
    const inject = vi.fn((_name: string, callback: () => () => void) => callback());
    const release = installWorkbenchSlots({ register, inject } as unknown as ClientContext["slots"], renderers);
    expect(register.mock.calls.map(call => call[0])).toEqual([{ name: "shell.overlay", id: "wemedia-workbench-panel" }, { name: "settings.plugin.item", key: "dsh-wemedia-workbench" }]);
    release(); release();
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("isolates both declaration wait and late registration failures", () => {
    const failed = vi.fn();
    const releaseOverlay = vi.fn();
    const register = vi.fn(() => releaseOverlay);
    const inject = vi.fn((name: string, callback: () => () => void) => { if (name === "settings.plugin.item") throw new Error("absent"); return callback(); });
    const release = installWorkbenchSlots({ register, inject } as unknown as ClientContext["slots"], renderers, failed);
    expect(failed.mock.calls).toEqual([["settings.plugin.item"]]);
    expect(register).toHaveBeenCalledWith({ name: "shell.overlay", id: "wemedia-workbench-panel" }, renderers.overlay);
    release();
    expect(releaseOverlay).toHaveBeenCalledTimes(1);
  });
  it("disposes a Remote mount resolving after unload without connecting UI", async () => {
    let finish!: (dispose: () => void) => void;
    const ready = vi.fn(); const failed = vi.fn(); const dispose = vi.fn();
    const release = mountWorkbenchRemote(() => new Promise(resolve => { finish = resolve; }), ready, failed);
    await settle();
    release();
    finish(dispose);
    await settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
  it("handles mount rejection locally and cleans a successful mount once", async () => {
    const failed = vi.fn();
    mountWorkbenchRemote(() => Promise.reject(new Error("offline")), vi.fn(), failed);
    await settle(); await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    const ready = vi.fn(); const dispose = vi.fn();
    const release = mountWorkbenchRemote(() => Promise.resolve(dispose), ready, vi.fn());
    await settle(); await settle();
    expect(ready).toHaveBeenCalledTimes(1);
    release(); release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

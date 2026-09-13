import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchController } from "../../src/client/controller.ts";
import { startJobStatusTracking, useDialogFocus, useJobStatusTracking } from "../../src/client/interactions.ts";
import type { WorkbenchJob, WorkbenchSnapshot } from "../../src/domain/workbench.ts";

const hooks = vi.hoisted(() => ({ effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", () => ({ useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; } }));

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean): void { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")); }
}

const deferred = (): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (status: WorkbenchJob["status"] = "running"): WorkbenchSnapshot => ({
  schemaVersion: "wemedia.workbench/v1", generationId: "generation-test", revision: 1,
  settings: { roots: [], hasWriteRoot: true, hasDataDir: true, approvalAvailable: true, issues: [] },
  capabilities: [], supportedChannels: ["wechat"],
  jobs: [{ jobId: "job-test", generationId: "generation-test", contentRef: "wmc:11111111-1111-4111-8111-111111111111", intentId: "intent-test", inputDigest: "sha256:input", action: "save_revision", sideEffect: "local_write", status, progress: { current: 0, total: 1 }, safeMessage: "Fixture job", createdAt: "2026-01-01T00:00:00Z", retryable: false, artifactRefs: [] }],
});

beforeEach(() => { vi.useFakeTimers(); hooks.effect = undefined; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("view-owned job status observation", () => {
  it("waits 1500ms before each read and never overlaps an in-flight read", async () => {
    const visibility = new Visibility(); const pending = deferred();
    const refresh = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.advanceTimersByTimeAsync(1499);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1499);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("exhausts its 200-read budget without visibility changes restarting it", async () => {
    const visibility = new Visibility(); const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(200);
    expect(vi.getTimerCount()).toBe(0);
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(200);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("starts paused when hidden and cancels a scheduled read on hide", async () => {
    const visibility = new Visibility(); visibility.hidden = true;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(1000);
    visibility.change(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).not.toHaveBeenCalled();
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(1499);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not schedule after an in-flight read settles while hidden", async () => {
    const visibility = new Visibility(); const pending = deferred();
    const refresh = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.advanceTimersByTimeAsync(1500);
    visibility.change(true); pending.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("contains rejected reads and counts failures toward the finite budget", async () => {
    const visibility = new Visibility(); const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(200);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("cleans the pending timer and listener exactly once", async () => {
    const visibility = new Visibility(); const remove = vi.spyOn(visibility, "removeEventListener");
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startJobStatusTracking(refresh, visibility);
    expect(vi.getTimerCount()).toBe(1);
    stop(); stop();
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("does not restart when a read %ss after cleanup", async outcome => {
    const visibility = new Visibility(); const pending = deferred();
    const refresh = vi.fn().mockReturnValue(pending.promise);
    const stop = startJobStatusTracking(refresh, visibility);
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    if (outcome === "resolve") pending.resolve(); else pending.reject(new Error("late disconnect"));
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["closed", "disconnected", "no snapshot", "terminal", "no jobs"])("does not observe when %s", async reason => {
    const visibility = new Visibility(); vi.stubGlobal("document", visibility);
    const controller = new WorkbenchController(() => undefined);
    const refresh = vi.spyOn(controller, "refreshStatus");
    const state = { ...controller.getSnapshot(), open: reason !== "closed", connected: reason !== "disconnected", snapshot: reason === "no snapshot" ? null : snapshot(reason === "terminal" ? "succeeded" : "running") };
    if (reason === "no jobs" && state.snapshot) state.snapshot.jobs = [];
    useJobStatusTracking(controller, state);
    expect(hooks.effect?.()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns observation cleanup from the active hook and stays stopped after closing", async () => {
    const visibility = new Visibility(); vi.stubGlobal("document", visibility);
    const controller = new WorkbenchController(() => undefined);
    const refresh = vi.spyOn(controller, "refreshStatus").mockResolvedValue(undefined);
    const state = { ...controller.getSnapshot(), open: true, connected: true, snapshot: snapshot() };
    useJobStatusTracking(controller, state);
    const stop = hooks.effect?.();
    expect(stop).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(1500);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop?.();
    useJobStatusTracking(controller, { ...state, open: false });
    expect(hooks.effect?.()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("owned dialog focus", () => {
  it("restores an explicit trigger when disabling an async preview button moved focus to body", () => {
    class FocusTarget { isConnected = true; focus = vi.fn(); }
    const body = new FocusTarget(); const trigger = new FocusTarget();
    const dialog = Object.assign(new EventTarget(), { closest: () => null, querySelector: () => null, querySelectorAll: () => [], focus: vi.fn() });
    vi.stubGlobal("document", { body, activeElement: body }); vi.stubGlobal("HTMLElement", FocusTarget);
    useDialogFocus({ current: dialog } as unknown as RefObject<HTMLElement>, true, { current: trigger } as unknown as RefObject<HTMLElement>);
    const stop = hooks.effect?.(); stop?.();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(body.focus).not.toHaveBeenCalled();
  });

  it("includes disclosure summaries in the Tab boundary and restores prior focus", () => {
    const page: { activeElement: FocusTarget | null } = { activeElement: null };
    class FocusTarget {
      isConnected = true;
      focus = vi.fn(() => { page.activeElement = this; });
      getClientRects = () => [{}];
    }
    const previous = new FocusTarget(); const button = new FocusTarget(); const summary = new FocusTarget();
    page.activeElement = previous;
    const dialog = Object.assign(new EventTarget(), {
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: vi.fn((selector: string) => selector.split(",").includes("summary") ? [button, summary] : [button]),
      contains: (node: FocusTarget | null) => node === button || node === summary,
      focus: vi.fn(),
    });
    vi.stubGlobal("document", page); vi.stubGlobal("HTMLElement", FocusTarget);
    useDialogFocus({ current: dialog } as unknown as RefObject<HTMLElement>, true);
    const stop = hooks.effect?.();
    expect(button.focus).toHaveBeenCalledTimes(1);
    page.activeElement = summary;
    const tab = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: false });
    dialog.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(page.activeElement).toBe(button);
    const reverseTab = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: true });
    dialog.dispatchEvent(reverseTab);
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(page.activeElement).toBe(summary);
    stop?.();
    expect(previous.focus).toHaveBeenCalledTimes(1);
    const afterClose = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: false });
    dialog.dispatchEvent(afterClose);
    expect(afterClose.defaultPrevented).toBe(false);
  });
});

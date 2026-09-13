import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetadataWatcher } from "../../src/infrastructure/watcher.ts";
import type { WatchEvent, WatchHandle, WatchOptions } from "../../src/infrastructure/watcher.ts";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), watch: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

class TestWatcher extends EventEmitter {
  closed = false;
  emitClose = true;
  close = vi.fn(() => { if (this.closed) return; this.closed = true; if (this.emitClose) this.emit("close"); });
}

const directories: string[] = [];
const handles: WatchHandle[] = [];
const natives: TestWatcher[] = [];
const releaseReads: Array<() => void> = [];
const wait = (milliseconds: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

beforeEach(() => {
  vi.mocked(watch).mockImplementation(((_path: unknown, _options: unknown, listener: (event: string, filename: string | Buffer | null) => void) => {
    const native = new TestWatcher();
    native.on("change", listener);
    natives.push(native);
    return native as unknown as FSWatcher;
  }) as typeof watch);
  vi.mocked(readdir).mockImplementation(actualFs.readdir);
});

afterEach(async () => {
  for (const release of releaseReads.splice(0)) release();
  await Promise.all(handles.splice(0).map(handle => handle.dispose()));
  vi.useRealTimers();
  natives.length = 0;
  vi.clearAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(onChange: (event: WatchEvent) => void | Promise<void>, options: WatchOptions) {
  const directory = await mkdtemp(resolve(tmpdir(), "wm-watch-"));
  directories.push(directory);
  const handle = await createMetadataWatcher([{ rootId: "root", path: directory }], onChange, options);
  handles.push(handle);
  return { directory, handle, native: natives.at(-1)! };
}
function expectRetired(native: TestWatcher): void {
  expect(native.closed).toBe(true);
  expect(native.listenerCount("change")).toBe(0);
  expect(native.listenerCount("close")).toBe(0);
  // Only a state-free sink survives on the closed object for already queued errors.
  expect(native.eventNames()).toEqual(["error"]);
  expect(native.listenerCount("error")).toBe(1);
  expect(() => native.emit("error", Object.assign(new Error("fixture late native error"), { code: "EMFILE" }))).not.toThrow();
}

describe("metadata watcher lifecycle", () => {
  it("debounces changes and emits nothing after dispose", async () => {
    const events: string[] = [];
    const { directory, handle } = await setup((event) => {
      events.push(`${event.rootId}:${event.reason}`);
    }, { debounceMs: 10, fallbackIntervalMs: 20 });
    await writeFile(resolve(directory, "article.md"), "# One\n");
    await writeFile(resolve(directory, "article.md"), "# Two\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1500, interval: 20 });
    await handle.dispose();
    const count = events.length;
    await writeFile(resolve(directory, "article.md"), "# Three\n");
    await wait(80);
    expect(events).toHaveLength(count);
    await handle.dispose();
  });

  it("handles asynchronous EMFILE locally without relying on close, while fingerprint fallback still reads changes", async () => {
    const events: WatchEvent[] = [];
    const { directory, handle, native } = await setup(event => { events.push(event); }, { debounceMs: 5, fallbackIntervalMs: 15 });
    native.emitClose = false; // Node's native error path may omit the close event.
    await Promise.resolve();
    expect(() => native.emit("error", Object.assign(new Error("fixture watcher limit"), { code: "EMFILE" }))).not.toThrow();
    expect(native.close).toHaveBeenCalledTimes(1);
    expectRetired(native);
    await writeFile(resolve(directory, "after-error.md"), "# Changed after native failure\n");
    await vi.waitFor(() => expect(events.some(event => event.reason === "fingerprint")).toBe(true), { timeout: 1500, interval: 20 });
    await handle.dispose();
    const count = events.length;
    native.emit("change", "rename", "late.md");
    await writeFile(resolve(directory, "after-error.md"), "# No more events\n");
    await wait(70);
    expect(events).toHaveLength(count);
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the same fallback when native watch construction fails synchronously", async () => {
    vi.mocked(watch).mockImplementationOnce(() => { throw Object.assign(new Error("fixture unavailable"), { code: "EMFILE" }); });
    const events: WatchEvent[] = [];
    const { directory } = await setup(event => { events.push(event); }, { debounceMs: 5, fallbackIntervalMs: 15 });
    await writeFile(resolve(directory, "fallback.md"), "# Fallback\n");
    await vi.waitFor(() => expect(events.some(event => event.reason === "fingerprint")).toBe(true), { timeout: 1500, interval: 20 });
  });

  it("contains synchronous throws and asynchronous onChange rejections without disabling later notifications", async () => {
    vi.useFakeTimers();
    const changed = vi.fn<(event: WatchEvent) => void | Promise<void>>()
      .mockImplementationOnce(() => { throw new Error("fixture sync callback error"); })
      .mockRejectedValueOnce(new Error("fixture async callback rejection"))
      .mockResolvedValue(undefined);
    const { handle, native } = await setup(changed, { debounceMs: 10 });
    for (let index = 0; index < 3; index += 1) {
      native.emit("change", "change", "article.md");
      await vi.advanceTimersByTimeAsync(11);
    }
    expect(changed).toHaveBeenCalledTimes(3);
    await handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expectRetired(native);
  });

  it("cancels pending debounce/interval work and contains a callback rejection arriving after dispose", async () => {
    vi.useFakeTimers();
    let rejectCallback!: (error: Error) => void;
    const changed = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectCallback = reject; }));
    const { handle, native } = await setup(changed, { debounceMs: 10, fallbackIntervalMs: 100 });
    native.emit("change", "change", "first.md");
    await vi.advanceTimersByTimeAsync(11);
    expect(changed).toHaveBeenCalledTimes(1);
    native.emit("change", "change", "pending.md");
    await handle.dispose(); await handle.dispose();
    rejectCallback(new Error("fixture late callback rejection"));
    native.emit("change", "change", "after-dispose.md");
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(native.close).toHaveBeenCalledTimes(1);
    expectRetired(native);
  });

  it("does not overlap fingerprint scans and drains an in-flight scan on dispose without emitting its result", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const { directory, handle, native } = await setup(changed, { debounceMs: 5, fallbackIntervalMs: 20 });
    await writeFile(resolve(directory, "changed.md"), "# Pending scan\n");
    let release!: () => void;
    vi.mocked(readdir).mockClear();
    vi.mocked(readdir).mockImplementationOnce((() => new Promise<Dirent[]>((resolveRead, rejectRead) => {
      let released = false;
      release = () => { if (!released) { released = true; void actualFs.readdir(directory, { withFileTypes: true }).then(resolveRead, rejectRead); } };
      releaseReads.push(release);
    })) as unknown as typeof readdir);
    await vi.advanceTimersByTimeAsync(100);
    expect(readdir).toHaveBeenCalledTimes(1);
    let disposed = false;
    const disposing = handle.dispose().then(() => { disposed = true; });
    expect(handle.dispose()).toBe(handle.dispose());
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(disposed).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expectRetired(native);
    expect(vi.getTimerCount()).toBe(0);
  });
});

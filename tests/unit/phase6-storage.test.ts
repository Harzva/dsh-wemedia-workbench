import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, success } from "../../src/domain/errors.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "../../src/domain/ledger.ts";
import type { LedgerEvent } from "../../src/domain/ledger.ts";
import type { OverlayV1 } from "../../src/domain/schema.ts";
import { acquireFileCommitLock } from "../../src/infrastructure/fileCommitLock.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { IsolatedNotifier, noOpNotifier } from "../../src/infrastructure/localNotifier.ts";
import { createEmptyOverlay, FileOverlayRepository } from "../../src/infrastructure/overlayRepository.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import type { Notification } from "../../src/ports/notifier.ts";

const directories: string[] = [];
async function temporary(): Promise<string> { const path = await mkdtemp(resolve(tmpdir(), "wm-p6-storage-")); directories.push(path); return path; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const event = (overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({ schemaVersion: LEDGER_EVENT_SCHEMA_VERSION, eventId: "event:first", eventKey: "key:first", occurredAt: "2026-09-08T01:00:00Z", contentRef: "wmc:550e8400-e29b-41d4-a716-446655440000", channel: "x", action: "publish", outcome: "succeeded", sideEffect: "remote_publish", evidence: { adapter: "fixture", code: "OK" }, ...overrides });
const notification: Notification = { kind: "job_completed", title: "任务完成", safeMessage: "本地任务已完成" };

describe("Phase 6 overlay and transaction fault boundaries", () => {
  it("keeps the CAS exclusive across two repository instances", async () => {
    const path = resolve(await temporary(), "overlay.json");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolveStarted => { entered = resolveStarted; });
    const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
    const first = new FileOverlayRepository(path, { beforeRename: async () => { entered(); await held; } });
    const second = new FileOverlayRepository(path);
    const firstSave = first.save({ ...createEmptyOverlay(), extensions: { writer: "first" } }, 0);
    await started;
    const secondSave = second.save({ ...createEmptyOverlay(), extensions: { writer: "second" } }, 0);
    release();
    expect(await firstSave).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(await secondSave).toMatchObject({ ok: false, error: { code: "IDENTITY_CONFLICT" } });
    expect(await second.load()).toMatchObject({ ok: true, value: { revision: 1, extensions: { writer: "first" } } });
    expect((await readdir(resolve(path, ".."))).some(name => name.endsWith(".lock"))).toBe(false);
  });
  it("rejects invalid overlay updates without poisoning a healthy repository", async () => {
    const path = resolve(await temporary(), "overlay.json"); const repository = new FileOverlayRepository(path);
    await repository.save(createEmptyOverlay(), 0); const bytes = await readFile(path, "utf8");
    const invalid = { ...createEmptyOverlay(), contentBindings: { broken: "not-a-content-ref" } } as unknown as OverlayV1;
    expect((await repository.save(invalid, 1)).ok).toBe(false);
    expect((await repository.save(createEmptyOverlay(), Number.MAX_SAFE_INTEGER)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(bytes); expect(repository.mode).toBe("read_write");
    expect((await repository.save(createEmptyOverlay(), 1)).ok).toBe(true);
  });
  it("captures the submitted overlay before it waits for its commit lock", async () => {
    const path = resolve(await temporary(), "overlay.json"); const held = await acquireFileCommitLock(path); if (!held.ok) throw Error("fixture lock");
    const submitted = createEmptyOverlay(); submitted.extensions.label = "previewed";
    const result = new FileOverlayRepository(path).save(submitted, 0); submitted.extensions.label = "mutated";
    await held.value.release();
    expect(await result).toMatchObject({ ok: true, value: { extensions: { label: "previewed" } } });
  });
  it("does not replay a partially applied transaction or permit revision mutation to bypass CAS", async () => {
    const directory = await temporary(), path = resolve(directory, "overlay.json"), artifact = resolve(directory, "new-version.txt");
    const writer = new FileOverlayRepository(path), competing = new FileOverlayRepository(path), store = new WorkbenchStore(writer);
    const change = vi.fn(async (state: OverlayV1) => {
      await writeFile(artifact, "independent prepared artifact", { flag: "wx" });
      await competing.save({ ...createEmptyOverlay(), extensions: { committed: "other writer" } }, 0);
      state.revision = 1; state.extensions.pointer = "new-version.txt";
    });
    await expect(store.update(change)).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    expect(change).toHaveBeenCalledTimes(1);
    expect(await readFile(artifact, "utf8")).toBe("independent prepared artifact");
    expect(await writer.load()).toMatchObject({ ok: true, value: { revision: 1, extensions: { committed: "other writer" } } });
    expect(JSON.stringify(await writer.load())).not.toContain("new-version.txt");
  });
  it.each(["", "legacy owner", '{"schema":"wemedia.commit-lock/v1","pid":1}'])("preserves unknown or legacy locks and bounds the wait: %s", async contents => {
    const path = resolve(await temporary(), "overlay.json"); await writeFile(`${path}.lock`, contents);
    const result = await new FileOverlayRepository(path).save(createEmptyOverlay(), 0);
    expect(result).toMatchObject({ ok: false, error: { code: "IDENTITY_CONFLICT" } });
    expect(JSON.stringify(result)).not.toContain(path); expect(await readFile(`${path}.lock`, "utf8")).toBe(contents);
  });
  it("releases only its original lock when the path was replaced", async () => {
    const path = resolve(await temporary(), "ledger.jsonl"); const lock = await acquireFileCommitLock(path); if (!lock.ok) throw Error("fixture lock");
    await unlink(`${path}.lock`); await writeFile(`${path}.lock`, "replacement owner");
    await lock.value.release(); await lock.value.release();
    expect(await readFile(`${path}.lock`, "utf8")).toBe("replacement owner");
  });
});

describe("Phase 6 append-only ledger matrix", () => {
  it("separates a valid EOF record before the next append", async () => {
    const path = resolve(await temporary(), "ledger.jsonl"); const first = event(), second = event({ eventId: "event:second", eventKey: "key:second" });
    await writeFile(path, JSON.stringify(first)); const ledger = new FileLedgerRepository(path);
    expect((await ledger.append(second)).ok).toBe(true);
    expect(await ledger.snapshot()).toEqual({ ok: true, value: { events: [first, second], issues: [] } });
    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines).toHaveLength(3); expect(lines[0]).toBe(JSON.stringify(first)); expect(JSON.parse(lines[1]!)).toEqual(second); expect(lines[2]).toBe("");
  });
  it.each([
    { schemaVersion: "unknown" }, { contentRef: "invalid" }, { outcome: "invented" }, { sideEffect: "write" }, { occurredAt: "not-a-date" }, { evidence: { adapter: "fixture" } },
  ])("rejects an invalid event before touching the ledger: %j", async invalid => {
    const path = resolve(await temporary(), "ledger.jsonl"); const ledger = new FileLedgerRepository(path);
    expect((await ledger.append({ ...event(), ...invalid } as LedgerEvent)).ok).toBe(false);
    expect(await readdir(resolve(path, ".."))).toEqual([]);
  });
  it("serializes two independent writers and preserves identical retries", async () => {
    const path = resolve(await temporary(), "ledger.jsonl"); const first = new FileLedgerRepository(path), second = new FileLedgerRepository(path);
    const results = await Promise.all([first.append(event()), second.append(event({ eventId: "retry", occurredAt: "2026-09-08T01:01:00Z" }))]);
    expect(results.every(result => result.ok)).toBe(true);
    const snapshot = await first.snapshot(); expect(snapshot).toMatchObject({ ok: true, value: { events: [expect.objectContaining({ eventKey: "key:first" })], issues: [] } });
  });
  it("refuses an event key reused for a different result and an ID reused for another key", async () => {
    const path = resolve(await temporary(), "ledger.jsonl"); const ledger = new FileLedgerRepository(path); await ledger.append(event());
    const before = await readFile(path, "utf8");
    expect(await ledger.append(event({ eventId: "retry", outcome: "failed" }))).toMatchObject({ ok: false, error: { code: "IDENTITY_CONFLICT" } });
    expect(await ledger.append(event({ eventKey: "another-key" }))).toMatchObject({ ok: false, error: { code: "IDENTITY_CONFLICT" } });
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it.each(["{damaged", "{damaged\n", `${JSON.stringify(event())}\n`])("preserves corrupt tails or duplicate evidence without appending: %s", async tail => {
    const path = resolve(await temporary(), "ledger.jsonl"), bytes = `${JSON.stringify(event())}\n${tail}`; await writeFile(path, bytes);
    const result = await new FileLedgerRepository(path).append(event({ eventId: "second", eventKey: "second" }));
    expect(result.ok).toBe(false); expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await readdir(resolve(path, ".."))).some(name => name.endsWith(".lock"))).toBe(false);
  });
  it("returns a safe failure when the lock directory is unavailable", async () => {
    const directory = await temporary(); await writeFile(resolve(directory, "not-a-directory"), "existing");
    const result = await new FileLedgerRepository(resolve(directory, "not-a-directory", "ledger.jsonl")).append(event());
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(directory);
  });
});

describe("Phase 6 optional notifications", () => {
  it("defaults to a no-op without scheduling any work", async () => {
    expect(await noOpNotifier.notify(notification, new AbortController().signal)).toEqual(success(undefined));
    expect(await new IsolatedNotifier().notify(notification, new AbortController().signal)).toEqual(success(undefined));
  });
  it.each([false, true])("contains rejected and thrown delegates without their private messages: %s", async throws => {
    const notifier = new IsolatedNotifier({ notify: async () => { if (throws) throw Error("private notifier state"); return failure("SCHEMA_INVALID_VALUE", "private notifier state"); } });
    const result = await notifier.notify(notification, new AbortController().signal);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("private notifier state");
  });
  it("bounds an unresponsive delegate and signals cancellation without changing business state", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const notifier = new IsolatedNotifier({ notify: async (_message, current) => { signal = current; return new Promise(() => undefined); } }, 10);
    const delivery = notifier.notify(notification, new AbortController().signal); await vi.advanceTimersByTimeAsync(10);
    expect(await delivery).toMatchObject({ ok: false, error: { safeMessage: "notification timed out" } });
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not invoke a delegate after cancellation and cleans up completed deliveries", async () => {
    vi.useFakeTimers(); const notify = vi.fn(async () => success(undefined)); const notifier = new IsolatedNotifier({ notify });
    const controller = new AbortController(); controller.abort();
    expect((await notifier.notify(notification, controller.signal)).ok).toBe(false); expect(notify).not.toHaveBeenCalled();
    expect(await notifier.notify(notification, new AbortController().signal)).toEqual(success(undefined)); expect(notify).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("observes cancellation before a scheduled delegate starts", async () => {
    vi.useFakeTimers(); const notify = vi.fn(async () => success(undefined)); const controller = new AbortController();
    const result = new IsolatedNotifier({ notify }).notify(notification, controller.signal); controller.abort();
    expect((await result).ok).toBe(false); expect(notify).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

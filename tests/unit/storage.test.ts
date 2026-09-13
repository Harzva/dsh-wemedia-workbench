import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LedgerEvent } from "../../src/domain/ledger.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "../../src/domain/ledger.ts";
import { INDEX_CACHE_SCHEMA_VERSION } from "../../src/domain/schema.ts";
import { FileIndexCacheRepository } from "../../src/infrastructure/indexCacheRepository.ts";
import { deduplicateLedgerEvents, projectLegacyEvents, readLegacyLedger } from "../../src/infrastructure/legacyLedgerReader.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import { createEmptyOverlay, FileOverlayRepository } from "../../src/infrastructure/overlayRepository.ts";

const temporaryDirectories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "wm-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
    eventId: "event-1",
    eventKey: "fnv1a64:0000000000000001",
    occurredAt: "2026-08-31T00:00:00.000Z",
    contentRef: "wmc:550e8400-e29b-41d4-a716-446655440000",
    channel: "x",
    action: "publish",
    outcome: "succeeded",
    sideEffect: "remote_publish",
    evidence: { adapter: "fixture", code: "published" },
    ...overrides,
  };
}

describe("overlay CAS and atomic persistence", () => {
  it("serializes concurrent saves and rejects a stale expected revision", async () => {
    const directory = await temporary();
    const repository = new FileOverlayRepository(resolve(directory, "overlay.v1.json"));
    const initial = createEmptyOverlay();
    const first = await repository.save(initial, 0);
    expect(first).toMatchObject({ ok: true, value: { revision: 1 } });
    const [left, right] = await Promise.all([
      repository.save({ ...initial, revision: 1, extensions: { writer: "left" } }, 1),
      repository.save({ ...initial, revision: 1, extensions: { writer: "right" } }, 1),
    ]);
    expect([left.ok, right.ok].sort()).toEqual([false, true]);
    expect((await repository.load())).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it("preserves the last committed overlay when an atomic rename is interrupted", async () => {
    const directory = await temporary();
    const path = resolve(directory, "overlay.v1.json");
    const healthy = new FileOverlayRepository(path);
    const first = await healthy.save(createEmptyOverlay(), 0);
    expect(first.ok).toBe(true);
    const before = await readFile(path, "utf8");
    const interrupted = new FileOverlayRepository(path, { beforeRename: async () => { throw new Error("fixture interruption"); } });
    const result = await interrupted.save({ ...createEmptyOverlay(), revision: 1, extensions: { changed: true } }, 1);
    expect(result.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("enters read-only mode without rewriting a corrupt overlay", async () => {
    const directory = await temporary();
    const path = resolve(directory, "overlay.v1.json");
    await writeFile(path, "{broken");
    const repository = new FileOverlayRepository(path);
    expect((await repository.load()).ok).toBe(false);
    expect(repository.mode).toBe("read_only");
    expect((await repository.save(createEmptyOverlay(), 0)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});

describe("disposable index cache", () => {
  it("keeps a trusted non-empty snapshot when a replacement is empty", async () => {
    const directory = await temporary();
    const repository = new FileIndexCacheRepository(resolve(directory, "index-cache.v1.json"));
    const source = { recordId: "record", rootId: "root", relativePath: "a.md", digest: "digest", title: "A", sourceIds: [] };
    expect((await repository.replace({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION, generationId: "g1", builtAt: "2026-08-31T00:00:00.000Z", sources: [source] })).ok).toBe(true);
    expect((await repository.replace({ schemaVersion: INDEX_CACHE_SCHEMA_VERSION, generationId: "g2", builtAt: "2026-08-31T00:01:00.000Z", sources: [] })).ok).toBe(false);
    expect(await repository.load()).toMatchObject({ ok: true, value: { generationId: "g1", sources: [source] } });
  });

  it("treats an incompatible cache as disposable", async () => {
    const directory = await temporary();
    const path = resolve(directory, "index-cache.v1.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "wemedia.index-cache/v2", generationId: "g", builtAt: "now", sources: [] }));
    const repository = new FileIndexCacheRepository(path);
    expect(await repository.load()).toEqual({ ok: true, value: null });
    expect((await repository.discard()).ok).toBe(true);
  });
});

describe("append-only ledger and legacy import", () => {
  it("appends one fsynced line and returns the original event for an idempotent retry", async () => {
    const directory = await temporary();
    const path = resolve(directory, "ledger.v1.jsonl");
    const repository = new FileLedgerRepository(path);
    const first = event();
    expect(await repository.append(first)).toEqual({ ok: true, value: first });
    expect(await repository.append(event({ eventId: "retry-event" }))).toEqual({ ok: true, value: first });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("isolates a damaged tail and refuses to append after it", async () => {
    const directory = await temporary();
    const path = resolve(directory, "ledger.v1.jsonl");
    await writeFile(path, `${JSON.stringify(event())}\n{damaged`);
    const repository = new FileLedgerRepository(path);
    const snapshot = await repository.snapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { events: [event()], issues: [{ line: 2, code: "damaged_tail" }] } });
    expect((await repository.append(event({ eventId: "event-2", eventKey: "fnv1a64:0000000000000002" }))).ok).toBe(false);
    expect(await readFile(path, "utf8")).toContain("{damaged");
  });

  it("preserves append order while projection evidence can be sorted independently", async () => {
    const directory = await temporary();
    const path = resolve(directory, "ledger.v1.jsonl");
    const repository = new FileLedgerRepository(path);
    const later = event({ eventId: "later", eventKey: "fnv1a64:0000000000000003", occurredAt: "2026-08-31T02:00:00.000Z" });
    const earlier = event({ eventId: "earlier", eventKey: "fnv1a64:0000000000000004", occurredAt: "2026-08-31T01:00:00.000Z" });
    expect((await repository.append(later)).ok).toBe(true);
    expect((await repository.append(earlier)).ok).toBe(true);
    const snapshot = await repository.snapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { events: [{ eventId: "later" }, { eventId: "earlier" }], issues: [] } });
  });

  it("normalizes legacy records and deduplicates legacy/new events by eventKey", async () => {
    const directory = await temporary();
    const path = resolve(directory, "publishing-ledger.jsonl");
    await writeFile(path, `${JSON.stringify({ title: "Legacy", topic_key: "topic", source_ids: ["doi:10.1000/example"], published_at: "2026-08-30T00:00:00.000Z", platforms: { x: { status: "published", id: "tweet-1", url: "https://x.com/example/status/123456" } } })}\n`);
    const result = await readLegacyLedger(path);
    expect(result).toMatchObject({ ok: true, value: { records: [{ title: "Legacy", topicKey: "topic" }], issues: [] } });
    if (!result.ok) return;
    const projected = projectLegacyEvents(result.value.records[0]!, "wmc:550e8400-e29b-41d4-a716-446655440000");
    expect(projected).toHaveLength(1);
    expect(deduplicateLedgerEvents([projected[0]!, { ...projected[0]!, eventId: "new-copy" }])).toHaveLength(1);
  });

  it("does not turn blocked, draft, unverified or undated legacy platforms into published events", () => {
    const common = { legacyKey: "legacy", line: 1, sourceIds: [], occurredAt: "2026-08-30T00:00:00.000Z", publishedAt: "2026-08-30T00:00:00.000Z" };
    const ref = "wmc:550e8400-e29b-41d4-a716-446655440000" as const;
    for (const value of [{ status: "drafted", url: "https://zhuanlan.zhihu.com/p/123" }, { status: "blocked_auth", url: "https://zhuanlan.zhihu.com/p/123" }, { status: "published", url: "https://attacker.invalid/post" }, { status: "published", id: "123" }, "https://zhuanlan.zhihu.com/p/123"]) {
      expect(projectLegacyEvents({ ...common, platforms: { zhihu: value } }, ref)).toEqual([]);
    }
    expect(projectLegacyEvents({ legacyKey: "legacy", line: 1, sourceIds: [], platforms: { zhihu: { status: "published", url: "https://zhuanlan.zhihu.com/p/123" } } }, ref)).toEqual([]);
  });

  it("preserves created_at for compatibility without treating it as a publication time", async () => {
    const directory = await temporary();
    const path = resolve(directory, "publishing-ledger.jsonl");
    await writeFile(path, JSON.stringify({ title: "Created earlier", created_at: "2026-08-01T00:00:00Z", platforms: { zhihu: { status: "published", url: "https://zhuanlan.zhihu.com/p/123" } } }));
    const result = await readLegacyLedger(path);
    expect(result).toMatchObject({ ok: true, value: { records: [{ occurredAt: "2026-08-01T00:00:00Z" }] } });
    if (!result.ok) return;
    expect(result.value.records[0]?.publishedAt).toBeUndefined();
    expect(projectLegacyEvents(result.value.records[0]!, "wmc:550e8400-e29b-41d4-a716-446655440000")).toEqual([]);
  });
});

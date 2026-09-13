import { describe, expect, it } from "vitest";

import { ContentService } from "../../src/application/contentService.ts";
import { affectedIdentityComponents, IdentityService, type IdentityComponent } from "../../src/application/identityService.ts";
import { IndexService } from "../../src/application/indexService.ts";
import { projectContents } from "../../src/application/projectionService.ts";
import type { SourceRecord } from "../../src/domain/content.ts";
import { failure, success } from "../../src/domain/errors.ts";
import type { LedgerEvent } from "../../src/domain/ledger.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "../../src/domain/ledger.ts";
import { INDEX_CACHE_SCHEMA_VERSION } from "../../src/domain/schema.ts";
import type { IndexCacheV1, OverlayV1 } from "../../src/domain/schema.ts";
import { createEmptyOverlay } from "../../src/infrastructure/overlayRepository.ts";
import type { IndexCacheRepository } from "../../src/ports/repositories.ts";

const contentRef = "wmc:550e8400-e29b-41d4-a716-446655440000" as const;

function source(recordId: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    recordId,
    rootId: "legacy-root",
    relativePath: `${recordId}.md`,
    digest: `digest-${recordId}`,
    title: `Title ${recordId}`,
    sourceIds: [],
    recordKind: "markdown",
    canonicalArtifactKey: `legacy-root:${recordId}.md`,
    ...overrides,
  };
}

function component(overrides: Partial<IdentityComponent> = {}): IdentityComponent {
  return {
    contentRef,
    sourceRecordIds: ["record-a"],
    identitySetDigest: "fnv1a64:0000000000000001",
    conflicts: [],
    ...overrides,
  };
}

function publishedEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
    eventId: "event-published",
    eventKey: "fnv1a64:0000000000000002",
    occurredAt: "2026-08-31T00:00:00.000Z",
    contentRef,
    channel: "x",
    action: "publish",
    outcome: "succeeded",
    sideEffect: "remote_publish",
    evidence: { adapter: "fixture", code: "published" },
    remote: { remoteId: "remote-1", url: "https://example.invalid/post/1" },
    ...overrides,
  };
}

describe("ledger/overlay recovery and read projection", () => {
  it("replays ledger truth after an overlay failure and clears reconciliation after catch-up", () => {
    const records = [source("record-a")];
    const event = publishedEvent();
    const beforeCatchUp = projectContents({ components: [component()], sources: records, ledgerEvents: [event], overlay: createEmptyOverlay() });
    expect(beforeCatchUp[0]?.channels.x).toMatchObject({ state: "published", evidenceEventId: event.eventId, reconcileRequired: true });
    expect(beforeCatchUp[0]?.channels.wechat.state).toBe("not_started");

    const overlay: OverlayV1 = {
      ...createEmptyOverlay(),
      variantState: { [`${contentRef}:x`]: { state: "published", lastEventId: event.eventId } },
    };
    const caughtUp = projectContents({ components: [component()], sources: records, ledgerEvents: [event], overlay });
    expect(caughtUp[0]?.channels.x).toMatchObject({ state: "published", reconcileRequired: false });
  });

  it("does not treat overlay-only remote completion as published evidence", () => {
    const overlay: OverlayV1 = {
      ...createEmptyOverlay(),
      variantState: { [`${contentRef}:x`]: { state: "published", remoteId: "untrusted" } },
    };
    const projected = projectContents({ components: [component()], sources: [source("record-a")], ledgerEvents: [], overlay });
    expect(projected[0]?.channels.x).toMatchObject({ state: "not_started", reconcileRequired: false });
    expect(projected[0]?.channels.x.evidenceEventId).toBeUndefined();
  });

  it("keeps conflict evidence and exposes only safe artifact paths through detail/search", () => {
    const projected = projectContents({
      components: [component({ conflicts: [{ leftRecordId: "record-a", rightRecordId: "record-b", evidenceCodes: ["duplicate_explicit_id"] }] })],
      sources: [source("record-a", { title: "Alpha", sourceIds: ["doi:example"] })],
      ledgerEvents: [],
      overlay: createEmptyOverlay(),
    });
    const service = new ContentService(() => projected);
    const detail = service.inspect(contentRef);
    expect(detail).toMatchObject({ ok: true, value: { conflicts: [{ evidenceCodes: ["duplicate_explicit_id"] }], artifacts: [{ rootId: "legacy-root", relativePath: "record-a.md" }] } });
    expect(JSON.stringify(detail)).not.toContain("/Volumes/");
    expect(service.search({ query: "doi:example" }, 10)).toMatchObject({ ok: true, value: { total: 1, items: [{ title: "Alpha" }] } });
  });
});

describe("identity invalidation, cache recovery, and pagination", () => {
  it("recomputes only components affected by changed source records", () => {
    let sequence = 0;
    const identity = new IdentityService({
      uuidV4: () => `550e8400-e29b-41d4-a716-${String(++sequence).padStart(12, "0")}`,
      opaqueId: () => "fixture-id",
    });
    const resolved = identity.resolve([
      source("record-a", { topicKey: "shared" }),
      source("record-b", { topicKey: "shared" }),
      source("record-c"),
    ], createEmptyOverlay());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(new Set(resolved.value.components.map(item => item.contentRef)).size).toBe(2);
    const affected = affectedIdentityComponents(resolved.value.components, ["record-b"]);
    expect(affected).toHaveLength(1);
    expect(affected[0]?.sourceRecordIds).toEqual(["record-a", "record-b"]);
  });

  it("returns the last trusted snapshot when every root fails or empty replacement is rejected", async () => {
    let stored: IndexCacheV1 | null = {
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      generationId: "trusted",
      builtAt: "2026-08-31T00:00:00.000Z",
      sources: [source("record-a")],
    };
    const cache: IndexCacheRepository = {
      load: async () => success(stored),
      replace: async (value) => {
        if (stored !== null && stored.sources.length > 0 && value.sources.length === 0) return failure("SCHEMA_INVALID_VALUE", "empty replacement rejected");
        stored = value;
        return success(undefined);
      },
      discard: async () => { stored = null; return success(undefined); },
    };
    const failed = new IndexService({ scan: async () => ({ sources: [], successfulRootIds: [], issues: [{ code: "ROOT_FAILED", rootId: "legacy-root", relativePath: "", safeMessage: "unavailable" }] }) }, cache);
    expect(await failed.refresh("g2", "2026-08-31T00:01:00.000Z")).toMatchObject({ ok: true, value: { stale: true, sources: [{ recordId: "record-a" }] } });

    const empty = new IndexService({ scan: async () => ({ sources: [], successfulRootIds: ["legacy-root"], issues: [] }) }, cache);
    expect(await empty.refresh("g3", "2026-08-31T00:02:00.000Z")).toMatchObject({ ok: true, value: { stale: true, sources: [{ recordId: "record-a" }] } });
  });

  it("uses deterministic query-bound cursors for stable pagination", () => {
    const items = ["Gamma", "Alpha", "Beta"].map((title, index) => ({
      ...projectContents({
        components: [component({ contentRef: `wmc:550e8400-e29b-41d4-a716-44665544000${index}` as typeof contentRef, sourceRecordIds: [`record-${index}`] })],
        sources: [source(`record-${index}`, { title })],
        ledgerEvents: [],
        overlay: createEmptyOverlay(),
      })[0]!,
    }));
    const service = new ContentService(() => items);
    const first = service.search({}, 2);
    expect(first).toMatchObject({ ok: true, value: { total: 3, items: [{ title: "Alpha" }, { title: "Beta" }] } });
    if (!first.ok || first.value.nextCursor === undefined) return;
    expect(service.search({}, 2, first.value.nextCursor)).toMatchObject({ ok: true, value: { items: [{ title: "Gamma" }] } });
    expect(service.search({ query: "Alpha" }, 2, first.value.nextCursor).ok).toBe(false);
  });
});

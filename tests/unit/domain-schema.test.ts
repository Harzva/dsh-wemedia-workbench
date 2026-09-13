import { describe, expect, it } from "vitest";

import type {
  ActionIntent,
  AdapterResult,
  CapabilityReport,
  GateReport,
  RemoteAnswer,
} from "../../src/domain/capability.ts";
import type { ContentItem } from "../../src/domain/content.ts";
import type { Job } from "../../src/domain/job.ts";
import type { JsonValue } from "../../src/domain/json.ts";
import { isJsonValue } from "../../src/domain/json.ts";
import type { LedgerEvent } from "../../src/domain/ledger.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "../../src/domain/ledger.ts";
import { formatContentRef, parseContentRef } from "../../src/domain/primitives.ts";
import {
  CONTENT_SCHEMA_VERSION,
  INDEX_CACHE_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  decodeContentManifest,
  decodeIndexCache,
  decodeLedgerEvent,
  decodeOverlay,
} from "../../src/domain/schema.ts";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const contentRef = `wmc:${uuid}` as const;

function roundTrip<T extends JsonValue>(value: T): T {
  expect(isJsonValue(value)).toBe(true);
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("versioned pure decoders", () => {
  it("decodes content and preserves unknown fields in extensions", () => {
    const result = decodeContentManifest({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      contentId: uuid,
      title: "A title",
      sourceIds: ["doi:10.1000/example"],
      canonicalDraft: "draft.md",
      variants: { wechat: "variants/wechat.md" },
      extensions: { producer: "fixture" },
      futureFlag: { enabled: true },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        contentId: uuid,
        title: "A title",
        sourceIds: ["doi:10.1000/example"],
        canonicalDraft: "draft.md",
        variants: { wechat: "variants/wechat.md" },
        extensions: { producer: "fixture", futureFlag: { enabled: true } },
      },
    });
  });

  it("decodes overlay and preserves unknown fields in extensions", () => {
    const result = decodeOverlay({
      schemaVersion: OVERLAY_SCHEMA_VERSION,
      revision: 2,
      contentBindings: { record: contentRef },
      manualDecisions: [],
      variantState: {},
      jobs: {},
      futureOverlayField: [1, 2, 3],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.extensions.futureOverlayField).toEqual([1, 2, 3]);
  });

  it("tolerates unknown ledger and cache fields", () => {
    const ledger = decodeLedgerEvent({
      schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
      eventId: "event-1",
      eventKey: "fnv1a64:0000000000000001",
      occurredAt: "2026-08-30T00:00:00.000Z",
      contentRef,
      channel: "x",
      action: "publish",
      outcome: "succeeded",
      sideEffect: "remote_publish",
      evidence: { adapter: "fixture", code: "published" },
      futureLedgerField: true,
    });
    const cache = decodeIndexCache({
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      generationId: "generation-1",
      builtAt: "2026-08-30T00:00:00.000Z",
      sources: [],
      futureCacheField: "ignored",
    });
    expect(ledger.ok).toBe(true);
    expect(cache).toEqual({
      ok: true,
      value: {
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        generationId: "generation-1",
        builtAt: "2026-08-30T00:00:00.000Z",
        sources: [],
      },
    });
  });

  it.each([
    [decodeContentManifest, { schemaVersion: "wemedia.content/v2" }],
    [decodeOverlay, { schemaVersion: "wemedia.overlay/v2" }],
    [decodeLedgerEvent, { schemaVersion: "wemedia.ledger-event/v2" }],
    [decodeIndexCache, { schemaVersion: "wemedia.index-cache/v2" }],
  ] as const)("rejects incompatible schema versions", (decoder, value) => {
    const result = decoder(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCHEMA_VERSION_UNSUPPORTED");
  });
});

describe("content reference and JSON DTO contracts", () => {
  it("formats and parses only UUIDv4 content references", () => {
    expect(formatContentRef(uuid)).toEqual({ ok: true, value: contentRef });
    expect(parseContentRef(contentRef)).toEqual({ ok: true, value: uuid });
    expect(formatContentRef("550e8400-e29b-11d4-a716-446655440000")).toMatchObject({
      ok: false,
      error: { code: "UUID_V4_INVALID" },
    });
    expect(parseContentRef(`wmc:550e8400-e29b-11d4-a716-446655440000`)).toMatchObject({
      ok: false,
      error: { code: "CONTENT_REF_INVALID" },
    });
  });

  it("round-trips every public Phase 2 DTO as canonical JSON data", () => {
    const content: ContentItem = {
      schemaVersion: CONTENT_SCHEMA_VERSION,
      contentRef,
      title: "A title",
      aliases: [],
      sourceIds: [],
      sources: [],
      assets: [],
      variants: {},
      overallState: "discovered",
      identity: { identitySetDigest: "fnv1a64:0000000000000000", sourceRecordIds: [], evidenceCodes: [] },
      conflicts: [],
    };
    const capability: CapabilityReport = {
      channel: "x",
      adapter: "fixture",
      configured: "missing",
      actions: [{
        action: "publish",
        status: "unsupported",
        reasonCode: "not_configured",
        safeMessage: "Not configured",
        checkedAt: "2026-08-30T00:00:00.000Z",
      }],
    };
    const gate: GateReport = { status: "pass", inputDigest: "digest", issues: [] };
    const intent: ActionIntent = {
      intentId: "intent-1",
      generationId: "generation-1",
      contentRef,
      channel: "x",
      action: "publish",
      sideEffect: "remote_publish",
      targetSummary: "X account is configured",
      inputDigest: "digest",
      expectedChanges: [],
      blockingGateCodes: [],
      expiresAt: "2026-08-30T00:05:00.000Z",
      approved: false,
    };
    const adapter: AdapterResult = {
      ok: true,
      code: "prepared",
      phase: "prepare",
      channel: "x",
      sideEffect: "local_write",
      artifacts: [],
      issues: [],
      retryable: false,
    };
    const job: Job = {
      jobId: "job-1",
      generationId: "generation-1",
      action: "prepare",
      channel: "x",
      sideEffect: "local_write",
      status: "queued",
      progress: { current: 0 },
      safeMessage: "Queued",
      createdAt: "2026-08-30T00:00:00.000Z",
      retryable: false,
      artifactRefs: [],
    };
    const ledger: LedgerEvent = {
      schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
      eventId: "event-1",
      eventKey: "fnv1a64:0000000000000001",
      occurredAt: "2026-08-30T00:00:00.000Z",
      contentRef,
      action: "prepare",
      outcome: "succeeded",
      sideEffect: "local_write",
      evidence: { adapter: "fixture", code: "prepared" },
    };
    const remote: RemoteAnswer<Job> = { ok: true, value: job, revision: 1 };
    for (const value of [content, capability, gate, intent, adapter, job, ledger, remote]) {
      expect(roundTrip(value)).toEqual(value);
    }
  });
});

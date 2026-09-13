import { readFile } from "node:fs/promises";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { fnv1a64 } from "../domain/identity.ts";
import { isJsonObject } from "../domain/json.ts";
import type { JsonObject, JsonValue } from "../domain/json.ts";
import { createLedgerEventKey, LEDGER_EVENT_SCHEMA_VERSION } from "../domain/ledger.ts";
import type { LedgerEvent } from "../domain/ledger.ts";
import { isChannel } from "../domain/primitives.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";
import { decodeLedgerEvent } from "../domain/schema.ts";
import { hasExplicitPublishedStatus, publicationTimestamp, safePublicationUrl } from "./localPublications.ts";

export interface LegacyLedgerRecord {
  legacyKey: string;
  line: number;
  title?: string;
  topicKey?: string;
  sourceIds: string[];
  occurredAt?: string;
  /** Explicit event/publication time; created_at is not publication evidence. */
  publishedAt?: string;
  platforms: Partial<Record<Channel, JsonValue>>;
}

export interface LegacyLedgerReadResult {
  records: LegacyLedgerRecord[];
  nativeEvents: LedgerEvent[];
  issues: Array<{ line: number; code: "invalid_json" | "invalid_record" }>;
}

function legacyFailure<T>(safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage);
}

function stringArray(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizePlatforms(value: JsonValue | undefined): Partial<Record<Channel, JsonValue>> {
  if (!isJsonObject(value)) return {};
  const output: Partial<Record<Channel, JsonValue>> = {};
  for (const [key, item] of Object.entries(value)) if (isChannel(key)) output[key] = item;
  return output;
}

export async function readLegacyLedger(absolutePath: string): Promise<DomainResult<LegacyLedgerReadResult>> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return legacyFailure("legacy ledger could not be read");
  }
  const records: LegacyLedgerRecord[] = [];
  const nativeEvents: LedgerEvent[] = [];
  const issues: LegacyLedgerReadResult["issues"] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      issues.push({ line: index + 1, code: "invalid_json" });
      continue;
    }
    const native = decodeLedgerEvent(value);
    if (native.ok) {
      nativeEvents.push(native.value);
      continue;
    }
    if (!isJsonObject(value)) {
      issues.push({ line: index + 1, code: "invalid_record" });
      continue;
    }
    const title = typeof value.title === "string" ? value.title : undefined;
    const topicKeyValue = value.topic_key ?? value.topicKey;
    const topicKey = typeof topicKeyValue === "string" ? topicKeyValue : undefined;
    const sourceIds = stringArray(value.source_ids ?? value.sourceIds);
    const occurredAtValue = value.occurred_at ?? value.published_at ?? value.created_at;
    const occurredAt = typeof occurredAtValue === "string" ? occurredAtValue : undefined;
    const publishedAtValue = value.published_at ?? value.occurred_at;
    const publishedAt = typeof publishedAtValue === "string" ? publishedAtValue : undefined;
    const platforms = normalizePlatforms(value.platforms);
    if (title === undefined && topicKey === undefined && sourceIds.length === 0) {
      issues.push({ line: index + 1, code: "invalid_record" });
      continue;
    }
    const legacyKey = fnv1a64(JSON.stringify({ title, topicKey, sourceIds: [...sourceIds].sort(), platforms }));
    records.push({
      legacyKey,
      line: index + 1,
      sourceIds,
      platforms,
      ...(title === undefined ? {} : { title }),
      ...(topicKey === undefined ? {} : { topicKey }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return success({ records, nativeEvents, issues });
}

export function projectLegacyEvents(record: LegacyLedgerRecord, contentRef: ContentRef): LedgerEvent[] {
  return Object.entries(record.platforms).flatMap(([channelName, value]) => {
    if (!isChannel(channelName) || !isJsonObject(value) || !hasExplicitPublishedStatus(value.status)) return [];
    const channel = channelName as Channel;
    const url = safePublicationUrl(value.replacement_url, channel) ?? safePublicationUrl(value.url, channel);
    const occurredAt = publicationTimestamp(value.published_at) ?? publicationTimestamp(record.publishedAt);
    // The legacy event schema requires a real event time; unknown is not 1970.
    if (!url || !occurredAt) return [];
    const remote = { url };
    const externalIdempotencyKey = url;
    const eventKey = createLedgerEventKey({
      contentRef,
      channel,
      action: "publish",
      inputDigest: record.legacyKey,
      ...(externalIdempotencyKey === undefined ? {} : { externalIdempotencyKey }),
    });
    return [{
      schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
      eventId: `legacy:${fnv1a64(`${record.legacyKey}:${channel}`)}`,
      eventKey,
      occurredAt,
      contentRef,
      channel,
      action: "publish",
      outcome: "succeeded",
      sideEffect: "remote_publish",
      evidence: { adapter: "legacy-ledger", code: "legacy_published" },
      ...(Object.keys(remote).length === 0 ? {} : { remote }),
    } satisfies LedgerEvent];
  });
}

export function deduplicateLedgerEvents(events: readonly LedgerEvent[]): LedgerEvent[] {
  const byKey = new Map<string, LedgerEvent>();
  for (const event of [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))) {
    if (!byKey.has(event.eventKey)) byKey.set(event.eventKey, event);
  }
  return [...byKey.values()].sort((left, right) => left.eventKey.localeCompare(right.eventKey));
}

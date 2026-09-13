import type { SideEffectLevel } from "./capability.ts";
import { canonicalJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { fnv1a64 } from "./identity.ts";
import type { Channel, ContentRef } from "./primitives.ts";

export const LEDGER_EVENT_SCHEMA_VERSION = "wemedia.ledger-event/v1" as const;

export type LedgerOutcome = "succeeded" | "failed" | "cancelled" | "timed_out" | "corrected";

export interface LedgerEvidence extends JsonObject {
  adapter: string;
  code: string;
  adapterVersion?: string;
}

export interface LedgerRemote extends JsonObject {
  remoteId?: string;
  url?: string;
}

export interface LedgerEvent extends JsonObject {
  schemaVersion: typeof LEDGER_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventKey: string;
  occurredAt: string;
  contentRef: ContentRef;
  action: string;
  outcome: LedgerOutcome;
  sideEffect: SideEffectLevel;
  evidence: LedgerEvidence;
  channel?: Channel;
  jobId?: string;
  artifactDigests?: string[];
  remote?: LedgerRemote;
  supersedesEventId?: string;
}

export interface LedgerEventKeyInput extends JsonObject {
  contentRef: ContentRef;
  action: string;
  inputDigest: string;
  channel?: Channel;
  externalIdempotencyKey?: string;
}

export function createLedgerEventKey(input: LedgerEventKeyInput): string {
  return fnv1a64(canonicalJson(input));
}

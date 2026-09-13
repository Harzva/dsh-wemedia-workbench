import type { JsonObject } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import type { PublicationType } from "./contentLibrary.ts";
export interface BatchPreflightEntry extends JsonObject {
  contentRef: ContentRef; publicationType: PublicationType | null; revisionDigest: string | null;
  channel: Channel; status: "pass" | "warn" | "block"; code: string; safeMessage: string; issues: string[];
}
export interface BatchPreflightResult extends JsonObject {
  schemaVersion: "wemedia.batch-preflight/v1"; results: BatchPreflightEntry[]; checkedAt: string; cancelled: boolean;
}
export type BatchPreflightRequest = { operation: "batch_preflight"; contentRefs: ContentRef[]; channels: Channel[] };

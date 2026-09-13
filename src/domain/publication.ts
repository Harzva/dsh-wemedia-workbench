import type { JsonObject } from "./json.ts";
import type { Channel } from "./primitives.ts";

export type PublicationStatus = "draft" | "ready" | "published" | "unknown";

/** A channel fact, distinct from local editing/review progress. */
export interface PublicationRecord extends JsonObject {
  channel: Channel;
  status: PublicationStatus | "failed" | "removed";
  publishedAt: string | null;
  checkedAt: string | null;
  url: string | null;
  evidence: "none" | "local_draft" | "draft_readback" | "local_receipt" | "remote_readback";
  note: string;
}

export interface PublicationSourceSummary extends JsonObject {
  available: boolean;
  checkedAt: string | null;
  counts: { ledgerRecords: number; zhihuArticles: number; xiaohongshuRecords: number };
  channels: Channel[];
  issues: string[];
}

/** A persisted result is historical evidence, never proof of the current edit. */
export function aggregatePublicationStatus(records: readonly PublicationRecord[] | undefined, fallback: PublicationStatus = "unknown"): PublicationStatus {
  if (records?.some(record => record.status === "published" && ["local_receipt", "remote_readback"].includes(record.evidence) && record.url)) return "published";
  if (fallback === "ready" || records?.some(record => record.status === "ready")) return "ready";
  if (records?.some(record => record.status === "draft" && record.evidence !== "local_draft")) return "draft";
  return fallback;
}

export function publicationStatusForWorkflow(status: string): PublicationStatus {
  if (status === "ready") return "ready";
  if (["drafting", "needs_review", "draft_verified"].includes(status)) return "draft";
  return "unknown";
}

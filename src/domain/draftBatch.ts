import type { JsonObject } from "./json.ts";
import { parseContentRef, type ContentRef } from "./primitives.ts";
import { WorkbenchFault } from "./workbenchFault.ts";

export const DRAFT_BATCH_LIMIT = 50;
export type DraftBatchScope = "selected" | "pending";
export type DraftBatchEntryStatus = "pending" | "skipped" | "blocked" | "running" | "succeeded" | "failed" | "cancelled" | "reconcile_required";

export interface DraftBatchEntry extends JsonObject {
  contentRef: ContentRef;
  title: string;
  revisionDigest: string | null;
  inputDigest: string | null;
  status: DraftBatchEntryStatus;
  code: string;
  safeMessage: string;
  jobId: string | null;
  intentId: string | null;
  targetRef: string | null;
}

export interface DraftBatchPreview extends JsonObject {
  schemaVersion: "wemedia.draft-batch-preview/v1";
  intentId: string;
  generationId: string;
  expiresAt: string;
  scope: DraftBatchScope;
  entries: DraftBatchEntry[];
  eligibleCount: number;
}

export interface DraftBatch extends JsonObject {
  schemaVersion: "wemedia.draft-batch/v1";
  batchId: string;
  generationId: string;
  status: "running" | "completed" | "stopped";
  createdAt: string;
  entries: DraftBatchEntry[];
}

export type DraftBatchRequest =
  | { operation: "preview_draft_batch"; scope: "selected"; contentRefs: ContentRef[] }
  | { operation: "preview_draft_batch"; scope: "pending"; contentRefs?: never }
  | { operation: "start_draft_batch"; intentId: string }
  | { operation: "advance_draft_batch" | "get_draft_batch" | "cancel_draft_batch"; batchId: string }
  | { operation: "list_draft_batches" };

export function decodeDraftBatchRequest(input: Record<string, unknown>): DraftBatchRequest {
  const invalid = (): never => { throw new WorkbenchFault("REQUEST_INVALID", "批量草稿请求参数无效"); };
  const operation = input.operation;
  const allowed = operation === "preview_draft_batch" ? ["operation", "scope", "contentRefs"] : operation === "start_draft_batch" ? ["operation", "intentId"] : operation === "list_draft_batches" ? ["operation"] : ["operation", "batchId"];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid();
  if (operation === "preview_draft_batch") {
    if (input.scope === "pending") {
      if ("contentRefs" in input) invalid();
      return { operation, scope: "pending" };
    }
    if (input.scope !== "selected" || !Array.isArray(input.contentRefs) || input.contentRefs.length < 1 || input.contentRefs.length > DRAFT_BATCH_LIMIT) return invalid();
    const refs = input.contentRefs.map(ref => {
      if (typeof ref !== "string") return invalid();
      const parsed = parseContentRef(ref);
      if (!parsed.ok) return invalid();
      return `wmc:${parsed.value}` as ContentRef;
    });
    if (new Set(refs).size !== refs.length) invalid();
    return { operation, scope: "selected", contentRefs: refs };
  }
  if (operation === "list_draft_batches") return { operation };
  if (operation === "start_draft_batch") {
    if (!isDraftBatchId(input.intentId)) return invalid();
    return { operation, intentId: input.intentId };
  }
  if (operation === "advance_draft_batch" || operation === "get_draft_batch" || operation === "cancel_draft_batch") {
    if (!isDraftBatchId(input.batchId)) return invalid();
    return { operation, batchId: input.batchId };
  }
  return invalid();
}

export function isDraftBatchId(value: unknown): value is string {
  return typeof value === "string" && !["__proto__", "constructor", "prototype"].includes(value) && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

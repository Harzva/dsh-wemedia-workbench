import type { WorkbenchRequest } from "../domain/workbench.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const jobOperations = new Set<WorkbenchRequest["operation"]>([
  "start_action", "get_job", "cancel_job", "create_content", "channel_start_action",
]);
const batchOperations = new Set<WorkbenchRequest["operation"]>([
  "start_draft_batch", "advance_draft_batch", "get_draft_batch", "cancel_draft_batch",
]);

/** Model-facing guidance only; the canonical DTO and execution policy stay unchanged. */
export function jobGuidance(operation: WorkbenchRequest["operation"], answer: unknown): string | undefined {
  if (!record(answer) || answer.ok !== true || !record(answer.value)) return;
  const value = answer.value;
  if (operation === "preview_draft_batch") return "Batch preview only: confirm this exact candidate list. No remote drafts or approvals have been created. Only pending entries may be queued through wemedia_start_draft_batch; skipped and blocked entries must not be replaced or forced through.";
  if (batchOperations.has(operation) && value.schemaVersion === "wemedia.draft-batch/v1") {
    if (!["running", "completed", "stopped"].includes(String(value.status))) return;
    const entries = Array.isArray(value.entries) ? value.entries : [];
    if (value.status === "stopped" && entries.some(entry => record(entry) && entry.status === "running")) return "The queue is stopped but a child job is still active. Cancellation is not rollback. Wait 15-30 seconds, then read this same batch with wemedia_get_draft_batch until its child reaches a terminal state. Do not advance the queue or issue another write; reconcile uncertain remote effects read-only.";
    if (value.status !== "running") return "The batch is stopped or completed, not necessarily all delivered. Count only succeeded entries; report skipped, blocked, failed and unconfirmed entries separately. Do not resume or retry cancelled/failed entries automatically, and do not infer formal publication.";
    if (entries.some(entry => record(entry) && entry.status === "running")) return "A child job is active. Wait 15-30 seconds, then read the same batch with wemedia_get_draft_batch. Honor its existing native approval if waiting_user; do not issue another write or stop at a progress report. Never call an alternate create tool for an entry.";
    return "The durable queue has pending work, not completion. Call wemedia_advance_draft_batch once for this same batchId; it handles one exact article through native approval. Continue serially until completed or stopped, without rewriting articles, creating substitute intents or retrying failed entries.";
  }
  if (operation === "preview_action" && record(value.intent)) {
    return "Preview only: no save or remote write has occurred. Execute only the exact reviewed intent with wemedia_start_action, honor native approval, then follow its job to a terminal state. A preview is not a saved revision or a delivered draft.";
  }
  if (!jobOperations.has(operation) || typeof value.jobId !== "string") return;
  switch (value.status) {
    case "queued":
      return "Not complete: this job is queued. Poll the same job with read-only wemedia_get_job after bounded 15-30 second waits until a terminal state; an unchanged queued status is neither a failure nor a native approval wait (queued alone does not mean approval is pending). Do not submit another write.";
    case "running":
      return "Not complete: execution has started. Poll the same job with read-only wemedia_get_job after bounded 15-30 second waits until a terminal state; an unchanged running status is neither a failure nor a native approval wait (this is not waiting_user). Do not ask for another approval. Do not submit another write or stop at a progress summary.";
    case "waiting_user":
      return "Await the existing native approval request for this exact intent. Do not replace it, approve it implicitly, or create another job. After the decision, read wemedia_get_job again; approval alone is not completion.";
    case "succeeded":
      if (value.action === "create_draft" || value.action === "update_draft") {
        return "Verify delivery before counting it: require resultCode WECHAT_DRAFT_VERIFIED, then wemedia_inspect_content must show exactly one target whose verifiedRevision equals the CURRENT revisionDigest. Record this job and target; never create a second draft for it. A verified draft is not formally published.";
      }
      if (value.action === "save_revision") {
        return "Local action succeeded. Read wemedia_inspect_content for the actual new revision, paragraphs and renamed assets before rebuilding review evidence. Check the expected changes; local save success is not remote delivery.";
      }
      return "This job is terminal. Check its resultCode and the action-specific saved revision or target before reporting the outcome. Local preparation, staging, draft creation and formal publication are different results.";
    case "failed":
    case "cancelled":
      return "This job did not complete successfully. Read resultCode and inspect the current revision and any existing target. Cancellation is not rollback; uncertain remote effects require read-only reconciliation. Do not automatically retry the write or manufacture a replacement intent.";
    case "timed_out":
    case "reconcile_required":
      return "Outcome unconfirmed: remote side effects may already exist. Read resultCode and inspect the current revision and any existing target through read-only reconciliation before reporting delivery or failure. Do not automatically retry the write or manufacture a replacement intent.";
  }
}

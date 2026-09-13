import { isJsonObject } from "../domain/json.ts";
import { parseContentRef } from "../domain/primitives.ts";
import { JOB_STATUSES } from "../domain/job.ts";
import { WORKBENCH_ACTIONS, WorkbenchFault } from "../domain/workbench.ts";
import type { WorkbenchJob } from "../domain/workbench.ts";
import type { WorkbenchJobs } from "../ports/workbench.ts";
import { WorkbenchStore } from "./workbenchStore.ts";

const invalid = (): never => { throw new WorkbenchFault("JOBS_INVALID", "任务记录格式无效，已停止自动恢复"); };
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));

/** Decode a public DTO, never expose the stored object or its unknown fields. */
function decodeJob(value: unknown): WorkbenchJob {
  if (!isJsonObject(value)) return invalid();
  const { jobId, generationId, contentRef, intentId, inputDigest, action, sideEffect, status, progress, safeMessage, createdAt, retryable, artifactRefs } = value;
  if (typeof jobId !== "string" || !jobId || typeof generationId !== "string" || !generationId || typeof intentId !== "string" || !intentId || typeof inputDigest !== "string" || !inputDigest || typeof contentRef !== "string" || !parseContentRef(contentRef).ok || typeof action !== "string" || ![...WORKBENCH_ACTIONS, "create_content", "create_publication", "save_publication"].includes(action) || typeof safeMessage !== "string" || !timestamp(createdAt) || typeof retryable !== "boolean" || !Array.isArray(artifactRefs) || !artifactRefs.every(item => typeof item === "string") || !JOB_STATUSES.includes(status as WorkbenchJob["status"])) return invalid();
  const expectedSideEffect = action === "sync" ? "read" : action === "create_draft" || action === "update_draft" ? "remote_draft" : "local_write";
  if (sideEffect !== expectedSideEffect || (value.channel !== undefined && value.channel !== "wechat") || !isJsonObject(progress) || typeof progress.current !== "number" || !Number.isFinite(progress.current) || progress.current < 0 || (progress.total !== undefined && (typeof progress.total !== "number" || !Number.isFinite(progress.total) || progress.total < progress.current)) || (progress.unit !== undefined && typeof progress.unit !== "string")) return invalid();
  const job: WorkbenchJob = {
    jobId, generationId, contentRef: contentRef as WorkbenchJob["contentRef"], intentId, inputDigest, action, sideEffect,
    status: status as WorkbenchJob["status"], safeMessage, createdAt, retryable, artifactRefs: [...artifactRefs],
    progress: { current: progress.current, ...(progress.total !== undefined ? { total: progress.total } : {}), ...(progress.unit !== undefined ? { unit: progress.unit } : {}) },
    ...(value.channel === "wechat" ? { channel: "wechat" as const } : {}),
  };
  for (const key of ["startedAt", "finishedAt", "deadline"] as const) {
    const item = value[key];
    if (item !== undefined) { if (!timestamp(item)) return invalid(); job[key] = item; }
  }
  for (const key of ["resultEventId", "resultCode"] as const) {
    const item = value[key];
    if (item !== undefined) { if (typeof item !== "string" || !item) return invalid(); job[key] = item; }
  }
  return job;
}

export class FileWorkbenchJobs implements WorkbenchJobs {
  constructor(private readonly store: WorkbenchStore) {}
  async loadAll(): Promise<WorkbenchJob[]> {
    const state = await this.store.read();
    const values = state.extensions.wechatJobs;
    if (values === undefined) return [];
    if (!isJsonObject(values)) return invalid();
    const jobs: WorkbenchJob[] = [];
    for (const [key, value] of Object.entries(values)) {
      const job = decodeJob(value);
      if (job.jobId !== key) return invalid();
      jobs.push(job);
    }
    return jobs;
  }
  async save(job: WorkbenchJob): Promise<void> {
    const publicJob = decodeJob(job);
    await this.store.update(state => {
      const previous = state.extensions.wechatJobs;
      state.extensions.wechatJobs = { ...(isJsonObject(previous) ? previous : {}), [publicJob.jobId]: publicJob };
    });
  }
}

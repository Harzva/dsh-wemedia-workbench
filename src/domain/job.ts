import type { SideEffectLevel } from "./capability.ts";
import type { JsonObject } from "./json.ts";
import type { Channel } from "./primitives.ts";

export const JOB_STATUSES = [
  "queued",
  "running",
  "waiting_user",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "reconcile_required",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobProgress extends JsonObject {
  current: number;
  total?: number;
  unit?: string;
}

export interface Job extends JsonObject {
  jobId: string;
  generationId: string;
  action: string;
  sideEffect: SideEffectLevel;
  status: JobStatus;
  progress: JobProgress;
  safeMessage: string;
  createdAt: string;
  retryable: boolean;
  artifactRefs: string[];
  channel?: Channel;
  startedAt?: string;
  finishedAt?: string;
  deadline?: string;
  resultEventId?: string;
}

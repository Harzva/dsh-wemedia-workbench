import { failure, success } from "./errors.ts";
import type { DomainResult } from "./errors.ts";
import type { JsonObject } from "./json.ts";
import type { Channel } from "./primitives.ts";

export const CHANNEL_STATES = [
  "not_started",
  "adapting",
  "in_review",
  "preflight_running",
  "preflight_failed",
  "preflight_passed",
  "preparing",
  "prepared",
  "staged",
  "drafted",
  "waiting_approval",
  "publishing",
  "published",
  "syncing",
  "synced",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type ChannelState = (typeof CHANNEL_STATES)[number];
export type StableChannelState = Exclude<
  ChannelState,
  "adapting" | "preflight_running" | "preparing" | "publishing" | "syncing" | "failed" | "cancelled" | "timed_out"
>;

export const OVERALL_STATES = [
  "discovered",
  "drafting",
  "review",
  "adapted",
  "preflight",
  "prepared",
  "published",
  "synced",
  "archived",
  "conflicted",
  "blocked",
  "waiting_approval",
] as const;

export type OverallState = (typeof OVERALL_STATES)[number];

export interface PublishedEvidence extends JsonObject {
  eventId: string;
  occurredAt: string;
}

export interface ChannelStateSnapshot extends JsonObject {
  channel: Channel;
  state: ChannelState;
  preflightValid: boolean;
  resumeFrom?: StableChannelState;
  publishedEvidence?: PublishedEvidence;
}

const RUNNING_RESUME_STATE: Partial<Record<ChannelState, StableChannelState>> = {
  adapting: "not_started",
  preflight_running: "in_review",
  preparing: "preflight_passed",
  publishing: "waiting_approval",
  syncing: "published",
};

const ALLOWED_TRANSITIONS: Readonly<Record<ChannelState, readonly ChannelState[]>> = {
  not_started: ["adapting"],
  adapting: ["in_review", "failed", "cancelled", "timed_out"],
  in_review: ["preflight_running"],
  preflight_running: ["preflight_failed", "preflight_passed", "failed", "cancelled", "timed_out"],
  preflight_failed: ["in_review"],
  preflight_passed: ["preparing"],
  preparing: ["prepared", "staged", "drafted", "failed", "cancelled", "timed_out"],
  prepared: ["waiting_approval"],
  staged: ["waiting_approval"],
  drafted: ["waiting_approval"],
  waiting_approval: ["publishing"],
  publishing: ["published", "failed", "cancelled", "timed_out"],
  published: ["syncing"],
  syncing: ["synced", "failed", "cancelled", "timed_out"],
  synced: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function createChannelState(channel: Channel): ChannelStateSnapshot {
  return { channel, state: "not_started", preflightValid: false };
}

export function transitionChannelState(
  snapshot: ChannelStateSnapshot,
  target: ChannelState,
  options: { publishedEvidence?: PublishedEvidence } = {},
): DomainResult<ChannelStateSnapshot> {
  if (!ALLOWED_TRANSITIONS[snapshot.state].includes(target)) {
    return failure("STATE_TRANSITION_INVALID", "channel state transition is not allowed", {
      details: { from: snapshot.state, to: target, channel: snapshot.channel },
    });
  }

  const resumeFrom = RUNNING_RESUME_STATE[snapshot.state];
  const isBypass = target === "failed" || target === "cancelled" || target === "timed_out";
  const next: ChannelStateSnapshot = {
    ...snapshot,
    state: target,
    preflightValid:
      target === "preflight_passed" ||
      (["preparing", "prepared", "staged", "drafted", "waiting_approval", "publishing", "published", "syncing", "synced"] as ChannelState[]).includes(target),
    ...(isBypass && resumeFrom !== undefined ? { resumeFrom } : {}),
    ...(target === "published" && options.publishedEvidence !== undefined
      ? { publishedEvidence: options.publishedEvidence }
      : {}),
  };
  if (!isBypass) delete next.resumeFrom;
  return success(next);
}

export function resumeChannelState(snapshot: ChannelStateSnapshot): DomainResult<ChannelStateSnapshot> {
  if (!["failed", "cancelled", "timed_out"].includes(snapshot.state) || snapshot.resumeFrom === undefined) {
    return failure("STATE_RESUME_UNAVAILABLE", "channel state has no resumable action");
  }
  const { resumeFrom, ...rest } = snapshot;
  return success({ ...rest, state: resumeFrom });
}

export function markVariantDirty(snapshot: ChannelStateSnapshot): ChannelStateSnapshot {
  return {
    ...snapshot,
    state: "in_review",
    preflightValid: false,
  };
}

export interface OverallProjectionInput {
  archived?: boolean;
  identityConflicted?: boolean;
  hasCanonicalDraft: boolean;
  canonicalSubmittedForReview?: boolean;
  hasReviewedVariant?: boolean;
  channels: Readonly<Partial<Record<Channel, ChannelStateSnapshot>>>;
}

export function projectOverallState(input: OverallProjectionInput): OverallState {
  const states = Object.values(input.channels).filter(
    (snapshot): snapshot is ChannelStateSnapshot => snapshot !== undefined,
  );
  if (input.archived) return "archived";
  if (input.identityConflicted) return "conflicted";
  if (states.some(({ state }) => state === "preflight_failed" || state === "failed")) return "blocked";
  if (states.some(({ state }) => state === "waiting_approval")) return "waiting_approval";
  if (states.some(({ state }) => state === "published" || state === "syncing" || state === "synced")) {
    const published = states.filter(({ publishedEvidence }) => publishedEvidence !== undefined);
    if (published.length > 0 && published.every(({ state }) => state === "synced")) return "synced";
    return "published";
  }
  if (states.some(({ state }) => ["prepared", "staged", "drafted"].includes(state))) return "prepared";
  if (states.some(({ state }) => ["preflight_running", "preflight_passed", "preparing"].includes(state))) return "preflight";
  if (input.hasReviewedVariant) return "adapted";
  if (input.canonicalSubmittedForReview) return "review";
  if (input.hasCanonicalDraft) return "drafting";
  return "discovered";
}

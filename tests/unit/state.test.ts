import { describe, expect, it } from "vitest";

import {
  createChannelState,
  markVariantDirty,
  projectOverallState,
  resumeChannelState,
  transitionChannelState,
} from "../../src/domain/state.ts";
import type { ChannelState, ChannelStateSnapshot } from "../../src/domain/state.ts";

function follow(channel: "wechat" | "zhihu", states: ChannelState[]): ChannelStateSnapshot {
  let current = createChannelState(channel);
  for (const state of states) {
    const result = transitionChannelState(current, state, state === "published"
      ? { publishedEvidence: { eventId: `${channel}-published`, occurredAt: "2026-08-30T00:00:00.000Z" } }
      : {});
    expect(result.ok).toBe(true);
    if (result.ok) current = result.value;
  }
  return current;
}

const prefix: ChannelState[] = ["adapting", "in_review", "preflight_running", "preflight_passed", "preparing"];

describe("independent channel state machines", () => {
  it.each(["prepared", "staged", "drafted"] as const)("keeps %s as a distinct stable fact", (branch) => {
    const snapshot = follow("wechat", [...prefix, branch]);
    expect(snapshot.state).toBe(branch);
    expect(snapshot.preflightValid).toBe(true);
  });

  it("runs the full publish and sync path", () => {
    const snapshot = follow("wechat", [...prefix, "drafted", "waiting_approval", "publishing", "published", "syncing", "synced"]);
    expect(snapshot.state).toBe("synced");
    expect(snapshot.publishedEvidence?.eventId).toBe("wechat-published");
  });

  it("rejects illegal rollback with a stable domain error", () => {
    const result = transitionChannelState(createChannelState("wechat"), "published");
    expect(result).toMatchObject({ ok: false, error: { code: "STATE_TRANSITION_INVALID" } });
  });

  it.each(["failed", "cancelled", "timed_out"] as const)("supports the %s running-state bypass and safe resume", (target) => {
    const running = follow("wechat", ["adapting"]);
    const bypass = transitionChannelState(running, target);
    expect(bypass).toMatchObject({ ok: true, value: { state: target, resumeFrom: "not_started" } });
    if (bypass.ok) expect(resumeChannelState(bypass.value)).toMatchObject({ ok: true, value: { state: "not_started" } });
  });

  it("invalidates preflight on dirty edits without erasing published evidence", () => {
    const published = follow("wechat", [...prefix, "prepared", "waiting_approval", "publishing", "published"]);
    const dirty = markVariantDirty(published);
    expect(dirty).toMatchObject({ state: "in_review", preflightValid: false });
    expect(dirty.publishedEvidence).toEqual(published.publishedEvidence);
  });

  it("does not mutate another channel when one channel becomes published", () => {
    const wechat = follow("wechat", [...prefix, "drafted", "waiting_approval", "publishing", "published"]);
    const zhihu = createChannelState("zhihu");
    const before = JSON.parse(JSON.stringify(zhihu));
    expect(projectOverallState({ hasCanonicalDraft: true, hasReviewedVariant: true, channels: { wechat, zhihu } })).toBe("published");
    expect(zhihu).toEqual(before);
    expect(zhihu.state).toBe("not_started");
  });

  it("prioritizes conflict, block, and waiting approval in the overall projection", () => {
    const waiting = follow("wechat", [...prefix, "prepared", "waiting_approval"]);
    const blocked = follow("zhihu", ["adapting", "in_review", "preflight_running", "preflight_failed"]);
    expect(projectOverallState({ hasCanonicalDraft: true, identityConflicted: true, channels: { wechat: waiting } })).toBe("conflicted");
    expect(projectOverallState({ hasCanonicalDraft: true, channels: { zhihu: blocked } })).toBe("blocked");
    expect(projectOverallState({ hasCanonicalDraft: true, channels: { wechat: waiting } })).toBe("waiting_approval");
  });
});

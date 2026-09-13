import type { SourceRecord } from "../domain/content.ts";
import type { LedgerEvent } from "../domain/ledger.ts";
import { CHANNELS } from "../domain/primitives.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";
import type { OverlayV1 } from "../domain/schema.ts";
import { createChannelState, projectOverallState } from "../domain/state.ts";
import type { ChannelState, ChannelStateSnapshot, OverallState } from "../domain/state.ts";
import type { IdentityComponent } from "./identityService.ts";

export interface SafeArtifactView {
  rootId: string;
  relativePath: string;
  digest: string;
  kind: string;
}

export interface ChannelProjection {
  channel: Channel;
  state: ChannelState;
  evidenceEventId?: string;
  remote?: { remoteId?: string; url?: string };
  reconcileRequired: boolean;
}

export interface ProjectedContent {
  contentRef: ContentRef;
  title: string;
  aliases: string[];
  topicKey?: string;
  sourceIds: string[];
  artifacts: SafeArtifactView[];
  channels: Record<Channel, ChannelProjection>;
  overallState: OverallState;
  conflicts: IdentityComponent["conflicts"];
  identitySetDigest: string;
}

function ledgerState(event: LedgerEvent): ChannelState {
  if (event.outcome === "failed") return "failed";
  if (event.outcome === "cancelled") return "cancelled";
  if (event.outcome === "timed_out") return "timed_out";
  if (event.action === "sync") return "synced";
  if (event.action === "publish") return "published";
  if (event.action === "draft") return "drafted";
  if (event.action === "stage") return "staged";
  if (event.action === "prepare") return "prepared";
  return "not_started";
}

function effectiveEvents(events: readonly LedgerEvent[]): LedgerEvent[] {
  const superseded = new Set(
    events
      .filter(({ outcome, supersedesEventId }) => outcome === "corrected" && supersedesEventId !== undefined)
      .map(({ supersedesEventId }) => supersedesEventId!),
  );
  const byKey = new Map<string, LedgerEvent>();
  for (const event of [...events].sort((left, right) => `${left.occurredAt}:${left.eventId}`.localeCompare(`${right.occurredAt}:${right.eventId}`))) {
    if (!superseded.has(event.eventId) && event.outcome !== "corrected") byKey.set(event.eventKey, event);
  }
  return [...byKey.values()];
}

function overlayState(value: unknown): ChannelState | undefined {
  if (typeof value !== "string") return undefined;
  const safeLocalStates: ChannelState[] = [
    "not_started", "adapting", "in_review", "preflight_running", "preflight_failed", "preflight_passed", "preparing", "prepared", "staged", "waiting_approval",
  ];
  return safeLocalStates.includes(value as ChannelState) ? value as ChannelState : undefined;
}

export function projectContents(input: {
  components: readonly IdentityComponent[];
  sources: readonly SourceRecord[];
  ledgerEvents: readonly LedgerEvent[];
  overlay: OverlayV1;
}): ProjectedContent[] {
  const byRecord = new Map(input.sources.map((source) => [source.recordId, source]));
  const events = effectiveEvents(input.ledgerEvents);
  return input.components.map((component) => {
    const sources = component.sourceRecordIds.map((id) => byRecord.get(id)).filter((source): source is SourceRecord => source !== undefined);
    const preferred = sources.find(({ recordKind }) => recordKind === "manifest") ?? sources[0];
    const titles = [...new Set(sources.map(({ title }) => title).filter(Boolean))];
    const contentEvents = events.filter(({ contentRef }) => contentRef === component.contentRef);
    const channels = Object.fromEntries(CHANNELS.map((channel) => {
      const channelEvents = contentEvents
        .filter((event) => event.channel === channel)
        .sort((left, right) => `${left.occurredAt}:${left.eventId}`.localeCompare(`${right.occurredAt}:${right.eventId}`));
      const latest = channelEvents.at(-1);
      const stateKey = `${component.contentRef}:${channel}`;
      const rawOverlay = input.overlay.variantState[stateKey];
      const overlayObject = typeof rawOverlay === "object" && rawOverlay !== null && !Array.isArray(rawOverlay) ? rawOverlay : undefined;
      const localState = overlayState(overlayObject?.state);
      const state = latest === undefined ? localState ?? "not_started" : ledgerState(latest);
      const overlayEventId = typeof overlayObject?.lastEventId === "string" ? overlayObject.lastEventId : undefined;
      const reconcileRequired = latest !== undefined && overlayEventId !== latest.eventId;
      const projection: ChannelProjection = {
        channel,
        state,
        reconcileRequired,
        ...(latest === undefined ? {} : { evidenceEventId: latest.eventId }),
        ...(latest?.remote === undefined ? {} : { remote: latest.remote }),
      };
      return [channel, projection];
    })) as Record<Channel, ChannelProjection>;
    const snapshots = Object.fromEntries(CHANNELS.map((channel) => {
      const projection = channels[channel];
      const snapshot: ChannelStateSnapshot = {
        ...createChannelState(channel),
        state: projection.state,
        preflightValid: ["preflight_passed", "preparing", "prepared", "staged", "drafted", "waiting_approval", "publishing", "published", "syncing", "synced"].includes(projection.state),
        ...(projection.state === "published" || projection.state === "syncing" || projection.state === "synced"
          ? { publishedEvidence: { eventId: projection.evidenceEventId ?? "manual", occurredAt: contentEvents.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z" } }
          : {}),
      };
      return [channel, snapshot];
    })) as Record<Channel, ChannelStateSnapshot>;
    const hasCanonical = sources.some(({ canonicalArtifactKey }) => canonicalArtifactKey !== undefined) || sources.some(({ recordKind }) => recordKind === "markdown");
    return {
      contentRef: component.contentRef,
      title: preferred?.title ?? "Untitled",
      aliases: titles.filter((title) => title !== preferred?.title),
      sourceIds: [...new Set(sources.flatMap(({ sourceIds }) => sourceIds))].sort(),
      artifacts: sources.map((source) => ({
        rootId: source.rootId,
        relativePath: source.relativePath,
        digest: source.digest,
        kind: typeof source.recordKind === "string" ? source.recordKind : "unknown",
      })),
      channels,
      overallState: projectOverallState({
        hasCanonicalDraft: hasCanonical,
        hasReviewedVariant: Object.values(channels).some(({ state }) => state !== "not_started" && state !== "adapting" && state !== "in_review"),
        identityConflicted: component.conflicts.length > 0,
        channels: snapshots,
      }),
      conflicts: component.conflicts,
      identitySetDigest: component.identitySetDigest,
      ...(preferred?.topicKey === undefined ? {} : { topicKey: preferred.topicKey }),
    };
  }).sort((left, right) => left.contentRef.localeCompare(right.contentRef));
}

import type { AdapterResult, CapabilityReport, GateReport, SideEffectLevel } from "../domain/capability.ts";
import type { ArtifactRef } from "../domain/content.ts";
import type { JsonObject } from "../domain/json.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";

export interface DiscoverContext extends JsonObject {
  generationId: string;
}

export interface PreflightInput extends JsonObject {
  contentRef: ContentRef;
  channel: Channel;
  artifact: ArtifactRef;
  inputDigest: string;
}

export interface ActionInput extends PreflightInput {
  sideEffect: SideEffectLevel;
}

export interface ApprovedActionInput extends ActionInput {
  intentId: string;
  approvalReference: string;
}

export interface SyncInput extends JsonObject {
  contentRef: ContentRef;
  channel: Channel;
  remoteId?: string;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  discover(context: DiscoverContext, signal: AbortSignal): Promise<CapabilityReport>;
  preflight(input: PreflightInput, signal: AbortSignal): Promise<GateReport>;
  prepare(input: ActionInput, signal: AbortSignal): Promise<AdapterResult>;
  stage?(input: ActionInput, signal: AbortSignal): Promise<AdapterResult>;
  draft?(input: ActionInput, signal: AbortSignal): Promise<AdapterResult>;
  publish?(input: ApprovedActionInput, signal: AbortSignal): Promise<AdapterResult>;
  sync(input: SyncInput, signal: AbortSignal): Promise<AdapterResult>;
}

export interface AdapterRegistry {
  get(channel: Channel): ChannelAdapter | undefined;
  list(): readonly ChannelAdapter[];
}

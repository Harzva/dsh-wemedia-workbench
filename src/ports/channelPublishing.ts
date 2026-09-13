import type { ArtifactRef } from "../domain/content.ts";
import type { CapabilityReport, ArtifactOutput } from "../domain/capability.ts";
import type { ChannelAction, PublishingChannel, PublishingType, ChannelRemote } from "../domain/channelPublishing.ts";
import type { ChannelDocument } from "../domain/channelDocument.ts";

export type { ChannelDocument } from "../domain/channelDocument.ts";
export type { ChannelRemote } from "../domain/channelPublishing.ts";
export interface ChannelBridgeResult {
  ok: boolean; code: string; configured: "configured" | "missing" | "invalid" | "unknown";
  accountRef?: string; permission?: "unknown" | "available" | "missing";
  status?: "prepared" | "manual_handoff" | "draft" | "published" | "reconcile_required";
  revisionDigest?: string; verifiedAt?: string; remoteWriteAttempted: boolean; reconcileRequired: boolean;
  issues: Array<{ code: string; status: "pass" | "warn" | "block" }>;
  artifacts: ArtifactOutput[]; remote?: ChannelRemote;
}
export interface ChannelRunInput {
  action?: ChannelAction;
  document: ChannelDocument; expectedAccountRef?: string; target?: ChannelRemote;
  output?: ArtifactRef; authorization?: { action: "stage" | "publish"; inputDigest: string; reference: string };
}
export interface PublishingAdapter {
  readonly channel: PublishingChannel;
  discover(signal: AbortSignal): Promise<CapabilityReport>;
  supports(type: PublishingType, action: ChannelAction | "preflight"): boolean;
  preflight(document: ChannelDocument, online: boolean, signal: AbortSignal, action?: ChannelAction): Promise<ChannelBridgeResult>;
  run(action: ChannelAction, input: ChannelRunInput, signal: AbortSignal): Promise<ChannelBridgeResult>;
}

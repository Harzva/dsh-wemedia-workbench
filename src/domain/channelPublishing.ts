import type { JsonObject } from "./json.ts";
import type { ContentRef } from "./primitives.ts";
import type { ActionIntent, CapabilityReport, GateReport, SideEffectLevel } from "./capability.ts";
import type { ArtifactOutput } from "./capability.ts";
import type { WorkbenchJob } from "./workbench.ts";

export const PUBLISHING_CHANNELS = ["zhihu", "xiaohongshu", "x"] as const;
export type PublishingChannel = typeof PUBLISHING_CHANNELS[number];
export const CHANNEL_ACTIONS = ["prepare", "stage", "publish", "sync"] as const;
export type ChannelAction = typeof CHANNEL_ACTIONS[number];
export type PublishingType = "article" | "video" | "image_text";
export interface ChannelRemote { remoteId: string; url?: string; remoteIds?: string[]; contentDigest?: string }
export const channelEffect = (channel: PublishingChannel, action: ChannelAction): SideEffectLevel => action === "sync" ? "read" : action === "publish" ? "remote_publish" : channel === "zhihu" && action === "stage" ? "remote_draft" : "local_write";
export interface ChannelTarget extends JsonObject {
  targetRef: string; channel: PublishingChannel; label: string; url: string;
  status: "draft" | "published" | "reconcile_required";
  revisionDigest: string; verifiedAt: string;
}
export interface ChannelMatrixRow extends JsonObject {
  channel: "wechat" | PublishingChannel | "csdn"; publicationType: PublishingType;
  action: string; status: string; reasonCode: string;
}
export interface ChannelInspection extends JsonObject {
  contentRef: ContentRef; revisionDigest: string; publicationType: PublishingType;
  capabilities: CapabilityReport[]; targets: ChannelTarget[]; jobs: WorkbenchJob[];
  matrix: ChannelMatrixRow[]; issues: string[];
}
export interface ChannelPreview extends JsonObject {
  intent: ActionIntent; channel: PublishingChannel; action: ChannelAction;
  publicationType: PublishingType; gates: GateReport; target: ChannelTarget | null; summary: string[];
}
export interface ChannelCheck extends JsonObject {
  contentRef: ContentRef; channel: PublishingChannel; revisionDigest: string;
  configured: "configured" | "missing" | "invalid" | "unknown";
  permission: "unknown" | "available" | "missing"; gates: GateReport;
}
export type ChannelRequest =
  | { operation: "channel_inspect"; contentRef: ContentRef }
  | { operation: "channel_preflight"; contentRef: ContentRef; channel: PublishingChannel; online?: boolean }
  | { operation: "channel_preview_action"; contentRef: ContentRef; channel: PublishingChannel; action: ChannelAction; targetRef?: string; targetUrl?: string }
  | { operation: "channel_start_action"; intentId: string };
export interface ChannelStoredResult extends JsonObject {
  job: WorkbenchJob; artifacts: ArtifactOutput[]; target: ChannelTarget | null;
}

import type { JsonObject } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import type { ChannelStateSnapshot, OverallState } from "./state.ts";

export interface ArtifactRef extends JsonObject {
  rootId: string;
  relativePath: string;
  digest?: string;
}

export interface SourceRef extends JsonObject {
  sourceId: string;
  kind: "paper" | "subscription" | "web" | "note" | "other";
  title?: string;
  url?: string;
}

export interface AssetRef extends ArtifactRef {
  mediaType?: string;
  role?: string;
}

export interface RemoteRef extends JsonObject {
  remoteId?: string;
  url?: string;
}

export interface Variant extends JsonObject {
  channel: Channel;
  artifact: ArtifactRef;
  derivedFrom?: ArtifactRef;
  generatedAt?: string;
  sourceDigest?: string;
  currentDigest?: string;
  dirty: boolean;
  state: ChannelStateSnapshot;
  remote?: RemoteRef;
}

export interface IdentityEvidence extends JsonObject {
  identitySetDigest: string;
  sourceRecordIds: string[];
  evidenceCodes: string[];
}

export interface ContentItem extends JsonObject {
  schemaVersion: "wemedia.content/v1";
  contentRef: ContentRef;
  title: string;
  aliases: string[];
  sourceIds: string[];
  sources: SourceRef[];
  assets: AssetRef[];
  variants: Partial<Record<Channel, Variant>>;
  overallState: OverallState;
  identity: IdentityEvidence;
  conflicts: string[];
  topicKey?: string;
  canonicalDraft?: ArtifactRef;
  createdAt?: string;
  updatedAt?: string;
}

export interface SourceRecord extends JsonObject {
  recordId: string;
  rootId: string;
  relativePath: string;
  digest: string;
  title: string;
  sourceIds: string[];
  explicitContentId?: string;
  topicKey?: string;
  canonicalArtifactKey?: string;
  channel?: Channel;
  remote?: RemoteRef;
  derivedFromPath?: string;
  recordKind?: "manifest" | "markdown" | "asset" | "ledger" | "wechat_manifest";
  articleId?: string;
  contentPath?: string;
  previewPath?: string;
  mediaType?: string;
}

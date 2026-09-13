import type { JsonObject } from "./json.ts";

export type CollectionKind = "wechat_article" | "xhs_note" | "xhs_author";
export interface CollectionInput { kind: CollectionKind; url: string; limit: number }
export interface CollectedReference extends JsonObject {
  platform: "wechat" | "xiaohongshu";
  sourceId: string; url: string; title: string; author: string;
  publishedAt: string | null; kind: "article" | "image_text" | "video";
  text: string; tags: string[]; completeness: "complete" | "partial";
  media: Array<{ kind: "image" | "video"; url: string }>;
}
export interface ReferenceItem extends CollectedReference { id: string; collectedAt: string }
export interface CollectionResult { items: CollectedReference[]; partial: boolean; message: string }
export interface ReferencePage extends JsonObject { schemaVersion: "wemedia.references/v1"; items: ReferenceItem[]; total: number; notice: string }
export interface ReferenceCollection extends JsonObject { schemaVersion: "wemedia.collection/v1"; items: ReferenceItem[]; added: number; updated: number; partial: boolean; message: string }
export interface ReferenceBrief extends JsonObject { schemaVersion: "wemedia.reference-brief/v1"; ids: string[]; action: "analyze" | "write"; prompt: string }
export type ReferenceRequest =
  | { operation: "reference_list" }
  | { operation: "reference_read"; id: string }
  | { operation: "reference_collect"; kind: CollectionKind; url: string; limit?: number }
  | { operation: "reference_brief"; ids: string[]; action: "analyze" | "write"; instruction?: string };

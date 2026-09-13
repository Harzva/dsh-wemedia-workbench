import type { JsonObject } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import type { ActionIntent } from "./capability.ts";
import type { PublicationRecord } from "./publication.ts";
import { isJsonObject } from "./json.ts";
import { LIBRARY_ITEM_ID } from "./contentLibrary.ts";
import { SHA256_PATTERN } from "./artifactValidation.ts";
import { WorkbenchFault } from "./workbenchFault.ts";

export const PUBLICATION_DRAFT_SCHEMA = "wemedia.publication-draft/v1" as const;
export const PUBLICATION_ASSET_ID = /^publication-asset:[a-f0-9]{64}$/u;
export type MediaPublicationType = "video" | "image_text";
export interface PublicationSelection extends JsonObject {
  source: "library" | "draft";
  itemId: string;
  revisionDigest: string;
  caption: string;
}
export interface PublicationAsset extends PublicationSelection {
  title: string;
  kind: "image" | "video";
  mediaType: string;
  bytes: number;
}
export interface PublicationEdit extends JsonObject {
  title: string;
  body: string;
  media: PublicationSelection[];
  coverItemId: string | null;
  channels: Channel[];
}
export interface PublicationDraft extends JsonObject {
  schemaVersion: typeof PUBLICATION_DRAFT_SCHEMA;
  contentRef: ContentRef;
  publicationType: MediaPublicationType;
  title: string;
  body: string;
  media: PublicationAsset[];
  coverItemId: string | null;
  channels: Channel[];
  revisionDigest: string;
  createdAt: string;
  updatedAt: string;
  readOnlySource: boolean;
  issues: string[];
  publications: PublicationRecord[];
}
export interface PublicationDraftPreview extends JsonObject {
  intent: ActionIntent;
  summary: string[];
  publication: PublicationDraft;
}
export interface PublicationMediaInput {
  contentRef: ContentRef;
  itemId: string;
  revisionDigest: string;
  offset: number;
  length: number;
}
export type PublicationRequest =
  | { operation: "publication_read"; contentRef: ContentRef }
  | { operation: "create_publication"; publicationType: MediaPublicationType; title: string }
  | { operation: "preview_publication_save"; contentRef: ContentRef; expectedRevision: string; edit: PublicationEdit }
  | ({ operation: "publication_media" } & PublicationMediaInput);

export const publicationEdit = (draft: PublicationDraft): PublicationEdit => ({
  title: draft.title, body: draft.body, coverItemId: draft.coverItemId, channels: [...draft.channels],
  media: draft.media.map(({ source, itemId, revisionDigest, caption }) => ({ source, itemId, revisionDigest, caption })),
});

export function publicationText(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) || /(?:file:\/\/|\/(?:Users|Volumes|private|home|etc)\/|(?:api[_-]?key|authorization|password|cookie|secret|access[_-]?token)\s*[:=])/iu.test(value)) throw new WorkbenchFault("REQUEST_INVALID", "发布稿字段无效或包含私有信息");
  return value;
}
export function decodePublicationEdit(value: unknown): PublicationEdit {
  const invalid = (): never => { throw new WorkbenchFault("REQUEST_INVALID", "发布稿格式无效"); };
  if (!isJsonObject(value) || Object.keys(value).length !== 5 || Object.keys(value).some(key => !["title", "body", "media", "coverItemId", "channels"].includes(key)) || !Array.isArray(value.media) || value.media.length > 18 || !Array.isArray(value.channels) || value.channels.length > 4 || new Set(value.channels).size !== value.channels.length || !value.channels.every(channel => typeof channel === "string" && ["wechat", "zhihu", "xiaohongshu", "x"].includes(channel))) return invalid();
  const media = value.media.map(item => {
    if (!isJsonObject(item) || Object.keys(item).length !== 4 || Object.keys(item).some(key => !["source", "itemId", "revisionDigest", "caption"].includes(key)) || (typeof item.source !== "string" || !["library", "draft"].includes(item.source)) || typeof item.itemId !== "string" || !(item.source === "library" ? LIBRARY_ITEM_ID : PUBLICATION_ASSET_ID).test(item.itemId) || typeof item.revisionDigest !== "string" || !SHA256_PATTERN.test(item.revisionDigest)) return invalid();
    return { source: item.source as PublicationSelection["source"], itemId: item.itemId, revisionDigest: item.revisionDigest, caption: publicationText(item.caption, 1000, true) };
  });
  if (new Set(media.map(item => item.itemId)).size !== media.length || value.coverItemId !== null && (typeof value.coverItemId !== "string" || !media.some(item => item.itemId === value.coverItemId))) return invalid();
  return { title: publicationText(value.title, 200), body: publicationText(value.body, 30_000, true), media, coverItemId: value.coverItemId as string | null, channels: value.channels as Channel[] };
}

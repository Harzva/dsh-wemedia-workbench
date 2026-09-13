import type { JsonObject } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import type { PublicationRecord, PublicationStatus } from "./publication.ts";
import type { ArticleCategory, ArticleFacets, ArticleTaxonomy } from "./articleTaxonomy.ts";
export type { PublicationStatus } from "./publication.ts";

export type LibraryKind = "article" | "image" | "video";
/** A source image is an asset, not a completed image-text publication. */
export type PublicationType = "article" | "video" | "image_text";
export type LibrarySort = "updated_desc" | "updated_asc";
export const LIBRARY_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export const LIBRARY_MEDIA_CHUNK_BYTES = 256 * 1024;
export const LIBRARY_ITEM_ID = /^library:[a-f0-9]{64}$/u;

/** Public library projections never carry file paths, remote IDs or credentials. */
export interface LibraryItem extends JsonObject {
  itemId: string;
  title: string;
  kind: LibraryKind;
  publicationType: PublicationType | null;
  publicationStatus: PublicationStatus;
  publications?: PublicationRecord[];
  taxonomy?: ArticleTaxonomy;
  origin: "workbench" | "legacy" | "local";
  rootLabel: string;
  readOnly: boolean;
  legacyReadOnly: boolean;
  contentRef: ContentRef | null;
  publicationRef?: ContentRef;
  mappingRef?: ContentRef;
  createdAt?: string | null;
  publishedAt?: string | null;
  mediaType: string | null;
  bytes: number | null;
  revisionDigest: string;
  status: string;
  updatedAt: string | null;
}
export interface LibraryPage extends JsonObject {
  facets?: ArticleFacets;
  items: LibraryItem[];
  total: number;
  nextCursor: string | null;
  revisionDigest: string;
  issues: string[];
  truncated: boolean;
}
export interface LibraryDetail extends JsonObject {
  item: LibraryItem;
  html: string | null;
  markdown: string | null;
  issues: string[];
}
export interface LibraryMediaChunk extends JsonObject {
  itemId: string;
  revisionDigest: string;
  offset: number;
  totalBytes: number;
  mediaType: string;
  dataBase64: string;
  eof: boolean;
}
export interface LibraryListInput {
  channel?: Channel;
  timeField?: "updated" | "created" | "published";
  query?: string;
  kind?: LibraryKind;
  publicationType?: PublicationType;
  publicationStatus?: PublicationStatus;
  category?: ArticleCategory;
  conference?: string;
  year?: number;
  tag?: string;
  /** Absolute ISO timestamps with a timezone; inclusive lower/exclusive upper bound. */
  updatedFrom?: string;
  updatedTo?: string;
  sort?: LibrarySort;
  cursor?: string;
  pageSize?: number;
}

/** Reject ambiguous local times, invalid calendar dates, and Date.parse rollover. */
export function isLibraryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35 || !Number.isFinite(Date.parse(value))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u.exec(value);
  if (!match || /[+-]14:(?!00)/u.test(value)) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
export interface LibraryMediaInput { itemId: string; offset: number; length: number; revisionDigest: string }

import type { JsonObject } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import type { ArtifactRef, SourceRecord } from "./content.ts";
import { safeRelativeFile } from "./artifactValidation.ts";

export const CONTENT_MAPPING_SCHEMA = "wemedia.content-mapping/v1" as const;
export const MAPPING_OPERATIONS = ["select_canonical", "map_variant", "bind", "separate"] as const;
export type MappingOperation = typeof MAPPING_OPERATIONS[number];
const SOURCE_INPUT = /(?:^|\/)(?:assets|paper-ocr|mineru|research|papers|node_modules|\.[^/]*)(?:\/|$)/iu;
const MANAGEMENT_FILE = /(?:^|[\/._-])(?:readme|agents|skill|demo|prompts?|reports?|records?|checklists?|inventory|ledger|manifest|completion|verification|smoke|batch|status|backlog|roadmap|plan|command|runbooks?|audit|preflight|precheck)(?:$|[\/._-])/iu;
/** A mapping candidate is a discovered authored document, never raw paper material. */
export function mappingArtifact(source: SourceRecord): ArtifactRef | null {
  if (!safeRelativeFile(source.relativePath) || SOURCE_INPUT.test(source.relativePath) || source.relativePath.split("/").some(part => /credential|secret|password|cookie|authorization|api[-_.]?key|access[-_.]?token|refresh[-_.]?token/iu.test(part))) return null;
  if (source.recordKind === "markdown") return MANAGEMENT_FILE.test(source.relativePath) ? null : { rootId: source.rootId, relativePath: source.relativePath };
  if (source.recordKind === "wechat_manifest" && source.contentPath && safeRelativeFile(source.contentPath)) return { rootId: source.rootId, relativePath: source.contentPath };
  if (source.recordKind === "manifest" && source.canonicalArtifactKey?.startsWith(`${source.rootId}:`)) {
    const path = source.canonicalArtifactKey.slice(source.rootId.length + 1);
    if (safeRelativeFile(path)) return { rootId: source.rootId, relativePath: path };
  }
  return null;
}
export interface StoredCanonicalMapping extends JsonObject {
  sourceRecordId: string;
  sourceDigest: string;
  selectedAt: string;
}
export interface StoredVariantMapping extends JsonObject {
  sourceRecordId: string;
  derivedFromRecordId: string;
  sourceDigest: string;
  generatedDigest: string;
  mappedAt: string;
  provenance: "explicit_mapping";
}
export interface StoredContentMapping extends JsonObject {
  contentRef: ContentRef;
  canonical: StoredCanonicalMapping | null;
  variants: Partial<Record<Channel, StoredVariantMapping>>;
}
export interface ContentMappingState extends JsonObject {
  schemaVersion: typeof CONTENT_MAPPING_SCHEMA;
  entries: Record<string, StoredContentMapping>;
}
export interface MappingSourceView extends JsonObject {
  sourceRecordId: string;
  title: string;
  rootId: string;
  rootLabel: string;
  contentRef: ContentRef | null;
  digest: string;
}
export interface CanonicalMappingView extends StoredCanonicalMapping {
  available: boolean;
  stale: boolean;
  currentDigest: string | null;
}
export interface VariantMappingView extends StoredVariantMapping {
  channel: Channel;
  available: boolean;
  dirty: boolean;
  stale: boolean;
  currentDigest: string | null;
}
export interface ContentMappingView extends JsonObject {
  schemaVersion: typeof CONTENT_MAPPING_SCHEMA;
  generationId: string;
  revision: number;
  contentRef: ContentRef;
  canonical: CanonicalMappingView | null;
  variants: VariantMappingView[];
  sources: MappingSourceView[];
  total: number;
  nextCursor: string | null;
  conflicts: Array<{ leftRecordId: string; rightRecordId: string; evidenceCodes: string[] }>;
  revalidationRequired: boolean;
}
export interface MappingInspectInput {
  contentRef: ContentRef;
  query?: string;
  cursor?: string;
  pageSize?: number;
}
export interface MappingChangeInput {
  contentRef: ContentRef;
  operation: MappingOperation;
  sourceRecordIds: string[];
  /** Separate keeps this explicitly selected group under the old contentRef. */
  retainedSourceRecordIds?: string[];
  channel?: Channel;
}
export interface MappingPreview extends JsonObject {
  intentId: string;
  generationId: string;
  contentRef: ContentRef;
  operation: MappingOperation;
  sideEffect: "local_write";
  inputDigest: string;
  expiresAt: string;
  expectedRevision: number;
  expectedChanges: string[];
  sources: MappingSourceView[];
}
export interface MappingApplyResult extends JsonObject {
  intentId: string;
  contentRef: ContentRef;
  operation: MappingOperation;
  revision: number;
  detachedContentRefs: ContentRef[];
}

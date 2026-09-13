import type { ParameterPropertySpec, ParameterSchemaSpec, ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { JOB_STATUSES } from "../domain/job.ts";
import { REVIEW_KINDS, WORKBENCH_ACTIONS } from "../domain/workbench.ts";
import type { AiWorkflowResult } from "../domain/workbench.ts";

const text = { type: "string" } as const;
const integer = { type: "integer" } as const;
const boolean = { type: "boolean" } as const;
const strings = { type: "array", items: text } as const;
const required = (schema: ValueSchemaSpec): ParameterPropertySpec => ({ ...schema, required: true });
const object = (properties: ParameterSchemaSpec): ValueSchemaSpec => ({ type: "object", additionalProperties: false, properties });
const array = (items: ValueSchemaSpec): ValueSchemaSpec => ({ type: "array", items });
const enumeration = (values: readonly string[]): ValueSchemaSpec => ({ type: "string", enum: values });
const nullable = (schema: ValueSchemaSpec): ValueSchemaSpec => ({ oneOf: [schema, { type: "null" }] });
const fields = (names: readonly string[]): ParameterSchemaSpec => Object.fromEntries(names.map(name => [name, required(text)]));

export const accountSummarySchema = object({ channel: required(enumeration(["wechat", "zhihu", "xiaohongshu", "x"])), name: required(text), status: required(enumeration(["unchecked", "ready", "login_required", "expired", "error", "not_configured"])), checkedAt: required(nullable(text)), message: required(text), permission: required(enumeration(["unknown", "available", "missing"])), credential: required(object({ kind: required(enumeration(["api_key", "cookies", "oauth"])), label: required(text), present: required(nullable(boolean)), storage: required(enumeration(["local_reference"])) })), login: required(object({ kind: required(enumeration(["qr", "browser", "configuration", "unsupported"])), supported: required(boolean), message: required(text) })) });
export const accountOverviewSchema = object({ schemaVersion: required(enumeration(["wemedia.accounts/v1"])), accounts: required(array(accountSummarySchema)), notice: required(text) });

export const artifactSchema = object(fields(["rootId", "relativePath"]));
export const metadataSchema = object({ ...fields(["articleId", "title", "author", "digest", "titlePrefix", "sourceUrl", "pdfUrl", "codeUrl"]), kind: required(enumeration(["paper", "article"])) });
export const editSchema = object({ metadata: required(metadataSchema), html: required(text), markdown: required(text) });
const coverageSchema = object({ paragraphs: required(array(integer)), paragraphTotal: required(integer), assets: required(strings), assetTotal: required(integer), complete: required(boolean) });
const reviewSchema = object({ coverage: coverageSchema, ...fields(["id", "revisionDigest", "artifactDigest", "summary", "recordedAt"]), kind: required(enumeration(REVIEW_KINDS)), artifact: required(artifactSchema), reviewer: required(enumeration(["user", "agent"])), valid: required(boolean) });
const targetSchema = object(fields(["targetRef", "label", "title", "sourceUrl", "verifiedRevision", "verifiedAt"]));
const assetSchema = object({ ...fields(["source", "digest", "mediaType"]), artifact: required(artifactSchema), kind: required(enumeration(["original", "formula", "other"])), bytes: required(integer) });
export const workflowMaterialSchema = object({ ...fields(["id", "sourceDigest", "sourceFormat", "title", "boundRevision", "boundHtmlDigest", "recordedAt"]), kind: required(enumeration(["review", "draft"])), source: required(artifactSchema), status: required(enumeration(["current", "partial", "historical", "stale"])), reviewKind: required(nullable(enumeration(REVIEW_KINDS))), findings: required(strings), warnings: required(strings) });
const publicationSchema = object({ channel: required(enumeration(["wechat", "zhihu", "xiaohongshu", "x"])), status: required(enumeration(["draft", "ready", "published", "unknown", "failed", "removed"])), publishedAt: required(nullable(text)), checkedAt: required(nullable(text)), url: required(nullable(text)), evidence: required(enumeration(["none", "local_draft", "draft_readback", "local_receipt", "remote_readback"])), note: required(text) });
const publicationSourceSchema = object({ available: required(boolean), checkedAt: required(nullable(text)), counts: required(object({ ledgerRecords: required(integer), zhihuArticles: required(integer), xiaohongshuRecords: required(integer) })), channels: required(array(enumeration(["wechat", "zhihu", "xiaohongshu", "x"]))), issues: required(strings) });
const taxonomySchema = object({ category: required(enumeration(["conference", "arxiv", "other"])), conference: required(nullable(text)), year: required(nullable(integer)), tags: required(strings) });
export const documentSchema = object({ ...fields(["contentRef", "html", "markdown", "revisionDigest"]), document: required(artifactSchema), htmlArtifact: required(artifactSchema), metadata: required(metadataSchema), assets: required(array(assetSchema)), readOnlySource: required(boolean), reviews: required(array(reviewSchema)), targets: required(array(targetSchema)), issues: required(strings), workflowImports: array(workflowMaterialSchema), paragraphs: strings, updatedAt: nullable(text), publications: array(publicationSchema), taxonomy: taxonomySchema });
const gateStatus = enumeration(["pass", "warn", "block"]);
const issueSchema = object({ ...fields(["gateId", "version", "code", "safeMessage", "inputDigest"]), status: required(gateStatus), evidenceRefs: required(strings) });
export const gateSchema = object({ inputDigest: required(text), status: required(gateStatus), issues: required(array(issueSchema)) });
export function aiWorkflowSchema(operation: AiWorkflowResult["operation"]): ValueSchemaSpec {
  return object({ ...fields(["revisionDigest", "code"]), operation: required({ type: "string", const: operation }), mode: required({ type: "string", const: "ai" }), sourceKind: required(enumeration(["markdown", "html"])), status: required(gateStatus), previewFidelity: required(enumeration(["exact", "degraded", "unavailable"])), issues: required(array(issueSchema)) });
}
const intentSchema = object({ ...fields(["intentId", "generationId", "contentRef", "action", "targetSummary", "inputDigest", "expiresAt"]), channel: text, sideEffect: required(enumeration(["read", "local_write", "remote_draft", "remote_publish"])), artifactDigest: text, expectedChanges: required(strings), blockingGateCodes: required(strings), approved: required(boolean) });
export const actionPreviewSchema = object({ intent: required(intentSchema), action: required(enumeration(WORKBENCH_ACTIONS)), gates: required(gateSchema), target: required(nullable(targetSchema)), summary: required(strings) });
export const workflowImportPreviewSchema = object({ intent: required(intentSchema), kind: required(enumeration(["review", "draft"])), material: required(workflowMaterialSchema), requiresIdentityCheck: required(boolean), summary: required(strings) });
export const jobSchema = object({ ...fields(["jobId", "generationId", "contentRef", "intentId", "inputDigest", "action", "safeMessage", "createdAt"]), sideEffect: required(enumeration(["read", "local_write", "remote_draft", "remote_publish"])), status: required(enumeration(JOB_STATUSES)), progress: required(object({ current: required(integer), total: integer, unit: text })), retryable: required(boolean), artifactRefs: required(strings), channel: text, startedAt: text, finishedAt: text, deadline: text, resultEventId: text, resultCode: text });
const summarySchema = object({ ...fields(["contentRef", "title", "articleId", "rootLabel"]), channel: required({ type: "string", const: "wechat" }), readOnlySource: required(boolean), status: required(enumeration(["discovered", "drafting", "needs_review", "ready", "draft_verified", "needs_revalidation"])), issueCount: required(integer), updatedAt: nullable(text), publications: array(publicationSchema), taxonomy: taxonomySchema });
export const pageSchema = object({ items: required(array(summarySchema)), total: required(integer), nextCursor: required(nullable(text)), revision: required(integer) });
const capabilitySchema = object({ ...fields(["channel", "adapter"]), adapterVersion: text, configured: required(enumeration(["configured", "missing", "invalid", "unknown"])), actions: required(array(object({ ...fields(["action", "reasonCode", "safeMessage", "checkedAt"]), status: required(enumeration(["ready", "unavailable", "unsupported", "degraded", "approval_required"])), expiresAt: text }))) });
const settingsSchema = object({ roots: required(array(object({ ...fields(["id", "label"]), mode: required(enumeration(["read", "write"])), available: required(boolean) }))), hasWriteRoot: required(boolean), hasDataDir: required(boolean), approvalAvailable: required(boolean), issues: required(strings) });
export const snapshotSchema = object({ ...fields(["schemaVersion", "generationId"]), revision: required(integer), settings: required(settingsSchema), capabilities: required(array(capabilitySchema)), jobs: required(array(jobSchema)), supportedChannels: required(strings), publicationSources: publicationSourceSchema });
export const previewSchema = object({ ...fields(["revisionDigest", "html"]), width: required(integer), imageCount: required(integer), issues: required(strings) });
export const briefSchema = object({ ...fields(["contentRef", "revisionDigest", "prompt"]), action: required(enumeration(["research", "write_draft", "review"])) });
export const referenceItemSchema = object({ ...fields(["id", "sourceId", "url", "title", "author", "text", "collectedAt"]), platform: required(enumeration(["wechat", "xiaohongshu"])), publishedAt: required(nullable(text)), kind: required(enumeration(["article", "image_text", "video"])), tags: required(strings), completeness: required(enumeration(["complete", "partial"])), media: required(array(object({ kind: required(enumeration(["image", "video"])), url: required(text) }))) });
export const referencePageSchema = object({ schemaVersion: required(text), items: required(array(referenceItemSchema)), total: required(integer), notice: required(text) });
export const referenceCollectionSchema = object({ schemaVersion: required(text), items: required(array(referenceItemSchema)), added: required(integer), updated: required(integer), partial: required(boolean), message: required(text) });
export const referenceBriefSchema = object({ schemaVersion: required(text), ids: required(strings), action: required(enumeration(["analyze", "write"])), prompt: required(text) });
export const createSchema: ValueSchemaSpec = { oneOf: [object({ intent: required(intentSchema), summary: required(strings) }), jobSchema] };
export { reviewSchema, required, text, integer, enumeration, nullable, array, object, strings };

/** Typed canonical values are shared by Native and DSH's generated PTC SDK. */
export function answerSchema(value: ValueSchemaSpec): ValueSchemaSpec {
  return { oneOf: [
    object({ ok: required({ type: "boolean", const: true }), value: required(value), revision: required(integer) }),
    object({ ok: required({ type: "boolean", const: false }), error: required(object({ code: required(text), safeMessage: required(text), retryable: required(boolean), details: { type: "json" } })) }),
  ] };
}

const sourceSchema = object(fields(["id", "title", "url", "page", "figure"]));
const factSchema = object({ ...fields(["id", "claim", "note"]), paragraph: required(integer), disposition: required(enumeration(["supported", "not_applicable"])), sourceIds: required(strings) });
const assetEvidenceSchema = object({ ...fields(["source", "digest", "formulaSource", "note"]), kind: required(enumeration(["original", "formula", "other"])), sourceIds: required(strings) });
const detailsSchema = object({ ...fields(["body", "markdownDigest"]), sources: required(array(sourceSchema)), facts: required(array(factSchema)), paragraphs: required(array(integer)), assets: required(array(assetEvidenceSchema)) });
const versionSchema = object({ ...fields(["id", "revisionDigest", "markdownDigest", "title", "recordedAt"]), current: required(boolean), available: required(boolean) });
export const historySchema = object({ contentRef: required(text), versions: required(array(versionSchema)), notes: required(strings) });
export const comparisonSchema = object({ from: required(versionSchema), to: required(versionSchema), fields: required(array(object(fields(["path", "oldText", "newText"])))), assets: required(array(object({ change: required(enumeration(["added", "removed", "changed"])), before: required(nullable(assetSchema)), after: required(nullable(assetSchema)) }))) });
export const evidenceDetailSchema = object({ ...fields(["id", "revisionDigest", "format", "body"]), current: required(boolean), details: required(nullable(detailsSchema)), coverage: required(nullable(coverageSchema)), image: required(nullable(object({ dataUrl: required(text), width: required(integer), height: required(integer) }))), notes: required(strings) });

export const channelSchema = enumeration(["wechat", "zhihu", "xiaohongshu", "x"]);
export const publicationTypeSchema = enumeration(["article", "video", "image_text"]);
export const mediaPublicationTypeSchema = enumeration(["video", "image_text"]);
export const libraryParameters: ParameterSchemaSpec = {
  query: { ...text, description: "At most 500 characters; title and article tags are searchable." },
  kind: enumeration(["article", "image", "video"]), publicationType: publicationTypeSchema,
  publicationStatus: enumeration(["draft", "ready", "published", "unknown"]), channel: channelSchema,
  category: enumeration(["conference", "arxiv", "other"]), conference: text, year: { ...integer, description: "1900–2099." }, tag: text,
  timeField: enumeration(["updated", "created", "published"]), updatedFrom: { ...text, description: "Inclusive ISO timestamp with timezone for timeField; unknown timestamps do not match." },
  updatedTo: { ...text, description: "Exclusive ISO timestamp with timezone; must be later than updatedFrom." },
  sort: enumeration(["updated_desc", "updated_asc"]), cursor: text, pageSize: { ...integer, description: "1–100; default 40. All filters are bound to nextCursor." },
};
const facetSchema = (value: ValueSchemaSpec): ValueSchemaSpec => object({ value: required(value), count: required(integer) });
const facetsSchema = object({ categories: required(array(facetSchema(enumeration(["conference", "arxiv", "other"])))), conferences: required(array(facetSchema(text))), years: required(array(facetSchema(integer))), tags: required(array(facetSchema(text))) });
export const libraryItemSchema = object({ ...fields(["itemId", "title", "rootLabel", "revisionDigest", "status"]), kind: required(enumeration(["article", "image", "video"])), publicationType: required(nullable(publicationTypeSchema)), publicationStatus: required(enumeration(["draft", "ready", "published", "unknown"])), publications: array(publicationSchema), taxonomy: taxonomySchema, origin: required(enumeration(["workbench", "legacy", "local"])), readOnly: required(boolean), legacyReadOnly: required(boolean), contentRef: required(nullable(text)), publicationRef: text, mappingRef: text, createdAt: nullable(text), publishedAt: nullable(text), mediaType: required(nullable(text)), bytes: required(nullable(integer)), updatedAt: required(nullable(text)) });
export const libraryPageSchema = object({ items: required(array(libraryItemSchema)), facets: facetsSchema, total: required(integer), nextCursor: required(nullable(text)), revisionDigest: required(text), issues: required(strings), truncated: required(boolean) });
export const libraryDetailSchema = object({ item: required(libraryItemSchema), html: required(nullable(text)), markdown: required(nullable(text)), issues: required(strings) });
export const mediaChunkSchema = object({ ...fields(["itemId", "revisionDigest", "mediaType", "dataBase64"]), offset: required(integer), totalBytes: required(integer), eof: required(boolean) });
export const mediaRangeParameters: ParameterSchemaSpec = { itemId: required(text), revisionDigest: required(text), offset: required({ ...integer, description: "Zero-based byte offset; must be inside the current media file." }), length: required({ ...integer, description: "1–262144 bytes; never fetch an entire large file in one tool call." }) };
const publicationSelectionFields: ParameterSchemaSpec = { source: required(enumeration(["library", "draft"])), ...fields(["itemId", "revisionDigest", "caption"]) };
const publicationSelectionSchema = object(publicationSelectionFields);
const publicationAssetSchema = object({ ...publicationSelectionFields, ...fields(["title", "mediaType"]), kind: required(enumeration(["image", "video"])), bytes: required(integer) });
export const publicationEditSchema = object({ title: required({ ...text, description: "Non-empty public title, at most 200 characters." }), body: required({ ...text, description: "Public text, at most 30000 characters." }), media: required({ type: "array", items: publicationSelectionSchema, description: "At most 18 distinct selected assets, in display order; preserve source, itemId and revisionDigest from Host readback." }), coverItemId: required(nullable(text)), channels: required({ type: "array", items: channelSchema, description: "Distinct intended channels, at most four; this does not authorize remote publication." }) });
export const publicationDraftSchema = object({ schemaVersion: required({ type: "string", const: "wemedia.publication-draft/v1" }), ...fields(["contentRef", "title", "body", "revisionDigest", "createdAt", "updatedAt"]), publicationType: required(mediaPublicationTypeSchema), media: required(array(publicationAssetSchema)), coverItemId: required(nullable(text)), channels: required(array(channelSchema)), readOnlySource: required(boolean), issues: required(strings), publications: required(array(publicationSchema)) });
export const publicationDraftPreviewSchema = object({ intent: required(intentSchema), summary: required(strings), publication: required(publicationDraftSchema) });
const batchEntrySchema = object({ ...fields(["contentRef", "code", "safeMessage"]), publicationType: required(nullable(publicationTypeSchema)), revisionDigest: required(nullable(text)), channel: required(channelSchema), status: required(gateStatus), issues: required(strings) });
export const batchPreflightSchema = object({ schemaVersion: required({ type: "string", const: "wemedia.batch-preflight/v1" }), results: required(array(batchEntrySchema)), checkedAt: required(text), cancelled: required(boolean) });

const mappingSourceSchema = object({ ...fields(["sourceRecordId", "title", "rootId", "rootLabel", "digest"]), contentRef: required(nullable(text)) });
const canonicalMappingSchema = object({ ...fields(["sourceRecordId", "sourceDigest", "selectedAt"]), available: required(boolean), stale: required(boolean), currentDigest: required(nullable(text)) });
const variantMappingSchema = object({ ...fields(["sourceRecordId", "derivedFromRecordId", "sourceDigest", "generatedDigest", "mappedAt"]), provenance: required({ type: "string", const: "explicit_mapping" }), channel: required(channelSchema), available: required(boolean), dirty: required(boolean), stale: required(boolean), currentDigest: required(nullable(text)) });
const mappingOperationSchema = enumeration(["select_canonical", "map_variant", "bind", "separate"]);
export const mappingChangeSchema: ValueSchemaSpec = { oneOf: [
  object({ contentRef: required(text), operation: required({ type: "string", const: "select_canonical" }), sourceRecordIds: required(strings) }),
  object({ contentRef: required(text), operation: required({ type: "string", const: "map_variant" }), sourceRecordIds: required(strings), channel: required(channelSchema) }),
  object({ contentRef: required(text), operation: required({ type: "string", const: "bind" }), sourceRecordIds: required(strings) }),
  object({ contentRef: required(text), operation: required({ type: "string", const: "separate" }), sourceRecordIds: required(strings), retainedSourceRecordIds: required(strings) }),
] };
export const mappingViewSchema = object({ schemaVersion: required({ type: "string", const: "wemedia.content-mapping/v1" }), ...fields(["generationId", "contentRef"]), revision: required(integer), canonical: required(nullable(canonicalMappingSchema)), variants: required(array(variantMappingSchema)), sources: required(array(mappingSourceSchema)), total: required(integer), nextCursor: required(nullable(text)), conflicts: required(array(object({ ...fields(["leftRecordId", "rightRecordId"]), evidenceCodes: required(strings) }))), revalidationRequired: required(boolean) });
export const mappingPreviewSchema = object({ ...fields(["intentId", "generationId", "contentRef", "inputDigest", "expiresAt"]), operation: required(mappingOperationSchema), sideEffect: required({ type: "string", const: "local_write" }), expectedRevision: required(integer), expectedChanges: required(strings), sources: required(array(mappingSourceSchema)) });
export const mappingApplySchema = object({ ...fields(["intentId", "contentRef"]), operation: required(mappingOperationSchema), revision: required(integer), detachedContentRefs: required(strings) });

const setupSelectionSchema = object({ rootIds: required(strings), writeRootId: required(nullable(text)) });
const setupCandidateSchema = object({ ...fields(["id", "label"]), available: required(boolean), selected: required(boolean) });
export const setupInspectionSchema = object({ schemaVersion: required({ type: "string", const: "wemedia.setup/v1" }), ...fields(["generationId", "inputDigest"]), roots: required(array(setupCandidateSchema)), writeRoots: required(array(setupCandidateSchema)), selection: required(setupSelectionSchema), dataDirAvailable: required(boolean), issues: required(strings) });
export const setupPreviewSchema = object({ schemaVersion: required({ type: "string", const: "wemedia.setup/v1" }), ...fields(["generationId", "intentId", "inputDigest", "expiresAt"]), sideEffect: required({ type: "string", const: "local_write" }), before: required(setupSelectionSchema), after: required(setupSelectionSchema), changes: required(strings), blockingCodes: required(strings) });
export const setupApplySchema = object({ applied: required({ type: "boolean", const: true }), selection: required(setupSelectionSchema), requiresReconnect: required({ type: "boolean", const: true }) });

export const publishingChannelSchema = enumeration(["zhihu", "xiaohongshu", "x"]);
export const channelActionSchema = enumeration(["prepare", "stage", "publish", "sync"]);
const channelTargetSchema = object({ ...fields(["targetRef", "label", "url", "revisionDigest", "verifiedAt"]), channel: required(publishingChannelSchema), status: required(enumeration(["draft", "published", "reconcile_required"])) });
export const channelInspectionSchema = object({ ...fields(["contentRef", "revisionDigest"]), publicationType: required(publicationTypeSchema), capabilities: required(array(capabilitySchema)), targets: required(array(channelTargetSchema)), jobs: required(array(jobSchema)), matrix: required(array(object(fields(["channel", "publicationType", "action", "status", "reasonCode"])))), issues: required(strings) });
export const channelCheckSchema = object({ ...fields(["contentRef", "revisionDigest"]), channel: required(publishingChannelSchema), configured: required(enumeration(["configured", "missing", "invalid", "unknown"])), permission: required(enumeration(["unknown", "available", "missing"])), gates: required(gateSchema) });
export const channelPreviewSchema = object({ intent: required(intentSchema), channel: required(publishingChannelSchema), action: required(channelActionSchema), publicationType: required(publicationTypeSchema), gates: required(gateSchema), target: required(nullable(channelTargetSchema)), summary: required(strings) });

// Research metadata is deliberately separate from executable channel capabilities.
const platformSourceSchema = object(fields(["label", "url"]));
const platformReferenceSchema = object(fields(["id", "repository", "url", "commit", "license", "reuse"]));
const platformEntrySchema = object({
  ...fields(["id", "name", "summary"]),
  formats: required(array(enumeration(["article", "image_text", "video", "short_text"]))),
  status: required({ type: "string", const: "research_only" }),
  priority: required(enumeration(["first", "later", "restricted"])),
  requirements: required(strings), limitations: required(strings),
  sources: required(array(platformSourceSchema)), referenceIds: required(strings),
});
export const platformCatalogSchema = object({
  schemaVersion: required({ type: "string", const: "wemedia.platform-catalog/v1" }),
  ...fields(["researchedAt", "notice"]),
  platforms: required(array(platformEntrySchema)), references: required(array(platformReferenceSchema)),
});

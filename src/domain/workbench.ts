import type { MappingChangeInput, MappingInspectInput } from "./contentMapping.ts";
import type { SetupSelection } from "./setup.ts";
import type { BatchPreflightRequest } from "./batchPreflight.ts";
import type { PublicationRequest } from "./publicationDraft.ts";
import type { ActionIntent, CapabilityReport, GateReport } from "./capability.ts";
import type { ArtifactRef } from "./content.ts";
import type { Job } from "./job.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { ContentRef } from "./primitives.ts";
import type { PublicationRecord, PublicationSourceSummary } from "./publication.ts";
import type { ArticleTaxonomy } from "./articleTaxonomy.ts";
import type { LibraryDetail, LibraryListInput, LibraryMediaChunk, LibraryMediaInput, LibraryPage } from "./contentLibrary.ts";

export const WORKBENCH_SCHEMA = "wemedia.workbench/v1" as const;
export const DOCUMENT_SCHEMA = "wemedia.wechat-document/v1" as const;
export const BRIDGE_SCHEMA = "wemedia.wechat-bridge/v1" as const;
export const REVIEW_KINDS = ["facts", "editorial", "images_formulas", "mobile_visual"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const WORKBENCH_ACTIONS = ["save_revision", "prepare", "create_draft", "update_draft", "sync"] as const;
export type WorkbenchAction = (typeof WORKBENCH_ACTIONS)[number];

export interface ArticleMetadata extends JsonObject {
  articleId: string;
  title: string;
  author: string;
  digest: string;
  kind: "paper" | "article";
  titlePrefix: string;
  sourceUrl: string;
  pdfUrl: string;
  codeUrl: string;
}

export interface ArticleAsset extends JsonObject {
  source: string;
  artifact: ArtifactRef;
  digest: string;
  mediaType: string;
  kind: "original" | "formula" | "other";
  bytes: number;
}

export interface ReviewCoverage extends JsonObject { paragraphs: number[]; paragraphTotal: number; assets: string[]; assetTotal: number; complete: boolean }

export interface ReviewEvidence extends JsonObject {
  id: string;
  kind: ReviewKind;
  revisionDigest: string;
  artifact: ArtifactRef;
  artifactDigest: string;
  reviewer: "user" | "agent";
  summary: string;
  recordedAt: string;
  valid: boolean;
  coverage?: ReviewCoverage;
}

export interface DraftTarget extends JsonObject {
  targetRef: string;
  label: string;
  title: string;
  sourceUrl: string;
  verifiedRevision: string;
  verifiedAt: string;
}

export interface ArticleDocument extends JsonObject {
  taxonomy?: ArticleTaxonomy;
  contentRef: ContentRef;
  document: ArtifactRef;
  htmlArtifact: ArtifactRef;
  metadata: ArticleMetadata;
  html: string;
  markdown: string;
  revisionDigest: string;
  assets: ArticleAsset[];
  readOnlySource: boolean;
  reviews: ReviewEvidence[];
  targets: DraftTarget[];
  issues: string[];
  workflowImports?: WorkflowMaterial[];
  paragraphs?: string[];
  /** Latest verified local content-file modification time, when the provider knows it. */
  updatedAt?: string | null;
  publications?: PublicationRecord[];
}

/** Reused native diagnostics, never evidence that an Agent reviewed the article. */
export interface AiWorkflowResult extends JsonObject {
  operation: "ai_inspect" | "ai_preview";
  revisionDigest: string;
  mode: "ai";
  sourceKind: "markdown" | "html";
  status: "pass" | "warn" | "block";
  code: string;
  previewFidelity: "exact" | "degraded" | "unavailable";
  issues: import("./capability.ts").GateIssue[];
}

export type WorkflowImportKind = "review" | "draft";
/** Only this projection crosses Tool/RPC. Remote IDs and upload mappings do not. */
export interface WorkflowMaterial extends JsonObject {
  id: string;
  kind: WorkflowImportKind;
  source: ArtifactRef;
  sourceDigest: string;
  sourceFormat: string;
  title: string;
  status: "current" | "partial" | "historical" | "stale";
  boundRevision: string;
  boundHtmlDigest: string;
  reviewKind: ReviewKind | null;
  findings: string[];
  warnings: string[];
  recordedAt: string;
}

export interface WorkflowImportPreview extends JsonObject {
  intent: ActionIntent;
  kind: WorkflowImportKind;
  material: WorkflowMaterial;
  requiresIdentityCheck: boolean;
  summary: string[];
}

export interface ArticleEdit extends JsonObject {
  metadata: ArticleMetadata;
  html: string;
  markdown: string;
}

export interface WorkbenchContentSummary extends JsonObject {
  taxonomy?: ArticleTaxonomy;
  contentRef: ContentRef;
  title: string;
  articleId: string;
  rootLabel: string;
  channel: "wechat";
  readOnlySource: boolean;
  status: "discovered" | "drafting" | "needs_review" | "ready" | "draft_verified" | "needs_revalidation";
  issueCount: number;
  updatedAt?: string | null;
  publications?: PublicationRecord[];
}

export interface WorkbenchPage extends JsonObject {
  items: WorkbenchContentSummary[];
  total: number;
  nextCursor: string | null;
  revision: number;
}

export interface WorkbenchSettings extends JsonObject {
  roots: Array<{ id: string; label: string; mode: "read" | "write"; available: boolean }>;
  hasWriteRoot: boolean;
  hasDataDir: boolean;
  approvalAvailable: boolean;
  issues: string[];
}

export interface WorkbenchSnapshot extends JsonObject {
  schemaVersion: typeof WORKBENCH_SCHEMA;
  generationId: string;
  revision: number;
  settings: WorkbenchSettings;
  capabilities: CapabilityReport[];
  jobs: WorkbenchJob[];
  supportedChannels: string[];
  publicationSources?: PublicationSourceSummary;
}

export interface WorkbenchJob extends Job {
  contentRef: ContentRef;
  intentId: string;
  inputDigest: string;
  resultCode?: string;
}

export interface ActionPreview extends JsonObject {
  intent: ActionIntent;
  action: WorkbenchAction;
  gates: GateReport;
  target: DraftTarget | null;
  summary: string[];
}

export interface PreviewDocument extends JsonObject {
  revisionDigest: string;
  html: string;
  width: number;
  imageCount: number;
  issues: string[];
}

export interface TaskBrief extends JsonObject {
  contentRef: ContentRef;
  action: "research" | "write_draft" | "review";
  revisionDigest: string;
  prompt: string;
}

export type WorkbenchRequest = import("./draftBatch.ts").DraftBatchRequest | import("./references.ts").ReferenceRequest | import("./accounts.ts").AccountRequest | import("./channelPublishing.ts").ChannelRequest | PublicationRequest | BatchPreflightRequest
  | ({ operation: "mapping_inspect" } & MappingInspectInput)
  | { operation: "mapping_preview"; change: MappingChangeInput }
  | { operation: "mapping_apply"; intentId: string }
  | { operation: "platform_catalog" }
  | { operation: "article_templates" }
  | { operation: "setup_inspect" }
  | ({ operation: "setup_preview" } & SetupSelection)
  | { operation: "setup_apply"; intentId: string }
  | { operation: "snapshot" | "refresh" }
  | ({ operation: "library_list" } & LibraryListInput)
  | { operation: "library_read"; itemId: string }
  | ({ operation: "library_media" } & LibraryMediaInput)
  | { operation: "search"; query: string; cursor?: string; pageSize?: number }
  | { operation: "inspect" | "preflight" | "preview" | "ai_inspect" | "ai_preview"; contentRef: ContentRef }
  | { operation: "history"; contentRef: ContentRef }
  | { operation: "compare_versions"; contentRef: ContentRef; fromId: string; toId: string }
  | { operation: "evidence_detail"; contentRef: ContentRef; evidenceId: string }
  | { operation: "preview_workflow_import"; contentRef: ContentRef; kind: WorkflowImportKind; artifact: ArtifactRef }
  | { operation: "apply_workflow_import"; intentId: string }
  | { operation: "task_brief"; contentRef: ContentRef; action: TaskBrief["action"] }
  | { operation: "preview_action"; contentRef: ContentRef; action: WorkbenchAction; targetRef?: string; edit?: ArticleEdit }
  | { operation: "start_action"; intentId: string }
  | { operation: "get_job" | "cancel_job"; jobId: string }
  | { operation: "record_review"; contentRef: ContentRef; kind: ReviewKind; revisionDigest: string; artifact: ArtifactRef; summary: string }
  | { operation: "create_content"; title: string; sourceUrl: string; kind: ArticleMetadata["kind"]; templateId?: import("./articleTemplates.ts").ArticleTemplateId; applyIntentId?: string };

export type WorkbenchValue = WorkbenchSnapshot | WorkbenchPage | LibraryPage | LibraryDetail | LibraryMediaChunk | ArticleDocument | GateReport | ActionPreview | WorkbenchJob | PreviewDocument | TaskBrief | AiWorkflowResult | WorkflowImportPreview | JsonObject;

export type WorkbenchAnswer =
  | { ok: true; value: WorkbenchValue; revision: number }
  | { ok: false; error: { code: string; safeMessage: string; retryable: boolean; details?: JsonValue } };

export interface WorkbenchCaller {
  /** Set only by the Host integration, never copied from RPC request data. */
  kind: "user" | "agent";
  sessionId?: string;
  callId?: string;
}

export { WorkbenchFault } from "./workbenchFault.ts";

import type { VersionHistory, VersionComparison, EvidenceDetail } from "../domain/inspection.ts";
import type { ActionIntent, AdapterResult, GateReport } from "../domain/capability.ts";
import type { ArtifactRef } from "../domain/content.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type {
  ArticleDocument, ArticleEdit, ArticleMetadata, DraftTarget, PreviewDocument,
  ReviewEvidence, WorkbenchContentSummary, WorkbenchJob, WorkbenchSettings, AiWorkflowResult,
  WorkflowImportKind, WorkflowMaterial,
} from "../domain/workbench.ts";
import type { JsonObject } from "../domain/json.ts";
import type { ApprovalBridge } from "./approval.ts";
import type { SourceRecord } from "../domain/content.ts";
import type { OverlayV1 } from "../domain/schema.ts";

export interface WorkbenchDocuments {
  refresh(): Promise<void>;
  revision(): number;
  list(): Promise<WorkbenchContentSummary[]>;
  read(contentRef: ContentRef): Promise<ArticleDocument>;
  preview(contentRef: ContentRef): Promise<PreviewDocument>;
  history?(contentRef: ContentRef): Promise<VersionHistory>;
  compareVersions?(contentRef: ContentRef, fromId: string, toId: string): Promise<VersionComparison>;
  evidenceDetail?(contentRef: ContentRef, evidenceId: string): Promise<EvidenceDetail>;
  settings(): WorkbenchSettings;
  create(input: { contentRef: ContentRef; metadata: ArticleMetadata }): Promise<ArticleDocument>;
  editAssets?(document: ArticleDocument, edit: ArticleEdit): Promise<ArticleDocument["assets"]>;
  saveRevision(contentRef: ContentRef, expectedDigest: string, edit: ArticleEdit, expectedAssets?: ArticleDocument["assets"]): Promise<ArticleDocument>;
  prepare(document: ArticleDocument, jobId: string): Promise<ArtifactRef[]>;
  recordReview(contentRef: ContentRef, evidence: Pick<ReviewEvidence, "kind" | "revisionDigest" | "artifact" | "reviewer" | "summary">): Promise<ReviewEvidence>;
  persistRemoteResult(document: ArticleDocument, result: AdapterResult, target: DraftTarget | null): Promise<void>;
  restoreMissingRemoteUploads?(document: ArticleDocument, result: WorkbenchRemoteResult, targetRef: string, accountRef: string): Promise<void>;
  previewWorkflowImport?(contentRef: ContentRef, kind: WorkflowImportKind, artifact: ArtifactRef): Promise<WorkflowImportCandidate>;
  commitWorkflowImport?(contentRef: ContentRef, candidate: WorkflowImportCandidate, reviewer: "user" | "agent", identity?: { accountRef: string; verifiedAt: string }, signal?: AbortSignal, assertCurrent?: () => void): Promise<ArticleDocument>;
}

/** Host-private import data. Never serialize this object at the API boundary. */
export interface WorkflowImportCandidate {
  revisionDigest: string;
  material: WorkflowMaterial;
  dependencies?: Array<{ artifact: ArtifactRef; digest: string }>;
  target?: { mediaId: string; title: string; sourceUrl: string; uploads: JsonObject[] };
}

export interface WorkbenchCatalog {
  refresh(overlay: OverlayV1): Promise<{ sources: SourceRecord[]; bindings: Record<string, ContentRef>; issues: string[]; mappingSources?: SourceRecord[]; components?: Array<{ contentRef: ContentRef; sourceRecordIds: string[]; identitySetDigest: string; conflicts: Array<{ leftRecordId: string; rightRecordId: string; evidenceCodes: string[] }> }>; manualDecisions?: OverlayV1["manualDecisions"] }>;
}

export interface WorkbenchRemoteResult extends AdapterResult {
  revisionDigest?: string;
  verifiedAt?: string;
  uploads?: Array<{ source: string; sha256: string; media_id: string; wechat_url: string }>;
  reconcileRequired?: boolean;
}

export interface WorkbenchAdapter {
  discover(signal: AbortSignal): Promise<import("../domain/capability.ts").CapabilityReport>;
  accountRef(): string | undefined;
  check(document: ArticleDocument, signal: AbortSignal): Promise<GateReport>;
  run(action: "create_draft" | "update_draft" | "sync", document: ArticleDocument, target: DraftTarget | null, signal: AbortSignal): Promise<WorkbenchRemoteResult>;
  inspectAi?(operation: "ai_inspect" | "ai_preview", document: ArticleDocument, signal: AbortSignal): Promise<AiWorkflowResult>;
  verifyDraftIdentity?(document: ArticleDocument, target: { mediaId: string; title: string; sourceUrl: string }, signal: AbortSignal): Promise<{ ok: boolean; code: string; accountRef?: string; verifiedAt?: string }>;
}

export interface WorkbenchJobs {
  loadAll(): Promise<WorkbenchJob[]>;
  save(job: WorkbenchJob): Promise<void>;
}

export interface WorkbenchQuality {
  check(document: ArticleDocument, signal: AbortSignal): Promise<GateReport>;
}

export interface WorkbenchHasher {
  digest(value: string): string;
}

export interface WorkbenchApprovalProvider {
  available(): boolean;
  forCaller(caller: { kind: "user" | "agent"; sessionId?: string; callId?: string }): ApprovalBridge | undefined;
}

export interface IntentApproval {
  intent: ActionIntent;
  reference: string;
}

import type { GateReport } from "../domain/capability.ts";
import type { ArtifactRef } from "../domain/content.ts";
import { REVIEW_KINDS, type AiWorkflowResult, type ArticleDocument, type ReviewEvidence, type ReviewKind, type WorkflowImportKind, type WorkflowMaterial } from "../domain/workbench.ts";

export interface SourceLinkView {
  label: string;
  href: string | null;
  status: "ready" | "missing" | "unsupported";
  description: string;
}

export interface MaterialView {
  name: string;
  kind: string;
  mediaType: string;
  size: string;
  artifact: string;
  digest: string;
}

export interface ReviewCategoryView {
  kind: ReviewKind;
  label: string;
  currentCount: number;
  staleCount: number;
}

export interface ReviewRecordView {
  id: string;
  category: string;
  current: boolean;
  reviewer: string;
  recordedAt: string;
  summary: string;
  revisionDigest: string;
  artifactDigest: string;
  artifact: string;
}

export interface AiWorkflowView {
  operation: "ai_inspect" | "ai_preview";
  operationLabel: string;
  sourceKind: "markdown" | "html";
  sourceKindLabel: string;
  status: AiWorkflowResult["status"];
  statusLabel: string;
  previewFidelity: AiWorkflowResult["previewFidelity"];
  previewFidelityLabel: string;
  revisionDigest: string;
  issues: Array<{ code: string; status: "pass" | "warn" | "block"; message: string }>;
  note: string;
}

export interface WorkflowMaterialView {
  id: string;
  kind: WorkflowImportKind;
  kindLabel: string;
  title: string;
  source: string;
  sourceFormat: string;
  status: WorkflowMaterial["status"];
  statusLabel: string;
  statusNote: string;
  boundRevision: string;
  boundHtmlDigest: string;
  currentRevision: boolean;
  findings: string[];
  warnings: string[];
  recordedAt: string;
}

const reviewLabels: Record<ReviewKind, string> = {
  facts: "资料与事实",
  editorial: "中文编辑",
  images_formulas: "原图与公式",
  mobile_visual: "390px 移动视觉",
};

const assetLabels = {
  original: "原图（来源标注）",
  formula: "公式（来源标注）",
  other: "来源类别未标注",
} as const;

/** These are user-activated links only; the Client never fetches source URLs. */
export function safeHttpsLink(value: string): string | null {
  const input = value.trim();
  if (!/^https:\/\//i.test(input) || /[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function sourceLink(label: string, value: string): SourceLinkView {
  const href = safeHttpsLink(value);
  return href
    ? { label, href, status: "ready", description: new URL(href).hostname }
    : { label, href: null, status: value.trim() ? "unsupported" : "missing", description: value.trim() ? "仅展示无凭据的 HTTPS 链接" : "未记录" };
}

/** Artifact references remain labels, never file URLs or machine paths. */
export function relativeArtifactLabel(artifact: ArtifactRef): string {
  const { rootId, relativePath } = artifact;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rootId) || !relativePath
    || /[\\:\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(relativePath)
    || relativePath.split("/").some(segment => !segment || segment === "." || segment === "..")) return "材料引用不可展示";
  return `${rootId}:${relativePath}`;
}

export function formatAssetBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isInteger(bytes)) return "大小未记录";
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? "KB" : "MB";
  const value = bytes / (unit === "KB" ? 1024 : 1024 * 1024);
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function articleMaterialsModel(document: ArticleDocument): {
  author: string;
  kind: string;
  sources: SourceLinkView[];
  sourceArtifact: string;
  htmlArtifact: string;
  sourceNote: string;
  assets: MaterialView[];
} {
  const { metadata } = document;
  return {
    author: metadata.author.trim() || "未记录作者",
    kind: metadata.kind === "paper" ? "论文解读" : "文章",
    sources: [sourceLink("第一手来源", metadata.sourceUrl), sourceLink("论文 PDF", metadata.pdfUrl), sourceLink("代码仓库", metadata.codeUrl)],
    sourceArtifact: relativeArtifactLabel(document.document),
    htmlArtifact: relativeArtifactLabel(document.htmlArtifact),
    sourceNote: document.readOnlySource
      ? "来源文件只读。保存编辑会创建独立修订，不覆盖原始文件。"
      : "当前文章位于独立写入区。再次保存仍会创建新修订，已有审读记录需重新匹配版本。",
    assets: document.assets.map((asset, index) => {
      const artifact = relativeArtifactLabel(asset.artifact);
      return {
        name: artifact === "材料引用不可展示" ? `素材 ${index + 1}` : asset.artifact.relativePath.split("/").at(-1)!,
        kind: assetLabels[asset.kind],
        mediaType: asset.mediaType || "媒体类型未记录",
        size: formatAssetBytes(asset.bytes),
        artifact,
        digest: asset.digest,
      };
    }),
  };
}

function currentReview(review: ReviewEvidence, revisionDigest: string): boolean {
  // A matching digest cannot promote an invalid Host record into valid evidence.
  return review.valid && review.revisionDigest === revisionDigest;
}

export function articleReviewsModel(document: ArticleDocument): {
  categories: ReviewCategoryView[];
  records: ReviewRecordView[];
} {
  return {
    categories: REVIEW_KINDS.map(kind => {
      const records = document.reviews.filter(review => review.kind === kind);
      const currentCount = records.filter(review => currentReview(review, document.revisionDigest)).length;
      return { kind, label: reviewLabels[kind], currentCount, staleCount: records.length - currentCount };
    }),
    records: document.reviews.map(review => ({
      id: review.id,
      category: reviewLabels[review.kind],
      current: currentReview(review, document.revisionDigest),
      reviewer: review.reviewer === "user" ? "用户" : "Agent",
      recordedAt: Number.isNaN(Date.parse(review.recordedAt)) ? "记录时间格式无法识别" : review.recordedAt,
      summary: review.summary.trim() || "未填写审读摘要",
      revisionDigest: review.revisionDigest,
      artifactDigest: review.artifactDigest,
      artifact: relativeArtifactLabel(review.artifact),
    })),
  };
}

const workflowKindLabels: Record<WorkflowImportKind, string> = { review: "旧审阅报告", draft: "已有草稿摘要" };
const workflowStatusLabels: Record<WorkflowMaterial["status"], string> = {
  current: "当前版本材料",
  partial: "部分导入",
  historical: "历史材料",
  stale: "版本过期",
};
const workflowStatusNotes: Record<WorkflowMaterial["status"], string> = {
  current: "已绑定当前版本；不代表四类审阅均已通过。",
  partial: "材料不完整；不代表四类审阅均已通过。",
  historical: "这是历史记录，需要重新绑定当前版本。",
  stale: "绑定版本已变化，需要重新导入。",
};

export function workflowMaterialsModel(document: ArticleDocument): WorkflowMaterialView[] {
  return (document.workflowImports ?? []).map(material => ({
    id: material.id,
    kind: material.kind,
    kindLabel: workflowKindLabels[material.kind],
    title: material.title.trim() || "未命名导入材料",
    source: relativeArtifactLabel(material.source),
    sourceFormat: material.sourceFormat.trim() || "格式未记录",
    status: material.status,
    statusLabel: workflowStatusLabels[material.status],
    statusNote: workflowStatusNotes[material.status],
    boundRevision: material.boundRevision,
    boundHtmlDigest: material.boundHtmlDigest,
    currentRevision: material.boundRevision === document.revisionDigest,
    findings: material.findings.map(value => value.trim()).filter(Boolean),
    warnings: material.warnings.map(value => value.trim()).filter(Boolean),
    recordedAt: Number.isNaN(Date.parse(material.recordedAt)) ? "记录时间格式无法识别" : material.recordedAt,
  }));
}

const workflowStatusViewLabels: Record<AiWorkflowResult["status"], string> = { pass: "诊断通过", warn: "诊断提醒", block: "诊断阻断" };
const fidelityLabels: Record<AiWorkflowResult["previewFidelity"], string> = { exact: "精确预览", degraded: "降级预览", unavailable: "预览不可用" };

export function aiWorkflowModel(result: AiWorkflowResult | null): AiWorkflowView | null {
  if (!result) return null;
  return {
    operation: result.operation,
    operationLabel: result.operation === "ai_inspect" ? "AI 检查" : "AI 预览",
    sourceKind: result.sourceKind,
    sourceKindLabel: result.sourceKind === "html" ? "HTML 正文" : "Markdown 原稿",
    status: result.status,
    statusLabel: workflowStatusViewLabels[result.status],
    previewFidelity: result.previewFidelity,
    previewFidelityLabel: fidelityLabels[result.previewFidelity],
    revisionDigest: result.revisionDigest,
    issues: result.issues.map(issue => ({ code: issue.code, status: issue.status, message: issue.safeMessage })),
    note: "这是 AI 原生诊断，不计入审阅记录、事实核验或最终图像验收。",
  };
}

export function defaultWorkflowImportArtifact(document: ArticleDocument, kind: WorkflowImportKind): ArtifactRef {
  const rootId = document.document.rootId;
  if (kind !== "draft" || !/^AAAI26-/i.test(document.metadata.articleId)) return { rootId, relativePath: "" };
  const parts = document.document.relativePath.split("/");
  parts.pop();
  const directory = parts.join("/");
  return { rootId, relativePath: `${directory ? `${directory}/` : ""}platform/aaai2026-agent-draft-summary.json` };
}

const documentMessages: Record<string, string> = {
  IMAGE_UNAVAILABLE: "有图片未能读取或解析。请核对图片相对路径、文件格式与可用性。",
  TARGET_BINDING_INVALID: "草稿目标绑定包含无效记录。请先核对草稿身份，再准备更新操作。",
};

export function documentIssueView(issue: string): { message: string; code: string | null } {
  if (!/^[A-Z][A-Z0-9_]*$/.test(issue)) return { message: issue, code: null };
  return { message: documentMessages[issue] ?? "文章材料存在待处理问题。请查看问题代码，并交给 Agent 核对。", code: issue };
}

export const gateStatusLabel = (status: GateReport["status"]): string => ({ pass: "通过", warn: "提醒", block: "阻断" })[status];

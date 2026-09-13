import { isJsonObject } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { safeRelativeFile, SHA256_PATTERN } from "./wechatDocument.ts";
import { REVIEW_KINDS, WorkbenchFault } from "./workbench.ts";
import type { ArticleDocument, ReviewKind, WorkflowMaterial } from "./workbench.ts";

export const WORKFLOW_PRIVATE = /file:\/\/|\/(?:Users|Volumes|private|var|tmp|home|root|etc|mnt|media|srv|run)(?:\/|\b)|(?:^|[\s"'=])~\/|\b[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@|\b(?:access[_-]?token|token|secret|password|cookie|authorization|api[_-]?key)["']?\s*[:=]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const AAAI26_ARTICLE = /^aaai26-(\d+)$/iu;
const UPLOAD_MAP_SUFFIX = ".upload-map.json";
const CHECK = /^[a-z][a-z0-9_]{0,99}$/u;
export const READBACK_CHECKS = ["present", "title_matches", "topic_prefix_present", "digest_matches", "digest_plain_text", "content_text_matches", "result_table_count_matches", "result_table_cells_match", "content_deep", "image_count_matches", "images_uploaded", "images_match_approved_uploads", "image_upload_map_count_matches", "source_url_matches", "official_page_url_visible", "official_pdf_url_visible", "code_url_visible_or_not_required", "cover_present", "developer_notes_absent", "local_paths_absent"];
const invalid = (): never => { throw new WorkbenchFault("WORKFLOW_FORMAT_UNSUPPORTED", "材料格式、文章身份或核验依据不受支持；未导入任何通过结论"); };
export const safeWorkflowText = (value: unknown, max = 2000): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) && !WORKFLOW_PRIVATE.test(value);
const safeText = safeWorkflowText;
const digest = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : typeof value === "string" && SHA256_PATTERN.test(value) ? value : invalid();
function uniqueArticle(rows: unknown, articleId: string, withMedia = false): JsonObject {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) return invalid();
  const ids = new Set<string>(), media = new Set<string>();
  for (const row of rows) {
    if (!isJsonObject(row) || typeof row.article_id !== "string" || !ID.test(row.article_id) || ids.has(row.article_id)) return invalid();
    ids.add(row.article_id);
    if (withMedia) {
      if (typeof row.media_id !== "string" || !ID.test(row.media_id) || row.media_id.includes("..") || media.has(row.media_id)) return invalid();
      media.add(row.media_id);
    }
  }
  return rows.find(row => isJsonObject(row) && row.article_id === articleId) as JsonObject ?? invalid();
}
function booleans(value: unknown): string[] {
  if (!isJsonObject(value) || !Object.keys(value).length || Object.keys(value).length > 100) return invalid();
  return Object.entries(value).filter(([key, pass]) => CHECK.test(key) && typeof pass === "boolean").map(([key, pass]) => `${key}: ${pass ? "pass" : "needs_review"}`).slice(0, 50);
}
export function validateNativeReview(report: unknown, kind: ReviewKind, revisionDigest: string): string[] {
  if (!isJsonObject(report) || report.schemaVersion !== "wemedia.review/v1" || report.kind !== kind || kind === "mobile_visual" || report.revisionDigest !== revisionDigest || report.verdict !== "pass" || !Array.isArray(report.findings) || !report.findings.length || report.findings.length > 100 || !report.findings.every(value => safeText(value)) || WORKFLOW_PRIVATE.test(JSON.stringify(report))) return invalid();
  return report.findings as string[];
}
export interface ParsedWorkflow {
  sourceFormat: string; status: WorkflowMaterial["status"]; boundRevision: string; boundHtmlDigest: string;
  reviewKind: ReviewKind | null; findings: string[]; warnings: string[];
  target?: { mediaId: string; title: string; sourceUrl: string; uploadMapFile?: string };
}
/** Known legacy shapes only. Raw diagnostics, paths and remote IDs stay private. */
export function parseWorkflowReport(raw: unknown, document: ArticleDocument, htmlDigest: string, kind: "review" | "draft"): ParsedWorkflow {
  if (!isJsonObject(raw)) return invalid();
  const result: ParsedWorkflow = { sourceFormat: "", status: "historical", boundRevision: "", boundHtmlDigest: "", reviewKind: null, findings: [], warnings: [] };
  if (kind === "draft") {
    if (raw.schema !== "aaai2026-agent-draft-summary.v1" || raw.conference !== "AAAI 2026" || !safeText(raw.batch, 150) || !Array.isArray(raw.results) || raw.article_count !== raw.results.length) return invalid();
    const row = uniqueArticle(raw.results, document.metadata.articleId, true);
    const article = AAAI26_ARTICLE.exec(document.metadata.articleId);
    let url: URL;
    try { url = new URL(document.metadata.sourceUrl); } catch { return invalid(); }
    if (!article || url.protocol !== "https:" || url.hostname !== "ojs.aaai.org" || url.pathname !== `/index.php/AAAI/article/view/${article[1]}` || url.search || url.hash || url.username || url.password || !safeText(row.title, 200)) return invalid();
    if (row.upload_map !== undefined && (!safeRelativeFile(row.upload_map) || !row.upload_map.endsWith(".json"))) return invalid();
    const uploadMapFile = typeof row.upload_map === "string" ? row.upload_map.split("/").at(-1)! : undefined;
    // Old manifests use uppercase article IDs with lowercase file prefixes.
    // Keep the row identity exact and retain the declared filename; only the
    // known AAAI26 prefix may vary in case, never the paper number or suffix.
    const uploadMapArticle = uploadMapFile?.endsWith(UPLOAD_MAP_SUFFIX) ? AAAI26_ARTICLE.exec(uploadMapFile.slice(0, -UPLOAD_MAP_SUFFIX.length)) : null;
    if (uploadMapFile && uploadMapArticle?.[1] !== article[1]) return invalid();
    return { ...result, sourceFormat: raw.schema, boundRevision: document.revisionDigest, warnings: ["DRAFT_IDENTITY_READ_REQUIRED", "REMOTE_CONTENT_NOT_VERIFIED", ...(uploadMapFile ? ["UPLOAD_MAP_RESOLVED_BESIDE_SUMMARY"] : ["UPLOAD_MAP_MISSING"])], findings: ["旧摘要中找到唯一文章与草稿身份；旧 created / updated 字段不是本次操作结果"], target: { mediaId: row.media_id as string, title: row.title, sourceUrl: document.metadata.sourceUrl, ...(uploadMapFile ? { uploadMapFile } : {}) } };
  }
  if (raw.schemaVersion === "wemedia.review/v1") {
    if (!REVIEW_KINDS.includes(raw.kind as ReviewKind) || raw.kind === "mobile_visual") return invalid();
    const boundRevision = digest(raw.revisionDigest);
    const findings = validateNativeReview(raw, raw.kind as ReviewKind, boundRevision);
    return { ...result, sourceFormat: "wemedia.review/v1", status: boundRevision === document.revisionDigest ? "current" : "stale", boundRevision, reviewKind: raw.kind as ReviewKind, findings, warnings: boundRevision === document.revisionDigest ? [] : ["REVIEW_REVISION_STALE"] };
  }
  if (raw.schema === "aaai2026-agent-draft-readback.v1") {
    const row = uniqueArticle(raw.checks, document.metadata.articleId, true);
    const boundRevision = digest(row.expected_revision_sha256);
    if (!isJsonObject(row.checks) || Object.keys(row.checks).length !== READBACK_CHECKS.length || !READBACK_CHECKS.every(key => typeof row.checks === "object" && row.checks !== null && isJsonObject(row.checks) && typeof row.checks[key] === "boolean")) return invalid();
    const complete = row.ok === true && READBACK_CHECKS.every(key => isJsonObject(row.checks) && row.checks[key] === true);
    return { ...result, sourceFormat: raw.schema, boundRevision, status: boundRevision !== document.revisionDigest ? "stale" : complete ? "current" : "partial", findings: booleans(row.checks), warnings: ["REMOTE_READBACK_NOT_REFRESHED", "NOT_HUMAN_REVIEW_EVIDENCE"] };
  }
  if (raw.schema === "justagent.conference-agent-mobile-390-static.v1") {
    const row = uniqueArticle(raw.articles, document.metadata.articleId);
    if (raw.viewport_width !== 390 || row.viewport_width !== 390 || !isJsonObject(row.checks)) return invalid();
    digest(row.css_sha256);
    return { ...result, sourceFormat: raw.schema, findings: booleans(row.checks), warnings: ["STATIC_REPORT_IS_NOT_SCREENSHOT", "ARTICLE_REVISION_NOT_BOUND"] };
  }
  if (raw.schema === undefined && raw.schemaVersion === undefined && raw.article_id === document.metadata.articleId && safeText(raw.generated_at, 40) && typeof raw.ok === "boolean" && Array.isArray(raw.source_tables) && Array.isArray(raw.image_checks) && Array.isArray(raw.formula_errors)) {
    const boundHtmlDigest = digest(raw.content_sha256);
    return { ...result, sourceFormat: "codex-editorial-content-sha256", boundHtmlDigest, status: boundHtmlDigest === htmlDigest ? "partial" : "stale", findings: booleans(raw.checks), warnings: ["HTML_ONLY_NOT_FULL_REVISION", "CURRENT_REVIEW_CONFIRMATION_REQUIRED"] };
  }
  return invalid();
}

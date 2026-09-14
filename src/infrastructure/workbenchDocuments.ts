import type { PublicationReader } from "../ports/publication.ts";
import { classifyArticle, isTaxonomyLabel, readArticleFrontmatter } from "../domain/articleTaxonomy.ts";
import { articleWorkflowStatus } from "../domain/articleWorkflowStatus.ts";
import type { PublicationRecord } from "../domain/publication.ts";
import { articleChannelDocument, channelDocumentPayload } from "../domain/channelDocument.ts";
import { articleParagraphs, decodeReviewDetails, reviewCoverage } from "../domain/inspection.ts";
import type { EvidenceDetail, VersionHistory, VersionComparison } from "../domain/inspection.ts";
import { versionRecord, storedVersions, summarizeVersion, compareDocuments, screenshotProjection } from "./workbenchInspection.ts";
import type { StoredVersion } from "./workbenchInspection.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import type { ArtifactRef, SourceRecord } from "../domain/content.ts";
import { isJsonObject } from "../domain/json.ts";
import type { JsonObject } from "../domain/json.ts";
import type { ContentRef } from "../domain/primitives.ts";
import { parseContentRef } from "../domain/primitives.ts";
import { decodeArticleMetadata, decodeWechatDocument, htmlImageSources, rewriteImageSources, revisionPayload, safeRelativeFile, safeWebUrl, SHA256_PATTERN } from "../domain/wechatDocument.ts";
import { DOCUMENT_SCHEMA, REVIEW_KINDS, WorkbenchFault } from "../domain/workbench.ts";
import type { ArticleDocument, ArticleEdit, ArticleMetadata, DraftTarget, ReviewEvidence, WorkbenchContentSummary, WorkbenchSettings, WorkflowImportKind, WorkflowMaterial } from "../domain/workbench.ts";
import { READBACK_CHECKS, parseWorkflowReport, safeWorkflowText, validateNativeReview, WORKFLOW_PRIVATE } from "../domain/workflowImport.ts";
import type { WorkbenchCatalog, WorkbenchDocuments, WorkbenchRemoteResult, WorkflowImportCandidate } from "../ports/workbench.ts";
import type { RootCapability } from "./pathPolicy.ts";
import { resolveCreateTarget, resolveReadablePath } from "./pathPolicy.ts";
import { WorkbenchStore } from "./workbenchStore.ts";

export const sha256 = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const PRIVATE = /file:\/\/|\/(?:Users|Volumes|private|var\/folders|tmp)\/|\b[A-Za-z]:[\\/]|(?:access[_-]?token|secret|cookie|authorization|api[_-]?key)\s*[:=]\s*["']?[\w.-]{8,}/iu;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TARGET_FIELDS = ["targetRef", "mediaId", "title", "sourceUrl", "verifiedRevision", "verifiedAt"] as const;
const UPLOAD_FIELDS = ["source", "sha256", "media_id", "wechat_url"] as const;
const MAX_REMOTE_RECORDS = 500;
const WORKFLOW_FORMATS = new Set(["wemedia.review/v1", "aaai2026-agent-draft-summary.v1", "aaai2026-agent-draft-readback.v1", "justagent.conference-agent-mobile-390-static.v1", "codex-editorial-content-sha256"]);
const WORKFLOW_FIELDS = new Set(["id", "kind", "source", "sourceDigest", "sourceFormat", "title", "status", "boundRevision", "boundHtmlDigest", "reviewKind", "findings", "warnings", "recordedAt"]);
function fail(code: string, message: string): never { throw new WorkbenchFault(code, message); }

function declaresTags(metadata: Record<string, unknown>): boolean {
  return ["tags", "keywords", "topics", "agent_topic_full", "topic_label", "agent_topic_short", "agent_topic_key"].some(key => Object.hasOwn(metadata, key));
}

function sameFileState(before: BigIntStats, after: BigIntStats): boolean {
  return before.isFile() && after.isFile() && before.ino !== 0n && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mode === after.mode && before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

type StoredTarget = Pick<DraftTarget, "targetRef" | "title" | "sourceUrl" | "verifiedRevision" | "verifiedAt"> & { mediaId: string };
function storedTarget(value: unknown): StoredTarget | undefined {
  if (!isJsonObject(value) || Object.keys(value).length !== TARGET_FIELDS.length || Object.keys(value).some(key => !TARGET_FIELDS.includes(key as typeof TARGET_FIELDS[number]))) return;
  if (typeof value.targetRef !== "string" || !OPAQUE_ID.test(value.targetRef) || typeof value.mediaId !== "string" || !OPAQUE_ID.test(value.mediaId)) return;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.title) || PRIVATE.test(value.title)) return;
  if (typeof value.sourceUrl !== "string" || value.sourceUrl.length > 2048 || value.sourceUrl !== value.sourceUrl.trim() || /[\u0000-\u001f\u007f]/u.test(value.sourceUrl) || PRIVATE.test(value.sourceUrl) || !safeWebUrl(value.sourceUrl, true)) return;
  if (value.verifiedRevision === "" ? value.verifiedAt !== "" : typeof value.verifiedRevision !== "string" || !SHA256_PATTERN.test(value.verifiedRevision) || !isTimestamp(value.verifiedAt)) return;
  return { targetRef: value.targetRef, mediaId: value.mediaId, title: value.title, sourceUrl: value.sourceUrl, verifiedRevision: value.verifiedRevision as string, verifiedAt: value.verifiedAt as string };
}
function storedTargets(saved: JsonObject): StoredTarget[] {
  if (!Array.isArray(saved.targets) || saved.targets.length > MAX_REMOTE_RECORDS) return [];
  const candidates = saved.targets.map(storedTarget).filter((value): value is StoredTarget => value !== undefined);
  const counts = new Map<string, number>();
  // Duplicate raw refs are ambiguous even if only one of the records validates.
  for (const raw of saved.targets) if (isJsonObject(raw) && typeof raw.targetRef === "string") counts.set(raw.targetRef, (counts.get(raw.targetRef) ?? 0) + 1);
  return candidates.filter(value => counts.get(value.targetRef) === 1);
}
function publicTarget(value: StoredTarget): DraftTarget {
  return { targetRef: value.targetRef, label: `微信草稿 · ${value.title}`, title: value.title, sourceUrl: value.sourceUrl, verifiedRevision: value.verifiedRevision, verifiedAt: value.verifiedAt };
}
function storedUploads(saved: JsonObject): JsonObject[] {
  if (saved.uploads === undefined) return [];
  if (!Array.isArray(saved.uploads) || saved.uploads.length > MAX_REMOTE_RECORDS) fail("UPLOAD_STATE_INVALID", "本地图片上传映射无法安全验证，请先核对草稿状态");
  const uploads: JsonObject[] = [];
  for (const value of saved.uploads) {
    if (!isJsonObject(value) || Object.keys(value).length !== UPLOAD_FIELDS.length || Object.keys(value).some(key => !UPLOAD_FIELDS.includes(key as typeof UPLOAD_FIELDS[number])) || !safeRelativeFile(value.source) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) || typeof value.media_id !== "string" || !OPAQUE_ID.test(value.media_id) || typeof value.wechat_url !== "string" || value.wechat_url.length > 4096 || value.wechat_url !== value.wechat_url.trim() || /[\u0000-\u001f\u007f]/u.test(value.wechat_url)) fail("UPLOAD_STATE_INVALID", "本地图片上传映射无法安全验证，请先核对草稿状态");
    try {
      const url = new URL(value.wechat_url);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "mmbiz.qpic.cn" || url.port || url.hash) fail("UPLOAD_STATE_INVALID", "本地图片上传映射无法安全验证，请先核对草稿状态");
      // The existing bridge accepts HTTP CDN URLs. Reuse the source URL credential
      // checks with HTTPS for validation only; do not rewrite the stored CDN URL.
      url.protocol = "https:";
      if (!safeWebUrl(url.href)) fail("UPLOAD_STATE_INVALID", "本地图片上传映射无法安全验证，请先核对草稿状态");
    } catch { fail("UPLOAD_STATE_INVALID", "本地图片上传映射无法安全验证，请先核对草稿状态"); }
    if (uploads.some(upload => upload.source === value.source)) fail("UPLOAD_STATE_INVALID", "本地图片上传映射存在重复来源，请先核对草稿状态");
    uploads.push({ source: value.source, sha256: value.sha256, media_id: value.media_id, wechat_url: value.wechat_url });
  }
  return uploads;
}
export function assertPublicArticle(edit: ArticleEdit): void {
  decodeArticleMetadata(edit.metadata);
  if (typeof edit.html !== "string" || typeof edit.markdown !== "string" || Buffer.byteLength(edit.html) > 1024 * 1024 || Buffer.byteLength(edit.markdown) > 1024 * 1024) fail("ARTICLE_TOO_LARGE", "文章内容超过大小限制");
  if (PRIVATE.test(JSON.stringify(edit))) fail("PUBLIC_CONTENT_LEAK", "文章含有私有路径或疑似凭据，请先移除");
  if (/<\s*(?:script|iframe|object|embed|form|input|link|meta|base)\b|\bon[a-z]+\s*=|javascript\s*:/iu.test(edit.html)) fail("ACTIVE_CONTENT_REJECTED", "文章不能包含脚本、表单或活动内容");
}
function ref(value: unknown): ArtifactRef | undefined {
  if (!isJsonObject(value) || typeof value.rootId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.rootId) || !safeRelativeFile(value.relativePath)) return;
  return { rootId: value.rootId, relativePath: value.relativePath };
}
function entry(state: { extensions: JsonObject }, contentRef: ContentRef): JsonObject {
  const all = state.extensions.wechatDocuments;
  return isJsonObject(all) && isJsonObject(all[contentRef]) ? all[contentRef] : {};
}
function put(state: { extensions: JsonObject }, contentRef: ContentRef, value: JsonObject): void {
  const all = state.extensions.wechatDocuments;
  state.extensions.wechatDocuments = { ...(isJsonObject(all) ? all : {}), [contentRef]: value };
}
async function exclusive(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class FileWorkbenchDocuments implements WorkbenchDocuments {
  private sources: SourceRecord[] = [];
  private bindings: Record<string, ContentRef> = {};
  private version = 0;
  private scanIssues: string[] = [];
  constructor(private readonly options: {
    roots: RootCapability[]; writeRoot?: RootCapability; store: WorkbenchStore;
    catalog: WorkbenchCatalog; settings: WorkbenchSettings; now: () => string; publications?: PublicationReader;
    channelRecords?: (contentRef: ContentRef, revision: string, documentDigest: string) => PublicationRecord[];
  }) {}
  revision(): number { return this.version; }
  settings(): WorkbenchSettings { return { ...this.options.settings, issues: [...this.options.settings.issues, ...this.scanIssues] }; }
  async refresh(): Promise<void> {
    await this.options.store.update(async state => {
      const catalog = await this.options.catalog.refresh(state);
      this.sources = catalog.sources.filter(source => source.recordKind === "wechat_manifest");
      this.bindings = catalog.bindings;
      this.scanIssues = catalog.issues;
      state.contentBindings = catalog.bindings;
      if (catalog.manualDecisions) state.manualDecisions = catalog.manualDecisions;
    });
    this.version += 1;
  }
  async readBytes(artifact: ArtifactRef, maximum = 1024 * 1024): Promise<Buffer> {
    return (await this.readArtifact(artifact, maximum)).bytes;
  }
  private async readArtifact(artifact: ArtifactRef, maximum = 1024 * 1024): Promise<{ bytes: Buffer; updatedAt: string }> {
    if (!ref(artifact)) fail("ARTIFACT_INVALID", "材料引用无效");
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 32 * 1024 * 1024) fail("ARTIFACT_INVALID", "材料读取大小限制无效");
    const root = this.options.roots.find(candidate => candidate.id === artifact.rootId);
    if (!root) fail("ROOT_UNAVAILABLE", "材料目录未配置或不可用");
    const path = await resolveReadablePath(root, artifact.relativePath);
    if (!path.ok || path.value.kind !== "file") fail("ARTIFACT_UNAVAILABLE", "材料不存在或超出受控目录");
    // Node does not expose a portable descriptor-relative directory walk. These
    // checks narrow rename/symlink races and fail closed; they are not a formal
    // cross-OS guarantee against a process continuously replacing ancestors.
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK === 0) fail("ARTIFACT_READ_UNSUPPORTED", "当前文件系统读取能力不满足安全要求");
    let handle: FileHandle | undefined;
    try {
      const namedBefore = await lstat(path.value.absolutePath, { bigint: true });
      if (!namedBefore.isFile()) fail("ARTIFACT_CHANGED", "材料读取前发生变化");
      if (namedBefore.size > BigInt(maximum)) fail("ARTIFACT_TOO_LARGE", "材料超过大小限制");
      // O_NONBLOCK also prevents a last-moment FIFO replacement from hanging open.
      handle = await open(path.value.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!sameFileState(namedBefore, before)) fail("ARTIFACT_CHANGED", "材料读取前发生变化");
      const verifyPath = async (): Promise<void> => {
        const current = await resolveReadablePath(root, artifact.relativePath);
        if (!current.ok || current.value.kind !== "file" || current.value.absolutePath !== path.value.absolutePath || !sameFileState(before, await lstat(current.value.absolutePath, { bigint: true }))) fail("ARTIFACT_CHANGED", "材料路径或文件身份发生变化");
      };
      await verifyPath();
      // A bounded read also prevents an actively growing file from exhausting memory.
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let total = 0;
      while (total < bytes.length) {
        const result = await handle.read(bytes, total, bytes.length - total, total);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }
      if (total > maximum || BigInt(total) !== before.size || !sameFileState(before, await handle.stat({ bigint: true }))) fail("ARTIFACT_CHANGED", "材料读取期间发生变化");
      await verifyPath();
      return { bytes: bytes.subarray(0, total), updatedAt: new Date(Number(before.mtimeMs)).toISOString() };
    } catch (error) {
      if (error instanceof WorkbenchFault) throw error;
      return fail("ARTIFACT_UNAVAILABLE", "材料无法安全读取，请刷新后重试");
    } finally { await handle?.close(); }
  }
  private relativeTo(document: ArtifactRef, file: string): ArtifactRef {
    if (!safeRelativeFile(file)) fail("ARTIFACT_INVALID", "图片必须使用受控相对路径");
    return { rootId: document.rootId, relativePath: posix.join(posix.dirname(document.relativePath), file) };
  }
  async read(contentRef: ContentRef): Promise<ArticleDocument> { return this.readAt(contentRef); }
  private async readAt(contentRef: ContentRef, historic?: ArtifactRef): Promise<ArticleDocument> {
    if (!parseContentRef(contentRef).ok) fail("CONTENT_REF_INVALID", "内容引用无效");
    const state = await this.options.store.read();
    const saved = historic ? {} : entry(state, contentRef);
    const candidates = this.sources.filter(source => this.bindings[source.recordId] === contentRef);
    let document = historic ?? ref(saved.document);
    if (!document && candidates.length !== 1) fail(candidates.length ? "CONTENT_AMBIGUOUS" : "CONTENT_NOT_FOUND", candidates.length ? "内容来源存在冲突，请先绑定正确来源" : "未找到微信文章");
    document ??= { rootId: candidates[0]!.rootId, relativePath: candidates[0]!.relativePath };
    let latestModified = -Infinity;
    const readContentBytes = async (artifact: ArtifactRef, maximum = 1024 * 1024): Promise<Buffer> => {
      const file = await this.readArtifact(artifact, maximum);
      latestModified = Math.max(latestModified, Date.parse(file.updatedAt));
      return file.bytes;
    };
    let decoded;
    let rawMetadata: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse((await readContentBytes(document)).toString("utf8"));
      decoded = decodeWechatDocument(raw);
      if (isJsonObject(raw)) rawMetadata = raw;
    }
    catch (error) { if (error instanceof WorkbenchFault) throw error; fail("DOCUMENT_INVALID", "文章文档无法解码"); }
    const htmlArtifact = this.relativeTo(document, decoded.contentFile);
    const html = (await readContentBytes(htmlArtifact)).toString("utf8");
    const markdown = decoded.markdownFile ? (await readContentBytes(this.relativeTo(document, decoded.markdownFile))).toString("utf8") : "";
    assertPublicArticle({ metadata: decoded.metadata, html, markdown });
    const assets: ArticleDocument["assets"] = [];
    const issues: string[] = [];
    const sources = htmlImageSources(html);
    if (sources.length > 64) fail("ASSET_LIMIT", "单篇文章图片数量超限");
    for (const source of sources) {
      try {
        const artifact = this.relativeTo(htmlArtifact, source);
        const mediaType = MIME[extname(source).toLowerCase()];
        if (!mediaType) fail("IMAGE_TYPE_INVALID", "仅支持静态栅格图片");
        const bytes = await readContentBytes(artifact, 12 * 1024 * 1024);
        // A filename is not source evidence or a formula attestation.
        assets.push({ source, artifact, digest: sha256(bytes), mediaType, bytes: bytes.length, kind: "other" });
      } catch { issues.push("IMAGE_UNAVAILABLE"); }
    }
    const revisionDigest = sha256(revisionPayload(decoded.metadata, sha256(html), assets));
    const reviews: ReviewEvidence[] = [];
    const assetKinds = new Map<string, Set<ArticleDocument["assets"][number]["kind"]>>();
    for (const raw of Array.isArray(saved.reviews) ? saved.reviews.slice(-100) : []) {
      if (!isJsonObject(raw) || !REVIEW_KINDS.includes(raw.kind as ReviewEvidence["kind"]) || typeof raw.id !== "string" || !OPAQUE_ID.test(raw.id) || !safeWorkflowText(raw.summary) || !isTimestamp(raw.recordedAt) || typeof raw.revisionDigest !== "string" || !SHA256_PATTERN.test(raw.revisionDigest) || typeof raw.artifactDigest !== "string" || !SHA256_PATTERN.test(raw.artifactDigest) || !ref(raw.artifact) || !["user", "agent"].includes(String(raw.reviewer)) || WORKFLOW_PRIVATE.test(JSON.stringify(raw))) continue;
      const evidence = raw as unknown as ReviewEvidence;
      let valid = evidence.revisionDigest === revisionDigest;
      let coverage: ReviewEvidence["coverage"];
      try {
        const bytes = await this.readBytes(evidence.artifact, 16 * 1024 * 1024);
        valid &&= sha256(bytes) === evidence.artifactDigest;
        if (valid && evidence.kind === "mobile_visual") screenshotProjection(bytes);
        if (valid && evidence.kind !== "mobile_visual") {
          const raw: unknown = JSON.parse(bytes.toString("utf8"));
          validateNativeReview(raw, evidence.kind, revisionDigest);
          if (isJsonObject(raw) && raw.details !== undefined) {
            const details = decodeReviewDetails(raw.details);
            valid &&= details.markdownDigest === sha256(markdown);
            if (valid) {
              coverage = reviewCoverage(details, { html, assets, issues } as ArticleDocument, evidence.kind);
              if (evidence.kind === "images_formulas") for (const asset of details.assets) {
                const kinds = assetKinds.get(asset.source) ?? new Set(); kinds.add(asset.kind); assetKinds.set(asset.source, kinds);
              }
            }
          }
        }
      } catch { valid = false; }
      reviews.push({ id: evidence.id, kind: evidence.kind, revisionDigest: evidence.revisionDigest, artifact: ref(evidence.artifact)!, artifactDigest: evidence.artifactDigest, reviewer: evidence.reviewer, summary: evidence.summary, recordedAt: evidence.recordedAt, valid, ...(coverage ? { coverage } : {}) });
    }
    for (const asset of assets) {
      const kinds = assetKinds.get(asset.source);
      if (kinds?.size === 1) asset.kind = [...kinds][0]!;
      else if (kinds && kinds.size > 1) issues.push("ASSET_EVIDENCE_CONFLICT");
    }
    const workflowImports: WorkflowMaterial[] = [];
    for (const raw of Array.isArray(saved.workflowImports) ? saved.workflowImports.slice(-100) : []) {
      if (!isJsonObject(raw) || Object.keys(raw).length !== WORKFLOW_FIELDS.size || Object.keys(raw).some(key => !WORKFLOW_FIELDS.has(key)) || !ref(raw.source) || typeof raw.id !== "string" || !/^import:[a-f0-9]{64}$/u.test(raw.id) || !["review", "draft"].includes(String(raw.kind)) || typeof raw.sourceDigest !== "string" || !SHA256_PATTERN.test(raw.sourceDigest) || typeof raw.boundRevision !== "string" || raw.boundRevision !== "" && !SHA256_PATTERN.test(raw.boundRevision) || typeof raw.boundHtmlDigest !== "string" || raw.boundHtmlDigest !== "" && !SHA256_PATTERN.test(raw.boundHtmlDigest) || typeof raw.sourceFormat !== "string" || !WORKFLOW_FORMATS.has(raw.sourceFormat) || !safeWorkflowText(raw.title, 200) || !isTimestamp(raw.recordedAt) || !["current", "partial", "historical", "stale"].includes(String(raw.status)) || !(raw.reviewKind === null || REVIEW_KINDS.includes(raw.reviewKind as ReviewEvidence["kind"])) || !Array.isArray(raw.findings) || raw.findings.length > 100 || !raw.findings.every(value => safeWorkflowText(value)) || !Array.isArray(raw.warnings) || raw.warnings.length > 100 || !raw.warnings.every(value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value)) || WORKFLOW_PRIVATE.test(JSON.stringify(raw))) continue;
      const material = raw as unknown as WorkflowMaterial;
      let stale = Boolean(material.boundRevision && material.boundRevision !== revisionDigest || material.boundHtmlDigest && material.boundHtmlDigest !== sha256(html));
      try {
        const bytes = await this.readBytes(material.source);
        stale ||= sha256(bytes) !== material.sourceDigest;
        if (!stale && material.sourceFormat === "wemedia.review/v1") {
          const raw: unknown = JSON.parse(bytes.toString("utf8"));
          if (isJsonObject(raw) && raw.details !== undefined) {
            const details = decodeReviewDetails(raw.details);
            stale ||= details.markdownDigest !== sha256(markdown);
            if (!stale && material.reviewKind) reviewCoverage(details, { html, assets, issues } as ArticleDocument, material.reviewKind);
          }
        }
      } catch { stale = true; }
      workflowImports.push({ id: material.id, kind: material.kind, source: ref(material.source)!, sourceDigest: material.sourceDigest, sourceFormat: material.sourceFormat, title: material.title, status: stale ? "stale" : material.status, boundRevision: material.boundRevision, boundHtmlDigest: material.boundHtmlDigest, reviewKind: material.reviewKind, findings: material.findings, warnings: [...material.warnings, ...(stale ? ["IMPORTED_SOURCE_OR_REVISION_CHANGED"] : [])], recordedAt: material.recordedAt });
    }
    const targets = this.publicTargets(saved);
    if (saved.targets !== undefined && (!Array.isArray(saved.targets) || saved.targets.length !== targets.length)) issues.push("TARGET_BINDING_INVALID");
    const identityArtifacts = [document, htmlArtifact, ...(decoded.markdownFile ? [this.relativeTo(document, decoded.markdownFile)] : [])];
    const sourcePaths = identityArtifacts.flatMap(artifact => {
      const root = this.options.roots.find(root => root.id === artifact.rootId);
      return root ? [resolve(root.realPath, artifact.relativePath)] : [];
    });
    const external = historic ? undefined : await this.options.publications?.lookup({ sourcePaths });
    const verified = targets.filter(target => target.verifiedRevision === revisionDigest && isTimestamp(target.verifiedAt)).sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
    const local: PublicationRecord = { channel: "wechat", status: "draft", publishedAt: null, checkedAt: verified?.verifiedAt ?? null, url: null, evidence: verified ? "draft_readback" : "local_draft", note: verified ? "该版本的公众号草稿已核对；尚无正式发布回执。" : "文章已保存在本地；草稿目标和本地保存都不代表正式发布。" };
    const paragraphs = articleParagraphs(html);
    const channelRecords = historic ? [] : this.options.channelRecords?.(contentRef, revisionDigest, sha256(channelDocumentPayload(articleChannelDocument({ contentRef, metadata: decoded.metadata, html, markdown, revisionDigest, assets, paragraphs })))) ?? [];
    const originalRecords = external?.publications.some(record => record.channel === "wechat") ? external.publications : [local, ...(external?.publications ?? [])];
    const publications = [...originalRecords.filter(record => !channelRecords.some(current => current.channel === record.channel)), ...channelRecords];
    if (external?.issues.length) issues.push(...external.issues);
    const taxonomy = classifyArticle({ title: decoded.metadata.title, path: document.relativePath, metadata: { ...rawMetadata, ...(isJsonObject(rawMetadata.metadata) ? rawMetadata.metadata : {}), ...decoded.metadata }, markdown });
    return { contentRef, document, htmlArtifact, metadata: decoded.metadata, html, markdown, revisionDigest, assets, reviews, targets, workflowImports, publications, taxonomy, paragraphs, issues, readOnlySource: document.rootId !== this.options.writeRoot?.id, updatedAt: Number.isFinite(latestModified) ? new Date(latestModified).toISOString() : null };
  }
  private publicTargets(saved: JsonObject): DraftTarget[] {
    return storedTargets(saved).map(publicTarget);
  }
  async privateRemoteState(contentRef: ContentRef, target: DraftTarget | null): Promise<{ target?: { mediaId: string; title: string; sourceUrl: string }; uploads: JsonObject[]; accountRef?: string }> {
    if (!parseContentRef(contentRef).ok) fail("CONTENT_REF_INVALID", "内容引用无效");
    const saved = entry(await this.options.store.read(), contentRef);
    const targets = storedTargets(saved);
    if (saved.targets !== undefined && (!Array.isArray(saved.targets) || saved.targets.length !== targets.length)) fail("TARGET_UNKNOWN", "草稿目标绑定存在无效或歧义记录，请先核对草稿状态");
    const stored = target ? targets.find(value => value.targetRef === target.targetRef) : undefined;
    if (target && !stored) fail("TARGET_UNKNOWN", "草稿目标无有效且唯一的本地绑定");
    if (target && stored && (target.title !== stored.title || target.sourceUrl !== stored.sourceUrl || target.verifiedRevision !== stored.verifiedRevision || target.verifiedAt !== stored.verifiedAt)) fail("TARGET_CHANGED", "草稿目标已变化，请刷新并重新预览");
    const accounts = saved.targetAccounts;
    const accountRef = stored && isJsonObject(accounts) ? accounts[stored.targetRef] : undefined;
    if (accountRef !== undefined && (typeof accountRef !== "string" || !/^wechat-account:[a-f0-9]{32}$/u.test(accountRef))) fail("TARGET_ACCOUNT_INVALID", "草稿账户绑定无效，请重新核对身份");
    return { ...(stored ? { target: { mediaId: stored.mediaId, title: stored.title, sourceUrl: stored.sourceUrl } } : {}), uploads: storedUploads(saved), ...(typeof accountRef === "string" ? { accountRef } : {}) };
  }
  async list(): Promise<WorkbenchContentSummary[]> {
    const state = await this.options.store.read();
    const saved = isJsonObject(state.extensions.wechatDocuments) ? state.extensions.wechatDocuments : {};
    const references = [...new Set([...this.sources.map(source => this.bindings[source.recordId]), ...Object.keys(saved)].filter((value): value is ContentRef => typeof value === "string" && parseContentRef(value).ok))];
    const output: WorkbenchContentSummary[] = [];
    for (const contentRef of references) {
      try {
        const doc = await this.read(contentRef);
        output.push({ contentRef, title: doc.metadata.title, articleId: doc.metadata.articleId, rootLabel: this.options.roots.find(root => root.id === doc.document.rootId)?.label ?? "未配置", channel: "wechat", readOnlySource: doc.readOnlySource, status: articleWorkflowStatus(doc), issueCount: doc.issues.length, updatedAt: doc.updatedAt ?? null, publications: doc.publications ?? [], ...(doc.taxonomy ? { taxonomy: doc.taxonomy } : {}) });
      } catch {
        output.push({ contentRef, title: "待修复的微信文章", articleId: "", rootLabel: "来源不可用", channel: "wechat", readOnlySource: true, status: "needs_revalidation", issueCount: 1, updatedAt: null });
      }
    }
    return output.sort((a, b) => a.title.localeCompare(b.title));
  }
  async preview(contentRef: ContentRef) {
    const doc = await this.read(contentRef);
    let html = doc.html;
    let total = 0;
    for (const asset of doc.assets) {
      const bytes = await this.readBytes(asset.artifact, 12 * 1024 * 1024);
      if (sha256(bytes) !== asset.digest) fail("ARTIFACT_CHANGED", "预览材料发生变化，请刷新");
      total += bytes.length;
      if (total > 24 * 1024 * 1024) fail("PREVIEW_TOO_LARGE", "预览图片总量超过限制");
      const uri = `data:${asset.mediaType};base64,${bytes.toString("base64")}`;
      html = rewriteImageSources(html, source => source === asset.source ? uri : source);
    }
    const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'";
    return { revisionDigest: doc.revisionDigest, html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=390,initial-scale=1"><style>html{background:white;color:#16181b}body{margin:0;padding:20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`, width: 390, imageCount: doc.assets.length, issues: doc.issues };
  }
  async editAssets(document: ArticleDocument, edit: ArticleEdit): Promise<ArticleDocument["assets"]> {
    const root = this.options.writeRoot;
    if (!root) fail("WRITE_ROOT_MISSING", "请先配置文章写入目录");
    assertPublicArticle(edit);
    const sources = htmlImageSources(edit.html);
    if (sources.length > 64) fail("ASSET_LIMIT", "单篇文章图片数量超限");
    const assets: ArticleDocument["assets"] = [];
    for (const source of sources) {
      const prior = document.assets.find(asset => asset.source === source);
      const artifact = prior?.artifact ?? { rootId: root.id, relativePath: source };
      const mediaType = MIME[extname(source).toLowerCase()];
      if (!safeRelativeFile(source) || !mediaType) fail("ASSET_REFERENCE_INVALID", "新图片须为写入目录内的受控相对路径");
      const bytes = await this.readBytes(artifact, 12 * 1024 * 1024), digest = sha256(bytes);
      if (prior && digest !== prior.digest) fail("ARTIFACT_CHANGED", "图片在预览期间变化");
      assets.push({ source, artifact, digest, mediaType, kind: "other", bytes: bytes.length });
    }
    return assets;
  }
  private async writeVersion(contentRef: ContentRef, edit: ArticleEdit, previous?: ArticleDocument, expectedAssets?: ArticleDocument["assets"]): Promise<ArtifactRef> {
    const root = this.options.writeRoot;
    if (!root) fail("WRITE_ROOT_MISSING", "请先配置独立的文章写入目录");
    assertPublicArticle(edit);
    const folder = `wechat-${contentRef.slice(4)}-${randomUUID()}`;
    const created = await resolveCreateTarget(root, folder);
    if (!created.ok) fail("WRITE_TARGET_REJECTED", "无法创建新的独立文章版本");
    await mkdir(created.value.absolutePath, { mode: 0o700 });
    let html = edit.html;
    const sources = htmlImageSources(html);
    if (sources.length > 64) fail("ASSET_LIMIT", "单篇文章图片数量超限");
    await mkdir(resolve(created.value.absolutePath, "assets"), { mode: 0o700 });
    for (const [index, source] of sources.entries()) {
      const prior = previous?.assets.find(asset => asset.source === source);
      // New assets can be authored by the Agent inside the configured write root.
      const artifact = prior?.artifact ?? { rootId: root.id, relativePath: source };
      if (!safeRelativeFile(source) || !MIME[extname(source).toLowerCase()]) fail("ASSET_REFERENCE_INVALID", "新图片须为写入目录内的相对路径");
      const bytes = await this.readBytes(artifact, 12 * 1024 * 1024);
      if (prior && sha256(bytes) !== prior.digest) fail("ARTIFACT_CHANGED", "图片在保存期间发生变化");
      if (expectedAssets && !expectedAssets.some(asset => asset.source === source && asset.digest === sha256(bytes))) fail("ARTIFACT_CHANGED", "图片与已确认的预览不一致，未保存新版本");
      const target = `assets/${index}-${sha256(bytes).slice(7, 23)}${extname(source).toLowerCase()}`;
      await exclusive(resolve(created.value.absolutePath, target), bytes);
      html = rewriteImageSources(html, candidate => candidate === source ? target : candidate);
    }
    await exclusive(resolve(created.value.absolutePath, "article.html"), html);
    await exclusive(resolve(created.value.absolutePath, "article.md"), edit.markdown);
    // Preserve only public classification labels; explicit new Markdown labels win.
    const metadata = previous?.taxonomy && !declaresTags(readArticleFrontmatter(edit.markdown))
      ? { ...edit.metadata, tags: previous.taxonomy.tags.filter(isTaxonomyLabel).slice(0, 16) }
      : edit.metadata;
    await exclusive(resolve(created.value.absolutePath, "wechat-document.json"), JSON.stringify({ schemaVersion: DOCUMENT_SCHEMA, metadata, contentFile: "article.html", markdownFile: "article.md" }));
    return { rootId: root.id, relativePath: `${folder}/wechat-document.json` };
  }
  async create(input: { contentRef: ContentRef; metadata: ArticleMetadata }): Promise<ArticleDocument> {
    if (!parseContentRef(input.contentRef).ok) fail("CONTENT_REF_INVALID", "内容引用无效");
    const escaped = input.metadata.title.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
    const document = await this.writeVersion(input.contentRef, { metadata: input.metadata, html: `<h1>${escaped}</h1><p>请完成资料研究和文章正文。</p>`, markdown: `# ${input.metadata.title}\n` });
    await this.options.store.update(state => {
      if (Object.keys(entry(state, input.contentRef)).length) fail("CONTENT_EXISTS", "内容已存在");
      put(state, input.contentRef, { document, reviews: [], targets: [], uploads: [] });
    });
    this.version += 1;
    return this.read(input.contentRef);
  }
  async saveRevision(contentRef: ContentRef, expectedDigest: string, edit: ArticleEdit, expectedAssets?: ArticleDocument["assets"]): Promise<ArticleDocument> {
    const previous = await this.read(contentRef);
    if (previous.revisionDigest !== expectedDigest) fail("REVISION_CHANGED", "文章版本已变化，请重新预览修改");
    if (previous.metadata.articleId !== edit.metadata.articleId) fail("ARTICLE_ID_IMMUTABLE", "文章来源标识不能在编辑中改变");
    const assets = expectedAssets ?? await this.editAssets(previous, edit);
    const document = await this.writeVersion(contentRef, edit, previous, assets);
    await this.options.store.update(async state => {
      const current = await this.read(contentRef);
      if (current.revisionDigest !== expectedDigest || current.markdown !== previous.markdown) fail("REVISION_CHANGED", "保存期间文章已变化，新文件未成为当前版本");
      const saved = entry(state, contentRef);
      const next = await this.readAt(contentRef, document);
      if (next.issues.length || next.assets.length !== assets.length) fail("REVISION_ASSETS_INVALID", "新版本图片不完整，未提交保存");
      const known = storedVersions(saved.history);
      const previousRecord = versionRecord(previous, this.options.now(), sha256);
      const nextRecord = versionRecord(next, this.options.now(), sha256);
      if (!known.some(item => item.id === previousRecord.id)) known.push(previousRecord);
      if (!known.some(item => item.id === nextRecord.id)) known.push(nextRecord);
      put(state, contentRef, { ...saved, document, history: known.slice(-100) });
    });
    this.version += 1;
    return this.read(contentRef);
  }
  private async historyRecords(contentRef: ContentRef): Promise<{ current: ArticleDocument; records: StoredVersion[]; currentId: string }> {
    const current = await this.read(contentRef);
    const records = storedVersions(entry(await this.options.store.read(), contentRef).history);
    const active = versionRecord(current, this.options.now(), sha256);
    if (!records.some(item => item.id === active.id)) records.push(active);
    return { current, records: records.slice(-100), currentId: active.id };
  }
  private async checkedVersion(contentRef: ContentRef, record: StoredVersion): Promise<ArticleDocument> {
    const document = await this.readAt(contentRef, record.document);
    const observed = versionRecord(document, record.recordedAt, sha256);
    if (observed.id !== record.id || observed.revisionDigest !== record.revisionDigest || observed.markdownDigest !== record.markdownDigest || observed.title !== record.title || document.issues.length) fail("HISTORY_CHANGED", "历史文件已变化或素材缺失，无法比较该版本");
    return document;
  }
  async history(contentRef: ContentRef): Promise<VersionHistory> {
    const { records, currentId } = await this.historyRecords(contentRef);
    const versions: VersionHistory["versions"] = [];
    for (const record of records) {
      let available = true;
      try { await this.checkedVersion(contentRef, record); } catch { available = false; }
      versions.push(summarizeVersion(record, currentId, available));
    }
    return { contentRef, versions: versions.reverse(), notes: ["仅列出已登记及当前可读的最近 100 个版本；接入历史索引前的孤立文件不自动认领。登记时间不等于原稿创建时间。", "历史比较只读，不恢复、覆盖或重新发布文章。"] };
  }
  async compareVersions(contentRef: ContentRef, fromId: string, toId: string): Promise<VersionComparison> {
    const { records, currentId } = await this.historyRecords(contentRef);
    const from = records.find(item => item.id === fromId), to = records.find(item => item.id === toId);
    if (!from || !to) fail("HISTORY_UNKNOWN", "请选择当前文章已登记的两个版本");
    const before = await this.checkedVersion(contentRef, from), after = await this.checkedVersion(contentRef, to);
    return { from: summarizeVersion(from, currentId, true), to: summarizeVersion(to, currentId, true), ...compareDocuments(before, after) };
  }
  async evidenceDetail(contentRef: ContentRef, evidenceId: string): Promise<EvidenceDetail> {
    const document = await this.read(contentRef);
    const review = document.reviews.find(item => item.id === evidenceId);
    const material = document.workflowImports?.find(item => item.id === evidenceId);
    if (!review && !material) fail("EVIDENCE_UNKNOWN", "请从当前文章已登记的材料中选择详情");
    const artifact = review?.artifact ?? material!.source;
    const expectedDigest = review?.artifactDigest ?? material!.sourceDigest;
    const bytes = await this.readBytes(artifact, review?.kind === "mobile_visual" ? 8 * 1024 * 1024 : 1024 * 1024);
    if (sha256(bytes) !== expectedDigest) fail("EVIDENCE_CHANGED", "材料文件已变化，请重新审阅或导入；未显示被替换内容");
    const current = review?.valid ?? material!.status === "current";
    const result: EvidenceDetail = { id: evidenceId, revisionDigest: review?.revisionDigest ?? material!.boundRevision, current, format: review?.kind === "mobile_visual" ? "image/png" : material?.sourceFormat ?? "wemedia.review/v1", body: "", details: null, coverage: null, image: null, notes: current ? [] : ["这是历史、部分或待重审材料，不能作为当前全文通过证明。"] };
    if (review?.kind === "mobile_visual") result.image = screenshotProjection(bytes);
    else {
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { fail("EVIDENCE_INVALID", "材料内容无法解码"); }
      if (isJsonObject(raw) && raw.schemaVersion === "wemedia.review/v1") {
        const kind = review?.kind ?? material!.reviewKind;
        if (!kind) fail("EVIDENCE_INVALID", "材料审阅类型缺失");
        const findings = validateNativeReview(raw, kind, result.revisionDigest);
        result.details = raw.details === undefined ? null : decodeReviewDetails(raw.details);
        result.body = result.details?.body ?? findings.join("\n\n");
        if (result.details && current && result.details.markdownDigest === sha256(document.markdown)) result.coverage = reviewCoverage(result.details, document, kind);
        if (!result.details) result.notes.push("原报告仅记录 findings，未提供正文扩展或逐项覆盖；这里展示全部已登记发现。");
      } else {
        // Legacy source formats include private diagnostics and remote identities.
        // Only known public report sections may cross the API boundary.
        const fields = ["checks", "source_tables", "image_checks", "formula_errors"];
        let sections = raw;
        if (isJsonObject(raw) && raw.schema === "aaai2026-agent-draft-readback.v1") {
          const rows = Array.isArray(raw.checks) ? raw.checks.filter(row => isJsonObject(row) && row.article_id === document.metadata.articleId) : [];
          if (rows.length !== 1 || !isJsonObject(rows[0])) fail("EVIDENCE_INVALID", "批量报告无法唯一定位当前文章");
          sections = { checks: rows[0].checks };
          result.notes.push("批量回读报告仅展示与本篇文章身份匹配的完整检查项。");
        }
        const project = (value: unknown, depth = 0): import("../domain/json.ts").JsonValue => {
          if (depth > 6) return "[层级超限，未展示]";
          if (typeof value === "string") return WORKFLOW_PRIVATE.test(value) || value.length > 8000 ? "[非公开内容已省略]" : value;
          if (typeof value === "boolean" || typeof value === "number" || value === null) return value;
          if (Array.isArray(value)) return value.slice(0, 256).map(item => project(item, depth + 1));
          if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).filter(([key, item]) => (typeof item === "boolean" && READBACK_CHECKS.includes(key)) || (typeof item === "boolean" && /^[a-z][a-z0-9_]{0,79}$/u.test(key) || ["title", "caption", "text", "message", "note", "reason", "status", "page", "figure", "index", "expected", "actual", "source_url", "source_title", "rows", "columns", "cells", "checks", "errors", "warnings", "formula", "latex"].includes(key)) && !/media.?id|upload|path|file|diagnostic|raw|token|secret|cookie|account|credential|authorization|password|api.?key|bearer/iu.test(key)).map(([key, item]) => [key, project(item, depth + 1)]));
          return null;
        };
        result.body = JSON.stringify({ findings: material!.findings, ...(isJsonObject(sections) ? Object.fromEntries(fields.filter(key => sections[key] !== undefined).map(key => [key, project(sections[key])])) : {}) }, null, 2);
        if (result.body.length > 128_000) fail("EVIDENCE_TOO_LARGE", "报告公开内容超过阅读限制，请拆分材料");
        result.notes.push("展示受支持的公开报告章节；账号身份、路径和原始诊断已省略。旧报告状态保持不变。");
      }
    }
    const latest = await this.read(contentRef);
    if (latest.revisionDigest !== document.revisionDigest || latest.markdown !== document.markdown || sha256(await this.readBytes(artifact, 8 * 1024 * 1024)) !== expectedDigest) fail("EVIDENCE_CHANGED", "读取期间文章或材料已变化，请刷新后再读");
    return result;
  }
  async prepare(document: ArticleDocument, _jobId: string): Promise<ArtifactRef[]> {
    const prepared = await this.saveRevision(document.contentRef, document.revisionDigest, { metadata: document.metadata, html: document.html, markdown: document.markdown });
    return [prepared.document, prepared.htmlArtifact, ...prepared.assets.map(asset => asset.artifact)];
  }
  async recordReview(contentRef: ContentRef, input: Pick<ReviewEvidence, "kind" | "revisionDigest" | "artifact" | "reviewer" | "summary">): Promise<ReviewEvidence> {
    const document = await this.read(contentRef);
    if (input.revisionDigest !== document.revisionDigest) fail("REVIEW_STALE", "审阅证据不属于当前文章版本");
    if (!REVIEW_KINDS.includes(input.kind) || !safeWorkflowText(input.summary)) fail("REVIEW_INVALID", "审阅说明无效");
    const bytes = await this.readBytes(input.artifact, 16 * 1024 * 1024);
    if (input.kind === "mobile_visual") {
      try { screenshotProjection(bytes); } catch { fail("VISUAL_EVIDENCE_INVALID", "移动端审阅需要当前版本的完整、可解码 390px 宽 PNG 截图"); }
    } else {
      let report: unknown;
      try { report = JSON.parse(bytes.toString("utf8")); } catch { fail("REVIEW_REPORT_INVALID", "审阅材料须为结构化 JSON 报告"); }
      try {
        validateNativeReview(report, input.kind, input.revisionDigest);
        if (isJsonObject(report) && report.details !== undefined) {
          const details = decodeReviewDetails(report.details);
          if (details.markdownDigest !== sha256(document.markdown)) fail("REVIEW_STALE", "审阅 Markdown 已变化");
          reviewCoverage(details, document, input.kind);
        }
      }
      catch { fail("REVIEW_REPORT_INVALID", "审阅报告须包含当前版本、通过结论及安全的具体核验发现"); }
    }
    const evidence: ReviewEvidence = { ...input, id: `review:${randomUUID()}`, artifactDigest: sha256(bytes), recordedAt: this.options.now(), valid: true };
    await this.options.store.update(async state => {
      const current = await this.read(contentRef);
      if (current.revisionDigest !== input.revisionDigest || current.markdown !== document.markdown || sha256(await this.readBytes(input.artifact, 16 * 1024 * 1024)) !== evidence.artifactDigest) fail("REVIEW_STALE", "记录审阅期间文章或材料发生变化");
      const saved = entry(state, contentRef);
      put(state, contentRef, { ...saved, reviews: [...(Array.isArray(saved.reviews) ? saved.reviews : []), evidence].slice(-100) });
    });
    this.version += 1;
    return evidence;
  }
  async previewWorkflowImport(contentRef: ContentRef, kind: WorkflowImportKind, artifact: ArtifactRef): Promise<WorkflowImportCandidate> {
    if (!artifact.relativePath.endsWith(".json")) fail("WORKFLOW_FORMAT_UNSUPPORTED", "导入材料必须为 JSON 文件");
    const document = await this.read(contentRef);
    const bytes = await this.readBytes(artifact);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch { fail("WORKFLOW_FORMAT_UNSUPPORTED", "导入材料不是有效 JSON"); }
    const parsed = parseWorkflowReport(raw, document, sha256(document.html), kind);
    if (isJsonObject(raw) && raw.schemaVersion === "wemedia.review/v1" && raw.details !== undefined) {
      const details = decodeReviewDetails(raw.details);
      if (parsed.status === "current" && details.markdownDigest !== sha256(document.markdown)) {
        parsed.status = "stale"; parsed.warnings.push("REVIEW_MARKDOWN_STALE");
      } else if (parsed.status === "current" && parsed.reviewKind) reviewCoverage(details, document, parsed.reviewKind);
    }
    const sourceDigest = sha256(bytes);
    const candidate: WorkflowImportCandidate = { revisionDigest: document.revisionDigest, material: { id: `import:${sha256(`${kind}:${artifact.rootId}:${artifact.relativePath}:${sourceDigest}`).slice(7)}`, kind, source: artifact, sourceDigest, sourceFormat: parsed.sourceFormat, title: kind === "draft" ? "原工作流草稿身份" : "原工作流审阅材料", status: parsed.status, boundRevision: parsed.boundRevision, boundHtmlDigest: parsed.boundHtmlDigest, reviewKind: parsed.reviewKind, findings: parsed.findings, warnings: parsed.warnings, recordedAt: this.options.now() } };
    if (parsed.target) {
      let uploads: JsonObject[] = [];
      if (parsed.target.uploadMapFile) {
        // Legacy manifests carry repository-relative paths. Resolve only their
        // article-specific basename beside the explicitly selected summary.
        const mapping: ArtifactRef = { rootId: artifact.rootId, relativePath: posix.join(posix.dirname(artifact.relativePath), parsed.target.uploadMapFile) };
        const mappingBytes = await this.readBytes(mapping);
        let rows: unknown;
        try { rows = JSON.parse(mappingBytes.toString("utf8")); } catch { fail("UPLOAD_STATE_INVALID", "原工作流图片映射不是有效 JSON"); }
        if (!Array.isArray(rows) || rows.length > 500) fail("UPLOAD_STATE_INVALID", "原工作流图片映射格式不受支持");
        // Deliberately discard the old preflight/reused annotations. They are
        // not current approval and never become a gate result.
        uploads = storedUploads({ uploads: rows.map(row => {
          if (!isJsonObject(row)) fail("UPLOAD_STATE_INVALID", "原工作流图片映射格式不受支持");
          return { source: row.source ?? null, sha256: row.sha256 ?? null, media_id: row.media_id ?? null, wechat_url: row.wechat_url ?? null };
        }) });
        candidate.dependencies = [{ artifact: mapping, digest: sha256(mappingBytes) }];
      }
      candidate.target = { mediaId: parsed.target.mediaId, title: parsed.target.title, sourceUrl: parsed.target.sourceUrl, uploads };
    }
    if (WORKFLOW_PRIVATE.test(JSON.stringify(candidate.material))) fail("WORKFLOW_MATERIAL_UNSAFE", "材料引用或公开字段包含私有路径或疑似凭据，未导入");
    return candidate;
  }
  async commitWorkflowImport(contentRef: ContentRef, candidate: WorkflowImportCandidate, reviewer: "user" | "agent", identity?: { accountRef: string; verifiedAt: string }, signal?: AbortSignal, assertCurrent?: () => void): Promise<ArticleDocument> {
    const signature = (value: WorkflowImportCandidate): string => JSON.stringify({ ...value, material: { ...value.material, recordedAt: "" } });
    await this.options.store.update(async state => {
      const current = await this.previewWorkflowImport(contentRef, candidate.material.kind, candidate.material.source);
      if (signature(current) !== signature(candidate)) fail("WORKFLOW_IMPORT_CHANGED", "文章或导入材料已变化，请重新预览");
      if (signal?.aborted) fail("REQUEST_CANCELLED", "导入已取消");
      const saved = entry(state, contentRef);
      const imports = Array.isArray(saved.workflowImports) ? saved.workflowImports : [];
      const next: JsonObject = { ...saved, workflowImports: [...imports.filter(value => !isJsonObject(value) || value.id !== candidate.material.id), { ...candidate.material, recordedAt: this.options.now() }].slice(-100) };
      if (candidate.target) {
        if (!identity || !/^wechat-account:[a-f0-9]{32}$/u.test(identity.accountRef) || !isTimestamp(identity.verifiedAt)) fail("DRAFT_IDENTITY_REQUIRED", "草稿身份尚未经过当前账号的只读核验");
        const boundMaterial: WorkflowMaterial = { ...candidate.material, status: "partial", recordedAt: this.options.now(), findings: [...candidate.material.findings, `草稿身份已于 ${identity.verifiedAt} 在当前账号中完成只读核对；不是当前内容回读结论`], warnings: [...candidate.material.warnings.filter(code => code !== "DRAFT_IDENTITY_READ_REQUIRED"), "DRAFT_IDENTITY_VERIFIED_NOT_CONTENT"] };
        next.workflowImports = [...imports.filter(value => !isJsonObject(value) || value.id !== candidate.material.id), boundMaterial].slice(-100);
        const targets = storedTargets(saved);
        if (saved.targets !== undefined && (!Array.isArray(saved.targets) || saved.targets.length !== targets.length)) fail("TARGET_BINDING_INVALID", "现有草稿绑定有歧义，未覆盖");
        const all = state.extensions.wechatDocuments;
        if (isJsonObject(all)) for (const [otherRef, value] of Object.entries(all)) {
          if (otherRef !== contentRef && isJsonObject(value) && Array.isArray(value.targets) && value.targets.some(target => isJsonObject(target) && target.mediaId === candidate.target!.mediaId)) fail("TARGET_ALREADY_BOUND", "该草稿已绑定其他文章，未建立重复绑定");
        }
        const existing = targets.filter(target => target.mediaId === candidate.target!.mediaId);
        if (existing.length > 1 || targets.some(target => target.mediaId !== candidate.target!.mediaId)) fail("TARGET_IMPORT_CONFLICT", "文章已有其他草稿绑定，未覆盖或自动新增目标");
        const accounts = isJsonObject(saved.targetAccounts) ? saved.targetAccounts : {};
        if (existing[0]) {
          const account = accounts[existing[0].targetRef];
          if (account !== undefined && account !== identity.accountRef || existing[0].sourceUrl !== candidate.target.sourceUrl || existing[0].title !== candidate.target.title) fail("TARGET_IMPORT_CONFLICT", "现有草稿身份已变化，未覆盖新状态");
          next.targetAccounts = { ...accounts, [existing[0].targetRef]: identity.accountRef };
        } else {
          const target: StoredTarget = { targetRef: `target:${randomUUID()}`, mediaId: candidate.target.mediaId, title: candidate.target.title, sourceUrl: candidate.target.sourceUrl, verifiedRevision: "", verifiedAt: "" };
          next.targets = [target]; next.uploads = candidate.target.uploads;
          next.targetAccounts = { ...accounts, [target.targetRef]: identity.accountRef };
        }
      } else if (candidate.material.sourceFormat === "wemedia.review/v1" && candidate.material.status === "current" && candidate.material.reviewKind) {
        const bytes = await this.readBytes(candidate.material.source);
        if (sha256(bytes) !== candidate.material.sourceDigest) fail("WORKFLOW_IMPORT_CHANGED", "导入材料已变化，请重新预览");
        validateNativeReview(JSON.parse(bytes.toString("utf8")), candidate.material.reviewKind, candidate.revisionDigest);
        const reviews = Array.isArray(saved.reviews) ? saved.reviews : [];
        const same = reviews.some(value => isJsonObject(value) && value.kind === candidate.material.reviewKind && value.revisionDigest === candidate.revisionDigest && value.artifactDigest === candidate.material.sourceDigest && isJsonObject(value.artifact) && value.artifact.rootId === candidate.material.source.rootId && value.artifact.relativePath === candidate.material.source.relativePath);
        if (!same) {
          const review: ReviewEvidence = { id: `review:${randomUUID()}`, kind: candidate.material.reviewKind, revisionDigest: candidate.revisionDigest, artifact: candidate.material.source, artifactDigest: candidate.material.sourceDigest, summary: "从原工作流复用当前版本结构化审阅报告", reviewer, recordedAt: this.options.now(), valid: true };
          next.reviews = [...reviews, review].slice(-100);
        }
      }
      if (signal?.aborted) fail("REQUEST_CANCELLED", "导入已取消");
      if ((await this.read(contentRef)).revisionDigest !== candidate.revisionDigest) fail("WORKFLOW_IMPORT_CHANGED", "记录期间文章已变化，请重新预览");
      // Revalidate every source at the final commit boundary, including the
      // draft summary's private upload-map dependency. Earlier identity reads
      // and the initial candidate parse are not commit-time freshness proof.
      const dependencies = [{ artifact: candidate.material.source, digest: candidate.material.sourceDigest }, ...(candidate.dependencies ?? [])];
      const currentDigests = await Promise.all(dependencies.map(async dependency => sha256(await this.readBytes(dependency.artifact))));
      if (dependencies.some((dependency, index) => dependency.digest !== currentDigests[index])) fail("WORKFLOW_IMPORT_CHANGED", "记录期间原报告或图片映射已变化，请重新预览");
      if (signal?.aborted) fail("REQUEST_CANCELLED", "导入已取消");
      assertCurrent?.();
      put(state, contentRef, next);
    });
    this.version += 1;
    return this.read(contentRef);
  }
  async restoreMissingRemoteUploads(document: ArticleDocument, result: WorkbenchRemoteResult, targetRef: string, accountRef: string): Promise<void> {
    let restored = false;
    await this.options.store.update(async state => {
      const saved = entry(state, document.contentRef);
      if (storedUploads(saved).length) return;
      const targets = storedTargets(saved), target = targets[0];
      const accounts = isJsonObject(saved.targetAccounts) ? saved.targetAccounts : {};
      if (targets.length !== 1 || !Array.isArray(saved.targets) || saved.targets.length !== 1 || !target || target.targetRef !== targetRef || target.mediaId !== result.remote?.remoteId || target.title !== document.metadata.title || target.sourceUrl !== document.metadata.sourceUrl || target.verifiedRevision || target.verifiedAt || accounts[targetRef] !== undefined && accounts[targetRef] !== accountRef) fail("UPLOAD_RECOVERY_TARGET_CHANGED", "图片映射恢复目标已变化，未覆盖现有记录");
      if (result.revisionDigest !== document.revisionDigest || (await this.read(document.contentRef)).revisionDigest !== document.revisionDigest) fail("UPLOAD_RECOVERY_REVISION_CHANGED", "图片映射与当前文章版本不一致，未恢复");
      const uploads = storedUploads({ uploads: result.uploads ?? [] });
      if (!uploads.length || uploads.length !== document.assets.length || !document.assets.every(asset => uploads.some(upload => upload.source === asset.source && `sha256:${upload.sha256}` === asset.digest))) fail("UPLOAD_RECOVERY_ASSETS_CHANGED", "账本图片映射未完整匹配当前素材，未恢复");
      // Restore only a lost cache from a validated ledger result, never a target,
      // verification flag, Job outcome or the historical result itself.
      put(state, document.contentRef, { ...saved, uploads });
      restored = true;
    });
    if (restored) this.version += 1;
  }
  async persistRemoteResult(document: ArticleDocument, result: WorkbenchRemoteResult, target: DraftTarget | null): Promise<void> {
    await this.options.store.update(state => {
      const saved = entry(state, document.contentRef);
      const targets = Array.isArray(saved.targets) ? saved.targets.filter(isJsonObject) : [];
      if (result.remote?.remoteId) {
        const targetRef = target?.targetRef ?? `target:${randomUUID()}`;
        const next = { targetRef, mediaId: result.remote.remoteId, title: document.metadata.title, sourceUrl: document.metadata.sourceUrl, verifiedRevision: result.ok ? document.revisionDigest : "", verifiedAt: result.ok ? result.verifiedAt ?? this.options.now() : "" };
        const index = targets.findIndex(value => value.targetRef === targetRef);
        if (index < 0) targets.push(next); else targets[index] = next;
      }
      const priorUploads = storedUploads(saved);
      const incomingUploads = result.uploads === undefined ? priorUploads : storedUploads({ uploads: result.uploads });
      const uploads = result.ok ? incomingUploads : storedUploads({ uploads: [...new Map([...priorUploads, ...incomingUploads].map(upload => [upload.source, upload])).values()] });
      put(state, document.contentRef, { ...saved, targets, uploads, lastCode: result.code });
    });
    this.version += 1;
  }
}

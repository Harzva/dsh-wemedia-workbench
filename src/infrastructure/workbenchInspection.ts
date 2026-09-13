import { inflateSync } from "node:zlib";
import type { ArticleDocument, ArticleEdit } from "../domain/workbench.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { ArtifactRef } from "../domain/content.ts";
import type { JsonObject } from "../domain/json.ts";
import { isJsonObject } from "../domain/json.ts";
import type { VersionSummary, VersionComparison } from "../domain/inspection.ts";
import { assetDifferences } from "../domain/inspection.ts";
import { safeRelativeFile, SHA256_PATTERN } from "../domain/wechatDocument.ts";
import { safeWorkflowText, WORKFLOW_PRIVATE } from "../domain/workflowImport.ts";

export interface StoredVersion extends JsonObject { id: string; document: ArtifactRef; revisionDigest: string; markdownDigest: string; title: string; recordedAt: string }
export function versionRecord(document: ArticleDocument, now: string, hash: (value: string) => string): StoredVersion {
  const markdownDigest = hash(document.markdown);
  return { id: `version:${hash(JSON.stringify([document.contentRef, document.document, document.revisionDigest, markdownDigest])).slice(7)}`, document: document.document, revisionDigest: document.revisionDigest, markdownDigest, title: document.metadata.title, recordedAt: now };
}
export function storedVersions(value: unknown): StoredVersion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new WorkbenchFault("HISTORY_INVALID", "历史索引无法安全读取");
  const output = value.map(raw => {
    if (!isJsonObject(raw) || Object.keys(raw).length !== 6 || Object.keys(raw).some(key => !["id", "document", "revisionDigest", "markdownDigest", "title", "recordedAt"].includes(key)) || typeof raw.id !== "string" || !/^version:[a-f0-9]{64}$/u.test(raw.id) || !isJsonObject(raw.document) || Object.keys(raw.document).length !== 2 || typeof raw.document.rootId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(raw.document.rootId) || !safeRelativeFile(raw.document.relativePath) || typeof raw.revisionDigest !== "string" || !SHA256_PATTERN.test(raw.revisionDigest) || typeof raw.markdownDigest !== "string" || !SHA256_PATTERN.test(raw.markdownDigest) || !safeWorkflowText(raw.title, 200) || typeof raw.recordedAt !== "string" || raw.recordedAt.length > 40 || !Number.isFinite(Date.parse(raw.recordedAt)) || WORKFLOW_PRIVATE.test(JSON.stringify(raw))) throw new WorkbenchFault("HISTORY_INVALID", "历史索引无法安全读取");
    return raw as unknown as StoredVersion;
  });
  if (new Set(output.map(item => item.id)).size !== output.length) throw new WorkbenchFault("HISTORY_INVALID", "历史索引存在重复身份");
  return output;
}
export function summarizeVersion(record: StoredVersion, currentId: string, available: boolean): VersionSummary {
  const { document: _document, ...summary } = record;
  return { ...summary, current: record.id === currentId, available };
}
export function compareDocuments(from: ArticleDocument, to: ArticleDocument): Pick<VersionComparison, "fields" | "assets"> {
  const fields: VersionComparison["fields"] = [];
  const metadataLabels = { title: "标题", digest: "纯文本摘要", author: "作者", articleId: "文章 ID", kind: "内容类型", titlePrefix: "标题前缀", sourceUrl: "来源 URL", pdfUrl: "PDF URL", codeUrl: "代码 URL" } as const;
  for (const key of Object.keys(metadataLabels) as Array<keyof typeof metadataLabels>) if (from.metadata[key] !== to.metadata[key]) fields.push({ path: metadataLabels[key], oldText: from.metadata[key], newText: to.metadata[key] });
  for (const key of ["html", "markdown"] as const) if (from[key] !== to[key]) fields.push({ path: key === "html" ? "正文 HTML" : "Markdown", oldText: from[key], newText: to[key] });
  return { fields, assets: assetDifferences(from.assets, to.assets) };
}

/** Strip ancillary metadata; only bounded raster PNG chunks reach the Client. */
export function screenshotProjection(bytes: Buffer): { dataUrl: string; width: number; height: number } {
  const fail = (): never => { throw new WorkbenchFault("SCREENSHOT_INVALID", "截图不是可显示的完整 390px PNG，请重新提供真实截图"); };
  if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return fail();
  let offset = 8, width = 0, height = 0, data = false, ended = false;
  const chunks = [bytes.subarray(0, 8)];
  const imageData: Buffer[] = []; let color = 0, depth = 0, palette = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) return fail();
    const kind = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4)) return fail();
    if (offset === 8 && kind !== "IHDR") return fail();
    if (kind === "IHDR") {
      if (width || size !== 13) return fail();
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      color = bytes[offset + 17]!; depth = bytes[offset + 16]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (width !== 390 || height < 200 || height > 20000 || !depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) return fail();
    }
    if (kind === "PLTE") { if (data || !size || size % 3 || size > 768) return fail(); palette = true; }
    if (kind === "IDAT") { data = true; imageData.push(bytes.subarray(offset + 8, end - 4)); }
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(kind)) chunks.push(bytes.subarray(offset, end));
    else if (kind[0] === kind[0]?.toUpperCase()) return fail();
    offset = end;
    if (kind === "IEND") { if (size || !data || offset !== bytes.length) return fail(); ended = true; break; }
  }
  if (!ended || color === 3 && !palette) return fail();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const stride = Math.ceil(width * depth * channels / 8) + 1;
  if (stride * height > 32 * 1024 * 1024) return fail();
  try {
    const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: stride * height });
    if (decoded.length !== stride * height) return fail();
    for (let row = 0; row < height; row++) if (decoded[row * stride]! > 4) return fail();
  } catch { return fail(); }
  return { dataUrl: `data:image/png;base64,${Buffer.concat(chunks).toString("base64")}`, width, height };
}

import { sourceRecordId } from "./scanner.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { PublicationDraft } from "../domain/publicationDraft.ts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { isLibraryTimestamp, LIBRARY_ITEM_ID, LIBRARY_MEDIA_CHUNK_BYTES, LIBRARY_MEDIA_MAX_BYTES } from "../domain/contentLibrary.ts";
import type { LibraryDetail, LibraryItem, LibraryListInput, LibraryMediaChunk, LibraryMediaInput, LibraryPage, PublicationStatus } from "../domain/contentLibrary.ts";
import { isJsonObject } from "../domain/json.ts";
import { decodeWechatDocument, htmlImageSources } from "../domain/wechatDocument.ts";
import { classifyArticle, isTaxonomyLabel, readArticleFrontmatter } from "../domain/articleTaxonomy.ts";
import type { ArticleCategory, ArticleFacets } from "../domain/articleTaxonomy.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { WorkbenchContentSummary } from "../domain/workbench.ts";
import type { ContentLibrary } from "../ports/contentLibrary.ts";
import type { WorkbenchDocuments } from "../ports/workbench.ts";
import type { PublicationReader } from "../ports/publication.ts";
import type { PublicationRecord } from "../domain/publication.ts";
import { aggregatePublicationStatus, publicationStatusForWorkflow } from "../domain/publication.ts";
import { isWithinRoot, normalizeRelativePath, resolveReadablePath } from "./pathPolicy.ts";
import { DEFAULT_EXCLUDES, matches } from "./scanner.ts";
import type { ScanRoot } from "./scanner.ts";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRIES = 12_000;
const MAX_DEPTH = 24;
const MAX_INLINE_IMAGES = 8 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"]);
const PRIVATE_SEGMENT = /(?:^\.|credential|secret|password|cookie|authorization|api[-_.]?key|access[-_.]?token|refresh[-_.]?token|^node_modules$)/iu;
const hash = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const idFor = (value: string): string => `library:${hash(value).slice(7)}`;
function standardItem(item: WorkbenchContentSummary): LibraryItem {
  return { itemId: idFor(item.contentRef), title: item.title, kind: "article", publicationType: "article", publicationStatus: aggregatePublicationStatus(item.publications, publicationStatusForWorkflow(item.status)), ...(item.publications ? { publications: item.publications } : {}), taxonomy: item.taxonomy ?? classifyArticle({ title: item.title }), origin: "workbench", rootLabel: item.rootLabel, readOnly: item.readOnlySource, legacyReadOnly: false, contentRef: item.contentRef, mediaType: null, bytes: null, revisionDigest: hash(JSON.stringify(item)), status: item.status, updatedAt: isLibraryTimestamp(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null };
}
function fault(code: string, message: string): never { throw new WorkbenchFault(code, message); }
function active(signal?: AbortSignal): void { if (signal?.aborted) fault("REQUEST_CANCELLED", "内容读取已取消"); }
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const decodeText = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[a-f0-9]{1,6});/giu, token => {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": "\u00a0" };
  if (named[token.toLowerCase()] !== undefined) return named[token.toLowerCase()]!;
  const code = token[2]?.toLowerCase() === "x" ? Number.parseInt(token.slice(3, -1), 16) : Number.parseInt(token.slice(2, -1), 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
});
const safeText = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").replace(/(?:file:\/\/[^\s<>"']+|\/(?:Users|Volumes|private|home|etc)\/[^\s<>"']+)/giu, "[本地路径]");

interface Locator { root: ScanRoot; path: string; type: "legacy" | "media" | "markdown" | "internal" | "registry"; articlePath?: string }
interface LocalArticle { item: LibraryItem; html: string | null; markdown: string | null; htmlPath: string | null; references: unknown[] }
interface OpenFile { handle: FileHandle; bytes: number; revisionDigest: string; updatedAt: string; header: Buffer; verify(): Promise<void> }
const decodeUtf8 = (data: Buffer): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return fault("LIBRARY_TEXT_INVALID", "本地文章不是有效的 UTF-8 文本"); }
};
const articleTitle = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
// These are operational documents even when they contain a Markdown heading.
const NON_ARTICLE = /(?:^|[\/._-])(?:readme|skill|demo|prompts?|reports?|records?|checklists?|inventory|ledger|manifest|completion|verification|smoke|batch|status|backlog|roadmap|plan|command)(?:$|[\/._-])|(?:^|\/)AGENTS\.md$|(?:发布记录|完成报告|验收报告|校验报告|检查清单|批量清单|提示词清单)/iu;
const SOURCE_MATERIAL_DIRECTORY = /^(?:paper-ocr|mineru|research|papers|source-papers)$/iu;
function articleFacets(items: LibraryItem[]): ArticleFacets {
  const categories = new Map<ArticleCategory, number>(), conferences = new Map<string, number>(), years = new Map<number, number>(), tags = new Map<string, number>();
  const count = <T,>(map: Map<T, number>, key: T): void => { map.set(key, (map.get(key) ?? 0) + 1); };
  for (const item of items) {
    if (item.kind !== "article" || !item.taxonomy) continue;
    const taxonomy = item.taxonomy;
    count(categories, taxonomy.category);
    if (taxonomy.conference) count(conferences, taxonomy.conference);
    if (taxonomy.year !== null) count(years, taxonomy.year);
    for (const tag of new Set(taxonomy.tags)) count(tags, tag);
  }
  return {
    categories: [...categories].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
    conferences: [...conferences].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
    years: [...years].map(([value, count]) => ({ value, count })).sort((a, b) => b.value - a.value),
    tags: [...tags].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
}

/** Reject links even when they resolve within a root, and apply exclusions to every read. */
function allowed(root: ScanRoot, path: string): boolean {
  const normalized = normalizeRelativePath(path);
  return normalized.ok && normalized.value === path && path.length > 0 && !path.split("/").some(part => PRIVATE_SEGMENT.test(part)) && !matches(path, [...DEFAULT_EXCLUDES, ...root.exclude]);
}
async function securePath(root: ScanRoot, path: string): Promise<string> {
  if (!allowed(root, path)) fault("LIBRARY_PATH_REJECTED", "内容路径不在允许的本地素材范围内");
  const rootInfo = await lstat(root.realPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fault("LIBRARY_PATH_REJECTED", "内容根目录已变化");
  let current = root.realPath;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fault("LIBRARY_PATH_REJECTED", "内容库不读取符号链接");
  }
  const resolved = await resolveReadablePath(root, path);
  if (!resolved.ok || resolved.value.kind !== "file" || resolved.value.absolutePath !== current) fault("LIBRARY_PATH_REJECTED", "内容路径无法安全解析");
  return resolved.value.absolutePath;
}
async function openSafe(root: ScanRoot, path: string, maximum: number): Promise<OpenFile> {
  const absolute = await securePath(root, path);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fault("LIBRARY_READ_UNSUPPORTED", "当前文件系统不支持安全媒体读取");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    const bytes = Number(info.size);
    if (!info.isFile() || bytes > maximum || bytes < 1) fault("LIBRARY_FILE_TOO_LARGE", "内容为空或超过本地预览体积限制");
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const verify = async (): Promise<void> => {
      if (await securePath(root, path) !== absolute) fault("LIBRARY_CHANGED", "内容已变化，请刷新后重试");
      const latest = await lstat(absolute, { bigint: true });
      const descriptor = await handle.stat({ bigint: true });
      if ([latest, descriptor].some(state => !state.isFile() || `${state.dev}:${state.ino}:${state.size}:${state.mtimeNs}:${state.ctimeNs}` !== signature)) fault("LIBRARY_CHANGED", "内容已变化，请刷新后重试");
    };
    const header = Buffer.alloc(Math.min(1024, bytes));
    const read = await handle.read(header, 0, header.length, 0);
    if (read.bytesRead !== header.length) fault("LIBRARY_CHANGED", "内容已变化，请刷新后重试");
    await verify();
    return { handle, bytes, header, revisionDigest: hash(`${root.id}:${path}:${signature}:${hash(header)}`), updatedAt: new Date(Number(info.mtimeMs)).toISOString(), verify };
  } catch (error) { await handle.close(); throw error; }
}
async function readSafe(root: ScanRoot, path: string, maximum: number): Promise<{ data: Buffer; revisionDigest: string; updatedAt: string }> {
  const file = await openSafe(root, path, maximum);
  try {
    const data = Buffer.alloc(file.bytes);
    const result = await file.handle.read(data, 0, data.length, 0);
    if (result.bytesRead !== data.length) fault("LIBRARY_CHANGED", "内容已变化，请刷新后重试");
    await file.verify();
    return { data, revisionDigest: hash(data), updatedAt: file.updatedAt };
  } finally { await file.handle.close(); }
}

/** A file extension alone never authorizes serving a browser media type. */
function mediaType(path: string, header: Buffer, bytes: number): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".png" && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.toString("ascii", 12, 16) === "IHDR" && bytes >= 45) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff && bytes >= 4) return "image/jpeg";
  if (extension === ".gif" && ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6)) && bytes >= 14) return "image/gif";
  if (extension === ".webp" && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" && header.length >= 16 && header.readUInt32LE(4) + 8 === bytes && ["VP8 ", "VP8L", "VP8X"].includes(header.toString("ascii", 12, 16))) return "image/webp";
  if ([".mp4", ".mov"].includes(extension) && header.length >= 20 && header.toString("ascii", 4, 8) === "ftyp" && header.readUInt32BE(0) >= 16 && header.readUInt32BE(0) <= bytes && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|qt  )$/u.test(header.toString("ascii", 8, 12))) return extension === ".mov" ? "video/quicktime" : "video/mp4";
  if (extension === ".webm" && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && header.includes(Buffer.from("webm"))) return "video/webm";
  return null;
}

/** Old manifests sometimes stored paths relative to their old project cwd. */
async function localReference(root: ScanRoot, manifest: string, input: unknown): Promise<string | null> {
  if (typeof input !== "string" || input.length > 2048 || /[\u0000-\u001f]/u.test(input)) return null;
  const candidates = new Set<string>();
  if (isAbsolute(input)) candidates.add(input);
  else {
    const normalized = normalizeRelativePath(input);
    if (!normalized.ok || !normalized.value) return null;
    candidates.add(resolve(root.realPath, dirname(manifest), normalized.value));
    let ancestor = root.realPath;
    for (let depth = 0; depth < 12; depth += 1) {
      candidates.add(resolve(ancestor, normalized.value));
      if (dirname(ancestor) === ancestor) break;
      ancestor = dirname(ancestor);
    }
  }
  for (const candidate of candidates) {
    if (!isWithinRoot(root.realPath, candidate)) continue;
    const path = relative(root.realPath, candidate).replaceAll("\\", "/");
    try { await securePath(root, path); return path; } catch { /* Invalid references are never returned. */ }
  }
  return null;
}

const PASSIVE_TAGS = new Set(["p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "s", "u", "br", "hr", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "span", "sup", "sub", "figure", "figcaption"]);
const BLOCKED_TAGS = new Set(["script", "style", "title", "head", "svg", "math", "iframe", "object", "template", "textarea", "xmp", "noembed", "noframes", "plaintext"]);
const RAW_TAGS = new Set(["script", "style", "title", "iframe", "textarea", "xmp", "noembed", "noframes", "plaintext"]);
interface HtmlToken { start: number; end: number; raw: string; name: string | null; closing: boolean }

/** A forward-only scanner: a broken tag never rescans the rest of the document. */
function* htmlTokens(source: string): Generator<HtmlToken> {
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) return;
    if (source.startsWith("<!--", start)) {
      const close = source.indexOf("-->", start + 4);
      const end = close < 0 ? source.length : close + 3;
      yield { start, end, raw: "", name: null, closing: false };
      cursor = end; continue;
    }
    let quote = "", end = start + 1;
    for (; end < source.length; end += 1) {
      const char = source[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">" || char === "<") break;
    }
    if (end === source.length) return;
    if (source[end] === "<") { cursor = end; continue; }
    const raw = source.slice(start, end + 1);
    const head = /^<\s*(\/\s*)?([a-z][a-z0-9]*)\b/iu.exec(raw);
    yield { start, end: end + 1, raw, name: head?.[2]?.toLowerCase() ?? null, closing: !!head?.[1] };
    cursor = end + 1;
  }
}

type PassivePart = { kind: "text"; text: string } | { kind: "tag"; raw: string; name: string; closing: boolean };
function suppressedToken(token: HtmlToken, blocked: string[]): boolean {
  const name = token.name;
  if (!name) return blocked.length > 0;
  const current = blocked[blocked.length - 1];
  if (current) {
    if (token.closing && name === current && current !== "plaintext") blocked.pop();
    else if (!RAW_TAGS.has(current) && !token.closing && BLOCKED_TAGS.has(name) && !/\/\s*>$/u.test(token.raw)) blocked.push(name);
    return true;
  }
  if (!BLOCKED_TAGS.has(name)) return false;
  if (!token.closing && !/\/\s*>$/u.test(token.raw)) blocked.push(name);
  return true;
}
/** Drop complete active regions, while retaining quoted attributes only for image lookup. */
function* passiveParts(source: string): Generator<PassivePart> {
  let bodyStart: number | null = null, bodyEnd: number | null = null;
  const scopeBlocked: string[] = [];
  for (const token of htmlTokens(source)) {
    if (suppressedToken(token, scopeBlocked)) continue;
    if (token.name !== "body") continue;
    if (!token.closing && bodyStart === null) bodyStart = token.end;
    else if (token.closing && bodyStart !== null) { bodyEnd = token.start; break; }
  }
  const input = bodyStart !== null && bodyEnd !== null ? source.slice(bodyStart, bodyEnd) : source;
  const blocked: string[] = [];
  let offset = 0;
  for (const token of htmlTokens(input)) {
    if (!blocked.length && token.start > offset) yield { kind: "text", text: input.slice(offset, token.start) };
    offset = token.end;
    const name = token.name;
    if (!name) continue;
    if (suppressedToken(token, blocked)) continue;
    if (PASSIVE_TAGS.has(name) || (name === "img" && !token.closing)) yield { kind: "tag", raw: token.raw, name, closing: token.closing };
  }
  if (!blocked.length && offset < input.length) yield { kind: "text", text: input.slice(offset) };
}

function passiveImageSources(source: string): string[] {
  const images = new Set<string>();
  for (const part of passiveParts(source)) {
    if (part.kind !== "tag" || part.name !== "img") continue;
    for (const reference of htmlImageSources(part.raw)) images.add(reference);
    if (images.size >= 100) break;
  }
  return [...images];
}

/** Rebuild a passive document; none of the source's attributes, CSS or navigation survive. */
function passiveHtml(source: string, images: Map<string, string>): string {
  const parts: string[] = [];
  for (const part of passiveParts(source)) {
    if (part.kind === "text") { parts.push(escape(safeText(decodeText(part.text)))); continue; }
    if (part.name === "img") {
      const uri = images.get(htmlImageSources(part.raw)[0] ?? "");
      if (uri) parts.push(`<img src="${uri}" alt="文章本地图片">`);
    } else parts.push(`<${part.closing ? "/" : ""}${part.name}>`);
  }
  const result = parts.join("");
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:white;color:#17202c}body{font:16px/1.85 system-ui;margin:0 auto;padding:28px;max-width:720px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #dbe0e7;padding:8px}pre{white-space:pre-wrap}blockquote{border-left:3px solid #ccd5df;margin-left:0;padding-left:16px}</style></head><body>${result}</body></html>`;
}

function publishedTime(item: LibraryItem, channel?: string): string | null {
  return (item.publications ?? []).filter(record => (!channel || record.channel === channel) && record.status === "published" && ["local_receipt", "remote_readback"].includes(record.evidence) && record.url && record.publishedAt && isLibraryTimestamp(record.publishedAt)).map(record => record.publishedAt!).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
function publicationItem(draft: PublicationDraft): LibraryItem {
  const publications: PublicationRecord[] = [...draft.channels.filter(channel => !draft.publications.some(record => record.channel === channel)).map(channel => ({ channel, status: "draft" as const, publishedAt: null, checkedAt: null, url: null, evidence: "local_draft" as const, note: "本地发布稿，尚未提交平台" })), ...draft.publications];
  return { itemId: idFor(draft.contentRef), title: draft.title, kind: draft.publicationType === "video" ? "video" : "article", publicationType: draft.publicationType, publicationStatus: aggregatePublicationStatus(publications, "draft"), publications, origin: "workbench", rootLabel: "内容写入目录", readOnly: draft.readOnlySource, legacyReadOnly: false, contentRef: null, publicationRef: draft.contentRef, mediaType: null, bytes: null, revisionDigest: draft.revisionDigest, status: "drafting", createdAt: draft.createdAt, updatedAt: draft.updatedAt, publishedAt: null };
}
export class FileContentLibrary implements ContentLibrary {
  private locations = new Map<string, Locator>();
  constructor(private readonly options: { roots: readonly ScanRoot[]; documents: WorkbenchDocuments; publications?: PublicationReader; publicationDrafts?: () => Promise<PublicationDraft[] | { drafts: PublicationDraft[]; issues: string[] }>; sourceBindings?: () => Promise<Record<string, ContentRef>> }) {}
  private async mediaCatalog(signal?: AbortSignal): Promise<{ drafts: PublicationDraft[]; issues: string[] }> {
    try {
      const result = await this.options.publicationDrafts?.() ?? [];
      active(signal);
      return Array.isArray(result) ? { drafts: result, issues: [] } : result;
    } catch {
      active(signal);
      return { drafts: [], issues: ["媒体发布稿索引暂不可读取；文章与原素材仍可浏览，请核对本地稿件。"] };
    }
  }

  private async legacy(root: ScanRoot, path: string): Promise<{ item: LibraryItem; value: Record<string, unknown> }> {
    const source = await readSafe(root, path, MAX_MANIFEST_BYTES);
    const value: unknown = JSON.parse(decodeUtf8(source.data));
    if (!isJsonObject(value) || value.schema !== "wemedia.wechat.local_draft.v1" || typeof value.title !== "string" || !value.title.trim() || value.title.length > 500) fault("LIBRARY_MANIFEST_INVALID", "旧稿清单缺少可用的标题或格式");
    const item: LibraryItem = { itemId: idFor(`${root.id}:${path}`), title: safeText(value.title).slice(0, 200), kind: "article", publicationType: "article", publicationStatus: "draft", origin: "legacy", rootLabel: safeText(root.label), readOnly: true, legacyReadOnly: true, contentRef: null, mediaType: null, bytes: null, revisionDigest: source.revisionDigest, status: "legacy_readonly", updatedAt: source.updatedAt };
    item.taxonomy = classifyArticle({ title: item.title, path: `${path} ${typeof value.article === "string" ? value.article : ""}`, metadata: value });
    const paths = [resolve(root.realPath, path)];
    const workspaceRelativePaths: string[] = [];
    for (const reference of [value.article, value.preview_html]) {
      const local = await localReference(root, path, reference);
      if (local) paths.push(resolve(root.realPath, local));
      else if (typeof reference === "string") workspaceRelativePaths.push(reference);
    }
    const external = await this.options.publications?.lookup({ sourcePaths: paths, workspaceRelativePaths });
    const records: PublicationRecord[] = external?.publications ?? [];
    item.publications = records.some(record => record.channel === "wechat") ? records : [{ channel: "wechat", status: "draft", publishedAt: null, checkedAt: null, url: null, evidence: "local_draft", note: "本地文章草稿，尚无正式发布回执。" }, ...records];
    item.publicationStatus = aggregatePublicationStatus(item.publications, "draft");
    if (external?.issues.length) item.publications.push({ channel: "wechat", status: "unknown", publishedAt: null, checkedAt: null, url: null, evidence: "none", note: "部分本地发布记录不可读取，请在设置与能力中核对记录来源。" });
    item.revisionDigest = hash(JSON.stringify([source.revisionDigest, item.publications]));
    return { item, value };
  }
  private async localArticle(root: ScanRoot, path: string, title: string, source: { revisionDigest: string; updatedAt: string }, metadata: Record<string, unknown>, markdown: string | null, html: string | null, htmlPath: string | null, references: unknown[] = []): Promise<LocalArticle> {
    const item: LibraryItem = { itemId: idFor(`${root.id}:${path}`), title: safeText(title).slice(0, 200), kind: "article", publicationType: "article", publicationStatus: "draft", origin: "local", rootLabel: safeText(root.label), readOnly: true, legacyReadOnly: true, contentRef: null, mediaType: null, bytes: null, revisionDigest: source.revisionDigest, status: "local_readonly", updatedAt: source.updatedAt,
      taxonomy: classifyArticle({ title, path, metadata, ...(markdown === null ? {} : { markdown }) }) };
    const paths = [resolve(root.realPath, path)];
    for (const reference of references) {
      const local = await localReference(root, path, reference);
      if (local) paths.push(resolve(root.realPath, local));
    }
    const external = await this.options.publications?.lookup({ sourcePaths: paths });
    const records = external?.publications ?? [];
    item.publications = records.some(record => record.channel === "wechat") ? records : [{ channel: "wechat", status: "draft", publishedAt: null, checkedAt: null, url: null, evidence: "local_draft", note: "本地文章草稿，尚无正式发布回执。" }, ...records];
    item.publicationStatus = aggregatePublicationStatus(item.publications, "draft");
    if (external?.issues.length) item.publications.push({ channel: "wechat", status: "unknown", publishedAt: null, checkedAt: null, url: null, evidence: "none", note: "部分本地发布记录不可读取，请在设置与能力中核对记录来源。" });
    item.revisionDigest = hash(JSON.stringify([source.revisionDigest, item.publications, item.taxonomy]));
    return { item, html, markdown, htmlPath, references };
  }
  private async markdownArticle(root: ScanRoot, path: string): Promise<LocalArticle> {
    if (NON_ARTICLE.test(path) || /(?:^|\/)assets\//iu.test(path)) fault("LIBRARY_MANIFEST_INVALID", "管理文档与论文素材不列入文章库");
    const source = await readSafe(root, path, MAX_TEXT_BYTES);
    const markdown = decodeUtf8(source.data);
    const metadata = readArticleFrontmatter(markdown);
    const title = metadata.title ?? /^#\s+([^\r\n]+)\s*$/mu.exec(markdown)?.[1]?.trim();
    if (!articleTitle(title)) fault("LIBRARY_MANIFEST_INVALID", "文章需要明确的标题");
    return this.localArticle(root, path, title, source, metadata, safeText(markdown), null, null);
  }
  private async internalArticle(root: ScanRoot, path: string): Promise<LocalArticle> {
    const source = await readSafe(root, path, MAX_TEXT_BYTES);
    const value: unknown = JSON.parse(decodeUtf8(source.data));
    if (!isJsonObject(value) || value.schema !== "wemedia.wechat.local_draft.v1.internal" || !articleTitle(value.title) || typeof value.content !== "string" || !value.content.trim()) fault("LIBRARY_MANIFEST_INVALID", "本地内嵌稿件格式不受支持");
    return this.localArticle(root, path, value.title, source, value, null, value.content, path, [value.article, value.preview_html]);
  }
  private async registryArticles(root: ScanRoot, path: string, signal?: AbortSignal, requestedPath?: string): Promise<LocalArticle[]> {
    const source = await readSafe(root, path, MAX_MANIFEST_BYTES);
    const value: unknown = JSON.parse(decodeUtf8(source.data));
    if (!isJsonObject(value) || value.schema !== "cvpr2026-series-link-registry.v1" || !Array.isArray(value.topics) || value.topics.length > 100) fault("LIBRARY_MANIFEST_INVALID", "会议系列清单格式不受支持");
    const output: LocalArticle[] = [];
    const seen = new Set<string>();
    for (const topic of value.topics) {
      active(signal);
      if (!isJsonObject(topic) || !Array.isArray(topic.articles) || topic.articles.length > 1000) continue;
      const rows = [...(isJsonObject(topic.navigation) ? [{ entry: topic.navigation, navigation: true }] : []), ...topic.articles.map(entry => ({ entry, navigation: false }))];
      for (const { entry, navigation } of rows) {
        active(signal);
        if (!isJsonObject(entry) || !articleTitle(entry.title)) continue;
        const htmlPath = await localReference(root, path, entry.local_html);
        if (!htmlPath || ![".html", ".htm"].includes(extname(htmlPath).toLowerCase()) || seen.has(htmlPath) || requestedPath !== undefined && htmlPath !== requestedPath) continue;
        seen.add(htmlPath);
        if (output.length >= 1000) fault("LIBRARY_FILE_TOO_LARGE", "会议系列超过本地预览数量限制");
        try {
          const html = await readSafe(root, htmlPath, MAX_TEXT_BYTES);
          const tags = [...(isTaxonomyLabel(topic.title) ? [topic.title] : []), ...(navigation ? ["专题导航"] : [])];
          const decoded = decodeUtf8(html.data);
          const article = await this.localArticle(root, htmlPath, entry.title, { revisionDigest: hash(`${source.revisionDigest}:${html.revisionDigest}`), updatedAt: html.updatedAt }, { conference: "CVPR", year: 2026, tags }, null, requestedPath === undefined ? null : decoded, htmlPath);
          output.push(article);
        } catch (error) { if (requestedPath !== undefined) throw error; /* Unreadable references are not usable articles. */ }
      }
    }
    return output;
  }
  private async mediaItem(root: ScanRoot, path: string): Promise<LibraryItem> {
    const file = await openSafe(root, path, LIBRARY_MEDIA_MAX_BYTES);
    try {
      const mime = mediaType(path, file.header, file.bytes);
      if (!mime) fault("LIBRARY_MEDIA_INVALID", "文件内容与支持的图片或视频格式不符");
      return { itemId: idFor(`${root.id}:${path}`), title: safeText(basename(path)), kind: mime.startsWith("image/") ? "image" : "video", publicationType: mime.startsWith("image/") ? null : "video", publicationStatus: "unknown", origin: "local", rootLabel: safeText(root.label), readOnly: true, legacyReadOnly: false, contentRef: null, mediaType: mime, bytes: file.bytes, revisionDigest: file.revisionDigest, status: "local", updatedAt: file.updatedAt };
    } finally { await file.handle.close(); }
  }
  private async scan(signal?: AbortSignal): Promise<{ items: LibraryItem[]; issues: string[]; truncated: boolean }> {
    const output: LibraryItem[] = [];
    const locations = new Map<string, Locator>();
    const issues = new Set<string>();
    const files: Array<{ root: ScanRoot; path: string }> = [];
    const represented = new Set<string>();
    let truncated = false;
    let visited = 0;
    const walk = async (root: ScanRoot, path: string, depth: number): Promise<void> => {
      active(signal);
      if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) { truncated = true; return; }
      const entries = await readdir(resolve(root.realPath, path), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        active(signal);
        if (++visited > MAX_ENTRIES) { truncated = true; break; }
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (!allowed(root, child) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          // Source papers and OCR are research inputs; their headings are not authored drafts.
          // This only controls discovery, leaving explicitly referenced article images readable.
          if (SOURCE_MATERIAL_DIRECTORY.test(entry.name)) continue;
          if (!matches(`${child}/`, [...DEFAULT_EXCLUDES, ...root.exclude])) {
            const info = await lstat(resolve(root.realPath, child));
            if (info.isDirectory() && !info.isSymbolicLink()) await walk(root, child, depth + 1);
          }
        } else if (entry.isFile() && (root.include.length === 0 || matches(child, root.include))) files.push({ root, path: child });
      }
    };
    const enabled = this.options.roots.filter(root => root.enabled);
    for (const root of enabled) {
      active(signal);
      try {
        const info = await lstat(root.realPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("root unavailable");
        await walk(root, "", 0);
      } catch { active(signal); issues.add("部分内容根目录暂不可读取，列表可能不完整"); }
    }
    const noteError = (error: unknown): void => {
      active(signal);
      if (error instanceof WorkbenchFault && error.code === "LIBRARY_FILE_TOO_LARGE") issues.add("部分文件为空或超过预览体积限制，未列入内容库");
    };
    const add = (item: LibraryItem, locator: Locator): void => {
      const identity = resolve(locator.root.realPath, locator.articlePath ?? locator.path);
      if (represented.has(identity)) return;
      represented.add(identity); output.push(item); locations.set(item.itemId, locator);
    };
    const markReferences = async (root: ScanRoot, path: string, references: unknown[]): Promise<void> => {
      for (const reference of references) {
        active(signal);
        if (typeof reference !== "string" || reference.length > 2048 || /[\u0000-\u001f]/u.test(reference)) continue;
        const normalized = isAbsolute(reference) ? null : normalizeRelativePath(reference);
        if (!isAbsolute(reference) && (!normalized?.ok || !normalized.value)) continue;
        // Deduplication uses only the declared absolute identity or its unique
        // manifest-relative resolution. Preview compatibility fallbacks cannot
        // claim a different draft merely because an ancestor contains its name.
        const candidate = resolve(root.realPath, dirname(path), reference);
        for (const other of enabled) {
          if (!isWithinRoot(other.realPath, candidate)) continue;
          try { represented.add(await securePath(other, relative(other.realPath, candidate).replaceAll("\\", "/"))); } catch { /* Unconfirmed duplicate artifacts stay visible. */ }
        }
      }
    };
    // Structured manifests own only their exact declared artifacts, never a title or stem.
    for (const { root, path } of files) {
      active(signal);
      try {
        if (basename(path).endsWith(".local-wechat-draft.json") || basename(path) === "wechat-document.json") {
          const source = await readSafe(root, path, MAX_MANIFEST_BYTES);
          const document = decodeWechatDocument(JSON.parse(decodeUtf8(source.data)));
          // Native document paths are strictly manifest-relative. Legacy project-cwd
          // fallback would allow an invalid native manifest to hide another draft.
          const declared = (reference: string): string => relative(root.realPath, resolve(root.realPath, dirname(path), reference)).replaceAll("\\", "/");
          await securePath(root, declared(document.contentFile));
          for (const reference of [document.contentFile, document.previewFile, document.markdownFile]) {
            if (reference === undefined) continue;
            try { represented.add(await securePath(root, declared(reference))); } catch { /* Missing optional artifacts own no other file. */ }
          }
        } else if (basename(path) === "article.wechat-local-draft.json") {
          const source = await readSafe(root, path, MAX_TEXT_BYTES);
          const value: unknown = JSON.parse(decodeUtf8(source.data));
          if (isJsonObject(value) && value.schema === "wemedia.wechat.local_draft.v1.internal") {
            const article = await this.internalArticle(root, path);
            add(article.item, { root, path, type: "internal" });
            await markReferences(root, path, article.references);
          } else {
            const article = await this.legacy(root, path);
            add(article.item, { root, path, type: "legacy" });
            await markReferences(root, path, [article.value.article, article.value.preview_html]);
          }
        } else if (basename(path) === "cvpr2026-series-links.json") {
          for (const article of await this.registryArticles(root, path, signal)) {
            add(article.item, { root, path, type: "registry", articlePath: article.htmlPath! });
          }
        }
      } catch (error) { noteError(error); }
    }
    for (const { root, path } of files) {
      active(signal);
      if (represented.has(resolve(root.realPath, path))) continue;
      try {
        if ([".md", ".markdown"].includes(extname(path).toLowerCase())) add((await this.markdownArticle(root, path)).item, { root, path, type: "markdown" });
        else if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) add(await this.mediaItem(root, path), { root, path, type: "media" });
      } catch (error) { noteError(error); }
    }
    if (truncated) issues.add("内容扫描达到数量或目录深度限制；当前展示部分结果，请缩小配置的内容根目录");
    active(signal);
    this.locations = locations;
    return { items: output, issues: [...issues], truncated };
  }
  async list(input: LibraryListInput = {}, signal?: AbortSignal): Promise<LibraryPage> {
    if (input.category !== undefined && !["conference", "arxiv", "other"].includes(input.category) || input.conference !== undefined && !isTaxonomyLabel(input.conference) || input.tag !== undefined && !isTaxonomyLabel(input.tag) || input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2099)) fault("REQUEST_INVALID", "文章分类筛选格式无效");
    if (input.updatedFrom !== undefined && !isLibraryTimestamp(input.updatedFrom) || input.updatedTo !== undefined && !isLibraryTimestamp(input.updatedTo)) fault("REQUEST_INVALID", "筛选时间必须包含完整日期、时间和时区");
    const from = input.updatedFrom === undefined ? null : Date.parse(input.updatedFrom);
    const to = input.updatedTo === undefined ? null : Date.parse(input.updatedTo);
    if (from !== null && to !== null && from >= to) fault("REQUEST_INVALID", "筛选结束时间必须晚于开始时间");
    const scan = await this.scan(signal);
    const documents = await this.options.documents.list();
    active(signal);
    const standard = documents.map(standardItem);
    const query = (input.query ?? "").trim().toLocaleLowerCase();
    const mediaCatalog = await this.mediaCatalog(signal);
    const publicationDrafts = mediaCatalog.drafts;
    scan.issues.push(...mediaCatalog.issues);
    const bindings = await this.options.sourceBindings?.() ?? {};
    const libraryItems = [...standard, ...scan.items, ...publicationDrafts.map(publicationItem)].map(item => ({ ...this.withMapping(item, bindings), createdAt: item.createdAt ?? null, publishedAt: publishedTime(item, input.channel) }));
    const time = (item: LibraryItem): string | null => input.timeField === "created" ? item.createdAt ?? null : input.timeField === "published" ? item.publishedAt ?? null : item.updatedAt;
    const facets = articleFacets(libraryItems);
    const all = libraryItems.filter(item => {
      if (input.kind && item.kind !== input.kind || input.publicationType && item.publicationType !== input.publicationType || !input.channel && input.publicationStatus && item.publicationStatus !== input.publicationStatus) return false;
      if (input.category && item.taxonomy?.category !== input.category || input.conference && item.taxonomy?.conference !== input.conference || input.year !== undefined && item.taxonomy?.year !== input.year || input.tag && !item.taxonomy?.tags.includes(input.tag)) return false;
      if (input.channel && !item.publications?.some(record => record.channel === input.channel)) return false;
      const channelRecords = item.publications?.filter(record => record.channel === input.channel);
      if (input.channel && input.publicationStatus && aggregatePublicationStatus(channelRecords, channelRecords?.some(record => record.status === "draft") ? "draft" : "unknown") !== input.publicationStatus) return false;
      const timestamp = time(item);
      const modified = timestamp === null ? null : Date.parse(timestamp);
      if ((from !== null || to !== null) && (modified === null || from !== null && modified < from || to !== null && modified >= to)) return false;
      return `${item.title} ${item.rootLabel} ${item.taxonomy?.category ?? ""} ${item.taxonomy?.conference ?? ""} ${item.taxonomy?.tags.join(" ") ?? ""}`.toLocaleLowerCase().includes(query);
    }).sort((a, b) => {
      // Missing dates stay last in both directions; never invent the scan time.
      const aTime = time(a), bTime = time(b);
      if ((aTime === null) !== (bTime === null)) return aTime === null ? 1 : -1;
      const difference = aTime === null || bTime === null ? 0 : Date.parse(aTime) - Date.parse(bTime);
      return (input.sort === "updated_asc" ? difference : -difference) || a.title.localeCompare(b.title) || a.itemId.localeCompare(b.itemId);
    });
    const revisionDigest = hash(JSON.stringify(all));
    const cursorKey = hash(JSON.stringify([input.channel ?? null, input.timeField ?? "updated", query, input.kind ?? "all", input.publicationType ?? "all", input.publicationStatus ?? "all", input.category ?? null, input.conference ?? null, input.year ?? null, input.tag ?? null, from, to, input.sort ?? "updated_desc", input.pageSize ?? 40, revisionDigest])).slice(7);
    const cursor = input.cursor?.split(":");
    if (cursor && (cursor.length !== 2 || cursor[0] !== cursorKey || !/^\d+$/u.test(cursor[1]!))) fault("CURSOR_STALE", "内容列表已变化，请从第一页刷新");
    const offset = cursor ? Number(cursor[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset > all.length) fault("CURSOR_STALE", "内容列表分页已失效，请刷新");
    const limit = input.pageSize ?? 40;
    return { items: all.slice(offset, offset + limit), total: all.length, nextCursor: offset + limit < all.length ? `${cursorKey}:${offset + limit}` : null, revisionDigest, facets, issues: scan.issues, truncated: scan.truncated };
  }
  private withMapping(item: LibraryItem, bindings: Record<string, ContentRef>): LibraryItem {
    const location = this.locations.get(item.itemId);
    const reference = location && item.publicationType === "article" ? bindings[sourceRecordId(location.root.id, location.type === "registry" ? location.articlePath ?? location.path : location.path)] : undefined;
    return reference ? { ...item, mappingRef: reference } : item;
  }
  private async locate(itemId: string, signal?: AbortSignal): Promise<Locator | undefined> {
    active(signal);
    if (!LIBRARY_ITEM_ID.test(itemId)) fault("REQUEST_INVALID", "内容编号格式无效");
    if (!this.locations.has(itemId)) await this.scan(signal);
    return this.locations.get(itemId);
  }
  private async readLocal(location: Locator, signal?: AbortSignal): Promise<LocalArticle> {
    if (location.type === "markdown") return this.markdownArticle(location.root, location.path);
    if (location.type === "internal") return this.internalArticle(location.root, location.path);
    if (location.type === "registry" && location.articlePath) {
      const article = (await this.registryArticles(location.root, location.path, signal, location.articlePath))[0];
      if (article) return article;
    }
    return fault("LIBRARY_NOT_FOUND", "本地文章已不可用，请刷新列表");
  }
  async read(itemId: string, signal?: AbortSignal): Promise<LibraryDetail> {
    const location = await this.locate(itemId, signal);
    if (!location) {
      const publication = (await this.mediaCatalog(signal)).drafts.find(draft => idFor(draft.contentRef) === itemId);
      if (publication) return { item: publicationItem(publication), html: null, markdown: publication.body, issues: publication.issues };
      const document = (await this.options.documents.list()).find(item => idFor(item.contentRef) === itemId);
      if (!document) fault("LIBRARY_NOT_FOUND", "内容已不可用，请刷新列表");
      const preview = await this.options.documents.preview(document.contentRef);
      active(signal);
      return { item: { ...standardItem(document), revisionDigest: preview.revisionDigest }, html: preview.html, markdown: null, issues: preview.issues };
    }
    const { root, path } = location;
    if (location.type === "media") {
      const item = await this.mediaItem(root, path);
      active(signal);
      return { item, html: null, markdown: null, issues: [] };
    }
    const local = location.type === "legacy" ? null : await this.readLocal(location, signal);
    const legacy = local === null ? await this.legacy(root, path) : null;
    const item = this.withMapping(local?.item ?? legacy!.item, await this.options.sourceBindings?.() ?? {});
    const htmlPath = local?.htmlPath ?? (legacy ? await localReference(root, path, legacy.value.preview_html) : null);
    const markdownPath = legacy ? await localReference(root, path, legacy.value.article) : null;
    const issues: string[] = [];
    let markdown: string | null = local?.markdown ?? null, source: string | null = local?.html ?? null;
    if (markdownPath && [".md", ".markdown"].includes(extname(markdownPath).toLowerCase())) {
      markdown = safeText(decodeUtf8((await readSafe(root, markdownPath, MAX_TEXT_BYTES)).data));
    }
    if (!local && htmlPath && [".html", ".htm"].includes(extname(htmlPath).toLowerCase())) source = decodeUtf8((await readSafe(root, htmlPath, MAX_TEXT_BYTES)).data);
    if (!source && markdown) source = `<pre>${escape(markdown)}</pre>`;
    const images = new Map<string, string>();
    if (source && htmlPath) {
      let imageBytes = 0;
      for (const reference of passiveImageSources(source)) {
        active(signal);
        if (reference.startsWith("data:") || /^[a-z]+:/iu.test(reference) || reference.startsWith("//")) continue;
        const imagePath = await localReference(root, htmlPath, reference);
        if (!imagePath) continue;
        try {
          const image = await readSafe(root, imagePath, MAX_INLINE_IMAGES);
          const mime = mediaType(imagePath, image.data.subarray(0, 1024), image.data.length);
          if (!mime?.startsWith("image/") || imageBytes + image.data.length > MAX_INLINE_IMAGES) continue;
          imageBytes += image.data.length;
          images.set(reference, `data:${mime};base64,${image.data.toString("base64")}`);
        } catch { /* Images remain optional and strictly local. */ }
      }
    }
    if (!source) issues.push("本地稿件正文未位于此内容根内，当前仅可查看清单信息");
    else issues.push("本地文章以只读静态内容展示；外部资源与原页面交互已移除");
    const current = local ? await this.readLocal(location, signal) : await this.legacy(root, path);
    active(signal);
    if (current.item.revisionDigest !== item.revisionDigest) fault("LIBRARY_CHANGED", "旧稿清单已变化，请刷新后重试");
    return { item, html: source ? passiveHtml(source, images) : null, markdown, issues };
  }
  async media(input: LibraryMediaInput, signal?: AbortSignal): Promise<LibraryMediaChunk> {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > LIBRARY_MEDIA_CHUNK_BYTES) fault("REQUEST_INVALID", "媒体分块范围无效");
    const location = await this.locate(input.itemId, signal);
    if (!location || location.type !== "media") fault("LIBRARY_NOT_FOUND", "媒体内容已不可用，请刷新列表");
    const file = await openSafe(location.root, location.path, LIBRARY_MEDIA_MAX_BYTES);
    try {
      if (file.revisionDigest !== input.revisionDigest) fault("LIBRARY_CHANGED", "媒体文件已变化，请刷新后重新打开");
      const mime = mediaType(location.path, file.header, file.bytes);
      if (!mime) fault("LIBRARY_MEDIA_INVALID", "文件内容与支持的图片或视频格式不符");
      if (input.offset >= file.bytes) fault("REQUEST_INVALID", "媒体分块范围超出文件长度");
      const data = Buffer.alloc(Math.min(input.length, file.bytes - input.offset));
      const read = await file.handle.read(data, 0, data.length, input.offset);
      if (read.bytesRead !== data.length) fault("LIBRARY_CHANGED", "媒体文件已变化，请重新打开");
      await file.verify();
      active(signal);
      return { itemId: input.itemId, revisionDigest: file.revisionDigest, offset: input.offset, totalBytes: file.bytes, mediaType: mime, dataBase64: data.toString("base64"), eof: input.offset + data.length === file.bytes };
    } finally { await file.handle.close(); }
  }
}

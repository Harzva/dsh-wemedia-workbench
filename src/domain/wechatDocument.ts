import { isJsonObject } from "./json.ts";
import type { ArticleMetadata } from "./workbench.ts";
import { DOCUMENT_SCHEMA, WorkbenchFault } from "./workbench.ts";

export const LEGACY_WECHAT_DOCUMENT_SCHEMA = "justagent.local-wechat-draft.v1" as const;
import { SHA256_PATTERN, safeRelativeFile } from "./artifactValidation.ts";
export { SHA256_PATTERN, safeRelativeFile } from "./artifactValidation.ts";

export function safeWebUrl(value: unknown, optional = false): value is string {
  if (typeof value !== "string") return false;
  if (optional && value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      ![...url.searchParams.keys()].some((key) => /token|secret|password|authorization|cookie|api.?key/iu.test(key));
  } catch { return false; }
}

function text(value: unknown, maximum: number, empty = true): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && value.trim() === "") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new WorkbenchFault("DOCUMENT_INVALID", "文章元数据格式不受支持");
  }
  return value;
}

export function decodeArticleMetadata(value: unknown): ArticleMetadata {
  if (!isJsonObject(value)) throw new WorkbenchFault("DOCUMENT_INVALID", "文章元数据必须是对象");
  const articleId = text(value.articleId, 100, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(articleId)) throw new WorkbenchFault("DOCUMENT_ID_INVALID", "文章来源标识无效");
  if (value.kind !== "paper" && value.kind !== "article") throw new WorkbenchFault("DOCUMENT_KIND_INVALID", "文章类型无效");
  const sourceUrl = text(value.sourceUrl, 2048);
  const pdfUrl = text(value.pdfUrl, 2048);
  const codeUrl = text(value.codeUrl, 2048);
  if (![sourceUrl, pdfUrl, codeUrl].every((url) => safeWebUrl(url, true))) throw new WorkbenchFault("SOURCE_URL_INVALID", "来源必须是无认证信息的 HTTPS 链接");
  return {
    articleId, title: text(value.title, 200, false), author: text(value.author, 100),
    digest: text(value.digest, 1000), kind: value.kind,
    titlePrefix: text(value.titlePrefix, 100), sourceUrl, pdfUrl, codeUrl,
  };
}

export interface DecodedWechatDocument {
  metadata: ArticleMetadata;
  contentFile: string;
  previewFile?: string;
  markdownFile?: string;
  legacy: boolean;
}

export function decodeWechatDocument(value: unknown): DecodedWechatDocument {
  if (!isJsonObject(value)) throw new WorkbenchFault("DOCUMENT_INVALID", "微信文档必须是对象");
  if (value.schema === LEGACY_WECHAT_DOCUMENT_SCHEMA) {
    if (!safeRelativeFile(value.content_file) || (value.preview_file !== undefined && !safeRelativeFile(value.preview_file))) {
      throw new WorkbenchFault("DOCUMENT_PATH_INVALID", "微信文档包含不安全的相对路径");
    }
    const metadata = decodeArticleMetadata({
      articleId: value.article_id, title: value.title, author: value.author ?? "",
      digest: value.digest ?? "", kind: "paper", titlePrefix: value.title_prefix ?? "",
      sourceUrl: value.content_source_url ?? "", pdfUrl: value.official_pdf_url ?? "", codeUrl: value.code_url ?? "",
    });
    return { metadata, contentFile: value.content_file, legacy: true, ...(value.preview_file === undefined ? {} : { previewFile: value.preview_file }) };
  }
  if (value.schemaVersion !== DOCUMENT_SCHEMA) throw new WorkbenchFault("DOCUMENT_SCHEMA_UNSUPPORTED", "尚不支持此微信文档格式");
  if (!safeRelativeFile(value.contentFile) || (value.markdownFile !== undefined && !safeRelativeFile(value.markdownFile))) {
    throw new WorkbenchFault("DOCUMENT_PATH_INVALID", "文档路径必须位于受控目录");
  }
  return {
    metadata: decodeArticleMetadata(value.metadata), contentFile: value.contentFile, legacy: false,
    ...(value.markdownFile === undefined ? {} : { markdownFile: value.markdownFile }),
  };
}

/** Ordered exactly like the existing article_revision.mjs producer. */
export function revisionPayload(metadata: ArticleMetadata, htmlDigest: string, assets: Array<{ source: string; digest: string }>): string {
  const native = {
    article_id: metadata.articleId, title: metadata.title, title_prefix: metadata.titlePrefix,
    author: metadata.author, digest: metadata.digest, content_source_url: metadata.sourceUrl,
    official_pdf_url: metadata.pdfUrl, code_url: metadata.codeUrl,
  };
  return JSON.stringify([
    "wemedia.article-revision.v1", Object.entries(native), htmlDigest.replace(/^sha256:/u, ""),
    assets.map((asset) => [asset.source, asset.digest.replace(/^sha256:/u, "")]),
  ]);
}

const HTML_TAG = /<!--[\s\S]*?(?:-->|$)|<(?:[^"'<>]|"[^"]*"|'[^']*')*>/gu;
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
function decodeImageSource(value: string): string {
  return value.replace(/&(?:amp|quot|apos);|&#(x[0-9a-f]+|[0-9]+);/giu, (entity: string, encoded?: string) => {
    if (!encoded) return ({ "&amp;": "&", "&quot;": '"', "&apos;": "'" } as Record<string, string>)[entity.toLowerCase()]!;
    const point = encoded[0]?.toLowerCase() === "x" ? Number.parseInt(encoded.slice(1), 16) : Number.parseInt(encoded, 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  });
}
/** Read actual attributes, never attribute-like text inside another quoted value. */
function imageSourceRanges(html: string): Array<{ start: number; end: number; value: string; needsEquals: boolean }> {
  const ranges: Array<{ start: number; end: number; value: string; needsEquals: boolean }> = [];
  let rawText = "";
  for (const token of html.matchAll(HTML_TAG)) {
    const tag = token[0], head = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/u.exec(tag);
    if (!head) continue;
    const name = head[2]!.toLowerCase(), closing = head[1] === "/";
    if (rawText) { if (closing && name === rawText && rawText !== "plaintext") rawText = ""; continue; }
    if (closing) continue;
    if (RAW_TEXT_TAGS.has(name)) { rawText = name; continue; }
    if (name !== "img") continue;
    let cursor = head[0].length;
    while (cursor < tag.length - 1) {
      while (/[\s/]/u.test(tag[cursor] ?? "")) cursor += 1;
      const attribute = /^[^\s/=>]+/u.exec(tag.slice(cursor));
      if (!attribute) { cursor += 1; continue; }
      cursor += attribute[0].length;
      while (/\s/u.test(tag[cursor] ?? "")) cursor += 1;
      const hasValue = tag[cursor] === "=";
      if (hasValue) { cursor += 1; while (/\s/u.test(tag[cursor] ?? "")) cursor += 1; }
      const start = cursor, quote = hasValue && (tag[cursor] === '"' || tag[cursor] === "'") ? tag[cursor++]! : "";
      if (hasValue) {
        while (cursor < tag.length - 1 && (quote ? tag[cursor] !== quote : !/[\s>]/u.test(tag[cursor]!))) cursor += 1;
        if (quote && tag[cursor] === quote) cursor += 1;
      }
      if (attribute[0].toLowerCase() === "src") {
        const value = hasValue ? tag.slice(start + (quote ? 1 : 0), cursor - (quote ? 1 : 0)) : "";
        // A bare src is empty in HTML; insert a value after its name when rewriting.
        ranges.push({ start: token.index! + start, end: token.index! + cursor, value: decodeImageSource(value), needsEquals: !hasValue });
        break;
      }
    }
  }
  return ranges;
}
export function htmlImageSources(html: string): string[] {
  return [...new Set(imageSourceRanges(html).map(source => source.value))];
}
/** Source extraction and rewriting use the same attribute contract. */
export function rewriteImageSources(html: string, transform: (source: string) => string): string {
  let result = "", cursor = 0;
  for (const source of imageSourceRanges(html)) {
    const value = transform(source.value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    result += html.slice(cursor, source.start) + (source.needsEquals ? "=" : "") + `"${value}"`; cursor = source.end;
  }
  return result + html.slice(cursor);
}

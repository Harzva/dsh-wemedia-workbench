import type { JsonObject } from "./json.ts";
import { isJsonObject } from "./json.ts";
import type { ArticleDocument, ArticleAsset, ReviewKind, ReviewCoverage } from "./workbench.ts";
import { WorkbenchFault } from "./workbench.ts";
import { safeWebUrl, SHA256_PATTERN } from "./wechatDocument.ts";
import { WORKFLOW_PRIVATE } from "./workflowImport.ts";

export interface CitationSource extends JsonObject { id: string; title: string; url: string; page: string; figure: string }
export interface FactEvidence extends JsonObject { id: string; paragraph: number; claim: string; disposition: "supported" | "not_applicable"; sourceIds: string[]; note: string }
export interface AssetEvidence extends JsonObject { source: string; digest: string; kind: "original" | "formula" | "other"; sourceIds: string[]; formulaSource: string; note: string }
export interface ReviewDetails extends JsonObject {
  body: string; markdownDigest: string; sources: CitationSource[]; facts: FactEvidence[];
  paragraphs: number[]; assets: AssetEvidence[];
}
export interface EvidenceDetail extends JsonObject {
  id: string; revisionDigest: string; current: boolean; format: string; body: string;
  details: ReviewDetails | null; coverage: ReviewCoverage | null;
  image: { dataUrl: string; width: number; height: number } | null; notes: string[];
}
export interface VersionSummary extends JsonObject { id: string; revisionDigest: string; markdownDigest: string; title: string; recordedAt: string; current: boolean; available: boolean }
export interface VersionHistory extends JsonObject { contentRef: string; versions: VersionSummary[]; notes: string[] }
export interface VersionComparison extends JsonObject {
  from: VersionSummary; to: VersionSummary;
  fields: Array<{ path: string; oldText: string; newText: string }>;
  assets: Array<{ change: "added" | "removed" | "changed"; before: ArticleAsset | null; after: ArticleAsset | null }>;
}

/** Stable numbered text blocks. Bound to exact HTML revision; no DOM/network access. */
export function articleParagraphs(html: string): string[] {
  return html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<\/(?:h[1-6]|p|li|td|th|figcaption|blockquote|div|section|tr)>|<br\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "").split(/\n+/u).map(value => value.replace(/\s+/gu, " ").trim()).filter(Boolean);
}
const invalid = (): never => { throw new WorkbenchFault("REVIEW_DETAILS_INVALID", "报告正文、来源或覆盖关联无效，请核对对应版本与材料"); };
const text = (value: unknown, max = 2000, empty = false): string => {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || WORKFLOW_PRIVATE.test(value)) return invalid();
  return value;
};
const object = (value: unknown, keys: string[]): JsonObject => {
  if (!isJsonObject(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value;
};
const rows = (value: unknown, max = 256): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid();
const unique = <T>(values: T[]): T[] => new Set(values).size === values.length ? values : invalid();
const id = (value: unknown): string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/u.test(value) ? value : invalid();

/** Optional v1 extension. Old reports retain their findings, never invented coverage. */
export function decodeReviewDetails(value: unknown): ReviewDetails {
  const raw = object(value, ["body", "markdownDigest", "sources", "facts", "paragraphs", "assets"]);
  if (typeof raw.markdownDigest !== "string" || !SHA256_PATTERN.test(raw.markdownDigest)) return invalid();
  const sources = rows(raw.sources).map(value => {
    const source = object(value, ["id", "title", "url", "page", "figure"]);
    const url = text(source.url, 2048); if (!safeWebUrl(url)) return invalid();
    return { id: id(source.id), title: text(source.title, 300), url, page: text(source.page, 100, true), figure: text(source.figure, 100, true) };
  });
  const sourceIds = new Set(unique(sources.map(source => source.id)));
  const references = (value: unknown): string[] => unique(rows(value).map(value => { const key = id(value); return sourceIds.has(key) ? key : invalid(); }));
  const paragraph = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 4096 ? Number(value) : invalid();
  const facts = rows(raw.facts).map(value => {
    const fact = object(value, ["id", "paragraph", "claim", "disposition", "sourceIds", "note"]);
    if (fact.disposition !== "supported" && fact.disposition !== "not_applicable") return invalid();
    const refs = references(fact.sourceIds);
    if (fact.disposition === "supported" && !refs.length || fact.disposition === "not_applicable" && refs.length) return invalid();
    return { id: id(fact.id), paragraph: paragraph(fact.paragraph), claim: text(fact.claim, 4000), disposition: fact.disposition as FactEvidence["disposition"], sourceIds: refs, note: text(fact.note) };
  });
  unique(facts.map(fact => fact.id));
  const assets = rows(raw.assets, 64).map(value => {
    const asset = object(value, ["source", "digest", "kind", "sourceIds", "formulaSource", "note"]);
    if (typeof asset.digest !== "string" || !SHA256_PATTERN.test(asset.digest) || typeof asset.kind !== "string" || !["original", "formula", "other"].includes(asset.kind)) return invalid();
    const refs = references(asset.sourceIds), formulaSource = text(asset.formulaSource, 8000, true);
    if (asset.kind === "original" && (!refs.length || !refs.some(ref => { const source = sources.find(source => source.id === ref)!; return Boolean(source.page && source.figure); }))) return invalid();
    if (asset.kind === "formula" && (!formulaSource.trim() || !refs.length)) return invalid();
    return { source: text(asset.source, 1024), digest: asset.digest, kind: asset.kind as AssetEvidence["kind"], sourceIds: refs, formulaSource, note: text(asset.note) };
  });
  unique(assets.map(asset => asset.source));
  return { body: text(raw.body, 64_000), markdownDigest: raw.markdownDigest, sources, facts, paragraphs: unique(rows(raw.paragraphs, 4096).map(paragraph)), assets };
}

export function reviewCoverage(details: ReviewDetails, document: ArticleDocument, kind: ReviewKind): ReviewCoverage {
  const paragraphTotal = articleParagraphs(document.html).length;
  if (details.paragraphs.some(index => index > paragraphTotal) || details.facts.some(fact => fact.paragraph > paragraphTotal)) return invalid();
  for (const item of details.assets) if (!document.assets.some(asset => asset.source === item.source && asset.digest === item.digest)) return invalid();
  const paragraphs = [...new Set(kind === "facts" ? details.facts.map(fact => fact.paragraph) : details.paragraphs)].sort((a, b) => a - b);
  const assets = details.assets.map(asset => asset.source);
  const complete = kind === "images_formulas" ? assets.length === document.assets.length && document.issues.length === 0 : paragraphs.length === paragraphTotal && paragraphTotal > 0;
  return { paragraphs, paragraphTotal, assets, assetTotal: document.assets.length, complete };
}

/** Match unchanged image bytes across version-local renames before reporting changes. */
export function assetDifferences(before: ArticleAsset[], after: ArticleAsset[]): VersionComparison["assets"] {
  const old = [...before], next = [...after];
  for (let i = old.length - 1; i >= 0; i--) {
    const match = next.findIndex(asset => asset.digest === old[i]!.digest && asset.mediaType === old[i]!.mediaType);
    if (match >= 0) { old.splice(i, 1); next.splice(match, 1); }
  }
  const changes: VersionComparison["assets"] = [];
  for (const asset of old) {
    const match = next.findIndex(candidate => candidate.source === asset.source);
    changes.push({ change: match >= 0 ? "changed" : "removed", before: asset, after: match >= 0 ? next.splice(match, 1)[0]! : null });
  }
  return [...changes, ...next.map(asset => ({ change: "added" as const, before: null, after: asset }))];
}

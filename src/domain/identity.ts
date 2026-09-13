import type { SourceRecord } from "./content.ts";
import type { JsonObject } from "./json.ts";
import type { ContentRef } from "./primitives.ts";

export type IdentityDecision =
  | "auto_merged"
  | "suggested"
  | "conflicted"
  | "manually_bound"
  | "manually_separated";

export type ManualDecisionStatus = "active" | "needs_revalidation";

export interface ManualIdentityDecision extends JsonObject {
  decisionId: string;
  kind: "bind" | "separate";
  sourceRecordIds: string[];
  inputDigest: string;
  decidedAt: string;
  revision: number;
  status: ManualDecisionStatus;
  contentRef?: ContentRef;
}

export interface IdentityPairDecision extends JsonObject {
  leftRecordId: string;
  rightRecordId: string;
  decision: IdentityDecision;
  evidenceCodes: string[];
  contentRef?: ContentRef;
  manualDecisionId?: string;
}

export interface IdentityResolution extends JsonObject {
  identitySetDigest: string;
  pairs: IdentityPairDecision[];
  manualDecisions: ManualIdentityDecision[];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function normalizeIdentityValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function sourceIdentityKey(record: SourceRecord): string {
  return [
    record.recordId,
    record.rootId,
    record.relativePath,
    record.digest,
    record.explicitContentId ?? "",
    normalizeIdentityValue(record.topicKey ?? ""),
    [...record.sourceIds].map(normalizeIdentityValue).sort().join(","),
    normalizeText(record.title),
    record.canonicalArtifactKey ?? "",
    record.remote?.remoteId ?? "",
    record.remote?.url ?? "",
    record.derivedFromPath ?? "",
  ].join("\u001f");
}

export function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export function identitySetDigest(records: readonly SourceRecord[]): string {
  return fnv1a64(records.map(sourceIdentityKey).sort().join("\u001e"));
}

export function isStrongSourceId(value: string): boolean {
  const normalized = normalizeIdentityValue(value);
  return /^(arxiv|doi|pmid|isbn|source|origin):[^\s]+$/.test(normalized);
}

export function revalidateManualDecision(
  decision: ManualIdentityDecision,
  records: readonly SourceRecord[],
): ManualIdentityDecision {
  const selected = records.filter(({ recordId }) => decision.sourceRecordIds.includes(recordId));
  const status: ManualDecisionStatus =
    selected.length === decision.sourceRecordIds.length && identitySetDigest(selected) === decision.inputDigest
      ? "active"
      : "needs_revalidation";
  return { ...decision, status };
}

function exactShared(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right.map(normalizeIdentityValue));
  return [...new Set(left.map(normalizeIdentityValue).filter((value) => rightSet.has(value)))].sort();
}

function evaluatePair(
  left: SourceRecord,
  right: SourceRecord,
  manualDecisions: readonly ManualIdentityDecision[],
): IdentityPairDecision {
  const base = { leftRecordId: left.recordId, rightRecordId: right.recordId };
  const manual = manualDecisions.find(
    ({ status, sourceRecordIds }) =>
      status === "active" && sourceRecordIds.includes(left.recordId) && sourceRecordIds.includes(right.recordId),
  );
  if (manual !== undefined) {
    return {
      ...base,
      decision: manual.kind === "bind" ? "manually_bound" : "manually_separated",
      evidenceCodes: [manual.kind === "bind" ? "manual_binding" : "manual_separation"],
      manualDecisionId: manual.decisionId,
      ...(manual.contentRef === undefined ? {} : { contentRef: manual.contentRef }),
    };
  }

  const leftExplicit = left.explicitContentId?.toLowerCase();
  const rightExplicit = right.explicitContentId?.toLowerCase();
  if (leftExplicit !== undefined && leftExplicit === rightExplicit) {
    const incompatibleDrafts =
      left.canonicalArtifactKey !== undefined &&
      right.canonicalArtifactKey !== undefined &&
      left.canonicalArtifactKey !== right.canonicalArtifactKey;
    return {
      ...base,
      decision: incompatibleDrafts ? "conflicted" : "auto_merged",
      evidenceCodes: [incompatibleDrafts ? "duplicate_explicit_id" : "explicit_content_id"],
    };
  }
  if (leftExplicit !== undefined && rightExplicit !== undefined && leftExplicit !== rightExplicit) {
    const topicMatches =
      normalizeIdentityValue(left.topicKey ?? "") !== "" &&
      normalizeIdentityValue(left.topicKey ?? "") === normalizeIdentityValue(right.topicKey ?? "");
    if (topicMatches) {
      return { ...base, decision: "conflicted", evidenceCodes: ["topic_key_explicit_id_conflict"] };
    }
  }

  const leftTopic = normalizeIdentityValue(left.topicKey ?? "");
  const rightTopic = normalizeIdentityValue(right.topicKey ?? "");
  if (leftTopic !== "" && leftTopic === rightTopic) {
    return { ...base, decision: "auto_merged", evidenceCodes: ["topic_key"] };
  }

  const sharedStrongIds = exactShared(left.sourceIds, right.sourceIds).filter(isStrongSourceId);
  const titlesMatch = normalizeText(left.title) !== "" && normalizeText(left.title) === normalizeText(right.title);
  if (sharedStrongIds.length >= 2 || (sharedStrongIds.length === 1 && titlesMatch)) {
    return { ...base, decision: "auto_merged", evidenceCodes: ["strong_source_ids"] };
  }
  if (sharedStrongIds.length > 0) {
    return { ...base, decision: "conflicted", evidenceCodes: ["strong_source_id_title_conflict"] };
  }

  if (titlesMatch) {
    const remoteMatches =
      (left.remote?.remoteId !== undefined && left.remote.remoteId === right.remote?.remoteId) ||
      (left.remote?.url !== undefined && left.remote.url === right.remote?.url);
    const derivedPathMatches =
      left.derivedFromPath !== undefined && left.derivedFromPath === right.derivedFromPath;
    return {
      ...base,
      decision: "suggested",
      evidenceCodes: [remoteMatches ? "title_remote_candidate" : derivedPathMatches ? "title_derived_path_candidate" : "title_only_candidate"],
    };
  }

  return { ...base, decision: "suggested", evidenceCodes: ["insufficient_identity_evidence"] };
}

export function resolveIdentity(
  records: readonly SourceRecord[],
  manualDecisions: readonly ManualIdentityDecision[] = [],
): IdentityResolution {
  const sorted = [...records].sort(({ recordId: left }, { recordId: right }) => left.localeCompare(right));
  const validatedManual = manualDecisions
    .map((decision) => revalidateManualDecision(decision, sorted))
    .sort((left, right) => right.revision - left.revision || right.decidedAt.localeCompare(left.decidedAt) || left.decisionId.localeCompare(right.decisionId));
  const pairs: IdentityPairDecision[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const left = sorted[leftIndex];
      const right = sorted[rightIndex];
      if (left !== undefined && right !== undefined) pairs.push(evaluatePair(left, right, validatedManual));
    }
  }
  return { identitySetDigest: identitySetDigest(sorted), pairs, manualDecisions: validatedManual };
}

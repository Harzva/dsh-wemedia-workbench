import { createHash } from "node:crypto";
import { CONTENT_MAPPING_SCHEMA, mappingArtifact } from "../domain/contentMapping.ts";
import type { ContentMappingState, StoredCanonicalMapping, StoredContentMapping, StoredVariantMapping } from "../domain/contentMapping.ts";
import type { ArtifactRef, SourceRecord } from "../domain/content.ts";
import { isJsonObject } from "../domain/json.ts";
import { revalidateManualDecision, resolveIdentity } from "../domain/identity.ts";
import { CHANNELS, parseContentRef } from "../domain/primitives.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { OverlayV1 } from "../domain/schema.ts";
import { isLibraryTimestamp } from "../domain/contentLibrary.ts";
import { SHA256_PATTERN } from "../domain/wechatDocument.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { ContentMappings, MappingMutation, MappingSnapshot, MappingSource } from "../ports/contentMapping.ts";
import type { WorkbenchCatalog } from "../ports/workbench.ts";
import { mappingSnapshotSignature } from "../ports/contentMapping.ts";
import type { RootCapability } from "./pathPolicy.ts";
import { WorkbenchStore } from "./workbenchStore.ts";

function fail(code: string, message: string): never { throw new WorkbenchFault(code, message); }
const hash = (input: string | Uint8Array): string => `sha256:${createHash("sha256").update(input).digest("hex")}`;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && SHA256_PATTERN.test(value);
function decodeCanonical(value: unknown): StoredCanonicalMapping | null {
  if (value === null) return null;
  if (!isJsonObject(value) || Object.keys(value).some(key => !["sourceRecordId", "sourceDigest", "selectedAt"].includes(key)) || !id(value.sourceRecordId) || !digest(value.sourceDigest) || !isLibraryTimestamp(value.selectedAt)) return fail("MAPPING_STATE_INVALID", "主稿映射记录无法安全读取，已停止映射写入");
  return { sourceRecordId: value.sourceRecordId, sourceDigest: value.sourceDigest, selectedAt: value.selectedAt };
}
function decodeVariant(value: unknown): StoredVariantMapping {
  if (!isJsonObject(value) || Object.keys(value).some(key => !["sourceRecordId", "derivedFromRecordId", "sourceDigest", "generatedDigest", "mappedAt", "provenance"].includes(key)) || !id(value.sourceRecordId) || !id(value.derivedFromRecordId) || !digest(value.sourceDigest) || !digest(value.generatedDigest) || !isLibraryTimestamp(value.mappedAt) || value.provenance !== "explicit_mapping") return fail("MAPPING_STATE_INVALID", "变体映射记录无法安全读取，已停止映射写入");
  return { sourceRecordId: value.sourceRecordId, derivedFromRecordId: value.derivedFromRecordId, sourceDigest: value.sourceDigest, generatedDigest: value.generatedDigest, mappedAt: value.mappedAt, provenance: "explicit_mapping" };
}
export function decodeContentMappingState(value: unknown): ContentMappingState {
  if (value === undefined) return { schemaVersion: CONTENT_MAPPING_SCHEMA, entries: {} };
  if (!isJsonObject(value) || value.schemaVersion !== CONTENT_MAPPING_SCHEMA || !isJsonObject(value.entries) || Object.keys(value).some(key => !["schemaVersion", "entries"].includes(key)) || Object.keys(value.entries).length > 10_000) return fail("MAPPING_STATE_INVALID", "内容映射记录格式无效，已停止映射写入");
  const entries: Record<string, StoredContentMapping> = {};
  for (const [reference, entry] of Object.entries(value.entries)) {
    if (!parseContentRef(reference).ok || !isJsonObject(entry) || entry.contentRef !== reference || !isJsonObject(entry.variants) || Object.keys(entry).some(key => !["contentRef", "canonical", "variants"].includes(key)) || Object.keys(entry.variants).some(key => !CHANNELS.includes(key as typeof CHANNELS[number]))) return fail("MAPPING_STATE_INVALID", "内容映射身份或渠道无效，已停止映射写入");
    entries[reference] = { contentRef: reference as ContentRef, canonical: decodeCanonical(entry.canonical), variants: Object.fromEntries(Object.entries(entry.variants).map(([channel, variant]) => [channel, decodeVariant(variant)])) };
  }
  return { schemaVersion: CONTENT_MAPPING_SCHEMA, entries };
}

/** Maps only discovered files; the supplied artifact reader retains all existing root/link/size checks. */
export class FileContentMappings implements ContentMappings {
  constructor(private readonly options: { catalog: WorkbenchCatalog; store: WorkbenchStore; roots: readonly RootCapability[]; readBytes(artifact: ArtifactRef, maximum: number): Promise<Uint8Array> }) {}
  private async snapshot(state: OverlayV1): Promise<MappingSnapshot> {
    const mappings = decodeContentMappingState(state.extensions.contentMappings);
    const catalog = await this.options.catalog.refresh(state);
    const records = catalog.mappingSources ?? catalog.sources;
    const candidates = records.filter(source => mappingArtifact(source) !== null);
    if (candidates.length > 1000) fail("MAPPING_SCAN_LIMIT", "映射来源超过安全数量限制，请缩小文章根的扫描范围");
    const sources: MappingSource[] = [];
    for (const record of candidates) {
      const artifact = mappingArtifact(record)!;
      const root = this.options.roots.find(root => root.id === record.rootId);
      if (!root) continue;
      try {
        const metadataBytes = await this.options.readBytes({ rootId: record.rootId, relativePath: record.relativePath }, 1024 * 1024);
        // The scanner and safe byte reader must observe the exact same source revision.
        if (hash(metadataBytes) !== record.digest) continue;
        const bytes = artifact.relativePath === record.relativePath ? metadataBytes : await this.options.readBytes(artifact, 1024 * 1024);
        const bytesDigest = hash(bytes);
        sources.push({ record, rootLabel: root.label, bytesDigest, digest: hash(JSON.stringify([record.digest, bytesDigest])) });
      } catch { /* Unavailable files stay unmappable; existing mappings become stale/dirty. */ }
    }
    sources.sort((a, b) => a.record.recordId.localeCompare(b.record.recordId));
    // A newly discovered source is an unbound candidate until an explicit write
    // or the ordinary catalog refresh persists its identity. Never expose a
    // freshly generated, uncommitted contentRef that changes on the next read.
    const bindings = { ...state.contentBindings };
    const manualDecisions = state.manualDecisions.map(decision => revalidateManualDecision(decision, sources.map(source => source.record)));
    const decisions = resolveIdentity(sources.map(source => source.record), manualDecisions);
    const documents = isJsonObject(state.extensions.wechatDocuments) ? Object.keys(state.extensions.wechatDocuments) : [];
    const knownContentRefs = [...new Set([...Object.values(bindings), ...documents, ...Object.keys(mappings.entries)].filter(reference => parseContentRef(reference).ok))].sort() as ContentRef[];
    return { revision: state.revision, sources, bindings, manualDecisions, mappings, knownContentRefs,
      conflicts: decisions.pairs.filter(pair => pair.decision === "conflicted").map(({ leftRecordId, rightRecordId, evidenceCodes }) => ({ leftRecordId, rightRecordId, evidenceCodes })) };
  }
  async read(): Promise<MappingSnapshot> { return this.snapshot(await this.options.store.read()); }
  async commit(expected: MappingSnapshot, mutation: MappingMutation, assertCurrent?: () => void): Promise<number> {
    return this.options.store.update(async state => {
      assertCurrent?.();
      if (state.revision !== expected.revision) fail("MAPPING_REVISION_CONFLICT", "工作台状态已变化，请重新预览映射");
      const current = await this.snapshot(state);
      assertCurrent?.();
      if (mappingSnapshotSignature(current) !== mappingSnapshotSignature(expected)) fail("MAPPING_INPUT_CHANGED", "提交前来源或文章文件已变化，未写入映射");
      state.extensions.contentMappings = decodeContentMappingState(mutation.mappings);
      state.contentBindings = structuredClone(mutation.bindings);
      state.manualDecisions = structuredClone(mutation.manualDecisions);
      return state.revision + 1;
    });
  }
}

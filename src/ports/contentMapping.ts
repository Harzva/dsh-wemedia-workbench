import type { SourceRecord } from "../domain/content.ts";
import type { ContentMappingState } from "../domain/contentMapping.ts";
import type { ManualIdentityDecision } from "../domain/identity.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { OverlayV1 } from "../domain/schema.ts";

/** Host-only source identity and safe artifact bytes digest; never returned verbatim. */
export interface MappingSource {
  record: SourceRecord;
  rootLabel: string;
  digest: string;
  bytesDigest: string;
}
export interface MappingSnapshot {
  revision: number;
  sources: MappingSource[];
  bindings: Record<string, ContentRef>;
  manualDecisions: ManualIdentityDecision[];
  mappings: ContentMappingState;
  knownContentRefs: ContentRef[];
  conflicts: Array<{ leftRecordId: string; rightRecordId: string; evidenceCodes: string[] }>;
}
export interface MappingMutation {
  mappings: ContentMappingState;
  bindings: Record<string, ContentRef>;
  manualDecisions: OverlayV1["manualDecisions"];
}
export interface ContentMappings {
  read(): Promise<MappingSnapshot>;
  /** Re-read under the shared store lock, compare expected revision and all source identities, then commit once. */
  commit(expected: MappingSnapshot, mutation: MappingMutation, assertCurrent?: () => void): Promise<number>;
}
export interface MappingCaller {
  kind: "user" | "agent";
  sessionId?: string;
  callId?: string;
}

/** Stable host-only input stamp shared by mapping preview and atomic persistence. */
export const mappingSnapshotSignature = (snapshot: MappingSnapshot): string => JSON.stringify({ revision: snapshot.revision, sources: snapshot.sources.map(source => [source.record, source.digest, source.bytesDigest]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), bindings: Object.entries(snapshot.bindings).sort(), decisions: snapshot.manualDecisions, mappings: snapshot.mappings, known: [...snapshot.knownContentRefs].sort() });

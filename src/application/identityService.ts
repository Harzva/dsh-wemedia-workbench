import type { SourceRecord } from "../domain/content.ts";
import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { identitySetDigest, resolveIdentity } from "../domain/identity.ts";
import { formatContentRef } from "../domain/primitives.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { OverlayV1 } from "../domain/schema.ts";
import type { IdGenerator } from "../ports/clock.ts";

export interface IdentityComponent {
  contentRef: ContentRef;
  sourceRecordIds: string[];
  identitySetDigest: string;
  conflicts: Array<{ leftRecordId: string; rightRecordId: string; evidenceCodes: string[] }>;
}

export interface IdentityProjection {
  components: IdentityComponent[];
  updatedBindings: Record<string, ContentRef>;
  manualDecisions: OverlayV1["manualDecisions"];
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

export class IdentityService {
  constructor(private readonly ids: IdGenerator) {}

  resolve(records: readonly SourceRecord[], overlay: OverlayV1): DomainResult<IdentityProjection> {
    const resolution = resolveIdentity(records, overlay.manualDecisions);
    const parent = new Map(records.map(({ recordId }) => [recordId, recordId]));
    const members = new Map(records.map(({ recordId }) => [recordId, new Set([recordId])]));
    const separated = new Set(
      resolution.pairs
        .filter(({ decision }) => decision === "manually_separated")
        .map(({ leftRecordId, rightRecordId }) => pairKey(leftRecordId, rightRecordId)),
    );
    const find = (value: string): string => {
      const current = parent.get(value) ?? value;
      if (current === value) return value;
      const root = find(current);
      parent.set(value, root);
      return root;
    };
    const canJoin = (leftRoot: string, rightRoot: string): boolean => {
      const leftMembers = members.get(leftRoot) ?? new Set([leftRoot]);
      const rightMembers = members.get(rightRoot) ?? new Set([rightRoot]);
      for (const left of leftMembers) for (const right of rightMembers) if (separated.has(pairKey(left, right))) return false;
      return true;
    };
    const join = (left: string, right: string): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot || !canJoin(leftRoot, rightRoot)) return;
      const [root, child] = leftRoot.localeCompare(rightRoot) <= 0 ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
      parent.set(child, root);
      const merged = new Set([...(members.get(root) ?? []), ...(members.get(child) ?? [])]);
      members.set(root, merged);
      members.delete(child);
    };
    for (const pair of resolution.pairs) {
      if (pair.decision === "auto_merged" || pair.decision === "manually_bound") join(pair.leftRecordId, pair.rightRecordId);
    }
    // Stable persisted identities survive ordinary source edits. A current
    // explicit separation is the only operation allowed to split that binding.
    const boundRecords = new Map<ContentRef, string>();
    for (const record of records) {
      const binding = overlay.contentBindings[record.recordId];
      if (!binding) continue;
      const first = boundRecords.get(binding);
      if (first) join(first, record.recordId);
      else boundRecords.set(binding, record.recordId);
    }

    const groups = new Map<string, SourceRecord[]>();
    for (const record of records) {
      const root = find(record.recordId);
      const group = groups.get(root) ?? [];
      group.push(record);
      groups.set(root, group);
    }
    const explicitCounts = new Map<string, number>();
    for (const record of records) {
      if (record.explicitContentId !== undefined) explicitCounts.set(record.explicitContentId.toLowerCase(), (explicitCounts.get(record.explicitContentId.toLowerCase()) ?? 0) + 1);
    }
    const updatedBindings = { ...overlay.contentBindings };
    const components: IdentityComponent[] = [];
    const assignedRefs = new Set<ContentRef>();
    for (const group of [...groups.values()].sort((left, right) => left[0]!.recordId.localeCompare(right[0]!.recordId))) {
      group.sort((left, right) => left.recordId.localeCompare(right.recordId));
      const recordIds = group.map(({ recordId }) => recordId);
      const manualRef = resolution.manualDecisions.find(
        ({ kind, status, contentRef, sourceRecordIds }) =>
          kind === "bind" && status === "active" && contentRef !== undefined && sourceRecordIds.every((id) => recordIds.includes(id)),
      )?.contentRef;
      const overlayRef = recordIds.map((id) => overlay.contentBindings[id]).find((value) => value !== undefined);
      const uniqueExplicit = group
        .map(({ explicitContentId }) => explicitContentId)
        .find((value) => value !== undefined && explicitCounts.get(value.toLowerCase()) === 1);
      let contentRef = manualRef ?? overlayRef;
      if (contentRef === undefined && uniqueExplicit !== undefined) {
        const formatted = formatContentRef(uniqueExplicit);
        if (formatted.ok) contentRef = formatted.value;
      }
      if (contentRef === undefined || assignedRefs.has(contentRef)) {
        contentRef = undefined;
        for (let attempt = 0; attempt < 10 && contentRef === undefined; attempt += 1) {
          const generated = formatContentRef(this.ids.uuidV4());
          if (!generated.ok) return failure("UUID_V4_INVALID", "ID generator returned an invalid UUIDv4");
          if (!assignedRefs.has(generated.value)) contentRef = generated.value;
        }
        if (contentRef === undefined) return failure("UUID_V4_INVALID", "ID generator could not provide a distinct content reference");
      }
      assignedRefs.add(contentRef);
      for (const recordId of recordIds) updatedBindings[recordId] = contentRef;
      const conflicts = resolution.pairs
        .filter(({ decision, leftRecordId, rightRecordId }) => decision === "conflicted" && (recordIds.includes(leftRecordId) || recordIds.includes(rightRecordId)))
        .map(({ leftRecordId, rightRecordId, evidenceCodes }) => ({ leftRecordId, rightRecordId, evidenceCodes }));
      components.push({
        contentRef,
        sourceRecordIds: recordIds,
        identitySetDigest: identitySetDigest(group),
        conflicts,
      });
    }
    return success({ components, updatedBindings, manualDecisions: resolution.manualDecisions });
  }
}

export function affectedIdentityComponents(
  components: readonly IdentityComponent[],
  changedRecordIds: readonly string[],
): IdentityComponent[] {
  const changed = new Set(changedRecordIds);
  return components.filter(({ sourceRecordIds }) => sourceRecordIds.some((recordId) => changed.has(recordId)));
}

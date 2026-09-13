import { describe, expect, it } from "vitest";
import { IdentityService } from "../../src/application/identityService.ts";
import { identitySetDigest, resolveIdentity } from "../../src/domain/identity.ts";
import type { ManualIdentityDecision } from "../../src/domain/identity.ts";
import type { SourceRecord } from "../../src/domain/content.ts";
import { createEmptyOverlay } from "../../src/infrastructure/overlayRepository.ts";

const ref = "wmc:550e8400-e29b-41d4-a716-446655440000" as const;
const records: SourceRecord[] = ["a", "b"].map(recordId => ({ recordId, rootId: "fixture", relativePath: `${recordId}.md`, digest: `fixture-${recordId}`, title: `文章 ${recordId}`, sourceIds: [], topicKey: "same-topic" }));
const decision = (kind: "bind" | "separate", revision: number, decisionId: string): ManualIdentityDecision => ({ kind, decisionId, revision, sourceRecordIds: ["a", "b"], inputDigest: identitySetDigest(records), decidedAt: "2026-09-08T00:00:00.000Z", status: "active", ...(kind === "bind" ? { contentRef: ref } : {}) });
const service = () => { let id = 0; return new IdentityService({ uuidV4: () => `2678b045-176d-4c6d-a98d-${String(++id).padStart(12, "0")}`, opaqueId: () => "fixture" }); };

describe("persistent identity mapping decisions", () => {
  it("separates an old shared binding into distinct stable identities", () => {
    const original = { ...createEmptyOverlay(), contentBindings: { a: ref, b: ref }, manualDecisions: [decision("separate", 2, "z-new-separation"), decision("bind", 1, "a-old-binding")] };
    const first = service().resolve(records, original);
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.value.components).toHaveLength(2);
    expect(new Set(first.value.components.map(component => component.contentRef)).size).toBe(2);
    expect(first.value.components.filter(component => component.contentRef === ref)).toHaveLength(1);
    const second = service().resolve(records, { ...original, contentBindings: first.value.updatedBindings });
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.value.updatedBindings).toEqual(first.value.updatedBindings);
  });
  it("uses the latest explicit decision independently of random decision ID order", () => {
    expect(resolveIdentity(records, [decision("bind", 1, "a-old"), decision("separate", 2, "z-new")]).pairs[0]?.decision).toBe("manually_separated");
    expect(resolveIdentity(records, [decision("separate", 2, "a-old"), decision("bind", 3, "z-new")]).pairs[0]?.decision).toBe("manually_bound");
  });
  it("keeps persisted identities across ordinary edits while marking the manual decision for revalidation", () => {
    const changed = [records[0]!, { ...records[1]!, digest: "edited", topicKey: "changed-topic" }];
    const result = service().resolve(changed, { ...createEmptyOverlay(), contentBindings: { a: ref, b: ref }, manualDecisions: [decision("bind", 1, "binding")] });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.components).toHaveLength(1);
    expect(result.value.components[0]?.contentRef).toBe(ref);
    expect(result.value.manualDecisions[0]?.status).toBe("needs_revalidation");
  });
  it("fails instead of allocating the same generated identity to unrelated contents", () => {
    const identity = new IdentityService({ uuidV4: () => ref.slice(4), opaqueId: () => "fixture" });
    expect(identity.resolve(records.map(record => ({ ...record, topicKey: record.recordId })), createEmptyOverlay())).toMatchObject({ ok: false, error: { code: "UUID_V4_INVALID" } });
  });
});

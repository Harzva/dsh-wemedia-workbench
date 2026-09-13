import { describe, expect, it } from "vitest";

import type { SourceRecord } from "../../src/domain/content.ts";
import {
  fnv1a64,
  identitySetDigest,
  resolveIdentity,
  type ManualIdentityDecision,
} from "../../src/domain/identity.ts";

function source(recordId: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    recordId,
    rootId: "root",
    relativePath: `${recordId}.md`,
    digest: `digest-${recordId}`,
    title: `Title ${recordId}`,
    sourceIds: [],
    ...overrides,
  };
}

describe("identity resolution", () => {
  it("conflicts duplicate explicit IDs that point at incompatible canonical drafts", () => {
    const records = [
      source("a", { explicitContentId: "550e8400-e29b-41d4-a716-446655440000", canonicalArtifactKey: "root:a.md" }),
      source("b", { explicitContentId: "550e8400-e29b-41d4-a716-446655440000", canonicalArtifactKey: "root:b.md" }),
    ];
    expect(resolveIdentity(records).pairs[0]).toMatchObject({
      decision: "conflicted",
      evidenceCodes: ["duplicate_explicit_id"],
    });
  });

  it("conflicts topic and strong-source evidence that disagrees", () => {
    const topicConflict = resolveIdentity([
      source("a", { explicitContentId: "550e8400-e29b-41d4-a716-446655440000", topicKey: "same-topic" }),
      source("b", { explicitContentId: "2678b045-176d-4c6d-a98d-f5ae2feee5cc", topicKey: "same-topic" }),
    ]).pairs[0];
    const sourceConflict = resolveIdentity([
      source("a", { title: "First", sourceIds: ["doi:10.1000/example"] }),
      source("b", { title: "Second", sourceIds: ["doi:10.1000/example"] }),
    ]).pairs[0];
    expect(topicConflict).toMatchObject({ decision: "conflicted", evidenceCodes: ["topic_key_explicit_id_conflict"] });
    expect(sourceConflict).toMatchObject({ decision: "conflicted", evidenceCodes: ["strong_source_id_title_conflict"] });
  });

  it("auto-merges only strong evidence and treats matching titles as suggestions", () => {
    const sameTopic = resolveIdentity([
      source("a", { topicKey: "topic-1" }),
      source("b", { topicKey: "topic-1" }),
    ]).pairs[0];
    const strongSource = resolveIdentity([
      source("a", { title: "Same title", sourceIds: ["arxiv:2608.00001"] }),
      source("b", { title: "same—title", sourceIds: ["ARXIV:2608.00001"] }),
    ]).pairs[0];
    const titleOnly = resolveIdentity([
      source("a", { title: "Same title", relativePath: "one/post.md" }),
      source("b", { title: "same title", relativePath: "two/post.md" }),
    ]).pairs[0];
    expect(sameTopic?.decision).toBe("auto_merged");
    expect(strongSource?.decision).toBe("auto_merged");
    expect(titleOnly).toMatchObject({ decision: "suggested", evidenceCodes: ["title_only_candidate"] });
  });

  it("produces a stable digest independent of input order", () => {
    const a = source("a", { topicKey: "topic" });
    const b = source("b", { sourceIds: ["doi:10.1000/example"] });
    expect(identitySetDigest([a, b])).toBe(identitySetDigest([b, a]));
    expect(identitySetDigest([a, b])).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(fnv1a64("")).toBe("fnv1a64:cbf29ce484222325");
    expect(fnv1a64("hello")).toBe("fnv1a64:a430d84680aabd0b");
  });

  it("keeps manual separation and marks stale manual binding for revalidation", () => {
    const original = [source("a"), source("b")];
    const binding: ManualIdentityDecision = {
      decisionId: "decision-bind",
      kind: "bind",
      sourceRecordIds: ["a", "b"],
      inputDigest: identitySetDigest(original),
      decidedAt: "2026-08-30T00:00:00.000Z",
      revision: 1,
      status: "active",
      contentRef: "wmc:550e8400-e29b-41d4-a716-446655440000",
    };
    const separation: ManualIdentityDecision = {
      ...binding,
      decisionId: "decision-separate",
      kind: "separate",
    };
    expect(resolveIdentity(original, [binding]).pairs[0]?.decision).toBe("manually_bound");
    expect(resolveIdentity(original, [separation]).pairs[0]?.decision).toBe("manually_separated");

    const changed = [original[0]!, source("b", { digest: "changed" })];
    const resolution = resolveIdentity(changed, [binding]);
    expect(resolution.manualDecisions[0]?.status).toBe("needs_revalidation");
    expect(resolution.pairs[0]?.decision).not.toBe("manually_bound");
  });
});

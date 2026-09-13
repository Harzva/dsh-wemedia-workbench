import { describe, expect, it } from "vitest";

import { QualityService } from "../../src/application/qualityService.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import { normalizeRelativePath } from "../../src/infrastructure/pathPolicy.ts";
import type { QualityGateRunner, QualityInput } from "../../src/ports/quality.ts";
import { createDefaultQualityRegistry, QualityGateRegistry } from "../../src/quality/registry.ts";

const contentRef = "wmc:550e8400-e29b-41d4-a716-446655440000" as ContentRef;

function input(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    contentRef,
    title: "A safe title",
    sourceIds: ["source:one"],
    paths: [{ rootId: "content", relativePath: "article.md" }],
    artifacts: [{ rootId: "content", relativePath: "cover.png", exists: true, kind: "original", line: 5 }],
    existingRecords: [],
    markdown: "# A safe title\n\nSafe text.",
    manifest: { schemaVersion: "fixture/v1" },
    ...overrides,
  };
}

const registry = createDefaultQualityRegistry((path) => normalizeRelativePath(path).ok);

describe("common quality gates", () => {
  it("passes clean content and keeps digest/order stable across unordered collections", async () => {
    const left = await registry.run(input({
      paths: [{ rootId: "b", relativePath: "b.md" }, { rootId: "a", relativePath: "a.md" }],
      artifacts: [
        { rootId: "b", relativePath: "b.png", exists: true },
        { rootId: "a", relativePath: "a.png", exists: true },
      ],
    }));
    const right = await registry.run(input({
      paths: [{ rootId: "a", relativePath: "a.md" }, { rootId: "b", relativePath: "b.md" }],
      artifacts: [
        { rootId: "a", relativePath: "a.png", exists: true },
        { rootId: "b", relativePath: "b.png", exists: true },
      ],
    }));
    expect(left.status).toBe("pass");
    expect(left).toEqual(right);
    expect(left.inputDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
  });

  it("blocks secret markers and unsafe paths without copying the secret into evidence", async () => {
    const marker = "fixture-sensitive-marker";
    const report = await registry.run(input({
      paths: [{ rootId: "content", relativePath: "../escape.md" }],
      markdown: `token=${marker}`,
    }));
    expect(report.status).toBe("block");
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(["PATH_SCHEMA_INVALID", "SECRET_MARKER_DETECTED", "READINESS_BLOCKED"]));
    expect(JSON.stringify(report)).not.toContain(marker);
  });

  it("warns for title-only duplicates and blocks topic or source identity duplicates", async () => {
    const record = { recordId: "record-1", title: "A SAFE TITLE", sourceIds: ["source:other"], status: "active" as const };
    const title = await registry.run(input({ existingRecords: [record] }));
    expect(title.status).toBe("warn");
    expect(title.issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_TITLE_ONLY", status: "warn" }));

    const topic = await registry.run(input({ topicKey: "topic-one", existingRecords: [{ ...record, topicKey: "TOPIC-ONE" }] }));
    expect(topic.issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_STRONG_IDENTITY", status: "block" }));

    const source = await registry.run(input({ existingRecords: [{ ...record, sourceIds: ["source:one"] }] }));
    expect(source.issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_STRONG_IDENTITY", status: "block" }));
  });

  it("blocks missing assets and incomplete subscription image review", async () => {
    const report = await registry.run(input({
      artifacts: [{ rootId: "content", relativePath: "missing.png", exists: false, kind: "generated", line: 100 }],
      subscription: {
        enabled: true,
        totalLines: 100,
        sourceSectionLine: 90,
        originalsAvailable: true,
        originalsDisposition: "unknown",
        generatedOverflowCheck: "fail",
        generatedVisualReview: "unknown",
        tailImageCount: 3,
      },
    }));
    expect(report.status).toBe("block");
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "ASSET_MISSING",
      "SUBSCRIPTION_IMAGE_AFTER_SOURCE",
      "SUBSCRIPTION_IMAGE_END_PILE",
      "SUBSCRIPTION_ORIGINALS_UNRESOLVED",
      "GENERATED_IMAGE_OVERFLOW_UNVERIFIED",
      "GENERATED_IMAGE_VISUAL_UNVERIFIED",
    ]));
  });

  it("isolates a thrown gate and channel failures", async () => {
    const throwing = new QualityGateRegistry([{
      gateId: "throwing",
      version: "1",
      selectInput: () => null,
      evaluate: () => { throw new Error("private implementation detail"); },
    }]);
    const report = await throwing.run(input());
    expect(report.status).toBe("block");
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "QUALITY_GATE_EXCEPTION" }));
    expect(JSON.stringify(report)).not.toContain("private implementation detail");

    const runner: QualityGateRunner = {
      async run(value) {
        if (value.channel === "x") throw new Error("channel failed");
        return registry.run(value);
      },
    };
    const results = await new QualityService(runner).evaluate([input({ channel: "x" }), input({ channel: "wechat" })]);
    expect(results[0]).toMatchObject({ channel: "x", report: { status: "block", issues: [{ code: "QUALITY_SERVICE_EXCEPTION" }] } });
    expect(results[1]).toMatchObject({ channel: "wechat", report: { status: "pass" } });
  });
});

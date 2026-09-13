import type { QualityGate } from "./types.ts";

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export const duplicateGate: QualityGate = {
  gateId: "duplicate",
  version: "1",
  selectInput: (input) => ({ title: input.title, topicKey: input.topicKey ?? null, sourceIds: [...input.sourceIds].sort(), existingRecords: [...input.existingRecords].sort((left, right) => left.recordId.localeCompare(right.recordId)) }),
  evaluate(input) {
    const active = input.existingRecords.filter(({ status }) => status === "active");
    const strong = active.filter((record) =>
      (input.topicKey !== undefined && record.topicKey !== undefined && normalized(input.topicKey) === normalized(record.topicKey))
      || input.sourceIds.some((sourceId) => record.sourceIds.includes(sourceId)),
    );
    if (strong.length > 0) return strong.map((record) => ({
      status: "block" as const,
      code: "DUPLICATE_STRONG_IDENTITY",
      safeMessage: "an active item has the same topic or source identity",
      evidenceRefs: [`record:${record.recordId}`],
    }));
    const titleMatches = active.filter((record) => normalized(record.title) === normalized(input.title));
    if (titleMatches.length > 0) return titleMatches.map((record) => ({
      status: "warn" as const,
      code: "DUPLICATE_TITLE_ONLY",
      safeMessage: "an active item has the same normalized title",
      evidenceRefs: [`record:${record.recordId}`],
    }));
    return [{ status: "pass", code: "DUPLICATE_SCAN_OK", safeMessage: "no active duplicate was detected", evidenceRefs: [] }];
  },
};

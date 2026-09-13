import type { QualityGate } from "./types.ts";

export const assetGate: QualityGate = {
  gateId: "assets",
  version: "1",
  selectInput: (input) => [...input.artifacts].sort((left, right) => `${left.rootId}:${left.relativePath}`.localeCompare(`${right.rootId}:${right.relativePath}`)),
  evaluate(input) {
    const missing = input.artifacts.filter(({ exists }) => !exists);
    return missing.length === 0 ? [{
      status: "pass",
      code: "ASSET_SCAN_OK",
      safeMessage: "all declared assets are available",
      evidenceRefs: [],
    }] : missing.map(({ rootId, relativePath }) => ({
      status: "block" as const,
      code: "ASSET_MISSING",
      safeMessage: "a declared asset is unavailable",
      evidenceRefs: [`path:${rootId}:${relativePath}`],
    }));
  },
};

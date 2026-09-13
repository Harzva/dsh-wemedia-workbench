import { isJsonObject, isJsonValue } from "../domain/json.ts";
import type { QualityGate, RelativePathValidator } from "./types.ts";

export function createPathSchemaGate(validateRelativePath: RelativePathValidator): QualityGate {
  return {
    gateId: "path-schema",
    version: "1",
    selectInput: (input) => ({ paths: [...input.paths].sort((left, right) => `${left.rootId}:${left.relativePath}`.localeCompare(`${right.rootId}:${right.relativePath}`)), manifest: input.manifest ?? null }),
    evaluate(input) {
      const findings = input.paths.flatMap((path) => validateRelativePath(path.relativePath) && path.rootId.trim() !== "" ? [] : [{
        status: "block" as const,
        code: "PATH_SCHEMA_INVALID",
        safeMessage: "a content path is outside the accepted safe-path schema",
        evidenceRefs: [`root:${path.rootId || "unknown"}`],
      }]);
      if (input.manifest !== undefined && (!isJsonValue(input.manifest) || !isJsonObject(input.manifest))) {
        findings.push({
          status: "block",
          code: "MANIFEST_SCHEMA_INVALID",
          safeMessage: "the content manifest is not a JSON object",
          evidenceRefs: ["manifest"],
        });
      }
      return findings.length === 0 ? [{
        status: "pass",
        code: "PATH_SCHEMA_OK",
        safeMessage: "safe paths and manifest shape passed",
        evidenceRefs: [],
      }] : findings;
    },
  };
}

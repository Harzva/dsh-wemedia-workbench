import type { JsonValue } from "../domain/json.ts";
import type { QualityInput } from "../ports/quality.ts";

export type GateStatus = "pass" | "warn" | "block";

export interface GateFinding {
  status: GateStatus;
  code: string;
  safeMessage: string;
  evidenceRefs: string[];
}

export interface QualityGate {
  gateId: string;
  version: string;
  selectInput(input: QualityInput): JsonValue;
  evaluate(input: QualityInput): GateFinding[] | Promise<GateFinding[]>;
}

export type RelativePathValidator = (input: string) => boolean;

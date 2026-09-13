import type { GateReport } from "../domain/capability.ts";
import type { JsonObject, JsonValue } from "../domain/json.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";

export interface QualityPathInput extends JsonObject {
  rootId: string;
  relativePath: string;
}

export interface QualityArtifactInput extends QualityPathInput {
  exists: boolean;
  role?: string;
  line?: number;
  kind?: "original" | "generated" | "other";
}

export interface QualityDuplicateRecord extends JsonObject {
  recordId: string;
  title: string;
  sourceIds: string[];
  status: "active" | "archived" | "deleted";
  topicKey?: string;
}

export interface SubscriptionQualityInput extends JsonObject {
  enabled: boolean;
  totalLines: number;
  originalsAvailable: boolean;
  sourceSectionLine?: number;
  originalsDisposition?: "used" | "discarded_with_reason" | "unknown";
  generatedOverflowCheck?: "pass" | "fail" | "unknown";
  generatedVisualReview?: "pass" | "fail" | "unknown";
  tailImageCount?: number;
}

export interface QualityInput extends JsonObject {
  contentRef: ContentRef;
  title: string;
  sourceIds: string[];
  paths: QualityPathInput[];
  artifacts: QualityArtifactInput[];
  existingRecords: QualityDuplicateRecord[];
  channel?: Channel;
  topicKey?: string;
  markdown?: string;
  manifest?: JsonValue;
  subscription?: SubscriptionQualityInput;
}

export interface QualityGateRunner {
  run(input: QualityInput): Promise<GateReport>;
}

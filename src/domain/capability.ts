import type { JsonObject, JsonValue } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";

export const SIDE_EFFECT_LEVELS = ["read", "local_write", "remote_draft", "remote_publish"] as const;
export type SideEffectLevel = (typeof SIDE_EFFECT_LEVELS)[number];

export const ADAPTER_ACTIONS = ["discover", "preflight", "prepare", "stage", "draft", "publish", "sync"] as const;
export type AdapterAction = (typeof ADAPTER_ACTIONS)[number];

export type CapabilityStatus = "ready" | "unavailable" | "unsupported" | "degraded" | "approval_required";

export interface Capability extends JsonObject {
  action: AdapterAction;
  status: CapabilityStatus;
  reasonCode: string;
  safeMessage: string;
  checkedAt: string;
  expiresAt?: string;
}

export interface CapabilityReport extends JsonObject {
  channel: Channel;
  adapter: string;
  adapterVersion?: string;
  configured: "configured" | "missing" | "invalid" | "unknown";
  actions: Capability[];
}

export interface GateIssue extends JsonObject {
  gateId: string;
  version: string;
  status: "pass" | "warn" | "block";
  code: string;
  safeMessage: string;
  evidenceRefs: string[];
  inputDigest: string;
}

export interface GateReport extends JsonObject {
  status: "pass" | "warn" | "block";
  inputDigest: string;
  issues: GateIssue[];
}

export interface ArtifactOutput extends JsonObject {
  rootId: string;
  relativePath: string;
  digest?: string;
}

export interface RemoteResult extends JsonObject {
  remoteId?: string;
  url?: string;
}

export interface AdapterResult extends JsonObject {
  ok: boolean;
  code: string;
  phase: AdapterAction;
  channel: Channel;
  sideEffect: SideEffectLevel;
  artifacts: ArtifactOutput[];
  issues: GateIssue[];
  retryable: boolean;
  remote?: RemoteResult;
}

export interface ActionIntent extends JsonObject {
  intentId: string;
  generationId: string;
  contentRef: ContentRef;
  channel?: Channel;
  action: string;
  sideEffect: SideEffectLevel;
  targetSummary: string;
  inputDigest: string;
  artifactDigest?: string;
  expectedChanges: JsonValue[];
  blockingGateCodes: string[];
  expiresAt: string;
  approved: boolean;
}

export type RemoteAnswer<T extends JsonValue> =
  | { ok: true; value: T; revision?: number }
  | {
      ok: false;
      error: {
        code: string;
        safeMessage: string;
        retryable: boolean;
        details?: JsonValue;
      };
    };

import type { ActionIntent } from "../domain/capability.ts";
import type { DomainResult } from "../domain/errors.ts";
import type { JsonObject } from "../domain/json.ts";

export interface ApprovalDecision extends JsonObject {
  approved: boolean;
  reference?: string;
  approvedAt?: string;
}

export interface ApprovalBridge {
  request(intent: ActionIntent, signal: AbortSignal): Promise<DomainResult<ApprovalDecision>>;
  verify(intent: ActionIntent, approvalReference: string): Promise<DomainResult<ApprovalDecision>>;
}

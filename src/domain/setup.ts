import type { JsonObject } from "./json.ts";

export const SETUP_SCHEMA = "wemedia.setup/v1" as const;
export interface SetupSelection extends JsonObject { rootIds: string[]; writeRootId: string | null }
export interface SetupCandidate extends JsonObject { id: string; label: string; available: boolean; selected: boolean }
export interface SetupInspection extends JsonObject {
  schemaVersion: typeof SETUP_SCHEMA;
  generationId: string;
  roots: SetupCandidate[];
  writeRoots: SetupCandidate[];
  selection: SetupSelection;
  dataDirAvailable: boolean;
  issues: string[];
  inputDigest: string;
}
export interface SetupPreview extends JsonObject {
  schemaVersion: typeof SETUP_SCHEMA;
  generationId: string;
  intentId: string;
  sideEffect: "local_write";
  inputDigest: string;
  expiresAt: string;
  before: SetupSelection;
  after: SetupSelection;
  changes: string[];
  blockingCodes: string[];
}
export interface SetupApplyResult extends JsonObject { applied: true; selection: SetupSelection; requiresReconnect: true }

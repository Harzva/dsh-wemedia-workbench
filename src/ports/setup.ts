import type { SetupCandidate, SetupSelection } from "../domain/setup.ts";

/** Host-only signature binds the whole configuration and directory identities. */
export interface SetupState {
  roots: SetupCandidate[];
  writeRoots: SetupCandidate[];
  selection: SetupSelection;
  dataDirAvailable: boolean;
  issues: string[];
  signature: string;
}
export interface SetupProposal { state: SetupState; selection: SetupSelection; blockingCodes: string[] }
export interface SetupPort {
  inspect(signal?: AbortSignal): Promise<SetupState>;
  preview(selection: SetupSelection, signal?: AbortSignal): Promise<SetupProposal>;
  /** Revalidate once inside the local commit queue, then call native configuration persistence. */
  apply(selection: SetupSelection, expectedSignature: string, assertCurrent: () => void, signal?: AbortSignal): Promise<void>;
}
export interface SetupCaller { kind: "user" | "agent"; sessionId?: string; callId?: string }

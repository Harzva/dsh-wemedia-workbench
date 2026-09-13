import type { PublicationRecord, PublicationSourceSummary } from "../domain/publication.ts";

/** Host-only exact file identities. These paths never cross RPC or Tools. */
export interface PublicationReader {
  lookup(input: {
    sourcePaths: readonly string[];
    /** Explicit manifest identities, resolved only against the configured workspace; never opened as content. */
    workspaceRelativePaths?: readonly string[];
  }): Promise<{ publications: PublicationRecord[]; issues: string[] }>;
  readSummary(): Promise<PublicationSourceSummary>;
}

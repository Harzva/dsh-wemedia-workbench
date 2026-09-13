import type { CollectionInput, CollectionResult } from "../domain/references.ts";

export type ReferenceCollect = (input: CollectionInput, signal: AbortSignal) => Promise<CollectionResult>;

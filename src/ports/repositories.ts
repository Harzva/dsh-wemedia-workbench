import type { ContentItem, SourceRecord } from "../domain/content.ts";
import type { DomainResult } from "../domain/errors.ts";
import type { Job } from "../domain/job.ts";
import type { LedgerEvent } from "../domain/ledger.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { IndexCacheV1, OverlayV1 } from "../domain/schema.ts";

export interface ContentRepository {
  get(contentRef: ContentRef): Promise<DomainResult<ContentItem | null>>;
  listSources(): Promise<DomainResult<SourceRecord[]>>;
}

export interface OverlayRepository {
  load(): Promise<DomainResult<OverlayV1 | null>>;
  save(value: OverlayV1, expectedRevision: number): Promise<DomainResult<OverlayV1>>;
}

/** Atomic, shared overlay transaction boundary used by application services. */
export interface WorkbenchStateStore {
  read(): Promise<OverlayV1>;
  update<T>(change: (overlay: OverlayV1) => Promise<T> | T): Promise<T>;
}

export interface IndexCacheRepository {
  load(): Promise<DomainResult<IndexCacheV1 | null>>;
  replace(value: IndexCacheV1): Promise<DomainResult<void>>;
  discard(): Promise<DomainResult<void>>;
}

export interface LedgerRepository {
  findByEventKey(eventKey: string): Promise<DomainResult<LedgerEvent | null>>;
  append(event: LedgerEvent): Promise<DomainResult<LedgerEvent>>;
  readAll(): AsyncIterable<DomainResult<LedgerEvent>>;
}

export interface JobRepository {
  get(jobId: string): Promise<DomainResult<Job | null>>;
  save(job: Job): Promise<DomainResult<void>>;
}

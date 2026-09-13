import type { SourceRecord } from "../domain/content.ts";
import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { INDEX_CACHE_SCHEMA_VERSION } from "../domain/schema.ts";
import type { IndexCacheRepository } from "../ports/repositories.ts";

export interface SourceScanBatch {
  sources: SourceRecord[];
  successfulRootIds: string[];
  issues: Array<{ code: string; rootId: string; relativePath: string; safeMessage: string }>;
}

export interface SourceScanner {
  scan(): Promise<SourceScanBatch>;
}

export interface IndexRefreshResult {
  sources: SourceRecord[];
  stale: boolean;
  cacheCommitted: boolean;
  issues: SourceScanBatch["issues"];
}

export class IndexService {
  constructor(
    private readonly scanner: SourceScanner,
    private readonly cache: IndexCacheRepository,
  ) {}

  async refresh(generationId: string, builtAt: string): Promise<DomainResult<IndexRefreshResult>> {
    let scanned: SourceScanBatch;
    try {
      scanned = await this.scanner.scan();
    } catch {
      return this.lastTrusted("index scan failed before producing a result");
    }
    if (scanned.successfulRootIds.length === 0 && scanned.issues.length > 0) {
      return this.lastTrusted("all configured roots failed to scan", scanned.issues);
    }
    const committed = await this.cache.replace({
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      generationId,
      builtAt,
      sources: scanned.sources,
    });
    if (!committed.ok && scanned.sources.length === 0) {
      return this.lastTrusted("empty scan result did not replace the trusted cache", scanned.issues);
    }
    return success({
      sources: scanned.sources,
      stale: false,
      cacheCommitted: committed.ok,
      issues: scanned.issues,
    });
  }

  private async lastTrusted(
    safeMessage: string,
    issues: SourceScanBatch["issues"] = [],
  ): Promise<DomainResult<IndexRefreshResult>> {
    const cached = await this.cache.load();
    if (!cached.ok || cached.value === null) return failure("SCHEMA_INVALID_VALUE", safeMessage);
    return success({ sources: cached.value.sources, stale: true, cacheCommitted: true, issues });
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { INDEX_CACHE_SCHEMA_VERSION, decodeIndexCache } from "../domain/schema.ts";
import type { IndexCacheV1 } from "../domain/schema.ts";
import type { IndexCacheRepository } from "../ports/repositories.ts";

function cacheFailure<T>(safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(path: string, value: IndexCacheV1): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class FileIndexCacheRepository implements IndexCacheRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<DomainResult<IndexCacheV1 | null>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const decoded = decodeIndexCache(JSON.parse(raw) as unknown);
      return decoded.ok ? decoded : success(null);
    } catch (error) {
      return isMissing(error) ? success(null) : success(null);
    }
  }

  replace(value: IndexCacheV1): Promise<DomainResult<void>> {
    const operation = this.queue.then(() => this.replaceLocked(value));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async replaceLocked(value: IndexCacheV1): Promise<DomainResult<void>> {
    const current = await this.load();
    if (!current.ok) return current;
    if (current.value !== null && current.value.sources.length > 0 && value.sources.length === 0) {
      return cacheFailure("empty scan result cannot replace a trusted non-empty cache");
    }
    const next: IndexCacheV1 = { ...value, schemaVersion: INDEX_CACHE_SCHEMA_VERSION };
    try {
      await atomicWrite(this.filePath, next);
      return success(undefined);
    } catch {
      return cacheFailure("index cache could not be replaced atomically");
    }
  }

  async discard(): Promise<DomainResult<void>> {
    try {
      await unlink(this.filePath);
      return success(undefined);
    } catch (error) {
      return isMissing(error) ? success(undefined) : cacheFailure("index cache could not be discarded");
    }
  }
}

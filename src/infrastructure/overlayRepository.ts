import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { OVERLAY_SCHEMA_VERSION, decodeOverlay } from "../domain/schema.ts";
import type { OverlayV1 } from "../domain/schema.ts";
import type { OverlayRepository } from "../ports/repositories.ts";
import { acquireFileCommitLock } from "./fileCommitLock.ts";

function storageFailure<T>(safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJsonWrite(path: string, value: unknown, beforeRename?: () => Promise<void>): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeRename?.();
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function createEmptyOverlay(): OverlayV1 {
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    revision: 0,
    contentBindings: {},
    manualDecisions: [],
    variantState: {},
    jobs: {},
    extensions: {},
  };
}

export class FileOverlayRepository implements OverlayRepository {
  private queue: Promise<void> = Promise.resolve();
  private readOnly = false;

  constructor(
    private readonly filePath: string,
    private readonly options: { beforeRename?: () => Promise<void> } = {},
  ) {}

  get mode(): "read_write" | "read_only" {
    return this.readOnly ? "read_only" : "read_write";
  }

  async load(): Promise<DomainResult<OverlayV1 | null>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const decoded = decodeOverlay(JSON.parse(raw) as unknown);
      if (!decoded.ok) {
        this.readOnly = true;
        return storageFailure("overlay is invalid; repository entered read-only mode");
      }
      return decoded;
    } catch (error) {
      if (isMissing(error)) return success(null);
      this.readOnly = true;
      return storageFailure("overlay could not be read; repository entered read-only mode");
    }
  }

  save(value: OverlayV1, expectedRevision: number): Promise<DomainResult<OverlayV1>> {
    if (this.readOnly) return Promise.resolve(storageFailure("overlay repository is read-only"));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) return Promise.resolve(storageFailure("overlay expected revision is invalid"));
    let next: OverlayV1;
    try {
      const decoded = decodeOverlay({ ...value, schemaVersion: OVERLAY_SCHEMA_VERSION, revision: expectedRevision + 1 });
      if (!decoded.ok) return Promise.resolve(storageFailure("overlay update is invalid; the committed state was preserved"));
      next = structuredClone(decoded.value);
    } catch { return Promise.resolve(storageFailure("overlay update is invalid; the committed state was preserved")); }
    const operation = this.queue.then(() => this.saveLocked(next, expectedRevision));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveLocked(next: OverlayV1, expectedRevision: number): Promise<DomainResult<OverlayV1>> {
    if (this.readOnly) return storageFailure("overlay repository is read-only");
    const lock = await acquireFileCommitLock(this.filePath);
    if (!lock.ok) return lock;
    try {
      const current = await this.load();
      if (!current.ok) return current;
      const actualRevision = current.value?.revision ?? 0;
      if (actualRevision !== expectedRevision) return failure("IDENTITY_CONFLICT", "overlay revision changed; reload before retrying", { details: { expectedRevision, actualRevision } });
      await atomicJsonWrite(this.filePath, next, this.options.beforeRename);
      return success(next);
    } catch {
      return storageFailure("overlay could not be committed atomically");
    } finally { await lock.value.release(); }
  }
}

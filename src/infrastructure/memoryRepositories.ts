import { success } from "../domain/errors.ts";
import type { IndexCacheV1, OverlayV1 } from "../domain/schema.ts";
import type { IndexCacheRepository, OverlayRepository } from "../ports/repositories.ts";

/** Empty unconfigured mode only; the Host disables all persistent actions. */
export class MemoryOverlayRepository implements OverlayRepository {
  private value: OverlayV1 | null = null;
  async load() { return success(structuredClone(this.value)); }
  async save(value: OverlayV1, expectedRevision: number) { this.value = structuredClone({ ...value, revision: expectedRevision + 1 }); return success(structuredClone(this.value)); }
}
export class MemoryIndexRepository implements IndexCacheRepository {
  private value: IndexCacheV1 | null = null;
  async load() { return success(structuredClone(this.value)); }
  async replace(value: IndexCacheV1) { this.value = structuredClone(value); return success(undefined); }
  async discard() { this.value = null; return success(undefined); }
}

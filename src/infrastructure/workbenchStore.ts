import type { OverlayV1 } from "../domain/schema.ts";
import type { OverlayRepository } from "../ports/repositories.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import { createEmptyOverlay } from "./overlayRepository.ts";

/** A single writer shared by identities, document pointers, evidence and jobs. */
export class WorkbenchStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly repository: OverlayRepository) {}
  async read(): Promise<OverlayV1> {
    const result = await this.repository.load();
    if (!result.ok) throw new WorkbenchFault("STORAGE_READ_ONLY", "工作台状态无法读取，已停止写入");
    return result.value ?? createEmptyOverlay();
  }
  update<T>(change: (overlay: OverlayV1) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      const state = await this.read();
      const expectedRevision = state.revision;
      const value = await change(state);
      // A transaction may create files before its CAS. Do not replay that
      // callback on conflict or let it select a newer expected revision.
      const saved = await this.repository.save(state, expectedRevision);
      if (!saved.ok) throw new WorkbenchFault("STORAGE_CONFLICT", "状态保存失败；请刷新后确认，勿重复远端操作");
      return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

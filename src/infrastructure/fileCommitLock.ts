import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";

export interface FileCommitLock { release(): Promise<void> }
const pause = (): Promise<void> => new Promise(resolvePause => setTimeout(resolvePause, 10));

/** Cooperating writers share an exclusive lock, including across repository instances. */
export async function acquireFileCommitLock(filePath: string): Promise<DomainResult<FileCommitLock>> {
  const lockPath = `${filePath}.lock`;
  try { await mkdir(dirname(filePath), { recursive: true, mode: 0o700 }); }
  catch { return failure("SCHEMA_INVALID_VALUE", "storage lock directory is unavailable"); }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    let handle;
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") return failure("SCHEMA_INVALID_VALUE", "storage lock could not be acquired");
      if (attempt < 24) await pause();
      continue;
    }
    const owned = handle;
    const identity = await owned.stat({ bigint: true }).catch(() => null);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        const current = await lstat(lockPath, { bigint: true }).catch(() => null);
        if (identity && current?.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
      } catch { /* An uncertain lock remains for explicit local reconciliation. */ }
      finally { await owned.close().catch(() => undefined); }
    };
    try {
      if (!identity) throw new Error("lock identity unavailable");
      await owned.writeFile(`${JSON.stringify({ schema: "wemedia.commit-lock/v1", owner: randomUUID(), pid: process.pid })}\n`, "utf8");
      await owned.sync();
      return success({ release });
    } catch { await release(); return failure("SCHEMA_INVALID_VALUE", "storage lock could not be initialized"); }
  }
  // An empty, legacy or abandoned lock is not proof that its owner is gone.
  // Never delete another writer's lock based on a timeout or PID guess.
  return failure("IDENTITY_CONFLICT", "storage is busy or has an unresolved lock; inspect the local lock before retrying");
}

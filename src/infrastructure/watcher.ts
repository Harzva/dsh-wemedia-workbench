import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface WatchEvent {
  rootId: string;
  relativePath: string;
  reason: "filesystem" | "fingerprint";
}

export interface WatchTarget {
  rootId: string;
  path: string;
}

export interface WatchOptions {
  debounceMs: number;
  fallbackIntervalMs?: number;
}

export interface WatchHandle {
  dispose(): Promise<void>;
}

// A closed native emitter can still receive a queued error. This static sink
// holds no plugin state, timers or live handles and dies with the closed object.
function ignoreClosedWatcherError(): void {}

async function directoryFingerprint(path: string): Promise<string> {
  const rows: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), relativePath);
      else if (entry.isFile()) {
        const info = await stat(resolve(directory, entry.name), { bigint: true });
        rows.push(`${relativePath}:${info.size}:${info.mtimeNs}`);
      }
    }
  };
  try {
    await visit(path, "");
  } catch {
    return "unavailable";
  }
  return rows.join("\n");
}

export async function createMetadataWatcher(
  targets: readonly WatchTarget[],
  onChange: (event: WatchEvent) => void | Promise<void>,
  options: WatchOptions,
): Promise<WatchHandle> {
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const stopWatchers = new Set<() => void>();
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  const fingerprints = new Map<string, string>();
  const schedule = (event: WatchEvent): void => {
    if (disposed) return;
    const key = `${event.rootId}:${event.relativePath}`;
    const previous = debounce.get(key);
    if (previous !== undefined) clearTimeout(previous);
    debounce.set(key, setTimeout(() => {
      debounce.delete(key);
      // The callback may throw before returning a promise, or reject later. An
      // optional watcher notification must never become a Host-level exception.
      void Promise.resolve().then(() => { if (!disposed) return onChange(event); }).catch(() => {});
    }, options.debounceMs));
  };

  for (const target of targets) {
    fingerprints.set(target.rootId, await directoryFingerprint(target.path));
    try {
      let active = true;
      const changed = (_event: string, filename: string | Buffer | null): void => {
        if (active) schedule({ rootId: target.rootId, relativePath: filename?.toString().replaceAll("\\", "/") ?? "", reason: "filesystem" });
      };
      const watcher = watch(target.path, { recursive: true }, changed);
      const stop = (): void => {
        if (!active) return;
        active = false;
        stopWatchers.delete(stop);
        watcher.on("error", ignoreClosedWatcherError);
        watcher.removeListener("change", changed);
        watcher.removeListener("error", stop);
        watcher.removeListener("close", stop);
        try { watcher.close(); } catch { /* A failed native watcher stays local. */ }
      };
      // FSWatcher can fail asynchronously (e.g. EMFILE) and Node may already
      // close its native handle without emitting "close" on that error path.
      watcher.on("error", stop);
      watcher.on("close", stop);
      stopWatchers.add(stop);
    } catch {
      // The bounded fingerprint fallback below remains active.
    }
  }

  let fingerprinting: Promise<void> | undefined;
  const interval = options.fallbackIntervalMs === undefined ? undefined : setInterval(() => {
    if (disposed || fingerprinting) return;
    fingerprinting = Promise.all(targets.map(async (target) => {
      const next = await directoryFingerprint(target.path);
      if (disposed) return;
      const previous = fingerprints.get(target.rootId);
      fingerprints.set(target.rootId, next);
      if (previous !== undefined && previous !== next) schedule({ rootId: target.rootId, relativePath: "", reason: "fingerprint" });
    })).then(() => {}).catch(() => {
      // A failed fingerprint pass is retried only by the existing next interval.
    }).finally(() => { fingerprinting = undefined; });
  }, options.fallbackIntervalMs);

  return {
    dispose(): Promise<void> {
      disposal ??= (async () => {
        disposed = true;
        if (interval !== undefined) clearInterval(interval);
        for (const timer of debounce.values()) clearTimeout(timer);
        debounce.clear();
        for (const stop of [...stopWatchers]) stop();
        stopWatchers.clear();
        await fingerprinting;
        fingerprints.clear();
      })();
      return disposal;
    },
  };
}

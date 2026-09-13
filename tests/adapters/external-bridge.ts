import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ExternalBridge = { enabled: false } | { enabled: true; path: string; url: string };

/** External bridge tests run only when a caller explicitly supplies the bridge file. */
export function externalBridge(envName: string): ExternalBridge {
  const configured = process.env[envName]?.trim();
  if (!configured) return { enabled: false };
  const path = resolve(configured);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${envName} must point to an existing bridge file`);
  return { enabled: true, path, url: pathToFileURL(path).href };
}

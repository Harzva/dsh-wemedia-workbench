import { lstat, realpath, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, win32 } from "node:path";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";

export const PATH_POLICY_CODES = {
  absolute: "PATH_ABSOLUTE_REJECTED",
  caseAlias: "PATH_CASE_ALIAS_REJECTED",
  dataDirOverlap: "PATH_DATA_DIR_OVERLAP",
  device: "PATH_DEVICE_REJECTED",
  escape: "PATH_ROOT_ESCAPE",
  exists: "PATH_TARGET_EXISTS",
  invalid: "PATH_INVALID",
  unavailable: "PATH_UNAVAILABLE",
  unicodeAlias: "PATH_UNICODE_ALIAS_REJECTED",
  writeDenied: "PATH_WRITE_DENIED",
} as const;

export type PathPolicyCode = (typeof PATH_POLICY_CODES)[keyof typeof PATH_POLICY_CODES];

export interface RootDescriptor {
  id: string;
  label: string;
  path: string;
  mode: "read" | "write";
}

export interface RootCapability {
  id: string;
  label: string;
  realPath: string;
  mode: "read" | "write";
}

export interface SafePathRef {
  rootId: string;
  relativePath: string;
}

export interface ResolvedPath extends SafePathRef {
  absolutePath: string;
  kind: "file" | "directory" | "other";
}

function storageFailure<T>(reasonCode: PathPolicyCode, safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage, { details: { reasonCode } });
}

export function pathPolicyReason(result: DomainResult<unknown>): string | undefined {
  if (result.ok || typeof result.error.details !== "object" || result.error.details === null || Array.isArray(result.error.details)) {
    return undefined;
  }
  const value = result.error.details.reasonCode;
  return typeof value === "string" ? value : undefined;
}

const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[?.]\\|\\[?.]\\)/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function invalidSegment(segment: string): PathPolicyCode | undefined {
  if (segment.includes(":")) return PATH_POLICY_CODES.device;
  if (WINDOWS_RESERVED.test(segment) || /[. ]$/u.test(segment)) return PATH_POLICY_CODES.device;
  return undefined;
}

export function normalizeRelativePath(input: string): DomainResult<string> {
  if (input.includes("\0")) return storageFailure(PATH_POLICY_CODES.invalid, "path contains a forbidden character");
  if (WINDOWS_DEVICE_PREFIX.test(input)) return storageFailure(PATH_POLICY_CODES.device, "device paths are not allowed");
  if (input !== input.normalize("NFC")) {
    return storageFailure(PATH_POLICY_CODES.unicodeAlias, "path must use canonical Unicode form");
  }
  const normalized = input.replaceAll("\\", "/");
  if (normalized === "" || normalized === ".") return success("");
  if (isAbsolute(normalized) || win32.isAbsolute(input)) {
    return storageFailure(PATH_POLICY_CODES.absolute, "absolute paths are not allowed");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    return storageFailure(PATH_POLICY_CODES.escape, "parent path segments are not allowed");
  }
  for (const part of parts) {
    const reason = invalidSegment(part);
    if (reason !== undefined) return storageFailure(reason, "path contains a reserved segment");
  }
  return success(parts.filter((part) => part !== "" && part !== ".").join("/"));
}

export function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child));
}

async function resolveExactSegments(rootPath: string, normalized: string): Promise<DomainResult<string>> {
  let current = rootPath;
  if (normalized === "") return success(current);
  for (const segment of normalized.split("/")) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return storageFailure(PATH_POLICY_CODES.unavailable, "path is unavailable");
    }
    const canonicalMatches = entries.filter((entry) => entry.normalize("NFC") === segment);
    if (canonicalMatches.length > 1) {
      return storageFailure(PATH_POLICY_CODES.unicodeAlias, "path has an ambiguous Unicode alias");
    }
    if (canonicalMatches.length === 0) {
      const caseMatches = entries.filter((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US"));
      if (caseMatches.length > 0) return storageFailure(PATH_POLICY_CODES.caseAlias, "path case does not match the stored entry");
      return storageFailure(PATH_POLICY_CODES.unavailable, "path is unavailable");
    }
    current = resolve(current, canonicalMatches[0]!);
  }
  return success(current);
}

export async function createRootCapability(descriptor: RootDescriptor): Promise<DomainResult<RootCapability>> {
  try {
    const resolved = await realpath(descriptor.path);
    const info = await stat(resolved);
    if (!info.isDirectory()) return storageFailure(PATH_POLICY_CODES.invalid, "configured root is not a directory");
    return success({ id: descriptor.id, label: descriptor.label, realPath: resolved, mode: descriptor.mode });
  } catch {
    return storageFailure(PATH_POLICY_CODES.unavailable, "configured root is unavailable");
  }
}

export async function resolveReadablePath(root: RootCapability, input: string): Promise<DomainResult<ResolvedPath>> {
  const normalized = normalizeRelativePath(input);
  if (!normalized.ok) return normalized;
  const exact = await resolveExactSegments(root.realPath, normalized.value);
  if (!exact.ok) return exact;
  try {
    const resolved = await realpath(exact.value);
    if (!isWithinRoot(root.realPath, resolved)) {
      return storageFailure(PATH_POLICY_CODES.escape, "resolved path escapes the configured root");
    }
    const info = await stat(resolved);
    return success({
      rootId: root.id,
      relativePath: normalized.value,
      absolutePath: resolved,
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
    });
  } catch {
    return storageFailure(PATH_POLICY_CODES.unavailable, "path is unavailable");
  }
}

export async function resolveWritablePath(root: RootCapability, input: string): Promise<DomainResult<ResolvedPath>> {
  if (root.mode !== "write") return storageFailure(PATH_POLICY_CODES.writeDenied, "writes require a configured write root");
  return resolveReadablePath(root, input);
}

export async function resolveCreateTarget(root: RootCapability, input: string): Promise<DomainResult<ResolvedPath>> {
  if (root.mode !== "write") return storageFailure(PATH_POLICY_CODES.writeDenied, "writes require a configured write root");
  const normalized = normalizeRelativePath(input);
  if (!normalized.ok) return normalized;
  if (normalized.value === "") return storageFailure(PATH_POLICY_CODES.invalid, "write target must not be the root");

  const parentInput = dirname(normalized.value) === "." ? "" : dirname(normalized.value).replaceAll("\\", "/");
  const parent = await resolveReadablePath(root, parentInput);
  if (!parent.ok || parent.value.kind !== "directory") {
    return storageFailure(PATH_POLICY_CODES.unavailable, "write target parent is unavailable");
  }

  const targetName = basename(normalized.value);
  const entries = await readdir(parent.value.absolutePath);
  if (entries.some((entry) => entry.normalize("NFC") === targetName)) {
    return storageFailure(PATH_POLICY_CODES.exists, "write target already exists");
  }
  if (entries.some((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US") === targetName.toLocaleLowerCase("en-US"))) {
    return storageFailure(PATH_POLICY_CODES.caseAlias, "write target collides with an existing case alias");
  }

  const absolutePath = resolve(parent.value.absolutePath, targetName);
  if (!isWithinRoot(root.realPath, absolutePath)) {
    return storageFailure(PATH_POLICY_CODES.escape, "write target escapes the configured root");
  }
  try {
    await lstat(absolutePath);
    return storageFailure(PATH_POLICY_CODES.exists, "write target already exists");
  } catch {
    return success({ rootId: root.id, relativePath: normalized.value, absolutePath, kind: "directory" });
  }
}

export async function validateDataDirBoundary(
  dataDir: RootCapability,
  indexedRoots: readonly RootCapability[],
): Promise<DomainResult<true>> {
  for (const root of indexedRoots) {
    if (isWithinRoot(root.realPath, dataDir.realPath) || isWithinRoot(dataDir.realPath, root.realPath)) {
      return storageFailure(PATH_POLICY_CODES.dataDirOverlap, "data directory must not overlap an indexed root");
    }
  }
  return success(true);
}

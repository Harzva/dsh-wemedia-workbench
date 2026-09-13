import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRootCapability,
  normalizeRelativePath,
  PATH_POLICY_CODES,
  pathPolicyReason,
  resolveCreateTarget,
  resolveReadablePath,
  resolveWritablePath,
  validateDataDirBoundary,
} from "../../src/infrastructure/pathPolicy.ts";

const temporaryDirectories: string[] = [];
async function temporary(prefix = "wm-path-"): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PathPolicy boundary enforcement", () => {
  it.each([
    ["bad\0name", PATH_POLICY_CODES.invalid],
    ["/private/file", PATH_POLICY_CODES.absolute],
    ["C:\\private\\file", PATH_POLICY_CODES.absolute],
    ["\\\\?\\C:\\device", PATH_POLICY_CODES.device],
    ["safe/../escape", PATH_POLICY_CODES.escape],
    ["CON/file", PATH_POLICY_CODES.device],
    ["name:stream", PATH_POLICY_CODES.device],
    ["cafe\u0301.md", PATH_POLICY_CODES.unicodeAlias],
  ])("rejects unsafe relative path %s", (input, code) => {
    expect(pathPolicyReason(normalizeRelativePath(input))).toBe(code);
  });

  it("resolves canonical disk names while rejecting case aliases and symlink escapes", async () => {
    const rootPath = await temporary();
    const outside = await temporary("wm-outside-");
    await mkdir(resolve(rootPath, "Articles"));
    await writeFile(resolve(rootPath, "Articles", "safe.md"), "safe");
    await writeFile(resolve(outside, "private.md"), "private");
    await symlink(outside, resolve(rootPath, "link"));
    const root = await createRootCapability({ id: "content", label: "Content", path: rootPath, mode: "read" });
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect((await resolveReadablePath(root.value, "Articles/safe.md")).ok).toBe(true);
    expect(pathPolicyReason(await resolveReadablePath(root.value, "articles/safe.md"))).toBe(PATH_POLICY_CODES.caseAlias);
    expect(pathPolicyReason(await resolveReadablePath(root.value, "link/private.md"))).toBe(PATH_POLICY_CODES.escape);
    expect(await resolveReadablePath(root.value, "missing.md")).toMatchObject({ ok: false, error: { safeMessage: "path is unavailable" } });
  });

  it("requires write capability and rejects create aliases and overlapping data roots", async () => {
    const rootPath = await temporary();
    const dataPath = resolve(rootPath, "data");
    await mkdir(dataPath);
    await mkdir(resolve(rootPath, "Existing"));
    const readRoot = await createRootCapability({ id: "read", label: "Read", path: rootPath, mode: "read" });
    const writeRoot = await createRootCapability({ id: "write", label: "Write", path: rootPath, mode: "write" });
    const dataRoot = await createRootCapability({ id: "data", label: "Data", path: dataPath, mode: "write" });
    expect(readRoot.ok && writeRoot.ok && dataRoot.ok).toBe(true);
    if (!readRoot.ok || !writeRoot.ok || !dataRoot.ok) return;
    expect(pathPolicyReason(await resolveWritablePath(readRoot.value, "Existing"))).toBe(PATH_POLICY_CODES.writeDenied);
    expect(pathPolicyReason(await resolveCreateTarget(writeRoot.value, "existing"))).toBe(PATH_POLICY_CODES.caseAlias);
    expect((await resolveCreateTarget(writeRoot.value, "new-folder")).ok).toBe(true);
    expect(pathPolicyReason(await validateDataDirBoundary(dataRoot.value, [readRoot.value]))).toBe(PATH_POLICY_CODES.dataDirOverlap);
  });

  it("keeps public path references free of machine absolute paths", async () => {
    const rootPath = await temporary();
    await writeFile(resolve(rootPath, "article.md"), "safe");
    const root = await createRootCapability({ id: "content", label: "Content", path: rootPath, mode: "read" });
    if (!root.ok) throw new Error("fixture root unavailable");
    const resolved = await resolveReadablePath(root.value, "article.md");
    if (!resolved.ok) throw new Error("fixture path unavailable");
    const dto = { rootId: resolved.value.rootId, relativePath: resolved.value.relativePath };
    expect(JSON.stringify(dto)).not.toContain(rootPath);
    expect(dto).toEqual({ rootId: "content", relativePath: "article.md" });
  });
});

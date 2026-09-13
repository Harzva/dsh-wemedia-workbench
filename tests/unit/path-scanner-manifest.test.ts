import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyContentProject, planContentProject, readContentManifest, safeSlug } from "../../src/infrastructure/manifest.ts";
import { createRootCapability, resolveReadablePath } from "../../src/infrastructure/pathPolicy.ts";
import { scanRoots } from "../../src/infrastructure/scanner.ts";

const temporaryDirectories: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function treeDigest(directory: string): Promise<string> {
  const rows: string[] = [];
  const visit = async (path: string, prefix: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(resolve(path, entry.name), relativePath);
      else if (entry.isFile()) rows.push(`${relativePath}:${createHash("sha256").update(await readFile(resolve(path, entry.name))).digest("hex")}`);
      else rows.push(`${relativePath}:link`);
    }
  };
  await visit(directory, "");
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

describe("read root policy and metadata scanner", () => {
  it("keeps channel operation packages out of article indexing without reading or rewriting them", async () => {
    const rootPath = await temporary("wm-channel-output-scan-");
    await writeFile(resolve(rootPath, "article.md"), "# Source article\n");
    for (const folder of [".wemedia-channel-fixture", "nested/.wemedia-channel-fixture"]) {
      await mkdir(resolve(rootPath, folder), { recursive: true });
      await writeFile(resolve(rootPath, folder, "content.json"), JSON.stringify({ schemaVersion: "wemedia.channel-pack/v1" }));
      await writeFile(resolve(rootPath, folder, "article.md"), "# Prepared copy, not another article\n");
    }
    const root = await createRootCapability({ id: "write", label: "Write", path: rootPath, mode: "write" });
    if (!root.ok) throw new Error("fixture root");
    const observed: string[] = [], before = await treeDigest(rootPath);
    const result = await scanRoots([{ ...root.value, enabled: true, include: [], exclude: [] }], { maxFileBytes: 1024, observe: event => observed.push(event.relativePath) });
    expect(result.issues).toEqual([]);
    expect(result.sources.map(source => source.relativePath)).toEqual(["article.md"]);
    expect(observed.every(path => !path.includes(".wemedia-channel-"))).toBe(true);
    expect(await treeDigest(rootPath)).toBe(before);
  });
  it("scans enabled roots with include/exclude and never reads binary bodies", async () => {
    const rootPath = await temporary("wm-scan-");
    await writeFile(resolve(rootPath, "article.md"), "---\ntitle: Example\ntopic_key: topic-1\nsource_ids: [\"doi:10.1000/example\"]\n---\n# Body\n");
    await writeFile(resolve(rootPath, "cover.png"), new Uint8Array([1, 2, 3, 4]));
    await writeFile(resolve(rootPath, "ignored.md"), "# Ignored\n");
    const capability = await createRootCapability({ id: "root-a", label: "Root A", path: rootPath, mode: "read" });
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    const observations: Array<{ relativePath: string; operation: string }> = [];
    const before = await treeDigest(rootPath);
    const result = await scanRoots([
      { ...capability.value, enabled: true, include: ["**/*.md", "**/*.png"], exclude: ["ignored.md"] },
      { ...capability.value, id: "disabled", enabled: false, include: [], exclude: [] },
    ], { maxFileBytes: 1024, observe: ({ relativePath, operation }) => observations.push({ relativePath, operation }) });
    expect(result.successfulRootIds).toEqual(["root-a"]);
    expect(result.sources.map(({ relativePath }) => relativePath)).toEqual(["cover.png", "article.md"].sort((left, right) => {
      const id = (path: string) => createHash("sha256").update(`root-a\u0000${path}`).digest("hex").slice(0, 24);
      return id(left).localeCompare(id(right));
    }));
    const article = result.sources.find(({ relativePath }) => relativePath === "article.md");
    expect(article).toMatchObject({ title: "Example", topicKey: "topic-1", sourceIds: ["doi:10.1000/example"], recordKind: "markdown" });
    expect(JSON.stringify(article)).not.toContain("# Body");
    expect(observations).toContainEqual({ relativePath: "cover.png", operation: "metadata_read" });
    expect(observations).not.toContainEqual({ relativePath: "cover.png", operation: "content_read" });
    expect(await treeDigest(rootPath)).toBe(before);
  });

  it("rejects parent traversal and symlinks that escape the root", async () => {
    const rootPath = await temporary("wm-root-");
    const outsidePath = await temporary("wm-outside-");
    await writeFile(resolve(outsidePath, "outside.md"), "# Outside\n");
    await symlink(resolve(outsidePath, "outside.md"), resolve(rootPath, "link.md"));
    const capability = await createRootCapability({ id: "root", label: "Root", path: rootPath, mode: "read" });
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    expect(await resolveReadablePath(capability.value, "../outside.md")).toMatchObject({ ok: false });
    expect(await resolveReadablePath(capability.value, "link.md")).toMatchObject({ ok: false });
    const scanned = await scanRoots([{ ...capability.value, enabled: true, include: ["**/*.md"], exclude: [] }], { maxFileBytes: 1024 });
    expect(scanned.sources).toEqual([]);
    expect(scanned.issues).toContainEqual(expect.objectContaining({ relativePath: "link.md", code: "path_rejected" }));
  });
});

describe("content manifest planning and exclusive creation", () => {
  it("creates only the previewed project and refuses the same target twice", async () => {
    const rootPath = await temporary("wm-write-");
    const capability = await createRootCapability({ id: "write", label: "Write", path: rootPath, mode: "write" });
    const plan = planContentProject({
      rootId: "write",
      date: "2026-08-31",
      title: "示例：跨平台 / 内容",
      contentId: "550e8400-e29b-41d4-a716-446655440000",
      sourceIds: ["doi:10.1000/example"],
    });
    expect(capability.ok).toBe(true);
    expect(plan.ok).toBe(true);
    if (!capability.ok || !plan.ok) return;
    expect(plan.value.projectPath).toBe("2026-08-31_示例-跨平台-内容");
    expect(await applyContentProject(capability.value, plan.value)).toEqual({
      ok: true,
      value: { rootId: "write", relativePath: plan.value.projectPath },
    });
    expect(await applyContentProject(capability.value, plan.value)).toMatchObject({ ok: false });
    const manifest = await readContentManifest(capability.value, `${plan.value.projectPath}/content.json`);
    expect(manifest).toMatchObject({ ok: true, value: { title: "示例：跨平台 / 内容", extensions: {} } });
  });

  it("preserves future manifest fields and rejects unusable slugs", async () => {
    const rootPath = await temporary("wm-manifest-");
    await writeFile(resolve(rootPath, "content.json"), JSON.stringify({
      schemaVersion: "wemedia.content/v1",
      contentId: "550e8400-e29b-41d4-a716-446655440000",
      title: "Future",
      sourceIds: [],
      variants: {},
      futureField: { enabled: true },
    }));
    const capability = await createRootCapability({ id: "root", label: "Root", path: rootPath, mode: "read" });
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    const manifest = await readContentManifest(capability.value, "content.json");
    expect(manifest).toMatchObject({ ok: true, value: { extensions: { futureField: { enabled: true } } } });
    expect(safeSlug("<>:\\/*?")).toMatchObject({ ok: false });
  });
});

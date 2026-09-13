import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "./fixture.ts";

async function amendManifest(path: string, update: (manifest: Record<string, unknown> & { metadata: Record<string, unknown> }) => void): Promise<void> {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  update(manifest);
  await writeFile(path, JSON.stringify(manifest));
}

it("projects native nested classification metadata to both article and list without changing content", async () => {
  const f = await fixture();
  try {
    const original = await f.create();
    const manifestPath = resolve(f.writePath, original.document.relativePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.metadata = { ...manifest.metadata, conference: "CVPR", year: 2025, tags: ["视频 Agent", "工具调用"] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const document = await f.documents.read(original.contentRef);
    const expected = { category: "conference", conference: "CVPR", year: 2025, tags: ["视频 Agent", "工具调用"] };
    expect(document.taxonomy).toEqual(expected);
    expect((await f.documents.list())[0]?.taxonomy).toEqual(expected);
    expect(document.html).toBe(original.html);
    expect(document.revisionDigest).toBe(original.revisionDigest);
    expect(JSON.stringify(document.taxonomy)).not.toContain(f.directory);
  } finally { await f.cleanup(); }
});

it.each(["native", "legacy"])("keeps validated public %s labels through independent saves without copying raw source metadata", async mode => {
  const f = await fixture();
  try {
    const first = await f.create();
    await amendManifest(resolve(f.writePath, first.document.relativePath), manifest => {
      if (mode === "native") manifest.metadata.tags = ["工具调用", "Video", "video", "https://private.invalid", "cookie=hidden-value", "/Users/fixture/private", "<unsafe>"];
      else { manifest.agent_topic_key = "tool"; manifest.agent_topic_full = "工具调用"; }
      manifest.remote_note = "original manifest field";
    });
    const tags = mode === "native" ? ["工具调用", "Video"] : ["工具调用"];
    const previous = await f.documents.read(first.contentRef);
    const saved = await f.documents.saveRevision(first.contentRef, previous.revisionDigest, { metadata: { ...previous.metadata, title: "A shorter title" }, html: previous.html, markdown: previous.markdown });
    expect(saved.taxonomy?.tags).toEqual(tags);
    const manifest = JSON.parse(await readFile(resolve(f.writePath, saved.document.relativePath), "utf8"));
    expect(manifest.metadata.tags).toEqual(tags);
    expect(Object.keys(manifest).sort()).toEqual(["contentFile", "markdownFile", "metadata", "schemaVersion"]);
    expect(JSON.stringify(manifest)).not.toMatch(/private.invalid|hidden-value|\/Users\/fixture|unsafe|remote_note/u);
    const next = await f.documents.saveRevision(first.contentRef, saved.revisionDigest, { metadata: saved.metadata, html: saved.html, markdown: saved.markdown });
    expect(next.taxonomy?.tags).toEqual(saved.taxonomy?.tags);
  } finally { await f.cleanup(); }
});

it.each(['["规划推理"]', "[]"])("respects new explicit Markdown labels %s when saving", async tags => {
  const f = await fixture();
  try {
    const first = await f.create();
    await amendManifest(resolve(f.writePath, first.document.relativePath), manifest => { manifest.metadata.tags = ["工具调用"]; });
    const previous = await f.documents.read(first.contentRef);
    const saved = await f.documents.saveRevision(first.contentRef, previous.revisionDigest, { metadata: previous.metadata, html: previous.html, markdown: `---\ntags: ${tags}\n---\n# Article\n` });
    expect(saved.taxonomy?.tags).toEqual(JSON.parse(tags));
    const manifest = JSON.parse(await readFile(resolve(f.writePath, saved.document.relativePath), "utf8"));
    expect(manifest.metadata).not.toHaveProperty("tags");
  } finally { await f.cleanup(); }
});

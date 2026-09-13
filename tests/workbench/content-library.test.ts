import { mkdir, open, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { LocalPublications } from "../../src/infrastructure/localPublications.ts";
import { createRootCapability } from "../../src/infrastructure/pathPolicy.ts";
import { LIBRARY_MEDIA_CHUNK_BYTES, LIBRARY_MEDIA_MAX_BYTES } from "../../src/domain/contentLibrary.ts";
import type { LibraryPage } from "../../src/domain/contentLibrary.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { requestSchema } from "../../src/remote/schemas.ts";
import { composeWorkbench } from "../../src/host/compose.ts";
import { createDefaultConfig } from "../../src/config.ts";
import { testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(overrides: { include?: string[]; exclude?: string[] } = {}) {
  const f = await fixture(); fixtures.push(f);
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: overrides.include ?? [], exclude: overrides.exclude ?? [] })) });
  return { ...f, library };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function legacy(root: string, fields: Record<string, unknown> = {}) {
  await mkdir(resolve(root, "old"), { recursive: true });
  await writeFile(resolve(root, "old", "article.wechat-local-draft.json"), JSON.stringify({ schema: "wemedia.wechat.local_draft.v1", title: "旧文章", author: "作者", preview_html: "preview.html", article: "article.md", remote_media_id: "private-fixture-id", ...fields }));
}

describe("read-only unified content library", () => {
  it("matches legacy workspace-relative receipts outside the content root without reading those bodies or joining titles", async () => {
    const f = await setup();
    const workspace = await realpath(f.directory);
    const contentRoot = resolve(workspace, "wechat/local-drafts");
    const bodyIdentity = "wechat/md2wechat-skill/articles/daily/example.md";
    await mkdir(resolve(contentRoot, "first"), { recursive: true });
    await mkdir(resolve(contentRoot, "same-title"), { recursive: true });
    await mkdir(resolve(workspace, "wechat/md2wechat-skill/articles/daily"), { recursive: true });
    await writeFile(resolve(workspace, bodyIdentity), "OUTSIDE_CONTENT_BODY_MUST_NOT_BE_READ");
    for (const [folder, article] of [["first", `./${bodyIdentity}`], ["same-title", "./wechat/md2wechat-skill/articles/daily/unrelated.md"]]) {
      await writeFile(resolve(contentRoot, folder!, "article.wechat-local-draft.json"), JSON.stringify({ schema: "wemedia.wechat.local_draft.v1", title: "Same title", article, preview_html: `wechat/local-drafts/${folder}/article.local-preview.html` }));
    }
    await writeFile(resolve(workspace, "publishing-ledger.jsonl"), JSON.stringify({ title: "Same title", platforms: { wechat: { status: "draft_created", article_path: bodyIdentity }, zhihu: { status: "blocked_auth", article_path: "zhihu/articles/example.md" }, xiaohongshu: { status: "prepared_local", note_path: "xiaohongshu/example/note.md" } } }));
    const root = await createRootCapability({ id: "legacy-workspace", label: "Legacy content", path: contentRoot, mode: "read" });
    if (!root.ok) throw new Error("fixture root");
    const publications = new LocalPublications({ workspaceRoot: workspace, ledgerPath: "publishing-ledger.jsonl" });
    const library = new FileContentLibrary({ documents: f.documents, publications, roots: [{ ...root.value, enabled: true, include: [], exclude: [] }] });
    const page = await library.list({ kind: "article" });
    expect(page.items).toHaveLength(2);
    const matched = page.items.find(item => item.publications?.some(record => record.channel === "zhihu"));
    expect(matched?.publications).toMatchObject([{ channel: "wechat", status: "draft" }, { channel: "zhihu", status: "failed" }, { channel: "xiaohongshu", status: "ready" }]);
    expect(page.items.filter(item => item.publications?.some(record => record.channel === "zhihu"))).toHaveLength(1);
    const detail = await library.read(matched!.itemId);
    expect(detail.markdown).toBeNull();
    expect(detail.html).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("OUTSIDE_CONTENT_BODY");
    expect(JSON.stringify(page)).not.toContain(bodyIdentity);
  });

  it("merges real workbench articles, legacy manifests and verified local media without exposing paths", async () => {
    const f = await setup(); const article = await f.create();
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const page = await f.library.list({});
    expect(page.total).toBe(3);
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "workbench", contentRef: article.contentRef, legacyReadOnly: false }),
      expect.objectContaining({ title: "旧文章", origin: "legacy", contentRef: null, readOnly: true, legacyReadOnly: true }),
      expect.objectContaining({ kind: "image", mediaType: "image/png", bytes: testPng().length, readOnly: true }),
    ]));
    expect(JSON.stringify(page)).not.toContain(f.directory);
    expect(JSON.stringify(page)).not.toContain("private-fixture-id");
    const detail = await f.library.read(page.items.find(item => item.contentRef === article.contentRef)!.itemId);
    expect(detail.html).toContain("Content-Security-Policy");
    expect(detail.item.contentRef).toBe(article.contentRef);
    expect(f.remoteCalls()).toBe(0);
  });

  it("reads legacy project-relative paths only when their final target remains in the same root", async () => {
    const f = await setup();
    await legacy(f.sourcePath, { preview_html: "source/old/preview.html", article: resolve(f.roots[0]!.realPath, "old", "article.md") });
    await writeFile(resolve(f.sourcePath, "old", "preview.html"), '<h1>本地正文</h1><p>段落</p><img src="image.png"><img src="https://example.invalid/track">');
    await writeFile(resolve(f.sourcePath, "old", "article.md"), "# 原始 Markdown");
    await writeFile(resolve(f.sourcePath, "old", "image.png"), testPng());
    const page = await f.library.list({ kind: "article" });
    const detail = await f.library.read(page.items[0]!.itemId);
    expect(detail.html).toContain("<h1>本地正文</h1>");
    expect(detail.html).toContain("data:image/png;base64,");
    expect(detail.html).not.toContain("example.invalid");
    expect(detail.markdown).toBe("# 原始 Markdown");
    expect(detail.item.legacyReadOnly).toBe(true);
  });

  it("projects passive legacy HTML and excludes active markup, URLs, CSS and local paths", async () => {
    const f = await setup();
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "old", "preview.html"), `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid"><style>body{background:url(https://example.invalid)}</style></head><body><script>privateScript()</script><svg onload="attack()"><script>nested()</script></svg><iframe src="file:///etc/passwd"></iframe><p onclick="attack()" style="position:fixed">真实正文</p><a href="javascript:attack()">链接文字</a><img src="file:///Users/test/private.png"><form action="https://example.invalid"><input name="secret"></form><p>/Users/test/private.md</p></body></html>`);
    const item = (await f.library.list({ kind: "article" })).items[0]!;
    const detail = await f.library.read(item.itemId);
    expect(detail.html).toContain("真实正文");
    expect(detail.html).toContain("链接文字");
    for (const forbidden of ["<script", "<svg", "<iframe", "onclick", "attack", "privateScript", "nested", "example.invalid", "/Users/test", "<form", "<input", "javascript:"]) expect(detail.html).not.toContain(forbidden);
    expect(detail.html).toContain("default-src 'none'");
  });

  it.each([
    ["unclosed angles", "<".repeat(100_000)],
    ["invalid whitespace-only tags", "<" + " ".repeat(100_000) + ">"],
    ["unclosed body tags", "<body ".repeat(20_000)],
    ["unclosed script regions", "<script>".repeat(15_000)],
    ["unclosed quoted attributes", '<img title="' + "<img title='".repeat(10_000)],
  ])("bounds malformed HTML processing: %s", async (_name, html) => {
    const f = await setup(); await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "old", "preview.html"), html);
    const item = (await f.library.list({ kind: "article" })).items[0]!;
    const start = performance.now();
    const detail = await f.library.read(item.itemId);
    // The previous quadratic tokenizer took several seconds at these sizes and
    // blocked the Host event loop. This generous bound includes all real file I/O.
    expect(performance.now() - start).toBeLessThan(1200);
    expect(detail.html).toContain("default-src 'none'");
    expect(detail.html).not.toContain("<script>");
  });

  it("keeps valid quoted image attributes while dropping active and hidden regions", async () => {
    const f = await setup(); await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "old", "image.png"), testPng());
    await writeFile(resolve(f.sourcePath, "old", "preview.html"), `<!doctype html><head><script>const hidden = "<body>PRIVATE_SCRIPT_TEXT</body>";</script></head><body><p title="1 > 0 and < 2" onclick="active()">Visible &amp; safe</p><img title='src="https://outside.invalid/decoy.png" > <' src="image.png"><img title="src='image.png'" src='https://outside.invalid/tracker.png'><template><img src="image.png">HIDDEN_TEMPLATE_TEXT</template><style>body{background:url(https://outside.invalid)}</style></body>`);
    const item = (await f.library.list({ kind: "article" })).items[0]!;
    const detail = await f.library.read(item.itemId);
    expect(detail.html).toContain("<p>Visible &amp; safe</p>");
    expect(detail.html?.match(/data:image\/png;base64,/gu)).toHaveLength(1);
    for (const value of ["outside.invalid", "PRIVATE_SCRIPT_TEXT", "HIDDEN_TEMPLATE_TEXT", "onclick", "<script", "<template", "<img title"]) expect(detail.html).not.toContain(value);
  });

  it.each(["absolute", "parent", "other-root", "symlink", "credential"] as const)("never reads legacy %s escapes", async mode => {
    const f = await setup();
    await writeFile(resolve(f.writePath, "outside.html"), "PRIVATE_OUTSIDE_FIXTURE");
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "old", "credential.html"), "PRIVATE_CREDENTIAL_FIXTURE");
    await symlink(resolve(f.writePath, "outside.html"), resolve(f.sourcePath, "old", "linked.html"));
    const paths = { absolute: "/etc/passwd", parent: "../../write/outside.html", "other-root": resolve(f.writePath, "outside.html"), symlink: "linked.html", credential: "credential.html" };
    await legacy(f.sourcePath, { preview_html: paths[mode], article: paths[mode] });
    const item = (await f.library.list({ kind: "article" })).items[0]!;
    const detail = await f.library.read(item.itemId);
    expect(detail.html).toBeNull();
    expect(detail.markdown).toBeNull();
    expect(detail.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
  });

  it("rejects file and directory links, private filenames, excluded folders and extension disguises", async () => {
    const f = await setup({ exclude: ["**/excluded/**"] });
    await mkdir(resolve(f.sourcePath, "excluded"));
    await mkdir(resolve(f.sourcePath, ".private"));
    for (const path of ["visible.png", "credential.png", "api-key.png", "excluded/hidden.png", ".private/hidden.png"]) await writeFile(resolve(f.sourcePath, path), testPng());
    await writeFile(resolve(f.sourcePath, "pretend.png"), '<svg xmlns="http://www.w3.org/2000/svg" onload="attack()"/>');
    await writeFile(resolve(f.sourcePath, "pretend.mp4"), "<!doctype html><html>active</html>");
    await symlink(resolve(f.sourcePath, "visible.png"), resolve(f.sourcePath, "linked.png"));
    await symlink(f.writePath, resolve(f.sourcePath, "linked-directory"));
    expect((await f.library.list({})).items.map(item => item.title)).toEqual(["visible.png"]);
  });

  it("honors configured include patterns on media and legacy discovery", async () => {
    const f = await setup({ include: ["**/*.png"] });
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "visible.png"), testPng());
    await writeFile(resolve(f.sourcePath, "hidden.gif"), Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex"));
    expect((await f.library.list({})).items.map(item => item.title)).toEqual(["visible.png"]);
  });

  it("serves bounded media chunks and rejects changed files between chunks", async () => {
    const f = await setup();
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const item = (await f.library.list({})).items[0]!;
    const first = await f.library.media({ itemId: item.itemId, revisionDigest: item.revisionDigest, offset: 0, length: 32 });
    expect(first).toMatchObject({ offset: 0, totalBytes: testPng().length, mediaType: "image/png", eof: false });
    expect(Buffer.from(first.dataBase64, "base64")).toEqual(testPng().subarray(0, 32));
    const last = await f.library.media({ itemId: item.itemId, revisionDigest: item.revisionDigest, offset: 32, length: LIBRARY_MEDIA_CHUNK_BYTES });
    expect(last.eof).toBe(true);
    expect(Buffer.concat([Buffer.from(first.dataBase64, "base64"), Buffer.from(last.dataBase64, "base64")])).toEqual(testPng());
    await writeFile(resolve(f.sourcePath, "picture.png"), Buffer.concat([testPng(), Buffer.from("changed")]));
    await expect(f.library.media({ itemId: item.itemId, revisionDigest: item.revisionDigest, offset: 32, length: 32 })).rejects.toMatchObject({ code: "LIBRARY_CHANGED" });
  });

  it("revalidates links and identity when an indexed media file is replaced", async () => {
    const f = await setup();
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const item = (await f.library.list({})).items[0]!;
    await rename(resolve(f.sourcePath, "picture.png"), resolve(f.sourcePath, "original.png"));
    await symlink(resolve(f.sourcePath, "original.png"), resolve(f.sourcePath, "picture.png"));
    await expect(f.library.media({ itemId: item.itemId, revisionDigest: item.revisionDigest, offset: 0, length: 32 })).rejects.toMatchObject({ code: "LIBRARY_PATH_REJECTED" });
  });

  it("excludes oversized media without reading its body and rejects oversized legacy text", async () => {
    const f = await setup();
    const handle = await open(resolve(f.sourcePath, "large.png"), "w");
    await handle.write(testPng()); await handle.truncate(LIBRARY_MEDIA_MAX_BYTES + 1); await handle.close();
    expect((await f.library.list({})).items).toHaveLength(0);
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "old", "preview.html"), "x".repeat(1024 * 1024 + 1));
    const item = (await f.library.list({})).items[0]!;
    await expect(f.library.read(item.itemId)).rejects.toMatchObject({ code: "LIBRARY_FILE_TOO_LARGE" });
  });

  it("refreshes discovery, binds cursors to content and filters by kind and title", async () => {
    const f = await setup();
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const page = await f.library.list({ pageSize: 1 });
    expect(page.nextCursor).not.toBeNull();
    expect((await f.library.list({ pageSize: 1, cursor: page.nextCursor! })).items).toHaveLength(1);
    expect((await f.library.list({ query: "picture", kind: "image" })).total).toBe(1);
    await writeFile(resolve(f.sourcePath, "new.png"), testPng());
    await expect(f.library.list({ pageSize: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    expect((await f.library.list({})).total).toBe(3);
  });

  it("recognizes local GIF, JPEG, WebP, MP4, MOV and WebM signatures without trusting an extension", async () => {
    const f = await setup();
    const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24); mp4.write("ftypisom", 4);
    const mov = Buffer.from(mp4); mov.write("qt  ", 8);
    const webp = Buffer.alloc(22); webp.write("RIFF"); webp.writeUInt32LE(14, 4); webp.write("WEBPVP8 ", 8);
    const values = {
      "image.gif": Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex"),
      "image.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image.webp": webp,
      "video.mp4": mp4, "video.mov": mov, "video.webm": Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")]),
    };
    for (const [name, bytes] of Object.entries(values)) await writeFile(resolve(f.sourcePath, name), bytes);
    const page = await f.library.list({});
    expect(page.total).toBe(6);
    expect(page.items.filter(item => item.kind === "video")).toHaveLength(3);
    expect(page.items.filter(item => item.kind === "image")).toHaveLength(3);
  });
});

describe("shared library request boundary", () => {
  it.each([
    { operation: "library_list", kind: "audio" }, { operation: "library_list", query: 1 }, { operation: "library_list", pageSize: 101 },
    { operation: "library_list", rootPath: "/etc" }, { operation: "library_read", itemId: "/etc/passwd" },
    ...[{ offset: -1 }, { offset: 1.5 }, { length: 0 }, { length: LIBRARY_MEDIA_CHUNK_BYTES + 1 }, { revisionDigest: "stale" }, { path: "/etc/passwd" }].map(change => ({ operation: "library_media", itemId: `library:${"a".repeat(64)}`, offset: 0, length: 32, revisionDigest: `sha256:${"b".repeat(64)}`, ...change })),
  ])("rejects malformed or forged library request %# at both service and RPC decoders", request => {
    expect(() => decodeWorkbenchRequest(request)).toThrow();
    expect(requestSchema.safeParse(request).success).toBe(false);
  });

  it("uses the composed shared service with strict inputs and no source writes or remote operations", async () => {
    const f = await setup();
    await legacy(f.sourcePath);
    await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
    const manifestBefore = await readFile(resolve(f.sourcePath, "old", "article.wechat-local-draft.json"));
    const service = await composeWorkbench({ ...createDefaultConfig(), dataDir: resolve(f.directory, "library-state"), roots: [{ id: "source", label: "Existing content", path: f.sourcePath, mode: "read", enabled: true, include: [], exclude: [] }] }, { available: () => false, forCaller: () => undefined });
    try {
      const list = await service.request({ operation: "library_list" }, { kind: "user" });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const item = (list.value as LibraryPage).items.find(item => item.kind === "image")!;
      expect(await service.request({ operation: "library_read", itemId: item.itemId }, { kind: "user" })).toMatchObject({ ok: true, value: { item: { kind: "image" } } });
      expect(await service.request({ operation: "library_media", itemId: item.itemId, revisionDigest: item.revisionDigest, offset: 0, length: 32 }, { kind: "user" })).toMatchObject({ ok: true, value: { mediaType: "image/png", offset: 0 } });
      expect(await service.request({ operation: "library_read", itemId: item.itemId, path: "/etc/passwd" }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
      expect(await readFile(resolve(f.sourcePath, "old", "article.wechat-local-draft.json"))).toEqual(manifestBefore);
      expect(f.remoteCalls()).toBe(0);
    } finally { await service.dispose(); }
  });
});

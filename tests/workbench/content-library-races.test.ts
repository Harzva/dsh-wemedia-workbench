import { constants } from "node:fs";
import { mkdir, open, rename, symlink, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContentLibrary } from "../../src/infrastructure/contentLibrary.ts";
import { testPng } from "../fixtures/png.ts";
import { fixture } from "./fixture.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture(); fixtures.push(f);
  const library = new FileContentLibrary({ documents: f.documents, roots: f.roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })) });
  await writeFile(resolve(f.sourcePath, "picture.png"), testPng());
  const item = (await library.list({})).items[0]!;
  return { ...f, library, item };
}
afterEach(async () => { vi.mocked(open).mockImplementation(actualFs.open); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

describe("library bounded and race-safe reading", () => {
  it("uses no-follow and nonblocking descriptors and rejects a last-moment final symlink", async () => {
    const f = await setup();
    const path = resolve(f.sourcePath, "picture.png");
    await writeFile(resolve(f.writePath, "outside.png"), testPng());
    let flags: string | number | undefined;
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      flags = mode;
      await unlink(path); await symlink(resolve(f.writePath, "outside.png"), path);
      return actualFs.open(file, mode, permissions);
    });
    await expect(f.library.media({ itemId: f.item.itemId, revisionDigest: f.item.revisionDigest, offset: 0, length: 32 })).rejects.toThrow();
    expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it("rejects a root swapped to an outside directory between resolution and open", async () => {
    const f = await setup();
    await writeFile(resolve(f.writePath, "picture.png"), testPng());
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      await rename(f.sourcePath, resolve(f.directory, "source-retained")); await symlink(f.writePath, f.sourcePath);
      return actualFs.open(file, mode, permissions);
    });
    await expect(f.library.media({ itemId: f.item.itemId, revisionDigest: f.item.revisionDigest, offset: 0, length: 32 })).rejects.toMatchObject({ code: "LIBRARY_PATH_REJECTED" });
  });

  it("checks the named file and descriptor after every read and closes changed descriptors", async () => {
    const f = await setup(); let closed = vi.fn(), stated = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      const handle = await actualFs.open(file, mode, permissions), originalRead = handle.read.bind(handle);
      closed = vi.spyOn(handle, "close"); stated = vi.spyOn(handle, "stat");
      let reads = 0;
      vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await originalRead(buffer, offset, length, position);
        if (++reads === 2) {
          const path = resolve(f.sourcePath, "picture.png");
          await rename(path, resolve(f.sourcePath, "retained.png")); await writeFile(path, testPng());
        }
        return result;
      }) as FileHandle["read"]);
      return handle;
    });
    await expect(f.library.media({ itemId: f.item.itemId, revisionDigest: f.item.revisionDigest, offset: 0, length: 32 })).rejects.toMatchObject({ code: "LIBRARY_CHANGED" });
    expect(stated.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stops discovery and media responses when their request is cancelled", async () => {
    const f = await setup();
    const abort = new AbortController(); abort.abort();
    await expect(f.library.list({}, abort.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(f.library.read(f.item.itemId, abort.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    const during = new AbortController();
    vi.mocked(open).mockImplementationOnce(async (file, mode, permissions) => {
      const handle = await actualFs.open(file, mode, permissions); during.abort(); return handle;
    });
    await expect(f.library.media({ itemId: f.item.itemId, revisionDigest: f.item.revisionDigest, offset: 0, length: 32 }, during.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("labels depth-limited results as partial instead of claiming a complete library", async () => {
    const f = await setup();
    const path = resolve(f.sourcePath, ...Array.from({ length: 26 }, (_, i) => `folder-${i}`));
    await mkdir(path, { recursive: true }); await writeFile(resolve(path, "unscanned.png"), testPng());
    const page = await f.library.list({});
    expect(page.truncated).toBe(true);
    expect(page.issues.join(" ")).toContain("部分结果");
    expect(page.items.map(item => item.title)).toEqual(["picture.png"]);
  });
});

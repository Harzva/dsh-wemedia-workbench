import { Context } from "@deepseek-ai/cordis";
import { SettingsProvider, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as plugin from "../../src/index.ts";
import { createDefaultConfig } from "../../src/config.ts";
import type { WorkbenchAnswer, WorkbenchJob, WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import type { SetupApplyResult, SetupInspection, SetupPreview } from "../../src/domain/setup.ts";
import type { PublicationDraft, PublicationDraftPreview } from "../../src/domain/publicationDraft.ts";
import { publicationEdit } from "../../src/domain/publicationDraft.ts";
import type { BatchPreflightResult } from "../../src/domain/batchPreflight.ts";
import type { LibraryPage } from "../../src/domain/contentLibrary.ts";
import type { WemediaRemoteService } from "../../src/remote/service.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const remote = (ctx: Context) => ctx.get("wemedia") as WemediaRemoteService | undefined;
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
class MemorySettings extends SettingsProvider {
  readonly writable = true;
  readonly persisted: Record<string, unknown> = {};
  persistCalls = 0;
  protected async load() { return this.persisted; }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) { this.persistCalls += 1; this.persisted[ns] = section; }
}
async function setup(withSettings = true, coldDisabled = false) {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "wemedia-setup-host-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source"), write = resolve(directory, "write"), data = resolve(directory, "state");
  await Promise.all([source, write, data].map(path => mkdir(path)));
  await writeFile(resolve(source, "untouched.txt"), "read-only fixture");
  const config = { ...createDefaultConfig(), dataDir: data, writeRoot: write, roots: [{ id: "source", label: "Fixture source", path: source, mode: "read" as const, enabled: true, include: [], exclude: [] }] };
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
  if (withSettings) {
    class PreloadedSettings extends MemorySettings {
      protected override async load() {
        if (coldDisabled) this.persisted[settingsNamespace(plugin.name)] = { roots: config.roots.map(root => ({ ...root, enabled: false })), writeRootEnabled: false };
        return super.load();
      }
    }
    await ctx.plugin(PreloadedSettings).await();
  }
  await ctx.plugin(plugin, config).await();
  await vi.waitFor(() => expect(remote(ctx)).toBeDefined(), { timeout: 3000 });
  return { directory, source, write, data, config, ctx, service: remote(ctx)! };
}

it("hydrates the first cold-start runtime from persisted selections without rewriting settings", async () => {
  const f = await setup(true, true);
  const snapshot = value<WorkbenchSnapshot>(await f.service.request({ operation: "snapshot" }, signal()));
  const inspection = value<SetupInspection>(await f.service.request({ operation: "setup_inspect" }, signal()));
  expect(inspection.selection).toEqual({ rootIds: [], writeRootId: null });
  expect(snapshot.settings.hasWriteRoot).toBe(false);
  expect(snapshot.settings.roots.some(root => root.id === "source")).toBe(false);
  expect(snapshot.generationId).toBe(inspection.generationId);
  expect((f.ctx.settings as MemorySettings).persistCalls).toBe(0);
  expect(await f.service.request({ operation: "create_publication", publicationType: "image_text", title: "Cold-start blocked write" }, signal())).toMatchObject({ ok: false, error: { code: "WRITE_ROOT_MISSING" } });
  expect(await readFile(resolve(f.source, "untouched.txt"), "utf8")).toBe("read-only fixture");
  expect(await readdir(f.source)).toEqual(["untouched.txt"]); expect(await readdir(f.write)).toEqual([]);
});

it("hydrates a settings provider attached later and falls back after that provider detaches", async () => {
  const f = await setup(false);
  expect(value<WorkbenchSnapshot>(await f.service.request({ operation: "snapshot" }, signal())).settings.hasWriteRoot).toBe(true);
  class LateSettings extends MemorySettings {
    protected override async load() {
      this.persisted[settingsNamespace(plugin.name)] = { roots: f.config.roots.map(root => ({ ...root, enabled: false })), writeRootEnabled: false };
      return super.load();
    }
  }
  const provider = f.ctx.plugin(LateSettings); await provider.await();
  await vi.waitFor(async () => { const service = remote(f.ctx); expect(service).toBeDefined(); expect(service).not.toBe(f.service); expect(value<WorkbenchSnapshot>(await service!.request({ operation: "snapshot" }, signal())).settings.hasWriteRoot).toBe(false); }, { timeout: 3000 });
  const attached = remote(f.ctx)!;
  expect(value<SetupInspection>(await attached.request({ operation: "setup_inspect" }, signal())).selection.writeRootId).toBeNull();
  expect((f.ctx.settings as MemorySettings).persistCalls).toBe(0);
  await provider.dispose();
  await vi.waitFor(async () => { const service = remote(f.ctx); expect(service).toBeDefined(); expect(service).not.toBe(attached); expect(value<WorkbenchSnapshot>(await service!.request({ operation: "snapshot" }, signal())).settings.hasWriteRoot).toBe(true); }, { timeout: 3000 });
  const fallback = remote(f.ctx)!;
  expect(value<SetupInspection>(await fallback.request({ operation: "setup_inspect" }, signal())).selection).toEqual({ rootIds: ["source"], writeRootId: "write" });
});

it("disables an inherited writeRoot through native settings and reads the new generation", async () => {
  const f = await setup(), before = value<WorkbenchSnapshot>(await f.service.request({ operation: "snapshot" }, signal()));
  const draftPreview = value<PublicationDraftPreview>(await f.service.request({ operation: "create_publication", publicationType: "image_text", title: "Saved fixture" }, signal()));
  const job = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: draftPreview.intent.intentId }, signal()));
  await vi.waitFor(async () => { expect(value<WorkbenchJob>(await f.service.request({ operation: "get_job", jobId: job.jobId }, signal())).status).toBe("succeeded"); });
  const inspect = value<SetupInspection>(await f.service.request({ operation: "setup_inspect" }, signal()));
  expect(inspect.selection).toEqual({ rootIds: ["source"], writeRootId: "write" });
  expect(JSON.stringify(inspect)).not.toContain(f.directory);
  const preview = value<SetupPreview>(await f.service.request({ operation: "setup_preview", rootIds: [], writeRootId: null }, signal()));
  expect(preview.blockingCodes).toEqual([]);
  expect(value<SetupApplyResult>(await f.service.request({ operation: "setup_apply", intentId: preview.intentId }, signal()))).toMatchObject({ applied: true, requiresReconnect: true, selection: { rootIds: [], writeRootId: null } });
  await vi.waitFor(async () => { expect(remote(f.ctx)).toBeDefined(); expect(value<WorkbenchSnapshot>(await remote(f.ctx)!.request({ operation: "snapshot" }, signal())).generationId).not.toBe(before.generationId); }, { timeout: 3000 });
  const current = remote(f.ctx)!, after = value<WorkbenchSnapshot>(await current.request({ operation: "snapshot" }, signal()));
  expect(after.generationId).not.toBe(before.generationId); expect(after.settings.hasWriteRoot).toBe(false);
  expect(after.settings.roots).toContainEqual({ id: "write", label: "文章写入目录", mode: "read", available: true });
  expect(after.settings.issues).not.toContain("WRITE_ROOT_REQUIRED");
  const ns = settingsNamespace(plugin.name);
  expect(f.ctx.settings.get(ns)).toMatchObject({ writeRoot: f.write, writeRootEnabled: false, roots: [expect.objectContaining({ enabled: false })] });
  expect((f.ctx.settings as MemorySettings).persisted[ns]).not.toHaveProperty("writeRoot");
  expect(value<SetupInspection>(await current.request({ operation: "setup_inspect" }, signal()))).toMatchObject({ selection: { rootIds: [], writeRootId: null }, writeRoots: [expect.objectContaining({ selected: false, available: true })] });
  expect(await f.service.request({ operation: "setup_apply", intentId: preview.intentId }, signal())).toMatchObject({ ok: false, error: { code: "GENERATION_DISPOSED" } });
  expect(await current.request({ operation: "setup_apply", intentId: preview.intentId }, signal())).toMatchObject({ ok: false, error: { code: "SETUP_INTENT_EXPIRED" } });
  expect(await current.request({ operation: "create_publication", publicationType: "image_text", title: "No write root" }, signal())).toMatchObject({ ok: false, error: { code: "WRITE_ROOT_MISSING" } });
  const readonlyDraft = value<PublicationDraft>(await current.request({ operation: "publication_read", contentRef: draftPreview.intent.contentRef }, signal()));
  expect(readonlyDraft).toMatchObject({ title: "Saved fixture", readOnlySource: true });
  const page = value<LibraryPage>(await current.request({ operation: "library_list", publicationType: "image_text" }, signal()));
  expect(page.items).toEqual([expect.objectContaining({ publicationRef: readonlyDraft.contentRef, readOnly: true })]);
  expect(await current.request({ operation: "preview_publication_save", contentRef: readonlyDraft.contentRef, expectedRevision: readonlyDraft.revisionDigest, edit: publicationEdit(readonlyDraft) }, signal())).toMatchObject({ ok: false, error: { code: "WRITE_ROOT_MISSING" } });
  expect(value<BatchPreflightResult>(await current.request({ operation: "batch_preflight", contentRefs: [readonlyDraft.contentRef], channels: ["wechat"] }, signal())).results).toEqual([expect.objectContaining({ code: "MEDIA_PUBLISHER_UNAVAILABLE" })]);
  const enable = value<SetupPreview>(await current.request({ operation: "setup_preview", rootIds: ["source"], writeRootId: "write" }, signal()));
  expect(enable.blockingCodes).toEqual([]);
  expect(value<SetupApplyResult>(await current.request({ operation: "setup_apply", intentId: enable.intentId }, signal())).applied).toBe(true);
  await vi.waitFor(async () => { expect(remote(f.ctx)).toBeDefined(); expect(value<WorkbenchSnapshot>(await remote(f.ctx)!.request({ operation: "snapshot" }, signal())).generationId).not.toBe(after.generationId); }, { timeout: 3000 });
  const reenabled = remote(f.ctx)!;
  expect(value<WorkbenchSnapshot>(await reenabled.request({ operation: "snapshot" }, signal())).settings.hasWriteRoot).toBe(true);
  const editable = value<PublicationDraft>(await reenabled.request({ operation: "publication_read", contentRef: readonlyDraft.contentRef }, signal()));
  expect(editable).toMatchObject({ readOnlySource: false, revisionDigest: readonlyDraft.revisionDigest });
  expect(await reenabled.request({ operation: "preview_publication_save", contentRef: editable.contentRef, expectedRevision: editable.revisionDigest, edit: publicationEdit(editable) }, signal())).toMatchObject({ ok: true });
  expect(f.ctx.settings.get(ns)).toMatchObject({ writeRoot: f.write, writeRootEnabled: true });
  expect(await readFile(resolve(f.source, "untouched.txt"), "utf8")).toBe("read-only fixture");
});

it("returns a local failure without altering directories when native settings are absent", async () => {
  const f = await setup(false);
  const preview = value<SetupPreview>(await f.service.request({ operation: "setup_preview", rootIds: [], writeRootId: null }, signal()));
  expect(await f.service.request({ operation: "setup_apply", intentId: preview.intentId }, signal())).toMatchObject({ ok: false, error: { code: "SETUP_APPLY_FAILED" } });
  expect(value<WorkbenchSnapshot>(await f.service.request({ operation: "snapshot" }, signal())).settings.hasWriteRoot).toBe(true);
  expect(await f.service.request({ operation: "setup_apply", intentId: preview.intentId }, signal())).toMatchObject({ ok: false, error: { code: "SETUP_INTENT_EXPIRED" } });
  expect(await readFile(resolve(f.source, "untouched.txt"), "utf8")).toBe("read-only fixture");
});

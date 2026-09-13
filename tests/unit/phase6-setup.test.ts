import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../../src/config.ts";
import type { ConfigV1 } from "../../src/config.ts";
import { SetupService } from "../../src/application/setupService.ts";
import { LocalSetup } from "../../src/infrastructure/localSetup.ts";
import { composeWorkbench } from "../../src/host/compose.ts";
import type { WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import type { SetupSelection } from "../../src/domain/setup.ts";
import type { SetupCaller, SetupPort } from "../../src/ports/setup.ts";

const directories: string[] = [];
const user: SetupCaller = { kind: "user" }, agent: SetupCaller = { kind: "agent", sessionId: "session:one" };
const hash = { digest: (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}` };
async function fixture() {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "wm-p6-setup-"))); directories.push(directory);
  const a = resolve(directory, "source-a"), b = resolve(directory, "source-b"), write = resolve(directory, "write"), data = resolve(directory, "data");
  await Promise.all([a, b, write, data].map(path => mkdir(path))); await writeFile(resolve(a, "existing.txt"), "original source");
  let config: ConfigV1 = { ...createDefaultConfig(), dataDir: data, writeRoot: write, roots: [{ id: "a", label: "内容 A", path: a, mode: "read", enabled: true, include: ["**/*.md"], exclude: [] }, { id: "b", label: "内容 B", path: b, mode: "read", enabled: false, include: [], exclude: ["**/*smoke*"] }] };
  let now = "2026-09-08T01:00:00.000Z", count = 0;
  const getConfig = vi.fn(() => config), applyConfig = vi.fn(async (next: ConfigV1) => { config = next; });
  const local = new LocalSetup({ getConfig, applyConfig, hasher: hash });
  const service = (setup: SetupPort = local, generationId = "generation:setup") => new SetupService({ setup, generationId, clock: { nowIso: () => now, monotonicMs: () => Date.parse(now) }, ids: { uuidV4: () => "unused", opaqueId: prefix => `${prefix}:${++count}` }, hasher: hash });
  return { directory, a, b, write, data, local, service, getConfig, applyConfig, get config() { return config; }, setConfig(next: ConfigV1) { config = next; }, setTime(next: string) { now = next; } };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

describe("Phase 6 selection-only setup", () => {
  it("inspects configured roots including disabled ones, with no directory paths in the public DTO", async () => {
    const f = await fixture(); f.config.roots[0]!.label = `${f.a} token=private-value`;
    const result = await f.service().inspect();
    expect(result.roots).toEqual([{ id: "a", label: "[目录] [敏感信息]", available: true, selected: true }, { id: "b", label: "内容 B", available: true, selected: false }]);
    expect(result.writeRoots).toEqual([{ id: "write", label: "独立写入目录", available: true, selected: true }]);
    expect(result.dataDirAvailable).toBe(true); expect(result.issues).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(f.directory); expect(JSON.stringify(result)).not.toContain("private-value"); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("previews a concrete diff and applies only selection changes through native persistence once", async () => {
    const f = await fixture(), service = f.service(), before = structuredClone(f.config);
    const preview = await service.preview({ rootIds: ["b"], writeRootId: null }, user);
    expect(preview.before).toEqual({ rootIds: ["a"], writeRootId: "write" }); expect(preview.after).toEqual({ rootIds: ["b"], writeRootId: null });
    expect(preview.changes).toEqual(["停用内容根：内容 A", "启用内容根：内容 B", "停用写入根，工作台不再创建或保存新稿"]); expect(preview.blockingCodes).toEqual([]);
    expect(f.applyConfig).not.toHaveBeenCalled(); expect(await service.apply(preview.intentId, user)).toEqual({ applied: true, selection: preview.after, requiresReconnect: true });
    expect(f.config).toEqual({ ...before, writeRootEnabled: false, roots: before.roots.map(root => ({ ...root, enabled: root.id === "b" })) });
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_INTENT_EXPIRED" }); expect(f.applyConfig).toHaveBeenCalledTimes(1);
    expect(await readFile(resolve(f.a, "existing.txt"), "utf8")).toBe("original source"); expect(await readdir(f.write)).toEqual([]);
    expect((await service.inspect()).writeRoots).toEqual([{ id: "write", label: "独立写入目录", available: true, selected: false }]);
  });
  it("allows explicitly disabling every content root and the write root", async () => {
    const f = await fixture(), service = f.service(); const preview = await service.preview({ rootIds: [], writeRootId: null }, user);
    expect(preview.blockingCodes).toEqual([]); await service.apply(preview.intentId, user);
    expect(f.config.roots.every(root => !root.enabled)).toBe(true); expect(f.config.writeRoot).toBe(f.write); expect(f.config.writeRootEnabled).toBe(false);
  });
  it("does not invent source or write candidates in an empty configuration", async () => {
    const f = await fixture(); f.setConfig(createDefaultConfig()); const service = f.service();
    expect(await service.inspect()).toMatchObject({ roots: [], writeRoots: [], dataDirAvailable: false });
    const preview = await service.preview({ rootIds: [], writeRootId: null }, user); expect(preview.blockingCodes).toEqual([]);
    await service.apply(preview.intentId, user); expect(f.config).toEqual({ ...createDefaultConfig(), writeRootEnabled: false });
  });
  it("re-enables the existing candidate without returning or rewriting its path", async () => {
    const f = await fixture(), service = f.service();
    const disable = await service.preview({ rootIds: ["a"], writeRootId: null }, user); await service.apply(disable.intentId, user);
    expect((await service.inspect()).selection.writeRootId).toBeNull(); expect(f.config.writeRoot).toBe(f.write);
    const enable = await service.preview({ rootIds: ["a"], writeRootId: "write" }, user);
    expect(enable.blockingCodes).toEqual([]); expect(JSON.stringify(enable)).not.toContain(f.directory);
    await service.apply(enable.intentId, user);
    expect(f.config.writeRootEnabled).toBe(true); expect(f.config.writeRoot).toBe(f.write);
    expect((await service.inspect()).selection.writeRootId).toBe("write");
  });
  it("still rejects a disabled write candidate overlapping a source when re-enabled", async () => {
    const f = await fixture(); f.config.writeRootEnabled = false; f.config.writeRoot = f.a;
    const service = f.service(); expect((await service.inspect()).writeRoots).toEqual([expect.objectContaining({ available: false, selected: false })]);
    const preview = await service.preview({ rootIds: [], writeRootId: "write" }, user);
    expect(preview.blockingCodes).toContain("WRITE_ROOT_UNAVAILABLE");
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_BLOCKED" });
  });
  it.each(["write", "disabled-source"] as const)("does not create state inside the disabled %s candidate during composition", async candidate => {
    const f = await fixture(); f.config.writeRootEnabled = false;
    const parent = candidate === "write" ? f.write : f.b;
    f.config.dataDir = resolve(parent, "must-not-be-created");
    const before = await readdir(parent);
    const workbench = await composeWorkbench(f.config, { available: () => false, forCaller: () => undefined });
    try {
      const result = await workbench.request({ operation: "snapshot" }, { kind: "user" });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
      expect((result.value as WorkbenchSnapshot).settings).toMatchObject({ hasDataDir: false, hasWriteRoot: false });
      expect(await readdir(parent)).toEqual(before);
    } finally { await workbench.dispose(); }
  });
  it.each([
    { rootIds: ["a", "a"], writeRootId: null }, { rootIds: ["unknown"], writeRootId: null }, { rootIds: ["a"], writeRootId: "a" }, { rootIds: ["/private/source"], writeRootId: null }, { rootIds: ["a"], writeRootId: null, path: "injected" },
  ])("rejects unknown, duplicate or arbitrary-path selections: %j", async input => {
    const f = await fixture(); await expect(f.service().preview(input as SetupSelection, user)).rejects.toMatchObject({ code: input.rootIds[0] === "unknown" ? "SETUP_ROOT_UNKNOWN" : "REQUEST_INVALID" }); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("leaves missing roots and a missing data directory untouched", async () => {
    const f = await fixture(); f.config.roots[1]!.path = resolve(f.directory, "missing-source"); f.config.dataDir = resolve(f.directory, "missing-data");
    const before = await readdir(f.directory), service = f.service(); const preview = await service.preview({ rootIds: ["b"], writeRootId: "write" }, user);
    expect(preview.blockingCodes).toEqual(expect.arrayContaining(["ROOT_UNAVAILABLE", "DATA_DIR_UNAVAILABLE"]));
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_BLOCKED" });
    expect(await readdir(f.directory)).toEqual(before); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it.each(["root", "ancestor"] as const)("rejects a configured %s symlink instead of accepting its target", async type => {
    const f = await fixture(), link = resolve(f.directory, "linked"); await symlink(type === "root" ? f.a : f.directory, link);
    f.config.roots[0]!.path = type === "root" ? link : resolve(link, "source-a");
    const preview = await f.service().preview({ rootIds: ["a"], writeRootId: null }, user);
    expect(preview.blockingCodes).toContain("ROOT_UNAVAILABLE"); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it.each(["write-source", "data-source", "write-data"] as const)("blocks a write boundary overlap: %s", async type => {
    const f = await fixture();
    if (type === "write-source") f.config.writeRoot = f.a;
    if (type === "data-source") f.config.dataDir = f.b;
    if (type === "write-data") f.config.writeRoot = f.data;
    const preview = await f.service().preview({ rootIds: ["a"], writeRootId: "write" }, user);
    expect(preview.blockingCodes.length).toBeGreaterThan(0); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("does not turn the target of a disabled source alias into a write root", async () => {
    const f = await fixture(), link = resolve(f.directory, "linked-source"); await symlink(f.a, link);
    f.config.roots[0]!.path = link; f.config.roots[0]!.enabled = false; f.config.writeRoot = f.a;
    const preview = await f.service().preview({ rootIds: ["b"], writeRootId: "write" }, user);
    expect(preview.blockingCodes).toContain("WRITE_ROOT_UNAVAILABLE"); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("requires native correction for duplicate root identities", async () => {
    const f = await fixture(); f.config.roots[1]!.id = "a";
    const service = f.service(); expect((await service.inspect()).issues).toContain("ROOT_ID_CONFLICT");
    const preview = await service.preview({ rootIds: [], writeRootId: null }, user); expect(preview.blockingCodes).toContain("ROOT_CONFIG_INVALID");
  });
});

describe("Phase 6 setup intent and generation boundaries", () => {
  it.each(["configuration", "read-root", "write-root", "data-dir"] as const)("rejects a changed %s identity after preview", async change => {
    const f = await fixture(), service = f.service(), preview = await service.preview({ rootIds: ["b"], writeRootId: "write" }, agent);
    if (change === "configuration") f.config.scan.debounceMs += 1;
    else { const path = change === "read-root" ? f.b : change === "write-root" ? f.write : f.data; await rename(path, `${path}-old`); await mkdir(path); }
    await expect(service.apply(preview.intentId, agent)).rejects.toMatchObject({ code: "SETUP_CONFIG_CHANGED" }); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("binds the preview caller and expires before native persistence", async () => {
    const f = await fixture(), service = f.service(), preview = await service.preview({ rootIds: ["b"], writeRootId: null }, agent);
    await expect(service.apply(preview.intentId, { kind: "agent", sessionId: "session:two" })).rejects.toMatchObject({ code: "SETUP_CALLER_CHANGED" });
    f.setTime("2026-09-08T01:10:00.000Z"); await expect(service.apply(preview.intentId, agent)).rejects.toMatchObject({ code: "SETUP_INTENT_EXPIRED" }); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("rechecks expiry after asynchronous filesystem validation", async () => {
    const f = await fixture(); const port: SetupPort = { inspect: signal => f.local.inspect(signal), preview: (input, signal) => f.local.preview(input, signal), apply: async (...args) => { f.setTime("2026-09-08T01:11:00.000Z"); await f.local.apply(...args); } };
    const service = f.service(port), preview = await service.preview({ rootIds: ["b"], writeRootId: null }, user);
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_INTENT_EXPIRED" }); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("invalidates old generations and cancellation without invoking persistence", async () => {
    const f = await fixture(), service = f.service(), preview = await service.preview({ rootIds: ["b"], writeRootId: null }, user);
    const controller = new AbortController(); controller.abort(); await expect(service.apply(preview.intentId, user, controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(f.service(f.local, "generation:new").apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_INTENT_EXPIRED" });
    service.dispose(); await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "GENERATION_DISPOSED" }); expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it("consumes an intent once even when native persistence fails", async () => {
    const f = await fixture(); f.applyConfig.mockRejectedValueOnce(Error("private native state")); const service = f.service(), preview = await service.preview({ rootIds: ["b"], writeRootId: null }, user);
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_APPLY_FAILED" });
    await expect(service.apply(preview.intentId, user)).rejects.toMatchObject({ code: "SETUP_INTENT_EXPIRED" }); expect(f.applyConfig).toHaveBeenCalledTimes(1);
    expect(f.config.roots[0]!.enabled).toBe(true);
  });
  it("serializes two setup commits and rejects the stale configuration preview", async () => {
    const f = await fixture(), service = f.service(); const first = await service.preview({ rootIds: ["b"], writeRootId: null }, user), second = await service.preview({ rootIds: [], writeRootId: null }, user);
    const results = await Promise.allSettled([service.apply(first.intentId, user), service.apply(second.intentId, user)]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "SETUP_CONFIG_CHANGED" } }); expect(f.applyConfig).toHaveBeenCalledTimes(1);
  });
  it("freezes returned previews and rejects configuration drift during inspection", async () => {
    const f = await fixture(), service = f.service(), preview = await service.preview({ rootIds: ["b"], writeRootId: null }, user);
    preview.after.rootIds.push("a"); preview.expiresAt = "2099-01-01T00:00:00Z";
    expect(await service.apply(preview.intentId, user)).toMatchObject({ selection: { rootIds: ["b"] } });
    let calls = 0; const local = new LocalSetup({ hasher: hash, applyConfig: f.applyConfig, getConfig: () => { if (++calls === 2) f.config.scan.debounceMs += 1; return f.config; } });
    await expect(local.inspect()).rejects.toMatchObject({ code: "SETUP_CONFIG_CHANGED" });
  });
});

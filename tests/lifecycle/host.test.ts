import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { SettingsProvider, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as plugin from "../../src/index.ts";
import { createDefaultConfig } from "../../src/config.ts";
import type { WorkbenchSnapshot } from "../../src/domain/workbench.ts";
import type { WemediaRemoteService } from "../../src/remote/service.ts";
import { WORKBENCH_TOOL_NAMES } from "../../src/host/tools.ts";

const roots: Context[] = [];
afterEach(async () => { for (const root of roots.splice(0).reverse()) await root.fiber.dispose(); });
const remote = (root: Context) => root.get("wemedia") as WemediaRemoteService | undefined;
const signal = () => new AbortController().signal;
async function setup() { const ctx = new Context(); roots.push(ctx); return ctx; }
async function tools(ctx: Context) { await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: "native" }).await(); }
async function ready(ctx: Context) { await vi.waitFor(() => { expect(remote(ctx)).toBeDefined(); }, { timeout: 3000 }); return remote(ctx)!; }
async function snapshot(service: WemediaRemoteService) {
  const result = await service.request({ operation: "snapshot" }, signal());
  if (!result.ok) throw new Error(result.error.code);
  return result.value as WorkbenchSnapshot;
}
class MemorySettings extends SettingsProvider {
  readonly writable = true;
  private readonly values: Record<string, unknown> = {};
  protected async load() { return this.values; }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) { this.values[ns] = section; }
}

describe("real Cordis Host ownership and cleanup", () => {
  it("keeps unconfigured RPC useful, registers tools when the dependency arrives, and removes both on stop", async () => {
    const ctx = await setup(); const mounted = ctx.plugin(plugin, createDefaultConfig()); await mounted.await();
    const service = await ready(ctx);
    expect(await snapshot(service)).toMatchObject({ settings: { hasWriteRoot: false, hasDataDir: false } });
    await tools(ctx);
    await vi.waitFor(() => { expect(ctx.tools.get("wemedia_snapshot")).toBeDefined(); });
    expect(ctx.tools.schemas().filter(item => item.name.startsWith("wemedia_"))).toHaveLength(52);
    await mounted.dispose();
    expect(remote(ctx)).toBeUndefined();
    expect(ctx.tools.schemas().filter(item => item.name.startsWith("wemedia_"))).toHaveLength(0);
    expect(await service.request({ operation: "snapshot" }, signal())).toMatchObject({ ok: false, error: { code: "GENERATION_DISPOSED" } });
  });
  it("reloads only the workbench generation through the native optional settings seam", async () => {
    const ctx = await setup(); await tools(ctx); await ctx.plugin(MemorySettings).await();
    const mounted = ctx.plugin(plugin, createDefaultConfig()); await mounted.await();
    const before = await ready(ctx); const initial = await snapshot(before);
    const ns = settingsNamespace(plugin.name);
    expect(ctx.settings.describe({ redactSecrets: true }).some(item => item.ns === ns)).toBe(true);
    await ctx.settings.update(ns, { scan: { debounceMs: 1000, maxFileBytes: 1048576 } });
    await vi.waitFor(async () => { expect(remote(ctx)).toBeDefined(); expect((await snapshot(remote(ctx)!)).generationId).not.toBe(initial.generationId); }, { timeout: 3000 });
    expect((await snapshot(remote(ctx)!)).generationId).not.toBe(initial.generationId);
    expect(await before.request({ operation: "snapshot" }, signal())).toMatchObject({ ok: false, error: { code: "GENERATION_DISPOSED" } });
    expect(ctx.tools.schemas().filter(item => item.name.startsWith("wemedia_"))).toHaveLength(52);
    await mounted.dispose();
    expect(ctx.settings.describe({ redactSecrets: true }).some(item => item.ns === ns)).toBe(false);
    expect(remote(ctx)).toBeUndefined();
  });
  it("contains registration collisions without replacing another tool or disabling RPC", async () => {
    const ctx = await setup(); await tools(ctx);
    const occupant: ToolDefinition = { name: "wemedia_preflight", description: "Fixture occupant", parameters: { type: "object", properties: {} }, output: { schema: { type: "null" }, render: () => [] }, execute: async () => null };
    ctx.tools.register(occupant);
    const mounted = ctx.plugin(plugin, createDefaultConfig()); await mounted.await();
    await ready(ctx);
    await vi.waitFor(() => { expect(ctx.tools.schemas().filter(item => item.name.startsWith("wemedia_"))).toHaveLength(1); });
    expect(ctx.tools.get("wemedia_preflight")?.description).toBe("Fixture occupant");
    expect((await snapshot(remote(ctx)!)).schemaVersion).toBe("wemedia.workbench/v1");
    await mounted.dispose();
    expect(ctx.tools.get("wemedia_preflight")?.description).toBe("Fixture occupant");
    for (const name of WORKBENCH_TOOL_NAMES.filter(name => name !== "wemedia_preflight")) expect(ctx.tools.get(name)).toBeUndefined();
  });
});

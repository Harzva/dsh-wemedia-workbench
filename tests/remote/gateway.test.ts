import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import * as TypertLoader from "@deepseek-ai/dsh-typert-loader";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as plugin from "../../src/index.ts";
import { createDefaultConfig } from "../../src/config.ts";
import { TYPERT } from "../../src/remote/contribution.ts";
import type { WemediaRemoteService } from "../../src/remote/service.ts";

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose(); });
const signal = () => new AbortController().signal;
const remote = (ctx: Context) => ctx.get("wemedia") as WemediaRemoteService | undefined;
async function setup() {
  const ctx = new Context().extend({ baseUrl: new URL("../../", import.meta.url).href });
  contexts.push(ctx);
  await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(TypertGatewayService).await();
  return ctx;
}
const invoke = (ctx: Context, request: unknown, abort = signal()) => ctx.typertGateway.invoke({ namespace: "wemedia", method: "request", args: { request }, signal: abort });

describe("strict actual Typert Gateway", () => {
  it("dispatches the same canonical business value and validates exact wire fields", async () => {
    const ctx = await setup(); const unregister = ctx.typert.register(TYPERT);
    await ctx.plugin(plugin, createDefaultConfig()).await();
    await vi.waitFor(() => expect(remote(ctx)).toBeDefined());
    expect(await invoke(ctx, { operation: "snapshot" })).toEqual(await remote(ctx)!.request({ operation: "snapshot" }, signal()));
    expect(await invoke(ctx, { operation: "platform_catalog" })).toEqual(await remote(ctx)!.request({ operation: "platform_catalog" }, signal()));
    await expect(ctx.typertGateway.invoke({ namespace: "wemedia", method: "request", args: { request: { operation: "snapshot" }, approved: true } })).rejects.toMatchObject({ code: "arguments-invalid" });
    for (const request of [{ operation: "platform_catalog", approved: true }, { operation: "snapshot", caller: { kind: "agent" } }, { operation: "start_action", intentId: "fixture", approved: true }, { operation: "channel_start_action", intentId: "fixture", approved: true }, { operation: "channel_preview_action", contentRef: "wmc:11111111-1111-4111-8111-111111111111", channel: "x", action: "publish", targetUrl: "https://x.com/a/status/123" }, { operation: "channel_preflight", contentRef: "wmc:11111111-1111-4111-8111-111111111111", channel: "csdn" }, { operation: "not_a_workbench_operation" }]) {
      await expect(invoke(ctx, request)).rejects.toMatchObject({ code: "input-invalid" });
    }
    expect(await invoke(ctx, { operation: "channel_inspect", contentRef: "wmc:11111111-1111-4111-8111-111111111111" })).toEqual(await remote(ctx)!.request({ operation: "channel_inspect", contentRef: "wmc:11111111-1111-4111-8111-111111111111" }, signal()));
    await expect(ctx.typertGateway.invoke({ namespace: "wemedia", method: "dispose", args: {} })).rejects.toMatchObject({ code: "invocation-unavailable" });
    unregister();
    await expect(invoke(ctx, { operation: "snapshot" })).rejects.toMatchObject({ code: "definition-unavailable" });
    expect(remote(ctx)).toBeDefined(); // No permissive source-marker fallback.
  });

  it("preserves canonical cancellation and blocks expired intent tasks", async () => {
    const ctx = await setup(); ctx.typert.register(TYPERT);
    await ctx.plugin(plugin, createDefaultConfig()).await();
    await vi.waitFor(() => expect(remote(ctx)).toBeDefined());
    const abort = new AbortController(); abort.abort();
    expect(await invoke(ctx, { operation: "snapshot" }, abort.signal)).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } });
    expect(await ctx.typertGateway.invoke({ namespace: "wemedia", method: "intentTask", args: { request: { intentId: "missing" } } })).toMatchObject({ ok: false, prompt: "" });
  });

  it("loads the built package's actual ./typert export, withdraws it on stop, and reloads without stale endpoints", async () => {
    const ctx = await setup();
    await ctx.plugin(Loader, { baseUrl: new URL("../../", import.meta.url).href }).await();
    await ctx.plugin(TypertLoader, { packages: [] }).await();
    const start = async () => {
      const id = await ctx.loader.create({ name: "dsh-wemedia-workbench", config: createDefaultConfig() });
      await ctx.loader.await();
      await vi.waitFor(() => expect(ctx.typert.local.get("wemedia/request")).toBeDefined());
      expect(ctx.typert.local.list().filter(item => item.namespace === "wemedia")).toHaveLength(2);
      expect(ctx.typert.getPackage("dsh-wemedia-workbench", "host")).toBeDefined();
      const answer = await invoke(ctx, { operation: "snapshot" });
      expect(answer).toMatchObject({ ok: true, value: { schemaVersion: "wemedia.workbench/v1", settings: { hasDataDir: false } } });
      return id;
    };
    const first = await start(); const old = remote(ctx)!;
    await ctx.loader.remove(first);
    await vi.waitFor(() => expect(ctx.typert.local.get("wemedia/request")).toBeUndefined());
    expect(remote(ctx)).toBeUndefined();
    await expect(invoke(ctx, { operation: "snapshot" })).rejects.toMatchObject({ code: "definition-unavailable" });
    await start();
    expect(remote(ctx)).not.toBe(old);
    expect(await old.request({ operation: "snapshot" }, signal())).toMatchObject({ ok: false, error: { code: "GENERATION_DISPOSED" } });
  });
});

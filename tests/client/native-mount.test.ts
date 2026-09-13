import { Context, Service } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import * as Client from "../../src/client/index.tsx";
import type { WorkbenchController } from "../../src/client/controller.ts";

describe("native Client Remote namespace ownership", () => {
  it("mounts the actual Gateway consumer and injects its separate namespace before connecting UI", async () => {
    // This ESM companion is shipped by the declared SDK package. Only the
    // connection carrier and renderer seats are fixtures; Remote/Cordis are real.
    const clientGateway = await import(new URL("./lib/types/client/index.js", import.meta.resolve("@deepseek-ai/dsh-api-gateway/package.json")).href);
    const ctx = new Context();
    const renderers = new Map<string, () => ReactNode>();
    const call = vi.fn().mockResolvedValue({ ok: true, value: { ok: false, error: { code: "FIXTURE_UNCONFIGURED", safeMessage: "Fixture not configured", retryable: false } } });
    class Connection extends Service {
      readonly rpc = { call };
      constructor(owner: Context) { super(owner, "connection"); }
    }
    class Slots extends Service {
      constructor(owner: Context) { super(owner, "slots"); }
      inject(_name: string, callback: () => () => void) { return callback(); }
      register(options: { name: string }, renderer: () => ReactNode) {
        renderers.set(options.name, renderer);
        return () => { renderers.delete(options.name); };
      }
    }
    try {
      await ctx.plugin(TypertRegistry).await();
      await ctx.plugin(Connection).await(); await ctx.plugin(Slots).await();
      await ctx.plugin(clientGateway).await();
      const mounted = ctx.plugin(Client); await mounted.await();
      const element = renderers.get("shell.overlay")!() as ReactElement<{ children: ReactElement<{ controller: WorkbenchController }> }>;
      const controller = element.props.children.props.controller;
      await vi.waitFor(() => expect(controller.getSnapshot().connected).toBe(true));
      controller.open();
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith("/api", "wemedia/request", { args: { request: { operation: "refresh" } } }, expect.any(AbortSignal)));
      await vi.waitFor(() => expect(controller.getSnapshot().notice).toMatchObject({ code: "FIXTURE_UNCONFIGURED" }));
      await mounted.dispose();
      await vi.waitFor(() => expect(ctx.get("remote.wemedia")).toBeUndefined());
      expect(renderers.size).toBe(0);
      expect(controller.getSnapshot().open).toBe(false);
    } finally { await ctx.fiber.dispose(); }
  });
});

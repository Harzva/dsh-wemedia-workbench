import type { Context } from "@deepseek-ai/cordis";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

import { Config } from "./config.ts";
import { WorkbenchFault } from "./domain/workbench.ts";
import type { ConfigV1 } from "./config.ts";
import { composeWorkbench } from "./host/compose.ts";
import { NativeWorkbenchApprovals } from "./host/approval.ts";
import { registerWorkbenchTools } from "./host/tools.ts";
import { WemediaRemoteService } from "./remote/service.ts";

export const name = "dsh-wemedia-workbench";
export { Config };
export type { ConfigV1 as ConfigType } from "./config.ts";

async function applyRuntime(ctx: Context, config: ConfigV1): Promise<void> {
  const approvals = new NativeWorkbenchApprovals(ctx);
  const ns = settingsNamespace(name);
  const workbench = await composeWorkbench(config, approvals, {
    getConfig: () => (ctx.get("settings")?.get(ns) as ConfigV1 | undefined) ?? config,
    async applyConfig(next) {
      const settings = ctx.get("settings");
      if (!settings?.writable) throw new WorkbenchFault("SETUP_NATIVE_UNAVAILABLE", "当前原生设置不可写，请通过 DSH 插件配置设置目录");
      const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === ns);
      if (!descriptor) throw new WorkbenchFault("SETUP_NATIVE_UNAVAILABLE", "原生设置尚未注册，请稍后重试");
      // Keep the private path candidate so setup can re-enable it later.
      await settings.update(ns, { roots: next.roots, writeRootEnabled: next.writeRootEnabled !== false }, descriptor.revision);
    },
  });
  ctx.effect(() => async () => { approvals.dispose(); await workbench.dispose(); });

  // Both UI RPC and ordinary/PTC tools use this one host-owned service.
  // Keep optional registrations on independent fibers; no mode/preset writes.
  ctx.plugin({ name: `${name}/remote`, apply(remoteContext) { new WemediaRemoteService(remoteContext, workbench); } });
  ctx.inject(["tools"], toolContext => {
    try { toolContext.effect(() => registerWorkbenchTools(toolContext, workbench, approvals)); }
    catch { toolContext.logger(name).warn("WeMedia tools unavailable: registration collision or unsupported tool contract."); }
  });
}

export function apply(ctx: Context, config: ConfigV1): void {
  let current = config;
  let source = () => config;
  let runtime: ReturnType<Context["plugin"]> | undefined;
  let pending = Promise.resolve();
  let stopped = false;
  ctx.effect(() => () => { stopped = true; });
  // Reuse the host settings consumer and Cordis's generation teardown/reload.
  // Never patch a profile, preset or the process-wide PTC presentation mode.
  installSettingsSection(ctx, settingsNamespace(name), Config, config, {
    setSource(next) { source = next; },
    onChange() {
      // Updating a loading Cordis fiber can leave its in-flight apply on the
      // old config. Serialize changes behind initialization and read the
      // newest source only after that generation has settled.
      pending = pending.then(async () => {
        const mounted = runtime;
        if (!mounted || stopped) return;
        await mounted.await().catch(() => {});
        if (stopped) return;
        const next = source();
        if (deepEqualJson(current, next)) return;
        await mounted.update(next, true);
      }).catch(() => {
        if (!stopped) ctx.logger(name).warn("WeMedia settings reload failed; inspect the plugin configuration before retrying.");
      });
    },
  });
  // Install the settings consumer first: its initial source callback precedes
  // the child runtime's apply. A missing provider leaves the composition source.
  runtime = ctx.plugin({ name: `${name}/runtime`, Config, apply(runtimeContext) {
    const next = source();
    current = next;
    return applyRuntime(runtimeContext, next);
  } }, config);
}

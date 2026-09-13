import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import React from "react";
import { TYPERT_REMOTE } from "../remote/descriptors.ts";
import { resolveCurrentSession, WorkbenchController } from "./controller.ts";
import { installWorkbenchSlots, mountWorkbenchRemote } from "./lifecycle.ts";
import { SettingsCard, WorkbenchBoundary } from "./views.tsx";
import { ContentNavigation } from "./content-navigation.tsx";

export const name = "dsh-wemedia-workbench";
export const inject = ["slots", "remote"] as const;

export function apply(ctx: ClientContext): void {
  const controller = new WorkbenchController(() => resolveCurrentSession(ctx.get("sessions")));
  ctx.effect(() => () => controller.dispose());
  // A mounted namespace is its own Cordis service, not a property covered by
  // inject: ["remote"]. Wait additively after requesting its native mount.
  ctx.inject(["remote.wemedia"], remoteContext => {
    controller.connect(remoteContext.remote.wemedia);
    remoteContext.effect(() => () => controller.unavailable());
  });
  ctx.effect(() => mountWorkbenchRemote(() => ctx.remote.$mount(TYPERT_REMOTE), () => {}, () => controller.unavailable()));
  ctx.effect(() => installWorkbenchSlots(ctx.slots, {
    overlay: () => <WorkbenchBoundary onClose={() => controller.close()}><ContentNavigation controller={controller} /></WorkbenchBoundary>,
    settings: () => <WorkbenchBoundary><SettingsCard controller={controller} /></WorkbenchBoundary>,
  }));
}

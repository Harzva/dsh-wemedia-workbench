import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ReactNode } from "react";

type Release = () => void | Promise<void>;

/** A late Remote mount must dispose immediately if its owning fiber stopped. */
export function mountWorkbenchRemote(mount: () => Promise<Release>, ready: () => void, failed: () => void): Release {
  let live = true;
  let release: Release | undefined;
  void Promise.resolve().then(mount).then(dispose => {
    if (!live) { void Promise.resolve().then(dispose).catch(() => {}); return; }
    release = dispose;
    ready();
  }).catch(() => { if (live) failed(); });
  return () => { live = false; const dispose = release; release = undefined; if (dispose) return Promise.resolve().then(dispose).catch(() => {}); };
}

/** Each declaration wait and registration is additive and independently scoped. */
export function installWorkbenchSlots(slots: Context["slots"], renderers: {
  overlay: () => ReactNode;
  settings: () => ReactNode;
}, failed: (surface: string) => void = surface => { console.warn(`WeMedia optional Client surface unavailable: ${surface}`); }): Release {
  const releases: Release[] = [];
  const add = (surface: string, install: () => Release): void => {
    try { releases.push(install()); } catch { failed(surface); }
  };
  const guarded = (surface: string, register: () => Release): Release => {
    try { return register(); } catch { failed(surface); return () => {}; }
  };
  add("shell.overlay", () => slots.inject("shell.overlay", () => guarded("shell.overlay", () => slots.register({ name: "shell.overlay", id: "wemedia-workbench-panel" }, renderers.overlay))));
  add("settings.plugins.tab", () => slots.inject("settings.plugins.tab", () => guarded("settings.plugins.tab", () => slots.register({ name: "settings.plugins.tab", id: "dsh-wemedia-workbench", label: "WeMedia" }, renderers.settings))));
  return () => { for (const release of releases.splice(0).reverse()) { try { release(); } catch { /* Keep sibling cleanup independent. */ } } };
}

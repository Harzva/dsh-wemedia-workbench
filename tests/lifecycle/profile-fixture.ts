import { boot, readProfilePatches, type ProfileContext } from "@deepseek-ai/dsh-app-boot";
import type {} from "@deepseek-ai/dsh-config-editor";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigV1 } from "../../src/config.ts";

export async function workbenchProfile(config: ConfigV1, withSettings = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wemedia-profile-")));
  const dir = join(home, "profiles", "test");
  await mkdir(dir, { recursive: true });
  const profile: ProfileContext = {
    name: "test", home, dir, cwd: home,
    patchPath: join(dir, "cordis.patch.yml"),
    installAnchor: fileURLToPath(new URL("../../package.json", import.meta.url)),
    startedBundles: [], overlays: [], telemetryDisabledEnv: "1",
  };
  const rows = [
    { id: "config-editor", name: "@deepseek-ai/dsh-config-editor" },
    ...(withSettings ? [{ id: "settings", name: "@deepseek-ai/dsh-settings" }] : []),
    { id: "dsh-wemedia-workbench", name: new URL("../../lib/index.js", import.meta.url).href, config },
  ];
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "wemedia-test-profile", private: true, dsh: { profile: { bundles: [] } } }));
  await writeFile(join(dir, "cordis.yml"), "[]\n");
  await writeFile(profile.patchPath, JSON.stringify([{ insert: rows }]));
  try {
    const ctx = await boot("wemedia-test", join(dir, "cordis.yml"), readProfilePatches("dsh", profile), ctx => { ctx.provide("profileContext", profile); }, new URL("../../", import.meta.url).href);
    ctx.effect(() => () => rm(home, { recursive: true, force: true }));
    const mounted = [...ctx.loader.entries()].find(entry => entry.options.id === "dsh-wemedia-workbench")?.fiber;
    if (!mounted) { await ctx.fiber.dispose(); throw new Error("Workbench fixture did not mount"); }
    return { ctx, mounted, profile };
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}

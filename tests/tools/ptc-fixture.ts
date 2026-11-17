import type { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { NodePtcRuntime } from "@deepseek-ai/dsh-ptc-runtime-node";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function installPtcRuntime(ctx: Context): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "wemedia-ptc-")));
  ctx.effect(() => () => rm(cwd, { recursive: true, force: true }));
  await ctx.plugin(LocalFileSystem, { cwd }).await();
  await ctx.plugin(LocalSubprocessRuntime).await();
  await ctx.plugin(LocalSandboxProvider, {}).await();
  await ctx.plugin(SessionProjectionRegistry).await();
  await ctx.plugin(SandboxPolicyService, { mode: "read-only", workspaceRoot: cwd }).await();
  await ctx.plugin(NodePtcRuntime, { timeoutMs: 10_000, maxTimeoutMs: 10_000, maxOutputBytes: 512 * 1024, maxOldGenerationSizeMb: 128 }).await();
}

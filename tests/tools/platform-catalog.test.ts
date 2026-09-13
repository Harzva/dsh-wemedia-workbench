import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, renderToolsSdk, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolExecutionInput, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlatformCatalog } from "../../src/domain/platformCatalog.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { createWorkbenchTools, registerWorkbenchTools } from "../../src/host/tools.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { fixture } from "../workbench/fixture.ts";

const toolName = "wemedia_platform_catalog";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function treeDigest(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, relative = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(resolve(path, entry.name), key);
      else if (entry.isFile()) result[key] = createHash("sha256").update(await readFile(resolve(path, entry.name))).digest("hex");
    }
  }
  await visit(directory);
  return result;
}

async function setup() {
  const f = await fixture(); cleanups.push(f.cleanup);
  const disposeBinding = vi.fn();
  const callers = { bind: () => ({ caller: { kind: "agent" as const, sessionId: "session:catalog-contract" }, dispose: disposeBinding }) };
  const tools = createWorkbenchTools(f.service, callers);
  const tool = tools.find(definition => definition.name === toolName)!;
  const invoke = (args: unknown) => tool.execute(args, { signal: new AbortController().signal } as ToolRunContext);
  return { ...f, callers, tools, tool, invoke, disposeBinding };
}

async function nativeSetup() {
  const f = await setup();
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: "both", maxParallelSubCalls: 2 }).await();
  await ctx.plugin(WorkerThreadCodeRuntime, { computeMs: 1000, maxWallMs: 10_000, maxOutputBytes: 512 * 1024, maxOldGenerationSizeMb: 128 }).await();
  ctx.effect(() => registerWorkbenchTools(ctx, f.service, f.callers));
  let id = 0;
  const call = (name: string, args: unknown) => ctx.tools.execute({ callId: `platform-catalog-${++id}` as ToolExecutionInput["callId"], name, arguments: args, signal: new AbortController().signal });
  const ptc = (args: unknown = {}) => call("run_code", { code: `return await tools.${toolName}(${JSON.stringify(args)});`, description: "Read-only platform catalog contract" });
  return { ...f, ctx, call, ptc };
}

describe("research platform catalog Native/PTC contract", () => {
  it("does not start account discovery, content indexing or job recovery when it is the first request", async () => {
    const f = await setup();
    const service = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, approvals: f.approvals, clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` }, hasher: { digest: sha256 } });
    cleanups.push(() => service.dispose());
    const work = [vi.spyOn(f.documents, "refresh"), vi.spyOn(f.adapter, "discover"), vi.spyOn(f.jobs, "loadAll"), vi.spyOn(f.jobs, "save")];
    const before = await treeDigest(f.directory);
    const result = await service.request({ operation: "platform_catalog" }, { kind: "user" });
    expect(result).toMatchObject({ ok: true, value: getPlatformCatalog() });
    for (const call of work) expect(call).not.toHaveBeenCalled();
    expect(await treeDigest(f.directory)).toEqual(before);
    expect(f.remoteCalls()).toBe(0);
  });

  it("reads the real service catalog without discovering accounts, invoking adapters or changing files", async () => {
    const f = await setup();
    const adapterCalls = [vi.spyOn(f.adapter, "discover"), vi.spyOn(f.adapter, "check"), vi.spyOn(f.adapter, "run"), vi.spyOn(f.adapter, "accountRef")];
    const approvalCalls = [vi.spyOn(f.approvals, "available"), vi.spyOn(f.approvals, "forCaller")];
    const documentReads = vi.spyOn(f.documents, "read");
    const before = await treeDigest(f.directory);
    const fromUser = await f.service.request({ operation: "platform_catalog" }, { kind: "user" });
    const fromAgent = await f.invoke({});
    expect(fromUser).toMatchObject({ ok: true, value: getPlatformCatalog() });
    expect(fromAgent).toEqual(fromUser);
    expect(validateJsonSchemaValue(f.tool.output.schema, fromAgent)).toEqual([]);
    expect(await treeDigest(f.directory)).toEqual(before);
    for (const call of [...adapterCalls, ...approvalCalls, documentReads]) expect(call).not.toHaveBeenCalled();
    expect(f.remoteCalls()).toBe(0);
    expect(f.disposeBinding).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fromAgent)).not.toMatch(/\/Users\/|\/Volumes\/|"(?:access_token|cookies|credentials|absolutePath)"\s*:/);
  });

  it("keeps research entries outside every executable channel request", () => {
    const catalog = getPlatformCatalog();
    expect(catalog.schemaVersion).toBe("wemedia.platform-catalog/v1");
    expect(catalog.platforms).toHaveLength(8);
    expect(catalog.references).toHaveLength(4);
    expect(new Set(catalog.platforms.map(platform => platform.id)).size).toBe(8);
    for (const platform of catalog.platforms) {
      expect(platform.status).toBe("research_only");
      for (const operation of ["channel_preflight", "channel_preview_action"] as const) {
        expect(() => decodeWorkbenchRequest({ operation, contentRef: "wmc:11111111-1111-4111-8111-111111111111", channel: platform.id, ...(operation === "channel_preview_action" ? { action: "publish" } : {}) })).toThrow();
      }
      expect(() => decodeWorkbenchRequest({ operation: "batch_preflight", contentRefs: ["wmc:11111111-1111-4111-8111-111111111111"], channels: [platform.id] })).toThrow();
    }
  });

  it("projects a structured deterministic SDK and rejects nested credential or capability injection", async () => {
    const f = await setup();
    const canonical = await f.invoke({});
    expect(f.tool.parameters).toMatchObject({ type: "object", properties: {} });
    expect(f.tool.isConcurrencySafe?.({})).toBe(true);
    const definition = (tool: ToolDefinition) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema });
    const sdk = renderToolsSdk(f.tools.map(definition));
    expect(sdk).toBe(renderToolsSdk([...f.tools].reverse().map(definition)));
    for (const field of [toolName, "researchedAt", "research_only", "requirements", "limitations", "referenceIds", "commit", "reuse"]) expect(sdk).toContain(field);
    const catalog = getPlatformCatalog();
    for (const value of [
      { ...catalog, credentials: { access_token: "PRIVATE_MARKER" } },
      { ...catalog, platforms: [{ ...catalog.platforms[0]!, status: "ready" }] },
      { ...catalog, platforms: [{ ...catalog.platforms[0]!, publish: true }] },
      { ...catalog, platforms: [{ ...catalog.platforms[0]!, sources: [{ label: "Bad source", url: 42 }] }] },
      { ...catalog, references: [{ ...catalog.references[0]!, absolutePath: "PRIVATE_MARKER" }] },
      {},
    ]) {
      expect(validateJsonSchemaValue(f.tool.output.schema, { ...(canonical as object), value }).length).toBeGreaterThan(0);
    }
  });

  it("rejects every nonempty argument through the shared service and native projection", async () => {
    const f = await setup();
    for (const args of [{ platform: "instagram" }, { online: true }, { approved: true }, { caller: { kind: "user" } }, { operation: "channel_start_action", intentId: "intent:injected" }]) {
      expect(await f.invoke(args)).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
      expect(await f.service.request({ ...args, operation: "platform_catalog" }, { kind: "user" })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    }
    expect(f.remoteCalls()).toBe(0);
  });

  it("keeps canonical values, strict input and policy denial identical through actual Native and PTC execution", async () => {
    const f = await nativeSetup();
    const direct = await f.call(toolName, {});
    const nested = await f.ptc();
    expect(direct.isError).toBe(false); expect(nested.isError).toBe(false);
    expect(direct.value).toMatchObject({ ok: true, value: getPlatformCatalog() });
    expect(nested.value).toEqual({ logs: [], result: direct.value });
    const sdkFields = await f.call("run_code", { code: `const answer = await tools.${toolName}({}); if (!answer.ok) return answer; return answer.value.platforms.map(p => ({id:p.id,status:p.status,formats:p.formats,repositories:p.referenceIds}));`, description: "Use typed catalog fields in existing PTC worker" });
    expect(sdkFields.isError).toBe(false);
    expect(sdkFields.value).toMatchObject({ result: getPlatformCatalog().platforms.map(platform => ({ id: platform.id, status: "research_only", formats: platform.formats, repositories: platform.referenceIds })) });
    const directInvalid = await f.call(toolName, { approved: true });
    const nestedInvalid = await f.ptc({ approved: true });
    expect(directInvalid.value).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    expect(nestedInvalid.value).toMatchObject({ result: { ok: false, error: { code: "REQUEST_INVALID" } } });
    const requests = vi.spyOn(f.service, "request");
    f.ctx.tools.guard(exec => exec.name === toolName ? "PLATFORM_CATALOG_POLICY_DENY" : undefined);
    for (const result of [await f.call(toolName, {}), await f.ptc()]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("PLATFORM_CATALOG_POLICY_DENY");
    }
    expect(requests).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });

  it("rejects an undeclared private field at the actual native output boundary before rendering or PTC exposure", async () => {
    const f = await nativeSetup();
    const canonical = await f.service.request({ operation: "platform_catalog" }, { kind: "user" });
    if (!canonical.ok) throw new Error(canonical.error.code);
    vi.spyOn(f.service, "request").mockResolvedValue({ ...canonical, value: { ...getPlatformCatalog(), privatePath: "PRIVATE_CATALOG_FIELD_MUST_NOT_ESCAPE" } });
    for (const result of [await f.call(toolName, {}), await f.ptc()]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_CATALOG_FIELD_MUST_NOT_ESCAPE");
    }
    expect(f.remoteCalls()).toBe(0);
  });
});

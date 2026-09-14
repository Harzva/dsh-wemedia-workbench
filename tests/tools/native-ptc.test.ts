import { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeWorkbenchApprovals } from "../../src/host/approval.ts";
import { registerWorkbenchTools } from "../../src/host/tools.ts";
import { fixture } from "../workbench/fixture.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import type { WorkflowImportPreview } from "../../src/domain/workbench.ts";
import { ChannelPublishingService } from "../../src/application/channelPublishingService.ts";
import { FileLedgerRepository } from "../../src/infrastructure/ledgerRepository.ts";
import type { PublishingAdapter } from "../../src/ports/channelPublishing.ts";
import type { ChannelPreview } from "../../src/domain/channelPublishing.ts";
import type { WorkbenchJob } from "../../src/domain/workbench.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(mode: "both" | "code" = "both") {
  const f = await fixture(); cleanups.push(f.cleanup);
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode, maxParallelSubCalls: 2 }).await();
  await ctx.plugin(WorkerThreadCodeRuntime, { computeMs: 1000, maxWallMs: 10_000, maxOutputBytes: 512 * 1024, maxOldGenerationSizeMb: 128 }).await();
  const approvals = new NativeWorkbenchApprovals(ctx);
  const channelRuns = vi.fn<PublishingAdapter["run"]>(async (_action, input) => ({ ok: true, code: "CHANNEL_PREPARED", configured: "configured", status: "prepared", revisionDigest: input.document.revisionDigest, remoteWriteAttempted: false, reconcileRequired: false, issues: [], artifacts: [] }));
  const channelAdapters: PublishingAdapter[] = (["zhihu", "xiaohongshu", "x"] as const).map(channel => ({ channel, discover: async () => ({ channel, adapter: "fixture", configured: "configured", actions: [] }), supports: () => true, preflight: async () => ({ ok: true, code: "CHANNEL_READY", configured: "configured", permission: "available", accountRef: `${channel}-account:${"a".repeat(32)}`, remoteWriteAttempted: false, reconcileRequired: false, issues: [], artifacts: [] }), run: channelRuns }));
  const clock = { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) }, ids = { uuidV4: randomUUID, opaqueId: (prefix: string) => `${prefix}:${randomUUID()}` };
  const service = new WorkbenchService({ documents: f.documents, jobs: f.jobs, adapter: f.adapter, approvals, clock, ids, hasher: { digest: sha256 }, channelPublishing: (generationId, canStart) => new ChannelPublishingService({ generationId, canStart, adapters: channelAdapters, documents: f.documents, store: f.store, ledger: new FileLedgerRepository(resolve(f.dataPath, "channel-ledger.jsonl")), approvals, clock, ids, hasher: { digest: sha256 }, writeAvailable: () => true }) });
  cleanups.push(() => service.dispose());
  ctx.effect(() => () => approvals.dispose());
  ctx.effect(() => registerWorkbenchTools(ctx, service, approvals));
  let id = 0;
  const call = (name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ callId: `fixture-${++id}` as ToolExecutionInput["callId"], name, arguments: args, signal });
  const code = (program: string, signal?: AbortSignal) => call("run_code", { code: program, description: "WeMedia offline contract verification" }, signal);
  return { ...f, service, ctx, call, code, channelRuns };
}

describe("real DSH native/PTC registry pipeline (no model or account)", () => {
  it("exposes article templates through the real Native/PTC registry and honors native denial", async () => {
    const f = await setup();
    const direct = await f.call("wemedia_article_templates", {});
    const nested = await f.code("return await tools.wemedia_article_templates({});");
    expect(direct.isError).toBe(false);
    expect(nested.value).toEqual({ logs: [], result: direct.value });
    expect(direct.value).toMatchObject({ ok: true, value: { templates: expect.arrayContaining([expect.objectContaining({ id: "series-index" })]) } });
    const requests = vi.spyOn(f.service, "request");
    f.ctx.tools.guard(exec => exec.name === "wemedia_article_templates" ? "TEMPLATE_POLICY_DENY" : undefined);
    expect((await f.code("return await tools.wemedia_article_templates({});")).isError).toBe(true);
    expect(requests).not.toHaveBeenCalled();
    expect(f.remoteCalls()).toBe(0);
  });
  it.each(["zhihu", "xiaohongshu", "x"] as const)("shares %s channel inspection and local prepare through the actual Native/PTC pipeline", async channel => {
    const f = await setup(), doc = await f.create();
    for (const operation of ["channel_inspect", "channel_preflight"] as const) {
      const args = { contentRef: doc.contentRef, ...(operation === "channel_preflight" ? { channel, online: false } : {}) };
      const direct = await f.call(`wemedia_${operation}`, args);
      const nested = await f.code(`return await tools.wemedia_${operation}(${JSON.stringify(args)});`);
      expect(direct.isError).toBe(false); expect(nested.isError).toBe(false);
      expect(nested.value).toEqual({ logs: [], result: direct.value });
      expect(direct.value).toMatchObject({ ok: true });
    }
    const result = await f.call("wemedia_channel_preview_action", { contentRef: doc.contentRef, channel, action: "prepare" });
    expect(result.isError).toBe(false);
    const preview = result.value as { ok: true; value: ChannelPreview };
    expect(preview).toMatchObject({ ok: true, value: { intent: { sideEffect: "local_write" }, gates: { status: "pass" } } });
    const started = await f.code(`return await tools.wemedia_channel_start_action({intentId:${JSON.stringify(preview.value.intent.intentId)}});`);
    expect(started.isError).toBe(false);
    const answer = started.value as { result: { ok: true; value: WorkbenchJob } };
    expect(answer.result.ok).toBe(true);
    expect((await f.service.settle(answer.result.value.jobId)).status).toBe("succeeded");
    expect(f.channelRuns).toHaveBeenCalledTimes(1);
    expect(f.remoteCalls()).toBe(0);
  });
  it("rejects channel approval injection and schema-valid remote execution without Agent approval", async () => {
    const f = await setup(), doc = await f.create();
    const p = await f.call("wemedia_channel_preview_action", { contentRef: doc.contentRef, channel: "x", action: "publish" });
    expect(p.isError).toBe(false);
    const preview = p.value as { ok: true; value: ChannelPreview };
    const attempt = await f.code(`return await tools.wemedia_channel_start_action({intentId:${JSON.stringify(preview.value.intent.intentId)}});`);
    expect(attempt.value).toMatchObject({ result: { ok: false } });
    const forged = await f.code(`return await tools.wemedia_channel_start_action({intentId:${JSON.stringify(preview.value.intent.intentId)},approved:true});`);
    expect(forged.value).toMatchObject({ result: { ok: false, error: { code: "REQUEST_INVALID" } } });
    expect(f.channelRuns).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });
  it.each(["channel_inspect", "channel_preflight", "channel_preview_action", "channel_start_action"])("keeps native policy ahead of the %s body for direct and PTC calls", async operation => {
    const f = await setup(), doc = await f.create(), name = `wemedia_${operation}`;
    const requests = vi.spyOn(f.service, "request");
    f.ctx.tools.guard(exec => exec.name === name ? "CHANNEL_POLICY_DENY" : undefined);
    const args = operation === "channel_start_action" ? { intentId: "channelintent:fixture" } : { contentRef: doc.contentRef, ...(operation === "channel_inspect" ? {} : { channel: "x" }), ...(operation === "channel_preview_action" ? { action: "prepare" } : {}) };
    for (const result of [await f.call(name, args), await f.code(`return await tools.${name}(${JSON.stringify(args)});`)]) {
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("CHANNEL_POLICY_DENY");
    }
    expect(requests).not.toHaveBeenCalled(); expect(f.channelRuns).not.toHaveBeenCalled();
  });
  it("uses the same canonical values and full policy pipeline for direct and nested calls", async () => {
    const f = await setup(); const document = await f.create();
    const trace: string[] = [];
    f.ctx.on("tools/pre-execute", async (exec, next) => { trace.push(`pre:${exec.name}`); return next(); });
    f.ctx.on("tools/execute", async (exec, next) => { trace.push(`execute:${exec.name}`); return next(); });
    f.ctx.on("tools/post-execute", async (exec, _result, next) => { trace.push(`post:${exec.name}`); return next(); });
    f.ctx.on("tools/result", exec => { trace.push(`result:${exec.name}`); });
    const direct = await f.call("wemedia_preflight", { contentRef: document.contentRef });
    const nested = await f.code(`return await tools.wemedia_preflight({contentRef:${JSON.stringify(document.contentRef)}});`);
    expect(direct.isError).toBe(false); expect(nested.isError).toBe(false);
    expect(nested.value).toEqual({ logs: [], result: direct.value });
    for (const stage of ["pre", "execute", "post", "result"]) {
      expect(trace.filter(item => item === `${stage}:wemedia_preflight`)).toHaveLength(2);
      expect(trace.filter(item => item === `${stage}:run_code`)).toHaveLength(1);
    }
    expect(f.remoteCalls()).toBe(0);
  });
  it("runs batch filtering inside the existing worker and returns only problem articles", async () => {
    const f = await setup(); const good = await f.create(); await f.reviewAll(good); const bad = await f.create();
    const result = await f.code(`
      const page = await tools.wemedia_search_contents({query:"", pageSize:20});
      if (!page.ok) return page;
      const checked = await Promise.all(page.value.items.map(async article => {
        const gate = await tools.wemedia_preflight({contentRef:article.contentRef});
        return {contentRef:article.contentRef, gate};
      }));
      return checked.filter(item => !item.gate.ok || item.gate.value.status !== "pass")
        .map(item => ({contentRef:item.contentRef, codes:item.gate.ok ? item.gate.value.issues.filter(issue => issue.status !== "pass").map(issue => issue.code) : [item.gate.error.code]}));
    `);
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({ logs: [], result: [{ contentRef: bad.contentRef, codes: expect.arrayContaining(["REVIEW_FACTS", "REVIEW_EDITORIAL"]) }] });
    expect(JSON.stringify(result.value)).not.toContain(good.contentRef);
    expect(f.remoteCalls()).toBe(0);
  });
  it("enforces the same monotonic denial for ordinary and PTC calls before any body work", async () => {
    const f = await setup(); const doc = await f.create(); const checks = vi.spyOn(f.adapter, "check");
    f.ctx.tools.guard(exec => exec.name === "wemedia_preflight" ? "POLICY_FIXTURE_DENY" : undefined);
    const direct = await f.call("wemedia_preflight", { contentRef: doc.contentRef });
    const nested = await f.code(`return await tools.wemedia_preflight({contentRef:${JSON.stringify(doc.contentRef)}});`);
    expect(direct.isError).toBe(true); expect(nested.isError).toBe(true);
    expect(JSON.stringify(direct)).toContain("POLICY_FIXTURE_DENY");
    expect(JSON.stringify(nested)).toContain("POLICY_FIXTURE_DENY");
    expect(checks).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });
  it("rejects forged approval and refuses remote writes without a real Agent approval binding", async () => {
    const f = await setup(); const doc = await f.create(); await f.reviewAll(doc);
    const preview = await f.call("wemedia_preview_action", { contentRef: doc.contentRef, action: "create_draft" });
    const result = preview.value as { ok: true; value: { intent: { intentId: string } } };
    expect(preview.isError).toBe(false);
    const denied = await f.code(`return await tools.wemedia_start_action({intentId:${JSON.stringify(result.value.intent.intentId)}});`);
    expect(denied.value).toMatchObject({ result: { ok: false, error: { code: "AGENT_APPROVAL_REQUIRED" } } });
    const forged = await f.code(`return await tools.wemedia_start_action({intentId:${JSON.stringify(result.value.intent.intentId)},approved:true});`);
    expect(forged.value).toMatchObject({ result: { ok: false, error: { code: "REQUEST_INVALID" } } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("honors existing code-only presentation without changing it and cancels pre-aborted calls", async () => {
    const f = await setup("code");
    const direct = await f.call("wemedia_snapshot", {});
    expect(direct.isError).toBe(true); expect(JSON.stringify(direct)).toContain("UNKNOWN_TOOL");
    const nested = await f.code("return await tools.wemedia_snapshot({});");
    expect(nested.isError).toBe(false); expect(nested.value).toMatchObject({ result: { ok: true } });
    const controller = new AbortController(); controller.abort();
    const cancelled = await f.code("return await tools.wemedia_refresh({});", controller.signal);
    expect(cancelled.isError).toBe(true);
    expect(f.remoteCalls()).toBe(0);
  });
  it.each(["ai_inspect", "ai_preview"] as const)("preserves canonical %s diagnostics across Native and PTC without creating review evidence", async operation => {
    const f = await setup(); const document = await f.create();
    f.adapter.inspectAi = async (action, doc) => ({ operation: action, revisionDigest: doc.revisionDigest, mode: "ai", sourceKind: "markdown", status: "block", code: "WECHAT_AI_BLOCKED", previewFidelity: "degraded", issues: [{ gateId: "wechat-ai", version: "1", status: "block", code: "QUALITY_GAP", safeMessage: "Quality review still required", inputDigest: doc.revisionDigest, evidenceRefs: [] }] });
    const direct = await f.call(`wemedia_${operation}`, { contentRef: document.contentRef });
    const nested = await f.code(`return await tools.wemedia_${operation}({contentRef:${JSON.stringify(document.contentRef)}});`);
    expect(direct.isError).toBe(false); expect(nested.isError).toBe(false);
    expect(direct.value).toMatchObject({ ok: true, value: { operation, status: "block", previewFidelity: "degraded", issues: [{ code: "QUALITY_GAP" }] } });
    expect(nested.value).toEqual({ logs: [], result: direct.value });
    expect((await f.documents.read(document.contentRef)).reviews).toEqual([]);
    expect(f.remoteCalls()).toBe(0);
  });
  it("shares workflow import preview and apply between the PTC worker and Native tools", async () => {
    const f = await setup(); const document = await f.create();
    await writeFile(resolve(f.writePath, "review.json"), JSON.stringify({ schemaVersion: "wemedia.review/v1", kind: "facts", revisionDigest: document.revisionDigest, verdict: "pass", findings: ["Fixture facts checked"] }));
    const preview = await f.code(`return await tools.wemedia_preview_workflow_import({contentRef:${JSON.stringify(document.contentRef)},kind:"review",artifact:{rootId:"write",relativePath:"review.json"}});`);
    expect(preview.isError).toBe(false);
    const value = preview.value as { result: { ok: true; value: WorkflowImportPreview } };
    expect(value.result).toMatchObject({ ok: true, value: { kind: "review", requiresIdentityCheck: false, material: { status: "current", reviewKind: "facts" } } });
    const applied = await f.call("wemedia_apply_workflow_import", { intentId: value.result.value.intent.intentId });
    expect(applied.isError).toBe(false);
    // This offline ToolExecutionInput has no Agent binding; the native caller is a user.
    expect(applied.value).toMatchObject({ ok: true, value: { workflowImports: [{ kind: "review", status: "current" }], reviews: [{ kind: "facts", reviewer: "user", valid: true }] } });
    const replay = await f.code(`return await tools.wemedia_apply_workflow_import({intentId:${JSON.stringify(value.result.value.intent.intentId)}});`);
    expect(replay.value).toMatchObject({ result: { ok: false, error: { code: "INTENT_EXPIRED" } } });
    expect(f.remoteCalls()).toBe(0);
  });
  it.each(["wemedia_ai_inspect", "wemedia_ai_preview", "wemedia_preview_workflow_import", "wemedia_apply_workflow_import"])("enforces policy for %s before direct and PTC body execution", async name => {
    const f = await setup(); const document = await f.create();
    const requests = vi.spyOn(f.service, "request");
    f.ctx.tools.guard(exec => exec.name === name ? "WORKFLOW_POLICY_DENY" : undefined);
    const args = name === "wemedia_apply_workflow_import" ? { intentId: "intent:fixture" } : name === "wemedia_preview_workflow_import" ? { contentRef: document.contentRef, kind: "review", artifact: { rootId: "write", relativePath: "review.json" } } : { contentRef: document.contentRef };
    const direct = await f.call(name, args);
    const nested = await f.code(`return await tools.${name}(${JSON.stringify(args)});`);
    expect(direct.isError).toBe(true); expect(nested.isError).toBe(true);
    expect(JSON.stringify(direct)).toContain("WORKFLOW_POLICY_DENY");
    expect(JSON.stringify(nested)).toContain("WORKFLOW_POLICY_DENY");
    expect(requests).not.toHaveBeenCalled(); expect(f.remoteCalls()).toBe(0);
  });
  it("rejects undeclared native AI source text at the actual canonical output boundary", async () => {
    const f = await setup(); const document = await f.create();
    f.adapter.inspectAi = async (operation, doc) => ({ operation, revisionDigest: doc.revisionDigest, mode: "ai", sourceKind: "markdown", status: "pass", code: "WECHAT_AI_READY", previewFidelity: "exact", issues: [], html: "RAW_SOURCE_MUST_NOT_ESCAPE" });
    const direct = await f.call("wemedia_ai_inspect", { contentRef: document.contentRef });
    const nested = await f.code(`return await tools.wemedia_ai_inspect({contentRef:${JSON.stringify(document.contentRef)}});`);
    expect(direct.isError).toBe(true); expect(nested.isError).toBe(true);
    expect(JSON.stringify([direct, nested])).not.toContain("RAW_SOURCE_MUST_NOT_ESCAPE");
    expect(f.remoteCalls()).toBe(0);
  });
});

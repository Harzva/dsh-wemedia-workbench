import { afterEach, describe, expect, it } from "vitest";
import { renderToolsSdk, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ActionPreview, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import { createWorkbenchTools, WORKBENCH_TOOL_NAMES } from "../../src/host/tools.ts";
import { fixture } from "../workbench/fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });
async function setup() {
  const f = await fixture(); fixtures.push(f);
  let bound = 0;
  const tools = createWorkbenchTools(f.service, { bind: () => { bound++; return { caller: { kind: "agent", callId: "fixture" }, dispose: () => { bound--; } }; } });
  const invoke = async (name: string, args: unknown) => {
    const tool = tools.find(tool => tool.name === name)!;
    // Direct contract harness only. Native registry/PTC execution is separately tested.
    const value = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext);
    expect(validateJsonSchemaValue(tool.output.schema, value), name).toEqual([]);
    expect(bound).toBe(0);
    return value as WorkbenchAnswer;
  };
  return { ...f, tools, invoke };
}
function success<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }

describe("shared native/PTC tool projection", () => {
  it("generates precise canonical SDK outputs without a custom run_code or batch engine", async () => {
    const f = await setup();
    expect(WORKBENCH_TOOL_NAMES).toHaveLength(45);
    expect(new Set(WORKBENCH_TOOL_NAMES).size).toBe(45);
    expect(WORKBENCH_TOOL_NAMES).not.toContain("run_code");
    const inputs = f.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema }));
    const sdk = renderToolsSdk(inputs);
    expect(sdk).toBe(renderToolsSdk([...inputs].reverse()));
    for (const field of ["contentRef", "nextCursor", "inputDigest", "issues", "safeMessage", "revisionDigest", "reconcile_required", "jobId", "previewFidelity", "workflowImports", "sourceDigest", "requiresIdentityCheck", "publicationRef", "mappingRef", "generatedDigest", "retainedSourceRecordIds", "requiresReconnect", "coverItemId", "dataBase64"]) expect(sdk).toContain(field);
    expect(sdk).toContain('"pass" | "warn" | "block"');
    const definition = f.tools.find(tool => tool.name === "wemedia_preflight")!;
    expect(definition.isConcurrencySafe?.({ contentRef: "wmc:fixture" })).toBe(true);
    expect(definition.isConcurrencySafe?.({ contentRef: 12 })).toBe(false);
    for (const name of ["wemedia_refresh", "wemedia_start_action", "wemedia_preview_action", "wemedia_record_review", "wemedia_preview_workflow_import", "wemedia_apply_workflow_import"]) expect(f.tools.find(tool => tool.name === name)?.isConcurrencySafe).toBeUndefined();
    for (const name of ["wemedia_ai_inspect", "wemedia_ai_preview"]) {
      expect(f.tools.find(tool => tool.name === name)?.isConcurrencySafe?.({ contentRef: "wmc:fixture" })).toBe(true);
      expect(f.tools.find(tool => tool.name === name)?.isConcurrencySafe?.({ contentRef: 12 })).toBe(false);
    }
  });
  it("keeps transient Xiaohongshu share parameters outside native Agent collection tools", async () => {
    const f = await setup();
    for (const kind of ["xhs_note", "xhs_author"]) await expect(f.invoke("wemedia_reference_collect", { kind, url: "https://www.xiaohongshu.com/explore/111111111111111111111111?xsec_token=synthetic" })).rejects.toThrow();
    expect(f.remoteCalls()).toBe(0);
  });
  it("returns typed search, document, gate, preview and task values from the existing service", async () => {
    const f = await setup(); const doc = await f.create();
    await f.invoke("wemedia_snapshot", {});
    await f.invoke("wemedia_refresh", {});
    await f.invoke("wemedia_search_contents", { query: "", pageSize: 1 });
    for (const name of ["wemedia_inspect_content", "wemedia_preflight", "wemedia_preview"]) await f.invoke(name, { contentRef: doc.contentRef });
    const brief = await f.invoke("wemedia_task_brief", { contentRef: doc.contentRef, action: "review" });
    expect(brief.ok).toBe(true);
    expect(f.remoteCalls()).toBe(0);
  });
  it("shares local version creation and durable jobs with user/RPC calls", async () => {
    const f = await setup();
    const input = { title: "Shared article", sourceUrl: "https://example.org/shared", kind: "article" };
    const preview = success<{ intent: ActionPreview["intent"] }>(await f.invoke("wemedia_create_content", input));
    const started = success<WorkbenchJob>(await f.invoke("wemedia_create_content", { ...input, applyIntentId: preview.intent.intentId }));
    await f.service.settle(started.jobId);
    const job = success<WorkbenchJob>(await f.invoke("wemedia_get_job", { jobId: started.jobId }));
    expect(job.status).toBe("succeeded");
    expect((await f.service.request({ operation: "inspect", contentRef: job.contentRef }, { kind: "user" })).ok).toBe(true);
    await f.invoke("wemedia_cancel_job", { jobId: job.jobId });
    expect(await f.invoke("wemedia_start_action", { intentId: preview.intent.intentId })).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("rejects caller, approval and operation injection, including canonical errors", async () => {
    const f = await setup(); const doc = await f.create();
    for (const extra of [{ approved: true }, { caller: { kind: "agent" } }, { operation: "start_action" }]) {
      expect(await f.invoke("wemedia_inspect_content", { contentRef: doc.contentRef, ...extra })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    }
    expect(await f.invoke("wemedia_search_contents", { query: "", pageSize: 0 })).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    await expect(f.invoke("wemedia_inspect_content", { contentRef: 123 })).rejects.toThrow();
    const preview = success<ActionPreview>(await f.invoke("wemedia_preview_action", { contentRef: doc.contentRef, action: "create_draft" }));
    expect(await f.invoke("wemedia_start_action", { intentId: preview.intent.intentId })).toMatchObject({ ok: false, error: { code: "GATES_BLOCKED" } });
    expect(f.remoteCalls()).toBe(0);
  });
  it("does not let metadata from an old report grant current review evidence", async () => {
    const f = await setup(); const doc = await f.create();
    const answer = await f.invoke("wemedia_record_review", { contentRef: doc.contentRef, kind: "facts", revisionDigest: `sha256:${"0".repeat(64)}`, artifact: { rootId: "write", relativePath: "review.json" }, summary: "Outdated review" });
    expect(answer).toMatchObject({ ok: false, error: { code: "REVIEW_STALE" } });
  });
});

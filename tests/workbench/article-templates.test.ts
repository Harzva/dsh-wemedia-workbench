import { afterEach, describe, expect, it } from "vitest";
import { articleTemplate, articleTemplates, renderArticleTemplate } from "../../src/domain/articleTemplates.ts";
import { decodeWorkbenchRequest } from "../../src/domain/workbenchRequest.ts";
import { createWorkbenchTools } from "../../src/host/tools.ts";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { ActionPreview, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const user = { kind: "user" as const };
function value<T>(answer: WorkbenchAnswer): T { if (!answer.ok) throw new Error(answer.error.code); return answer.value as T; }
async function setup() { const f = await fixture(); fixtures.push(f); return f; }

describe("source-aware article templates", () => {
  it("provides six templates and a backward-compatible blank without shared mutable definitions", () => {
    const list = articleTemplates();
    expect(list).toHaveLength(7);
    expect(new Set(list.map(item => item.id)).size).toBe(7);
    list[1]!.sections[0]!.title = "changed";
    expect(articleTemplate("paper-deep-dive").sections[0]!.title).toBe("论文介绍");
    expect(renderArticleTemplate("blank", "Title", "").markdown).toBe("# Title\n");
  });
  it("escapes user text and keeps missing evidence explicit in both formats", () => {
    const result = renderArticleTemplate("paper-deep-dive", '<img src=x onerror="alert(1)">', "https://example.org/paper?a=1&b=2");
    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("&lt;img");
    expect(result.markdown).toContain("\\<img");
    for (const title of ["作者与团队", "摘要提炼", "引言与研究动机", "方法与关键图示", "实验与表格解读"]) {
      expect(result.markdown).toContain(title);
      expect(result.html).toContain(title);
    }
    expect(result.markdown).toContain("待补");
    expect(result.markdown).toContain("仅在确有人工审核时");
  });
  it("rejects unknown templates, incompatible kinds and injected body/review fields", () => {
    const request = { operation: "create_content", kind: "paper", title: "Paper", sourceUrl: "" };
    for (const extra of [{ templateId: "missing" }, { templateId: "series-index" }, { body: "forged" }, { reviewed: true }]) expect(() => decodeWorkbenchRequest({ ...request, ...extra })).toThrow();
    expect(() => decodeWorkbenchRequest({ operation: "article_templates", approved: true })).toThrow();
  });
  it.each(articleTemplates())("creates $id as one independent unreviewed local revision", async template => {
    const f = await setup();
    const request = { operation: "create_content", title: "Template test", sourceUrl: "https://example.org/paper", kind: template.kind === "any" ? "article" : template.kind, templateId: template.id };
    const preview = value<{ intent: ActionPreview["intent"]; summary: string[] }>(await f.service.request(request, user));
    expect(preview.summary.join("\n")).toContain(template.label);
    expect((await f.documents.list()).length).toBe(0);
    const job = value<WorkbenchJob>(await f.service.request({ ...request, applyIntentId: preview.intent.intentId }, user));
    expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
    const doc = await f.documents.read(job.contentRef);
    expect(doc.markdown).toBe(renderArticleTemplate(template.id, request.title, request.sourceUrl).markdown);
    expect(doc.reviews).toEqual([]);
    expect(doc.targets).toEqual([]);
    expect(doc.assets).toEqual([]);
    expect(f.remoteCalls()).toBe(0);
    expect(await f.service.request({ ...request, applyIntentId: preview.intent.intentId }, user)).toMatchObject({ ok: false });
  });
  it("rejects a template swap between preview and confirmation without consuming the original intent", async () => {
    const f = await setup();
    const request = { operation: "create_content", title: "Paper", sourceUrl: "", kind: "paper", templateId: "paper-deep-dive" };
    const preview = value<{ intent: ActionPreview["intent"] }>(await f.service.request(request, user));
    expect(await f.service.request({ ...request, templateId: "nature-review", applyIntentId: preview.intent.intentId }, user)).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
    const job = value<WorkbenchJob>(await f.service.request({ ...request, applyIntentId: preview.intent.intentId }, user));
    expect((await f.service.settle(job.jobId)).status).toBe("succeeded");
    expect(f.remoteCalls()).toBe(0);
  });
  it("returns the native tool's declared catalog schema without writing or invoking a model", async () => {
    const f = await setup();
    const answer = await f.service.request({ operation: "article_templates" }, user);
    const tool = createWorkbenchTools(f.service, { bind: () => ({ caller: user, dispose() {} }) }).find(item => item.name === "wemedia_article_templates")!;
    expect(validateJsonSchemaValue(tool.output.schema, answer)).toEqual([]);
    expect(value<{ templates: unknown[] }>(answer).templates).toHaveLength(7);
    expect((await f.documents.list()).length).toBe(0);
    expect(f.remoteCalls()).toBe(0);
  });
});

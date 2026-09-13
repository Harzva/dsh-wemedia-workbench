import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPreview, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import { fixture } from "./fixture.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const value = await fixture(); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.cleanup())); vi.restoreAllMocks(); });

function value<T>(answer: WorkbenchAnswer): T {
  if (!answer.ok) throw new Error(answer.error.code);
  return answer.value as T;
}

const user = { kind: "user" as const };

describe("task brief workflow guidance", () => {
  it("discloses AI assistance without mandatory model attribution or silent article edits", async () => {
    const f = await setup();
    const document = await f.create();
    const brief = value<{ prompt: string }>(await f.service.request({ operation: "task_brief", contentRef: document.contentRef, action: "write_draft" }, user));
    expect(brief.prompt).toContain("明确说明 AI 辅助整理");
    expect(brief.prompt).toContain("docs/ai-assisted-workflow.md");
    expect(brief.prompt).toContain("不得把 Agent 复核写成人工审核");
    expect(brief.prompt).toContain("具体模型名称不是逐篇必填项");
    expect(brief.prompt).toContain("仍须保留修订、Job 与目标核验状态");
    expect(brief.prompt).toContain("已有冻结或已入箱文章不因补声明自动改写");
    expect((await f.documents.read(document.contentRef)).revisionDigest).toBe(document.revisionDigest);
  });
  it("reuses cached figures before explicit local cropping without changing permissions", async () => {
    const f = await setup();
    const document = await f.create();
    const brief = value<{ prompt: string }>(await f.service.request({ operation: "task_brief", contentRef: document.contentRef, action: "write_draft" }, user));
    expect(brief.prompt).toContain("优先复用已核验字节");
    expect(brief.prompt).toContain("scripts/crop-pdf-asset.py");
    expect(brief.prompt).toContain("明确 PDF 一基页码与 bbox 坐标系");
    expect(brief.prompt).toContain("manifest 和检测置信度不代替图像审阅");
    expect(brief.prompt).toContain("不自动安装或扩大权限");
  });
  it("requires fresh paragraph and asset/source closure for article review", async () => {
    const f = await setup();
    const document = await f.create();
    const brief = value<{ prompt: string }>(await f.service.request({ operation: "task_brief", contentRef: document.contentRef, action: "review" }, user));

    expect(brief.prompt).toContain("fresh");
    expect(brief.prompt).toContain("revisionDigest、paragraphs 和 assets");
    expect(brief.prompt).toContain("段号到来源映射");
    expect(brief.prompt).toContain("包括但不限于数字、提升/下降、实验比较");
    expect(brief.prompt).toContain("不能机械写 N/A");
    expect(brief.prompt).toContain("不能只因出现“成本”或“实验”一词就自动算事实");
    expect(brief.prompt).toContain("普通“实验设置”等无事实主张的结构标题仍可标记 not_applicable");
    expect(brief.prompt).toContain("三类 JSON report kind 只在其对应证据实际核验后分别登记");
    expect(brief.prompt).toContain("verdict=pass");
    expect(brief.prompt).toContain("前三类报告使用 wemedia.review/v1 JSON");
    expect(brief.prompt).toContain("不生成替代截图的 JSON");
    expect(brief.prompt).toContain("schema 或字段校验通过不等于事实核查通过");
    expect(brief.prompt).toContain("重写 facts、editorial、images_formulas 三份 JSON");
    expect(brief.prompt).toContain("同路径不等于同一份证据");
    expect(brief.prompt).toContain("设置视口成功不等于页面已变成 390px");
    expect(brief.prompt).toContain("artifactDigest");
    expect(brief.prompt).toContain("facts/editorial/images_formulas 三类 JSON 报告分别核 coverage.complete");
    expect(brief.prompt).toContain("不要求 PNG 伪造 details 或 coverage.complete");
    expect(brief.prompt).toContain("coverage.complete");
  });

  it("keeps queued and running explicitly non-terminal and makes success conditional", async () => {
    const f = await setup();
    const document = await f.create();
    const saves = vi.spyOn(f.jobs, "save");
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: document.contentRef, action: "prepare" }, user));
    const started = value<WorkbenchJob>(await f.service.request({ operation: "start_action", intentId: preview.intent.intentId }, user));

    expect(started.status).toBe("queued");
    expect(started.safeMessage).toContain("尚未完成");
    expect(started.safeMessage).toContain("wemedia_get_job");

    const finished = await f.service.settle(started.jobId);
    const running = saves.mock.calls.map(([job]) => job).find(job => job.status === "running");
    expect(running).toBeDefined();
    expect(running!.safeMessage).toContain("尚未完成");
    expect(running!.safeMessage).toContain("不是等待审批");
    expect(finished.status).toBe("succeeded");
    expect(finished.safeMessage).toContain("resultCode");
    expect(finished.safeMessage).toContain("目标和当前内容版本");
    expect(finished.safeMessage).toContain("不等同于已正式发布");
  });

  it("tells an authorized action to poll terminal state and avoid blind retries", async () => {
    const f = await setup();
    const document = await f.create();
    const preview = value<ActionPreview>(await f.service.request({ operation: "preview_action", contentRef: document.contentRef, action: "prepare" }, user));
    const prompt = f.service.intentTask(preview.intent.intentId);

    expect(prompt).toContain("已授权操作启动后不要停止");
    expect(prompt).toContain("再用 wemedia_get_job 查询");
    expect(prompt).toContain("先等待一个有限间隔");
    expect(prompt).toContain("以适度间隔重复，避免忙轮询");
    expect(prompt).not.toContain("立即用 wemedia_get_job 持续查询");
    expect(prompt).toContain("直到 succeeded、failed、cancelled、timed_out 或 reconcile_required");
    expect(prompt).toContain("只有 waiting_user 才等待 DSH 原生审批");
    expect(prompt).toContain("failed、timed_out、reconcile_required 或 cancelled");
    expect(prompt).toContain("不要盲目重试、重复创建");
  });
});

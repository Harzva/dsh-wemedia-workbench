import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelActionsController, ChannelActionsPanel, publicChannelUrl, trackChannelJobs } from "../../src/client/channel-actions.tsx";
import type { ChannelActionsContext, ChannelActionsHost } from "../../src/client/channel-actions.tsx";
import { CHANNEL_ACTIONS, PUBLISHING_CHANNELS, channelEffect } from "../../src/domain/channelPublishing.ts";
import type { ChannelAction, ChannelCheck, ChannelInspection, ChannelPreview, ChannelTarget, PublishingChannel } from "../../src/domain/channelPublishing.ts";
import type { WorkbenchJob, WorkbenchRequest, WorkbenchValue } from "../../src/domain/workbench.ts";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [dirname(require.resolve("@deepseek-ai/dsh-client-runtime"))] })) as { renderToStaticMarkup: (node: ReactNode) => string };
const context: ChannelActionsContext = { contentRef: "wmc:00000000-0000-4000-8000-000000000001", revisionDigest: `sha256:${"a".repeat(64)}`, connected: true, dirty: false, generationId: "g1", writable: true, approvalAvailable: true };
const inspection = (values: Partial<ChannelInspection> = {}): ChannelInspection => ({ contentRef: context.contentRef, revisionDigest: context.revisionDigest, publicationType: "image_text", capabilities: [], targets: [], jobs: [], issues: [], matrix: PUBLISHING_CHANNELS.flatMap(channel => CHANNEL_ACTIONS.map(action => ({ channel, action, publicationType: "image_text" as const, status: "ready", reasonCode: "CHANNEL_PROTOCOL_AVAILABLE" }))), ...values });
const preview = (channel: PublishingChannel, action: ChannelAction, values: Partial<ChannelPreview> = {}): ChannelPreview => ({ channel, action, publicationType: "image_text", target: null, summary: ["当前已保存版本", "核对目标账号"], gates: { status: "pass", inputDigest: context.revisionDigest, issues: [] }, intent: { intentId: `intent:${channel}:${action}`, generationId: "g1", contentRef: context.contentRef, channel, action: `channel_${action}`, sideEffect: channelEffect(channel, action), targetSummary: `目标账号 · ${channel}`, inputDigest: "sha256:intent", artifactDigest: context.revisionDigest, expectedChanges: [], blockingGateCodes: [], expiresAt: "2030-01-01T00:00:00Z", approved: false }, ...values });
const job = (values: Partial<WorkbenchJob> = {}): WorkbenchJob => ({ jobId: "channeljob:1", generationId: "g1", contentRef: context.contentRef, intentId: "intent:zhihu:prepare", inputDigest: "sha256:intent", action: "channel_prepare", sideEffect: "local_write", channel: "zhihu", status: "queued", progress: { current: 0, total: 3 }, safeMessage: "等待任务执行", createdAt: "2026-09-09T00:00:00Z", retryable: false, artifactRefs: [], ...values });
const target = (values: Partial<ChannelTarget> = {}): ChannelTarget => ({ targetRef: "target:1", channel: "zhihu", label: "知乎 · 平台草稿", status: "draft", revisionDigest: context.revisionDigest, verifiedAt: "2026-09-09T00:00:00Z", url: "https://zhuanlan.zhihu.com/p/1234", ...values });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }
const defaultResponse = async (input: WorkbenchRequest): Promise<WorkbenchValue> => input.operation === "channel_inspect" ? inspection() : input.operation === "channel_preview_action" ? preview(input.channel, input.action) : job();
function setup(respond = defaultResponse, initial = context) {
  const request = vi.fn<ChannelActionsHost["channelRequest"]>(respond), handoff = vi.fn<ChannelActionsHost["handoffChannelIntent"]>(async () => {});
  const model = new ChannelActionsController({ channelRequest: request, handoffChannelIntent: handoff }, initial, () => Date.parse("2026-09-09T00:00:00Z"));
  return { model, request, handoff };
}
const markup = (model: ChannelActionsController) => renderToStaticMarkup(createElement(ChannelActionsPanel, { model, view: model.getSnapshot() }));

describe("channel action lifecycle and current-version binding", () => {
  it("loads read-only capability data and requires a concrete preview before starting local work", async () => {
    const { model, request, handoff } = setup();
    await model.confirmPreview(); expect(request).not.toHaveBeenCalled();
    await model.inspect(); await model.previewAction("prepare");
    expect(request.mock.calls.map(([value]) => value.operation)).toEqual(["channel_inspect", "channel_preview_action"]);
    const first = model.confirmPreview(), duplicate = model.confirmPreview(); await Promise.all([first, duplicate]);
    expect(request.mock.calls.map(([value]) => value.operation)).toEqual(["channel_inspect", "channel_preview_action", "channel_start_action"]);
    expect(handoff).not.toHaveBeenCalled(); expect(model.getSnapshot().jobs[0]?.status).toBe("queued"); expect(model.getSnapshot().preview).toBeNull();
  });
  it.each([["zhihu", "stage"], ["zhihu", "publish"], ["xiaohongshu", "publish"], ["x", "publish"]] as const)("%s %s hands off to native Agent approval without starting an external action", async (channel, action) => {
    const { model, request, handoff } = setup(); model.selectChannel(channel); await model.inspect(); await model.previewAction(action); await model.confirmPreview(); await model.confirmPreview();
    expect(handoff).toHaveBeenCalledExactlyOnceWith(`intent:${channel}:${action}`);
    expect(request.mock.calls.some(([value]) => value.operation === "channel_start_action")).toBe(false);
    expect(model.getSnapshot().notice).toContain("原生审批");
  });
  it.each(["xiaohongshu", "x"] as const)("%s stage only starts local preparation", async channel => {
    const { model, request, handoff } = setup(); model.selectChannel(channel); await model.inspect(); await model.previewAction("stage"); await model.confirmPreview();
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ operation: "channel_start_action", intentId: `intent:${channel}:stage` }); expect(handoff).not.toHaveBeenCalled();
  });
  it.each(["content", "revision", "dirty", "disconnected", "generation", "unmount", "channel"])("%s change aborts a preview and suppresses its late response", async change => {
    const pending = deferred<WorkbenchValue>();
    const { model, request } = setup(async input => input.operation === "channel_preview_action" ? pending.promise : defaultResponse(input));
    await model.inspect(); const loading = model.previewAction("publish"), signal = request.mock.calls.at(-1)?.[1];
    if (change === "unmount") model.disconnect();
    else if (change === "channel") model.selectChannel("x");
    else model.setContext({ ...context, ...(change === "content" ? { contentRef: "wmc:other" } : change === "revision" ? { revisionDigest: "sha256:new" } : change === "dirty" ? { dirty: true } : change === "generation" ? { generationId: "g2" } : { connected: false }) });
    expect(signal?.aborted).toBe(true); pending.resolve(preview("zhihu", "publish")); await loading;
    expect(model.getSnapshot().preview).toBeNull(); expect(model.getSnapshot().pending).toBeNull(); expect(model.getSnapshot().error).toBeNull();
  });
  it("clears an existing preview when a same-content revision changes", async () => {
    const { model } = setup(); await model.inspect(); await model.previewAction("prepare"); expect(model.getSnapshot().preview).not.toBeNull();
    model.setContext({ ...context, revisionDigest: "sha256:changed" }); expect(model.getSnapshot().preview).toBeNull();
  });
  it.each(["xiaohongshu", "x"] as const)("keeps %s selected through edit, save and reconnection while invalidating every old intent", async channel => {
    const { model, request, handoff } = setup(); model.selectChannel(channel); await model.inspect(); await model.previewAction("publish");
    expect(model.confirmationBlocked()).toBe(false);
    for (const next of [{ ...context, dirty: true }, { ...context, revisionDigest: "sha256:saved" }, { ...context, revisionDigest: "sha256:saved", connected: false }, { ...context, revisionDigest: "sha256:saved", generationId: "g2" }]) {
      model.setContext(next);
      expect(model.getSnapshot().channel).toBe(channel); expect(model.getSnapshot().preview).toBeNull(); expect(model.hasContext(next)).toBe(true); expect(model.confirmationBlocked()).toBe(true);
      await model.confirmPreview();
    }
    expect(handoff).not.toHaveBeenCalled(); expect(request.mock.calls.some(([input]) => input.operation === "channel_start_action")).toBe(false);
  });
  it.each(["dirty", "revision", "connection", "generation"])("renders no stale intent controls before the %s context update has committed", async change => {
    const { model, request, handoff } = setup(); model.selectChannel("x"); await model.inspect(); await model.previewAction("publish");
    const next = { ...context, ...(change === "dirty" ? { dirty: true } : change === "revision" ? { revisionDigest: "sha256:saved" } : change === "connection" ? { connected: false } : { generationId: "g2" }) };
    expect(model.confirmationBlocked()).toBe(false);
    const html = renderToStaticMarkup(createElement(ChannelActionsPanel, { model, view: model.getSnapshot(), context: next }));
    expect(html).toContain("正在切换到当前内容版本"); expect(html).not.toContain("<button"); expect(html).not.toContain("渠道操作预览");
    model.setContext(next); await model.confirmPreview();
    expect(model.getSnapshot().channel).toBe("x"); expect(model.confirmationBlocked()).toBe(true); expect(handoff).not.toHaveBeenCalled(); expect(request.mock.calls.some(([input]) => input.operation === "channel_start_action")).toBe(false);
  });
  it("treats equivalent context field ordering as unchanged so ordinary renders retain the current preview", async () => {
    const { model } = setup(); model.selectChannel("x"); await model.inspect(); await model.previewAction("publish");
    const reordered = { approvalAvailable: context.approvalAvailable, writable: context.writable, generationId: context.generationId, dirty: context.dirty, connected: context.connected, revisionDigest: context.revisionDigest, contentRef: context.contentRef };
    expect(model.hasContext(reordered)).toBe(true); model.setContext(reordered); expect(model.getSnapshot().preview).not.toBeNull(); expect(model.confirmationBlocked()).toBe(false);
  });
  it.each(["generation", "artifact", "content", "effect", "channel"])("rejects a preview with a mismatching %s", async field => {
    const bad = preview("zhihu", "publish");
    if (field === "generation") bad.intent.generationId = "old";
    if (field === "artifact") bad.intent.artifactDigest = "sha256:old";
    if (field === "content") bad.intent.contentRef = "wmc:other";
    if (field === "effect") bad.intent.sideEffect = "local_write";
    if (field === "channel") bad.intent.channel = "x";
    const { model, handoff } = setup(async input => input.operation === "channel_preview_action" ? bad : defaultResponse(input));
    await model.inspect(); await model.previewAction("publish"); await model.confirmPreview();
    expect(model.getSnapshot().preview).toBeNull(); expect(model.getSnapshot().error).toContain("不一致"); expect(handoff).not.toHaveBeenCalled();
  });
  it.each(["expired", "invalid_time", "gate", "blocking_codes"])("prevents confirming %s intent", async reason => {
    const blocked = preview("zhihu", "publish");
    if (reason === "expired") blocked.intent.expiresAt = "2020-01-01T00:00:00Z";
    if (reason === "invalid_time") blocked.intent.expiresAt = "invalid";
    if (reason === "gate") blocked.gates.status = "block";
    if (reason === "blocking_codes") blocked.intent.blockingGateCodes = ["CHANNEL_PERMISSION_UNKNOWN"];
    const { model, request, handoff } = setup(async input => input.operation === "channel_preview_action" ? blocked : defaultResponse(input));
    await model.inspect(); await model.previewAction("publish"); expect(model.confirmationBlocked()).toBe(true); await model.confirmPreview();
    expect(request.mock.calls.some(([value]) => value.operation === "channel_start_action")).toBe(false); expect(handoff).not.toHaveBeenCalled();
  });
  it("does not retry a write after an uncertain start, and does not expose raw errors", async () => {
    const { model, request } = setup(async input => { if (input.operation === "channel_start_action") throw new Error("private-token/private/path"); return defaultResponse(input); });
    await model.inspect(); await model.previewAction("prepare"); await model.confirmPreview(); await model.confirmPreview();
    expect(request.mock.calls.filter(([value]) => value.operation === "channel_start_action")).toHaveLength(1);
    expect(JSON.stringify(model.getSnapshot())).not.toContain("private-token"); expect(model.getSnapshot().error).toContain("不会自动重试");
  });
  it("disables dirty, disconnected, unsupported and unapproved operations with reasons", async () => {
    for (const patch of [{ dirty: true }, { connected: false }]) {
      const { model, request } = setup(defaultResponse, { ...context, ...patch }); await model.inspect(); await model.previewAction("publish"); expect(request).not.toHaveBeenCalled();
    }
    const { model } = setup(defaultResponse, { ...context, approvalAvailable: false }); await model.inspect(); expect(model.disabledReason("publish")).toContain("原生审批"); expect(model.disabledReason("prepare")).toBeNull();
    const unsupported = setup(async input => input.operation === "channel_inspect" ? inspection({ matrix: [] }) : defaultResponse(input)); await unsupported.model.inspect(); expect(unsupported.model.disabledReason("publish")).toContain("渠道连接");
  });
});

describe("public URL recovery and real job progress", () => {
  it("refreshes terminal job targets, keeps the selected work, and never regresses a terminal job to an older list result", async () => {
    let reads = 0;
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ targets: [target({ status: ++reads === 1 ? "draft" : "published", label: reads === 1 ? "知乎 · 平台草稿" : "知乎 · 已发表" })], jobs: [job()] }) : job({ status: "succeeded" }));
    await model.inspect(); model.setTarget("target:1"); await model.refreshJob("channeljob:1");
    expect(model.getSnapshot().targetRef).toBe("target:1"); expect(model.getSnapshot().inspection?.targets[0]?.status).toBe("published"); expect(model.getSnapshot().jobs[0]?.status).toBe("succeeded");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["channel_inspect", "get_job", "channel_inspect"]);
    const html = markup(model); expect(html).toContain("已发布并核对"); expect(html).toContain("核对时间"); expect(html).toContain('href="https://zhuanlan.zhihu.com/p/1234"');
  });
  it("shows a failed task honestly and retains prior target evidence when the following inspection fails", async () => {
    let reads = 0;
    const { model } = setup(async input => { if (input.operation === "channel_inspect") { if (++reads > 1) throw new Error("private-token/path"); return inspection({ targets: [target()], jobs: [job()] }); } return job({ status: "failed", resultCode: "CHANNEL_ACTION_FAILED", safeMessage: "任务未完成" }); });
    await model.inspect(); model.setTarget("target:1"); await model.refreshJob("channeljob:1");
    expect(model.getSnapshot().jobs[0]?.status).toBe("failed"); expect(model.getSnapshot().inspection?.targets[0]?.status).toBe("draft"); expect(model.getSnapshot().targetRef).toBe("target:1");
    expect(model.getSnapshot().error).toContain("作品列表暂未刷新"); expect(markup(model)).toContain("任务未完成"); expect(JSON.stringify(model.getSnapshot())).not.toContain("private-token");
  });
  it("clears a missing selection after a successful list refresh but preserves an explicit recovery URL", async () => {
    let reads = 0;
    const { model } = setup(async () => inspection({ targets: ++reads === 1 ? [target()] : [] }));
    await model.inspect(); model.setTarget("target:1"); await model.inspect();
    expect(model.getSnapshot().targetRef).toBe(""); expect(model.getSnapshot().notice).toContain("重新选择");
    model.setTargetUrl("https://zhuanlan.zhihu.com/p/1234"); await model.inspect(); expect(model.getSnapshot().targetUrl).toBe("https://zhuanlan.zhihu.com/p/1234");
  });
  it("suppresses a late terminal list refresh after the user changes channels", async () => {
    let reads = 0; const pending = deferred<WorkbenchValue>();
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? ++reads === 1 ? inspection({ jobs: [job()] }) : pending.promise : job({ status: "succeeded" }));
    await model.inspect(); const refreshing = model.refreshJob("channeljob:1"); await Promise.resolve(); await Promise.resolve();
    const signal = request.mock.calls.at(-1)?.[1]; model.selectChannel("x"); pending.resolve(inspection({ targets: [target()] })); await refreshing;
    expect(signal?.aborted).toBe(true); expect(model.getSnapshot().channel).toBe("x"); expect(model.getSnapshot().inspection?.targets).toEqual([]); expect(model.getSnapshot().error).toBeNull();
  });
  it("distinguishes local checks from online login failure, explains disabled publishing, and keeps local preparation usable", async () => {
    let available = false;
    const { model } = setup(async input => input.operation === "channel_preflight" ? { contentRef: context.contentRef, revisionDigest: context.revisionDigest, channel: "zhihu", configured: "configured", permission: available ? "available" : "missing", gates: { inputDigest: context.revisionDigest, status: available ? "pass" : "block", issues: [] } } as ChannelCheck : defaultResponse(input));
    await model.inspect(); await model.preflight(false); expect(markup(model)).toContain("本地检查不确认登录有效"); expect(model.disabledReason("publish")).toBeNull();
    await model.preflight(true); expect(markup(model)).toContain("在线账号检查"); expect(markup(model)).toContain("授权不可用"); expect(markup(model)).toContain('aria-label="操作限制"'); expect(model.disabledReason("publish")).toContain("重新核对"); expect(model.disabledReason("prepare")).toBeNull();
    available = true; await model.preflight(true); expect(model.disabledReason("publish")).toBeNull();
    model.selectChannel("x"); expect(model.getSnapshot().checkOnline).toBeNull(); expect(model.getSnapshot().checkedAt).toBeNull();
  });
  it("shows controlled local material references without turning paths or unsafe references into links", async () => {
    const ref = "write:.wemedia-channel-123/manual-stage.txt";
    const { model } = setup(async () => inspection({ jobs: [job({ status: "succeeded", artifactRefs: [ref, "write:../../private.txt", "/private/credentials.txt", "file:///private/data", "writeabc"] })] }));
    await model.inspect(); const html = markup(model);
    expect(html).toContain("本地材料位置"); expect(html).toContain(ref); expect(html).toContain("目录标识:相对路径"); expect(html).not.toContain("private"); expect(html).not.toContain("writeabc"); expect(html).not.toContain("href=");
  });
  it("accepts only exact public identifiers and rejects tokens, non-public URLs and partial IDs", () => {
    expect(publicChannelUrl("xiaohongshu", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567")).toBe("https://www.xiaohongshu.com/explore/0123456789abcdef01234567");
    expect(publicChannelUrl("zhihu", "https://zhuanlan.zhihu.com/p/1234")).toBe("https://zhuanlan.zhihu.com/p/1234");
    expect(publicChannelUrl("x", "https://x.com/name/status/1234")).toBe("https://x.com/name/status/1234");
    expect(publicChannelUrl("x", "https://x.com/i/web/status/1234")).toBe("https://x.com/i/web/status/1234");
    expect(publicChannelUrl("xiaohongshu", "https://www.xiaohongshu.com/discovery/item/0123456789abcdef01234567")).toBe("https://www.xiaohongshu.com/discovery/item/0123456789abcdef01234567");
    for (const url of ["https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=secret", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567#secret", "http://127.0.0.1/explore/0123456789abcdef01234567", "https://user:secret@www.xiaohongshu.com/explore/0123456789abcdef01234567", "https://evil.test/explore/0123456789abcdef01234567", "https://www.xiaohongshu.com/explore/0123"]) expect(publicChannelUrl("xiaohongshu", url)).toBeNull();
  });
  it("recovers an unconfirmed small-red-book result through an explicit public URL and a read-only start", async () => {
    const { model, request, handoff } = setup(); model.selectChannel("xiaohongshu"); await model.inspect();
    model.setTargetUrl("https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=secret"); await model.previewAction("sync");
    expect(request).toHaveBeenCalledTimes(1);
    model.setTargetUrl("https://www.xiaohongshu.com/explore/0123456789abcdef01234567"); await model.previewAction("sync");
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ operation: "channel_preview_action", action: "sync", targetUrl: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567" });
    await model.confirmPreview(); expect(handoff).not.toHaveBeenCalled(); expect(request.mock.calls.at(-1)?.[0].operation).toBe("channel_start_action");
    expect(JSON.stringify(request.mock.calls)).not.toContain("secret");
  });
  it("target edits discard previews, preventing confirmation of an earlier selected work", async () => {
    const { model } = setup(); await model.inspect(); model.setTarget("target:old"); await model.previewAction("sync");
    expect(model.getSnapshot().preview).not.toBeNull(); model.setTargetUrl("https://zhuanlan.zhihu.com/p/99"); expect(model.getSnapshot().preview).toBeNull(); expect(model.getSnapshot().targetRef).toBe("");
  });
  it("refreshes and cancels only known live jobs through the shared request protocol", async () => {
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: [job()] }) : input.operation === "get_job" ? job({ status: "running", progress: { current: 2, total: 3 } }) : input.operation === "cancel_job" ? job({ status: "reconcile_required", progress: { current: 2, total: 3 } }) : defaultResponse(input));
    await model.inspect(); await model.refreshJob("unknown"); expect(request).toHaveBeenCalledTimes(1);
    await model.refreshJob("channeljob:1"); expect(model.getSnapshot().jobs[0]?.progress.current).toBe(2);
    await model.cancelJob("channeljob:1"); expect(model.getSnapshot().jobs[0]?.status).toBe("reconcile_required"); await model.cancelJob("channeljob:1");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["channel_inspect", "get_job", "cancel_job", "channel_inspect"]);
    expect(markup(model)).toContain("避免重复发送"); expect(markup(model)).not.toContain("取消任务</button>");
  });
  it("reads a known persisted job from an earlier runtime without treating it as a new action", async () => {
    const historical = job({ generationId: "previous-runtime", status: "reconcile_required" });
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: [historical] }) : historical);
    await model.inspect(); await model.refreshJob(historical.jobId);
    expect(model.getSnapshot().error).toBeNull(); expect(model.getSnapshot().jobs[0]?.generationId).toBe("previous-runtime");
    expect(request.mock.calls.map(([value]) => value.operation)).toEqual(["channel_inspect", "get_job", "channel_inspect"]);
  });
  it("displays platform support, missing capability reasons, media evidence limits and approval handoff", async () => {
    const { model } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: [job({ channel: "xiaohongshu", action: "channel_sync", status: "succeeded" })], matrix: [...inspection().matrix, { channel: "csdn", publicationType: "image_text", action: "publish", status: "unsupported", reasonCode: "CHANNEL_TYPE_ACTION_UNSUPPORTED" }] }) : defaultResponse(input));
    model.selectChannel("xiaohongshu"); await model.inspect(); await model.previewAction("publish"); const html = markup(model);
    expect(html).toContain("多平台发布"); expect(html).toContain("CSDN"); expect(html).toContain("当前内容类型不支持此操作"); expect(html).toContain("交给当前 Agent 审批"); expect(html).toContain("账号/正文/媒体数量已核对，图片原字节未校验"); expect(html).toContain("公开作品链接");
  });
});

describe("bounded visible channel progress tracking", () => {
  afterEach(() => vi.useRealTimers());
  it("stops after ten reads per job without an idle timer, and tracks newly discovered jobs", async () => {
    vi.useFakeTimers(); let currentJobs = [job()];
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: currentJobs }) : job({ jobId: input.operation === "get_job" ? input.jobId : "channeljob:1" }));
    await model.inspect(); const stop = trackChannelJobs(model, () => true, () => () => {});
    await vi.advanceTimersByTimeAsync(22_000); expect(request.mock.calls.filter(([input]) => input.operation === "get_job")).toHaveLength(10); expect(vi.getTimerCount()).toBe(0);
    currentJobs = [job(), job({ jobId: "channeljob:2" })]; await model.inspect(); await vi.advanceTimersByTimeAsync(2_000);
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ operation: "get_job", jobId: "channeljob:2" }); stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses no timer while hidden, resumes when visible, and cancels all scheduling on cleanup", async () => {
    vi.useFakeTimers(); let visible = false, notifyVisibility = () => {};
    const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: [job()] }) : job());
    await model.inspect(); const removeVisibility = vi.fn(); const stop = trackChannelJobs(model, () => visible, listener => { notifyVisibility = listener; return removeVisibility; });
    expect(vi.getTimerCount()).toBe(0); visible = true; notifyVisibility(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000); expect(request.mock.calls.filter(([input]) => input.operation === "get_job")).toHaveLength(1);
    visible = false; notifyVisibility(); expect(vi.getTimerCount()).toBe(0); visible = true; notifyVisibility(); stop(); model.disconnect(); await vi.advanceTimersByTimeAsync(20_000);
    expect(request.mock.calls.filter(([input]) => input.operation === "get_job")).toHaveLength(1); expect(removeVisibility).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops polling when the task finishes and refreshes its targets exactly once", async () => {
    vi.useFakeTimers(); const { model, request } = setup(async input => input.operation === "channel_inspect" ? inspection({ jobs: [job()] }) : job({ status: "succeeded" }));
    await model.inspect(); const stop = trackChannelJobs(model, () => true, () => () => {}); await vi.advanceTimersByTimeAsync(20_000);
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["channel_inspect", "get_job", "channel_inspect"]); expect(vi.getTimerCount()).toBe(0); stop();
  });
});

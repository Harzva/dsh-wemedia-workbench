import { useId, useState, type ReactNode } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { GateIssue, GateReport } from "../domain/capability.ts";
import type { WorkbenchJob } from "../domain/workbench.ts";
import { terminalJob, type ClientState, type WorkbenchController } from "./controller.ts";
import { articleReviewsModel } from "./evidence-model.ts";
import { displayTime, statusLabel } from "./presentation.ts";
import { wechatDraftGuideStyles } from "./wechat-draft-guide-styles.ts";

export interface WechatDraftGuideProps {
  controller: WorkbenchController;
  state: ClientState;
  targetRef: string;
  setTargetRef: (value: string) => void;
  onReviews: () => void;
  onImportDraft: () => void;
  onEdit: () => void;
}

type DraftMode = "choose" | "create" | "update";
const buttonClass = "wm-native-button";
const actionNames: Record<string, string> = { create_draft: "新增微信草稿", update_draft: "更新微信草稿", sync: "只读核对草稿" };
const jobMessages: Record<WorkbenchJob["status"], string> = {
  queued: "任务已排队，尚未完成草稿操作。",
  running: "正在处理，请等待本次结果，避免重复提交。",
  waiting_user: "请回到当前 DSH 会话处理原生审批；审批前不会写入草稿。",
  succeeded: "本次任务已完成。草稿是否对应当前文章，以所选目标的版本核验为准。",
  failed: "本次任务失败，不能视为草稿已保存。请查看任务详情后处理原因。",
  cancelled: "本次任务已取消，不能据此认定草稿已保存。",
  timed_out: "本次任务超时，请先核对任务与草稿结果。",
  reconcile_required: "远端结果尚未确认。请先只读核对已有草稿，避免重复新增；工作台不会自动重试。",
};

function gateMessage(issue: GateIssue): string {
  const labels: Record<string, string> = { FACTS: "资料与事实", EDITORIAL: "中文编辑", IMAGES_FORMULAS: "原图与公式", MOBILE_VISUAL: "390px 移动视觉" };
  if (issue.code.startsWith("REVIEW_")) {
    const label = labels[issue.code.slice(7)];
    if (label) return `${label}：${issue.status === "pass" ? "已有当前版本的有效审阅记录" : "需要当前版本的有效审阅记录"}`;
  }
  if (issue.code.startsWith("COVERAGE_")) {
    const label = labels[issue.code.slice(9)];
    if (label) return `${label}：${issue.status === "pass" ? "逐项覆盖记录已齐备" : "逐项覆盖记录尚未齐备"}`;
  }
  if (issue.code === "ARTICLE_ASSETS_RESOLVED") return issue.status === "pass" ? "文章图片均可读取并属于当前版本" : "请处理文章中无法读取或版本不符的图片";
  return issue.safeMessage;
}

function CheckReport({ report }: { report: GateReport }): ReactNode {
  const unresolved = report.issues.filter(issue => issue.status !== "pass");
  return <div className="wm-wechat-guide-check" data-status={report.status}>
    <strong>{report.status === "block" ? "检查发现待处理项" : report.status === "warn" ? "检查完成，有提醒需确认" : "发布前检查通过"}</strong>
    {!!unresolved.length && <ul>{unresolved.map((issue, index) => <li key={`${issue.code}-${index}`}><span className="wm-pill" data-status={issue.status}>{statusLabel(issue.status)}</span> {gateMessage(issue)}</li>)}</ul>}
    <details className="wm-small"><summary>查看全部检查与记录</summary><ul>{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><span>{statusLabel(issue.status)} · {gateMessage(issue)}</span><br /><code>{issue.code}</code></li>)}</ul><p className="wm-code">检查版本：{report.inputDigest}</p></details>
  </div>;
}

/** Presentation only: all operations still use the existing preview and approval flow. */
export function WechatDraftGuide({ controller, state, targetRef, setTargetRef, onReviews, onImportDraft, onEdit }: WechatDraftGuideProps): ReactNode {
  const id = useId();
  const document = state.document;
  const [selection, setSelection] = useState<{ contentRef: string | null; mode: DraftMode }>({ contentRef: null, mode: "choose" });
  if (!document) return null;

  // A different article always requires a new decision when it already has targets.
  const mode = selection.contentRef === document.contentRef ? selection.mode : document.targets.length ? "choose" : "create";
  const target = document.targets.find(candidate => candidate.targetRef === targetRef) ?? null;
  const dirty = controller.dirty;
  const pending = (key: string): boolean => state.pending.includes(key);
  const busy = ["mutation", "action-preview", "article", "wechat-result", "workflow-import-apply"].some(pending);
  const checkBusy = pending("preflight");
  const jobs = (state.snapshot?.jobs ?? []).filter(job => job.contentRef === document.contentRef && job.channel === "wechat" && Object.hasOwn(actionNames, job.action))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = jobs[0] ?? null;
  const activeJob = jobs.some(job => !terminalJob(job));
  const uncertain = jobs.some(job => job.status === "reconcile_required");
  const settings = state.snapshot?.settings;
  const commonReason = !state.connected ? "连接已断开，请恢复工作台连接后继续。"
    : dirty ? "当前修改还未保存。请先保存文章，再检查和操作草稿。"
    : busy ? "正在处理当前文章，请等待本次操作完成。" : "";
  const writeReason = commonReason || (checkBusy ? "正在检查，请等待检查结果。"
    : activeJob ? "已有微信任务正在处理，请先等待并核对结果。"
    : uncertain && mode === "create" ? "存在结果未确认的任务记录，请先只读核对；暂不能重复新增草稿。"
    : settings?.approvalAvailable === false ? "原生审批服务暂不可用，请在设置中检查后继续。"
    : mode === "choose" ? "请选择本次要新增草稿，还是更新已有草稿。"
    : mode === "update" && !target ? "请选择本次要更新的具体草稿。" : "");
  const readDisabled = Boolean(commonReason) || checkBusy || activeJob;
  const reviews = articleReviewsModel(document).categories;
  const currentReviewCount = reviews.filter(category => category.currentCount > 0).length;
  const report = !dirty && state.gates?.inputDigest === document.revisionDigest ? state.gates : null;
  const verified = Boolean(target && !dirty && target.verifiedRevision === document.revisionDigest && target.verifiedAt && Number.isFinite(Date.parse(target.verifiedAt)));
  const setMode = (next: Exclude<DraftMode, "choose">): void => {
    setSelection({ contentRef: document.contentRef, mode: next });
    if (next === "create") setTargetRef("");
  };
  const submit = (): void => {
    if (writeReason) return;
    if (mode === "create") void controller.previewAction("create_draft");
    else if (mode === "update" && target) void controller.previewAction("update_draft", target.targetRef);
  };

  return <section className="wm-wechat-guide" aria-labelledby={`${id}-title`}>
    <style>{wechatDraftGuideStyles}</style>
    <header className="wm-wechat-guide-heading"><div><span className="wm-eyebrow">微信公众号</span><h3 id={`${id}-title`}>把文章存进微信草稿箱</h3><p>保存文章 → 检查内容 → 确认本次草稿操作</p></div><span className="wm-pill">微信草稿 ≠ 正式发布</span></header>
    {!state.connected && <p className="wm-wechat-guide-notice" role="status">连接已断开。下方保留上次读取的记录，暂不能确认最新状态或提交操作。</p>}
    {state.notice?.kind === "error" && <div className="wm-wechat-guide-notice wm-error" role="alert"><p>{state.notice.text}</p>{state.notice.code && <details className="wm-small"><summary>错误代码</summary><code>{state.notice.code}</code></details>}</div>}

    <ol className="wm-wechat-guide-steps">
      <li className="wm-wechat-guide-step"><span className="wm-wechat-guide-number" aria-hidden="true">1</span><div className="wm-wechat-guide-step-body">
        <div className="wm-wechat-guide-step-heading"><h4>保存文章</h4><span className="wm-pill" data-status={dirty ? "warn" : undefined}>{dirty ? "待保存" : "文章已保存"}</span></div>
        <p className="wm-small wm-muted">{dirty ? "当前有未保存修改，草稿操作只使用已保存版本。" : "后续检查和草稿操作使用这份已保存的文章。"}</p>
        <div className="wm-row">{dirty && <Button className={buttonClass} size="sm" variant="primary" disabled={!state.connected || busy || settings?.hasWriteRoot === false} onClick={() => void controller.previewAction("save_revision")}>保存文章</Button>}<Button className={buttonClass} size="sm" variant="outline" disabled={busy} onClick={onEdit}>{dirty ? "返回编辑" : "查看文章"}</Button></div>
        {dirty && settings?.hasWriteRoot === false && <p className="wm-small wm-error">尚未配置可写目录，请先在工作台设置中完成配置。</p>}
      </div></li>

      <li className="wm-wechat-guide-step"><span className="wm-wechat-guide-number" aria-hidden="true">2</span><div className="wm-wechat-guide-step-body">
        <div className="wm-wechat-guide-step-heading"><h4>发布前检查</h4><span className="wm-small wm-muted">{currentReviewCount}/4 类有当前版本记录{dirty ? "（已保存版本）" : ""}</span></div>
        <ul className="wm-wechat-guide-reviews">{reviews.map(category => {
          const covered = document.reviews.some(review => review.kind === category.kind && review.valid && review.revisionDigest === document.revisionDigest && review.coverage?.complete);
          return <li key={category.kind}><strong>{category.label}</strong><span>{category.currentCount ? category.kind !== "mobile_visual" && !covered ? "已有记录 · 待补逐项覆盖" : "已有当前版本记录" : category.staleCount ? "历史记录需重审" : "待审阅"}</span></li>;
        })}</ul>
        <p className="wm-small wm-muted">有效记录不等于全文审阅通过。检查会核对素材、版本与覆盖情况，不能代替实际审阅。</p>
        <div className="wm-row"><Button className={buttonClass} size="sm" variant="outline" disabled={Boolean(commonReason) || checkBusy} onClick={() => void controller.preflight()}>{checkBusy ? "正在检查…" : "运行发布前检查"}</Button><Button className={buttonClass} size="sm" variant="toolbar" disabled={busy} onClick={onReviews}>查看 / 补齐审阅</Button></div>
        {report ? <CheckReport report={report} /> : <p className="wm-small wm-muted">{dirty ? "保存后重新检查；此前的报告不代表当前修改已通过。" : "尚无当前版本的检查结果。下方草稿操作也会先重新检查。"}</p>}
      </div></li>

      <li className="wm-wechat-guide-step"><span className="wm-wechat-guide-number" aria-hidden="true">3</span><div className="wm-wechat-guide-step-body">
        <h4>存公众号草稿</h4>
        {document.targets.length > 0 ? <fieldset className="wm-wechat-guide-mode" disabled={busy || activeJob}><legend>本次草稿操作</legend><label><input type="radio" name={`${id}-mode`} value="create" checked={mode === "create"} onChange={() => setMode("create")} /><span><strong>新增一份草稿</strong><small>会创建新的草稿记录</small></span></label><label><input type="radio" name={`${id}-mode`} value="update" checked={mode === "update"} onChange={() => setMode("update")} /><span><strong>更新已有草稿</strong><small>先选择要替换内容的目标</small></span></label></fieldset> : <p className="wm-small wm-muted">当前没有绑定草稿。本次将新增一份微信草稿。</p>}
        {document.targets.length > 0 && <div className="wm-wechat-guide-target"><label>{mode === "update" ? "选择要更新的草稿" : "已有草稿（仅供核对）"}<select value={target?.targetRef ?? ""} disabled={busy || activeJob} onChange={event => setTargetRef(event.target.value)}><option value="">请选择具体草稿</option>{document.targets.map(candidate => <option key={candidate.targetRef} value={candidate.targetRef}>{candidate.label} · {candidate.title}</option>)}</select></label>
          {target && <div className="wm-small"><p className={verified && state.connected && !uncertain ? "wm-wechat-guide-verified" : "wm-muted"}>{verified ? `${state.connected ? "所选草稿已核验" : "上次核验记录"}：与当前已保存版本一致。` : "所选草稿尚未核验为当前文章版本，请先只读核对。"}</p>{verified && <p className="wm-muted">核验时间：{displayTime(target.verifiedAt)}</p>}</div>}
          <Button className={buttonClass} size="sm" variant="outline" disabled={readDisabled || !target} onClick={() => { if (target) void controller.previewAction("sync", target.targetRef); }}>只读核对所选草稿</Button>
        </div>}
        <div className="wm-wechat-guide-submit"><Button className={`${buttonClass} wm-wechat-guide-primary`} variant="primary" disabled={Boolean(writeReason)} aria-describedby={writeReason ? `${id}-disabled` : `${id}-approval`} onClick={submit}>{pending("action-preview") ? "正在检查并生成预览…" : mode === "update" ? "检查并更新所选草稿" : mode === "choose" ? "请先选择草稿操作" : "检查并新增微信草稿"}</Button>
          {writeReason && <p id={`${id}-disabled`} className="wm-small wm-muted" role="status">{writeReason}</p>}
          <p id={`${id}-approval`} className="wm-small wm-muted">先查看检查结果和操作预览，再交给当前 Agent 请求 DSH 原生审批。排队、审批和草稿写入是不同阶段。</p>
        </div>

        {latest && <section className="wm-wechat-guide-result" aria-label="最近一次微信草稿任务" aria-live="polite"><div className="wm-wechat-guide-step-heading"><strong>{actionNames[latest.action]} · {statusLabel(latest.status)}</strong><span className="wm-small wm-muted">{displayTime(latest.createdAt)}</span></div><p>{jobMessages[latest.status]}</p><div className="wm-row"><Button className={buttonClass} size="sm" variant="outline" disabled={!state.connected || pending(`job-read:${latest.jobId}`)} onClick={() => void controller.refreshJob(latest.jobId)}>刷新任务状态</Button><Button className={buttonClass} size="sm" variant="toolbar" onClick={() => controller.navigate("jobs")}>查看任务详情</Button></div><details className="wm-small"><summary>任务记录</summary><dl><dt>任务 ID</dt><dd>{latest.jobId}</dd><dt>意图 ID</dt><dd>{latest.intentId}</dd>{latest.resultCode && <><dt>结果代码</dt><dd>{latest.resultCode}</dd></>}</dl></details></section>}
        {uncertain && latest?.status !== "reconcile_required" && <p className="wm-wechat-guide-notice" role="status">仍保留较早的结果未确认任务记录。请结合所选草稿的核验记录，在任务中心查看；不要重复新增。</p>}
        <details className="wm-wechat-guide-advanced"><summary>已有草稿导入与本地材料</summary><div className="wm-wechat-guide-advanced-body"><p className="wm-small wm-muted">已有外部草稿需从原摘要导入并核对身份；不会按文章标题猜测或覆盖目标。</p><div className="wm-row"><Button className={buttonClass} size="sm" variant="outline" disabled={Boolean(commonReason) || activeJob} onClick={onImportDraft}>导入已有草稿目标</Button><Button className={buttonClass} size="sm" variant="outline" disabled={Boolean(commonReason) || checkBusy || settings?.hasWriteRoot === false} onClick={() => void controller.previewAction("prepare")}>预览本地材料准备</Button></div><p className="wm-small wm-muted">本地材料准备会生成本地文件，不会上传公众号。</p><dl className="wm-small"><dt>当前保存版本</dt><dd>{document.revisionDigest}</dd>{target && <><dt>所选草稿引用</dt><dd>{target.targetRef}</dd><dt>已核验版本</dt><dd>{target.verifiedRevision || "尚未核验"}</dd></>}</dl></div></details>
      </div></li>
    </ol>
  </section>;
}

import { htmlImageSources } from "../domain/wechatDocument.ts";
import type { DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ArticleDocument, ArticleEdit, WorkbenchAction, WorkbenchJob } from "../domain/workbench.ts";

export const actionLabels: Record<WorkbenchAction, string> = {
  save_revision: "保存新版本", prepare: "准备本地材料", create_draft: "创建公众号草稿", update_draft: "更新指定草稿", sync: "只读核对草稿",
};
const labels: Record<string, string> = {
  queued: "排队中", running: "执行中", waiting_user: "等待原生审批", succeeded: "已完成", failed: "失败", cancelled: "已取消", timed_out: "已超时", reconcile_required: "需要核对结果",
  discovered: "已发现", drafting: "撰写中", needs_review: "待审阅", ready: "已就绪", draft_verified: "草稿已核对", needs_revalidation: "需要重新验证",
  pass: "通过", warn: "提醒", block: "阻断", available: "可用", unavailable: "不可用", unsupported: "不支持", degraded: "受限", approval_required: "需要审批", configured: "已配置", missing: "未配置", invalid: "配置无效", unknown: "未知",
};
export const statusLabel = (value: string): string => Object.hasOwn(labels, value) ? labels[value]! : value;
export const shortId = (value: string): string => value.length > 24 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
export const displayTime = (value: string): string => Number.isNaN(Date.parse(value)) ? "时间未知" : new Date(value).toLocaleString();
export const attentionJob = (job: WorkbenchJob): boolean => ["failed", "timed_out", "reconcile_required", "waiting_user"].includes(job.status);

/** Reuse DSH's native before/after renderer, not another diff or patch engine. */
export function editDiffs(document: ArticleDocument, edit: ArticleEdit): DiffHunk[] {
  const metadataLabels = { title: "标题", digest: "纯文本摘要", author: "作者", articleId: "文章 ID", kind: "内容类型", titlePrefix: "标题前缀", sourceUrl: "来源 URL", pdfUrl: "PDF URL", codeUrl: "代码 URL" } as const;
  const diffs: DiffHunk[] = [];
  for (const key of Object.keys(metadataLabels) as Array<keyof typeof metadataLabels>) {
    if (document.metadata[key] !== edit.metadata[key]) diffs.push({ path: metadataLabels[key], oldText: document.metadata[key], newText: edit.metadata[key] });
  }
  if (document.html !== edit.html) diffs.push({ path: "正文 HTML", oldText: document.html, newText: edit.html });
  if (document.markdown !== edit.markdown) diffs.push({ path: "Markdown", oldText: document.markdown, newText: edit.markdown });
  const before = htmlImageSources(document.html ?? ""), after = htmlImageSources(edit.html ?? "");
  const removed = before.filter(source => !after.includes(source)), added = after.filter(source => !before.includes(source));
  if (removed.length || added.length) diffs.push({ path: "素材引用增删", oldText: removed.map(source => `移除 ${source}`).join("\n"), newText: added.map(source => `新增 ${source}`).join("\n") });
  return diffs;
}

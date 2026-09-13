import type { ReactNode } from "react";
import type { GateReport } from "../domain/capability.ts";
import type { AiWorkflowResult, ArticleDocument } from "../domain/workbench.ts";
import { aiWorkflowModel, articleMaterialsModel, articleReviewsModel, documentIssueView, gateStatusLabel, workflowMaterialsModel } from "./evidence-model.ts";

export function ArticleMaterials({ document }: { document: ArticleDocument }): ReactNode {
  const materials = articleMaterialsModel(document);
  return <section className="wm-card wm-stack wm-materials" aria-label="来源与素材">
    <div><h3 className="wm-section-title">来源与素材</h3><p className="wm-small wm-muted">查看文章已有的来源记录与本地材料。链接由你主动打开，工作台不会自动加载外部图片。</p></div>
    <dl className="wm-facts-grid">
      <div><dt>作者</dt><dd>{materials.author}</dd></div>
      <div><dt>文章类型</dt><dd>{materials.kind}</dd></div>
      {materials.sources.map(source => <div key={source.label}><dt>{source.label}</dt><dd>{source.href
        ? <a href={source.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.description}<span className="wm-small"> · 新窗口打开</span></a>
        : <span className="wm-small wm-muted">{source.description}</span>}</dd></div>)}
    </dl>
    <div><p className="wm-small">{materials.sourceNote}</p><details className="wm-small"><summary>来源文件引用</summary><dl className="wm-evidence-meta"><div><dt>文章文档</dt><dd className="wm-code">{materials.sourceArtifact}</dd></div><div><dt>正文文件</dt><dd className="wm-code">{materials.htmlArtifact}</dd></div></dl></details></div>
    <div className="wm-row wm-between"><h4>文章素材</h4><span className="wm-pill">{materials.assets.length} 项已解析</span></div>
    {materials.assets.length ? <ul className="wm-material-list">{materials.assets.map((asset, index) => <li key={`${asset.artifact}-${index}`} className="wm-material-item wm-stack">
      <div className="wm-row wm-between"><strong>{asset.name}</strong><span className="wm-pill">{asset.kind}</span></div>
      <p className="wm-small wm-muted">{asset.mediaType} · {asset.size}</p>
      <p className="wm-code">{asset.artifact}</p>
      <details className="wm-small"><summary>查看素材 SHA</summary><p className="wm-code">{asset.digest || "未记录摘要"}</p></details>
    </li>)}</ul> : <p className="wm-muted" role="status">暂无已解析素材。未列出素材不代表图片已核验，请结合文章问题和正文检查。</p>}
    <p className="wm-small wm-muted">素材类别仅展示已有标注，不根据文件名推断原图或公式。在下方覆盖记录中打开报告，可查看已登记的逐条事实、页码/图号、原图出处与公式源码；有来源链接不代表事实已核验。</p>
  </section>;
}

export function ArticleReviews({ document, onReadEvidence, report, onPreflight, onAgent, busy, aiWorkflow = null, onAiInspect, onAiPreview, aiBusy = false, aiDisabled = false, onImportReview, importBusy = false }: {
  document: ArticleDocument;
  onReadEvidence?: (id: string) => void;
  report: GateReport | null;
  onPreflight: () => void;
  onAgent: () => void;
  busy: boolean;
  aiWorkflow?: AiWorkflowResult | null;
  onAiInspect?: () => void;
  onAiPreview?: () => void;
  aiBusy?: boolean;
  aiDisabled?: boolean;
  onImportReview?: () => void;
  importBusy?: boolean;
}): ReactNode {
  const reviews = articleReviewsModel(document);
  const issues = document.issues.map(documentIssueView);
  const ai = aiWorkflowModel(aiWorkflow);
  return <section className="wm-card wm-stack" aria-label="审读证据与机械校验">
    <div><h3 className="wm-section-title">审读证据与机械校验</h3><p className="wm-small wm-muted">机械检查不替代事实、中文、原图/公式和实际移动视觉审阅。有效记录只表示与当前版本匹配，不表示全文覆盖或内容质量自动通过。</p></div>
    <section className="wm-ai-diagnostic wm-stack" aria-label="AI 原生诊断"><div className="wm-row wm-between"><div><h4>AI 原生诊断</h4><p className="wm-small wm-muted">复用既有 AI 检查与预览入口；结果独立于四类审阅和最终图像验收。</p></div><div className="wm-row"><button type="button" disabled={aiDisabled || aiBusy || !onAiInspect} onClick={onAiInspect}>{aiBusy ? "处理中…" : "AI 检查"}</button><button type="button" disabled={aiDisabled || aiBusy || !onAiPreview} onClick={onAiPreview}>AI 预览</button></div></div>{ai ? <div className="wm-stack"><div className="wm-row wm-between"><span className="wm-pill" data-status={ai.status}>{ai.statusLabel}</span><span className="wm-small wm-muted">{ai.operationLabel} · {ai.sourceKindLabel} · {ai.previewFidelityLabel}</span></div><p className="wm-small wm-muted">诊断版本：<span className="wm-code">{ai.revisionDigest}</span></p>{ai.issues.length ? <ul className="wm-gate-list">{ai.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><span className="wm-pill" data-status={issue.status}>{gateStatusLabel(issue.status)}</span> {issue.message}<details className="wm-small"><summary>问题代码</summary><code>{issue.code}</code></details></li>)}</ul> : <p className="wm-small wm-muted">本次 AI 诊断未返回问题项。</p>}<p className="wm-small wm-muted">{ai.note}</p></div> : <p className="wm-small wm-muted" role="status">尚无 AI 原生诊断结果。运行后只展示诊断状态，不会自动写入审阅记录。</p>}</section>
    <div className="wm-review-summary">{reviews.categories.map(category => <div key={category.kind} data-review-state={category.currentCount ? "current" : "pending"}>
      <h4>{category.label}</h4><p><span className="wm-pill">{category.currentCount ? `当前版本有效记录 ${category.currentCount} 份` : "待审阅"}</span></p>
      <p className="wm-small wm-muted">{category.currentCount ? "可在下方查看记录摘要与产物引用。" : "尚无当前版本有效记录。"}{category.staleCount > 0 ? ` 另有 ${category.staleCount} 份历史记录需要重审。` : ""}</p>
    </div>)}</div>
    <div><div className="wm-row wm-between"><h4>审读记录</h4>{onImportReview && <button type="button" disabled={importBusy || aiDisabled} onClick={onImportReview}>{importBusy ? "处理中…" : "导入旧报告"}</button>}</div>{reviews.records.length ? <ul className="wm-review-list">{reviews.records.map((review, index) => <li key={`${review.id}-${index}`} className="wm-review-item wm-stack">
      <div className="wm-row wm-between"><strong>{review.category}</strong><span className="wm-pill">{review.current ? "当前版本有效记录" : "需要重审"}</span></div>
      <p>{review.summary}</p>{onReadEvidence && <button type="button" disabled={aiDisabled} onClick={() => onReadEvidence(review.id)}>阅读报告或截图详情</button>}
      {!review.current && <p className="wm-small wm-muted">与当前版本不匹配，需要重审。</p>}
      <dl className="wm-evidence-meta"><div><dt>记录者</dt><dd>{review.reviewer}</dd></div><div><dt>记录时间</dt><dd>{review.recordedAt}</dd></div><div><dt>产物引用</dt><dd className="wm-code">{review.artifact}</dd></div></dl>
      <details className="wm-small"><summary>查看绑定版本与产物 SHA</summary><dl className="wm-evidence-meta"><div><dt>内容版本</dt><dd className="wm-code">{review.revisionDigest}</dd></div><div><dt>审读产物 SHA</dt><dd className="wm-code">{review.artifactDigest}</dd></div></dl></details>
    </li>)}</ul> : <p className="wm-muted" role="status">暂无审读记录。可以交给当前 Agent 审阅文章，并提交绑定当前版本的真实材料。</p>}
      <p className="wm-small wm-muted">打开详情可阅读真实报告和截图；未登记的正文或覆盖信息会明确提示，不根据摘要推断审读范围。</p>
    </div>
    <WorkflowImports document={document} {...(onReadEvidence ? { onReadEvidence } : {})} disabled={aiDisabled} />
    {issues.length > 0 && <div><h4>文章材料待处理</h4><ul className="wm-gate-list">{issues.map((issue, index) => <li key={index}><p>{issue.message}</p>{issue.code && <details className="wm-small"><summary>问题代码</summary><p className="wm-code">{issue.code}</p></details>}</li>)}</ul></div>}
    <div aria-busy={busy}><div className="wm-row wm-between"><h4>机械校验</h4><button type="button" disabled={busy} onClick={onPreflight}>{busy ? "正在校验…" : "运行机械校验"}</button></div>
      {report ? <div><p><span className="wm-pill">机械校验：{gateStatusLabel(report.status)}</span></p>{report.issues.length ? <ul className="wm-gate-list">{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
        <p><span className="wm-pill">{gateStatusLabel(issue.status)}</span> {issue.safeMessage}</p><details className="wm-small"><summary>检查代码与版本</summary><dl className="wm-evidence-meta"><div><dt>问题代码</dt><dd className="wm-code">{issue.code}</dd></div><div><dt>检查项</dt><dd className="wm-code">{issue.gateId} · {issue.version}</dd></div><div><dt>检查输入</dt><dd className="wm-code">{issue.inputDigest}</dd></div></dl></details>
      </li>)}</ul> : <p className="wm-small wm-muted">报告未返回逐项校验明细。</p>}<details className="wm-small"><summary>本次校验输入摘要</summary><p className="wm-code">{report.inputDigest}</p></details></div>
        : <p className="wm-small wm-muted">尚无机械校验报告。运行后查看检查结果，再结合内容审读记录判断下一步。</p>}
    </div>
    <div className="wm-row"><button type="button" onClick={onAgent}>进入 Agent 审阅</button><span className="wm-small wm-muted">研究、审读与材料提交使用当前 DSH 会话。</span></div>
  </section>;
}

export function WorkflowImports({ document, onReadEvidence, disabled = false }: { document: ArticleDocument; onReadEvidence?: (id: string) => void; disabled?: boolean }): ReactNode {
  const materials = workflowMaterialsModel(document);
  return <section className="wm-workflow-imports wm-stack" aria-label="已导入工作流材料"><div><h4>已导入工作流材料</h4><p className="wm-small wm-muted">导入材料不会自动补齐四类审阅；仅当前版本且格式受支持的原生报告，在确认后记录到对应审阅项。</p></div>{materials.length ? <ul className="wm-review-list">{materials.map(material => <li key={material.id} className="wm-review-item wm-stack"><div className="wm-row wm-between"><strong>{material.kindLabel}</strong><span className="wm-pill" data-status={material.status}>{material.statusLabel}</span></div><p>{material.title}</p>{onReadEvidence && <button type="button" disabled={disabled} onClick={() => onReadEvidence(material.id)}>阅读材料详情</button>}<p className="wm-small wm-muted">来源：<span className="wm-code">{material.source}</span> · 格式：{material.sourceFormat}</p><p className="wm-small wm-muted">{material.statusNote} {material.currentRevision ? "当前版本匹配。" : material.boundRevision.trim() ? "记录绑定版本与当前版本不一致。" : "未绑定完整文章版本；仅保留已有的来源或 HTML 匹配信息。"}</p><details className="wm-small"><summary>查看版本绑定</summary><dl className="wm-evidence-meta"><div><dt>绑定文章版本</dt><dd className="wm-code">{material.boundRevision || "未记录"}</dd></div><div><dt>绑定 HTML 摘要</dt><dd className="wm-code">{material.boundHtmlDigest || "未记录"}</dd></div><div><dt>记录时间</dt><dd>{material.recordedAt}</dd></div></dl></details>{material.findings.length > 0 && <div><p className="wm-small"><strong>发现</strong></p><ul className="wm-gate-list">{material.findings.map((finding, index) => <li key={`finding-${index}`}>{finding}</li>)}</ul></div>}{material.warnings.length > 0 && <div><p className="wm-small"><strong>警告</strong></p><ul className="wm-gate-list">{material.warnings.map((warning, index) => <li key={`warning-${index}`}><span className="wm-pill" data-status="warn">提醒</span> {warning}</li>)}</ul></div>}</li>)}</ul> : <p className="wm-small wm-muted" role="status">尚无导入材料。导入前先预览并确认来源与版本绑定。</p>}</section>;
}

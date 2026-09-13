import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, DiffBlock, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ArticleDocument } from "../domain/workbench.ts";
import type { ReviewDetails } from "../domain/inspection.ts";
import type { ClientState, WorkbenchController } from "./controller.ts";
import { useDialogFocus } from "./interactions.ts";
import { displayTime, shortId } from "./presentation.ts";
import { workbenchStyles } from "./styles.ts";

const btn = "wm-native-button";

export function VersionHistoryView({ state, controller }: { state: ClientState; controller: WorkbenchController }): ReactNode {
  const [fromId, setFrom] = useState(""); const [toId, setTo] = useState("");
  useEffect(() => {
    const available = state.history?.versions.filter(item => item.available) ?? [];
    setFrom(available[1]?.id ?? available[0]?.id ?? ""); setTo(available[0]?.id ?? "");
  }, [state.history]);
  const pending = state.pending.includes("history") || state.pending.includes("comparison");
  const readTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pending) return;
    const trigger = readTrigger.current; readTrigger.current = null;
    if (trigger?.isConnected && document.activeElement === document.body) trigger.focus();
  }, [pending]);
  const comparison = state.comparison?.from.id === fromId && state.comparison.to.id === toId ? state.comparison : null;
  return <section className="wm-card wm-stack" aria-label="版本历史与比较" aria-busy={pending}>
    <div className="wm-row wm-between"><div><h3>版本历史</h3><p className="wm-small wm-muted">比较两次保存的正文、公开信息与素材。历史文件发生变化时，会明确标记为不可用。</p></div><Button className={btn} disabled={pending || controller.dirty} onClick={event => { readTrigger.current = event.currentTarget; void controller.loadHistory(); }}>{pending ? "正在读取…" : "读取版本历史"}</Button></div>
    {controller.dirty && <p className="wm-inline-note">请先保存或放弃当前修改，再比较已保存版本。</p>}
    {!state.history ? <p role="status">尚未读取历史。首次启用历史索引前的文件不会自动认领。</p> : <>
      <div className="wm-grid">{(["from", "to"] as const).map(side => <label key={side}>{side === "from" ? "较早版本" : "对比版本"}<select disabled={pending} value={side === "from" ? fromId : toId} onChange={event => side === "from" ? setFrom(event.target.value) : setTo(event.target.value)}>{state.history!.versions.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.current ? "当前 · " : ""}{item.title} · {displayTime(item.recordedAt)} · {shortId(item.id)}{item.available ? "" : " · 文件已变化或缺失"}</option>)}</select></label>)}</div>
      <Button className={btn} variant="outline" disabled={pending || controller.dirty || !fromId || !toId} onClick={event => { readTrigger.current = event.currentTarget; void controller.compareVersions(fromId, toId); }}>比较所选版本</Button>
      {comparison && <div className="wm-stack" aria-live="polite"><h4>版本差异</h4>{comparison.fields.length ? <DiffBlock diffs={comparison.fields} maxLines={32} className="wm-native-diff" /> : <p>公开信息、正文与 Markdown 相同。</p>}<h4>素材变化 · {comparison.assets.length} 项</h4>{comparison.assets.length ? <ul className="wm-material-list">{comparison.assets.map((asset, index) => <li key={index} className="wm-material-item"><strong>{({ added: "新增", removed: "移除", changed: "内容变化" })[asset.change]}</strong><p className="wm-code">{asset.before?.source ?? "无"} → {asset.after?.source ?? "无"}</p><details><summary>比较素材摘要</summary><p className="wm-code">{asset.before?.digest ?? "无"}<br />{asset.after?.digest ?? "无"}</p></details></li>)}</ul> : <p>素材字节无增删或变化；版本目录内的复制重命名已按摘要匹配。</p>}</div>}
      {state.history.notes.map(note => <p key={note} className="wm-small wm-muted">{note}</p>)}
    </>}
  </section>;
}

export function CoverageSummary({ document, onRead, disabled }: { document: ArticleDocument; onRead: (id: string) => void; disabled: boolean }): ReactNode {
  return <section className="wm-card wm-stack" aria-label="来源与覆盖记录"><h3>来源与覆盖记录</h3><p className="wm-small wm-muted">覆盖统计针对本版本的可定位正文块与素材，表示审阅者已登记范围，不自动证明事实正确。非事实段落也需要说明。</p>
    {document.reviews.length ? document.reviews.map(review => <div key={review.id} className="wm-review-item wm-stack"><div className="wm-row wm-between"><strong>{({ facts: "事实来源", editorial: "中文审读", images_formulas: "原图与公式", mobile_visual: "移动视觉" })[review.kind]}</strong><span className="wm-pill">{review.valid ? "版本匹配" : "待重审"}</span></div>{review.coverage ? <p>正文块 {review.coverage.paragraphs.length}/{review.coverage.paragraphTotal} · 素材 {review.coverage.assets.length}/{review.coverage.assetTotal} · {review.coverage.complete && review.valid ? "该类标注范围完整" : "仍需补齐或重审"}</p> : <p className="wm-small wm-muted">{review.kind === "mobile_visual" ? "实际截图记录，打开详情查看尺寸与图像。" : "未登记逐项覆盖；已有摘要不能补齐覆盖记录。"}</p>}<Button className={btn} size="sm" disabled={disabled} onClick={() => onRead(review.id)}>阅读{review.kind === "mobile_visual" ? "截图" : "报告与来源"}</Button></div>) : <p role="status">尚未记录当前文章的审阅材料。</p>}
    <details><summary>查看正文块编号 · {document.paragraphs?.length ?? 0} 块</summary><ol className="wm-paragraph-list">{document.paragraphs?.map((paragraph, index) => <li key={index} value={index + 1}>{paragraph}</li>)}</ol></details>
  </section>;
}

function SourceDetails({ details }: { details: ReviewDetails }): ReactNode {
  return <div className="wm-stack">
    <section><h4>参考来源 · {details.sources.length}</h4>{details.sources.length ? <ol className="wm-source-list">{details.sources.map(source => <li key={source.id}><strong>{source.id} · {source.title}</strong><p><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开原始来源</a></p><p className="wm-small">页码：{source.page || "未记录"} · 图号/公式号：{source.figure || "未记录"}</p></li>)}</ol> : <p>未登记外部来源。</p>}</section>
    <section><h4>逐项事实与段落 · {details.facts.length}</h4>{details.facts.map(fact => <article key={fact.id} className="wm-review-item wm-stack"><strong>正文块 {fact.paragraph} · {fact.disposition === "supported" ? "已登记来源支持" : "非事实内容说明"}</strong><p>{fact.claim}</p><p className="wm-small">来源：{fact.sourceIds.join("、") || "不适用"}</p><p>{fact.note}</p></article>)}</section>
    <section><h4>原图与公式关联 · {details.assets.length}</h4>{details.assets.map(asset => <article key={asset.source} className="wm-material-item wm-stack"><strong>{({ original: "原论文图", formula: "公式渲染产物", other: "其他素材" })[asset.kind]}</strong><p className="wm-code">{asset.source}</p><p>来源：{asset.sourceIds.join("、") || "未登记"}</p>{asset.formulaSource && <div><p>公式源码</p><pre className="wm-report-body">{asset.formulaSource}</pre></div>}<p>{asset.note}</p><details><summary>渲染产物 / 素材 SHA</summary><p className="wm-code">{asset.digest}</p></details></article>)}</section>
  </div>;
}

export function EvidenceReader({ state, controller, trigger }: { state: ClientState; controller: WorkbenchController; trigger: RefObject<HTMLElement> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null), open = state.evidenceRequested !== null;
  useDialogFocus(ref, open, trigger);
  const evidence = state.evidence, pending = state.pending.includes("evidence");
  useEffect(() => {
    // Retry removes its button while loading; keep keyboard focus inside the open reader.
    if (open && document.activeElement === document.body) ref.current?.focus();
  }, [open, pending]);
  return <Modal open={open} onClose={() => controller.closeEvidence()} title="审阅材料详情" closeLabel="关闭材料详情" className="wm-workbench wm-evidence-dialog" description="核对报告正文、来源与截图；历史材料保持原有适用范围。"><style>{workbenchStyles}</style><div ref={ref} tabIndex={-1} className="wm-stack" aria-label="审阅材料内容" aria-busy={pending}>
    {pending ? <p role="status">正在校验材料摘要并读取内容…</p> : evidence ? <>
      <div className="wm-row wm-between"><span className="wm-pill">{evidence.current ? "当前版本材料" : "历史 / 部分 / 待重审材料"}</span><span className="wm-small wm-muted">{evidence.format}</span></div>
      {evidence.notes.map(note => <p className="wm-inline-note" key={note}>{note}</p>)}
      {evidence.coverage && <p>本类覆盖：正文块 {evidence.coverage.paragraphs.length}/{evidence.coverage.paragraphTotal} · 素材 {evidence.coverage.assets.length}/{evidence.coverage.assetTotal}</p>}
      {evidence.image ? <figure className="wm-screenshot"><img src={evidence.image.dataUrl} width={evidence.image.width} height={evidence.image.height} alt={`已登记的文章移动端审阅截图，${evidence.image.width}×${evidence.image.height} 像素，${evidence.current ? "当前版本" : "需重新审阅的历史版本"}`} /><figcaption>{evidence.image.width} × {evidence.image.height} 像素 · 以原比例缩放显示</figcaption></figure> : <section><h4>报告正文</h4><pre className="wm-report-body">{evidence.body}</pre></section>}
      {evidence.details && <SourceDetails details={evidence.details} />}
      <details><summary>材料身份与绑定版本</summary><p className="wm-code">{evidence.id}<br />{evidence.revisionDigest || "未记录完整文章版本"}</p></details>
    </> : <div role="alert"><p>{state.notice?.text ?? "材料无法读取。可以关闭后选择其他记录，或核对文件后重试。"}</p><Button className={btn} onClick={() => { if (state.evidenceRequested) void controller.readEvidence(state.evidenceRequested); }}>重新读取材料</Button></div>}
    <Button className={btn} onClick={() => controller.closeEvidence()}>返回工作台</Button>
  </div></Modal>;
}

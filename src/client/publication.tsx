import React from "react";
import type { ReactNode } from "react";
import type { PublicationStatus } from "../domain/contentLibrary.ts";
import type { PublicationRecord, PublicationSourceSummary } from "../domain/publication.ts";

const statusLabels: Record<PublicationStatus, string> = { draft: "草稿", ready: "待发布", published: "已发布", unknown: "状态未知" };
const channelLabels: Record<PublicationRecord["channel"], string> = { wechat: "微信公众号", zhihu: "知乎", xiaohongshu: "小红书", x: "X" };
const recordLabels: Record<PublicationRecord["status"], string> = { ...statusLabels, failed: "发布失败", removed: "已下架" };
const evidenceLabels: Record<PublicationRecord["evidence"], string> = { none: "尚无核验依据", local_draft: "本地草稿", draft_readback: "平台草稿已核对", local_receipt: "本地发布记录 · 未实时核验", remote_readback: "平台回读记录" };

export const publicationStatusLabel = (status: PublicationStatus): string => statusLabels[status] ?? statusLabels.unknown;
export const publicationChannelLabel = (channel: string): string => channelLabels[channel as PublicationRecord["channel"]] ?? channel;
export function PublicationBadge({ status, label }: { status: PublicationStatus | "failed" | "removed"; label?: string }): ReactNode {
  return <span className="wm-publication-badge" data-publication-status={status} aria-label={`发布状态：${label ?? recordLabels[status]}`}><i aria-hidden="true" />{label ?? recordLabels[status]}</span>;
}

function recordStatusLabel(record: PublicationRecord): string {
  if (record.status === "draft" && record.evidence === "local_draft") return "本地草稿";
  if (record.status === "draft" && record.evidence === "draft_readback") return "平台草稿";
  return recordLabels[record.status];
}

/** Only public HTTP(S) links can become clickable, even if an older Host sends an invalid URL. */
export function publicPublicationUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const sensitiveQuery = [...url.searchParams.keys()].some(key => /(?:token|secret|password|cookie|authorization|api[_-]?key)/iu.test(key));
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !sensitiveQuery ? url.href : null;
  } catch { return null; }
}

const publicationTime = (value: string): string => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未知";

export function PublicationStatusPanel({ status, records = [], savedLocally = true, dirty = false }: { status: PublicationStatus; records?: readonly PublicationRecord[] | undefined; savedLocally?: boolean; dirty?: boolean }): ReactNode {
  return <section className="wm-publication" aria-label="文章发布状态"><style>{publicationStyles}</style><div className="wm-publication-heading"><h3>发布状态</h3><PublicationBadge status={status} /><span className="wm-publication-local">{dirty ? "当前修改未保存" : savedLocally ? "本地已保存" : "本地状态未知"}</span></div>
    {records.length ? <ul className="wm-publication-channels" aria-label="各平台发布记录">{records.map((record, index) => {
      const url = publicPublicationUrl(record.url);
      return <li className="wm-publication-channel" key={`${record.channel}:${index}`}><div className="wm-publication-channelhead"><strong>{channelLabels[record.channel]}</strong><PublicationBadge status={record.status} label={recordStatusLabel(record)} />{url && <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{record.status === "published" ? "查看作品" : "查看记录"}<span aria-hidden="true"> ↗</span></a>}</div><p className="wm-publication-evidence">{evidenceLabels[record.evidence]}</p>{record.note && <p className="wm-publication-note">{record.note}</p>}{(record.publishedAt || record.checkedAt) && <div className="wm-publication-times">{record.publishedAt && <span>发布时间：{publicationTime(record.publishedAt)}</span>}{record.checkedAt && <span>核对时间：{publicationTime(record.checkedAt)}</span>}</div>}</li>;
    })}</ul> : <p className="wm-publication-empty">暂无可核验的渠道发布记录。</p>}
    <p className="wm-publication-footnote">发布状态依据渠道记录；本地保存和平台草稿均不代表正式发布。{records.some(record => record.evidence === "local_receipt") && "历史发布记录不表示当前修订已发布。"}</p>
  </section>;
}

export function PublicationSourcesCard({ summary }: { summary: PublicationSourceSummary }): ReactNode {
  return <section className="wm-card wm-publication-sources" aria-label="本地发布记录"><div className="wm-row wm-between"><h3>本地发布记录</h3><span className="wm-pill">{summary.available ? "已读取" : "暂不可用"}</span></div>{summary.available ? <><p className="wm-small wm-muted">已复用{summary.channels.length ? ` ${summary.channels.map(publicationChannelLabel).join("、")} 的` : "已有"}本地记录。</p><dl className="wm-evidence-meta"><div><dt>跨平台记录</dt><dd>{summary.counts.ledgerRecords} 条</dd></div><div><dt>知乎文章库存</dt><dd>{summary.counts.zhihuArticles} 篇</dd></div><div><dt>小红书记录</dt><dd>{summary.counts.xiaohongshuRecords} 条</dd></div></dl></> : <p className="wm-small wm-muted">本地记录来源暂不可用，刷新工作台后可重新读取。</p>}<p className="wm-small wm-muted">知乎库存同步于：{summary.checkedAt ? publicationTime(summary.checkedAt) : "时间未记录"}</p><p className="wm-small wm-muted">记录读取与自动发布分别接入；读取成功不代表账号已登录或自动发布可用。</p>{summary.issues.length > 0 && <ul className="wm-small wm-muted">{summary.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</section>;
}

export const publicationStyles = `
.wm-publication,.wm-publication-badge{--wmp-text:var(--dsw-alias-label-primary);--wmp-muted:var(--dsw-alias-label-secondary);--wmp-border:var(--dsw-alias-border-l2);--wmp-layer:var(--dsw-alias-bg-layer-2);--wmp-success:var(--dsw-alias-state-success-primary);--wmp-warn:var(--dsw-alias-state-warn-primary);--wmp-error:var(--dsw-alias-state-error-primary)}
.wm-publication{color:var(--wmp-text);margin-top:14px;border:1px solid var(--wmp-border);border-radius:9px;padding:11px 13px;min-width:0;font:12px/1.6 system-ui,sans-serif}.wm-publication *{box-sizing:border-box}.wm-publication-heading{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.wm-publication-heading h3{font-size:12px;font-weight:600;margin:0!important;line-height:1.5}.wm-publication-local{font-size:10px;color:var(--wmp-muted);margin-left:auto}.wm-publication-badge{display:inline-flex;gap:5px;align-items:center;flex-shrink:0;max-width:100%;padding:1px 6px;border-radius:5px;border:1px solid var(--wmp-border);font-size:10px;line-height:1.6;color:var(--wmp-muted);white-space:nowrap}.wm-publication-badge i{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}.wm-publication-badge[data-publication-status=published]{color:var(--wmp-success)}.wm-publication-badge[data-publication-status=ready]{color:var(--wmp-warn)}.wm-publication-badge[data-publication-status=failed]{color:var(--wmp-error)}.wm-publication-channels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:8px;list-style:none;padding:0;margin:10px 0 0;max-height:190px;overflow:auto}.wm-publication-channel{min-width:0;border-radius:7px;background:var(--wmp-layer);padding:9px 10px}.wm-publication-channelhead{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.wm-publication-channelhead strong{font-size:11px}.wm-publication-channelhead a{font-size:10px;color:var(--dsw-alias-brand-primary);margin-left:auto;text-decoration:none}.wm-publication-channelhead a:hover{text-decoration:underline}.wm-publication .wm-publication-evidence,.wm-publication .wm-publication-note,.wm-publication .wm-publication-empty{font-size:11px;color:var(--wmp-muted);margin:6px 0 0;overflow-wrap:anywhere}.wm-publication-times{display:flex;gap:2px 12px;flex-wrap:wrap;color:var(--wmp-muted);font-size:10px;margin-top:6px}.wm-publication .wm-publication-footnote{font-size:10px;color:var(--wmp-muted);margin:8px 0 0;overflow-wrap:anywhere}.wm-content-detailhead>div:first-child{min-width:0;flex:1}
@media(max-width:760px){.wm-publication{padding:9px 10px}.wm-publication-local{margin-left:0}.wm-publication-channels{grid-template-columns:minmax(0,1fr)}}
`;

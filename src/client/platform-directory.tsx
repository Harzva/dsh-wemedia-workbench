import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PlatformCatalog, PlatformFormat } from "../domain/platformCatalog.ts";
import type { WorkbenchController } from "./controller.ts";

export type PlatformDirectoryHost = Pick<WorkbenchController, "requestContent">;
export interface PlatformDirectoryState { catalog: PlatformCatalog | null; loading: boolean; error: string | null }
const empty: PlatformDirectoryState = { catalog: null, loading: false, error: null };
const formatLabels: Record<PlatformFormat, string> = { article: "文章", image_text: "图文", video: "视频", short_text: "短帖" };
const priorityLabels = { first: "建议优先", later: "后续扩展", restricted: "接入受限" };

/** Effect lifetime owns the request. A disconnected/replaced view cannot accept late results. */
export function loadPlatformDirectory(host: PlatformDirectoryHost, publish: (state: PlatformDirectoryState) => void): () => void {
  const abort = new AbortController();
  publish({ catalog: null, loading: true, error: null });
  void (async () => {
    try {
      const catalog = await host.requestContent<PlatformCatalog>({ operation: "platform_catalog" }, abort.signal);
      if (!abort.signal.aborted) publish({ catalog, loading: false, error: null });
    } catch {
      if (!abort.signal.aborted) publish({ catalog: null, loading: false, error: "平台目录暂时不可用，请重试。" });
    }
  })();
  return () => abort.abort();
}

export function filterPlatforms(catalog: PlatformCatalog, query: string, format: PlatformFormat | "all"): PlatformCatalog["platforms"] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return catalog.platforms.filter(platform => {
    const text = [platform.id, platform.name, platform.name.replace(/\s+/gu, ""), platform.summary, ...platform.formats.map(item => formatLabels[item]), ...platform.requirements].join(" ").toLocaleLowerCase();
    return (format === "all" || platform.formats.includes(format)) && terms.every(term => text.includes(term));
  });
}

export function PlatformDirectory({ host, connected, generationId, active = true }: { host: PlatformDirectoryHost; connected: boolean; generationId: string; active?: boolean }): ReactNode {
  const [state, setState] = useState<PlatformDirectoryState>(empty);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!active || !connected) { setState(empty); return; }
    return loadPlatformDirectory(host, setState);
  }, [host, active, connected, generationId, reload]);
  return <PlatformDirectoryPanel state={state} connected={connected} onRetry={() => setReload(value => value + 1)} />;
}

export function PlatformDirectoryPanel({ state, connected, onRetry }: { state: PlatformDirectoryState; connected: boolean; onRetry: () => void }): ReactNode {
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<PlatformFormat | "all">("all");
  const items = state.catalog ? filterPlatforms(state.catalog, query, format) : [];
  return <section className="wm-platform-directory" aria-label="平台扩展目录" aria-busy={state.loading}>
    <style>{styles}</style>
    <header className="wm-platform-intro"><span className="wm-eyebrow">内容分发 · 平台扩展</span><h2>下一站，把内容发到哪里？</h2>
      <p>查看 Ins 等平台支持的内容、账号条件与接入限制。以下平台均待接入，当前还不能从工作台发布。</p>
    </header>
    {!connected ? <p role="status">工作台连接后加载目录。</p> : state.loading ? <p role="status">正在加载平台目录…</p> : state.error ? <div role="alert"><p>{state.error}</p><Button onClick={onRetry}>重新加载</Button></div> : state.catalog && <>
      <div className="wm-platform-filters"><label>搜索平台<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Ins、B站、专业账号…" /></label><label>内容类型<select value={format} onChange={event => setFormat(event.target.value as PlatformFormat | "all")}><option value="all">全部类型</option>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="wm-muted" role="status">{items.length} 个平台</span></div>
      <p className="wm-small wm-muted">资料核对：{state.catalog.researchedAt} · {state.catalog.notice}</p>
      <div className="wm-platform-grid">{items.map(platform => <article key={platform.id} className="wm-platform-card">
        <div className="wm-row wm-between"><h3>{platform.name}</h3><span className="wm-pill">待接入</span></div>
        <div className="wm-row wm-small"><span className="wm-platform-priority" data-priority={platform.priority}>{priorityLabels[platform.priority]}</span>{platform.formats.map(item => <span className="wm-pill" key={item}>{formatLabels[item]}</span>)}</div>
        <p>{platform.summary}</p><h4>接入条件</h4><ul>{platform.requirements.map(item => <li key={item}>{item}</li>)}</ul>
        <h4>需要注意</h4><ul className="wm-muted">{platform.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        <div className="wm-platform-sources">{platform.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.label} ↗</a>)}</div>
        {!!platform.referenceIds.length && <details><summary>参考源码与许可</summary>{state.catalog!.references.filter(reference => platform.referenceIds.includes(reference.id)).map(reference => <div className="wm-platform-reference" key={reference.id}><a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.repository} ↗</a><p className="wm-code">{reference.commit.slice(0, 12)} · {reference.license}</p><p>{reference.reuse}</p></div>)}</details>}
      </article>)}</div>
      {!items.length && <div className="wm-empty"><p>没有匹配的平台，试试其他名称或内容类型。</p><Button onClick={() => { setQuery(""); setFormat("all"); }}>清除筛选</Button></div>}
    </>}
  </section>;
}

const styles = `
.wm-workbench .wm-platform-directory{padding:24px;max-width:1500px;margin:auto;width:100%}
.wm-platform-intro h2{margin:6px 0;font-size:24px;letter-spacing:-.03em}
.wm-platform-intro p{color:var(--wm-muted);margin:8px 0 20px;max-width:850px}
.wm-platform-filters{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.wm-platform-filters label{display:grid;gap:5px;font-size:12px;color:var(--wm-muted)}
.wm-platform-filters input,.wm-platform-filters select{border:1px solid var(--wm-border);border-radius:9px;padding:9px 12px;background:var(--wm-panel);color:var(--wm-text);max-width:100%}
.wm-platform-filters input{width:280px}.wm-platform-filters>span{padding-bottom:9px}
.wm-platform-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;align-items:start}
.wm-platform-card{border:1px solid var(--wm-border);border-radius:14px;background:var(--wm-panel);padding:20px;min-width:0;overflow-wrap:anywhere}
.wm-platform-card h3{font-size:18px}.wm-platform-card h4{font-size:12px;margin-top:16px}.wm-platform-card>.wm-row+.wm-row{margin-top:10px}
.wm-platform-card p{margin:12px 0}.wm-platform-card ul{margin:6px 0 12px;padding-left:20px;font-size:13px}.wm-platform-card li+li{margin-top:5px}
.wm-platform-priority{color:var(--wm-accent)}.wm-platform-priority[data-priority=restricted]{color:var(--wm-warn)}
.wm-platform-sources{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}.wm-platform-card details{margin-top:16px;border-top:1px solid var(--wm-border);padding-top:12px;font-size:12px}
.wm-platform-card summary{cursor:pointer}.wm-platform-reference{margin-top:12px}.wm-platform-reference p{margin:4px 0}
@media(max-width:600px){.wm-workbench .wm-platform-directory{padding:16px}.wm-platform-card{padding:16px}.wm-platform-filters label{flex:1;min-width:120px}.wm-platform-filters input{width:100%}}
`;

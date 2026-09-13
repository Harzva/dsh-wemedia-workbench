import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PublicationAsset } from "../domain/publicationDraft.ts";
import type { WorkbenchController } from "./controller.ts";
import { ContentLibraryController } from "./content-library-controller.ts";
import { contentBytesLabel } from "./content-library.tsx";
import { useDialogFocus } from "./interactions.ts";

export function AssetPicker({ controller, kind, selectedIds, maximum, onChoose, onClose }: { controller: WorkbenchController; kind: "image" | "video"; selectedIds: string[]; maximum: number; onChoose: (assets: PublicationAsset[]) => void; onClose: () => void }): ReactNode {
  const [library] = useState(() => new ContentLibraryController((request, signal) => controller.requestContent(request, signal)));
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const [chosen, setChosen] = useState<PublicationAsset[]>([]), [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null); useDialogFocus(ref, true);
  useEffect(() => { library.connect(); void library.setKind(kind); return () => library.dispose(); }, [library, kind]);
  const toggle = (asset: PublicationAsset) => setChosen(current => current.some(value => value.itemId === asset.itemId) ? current.filter(value => value.itemId !== asset.itemId) : current.length < maximum ? [...current, asset] : current);
  return <Modal open title={kind === "image" ? "选择本地图像" : "选择本地视频"} onClose={onClose} closeLabel="关闭素材选择" className="wm-workbench wm-publication-dialog" footer={<><span className="wm-small wm-muted">已选 {chosen.length} / {maximum}</span><Button variant="primary" disabled={!chosen.length} onClick={() => { onChoose(chosen); onClose(); }}>添加所选素材</Button></>}><div ref={ref} tabIndex={-1} className="wm-stack"><form className="wm-publication-picker-search" onSubmit={event => { event.preventDefault(); void library.search(query); }}><input aria-label="搜索本地素材" placeholder="搜索素材名称" value={query} onChange={event => setQuery(event.target.value)} /><Button type="submit">搜索</Button></form><p className="wm-small wm-muted">按选择顺序添加，保存时复制到发布稿版本。</p><div className="wm-publication-picker" aria-label="可选素材" aria-busy={state.listLoading}>{state.items.filter(item => !item.publicationRef && item.kind === kind && item.mediaType && item.bytes).map(item => { const checked = chosen.some(value => value.itemId === item.itemId), present = selectedIds.includes(item.itemId); return <label key={item.itemId} className="wm-publication-picker-row"><input type="checkbox" checked={checked || present} disabled={present || !checked && chosen.length >= maximum} onChange={() => toggle({ source: "library", itemId: item.itemId, revisionDigest: item.revisionDigest, caption: "", title: item.title, kind, mediaType: item.mediaType!, bytes: item.bytes! })} /><span><strong>{item.title}</strong><small>{contentBytesLabel(item.bytes)}{present ? " · 已在稿件中" : ""}</small></span></label>; })}{state.listLoading && <p role="status">正在读取素材…</p>}{state.listError && <div role="alert"><p>{state.listError}</p><Button onClick={() => void library.refresh()}>重试</Button></div>}{!state.listLoading && !state.listError && !state.items.length && <p>没有匹配的本地素材。</p>}{state.nextCursor && !state.listLoading && <Button onClick={() => void library.loadMore()}>加载更多素材</Button>}</div></div></Modal>;
}

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { LibraryItem } from "../domain/contentLibrary.ts";
import type { ContentRef } from "../domain/primitives.ts";
import type { WorkbenchController, View } from "./controller.ts";
import { ContentLibraryController } from "./content-library-controller.ts";
import { ContentLibraryDetail, ContentLibrarySidebar } from "./content-library.tsx";
import { attachContentSurface, type ContentSurface } from "./content-surface.ts";
import { CreateArticle, WorkbenchBoundary, WorkbenchPanel } from "./views.tsx";
import { workbenchStyles } from "./styles.ts";
import { MappingView } from "./mapping-view.tsx";
import { ContentHome, contentHomeStyles } from "./content-home.tsx";
import { useDialogFocus } from "./interactions.ts";

const navigationStyles = `
.wm-content-switch{display:flex;width:100%;gap:4px;padding:4px 0 12px}
.wm-content-switch button{border:0;border-radius:7px;background:transparent;color:var(--wm-muted);display:flex;align-items:center;justify-content:center;gap:7px;flex:1;min-height:34px;cursor:pointer;font-size:13px}
.wm-content-switch button[aria-selected=true]{color:var(--wm-text);background:var(--wm-hover);font-weight:600}
.wm-content-switch svg{width:16px;height:16px;flex:none}
[data-sidebar-collapsed] .wm-content-switch{flex-direction:column;gap:6px;padding:6px 0}
.wm-content-center-shell{height:100%;width:100%;min-width:0;display:flex;flex-direction:column;background:var(--wm-bg)}
.wm-content-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;border-bottom:1px solid var(--wm-border);flex:none}
.wm-content-toolbar nav{display:flex;flex:1;min-width:0;gap:18px;overflow:auto}
.wm-content-toolbar nav button{border:0;background:none;color:var(--wm-muted);cursor:pointer;padding:7px 0;white-space:nowrap;font-size:12px;border-bottom:2px solid transparent}
.wm-content-toolbar nav button[aria-current=page]{color:var(--wm-text);border-color:var(--wm-accent);font-weight:600}
.wm-content-toolbar-state{font-size:11px;color:var(--wm-muted);white-space:nowrap}
.wm-content-main{flex:1;min-height:0;display:flex;overflow:hidden}
.wm-content-pane{display:flex;width:100%;min-height:0;min-width:0}
.wm-content-pane>.wm-content-detail{flex:1;width:100%;min-width:0}
.wemedia-content-library>.wm-content-sidebar{flex:1;width:100%;min-width:0}
.wm-content-pane[hidden]{display:none}
.wm-library-dialog .wm-content-dialog-body{display:flex;flex:1;min-width:0;min-height:0;outline:none}
.wm-embedded{height:100%;width:100%;min-height:0;display:flex}
.wm-embedded>.wm-panel{width:100%;max-width:none;border:0;border-radius:0;box-shadow:none}
.wm-embedded .wm-header,.wm-embedded .wm-nav-row{display:none}
.wm-embedded .wm-article-workspace[data-detail-only]{display:flex}
.wm-embedded .wm-article-workspace[data-detail-only]>.wm-library,.wm-embedded .wm-article-workspace[data-detail-only]>.wm-mobile-library-bar{display:none}
.wm-embedded .wm-article-workspace[data-detail-only]>.wm-detail{width:100%;flex:1}
.wm-content-fallback{position:absolute;left:18px;top:70px;pointer-events:auto;z-index:2}
.wm-content-mobile-back,.wm-content-mobile-library{display:none;flex:none;white-space:nowrap}
@media(max-width:700px){.wm-content-toolbar{padding:8px 12px}.wm-content-toolbar nav{gap:12px}.wm-content-toolbar-state{display:none}.wm-content-mobile-back,.wm-content-mobile-library{display:inline-flex}}
`;

function NavigationIcon({ content }: { content: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{content ? <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></> : <><path d="M20 11a8 8 0 0 1-8 8H5l-3 3v-11a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/></>}</svg>;
}

function navigateTabs(event: React.KeyboardEvent<HTMLDivElement>): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : ["ArrowRight", "ArrowDown"].includes(event.key) ? (current + 1) % tabs.length
    : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (current + tabs.length - 1) % tabs.length : undefined;
  if (next === undefined) return;
  event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
}

/** Global presentation composition; the original session DOM stays mounted. */
export function ContentNavigation({ controller }: { controller: WorkbenchController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [library] = useState(() => new ContentLibraryController((request, signal) => controller.requestContent(request, signal)));
  const [surface, setSurface] = useState<ContentSurface | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [detailMode, setDetailMode] = useState<"library" | "editor">("library");
  const [creating, setCreating] = useState(false);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const libraryState = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const [mappingRef, setMappingRef] = useState<ContentRef | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const libraryButton = useRef<HTMLSpanElement>(null);
  const libraryDialogBody = useRef<HTMLDivElement>(null);
  const libraryDialogTrigger = useRef<HTMLButtonElement | null>(null);
  useDialogFocus(libraryDialogBody, libraryDialogOpen && state.open, libraryDialogTrigger);
  const returnButton = useRef<HTMLSpanElement>(null);
  const mobileInteraction = useRef(false);
  const showMobileLibrary = (open: boolean) => { mobileInteraction.current = true; setMobileLibraryOpen(open); };
  useEffect(() => {
    surface?.setLibraryOpen(state.open && mobileLibraryOpen);
    const requested = mobileInteraction.current;
    mobileInteraction.current = false;
    // The creation dialog owns focus while open; closing it requests a fresh
    // return to the visible toolbar instead of its now-hidden library trigger.
    if (requested && !creating && state.open && typeof window !== "undefined" && window.matchMedia("(max-width:700px)").matches) {
      (mobileLibraryOpen ? returnButton : libraryButton).current?.querySelector("button")?.focus();
    }
  }, [surface, state.open, mobileLibraryOpen, creating]);
  // The composition owns open state across embedded/fallback view replacement.
  useEffect(() => () => controller.close(), [controller]);
  useEffect(() => {
    let live = true, attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attached: ContentSurface | undefined;
    const attach = () => {
      if (!live) return;
      if (anchor.current) attached = attachContentSurface(anchor.current, {
        onSessionRequested: (event: Event) => {
          if (!controller.dirty) { controller.requestClose(); return; }
          event.preventDefault(); event.stopImmediatePropagation();
          const target = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
          controller.requestNavigation(() => { controller.close(); if (target?.isConnected) target.click(); });
        },
        onUnavailable: () => { if (live) { setSurface(null); setDegraded(true); } },
      });
      if (attached) { setSurface(attached); return; }
      if (++attempts < 30) timer = setTimeout(attach, 100);
      else setDegraded(true);
    };
    attach();
    return () => { live = false; clearTimeout(timer); attached?.dispose(); };
  }, [controller]);
  useEffect(() => () => library.dispose(), [library]);
  useEffect(() => { if (state.connected) library.connect(); else library.unavailable(); }, [library, state.connected]);
  useEffect(() => {
    surface?.setActive(state.open);
    if (state.open) library.open(); else { library.close(); setCreating(false); setMappingRef(null); setMobileLibraryOpen(false); setLibraryDialogOpen(false); }
  }, [surface, library, state.open]);
  useEffect(() => { if (state.open && state.connected) void library.refresh(); }, [library, state.page?.total, state.document?.revisionDigest, state.publicationRevision, state.snapshot?.generationId]);

  const openArticle = (contentRef: ContentRef) => controller.requestNavigation(() => {
    setDetailMode("editor"); controller.navigate("articles"); void controller.select(contentRef);
  });
  const choose = (item: LibraryItem, select: () => void) => controller.requestNavigation(() => {
    select(); setLibraryDialogOpen(false); showMobileLibrary(false); controller.navigate("articles");
    if (item.publicationRef) { setDetailMode("editor"); void controller.selectPublication(item.publicationRef); }
    else if (item.contentRef) { setDetailMode("editor"); void controller.select(item.contentRef); }
    else setDetailMode("library");
  });
  const create = () => controller.requestNavigation(() => { setLibraryDialogOpen(false); showMobileLibrary(false); setCreating(true); });
  const browse = (query?: string) => {
    if (query !== undefined) void library.search(query);
    if (typeof window !== "undefined" && window.matchMedia("(max-width:700px)").matches) showMobileLibrary(true);
    else { libraryDialogTrigger.current = libraryButton.current?.querySelector("button") ?? null; setLibraryDialogOpen(true); }
  };
  const tabs: Array<[View, string]> = [["articles", "内容"], ["references", "采集 / 参考库"], ["agent", "Agent 协作"], ["jobs", "任务"], ["accounts", "账号"], ["platforms", "平台扩展"], ["settings", "设置"]];
  useEffect(() => { if (state.publication || state.document) setDetailMode("editor"); }, [state.publication?.contentRef, state.document?.contentRef]);
  const editorVisible = state.view !== "articles" || detailMode === "editor";
  const main = <WorkbenchBoundary onClose={() => controller.requestClose()}><div className="wm-workbench wm-content-center-shell"><style>{workbenchStyles}{navigationStyles}{contentHomeStyles}</style>
    <header className="wm-content-toolbar"><span ref={libraryButton} className="wm-content-library-trigger"><Button size="sm" variant="outline" onClick={() => browse()}>选择内容</Button></span><nav aria-label="内容工具">{tabs.map(([view, title]) => <button key={view} aria-current={state.view === view ? "page" : undefined} onClick={() => controller.navigate(view)}>{title}</button>)}</nav><span className="wm-content-toolbar-state">{state.connected ? "本地内容" : "正在连接"}</span><Button className="wm-content-mobile-back" size="sm" onClick={() => controller.requestClose()}>会话</Button></header>
    <div className="wm-content-main"><div className="wm-content-pane" hidden={editorVisible}>{!libraryState.selected ? <ContentHome state={libraryState} canCreate={!!state.snapshot?.settings.hasWriteRoot} onBrowse={browse} onCreate={create} onCollect={() => controller.navigate("references")} onAccounts={() => controller.navigate("accounts")} onOpen={item => choose(item, () => void library.select(item.itemId))} /> : <ContentLibraryDetail controller={library} onOpenArticle={openArticle} onOpenMapping={contentRef => controller.requestNavigation(() => setMappingRef(contentRef))} active={state.open && !editorVisible}/>}</div><div className="wm-content-pane" hidden={!editorVisible}><WorkbenchPanel controller={controller} embedded detailOnly active={editorVisible} /></div></div>
    <Modal open={libraryDialogOpen && state.open} onClose={() => setLibraryDialogOpen(false)} title="选择内容" closeLabel="关闭内容选择" className="wm-workbench wm-library-dialog"><style>{workbenchStyles}{contentHomeStyles}</style><div ref={libraryDialogBody} className="wm-content-dialog-body" tabIndex={-1}><ContentLibrarySidebar controller={library} onSelect={choose} onCreateArticle={state.snapshot?.settings.hasWriteRoot ? create : undefined} /></div></Modal>
    {mappingRef && <MappingView key={mappingRef} controller={controller} contentRef={mappingRef} onClose={() => setMappingRef(null)} />}
    <CreateArticle controller={controller} state={state} open={creating} onClose={() => { setCreating(false); showMobileLibrary(false); controller.discardCreation(); controller.discardPublicationCreation(); }} onCreated={() => {
      setCreating(false); showMobileLibrary(false); setDetailMode("editor"); controller.navigate("jobs"); void library.refresh();
    }} />
  </div></WorkbenchBoundary>;
  return <><span ref={anchor} hidden data-wemedia-layout-anchor="" />{surface && <>
    {createPortal(<div className="wm-workbench wm-content-switch" role="tablist" aria-label="工作区导航" onKeyDown={navigateTabs}><style>{workbenchStyles}{navigationStyles}</style><button role="tab" aria-label="会话" aria-selected={!state.open} tabIndex={state.open ? -1 : 0} onClick={() => controller.requestClose()}><NavigationIcon content={false}/><span data-wemedia-nav-label>会话</span></button><button role="tab" aria-label="内容" aria-selected={state.open} tabIndex={state.open ? 0 : -1} onClick={() => { showMobileLibrary(false); controller.open(); }}><NavigationIcon content/><span data-wemedia-nav-label>内容</span></button></div>, surface.navigation)}
    {createPortal(<><span ref={returnButton} className="wm-content-mobile-library"><Button size="sm" onClick={() => showMobileLibrary(false)}>返回内容</Button></span><ContentLibrarySidebar controller={library} onSelect={choose} onCreateArticle={state.snapshot?.settings.hasWriteRoot ? create : undefined} /></>, surface.library)}
    {createPortal(main, surface.center)}
  </>}{degraded && <><div className="wm-workbench wm-content-fallback"><style>{workbenchStyles}{navigationStyles}</style><Button onClick={() => controller.open()}>内容</Button></div><WorkbenchPanel controller={controller}/></>}</>;
}

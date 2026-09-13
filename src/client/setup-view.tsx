import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SetupApplyResult, SetupInspection, SetupPreview, SetupSelection } from "../domain/setup.ts";
import { ClientFault, type WorkbenchController } from "./controller.ts";

export interface SetupViewState {
  inspection: SetupInspection | null; selection: SetupSelection | null; preview: SetupPreview | null;
  reading: boolean; previewing: boolean; applying: boolean; error: string | null; notice: string | null;
  pending: { selection: SetupSelection; previousGeneration: string } | null;
}
const sameSelection = (left: SetupSelection, right: SetupSelection) => left.writeRootId === right.writeRootId && JSON.stringify([...left.rootIds].sort()) === JSON.stringify([...right.rootIds].sort());

/** Presentation and readback only; native configuration writes stay on the shared Host service. */
export class SetupViewController {
  private state: SetupViewState = { inspection: null, selection: null, preview: null, reading: false, previewing: false, applying: false, error: null, notice: null, pending: null };
  private listeners = new Set<() => void>(); private requests = new Map<string, AbortController>(); private stopped = false;
  private readbackTimer: ReturnType<typeof setTimeout> | null = null; private readbackAttempts = 0;
  constructor(private readonly request: WorkbenchController["requestContent"], private readonly onInspection?: (inspection: SetupInspection) => Promise<void>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(update: Partial<SetupViewState>) { if (this.stopped) return; this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(); }
  private owner(key: string) { this.requests.get(key)?.abort(); const owner = new AbortController(); this.requests.set(key, owner); return owner; }
  private current(key: string, owner: AbortController) { return !this.stopped && !owner.signal.aborted && this.requests.get(key) === owner; }
  private error(error: unknown) { return error instanceof ClientFault ? error.message : "目录操作未完成，请刷新当前选择后重试。"; }
  dispose() { this.stopped = true; if (this.readbackTimer !== null) clearTimeout(this.readbackTimer); this.readbackTimer = null; for (const request of this.requests.values()) request.abort(); this.requests.clear(); this.listeners.clear(); }
  private scheduleReadback(): void {
    if (!this.state.pending || this.stopped) {
      if (this.readbackTimer !== null) clearTimeout(this.readbackTimer);
      this.readbackTimer = null; return;
    }
    if (this.state.applying || this.readbackTimer !== null) return;
    if (this.readbackAttempts >= 20) { this.patch({ notice: "自动核对已结束，目录提交结果仍待确认，请刷新并核对目录。" }); return; }
    this.readbackTimer = setTimeout(() => {
      this.readbackTimer = null; this.readbackAttempts += 1;
      void this.inspect();
    }, 500);
  }
  change(selection: SetupSelection) { this.requests.get("preview")?.abort(); this.patch({ selection: structuredClone(selection), preview: null, previewing: false, error: null, notice: null }); }
  async inspect(): Promise<void> {
    if (this.stopped) return;
    const owner = this.owner("inspect"); this.patch({ reading: true, error: null });
    try {
      const inspection = await this.request<SetupInspection>({ operation: "setup_inspect" }, owner.signal);
      if (!this.current("inspect", owner)) return;
      const pending = this.state.pending, previous = this.state.inspection;
      const unchangedInput = !this.state.selection || !previous || sameSelection(this.state.selection, previous.selection);
      this.patch({ inspection, ...(unchangedInput || pending ? { selection: structuredClone(inspection.selection) } : {}), ...(previous && previous.inputDigest !== inspection.inputDigest ? { preview: null } : {}) });
      if (pending && inspection.generationId !== pending.previousGeneration) {
        this.patch({ pending: null, notice: sameSelection(pending.selection, inspection.selection) ? "目录选择已在重新连接后核对生效。" : "重新连接后的目录选择与提案不同，请核对当前状态后重新预览。" });
      } else if (pending) this.patch({ notice: "目录更新已提交，等待重新连接后核对选择。" });
      await this.onInspection?.(inspection);
    } catch (error) { if (this.current("inspect", owner)) this.patch({ error: this.error(error) }); }
    finally { if (this.current("inspect", owner)) { this.requests.delete("inspect"); this.patch({ reading: false }); this.scheduleReadback(); } }
  }
  async preview(): Promise<void> {
    if (!this.state.selection || this.stopped || this.state.applying) return;
    const selection = structuredClone(this.state.selection), owner = this.owner("preview"); this.patch({ previewing: true, preview: null, error: null, notice: null });
    try { const preview = await this.request<SetupPreview>({ operation: "setup_preview", ...selection }, owner.signal); if (this.current("preview", owner) && this.state.selection && sameSelection(selection, this.state.selection)) this.patch({ preview }); }
    catch (error) { if (this.current("preview", owner)) this.patch({ error: this.error(error) }); }
    finally { if (this.current("preview", owner)) { this.requests.delete("preview"); this.patch({ previewing: false }); } }
  }
  async apply(): Promise<void> {
    const preview = this.state.preview;
    if (!preview || this.state.applying || this.stopped) return;
    if (preview.blockingCodes.length || Date.parse(preview.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(preview.expiresAt)) || preview.sideEffect !== "local_write" || !this.state.selection || !sameSelection(preview.after, this.state.selection) || preview.generationId !== this.state.inspection?.generationId) { this.patch({ preview: null, error: "目录预览已失效或仍有阻断项，请重新预览。" }); return; }
    if (this.readbackTimer !== null) clearTimeout(this.readbackTimer); this.readbackTimer = null; this.readbackAttempts = 0;
    const owner = this.owner("apply");
    this.patch({ applying: true, preview: null, error: null, pending: { selection: structuredClone(preview.after), previousGeneration: preview.generationId }, notice: "正在提交目录选择，连接可能短暂重载。" });
    try {
      await this.request<SetupApplyResult>({ operation: "setup_apply", intentId: preview.intentId }, owner.signal);
      if (this.current("apply", owner)) { this.patch({ notice: "目录更新已提交，等待重新连接后核对选择。" }); await this.inspect(); }
    } catch (error) {
      if (this.current("apply", owner)) {
        const uncertain = !(error instanceof ClientFault) || !(error.code.startsWith("SETUP_") || error.code === "REQUEST_INVALID");
        this.patch({ ...(uncertain ? { notice: "连接已变化，提交结果尚待核对。重新连接后刷新当前选择。" } : { error: this.error(error), pending: null, notice: null }) });
      }
    } finally { if (this.current("apply", owner)) { this.requests.delete("apply"); this.patch({ applying: false }); this.scheduleReadback(); } }
  }
}

export const setupStyles = `.wm-setup-manager{min-width:0}.wm-setup-roots{display:flex;flex-direction:column;gap:8px}.wm-setup-root{display:flex;align-items:center;gap:8px;border:1px solid var(--wm-border);border-radius:8px;padding:10px}.wm-setup-root input{width:auto;flex:none}.wm-setup-root>span{display:flex;flex-direction:column;min-width:0;gap:3px;overflow-wrap:anywhere}.wm-setup-root small{font-size:11px;color:var(--wm-muted)}.wm-setup-manager select{max-width:100%;min-width:0}.wm-setup-manager .wm-row{flex-wrap:wrap}.wm-setup-preview{padding:14px;border:1px solid var(--wm-border);border-radius:8px}.wm-setup-preview li{overflow-wrap:anywhere;font-size:12px;line-height:1.8}`;

export function createSetupViewController(controller: WorkbenchController): SetupViewController {
  return new SetupViewController((request, signal) => controller.requestContent(request, signal), async inspection => {
    if (controller.getSnapshot().snapshot?.generationId !== inspection.generationId) await controller.refresh();
  });
}

export function SetupView({ controller, manager: supplied }: { controller: WorkbenchController; manager?: SetupViewController }): ReactNode {
  const host = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [manager] = useState(() => supplied ?? createSetupViewController(controller));
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  useEffect(() => () => manager.dispose(), [manager]);
  useEffect(() => { if (host.connected) void manager.inspect(); }, [manager, host.connected, host.snapshot?.generationId]);
  const selection = state.selection, locked = state.applying || state.previewing;
  return <section className="wm-card wm-stack wm-setup-manager" aria-label="内容目录设置"><style>{setupStyles}</style><div className="wm-row wm-between"><h3>内容目录设置</h3><Button size="sm" disabled={!host.connected || state.reading || state.applying} onClick={() => void manager.inspect()}>刷新并核对目录</Button></div><p className="wm-small wm-muted">选择已在 DSH 配置中的内容目录和独立写入目录。新增目录请在 DSH 原生插件配置中设置。</p>{state.reading && <p role="status">正在读取目录候选…</p>}{state.inspection && selection && <><div className="wm-setup-roots" role="group" aria-label="启用的内容目录">{state.inspection.roots.map(root => <label key={root.id} className="wm-setup-root"><input type="checkbox" checked={selection.rootIds.includes(root.id)} disabled={locked || !root.available && !selection.rootIds.includes(root.id)} onChange={event => manager.change({ ...selection, rootIds: event.target.checked ? [...selection.rootIds, root.id] : selection.rootIds.filter(id => id !== root.id) })} /><span><strong>{root.label}</strong><small>{root.available ? selection.rootIds.includes(root.id) ? "已选择" : "可启用" : "当前不可用"} · {root.id}</small></span></label>)}</div>{!state.inspection.roots.length && <p>没有已配置的内容目录。</p>}<label className="wm-stack">独立写入目录<select aria-label="独立写入目录" value={selection.writeRootId ?? ""} disabled={locked} onChange={event => manager.change({ ...selection, writeRootId: event.target.value || null })}><option value="">停用写入，仅浏览内容</option>{state.inspection.writeRoots.map(root => <option key={root.id} value={root.id} disabled={!root.available}>{root.label}{root.available ? "" : "（不可用）"}</option>)}</select></label>{!state.inspection.writeRoots.length && <p className="wm-small wm-muted">暂无写入目录候选。请先在 DSH 原生配置中添加独立写入目录。</p>}{state.inspection.issues.length > 0 && <ul className="wm-inline-note">{state.inspection.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}<Button disabled={locked || !host.connected || state.reading} onClick={() => void manager.preview()}>{state.previewing ? "正在预览…" : "预览目录变更"}</Button></>}{state.preview && <section className="wm-setup-preview wm-stack" aria-label="目录变更预览"><h4>确认目录选择</h4><ul>{state.preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>{state.preview.blockingCodes.length > 0 && <p role="alert">仍有阻断项：{state.preview.blockingCodes.join("、")}</p>}<p className="wm-small wm-muted">应用后会重载连接，并重新读取目录选择进行核对。</p><Button variant="primary" disabled={state.applying || !!state.preview.blockingCodes.length || !host.connected} onClick={() => void manager.apply()}>确认应用目录选择</Button></section>}{state.notice && <p role="status" className="wm-inline-note">{state.notice}</p>}{state.error && <p role="alert" className="wm-error">{state.error}</p>}</section>;
}

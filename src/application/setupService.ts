import { SETUP_SCHEMA } from "../domain/setup.ts";
import type { SetupApplyResult, SetupInspection, SetupPreview, SetupSelection } from "../domain/setup.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { SetupCaller, SetupPort } from "../ports/setup.ts";

const fail = (code: string, message: string): never => { throw new WorkbenchFault(code, message); };
const callerKey = (caller: SetupCaller): string => {
  if (!["user", "agent"].includes(caller.kind) || caller.sessionId !== undefined && (typeof caller.sessionId !== "string" || caller.sessionId.length > 200) || caller.kind === "agent" && !caller.sessionId) return fail("SETUP_CALLER_UNAVAILABLE", "当前调用方身份不可用，请在当前会话重新预览");
  return JSON.stringify([caller.kind, caller.sessionId ?? null]);
};
interface SavedSetup { preview: SetupPreview; signature: string; caller: string; consumed: boolean }

/** Selection-only setup; filesystem discovery and native persistence remain behind a port. */
export class SetupService {
  private stopped = false;
  private readonly intents = new Map<string, SavedSetup>();
  constructor(private readonly options: { setup: SetupPort; generationId: string; clock: Clock; ids: IdGenerator; hasher: { digest(value: string): string } }) {}
  dispose(): void { this.stopped = true; this.intents.clear(); }
  private active(signal?: AbortSignal): void {
    if (this.stopped) fail("GENERATION_DISPOSED", "当前配置已停止，请连接新工作台后重试");
    if (signal?.aborted) fail("REQUEST_CANCELLED", "设置操作已取消");
  }
  async inspect(signal?: AbortSignal): Promise<SetupInspection> {
    this.active(signal); const state = await this.options.setup.inspect(signal); this.active(signal);
    const { signature, ...view } = state;
    return { ...view, schemaVersion: SETUP_SCHEMA, generationId: this.options.generationId, inputDigest: this.options.hasher.digest(JSON.stringify([this.options.generationId, signature])) };
  }
  async preview(selection: SetupSelection, caller: SetupCaller, signal?: AbortSignal): Promise<SetupPreview> {
    this.active(signal); const owner = callerKey(caller);
    const proposal = await this.options.setup.preview(selection, signal); this.active(signal);
    const now = Date.parse(this.options.clock.nowIso());
    for (const [id, entry] of this.intents) if (entry.consumed || Date.parse(entry.preview.expiresAt) <= now) this.intents.delete(id);
    if (this.intents.size >= 100) fail("SETUP_INTENT_LIMIT", "待确认设置过多，请稍后重新预览");
    const before = proposal.state.selection, after = proposal.selection;
    const changes = proposal.state.roots.flatMap(root => before.rootIds.includes(root.id) === after.rootIds.includes(root.id) ? [] : [`${after.rootIds.includes(root.id) ? "启用" : "停用"}内容根：${root.label}`]);
    if (before.writeRootId !== after.writeRootId) changes.push(after.writeRootId === null ? "停用写入根，工作台不再创建或保存新稿" : "选择已配置的独立写入根");
    if (!changes.length) changes.push("目录选择保持不变");
    const preview: SetupPreview = { schemaVersion: SETUP_SCHEMA, generationId: this.options.generationId, intentId: this.options.ids.opaqueId("setup-intent"), sideEffect: "local_write", inputDigest: this.options.hasher.digest(JSON.stringify([this.options.generationId, proposal.state.signature, after, owner])), expiresAt: new Date(now + 10 * 60_000).toISOString(), before: structuredClone(before), after: structuredClone(after), changes, blockingCodes: [...proposal.blockingCodes] };
    this.intents.set(preview.intentId, { preview: structuredClone(preview), signature: proposal.state.signature, caller: owner, consumed: false });
    return preview;
  }
  async apply(intentId: string, caller: SetupCaller, signal?: AbortSignal): Promise<SetupApplyResult> {
    this.active(signal); const saved = this.intents.get(intentId), owner = callerKey(caller);
    if (!saved || saved.consumed) return fail("SETUP_INTENT_EXPIRED", "设置预览已使用或失效，请重新预览");
    const current = (): void => {
      this.active(signal);
      if (saved.preview.generationId !== this.options.generationId || Date.parse(saved.preview.expiresAt) <= Date.parse(this.options.clock.nowIso())) fail("SETUP_INTENT_EXPIRED", "设置预览已过期，请重新预览");
      if (saved.caller !== owner) fail("SETUP_CALLER_CHANGED", "设置预览属于其他调用方，请在当前会话重新预览");
    };
    current();
    if (saved.preview.blockingCodes.length) fail("SETUP_BLOCKED", "目录选择仍有阻断项，请先修正原生配置后重新预览");
    saved.consumed = true;
    await this.options.setup.apply(saved.preview.after, saved.signature, current, signal);
    return { applied: true, selection: structuredClone(saved.preview.after), requiresReconnect: true };
  }
}

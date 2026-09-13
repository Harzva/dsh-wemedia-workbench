import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-user-approval";
import { success } from "../domain/errors.ts";
import type { WorkbenchCaller } from "../domain/workbench.ts";
import type { WorkbenchApprovalProvider } from "../ports/workbench.ts";
import type { ApprovalBridge } from "../ports/approval.ts";

export class NativeWorkbenchApprovals implements WorkbenchApprovalProvider {
  private readonly calls = new Map<string, ToolRunContext>();
  constructor(private readonly ctx: Context) {}
  available(): boolean { return this.ctx.get("approval") !== undefined; }
  bind(exec: ToolRunContext): { caller: WorkbenchCaller; dispose: () => void } {
    const identity = `call:${randomUUID()}`;
    if (exec.agent) this.calls.set(identity, exec);
    // The installed Agent contract shares `id` with its live Session. Import
    // preview and apply are different tool calls but must retain this identity.
    return { caller: exec.agent ? { kind: "agent", sessionId: exec.agent.id, callId: identity } : { kind: "user" }, dispose: () => { this.calls.delete(identity); } };
  }
  forCaller(caller: WorkbenchCaller): ApprovalBridge | undefined {
    const exec = caller.kind === "agent" && caller.callId ? this.calls.get(caller.callId) : undefined;
    const approval = this.ctx.get("approval");
    if (!exec?.agent || !approval) return;
    const agent = exec.agent;
    let issued: { intentId: string; digest: string; reference: string } | undefined;
    return {
      request: async (intent, signal) => {
        const outcome = await approval.request({ agent, toolName: exec.name, callId: exec.callId, signal, reason: `${intent.targetSummary}\n内容：${intent.contentRef}\n版本：${intent.artifactDigest ?? intent.inputDigest}\n意图：${intent.intentId}\n${intent.sideEffect === "remote_publish" ? "本次操作会正式发布上述精确内容；批准仅适用于此次渠道、账号和版本。" : "权限仅限此次预览，不包含正式发布。"}` });
        if (outcome !== "allowed-once" || signal.aborted) return success({ approved: false });
        issued = { intentId: intent.intentId, digest: intent.inputDigest, reference: `approval:${randomUUID()}` };
        return success({ approved: true, reference: issued.reference, approvedAt: new Date().toISOString() });
      },
      verify: async (intent, reference) => {
        const approved = issued?.reference === reference && issued.intentId === intent.intentId && issued.digest === intent.inputDigest && this.calls.get(caller.callId!) === exec;
        issued = undefined;
        return success({ approved });
      },
    };
  }
  dispose(): void { this.calls.clear(); }
}

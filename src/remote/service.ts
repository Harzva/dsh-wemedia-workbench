import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { WorkbenchRequest } from "../domain/workbench.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { WorkbenchService } from "../application/workbenchService.ts";

export class WemediaRemoteService extends TypertRemoteService {
  constructor(ctx: Context, private readonly workbench: WorkbenchService) { super(ctx, "wemedia"); }
  // Exported only by the package's strict ./typert descriptors. No permissive
  // source-marker fallback or additional decorator transpiler is needed.
  request(request: WorkbenchRequest, signal: AbortSignal) {
    // RPC identity is always a user, regardless of fields in the payload.
    return this.workbench.request(request, { kind: "user" }, signal);
  }
  async intentTask(request: { intentId: string }, signal: AbortSignal) {
    try {
      if (signal.aborted) throw new WorkbenchFault("REQUEST_CANCELLED", "请求已取消");
      return { ok: true, prompt: this.workbench.intentTask(request.intentId), code: "AGENT_TASK_READY" };
    } catch (error) { return { ok: false, prompt: "", code: error instanceof WorkbenchFault ? error.code : "TASK_UNAVAILABLE" }; }
  }
}

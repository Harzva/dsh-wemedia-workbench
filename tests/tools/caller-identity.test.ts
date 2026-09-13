import { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { NativeWorkbenchApprovals } from "../../src/host/approval.ts";

describe("trusted native caller session binding", () => {
  it("retains actual session identity across calls but never conflates agents", () => {
    const approvals = new NativeWorkbenchApprovals(new Context());
    const bind = (session: string) => approvals.bind({ agent: { id: session } } as ToolRunContext);
    const first = bind("session-a"), next = bind("session-a"), other = bind("session-b");
    expect(first.caller.sessionId).toBe("session-a");
    expect(next.caller.sessionId).toBe(first.caller.sessionId);
    expect(next.caller.callId).not.toBe(first.caller.callId);
    expect(other.caller.sessionId).not.toBe(first.caller.sessionId);
    first.dispose(); next.dispose(); other.dispose(); approvals.dispose();
  });
});

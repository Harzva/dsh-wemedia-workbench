import { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ActionIntent } from "../../src/domain/capability.ts";
import { afterEach, describe, expect, it } from "vitest";
import { NativeWorkbenchApprovals } from "../../src/host/approval.ts";

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });
const intent: ActionIntent = {
  intentId: "intent:fixture", generationId: "generation:fixture",
  contentRef: "wmc:11111111-1111-4111-8111-111111111111", action: "create_draft",
  sideEffect: "remote_draft", targetSummary: "Fixture draft", inputDigest: `sha256:${"a".repeat(64)}`,
  expectedChanges: [], blockingGateCodes: [], expiresAt: "2099-01-01T00:00:00Z", approved: false,
};
async function approvalFixture(open = true) {
  const ctx = new Context(); contexts.push(ctx);
  await ctx.plugin(ApprovalService, { policy: "ask" }).await();
  const session = Session.create(SessionId("fixture-agent"));
  if (open) session.append("turn/start", { turn: 0 });
  const agent = { id: session.id, session } as Agent;
  const approvals = new NativeWorkbenchApprovals(ctx);
  ctx.effect(() => () => approvals.dispose());
  const binding = approvals.bind({ agent, name: "wemedia_start_action", callId: "fixture-call", signal: new AbortController().signal } as ToolRunContext);
  const bridge = approvals.forCaller(binding.caller)!;
  return { ctx, session, approvals, binding, bridge };
}

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
  it("uses real open-turn approval audit and consumes an exact grant once", async () => {
    const f = await approvalFixture();
    f.ctx.on("approval/request", async () => "allowed-once");
    const before = f.session.seq;
    const answer = await f.bridge.request(intent, new AbortController().signal);
    expect(answer).toMatchObject({ ok: true, value: { approved: true } });
    expect(f.session.eventAt(SessionSeq(before))).toMatchObject({ type: "approval/asked", data: { toolName: "wemedia_start_action", callId: "fixture-call" } });
    expect(f.session.eventAt(SessionSeq(before + 1))).toMatchObject({ type: "approval/decided", data: { outcome: "allowed-once" } });
    if (!answer.ok || !answer.value.reference) throw new Error("Fixture approval missing");
    expect(await f.bridge.verify(intent, answer.value.reference)).toMatchObject({ ok: true, value: { approved: true } });
    expect(await f.bridge.verify(intent, answer.value.reference)).toMatchObject({ ok: true, value: { approved: false } });
    f.binding.dispose();
    expect(f.approvals.forCaller(f.binding.caller)).toBeUndefined();
  });
  it.each(["rejected", "cancelled", "unavailable"] as const)("does not grant on native %s", async outcome => {
    const f = await approvalFixture();
    f.ctx.on("approval/request", async () => outcome);
    expect(await f.bridge.request(intent, new AbortController().signal)).toMatchObject({ ok: true, value: { approved: false } });
    expect(await f.bridge.verify(intent, "forged-reference")).toMatchObject({ ok: true, value: { approved: false } });
  });
  it("rejects approval outside an open turn without writing an unaudited decision", async () => {
    const f = await approvalFixture(false), before = f.session.seq;
    await expect(f.bridge.request(intent, new AbortController().signal)).rejects.toThrow("outside an open turn");
    expect(f.session.seq).toBe(before);
  });
});

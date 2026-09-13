import { describe, expect, it } from "vitest";
import { jobGuidance } from "../../src/host/jobGuidance.ts";
import { createWorkbenchTools } from "../../src/host/tools.ts";

const job = (status: string, action = "create_draft") => ({ ok: true as const, revision: 1, value: { jobId: "job:fixture", status, action } });

describe("job follow-up guidance", () => {
  it("distinguishes preview, queued, running and native approval", () => {
    expect(jobGuidance("preview_action", { ok: true, value: { intent: {} } })).toContain("no save or remote write has occurred");
    expect(jobGuidance("start_action", job("queued"))).toContain("queued alone does not mean approval is pending");
    expect(jobGuidance("get_job", job("running"))).toContain("Do not ask for another approval");
    expect(jobGuidance("get_job", job("running"))).toContain("until a terminal state");
    expect(jobGuidance("get_job", job("waiting_user"))).toContain("existing native approval request");
    expect(jobGuidance("get_job", job("waiting_user"))).toContain("approval alone is not completion");
  });

  it("spaces polling on the same job without treating unchanged work as failure", () => {
    for (const status of ["queued", "running"]) {
      const hint = jobGuidance("get_job", job(status));
      expect(hint).toContain("same job");
      expect(hint).toContain("15-30 second waits");
      expect(hint).toContain("unchanged");
      expect(hint).toContain("neither a failure nor a native approval wait");
      expect(hint).toContain("Do not submit another write");
    }
  });

  it.each(["create_draft", "update_draft"])("requires current target readback after successful %s", action => {
    const hint = jobGuidance("get_job", job("succeeded", action));
    for (const requirement of ["WECHAT_DRAFT_VERIFIED", "exactly one target", "CURRENT revisionDigest", "never create a second draft", "not formally published"]) expect(hint).toContain(requirement);
  });

  it("does not confuse local or other-channel success with WeChat delivery", () => {
    expect(jobGuidance("get_job", job("succeeded", "save_revision"))).toContain("actual new revision, paragraphs and renamed assets");
    expect(jobGuidance("get_job", job("succeeded", "save_revision"))).toContain("not remote delivery");
    expect(jobGuidance("channel_start_action", job("succeeded", "channel_publish"))).not.toContain("WECHAT_DRAFT_VERIFIED");
  });

  it.each(["failed", "cancelled", "timed_out", "reconcile_required"])("never invites automatic retry after %s", status => {
    const hint = jobGuidance("get_job", job(status));
    expect(hint).toContain(status === "timed_out" || status === "reconcile_required" ? "Outcome unconfirmed" : "did not complete successfully");
    expect(hint).toContain("read-only reconciliation");
    expect(hint).toContain("Do not automatically retry");
  });

  it("does not interpret article text, unknown statuses or errors as job instructions", () => {
    expect(jobGuidance("inspect", job("running"))).toBeUndefined();
    expect(jobGuidance("get_job", job("invented"))).toBeUndefined();
    for (const value of [null, [], { ok: false, error: { code: "INTENT_CHANGED" } }, { ok: true, value: { status: "running" } }]) expect(jobGuidance("get_job", value)).toBeUndefined();
  });

  it("keeps canonical tool JSON first and appends guidance only to model rendering", async () => {
    const answer = job("running");
    const tools = createWorkbenchTools({ request: async () => answer }, { bind: () => ({ caller: { kind: "user" }, dispose() {} }) });
    const tool = tools.find(item => item.name === "wemedia_get_job")!;
    const rendered = await tool.output.render({ jobId: "job:fixture" }, answer);
    expect(rendered[0]).toEqual({ type: "text", text: JSON.stringify(answer) });
    expect(rendered[1]).toMatchObject({ type: "text", text: expect.stringContaining("not waiting_user") });
    expect(answer).toEqual(job("running"));
  });
});

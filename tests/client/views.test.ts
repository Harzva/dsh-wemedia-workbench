import { describe, expect, it } from "vitest";
import { displayImportEvidence, workflowImportBlockingReason } from "../../src/client/views.tsx";

describe("Workflow import preview presentation", () => {
  it.each([
    ["", "未记录"],
    ["   ", "未记录"],
    [null, "未记录"],
    [undefined, "未记录"],
    ["sha256:bound", "sha256:bound"],
  ] as const)("shows an explicit placeholder for missing evidence value %j", (value, expected) => {
    expect(displayImportEvidence(value)).toBe(expected);
  });

  it("keeps a blocked import reason visible and human-readable", () => {
    const message = workflowImportBlockingReason(["WECHAT_ACCOUNT_UNAVAILABLE", "WORKFLOW_IMPORT_CHANGED"]);
    expect(message).toContain("确认暂不可用");
    expect(message).toContain("公众号账号不可用");
    expect(message).toContain("文章、材料、账号或草稿绑定已变化");
    expect(message).toContain("WECHAT_ACCOUNT_UNAVAILABLE");
    expect(message).toContain("请先处理后重新预览");
  });

  it("preserves an unknown gate code instead of inventing a reason", () => {
    expect(workflowImportBlockingReason(["FUTURE_IMPORT_GATE"])).toContain("FUTURE_IMPORT_GATE");
    expect(workflowImportBlockingReason([])).toBe("");
  });
});

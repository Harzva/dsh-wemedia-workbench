import { describe, expect, it, vi } from "vitest";
import { decodeWechatBridge, WECHAT_READBACK_CHECKS, WechatAdapter } from "../../src/adapters/wechat.ts";
import type { ArticleDocument } from "../../src/domain/workbench.ts";
import type { CommandSpec, ProcessResult, ProcessRunner } from "../../src/ports/process.ts";
const revision = `sha256:${"a".repeat(64)}`;
const envelope = { schemaVersion: "wemedia.wechat-bridge/v1", adapterVersion: "1.0.0", operation: "draft_create", configured: "configured", ok: true, code: "WECHAT_DRAFT_VERIFIED", issues: [], uploads: [], remoteWriteAttempted: true, remoteId: "UppercaseMediaID", revisionDigest: revision, verifiedAt: "2026-09-06T00:00:00.000Z", draftMode: "created", checks: Object.fromEntries(WECHAT_READBACK_CHECKS.map(key => [key, true])) };
describe("strict WeChat bridge decoder", () => {
  it("accepts only the current complete 20-check readback", () => {
    expect(decodeWechatBridge(JSON.stringify(envelope), "draft_create", revision)).toMatchObject({ ok: true, remoteId: "UppercaseMediaID" });
    const { present: _, ...checks } = envelope.checks;
    expect(decodeWechatBridge(JSON.stringify({ ...envelope, checks }), "draft_create", revision)).toMatchObject({ ok: false, reconcileRequired: true });
    expect(decodeWechatBridge(JSON.stringify({ ...envelope, draftMode: "updated" }), "draft_create", revision)).toMatchObject({ ok: false, code: "WECHAT_DRAFT_MODE_MISMATCH" });
  });
  it("rejects malformed output, stale revision, active URLs and unsupported versions", () => {
    expect(decodeWechatBridge("no JSON", "draft_create", revision)).toMatchObject({ ok: false, reconcileRequired: true });
    expect(decodeWechatBridge(JSON.stringify(envelope), "draft_create", `sha256:${"b".repeat(64)}`)).toMatchObject({ ok: false, code: "WECHAT_REVISION_CHANGED" });
    expect(decodeWechatBridge(JSON.stringify({ ...envelope, adapterVersion: "2.0.0" }), "draft_create", revision).ok).toBe(false);
    expect(decodeWechatBridge(JSON.stringify({ ...envelope, uploads: [{ source: "figure.png", sha256: "a".repeat(64), media_id: "Uppercase", wechat_url: "https://mmbiz.qpic.cn/image?access_token=secret" }] }), "draft_create", revision)).toMatchObject({ ok: false, code: "WECHAT_UPLOAD_MAP_INVALID" });
  });
  it("preserves known partial results without marking them retryable or verified", () => {
    const failure = decodeWechatBridge(JSON.stringify({ ...envelope, ok: false, code: "WECHAT_HTTP_FAILED", checks: undefined, reconcileRequired: true }), "draft_create", revision);
    expect(failure).toMatchObject({ ok: false, remoteId: "UppercaseMediaID", reconcileRequired: true });
    expect(decodeWechatBridge(JSON.stringify({ ...envelope, issues: [{ status: "block", code: "WECHAT_BAD" }] }), "draft_create", revision).ok).toBe(false);
  });
});

const accountRef = `wechat-account:${"a".repeat(32)}`;
const verifiedAt = "2026-09-07T00:00:00.000Z";
const readEnvelope = { schemaVersion: "wemedia.wechat-bridge/v1", adapterVersion: "1.0.0", configured: "configured", ok: true, issues: [], uploads: [], remoteWriteAttempted: false, revisionDigest: revision };
const aiEnvelope = { ...readEnvelope, operation: "ai_inspect", code: "WECHAT_AI_READY", mode: "ai", sourceKind: "markdown", status: "pass", previewFidelity: "exact" };
const identityEnvelope = { ...readEnvelope, operation: "draft_identity", code: "WECHAT_DRAFT_IDENTITY_VERIFIED", accountRef, remoteId: "ExactMediaID", verifiedAt, identityVerified: true };
const document: ArticleDocument = {
  contentRef: "wmc:11111111-1111-4111-8111-111111111111",
  document: { rootId: "articles", relativePath: "fixture/document.json" },
  htmlArtifact: { rootId: "articles", relativePath: "fixture/article.html" },
  metadata: { articleId: "fixture", title: "Current title", author: "Author", digest: "Safe digest", kind: "article", titlePrefix: "", sourceUrl: "https://example.org/article", pdfUrl: "", codeUrl: "" },
  html: "<p>Private draft HTML</p>", markdown: "# Private Markdown draft\n\nBody", revisionDigest: revision,
  assets: [], readOnlySource: false, reviews: [], targets: [], issues: [],
};
const identityTarget = { mediaId: "ExactMediaID", title: "Original imported title", sourceUrl: document.metadata.sourceUrl };
const signal = () => new AbortController().signal;
function processResult(stdout: unknown, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderrSummary: "", timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false, terminationSkipped: false, ...overrides };
}
function adapterFor(stdout: unknown, overrides: Partial<ProcessResult> = {}) {
  const run = vi.fn<ProcessRunner["run"]>().mockImplementation(async command => {
    const request = JSON.parse(command.stdinText!);
    return { ok: true, value: request.operation === "discover" ? processResult({ ...readEnvelope, operation: "discover", code: "WECHAT_READY", revisionDigest: undefined, accountRef }) : processResult(stdout, overrides) };
  });
  const privateState = vi.fn<ConstructorParameters<typeof WechatAdapter>[0]["privateState"]>(async () => ({ uploads: [] }));
  const command: CommandSpec = { executable: "fixture-runner", argv: ["bridge"], cwdRootId: "workflow", cwdRelativePath: ".", env: {}, timeoutMs: 100, maxOutputBytes: 4096 };
  const adapter = new WechatAdapter({ runner: { run }, command, roots: { articles: "/fixture/articles" }, privateState, now: () => verifiedAt });
  return { adapter, run, privateState, command };
}

describe("AI bridge decoder", () => {
  it.each(["ai_inspect", "ai_preview"] as const)("accepts safe %s scalars and drops native source, messages and paths", operation => {
    const result = decodeWechatBridge(JSON.stringify({ ...aiEnvelope, operation, html: "<p>private</p>", markdownText: "private text", output_file: "/fixture/private-output.html", issues: [{ status: "pass", code: "WECHAT_AI_READY", message: "private text" }] }), operation, revision);
    expect(result).toMatchObject({ ok: true, mode: "ai", sourceKind: "markdown", status: "pass", previewFidelity: "exact", revisionDigest: revision, reconcileRequired: false });
    expect(result.issues).toEqual([{ status: "pass", code: "WECHAT_AI_READY" }]);
    expect(JSON.stringify(result)).not.toMatch(/private|output_file|markdownText/u);
  });
  it("accepts downgraded HTML without treating it as a review pass", () => {
    expect(decodeWechatBridge(JSON.stringify({ ...aiEnvelope, sourceKind: "html", status: "warn", previewFidelity: "degraded", issues: [{ status: "warn", code: "WECHAT_AI_HTML_SOURCE" }] }), "ai_inspect", revision)).toMatchObject({ ok: true, status: "warn", previewFidelity: "degraded" });
  });
  it.each([
    { mode: "api" }, { sourceKind: "raw" }, { previewFidelity: "rendered" }, { status: "success" },
    { sourceKind: ["markdown"] }, { status: ["pass"] }, { previewFidelity: ["exact"] }, { configured: ["configured"] },
    { revisionDigest: undefined }, { revisionDigest: `sha256:${"b".repeat(64)}` },
    { adapterVersion: "2.0.0" }, { schemaVersion: "v2" }, { operation: "preflight" },
    { uploads: [{}] }, { remoteWriteAttempted: true }, { reconcileRequired: true },
    { issues: [{ status: "warn", code: "unsafe message with /path" }] },
    { issues: [{ status: ["pass"], code: "WECHAT_AI_READY" }] },
  ])("rejects unsafe or incomplete AI output %#", fields => {
    expect(decodeWechatBridge(JSON.stringify({ ...aiEnvelope, ...fields }), "ai_inspect", revision)).toMatchObject({ ok: false, reconcileRequired: false });
  });
  it.each([
    { sourceKind: "html" }, { previewFidelity: "degraded" }, { previewFidelity: "unavailable" },
    { status: "warn" }, { status: "block" }, { ok: false },
    { issues: [{ status: "block", code: "WECHAT_AI_FAILED" }] },
    { ok: false, sourceKind: "html", status: "block", issues: [{ status: "block", code: "WECHAT_AI_FAILED" }] },
  ])("rejects inconsistent AI status %#", fields => {
    expect(decodeWechatBridge(JSON.stringify({ ...aiEnvelope, ...fields }), "ai_inspect", revision)).toMatchObject({ ok: false, code: "WECHAT_RESULT_INCONSISTENT", reconcileRequired: false });
  });
  it("preserves a sanitized block result", () => {
    expect(decodeWechatBridge(JSON.stringify({ ...aiEnvelope, ok: false, code: "WECHAT_AI_FAILED", status: "block", previewFidelity: "unavailable", issues: [{ status: "block", code: "WECHAT_AI_FAILED" }] }), "ai_inspect", revision)).toMatchObject({ ok: false, status: "block", previewFidelity: "unavailable", reconcileRequired: false });
  });
  it.each([
    ["markdown", "exact"], ["markdown", "degraded"], ["html", "degraded"],
  ] as const)("preserves a quality block with completed %s/%s diagnostics", (sourceKind, previewFidelity) => {
    expect(decodeWechatBridge(JSON.stringify({ ...aiEnvelope, ok: false, sourceKind, code: "WECHAT_AI_BLOCKED", status: "block", previewFidelity, issues: [{ status: "block", code: "QUALITY_GAP" }] }), "ai_inspect", revision)).toMatchObject({ ok: false, sourceKind, status: "block", code: "WECHAT_AI_BLOCKED", previewFidelity, issues: [{ status: "block", code: "QUALITY_GAP" }], reconcileRequired: false });
  });
});

describe("draft identity decoder", () => {
  it("verifies identity without accepting it as complete draft content readback", () => {
    expect(decodeWechatBridge(JSON.stringify(identityEnvelope), "draft_identity", revision)).toMatchObject({ ok: true, identityVerified: true, remoteId: identityTarget.mediaId, accountRef, verifiedAt, revisionDigest: revision, reconcileRequired: false });
    for (const operation of ["draft_create", "draft_update", "sync"] as const) {
      expect(decodeWechatBridge(JSON.stringify({ ...identityEnvelope, operation, draftMode: operation === "draft_update" ? "updated" : "created" }), operation, revision)).toMatchObject({ ok: false, code: "WECHAT_READBACK_INCOMPLETE", reconcileRequired: operation !== "sync" });
    }
  });
  it.each([
    { identityVerified: false }, { identityVerified: "true" }, { identityVerified: undefined },
    { remoteId: undefined }, { remoteId: "../private" }, { remoteId: "target..id" },
    { accountRef: undefined }, { accountRef: "unsafe-account" },
    { verifiedAt: undefined }, { verifiedAt: "yesterday" }, { verifiedAt: "1" },
    { revisionDigest: undefined }, { revisionDigest: `sha256:${"b".repeat(64)}` },
    { remoteWriteAttempted: true }, { reconcileRequired: true }, { uploads: [{}] },
  ])("rejects incomplete or unsafe identity evidence %#", fields => {
    expect(decodeWechatBridge(JSON.stringify({ ...identityEnvelope, ...fields }), "draft_identity", revision)).toMatchObject({ ok: false, reconcileRequired: false });
  });
  it("does not reinterpret malformed read output as a remote write", () => {
    expect(decodeWechatBridge("not JSON", "draft_identity", revision)).toMatchObject({ ok: false, code: "WECHAT_JSON_INVALID", reconcileRequired: false });
  });
  it.each(["draft_create", "draft_update", "sync"] as const)("keeps the full check set strict for %s", operation => {
    const complete = { ...envelope, operation, draftMode: operation === "draft_update" ? "updated" : "created", remoteWriteAttempted: operation !== "sync" };
    expect(decodeWechatBridge(JSON.stringify(complete), operation, revision).ok).toBe(true);
    for (const checks of [{ ...complete.checks, extra: true }, { ...complete.checks, images_uploaded: false }, { ...complete.checks, images_uploaded: "true" }]) {
      expect(decodeWechatBridge(JSON.stringify({ ...complete, identityVerified: true, checks }), operation, revision)).toMatchObject({ ok: false, code: "WECHAT_READBACK_INCOMPLETE" });
    }
  });
});

describe("WeChat read-only extensions", () => {
  it.each(["ai_inspect", "ai_preview"] as const)("sends only private %s input and projects safe diagnostics", async operation => {
    const { adapter, run, privateState, command } = adapterFor({ ...aiEnvelope, operation });
    const result = await adapter.inspectAi(operation, document, signal());
    const sent = run.mock.calls[0]![0];
    expect(JSON.parse(sent.stdinText!)).toEqual({ schemaVersion: "wemedia.wechat-bridge/v1", operation, roots: { articles: "/fixture/articles" }, metadata: document.metadata, htmlArtifact: document.htmlArtifact, assets: document.assets, expectedRevision: revision, markdownText: document.markdown });
    expect(sent.argv).toEqual(command.argv);
    expect(privateState).not.toHaveBeenCalled();
    expect(result).toEqual({ operation, revisionDigest: revision, mode: "ai", sourceKind: "markdown", status: "pass", code: "WECHAT_AI_READY", previewFidelity: "exact", issues: [] });
    expect(JSON.stringify(result)).not.toMatch(/Private|\/fixture|htmlArtifact|markdownText/u);
  });
  it("reports HTML fallback as degraded and binds issues to the current revision", async () => {
    const { adapter } = adapterFor({ ...aiEnvelope, sourceKind: "html", status: "warn", previewFidelity: "degraded", issues: [{ status: "warn", code: "WECHAT_AI_HTML_SOURCE", message: "private native text", output_file: "/fixture/native.html" }] });
    const result = await adapter.inspectAi("ai_inspect", { ...document, markdown: " \n" }, signal());
    expect(result).toMatchObject({ sourceKind: "html", status: "warn", previewFidelity: "degraded", issues: [{ gateId: "wechat-ai", status: "warn", code: "WECHAT_AI_HTML_SOURCE", inputDigest: revision, evidenceRefs: [] }] });
    expect(JSON.stringify(result)).not.toMatch(/private native text|native.html/u);
  });
  it("cannot promote actual HTML input to a Markdown review pass", async () => {
    const { adapter } = adapterFor(aiEnvelope);
    expect(await adapter.inspectAi("ai_inspect", { ...document, markdown: "" }, signal())).toMatchObject({ sourceKind: "html", status: "block", code: "WECHAT_AI_SOURCE_MISMATCH", previewFidelity: "unavailable" });
  });
  it.each(["ai_inspect", "ai_preview"] as const)("retains native degraded diagnostics and quality blockers from %s", async operation => {
    const { adapter } = adapterFor({ ...aiEnvelope, operation, ok: false, code: "WECHAT_AI_BLOCKED", status: "block", previewFidelity: "degraded", issues: [{ status: "block", code: "QUALITY_GAP" }] }, { exitCode: 1 });
    expect(await adapter.inspectAi(operation, document, signal())).toMatchObject({ operation, status: "block", code: "WECHAT_AI_BLOCKED", previewFidelity: "degraded", issues: [{ gateId: "wechat-ai", status: "block", code: "QUALITY_GAP", inputDigest: revision }] });
  });
  it.each([{ cancelled: true }, { timedOut: true }])("clears quality diagnostic fidelity after interrupted execution %#", async overrides => {
    const { adapter } = adapterFor({ ...aiEnvelope, ok: false, code: "WECHAT_AI_BLOCKED", status: "block", previewFidelity: "degraded", issues: [{ status: "block", code: "QUALITY_GAP" }] }, overrides);
    expect(await adapter.inspectAi("ai_inspect", document, signal())).toMatchObject({ status: "block", code: "cancelled" in overrides ? "WECHAT_CANCELLED" : "WECHAT_TIMEOUT", previewFidelity: "unavailable" });
  });
  it("sends the exact imported identity without reading private draft state or uploading", async () => {
    const { adapter, run, privateState } = adapterFor(identityEnvelope);
    await adapter.discover(signal());
    expect(await adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: true, code: "WECHAT_DRAFT_IDENTITY_VERIFIED", accountRef, verifiedAt });
    const request = JSON.parse(run.mock.calls[1]![0].stdinText!);
    expect(request).toMatchObject({ operation: "draft_identity", target: identityTarget, accountRef, network: "drafts", expectedRevision: revision });
    expect(request).not.toHaveProperty("uploads");
    expect(request).not.toHaveProperty("markdownText");
    expect(privateState).not.toHaveBeenCalled();
  });
  it.each([
    [{ remoteId: "WrongMediaID" }, "WECHAT_DRAFT_IDENTITY_MISMATCH"],
    [{ accountRef: `wechat-account:${"b".repeat(32)}` }, "WECHAT_ACCOUNT_CHANGED"],
    [{ revisionDigest: `sha256:${"b".repeat(64)}` }, "WECHAT_REVISION_CHANGED"],
  ] as const)("rejects mismatched identity evidence %#", async (fields, code) => {
    const { adapter } = adapterFor({ ...identityEnvelope, ...fields });
    await adapter.discover(signal());
    expect(await adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: false, code });
  });
  it("blocks identity calls before discovery or with a different source URL", async () => {
    const { adapter, run, privateState } = adapterFor(identityEnvelope);
    expect(await adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: false, code: "WECHAT_ACCOUNT_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    await adapter.discover(signal());
    expect(await adapter.verifyDraftIdentity(document, { ...identityTarget, sourceUrl: "https://example.org/other" }, signal())).toEqual({ ok: false, code: "WECHAT_DRAFT_TARGET_INVALID" });
    expect(await adapter.verifyDraftIdentity(document, { ...identityTarget, mediaId: "../unsafe" }, signal())).toEqual({ ok: false, code: "WECHAT_DRAFT_TARGET_INVALID" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(privateState).not.toHaveBeenCalled();
  });
  it.each(["create_draft", "update_draft", "sync"] as const)("rejects changed target accounts before %s can reach the bridge", async action => {
    const { adapter, run, privateState } = adapterFor(envelope);
    await adapter.discover(signal());
    privateState.mockResolvedValueOnce({ target: identityTarget, uploads: [], accountRef: `wechat-account:${"b".repeat(32)}` });
    expect(await adapter.run(action, document, null, signal())).toMatchObject({ ok: false, code: "WECHAT_TARGET_ACCOUNT_CHANGED", reconcileRequired: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("allows a private target pinned to the current account", async () => {
    const { adapter, run, privateState } = adapterFor({ ...envelope, operation: "draft_update", draftMode: "updated" });
    await adapter.discover(signal());
    privateState.mockResolvedValueOnce({ target: identityTarget, uploads: [], accountRef });
    expect(await adapter.run("update_draft", document, null, signal())).toMatchObject({ ok: true, code: "WECHAT_DRAFT_VERIFIED" });
    expect(JSON.parse(run.mock.calls[1]![0].stdinText!)).toMatchObject({ target: identityTarget, accountRef, network: "drafts" });
  });
  it.each([
    [{ cancelled: true }, "WECHAT_CANCELLED"], [{ timedOut: true }, "WECHAT_TIMEOUT"],
    [{ stdoutTruncated: true }, "WECHAT_OUTPUT_TRUNCATED"], [{ exitCode: 1 }, "WECHAT_PROCESS_FAILED"],
  ] as const)("does not trust successful stdout after interrupted read operations %#", async (overrides, code) => {
    const ai = adapterFor(aiEnvelope, overrides);
    expect(await ai.adapter.inspectAi("ai_inspect", document, signal())).toMatchObject({ status: "block", code, previewFidelity: "unavailable", issues: [{ status: "block", code, inputDigest: revision }] });
    const identity = adapterFor(identityEnvelope, overrides);
    await identity.adapter.discover(signal());
    expect(await identity.adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: false, code });
    expect(identity.privateState).not.toHaveBeenCalled();
  });
  it("handles unavailable commands, process rejection and aborted signals safely", async () => {
    const unconfigured = new WechatAdapter({ roots: {}, privateState: async () => ({ uploads: [] }), now: () => verifiedAt });
    expect(await unconfigured.inspectAi("ai_preview", { ...document, markdown: "" }, signal())).toMatchObject({ status: "block", sourceKind: "html", code: "WECHAT_NOT_CONFIGURED", previewFidelity: "unavailable" });
    const { adapter, run } = adapterFor(aiEnvelope);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await adapter.inspectAi("ai_inspect", document, cancelled.signal)).toMatchObject({ status: "block", code: "WECHAT_CANCELLED" });
    expect(run).not.toHaveBeenCalled();
    run.mockRejectedValueOnce(new Error("private native failure"));
    expect(await adapter.inspectAi("ai_inspect", document, signal())).toMatchObject({ status: "block", code: "WECHAT_PROCESS_FAILED" });
    run.mockResolvedValueOnce({ ok: false, error: { code: "SCHEMA_INVALID_VALUE", safeMessage: "private native failure" } });
    expect(await adapter.inspectAi("ai_preview", document, signal())).toMatchObject({ status: "block", code: "WECHAT_PROCESS_FAILED" });
  });
  it("honors cancellation even when a runner neglects to flag its successful output", async () => {
    const cancelled = new AbortController();
    const { adapter, run } = adapterFor(aiEnvelope);
    run.mockImplementationOnce(async () => {
      cancelled.abort();
      return { ok: true, value: processResult(aiEnvelope) };
    });
    expect(await adapter.inspectAi("ai_inspect", document, cancelled.signal)).toMatchObject({ status: "block", code: "WECHAT_CANCELLED", previewFidelity: "unavailable" });
  });
  it("rejects identity evidence when discovery changes the current account during the call", async () => {
    const { adapter, run } = adapterFor(identityEnvelope);
    await adapter.discover(signal());
    run.mockImplementationOnce(async () => {
      run.mockResolvedValueOnce({ ok: true, value: processResult({ ...readEnvelope, operation: "discover", code: "WECHAT_READY", revisionDigest: undefined, accountRef: `wechat-account:${"b".repeat(32)}` }) });
      await adapter.discover(signal());
      return { ok: true, value: processResult(identityEnvelope) };
    });
    expect(await adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: false, code: "WECHAT_ACCOUNT_CHANGED" });
  });
  it("requires identity evidence to match both the requested and still-current account", async () => {
    const { adapter, run } = adapterFor(identityEnvelope);
    const changedAccount = `wechat-account:${"b".repeat(32)}`;
    await adapter.discover(signal());
    run.mockImplementationOnce(async () => {
      run.mockResolvedValueOnce({ ok: true, value: processResult({ ...readEnvelope, operation: "discover", code: "WECHAT_READY", revisionDigest: undefined, accountRef: changedAccount }) });
      await adapter.discover(signal());
      return { ok: true, value: processResult({ ...identityEnvelope, accountRef: changedAccount }) };
    });
    expect(await adapter.verifyDraftIdentity(document, identityTarget, signal())).toEqual({ ok: false, code: "WECHAT_ACCOUNT_CHANGED" });
  });
  it.each(["revision", "markdown"] as const)("rejects AI results when the supplied document %s changes in flight", async field => {
    const changing = structuredClone(document); const { adapter, run } = adapterFor(aiEnvelope);
    run.mockImplementationOnce(async () => {
      if (field === "revision") changing.revisionDigest = `sha256:${"b".repeat(64)}`;
      else changing.markdown = "# Different Markdown";
      return { ok: true, value: processResult(aiEnvelope) };
    });
    expect(await adapter.inspectAi("ai_inspect", changing, signal())).toMatchObject({ revisionDigest: revision, status: "block", code: "WECHAT_REVISION_CHANGED", previewFidelity: "unavailable", issues: [{ inputDigest: revision }] });
  });
  it.each(["target", "revision"] as const)("rejects identity evidence after the requested %s changes in flight", async field => {
    const changing = structuredClone(document), target = { ...identityTarget }; const { adapter, run } = adapterFor(identityEnvelope);
    await adapter.discover(signal());
    run.mockImplementationOnce(async () => {
      if (field === "target") target.title = "Another imported title";
      else changing.revisionDigest = `sha256:${"b".repeat(64)}`;
      return { ok: true, value: processResult(identityEnvelope) };
    });
    expect(await adapter.verifyDraftIdentity(changing, target, signal())).toEqual({ ok: false, code: field === "target" ? "WECHAT_DRAFT_IDENTITY_MISMATCH" : "WECHAT_REVISION_CHANGED" });
  });
});

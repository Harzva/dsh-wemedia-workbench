import { describe, expect, it, vi } from "vitest";
import { CHANNEL_BRIDGE_SCHEMA, ChannelBridgeAdapter, decodeChannelRemote, decodeChannelResult } from "../../src/adapters/channelBridge.ts";
import type { PublishingChannel } from "../../src/domain/channelPublishing.ts";
import type { ChannelBridgeResult, ChannelRemote, ChannelRunInput } from "../../src/ports/channelPublishing.ts";
import type { ProcessRunner } from "../../src/ports/process.ts";

const channels = ["zhihu", "xiaohongshu", "x"] as const;
const revision = `sha256:${"a".repeat(64)}`;
const contentDigest = `sha256:${"b".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const now = "2026-09-09T10:00:00.000Z";
const account = (channel: PublishingChannel) => `${channel}-account:${"1".repeat(32)}`;
const ids: Record<PublishingChannel, string[]> = {
  zhihu: ["123456789", "123456790", "123456791"],
  xiaohongshu: ["64b000000000000000000001", "64b000000000000000000002", "64b000000000000000000003"],
  x: ["1901234567890123456", "1901234567890123457", "1901234567890123458"],
};
function remote(channel: PublishingChannel, index = 0): ChannelRemote {
  const remoteId = ids[channel][index]!;
  return { remoteId, url: channel === "zhihu" ? `https://zhuanlan.zhihu.com/p/${remoteId}` : channel === "xiaohongshu" ? `https://www.xiaohongshu.com/explore/${remoteId}` : `https://x.com/i/web/status/${remoteId}`, contentDigest };
}
function input(channel: PublishingChannel, target?: ChannelRemote): ChannelRunInput {
  return {
    document: { contentRef: "wmc:11111111-1111-4111-8111-111111111111", publicationType: "image_text", revisionDigest: revision, title: "论文图文", body: "测试完整内容", html: "<p>测试完整内容</p>", coverSource: null, assets: [] },
    expectedAccountRef: account(channel), output: { rootId: "write", relativePath: "operation-123" }, ...(target ? { target } : {}),
  };
}
function operationInput(channel: PublishingChannel, operation: string): ChannelRunInput {
  return input(channel, operation === "sync" || channel === "zhihu" && operation === "publish" ? remote(channel) : undefined);
}
type Envelope = ChannelBridgeResult & { schemaVersion: string; adapterVersion: string; channel: PublishingChannel; operation: string };
function success(channel: PublishingChannel, operation: string): Envelope {
  const result: Envelope = { schemaVersion: CHANNEL_BRIDGE_SCHEMA, adapterVersion: "1.0.0", channel, operation, ok: true, code: "CHANNEL_VERIFIED", configured: "configured", permission: "unknown", remoteWriteAttempted: false, reconcileRequired: false, issues: [], artifacts: [] };
  if (operation === "discover") return { ...result, configured: "unknown" };
  if (operation === "preflight") return { ...result, accountRef: account(channel), revisionDigest: revision };
  if (operation === "prepare" || operation === "stage" && channel !== "zhihu") return { ...result, status: operation === "prepare" ? "prepared" : "manual_handoff", revisionDigest: revision, artifacts: [{ rootId: "write", relativePath: "operation-123/content.json", digest: contentDigest }] };
  return { ...result, accountRef: account(channel), revisionDigest: revision, verifiedAt: now, remote: remote(channel), status: operation === "stage" ? "draft" : "published", remoteWriteAttempted: operation !== "sync" };
}
function failure(channel: PublishingChannel, operation: string, attempted: boolean): Envelope {
  return { schemaVersion: CHANNEL_BRIDGE_SCHEMA, adapterVersion: "1.0.0", channel, operation, ok: false, code: "CHANNEL_RESPONSE_UNKNOWN", configured: "configured", status: "reconcile_required", remoteWriteAttempted: attempted, reconcileRequired: true, issues: [{ code: "CHANNEL_RESPONSE_UNKNOWN", status: "block" }], artifacts: [], remote: remote(channel) };
}

describe("channel bridge remote identity", () => {
  it.each(channels)("accepts canonical %s work URLs with exact final IDs", channel => {
    const value = remote(channel);
    expect(decodeChannelRemote(channel, value)).toEqual(value);
    if (channel === "zhihu") expect(decodeChannelRemote(channel, { ...value, url: `${value.url}/edit` })).toMatchObject({ remoteId: value.remoteId });
    if (channel === "xiaohongshu") expect(decodeChannelRemote(channel, { ...value, url: `https://xiaohongshu.com/discovery/item/${value.remoteId}` })).toMatchObject({ remoteId: value.remoteId });
    if (channel === "x") expect(decodeChannelRemote(channel, { ...value, url: `https://twitter.com/research_team/status/${value.remoteId}` })).toMatchObject({ remoteId: value.remoteId });
  });
  it.each([
    ["zhihu", "p"], ["zhihu", "0"], ["zhihu", "0123"], ["zhihu", "123.5"], ["zhihu", "-123"],
    ["x", "status"], ["x", "research_team"], ["x", "0"], ["x", "123e4"], ["x", "9".repeat(31)],
    ["xiaohongshu", "explore"], ["xiaohongshu", "64B000000000000000000001"], ["xiaohongshu", "b".repeat(23)], ["xiaohongshu", "b".repeat(25)], ["xiaohongshu", "g".repeat(24)],
  ] as const)("rejects %s remote ID %s even when it occurs in a valid URL", (channel, remoteId) => {
    expect(decodeChannelRemote(channel, { ...remote(channel), remoteId })).toBeUndefined();
  });
  it.each(channels)("rejects a valid %s ID paired with another work's URL", channel => {
    expect(decodeChannelRemote(channel, { ...remote(channel), url: remote(channel, 1).url })).toBeUndefined();
  });
  it.each(channels)("rejects ambiguous or noncanonical %s URLs before binding", channel => {
    const value = remote(channel), url = new URL(value.url!);
    const unsafe = [
      `${url.origin}:8443${url.pathname}`, `${url.origin}:443${url.pathname}`, ` ${url.href}`, `${url.href} `,
      `${url.origin}/unrelated/..${url.pathname}`, `${url.origin}${url.pathname}/.`,
      `${url.href}?token=private`, `${url.href}#fragment`, url.href.replace("https://", "http://"),
      url.href.replace("https://", "https://user:password@"), url.href.replace(url.host, `${url.host}.example.com`),
    ];
    for (const candidate of unsafe) expect(decodeChannelRemote(channel, { ...value, url: candidate }), candidate).toBeUndefined();
  });
  it.each(channels)("requires a unique ordered %s ID list starting at the primary ID", channel => {
    const value = { ...remote(channel), remoteIds: [...ids[channel]] };
    expect(decodeChannelRemote(channel, value)).toEqual(value);
    for (const remoteIds of [[], [ids[channel][1]!], [ids[channel][0]!, ids[channel][0]!], [ids[channel][0]!, "status"]]) {
      expect(decodeChannelRemote(channel, { ...value, remoteIds })).toBeUndefined();
    }
  });
});

describe("channel bridge operation and verification boundaries", () => {
  it.each(channels)("preserves valid %s discover, preflight, prepare, stage, publish and sync contracts", channel => {
    for (const operation of ["discover", "preflight", "prepare", "stage", "publish", "sync"]) {
      const request = operation === "discover" ? undefined : operationInput(channel, operation);
      const envelope = success(channel, operation);
      const { schemaVersion: _schema, adapterVersion: _version, channel: _channel, operation: _operation, ...expected } = envelope;
      expect(decodeChannelResult(envelope, channel, operation, request)).toEqual(expected);
    }
  });
  it("accepts a read-only confirmed Zhihu draft sync", () => {
    const envelope = { ...success("zhihu", "sync"), status: "draft" };
    expect(decodeChannelResult(envelope, "zhihu", "sync", input("zhihu", remote("zhihu")))).toMatchObject({ ok: true, status: "draft", remoteWriteAttempted: false });
  });
  it.each(["xiaohongshu", "x"] as const)("does not invent a remote draft capability for %s sync", channel => {
    expect(() => decodeChannelResult({ ...success(channel, "sync"), status: "draft" }, channel, "sync", input(channel, remote(channel)))).toThrow();
  });
  it.each(["publish", "sync"])("rejects a Zhihu editor URL as proof of a published work during %s", operation => {
    const draft = { ...remote("zhihu"), url: `${remote("zhihu").url}/edit` };
    expect(() => decodeChannelResult({ ...success("zhihu", operation), remote: draft }, "zhihu", operation, input("zhihu", draft))).toThrow();
  });
  it.each(channels)("does not allow a successful %s stage to claim publication", channel => {
    const forged = { ...success(channel, "publish"), operation: "stage" };
    expect(() => decodeChannelResult(forged, channel, "stage", input(channel))).toThrow();
  });
  it.each(["xiaohongshu", "x"] as const)("keeps %s stage a local manual handoff", channel => {
    const stage = success(channel, "stage");
    for (const patch of [
      { status: "draft", accountRef: account(channel), revisionDigest: revision, verifiedAt: now, remote: remote(channel) },
      { remoteWriteAttempted: true }, { remote: remote(channel) }, { verifiedAt: now }, { status: "prepared" },
    ]) expect(() => decodeChannelResult({ ...stage, ...patch }, channel, "stage", input(channel))).toThrow();
  });
  it("requires a verified remote Zhihu draft and content readback proof for stage", () => {
    const stage = success("zhihu", "stage");
    for (const patch of [{ status: "manual_handoff" }, { status: "prepared" }, { remoteWriteAttempted: false }, { remote: { remoteId: ids.zhihu[0], url: remote("zhihu").url } }]) {
      expect(() => decodeChannelResult({ ...stage, ...patch }, "zhihu", "stage", input("zhihu"))).toThrow();
    }
  });
  it.each(channels)("requires %s publish to report a verified publication and a write attempt", channel => {
    for (const patch of [{ status: "draft" }, { status: "manual_handoff" }, { status: undefined }, { remoteWriteAttempted: false }]) {
      expect(() => decodeChannelResult({ ...success(channel, "publish"), ...patch }, channel, "publish", operationInput(channel, "publish"))).toThrow();
    }
  });
  it.each(channels)("keeps %s sync read-only and rejects local preparation masquerading as verification", channel => {
    for (const patch of [{ remoteWriteAttempted: true }, { status: "prepared" }, { status: undefined }, { artifacts: success(channel, "prepare").artifacts }]) {
      expect(() => decodeChannelResult({ ...success(channel, "sync"), ...patch }, channel, "sync", input(channel, remote(channel)))).toThrow();
    }
  });
  it.each(channels)("never accepts an unbound or mismatched %s account on verified results", channel => {
    for (const operation of ["publish", "sync", ...(channel === "zhihu" ? ["stage"] : [])]) {
      for (const binding of ["missing_expected", "missing_returned", "missing_both", "wrong_returned"] as const) {
        const request = operationInput(channel, operation), envelope = success(channel, operation);
        if (binding === "missing_expected" || binding === "missing_both") delete request.expectedAccountRef;
        if (binding === "missing_returned" || binding === "missing_both") delete envelope.accountRef;
        if (binding === "wrong_returned") envelope.accountRef = `${channel}-account:${"2".repeat(32)}`;
        expect(() => decodeChannelResult(envelope, channel, operation, request), `${operation}: ${binding}`).toThrow();
      }
    }
  });
  it.each(channels)("requires the current revision, URL and verification timestamp for %s publication", channel => {
    for (const patch of [{ revisionDigest: undefined }, { revisionDigest: otherDigest }, { verifiedAt: undefined }, { verifiedAt: "unverified" }, { remote: { remoteId: ids[channel][0] } }]) {
      expect(() => decodeChannelResult({ ...success(channel, "publish"), ...patch }, channel, "publish", operationInput(channel, "publish"))).toThrow();
    }
  });
  it.each(channels)("does not allow successful %s results to remain uncertain or blocked", channel => {
    for (const operation of ["discover", "preflight", "prepare", "stage", "publish", "sync"]) {
      for (const patch of [{ reconcileRequired: true }, { status: "reconcile_required" }, { issues: [{ code: "VERIFICATION_MISSING", status: "block" }] }]) {
        expect(() => decodeChannelResult({ ...success(channel, operation), ...patch }, channel, operation, operation === "discover" ? undefined : operationInput(channel, operation))).toThrow();
      }
    }
  });
});

describe("channel bridge existing target binding and uncertain outcomes", () => {
  it.each([["zhihu", "publish"], ["zhihu", "sync"], ["xiaohongshu", "sync"], ["x", "sync"]] as const)("requires an explicit target for successful %s %s", (channel, operation) => {
    expect(() => decodeChannelResult(success(channel, operation), channel, operation, input(channel))).toThrow();
  });
  it.each(channels)("binds successful %s publish and sync to the exact existing primary ID", channel => {
    for (const operation of ["publish", "sync"]) {
      const request = input(channel, remote(channel));
      expect(() => decodeChannelResult({ ...success(channel, operation), remote: remote(channel, 1) }, channel, operation, request)).toThrow();
      expect(() => decodeChannelResult({ ...success(channel, operation), remote: undefined }, channel, operation, request)).toThrow();
    }
  });
  it.each(channels)("preserves every bound %s ID in order during successful publish and sync", channel => {
    const target = { ...remote(channel), remoteIds: [...ids[channel]] };
    for (const operation of ["publish", "sync"]) {
      expect(decodeChannelResult({ ...success(channel, operation), remote: target }, channel, operation, input(channel, target)).remote).toEqual(target);
      for (const remoteIds of [undefined, [ids[channel][0]!], [ids[channel][0]!, ids[channel][2]!, ids[channel][1]!]]) {
        expect(() => decodeChannelResult({ ...success(channel, operation), remote: { ...target, remoteIds } }, channel, operation, input(channel, target))).toThrow();
      }
    }
  });
  it.each(["publish", "sync"])("requires %s to retain the already bound Zhihu content digest", operation => {
    const target = remote("zhihu");
    for (const digest of [undefined, otherDigest]) {
      expect(() => decodeChannelResult({ ...success("zhihu", operation), remote: { ...target, contentDigest: digest } }, "zhihu", operation, input("zhihu", target))).toThrow();
    }
  });
  it.each(channels)("retains legal %s publication recovery targets even when no write was observed", channel => {
    for (const attempted of [false, true]) {
      const envelope = failure(channel, "publish", attempted), request = input(channel, remote(channel));
      const decoded = decodeChannelResult(envelope, channel, "publish", request);
      expect(decoded).toMatchObject({ ok: false, status: "reconcile_required", reconcileRequired: true, remoteWriteAttempted: attempted, remote: remote(channel) });
      delete envelope.status;
      expect(decodeChannelResult(envelope, channel, "publish", request).remote).toEqual(remote(channel));
    }
  });
  it("retains a Zhihu draft recovery target after an uncertain stage with either write observation", () => {
    for (const attempted of [false, true]) {
      expect(decodeChannelResult(failure("zhihu", "stage", attempted), "zhihu", "stage", input("zhihu"))).toMatchObject({ ok: false, remoteWriteAttempted: attempted, reconcileRequired: true, remote: remote("zhihu") });
    }
  });
  it("allows a partial X thread recovery result without claiming the complete thread succeeded", () => {
    const target = { ...remote("x"), remoteIds: [...ids.x] }, partial = { ...remote("x"), remoteIds: [ids.x[0]!] };
    expect(decodeChannelResult({ ...failure("x", "publish", true), remote: partial }, "x", "publish", input("x", target))).toMatchObject({ ok: false, reconcileRequired: true, remote: partial });
  });
  it.each(channels)("rejects an unrelated %s recovery target despite an uncertain failure", channel => {
    expect(() => decodeChannelResult({ ...failure(channel, "publish", true), remote: remote(channel, 1) }, channel, "publish", input(channel, remote(channel)))).toThrow();
  });
  it.each(channels)("does not bind a %s recovery target to a different observed account", channel => {
    const result = { ...failure(channel, "publish", true), accountRef: `${channel}-account:${"2".repeat(32)}` };
    expect(() => decodeChannelResult(result, channel, "publish", input(channel, remote(channel)))).toThrow();
  });
  it.each(channels)("allows read-only %s reconciliation failure while preserving the known target", channel => {
    expect(decodeChannelResult(failure(channel, "sync", false), channel, "sync", input(channel, remote(channel)))).toMatchObject({ ok: false, reconcileRequired: true, remoteWriteAttempted: false, remote: remote(channel) });
  });
});

describe("channel bridge process boundary", () => {
  it.each([["zhihu", "publish"], ["zhihu", "sync"], ["xiaohongshu", "sync"], ["x", "sync"]] as const)("does not spawn a process for %s %s without its required target", async (channel, operation) => {
    const run = vi.fn<ProcessRunner["run"]>();
    const adapter = new ChannelBridgeAdapter(channel, { runner: { run }, roots: {}, now: () => now, command: { executable: "fixture-only", argv: [], cwdRootId: "write", cwdRelativePath: ".", env: {}, timeoutMs: 1000, maxOutputBytes: 100000 } });
    const request = { ...input(channel), authorization: { action: "publish" as const, inputDigest: revision, reference: "native:fixture" } };
    expect(await adapter.run(operation, request, new AbortController().signal)).toMatchObject({ ok: false, code: "CHANNEL_TARGET_REQUIRED", remoteWriteAttempted: false, reconcileRequired: false });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["publish", "sync"] as const)("turns a forged %s result into a safe protocol failure", async operation => {
    const forged = { ...success("x", operation), remote: remote("x", 1), debugCookie: "private-value-must-not-escape" };
    const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue({ ok: true, value: { exitCode: 0, signal: null, stdout: JSON.stringify(forged), stderrSummary: "", timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false, terminationSkipped: false } });
    const adapter = new ChannelBridgeAdapter("x", { runner: { run }, roots: { write: "/unused-fixture-root" }, now: () => now, command: { executable: "fixture-only", argv: [], cwdRootId: "write", cwdRelativePath: ".", env: {}, timeoutMs: 1000, maxOutputBytes: 100000 } });
    const request = { ...input("x", remote("x")), authorization: { action: "publish" as const, inputDigest: revision, reference: "native:fixture" } };
    const result = await adapter.run(operation, request, new AbortController().signal);
    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false, code: "CHANNEL_PROTOCOL_INVALID", configured: "unknown", remoteWriteAttempted: operation === "publish", reconcileRequired: operation === "publish", issues: [{ code: "CHANNEL_PROTOCOL_INVALID", status: "block" }], artifacts: [] });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
});

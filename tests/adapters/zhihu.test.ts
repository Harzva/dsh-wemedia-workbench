import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZhihuAdapter } from "../../src/adapters/zhihu.ts";
import type { ChannelDocument } from "../../src/ports/channelPublishing.ts";
import type { ProcessRunner } from "../../src/ports/process.ts";
import { externalBridge } from "./external-bridge.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const bridgeConfig = externalBridge("WEMEDIA_TEST_ZHIHU_BRIDGE");
const bridge = bridgeConfig.enabled ? bridgeConfig.path : "";
const runner: ProcessRunner = { run(command, signal) { return new Promise((resolve, reject) => {
  const child = spawn(command.executable, command.argv, { env: {}, signal, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.resume();
  child.once("error", reject); child.once("close", exitCode => resolve({ ok: true, value: { exitCode, signal: null, stdout, stderrSummary: "", timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false, terminationSkipped: false } }));
  child.stdin.end(command.stdinText);
}); } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zhihu-adapter-")); directories.push(directory);
  const source = join(directory, "source"), write = join(directory, "write"); await mkdir(source); await mkdir(write);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZSAAAAAASUVORK5CYII=", "base64");
  await writeFile(join(source, "image.png"), png);
  const document: ChannelDocument = { contentRef: "wmc:11111111-1111-4111-8111-111111111111", publicationType: "image_text", revisionDigest: `sha256:${"a".repeat(64)}`, title: "知乎图文测试", body: "这是具有完整文字说明的本地准备测试正文，确认现有内容不会被改写。", html: "", coverSource: "image.png", assets: [{ source: "image.png", artifact: { rootId: "source", relativePath: "image.png" }, digest: `sha256:${createHash("sha256").update(png).digest("hex")}`, bytes: png.length, mediaType: "image/png" }] };
  const adapter = new ZhihuAdapter({ runner, roots: { source, write }, now: () => "2026-09-09T00:00:00.000Z", command: { executable: process.execPath, argv: [bridge], cwdRootId: "source", cwdRelativePath: ".", env: {}, timeoutMs: 10000, maxOutputBytes: 100000 } });
  return { source, write, document, adapter, png };
}

const suite = bridgeConfig.enabled ? describe : describe.skip;
suite("Zhihu actual independent local bridge (explicit external bridge)", () => {
  it("preflights and prepares the complete image pack using stdin, with no account or source writes", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    expect((await f.adapter.preflight(f.document, false, signal, "stage")).ok).toBe(true);
    const result = await f.adapter.run("prepare", { document: f.document, output: { rootId: "write", relativePath: "prepared" } }, signal);
    expect(result).toMatchObject({ ok: true, status: "prepared", remoteWriteAttempted: false, reconcileRequired: false });
    expect(result.artifacts).toHaveLength(2);
    expect(await readFile(join(f.write, "prepared/image-1.png"))).toEqual(f.png);
    expect(await readdir(f.source)).toEqual(["image.png"]);
    expect(await readFile(join(f.source, "image.png"))).toEqual(f.png);
    expect((await f.adapter.run("prepare", { document: f.document, output: { rootId: "write", relativePath: "prepared" } }, signal)).code).toBe("ZHIHU_OUTPUT_EXISTS");
  });
  it("requires native approval for both remote draft creation and publish; video is unavailable", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    for (const action of ["stage", "publish"] as const) expect(await f.adapter.run(action, { document: f.document }, signal)).toMatchObject({ ok: false, code: "CHANNEL_APPROVAL_REQUIRED", remoteWriteAttempted: false });
    for (const action of ["preflight", "prepare", "stage", "publish", "sync"] as const) expect(f.adapter.supports("video", action)).toBe(false);
    expect(f.adapter.supports("image_text", "stage")).toBe(true);
  });
  it("rejects approval for another revision inside the real bridge before reading the account", async () => {
    const f = await fixture();
    const result = await f.adapter.run("stage", { document: f.document, expectedAccountRef: `zhihu-account:${"1".repeat(32)}`, authorization: { action: "stage", inputDigest: `sha256:${"b".repeat(64)}`, reference: "native:fixture" }, output: { rootId: "write", relativePath: "prepared" } }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, code: "ZHIHU_APPROVAL_REQUIRED", remoteWriteAttempted: false, reconcileRequired: false });
    expect(await readdir(f.write)).toEqual([]);
  });
});

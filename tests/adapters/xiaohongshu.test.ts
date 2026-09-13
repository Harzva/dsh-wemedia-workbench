import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XiaohongshuAdapter } from "../../src/adapters/xiaohongshu.ts";
import type { ChannelDocument } from "../../src/ports/channelPublishing.ts";
import type { ProcessRunner } from "../../src/ports/process.ts";
import { externalBridge } from "./external-bridge.ts";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const bridgeConfig = externalBridge("WEMEDIA_TEST_XHS_BRIDGE");
const bridge = bridgeConfig.enabled ? bridgeConfig.path : "";
const runner: ProcessRunner = { run(command, signal) { return new Promise((resolve, reject) => {
  const child = spawn(command.executable, command.argv, { env: { PATH: process.env.PATH ?? "" }, signal, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.resume();
  child.once("error", reject); child.once("close", exitCode => resolve({ ok: true, value: { exitCode, signal: null, stdout, stderrSummary: "", timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false, terminationSkipped: false } }));
  child.stdin.end(command.stdinText);
}); } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "xhs-adapter-")); directories.push(directory);
  const source = join(directory, "source"), write = join(directory, "write"); await mkdir(source); await mkdir(write);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZSAAAAAASUVORK5CYII=", "base64");
  await writeFile(join(source, "image.png"), png);
  const document: ChannelDocument = { contentRef: "wmc:fixture", publicationType: "image_text", revisionDigest: `sha256:${"a".repeat(64)}`, title: "图文测试", body: "本地准备测试正文", html: "", coverSource: "image.png", assets: [{ source: "image.png", artifact: { rootId: "source", relativePath: "image.png" }, digest: `sha256:${createHash("sha256").update(png).digest("hex")}`, bytes: png.length, mediaType: "image/png" }] };
  const adapter = new XiaohongshuAdapter({ runner, roots: { source, write }, now: () => "2026-09-09T00:00:00.000Z", command: { executable: process.execPath, argv: [bridge], cwdRootId: "source", cwdRelativePath: ".", env: {}, timeoutMs: 10000, maxOutputBytes: 100000 } });
  return { directory, source, write, document, adapter, png };
}
const suite = bridgeConfig.enabled ? describe : describe.skip;
suite("Xiaohongshu actual local bridge integration (explicit external bridge)", () => {
  it("discovers protocol and makes a manual image pack through actual stdin without changing source", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    expect((await f.adapter.discover(signal)).configured).toBe("configured");
    expect((await f.adapter.preflight(f.document, false, signal)).ok).toBe(true);
    const result = await f.adapter.run("stage", { document: f.document, output: { rootId: "write", relativePath: "handoff" } }, signal);
    expect(result).toMatchObject({ ok: true, status: "manual_handoff", remoteWriteAttempted: false, reconcileRequired: false });
    expect(result.artifacts).toHaveLength(3);
    expect(await readFile(join(f.write, "handoff/media-0.png"))).toEqual(f.png);
    expect(await readdir(f.source)).toEqual(["image.png"]);
  });
  it("rejects missing approval before spawning publish and keeps article manual-only", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const result = await f.adapter.run("publish", { document: f.document }, signal);
    expect(result).toMatchObject({ ok: false, code: "CHANNEL_APPROVAL_REQUIRED", remoteWriteAttempted: false });
    expect(f.adapter.supports("article", "publish")).toBe(false);
    expect(f.adapter.supports("article", "stage")).toBe(true);
    expect(f.adapter.supports("video", "publish")).toBe(true);
  });
});

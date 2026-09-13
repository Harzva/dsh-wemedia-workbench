import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecureProcessRunner } from "../../src/infrastructure/processRunner.ts";
import { createRootCapability } from "../../src/infrastructure/pathPolicy.ts";
import { redactText } from "../../src/infrastructure/redaction.ts";

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe("bounded bridge stdin", () => {
  it("passes bounded JSON on stdin, not argv or inherited environment", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wm-bridge-input-")); dirs.push(dir);
    const root = await createRootCapability({ id: "workspace", label: "Workspace", path: dir, mode: "read" });
    if (!root.ok) throw new Error("fixture unavailable");
    const runner = new SecureProcessRunner({ roots: [root.value], executables: { node: { path: process.execPath, allowedEnvKeys: [] } }, maxInputBytes: 256 });
    const spec = { executable: "node", argv: ["-e", "let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>console.log(JSON.stringify({value:JSON.parse(x).value,argCount:process.argv.length})))"], cwdRootId: "workspace", cwdRelativePath: "", env: {}, timeoutMs: 2000, maxOutputBytes: 4096, stdinText: JSON.stringify({ value: "literal ; $(nothing)" }) };
    const result = await runner.run(spec, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    if (result.ok) expect(JSON.parse(result.value.stdout)).toEqual({ value: "literal ; $(nothing)", argCount: 1 });
    expect(await runner.run({ ...spec, stdinText: "x".repeat(257) }, new AbortController().signal)).toMatchObject({ ok: false, error: { details: { reasonCode: "PROCESS_INPUT_LIMIT_INVALID" } } });
  });
  it("redacts absolute filesystem paths without corrupting native CDN or artifact URLs", () => {
    const url = "https://mmbiz.qpic.cn/mmbiz_png/abc123/0?wx_fmt=png";
    expect(redactText(JSON.stringify({ url, relativePath: "batch/article/assets/figure.png" }))).toBe(JSON.stringify({ url, relativePath: "batch/article/assets/figure.png" }));
    expect(redactText("failure at /private/example/file.txt")).toBe("failure at [REDACTED_PATH]");
  });
});

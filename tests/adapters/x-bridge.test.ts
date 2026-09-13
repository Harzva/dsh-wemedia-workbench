import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelBridgeResult, ChannelDocument } from "../../src/ports/channelPublishing.ts";
import { decodeChannelResult } from "../../src/adapters/channelBridge.ts";
import { XAdapter } from "../../src/adapters/x.ts";
import { externalBridge } from "./external-bridge.ts";

type XBridgeModule = {
  handleRequest: (input: unknown, dependencies?: object) => Promise<ChannelBridgeResult>;
  splitPosts: (text: string) => string[];
};
const bridge = externalBridge("WEMEDIA_TEST_X_BRIDGE");
const bridgeModule = bridge.enabled ? await import(/* @vite-ignore */ bridge.url) as XBridgeModule : undefined;
const bridgePath = bridge.enabled ? bridge.path : "";
const unavailable = (): never => { throw new Error("WEMEDIA_TEST_X_BRIDGE is not enabled"); };
const handleRequest: XBridgeModule["handleRequest"] = bridgeModule?.handleRequest ?? unavailable;
const splitPosts: XBridgeModule["splitPosts"] = bridgeModule?.splitPosts ?? unavailable;
const folders: string[] = [];
const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const account = `x-account:${createHash("sha256").update("x-user:12345").digest("hex").slice(0, 32)}`;
const now = () => "2026-09-09T00:00:00.000Z";
const schema = "wemedia.channel-bridge/v1";
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "wemedia-x-protocol-")); folders.push(directory);
  const roots = { source: resolve(directory, "source"), write: resolve(directory, "write") };
  await Promise.all(Object.values(roots).map(path => mkdir(path)));
  const document: ChannelDocument = { contentRef: "wmc:11111111-1111-4111-8111-111111111111", publicationType: "article", revisionDigest: digest("fixture-revision"), title: "Synthetic X fixture", body: "An explicitly approved synthetic post.", html: "", assets: [], coverSource: null };
  const output = { rootId: "write", relativePath: "jobs/x-fixture" };
  const authorization = { action: "publish", inputDigest: document.revisionDigest, reference: "fixture-approval" };
  const request = (operation: string, extra: object = {}) => ({ schemaVersion: schema, channel: "x", operation, roots, network: "disabled", ...(operation === "discover" ? {} : { document }), ...extra });
  const publish = () => request("publish", { network: "enabled", expectedAccountRef: account, output, authorization });
  const posts = new Map<string, Record<string, unknown>>();
  const media = new Map<string, string>();
  const calls: Array<{ url: string; method: string; options: RequestInit }> = [];
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const api = async (url: string, options: RequestInit = {}) => {
    calls.push({ url, method: options.method ?? "GET", options });
    const u = new URL(url);
    if (u.pathname === "/2/users/me") return respond({ data: { id: "12345" } });
    if (u.pathname === "/2/media/upload/initialize") { const id = String(9000 + media.size); media.set(id, `3_${id}`); return respond({ data: { id, media_key: media.get(id) } }); }
    if (u.pathname.endsWith("/append")) return new Response(null, { status: 204 });
    if (u.pathname.endsWith("/finalize")) return respond({ data: { id: u.pathname.split("/").at(-2) } });
    if (u.pathname === "/2/tweets" && options.method === "POST") {
      const payload = JSON.parse(String(options.body)); const id = String(1000 + posts.size);
      posts.set(id, { id, author_id: "12345", text: payload.text, referenced_tweets: payload.reply ? [{ type: "replied_to", id: payload.reply.in_reply_to_tweet_id }] : [], attachments: { media_keys: (payload.media?.media_ids ?? []).map((key: string) => media.get(key)) } });
      return respond({ data: { id, text: payload.text } });
    }
    if (u.pathname.startsWith("/2/tweets/")) return respond({ data: posts.get(u.pathname.split("/").at(-1)!) });
    return respond({ title: "fixture unsupported request" }, 400);
  };
  const credentialPresence = vi.fn(async () => true);
  const loadCredential = vi.fn(async () => ({ token: "synthetic-token-only", scopes: ["tweet.read", "tweet.write", "users.read", "media.write"] }));
  const dependencies = { credentialPresence, loadCredential, fetch: api, now, sleep: async () => {} };
  const asset = async (source: string, mediaType = "image/png", length = 32) => {
    const bytes = Buffer.alloc(length, 1);
    if (mediaType === "video/mp4") bytes.write("ftyp", 4); else Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    await writeFile(resolve(roots.source, source), bytes);
    const item = { source, artifact: { rootId: "source", relativePath: source }, digest: digest(bytes), mediaType, bytes: bytes.length };
    document.assets.push(item); return item;
  };
  return { directory, roots, document, output, authorization, request, publish, posts, media, calls, respond, api, dependencies, asset };
}

const suite = bridge.enabled ? describe : describe.skip;
suite("X independent real bridge protocol (explicit external bridge)", () => {
  it.each([false, true])("discovers local entry with credentials present=%s without reading them or using network", async present => {
    const f = await fixture(); f.dependencies.credentialPresence.mockResolvedValue(present);
    const result = await handleRequest(f.request("discover"), f.dependencies);
    expect(result).toMatchObject({ ok: true, configured: present ? "unknown" : "missing", permission: "unknown", remoteWriteAttempted: false });
    expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it("runs the actual stdin/stdout CLI in a read-only discover invocation", async () => {
    const f = await fixture();
    const run = spawnSync(process.execPath, [bridgePath], { input: JSON.stringify(f.request("discover")), encoding: "utf8", timeout: 5000 });
    expect(run.status).toBe(0); expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ schemaVersion: schema, channel: "x", operation: "discover", remoteWriteAttempted: false, permission: "unknown" });
  });
  it("preflights HTML-only articles without account or inventory writes", async () => {
    const f = await fixture(); f.document.body = ""; f.document.html = "<p>A reviewed source-only article.</p>";
    expect(await handleRequest(f.request("preflight"), f.dependencies)).toMatchObject({ ok: true, code: "X_OFFLINE_PREFLIGHT_OK", permission: "unknown" });
    expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it.each(["prepare", "stage"])("%s only creates a bounded local handoff and never opens or posts", async operation => {
    const f = await fixture(); f.document.publicationType = "image_text"; const asset = await f.asset("fixture.png");
    const result = await handleRequest(f.request(operation, { output: f.output }), f.dependencies);
    expect(result).toMatchObject({ ok: true, status: operation === "stage" ? "manual_handoff" : "prepared", remoteWriteAttempted: false });
    const packageData = JSON.parse(await readFile(resolve(f.roots.write, f.output.relativePath, "x-thread.json"), "utf8"));
    expect(packageData.status).toBe("prepared"); expect(packageData.posts[0].sources).toEqual([asset.source]);
    expect(digest(await readFile(resolve(f.roots.write, f.output.relativePath, "media-1.png")))).toBe(asset.digest);
    expect(f.calls).toEqual([]); expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(await readdir(f.roots.source)).toEqual(["fixture.png"]);
    expect(decodeChannelResult(result, "x", operation, { document: f.document, output: f.output }).ok).toBe(true);
  });
  it("keeps whole URLs and emoji graphemes while preparing explicit threads", () => {
    const url = "https://example.org/source";
    const posts = splitPosts("文".repeat(120) + " " + url + " " + "👨‍👩‍👧‍👦".repeat(30));
    expect(posts.join("").replaceAll(" ", "")).toBe("文".repeat(120) + url + "👨‍👩‍👧‍👦".repeat(30));
    expect(posts.filter(post => post.includes(url))).toHaveLength(1);
    expect(posts.every(post => !post.startsWith("\u200d") && !post.endsWith("\u200d"))).toBe(true);
  });
  it("counts every short URL using its conservative 23-character allowance", () => {
    const posts = splitPosts("https://x.co ".repeat(20));
    expect(posts).toHaveLength(2);
    expect(posts.map(post => post.split(" ").length)).toEqual([10, 10]);
  });
  it("rejects missing authorization before any credential or network access", async () => {
    const f = await fixture(); const request = f.publish(); delete (request as { authorization?: unknown }).authorization;
    expect(await handleRequest(request, f.dependencies)).toMatchObject({ ok: false, code: "X_APPROVAL_REQUIRED", remoteWriteAttempted: false });
    expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it("binds authorization to the exact current document revision before account access", async () => {
    const f = await fixture(); f.authorization.inputDigest = digest("obsolete-approved-revision");
    expect(await handleRequest(f.publish(), f.dependencies)).toMatchObject({ ok: false, code: "X_AUTHORIZATION_REVISION_CHANGED", remoteWriteAttempted: false });
    expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it("does not infer write permission from successful online account identity", async () => {
    const f = await fixture();
    expect(await handleRequest(f.request("preflight", { network: "enabled" }), f.dependencies)).toMatchObject({ ok: true, code: "X_ONLINE_IDENTITY_VERIFIED", accountRef: account, configured: "configured", permission: "unknown", remoteWriteAttempted: false });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe("GET"); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it.each(["prepare", "stage", "publish", "sync"])("accepts the shared action-specific %s preflight without running that action", async action => {
    const f = await fixture();
    expect(await handleRequest(f.request("preflight", { action }), f.dependencies)).toMatchObject({ ok: true, remoteWriteAttempted: false, permission: "unknown" });
    expect(f.calls).toEqual([]); expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it("blocks known missing write scope in online publish preflight without any POST", async () => {
    const f = await fixture(); const loadCredential = async () => ({ token: "fixture-read-only", scopes: ["tweet.read", "users.read"] });
    expect(await handleRequest(f.request("preflight", { action: "publish", network: "enabled" }), { ...f.dependencies, loadCredential })).toMatchObject({ ok: false, code: "X_PERMISSION_MISSING", permission: "missing", remoteWriteAttempted: false });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe("GET");
  });
  it.each(["disabled", "account", "scope"])("blocks a %s publish gate without POST", async gate => {
    const f = await fixture(); const input = f.publish();
    if (gate === "disabled") input.network = "disabled";
    if (gate === "account") Object.assign(input, { expectedAccountRef: `x-account:${"b".repeat(32)}` });
    const deps = gate === "scope" ? { ...f.dependencies, loadCredential: async () => ({ token: "fixture-readonly", scopes: ["tweet.read", "users.read"] }) } : f.dependencies;
    const result = await handleRequest(input, deps);
    expect(result.ok).toBe(false); expect(result.remoteWriteAttempted).toBe(false); expect(f.calls.filter(call => call.method === "POST")).toEqual([]);
    expect(await readdir(f.roots.write)).toEqual([]);
  });
  it("publishes only after per-ID readback and keeps exact IDs in the safe envelope", async () => {
    const f = await fixture(); f.document.body = "A".repeat(700);
    const result = await handleRequest(f.publish(), f.dependencies);
    expect(result).toMatchObject({ ok: true, code: "X_POSTS_VERIFIED", status: "published", accountRef: account, verifiedAt: now(), remoteWriteAttempted: true, reconcileRequired: false, remote: { remoteId: "1000", url: "https://x.com/i/web/status/1000", remoteIds: ["1000", "1001", "1002"] } });
    expect(f.calls.filter(call => call.url.includes("/2/tweets/") && call.method === "GET")).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
    expect(decodeChannelResult(result, "x", "publish", { document: f.document, expectedAccountRef: account, output: f.output, authorization: { ...f.authorization, action: "publish" } }).ok).toBe(true);
  });
  it("uploads image bytes with dedicated v2 endpoints and syncs media provenance with GET only", async () => {
    const f = await fixture(); f.document.publicationType = "image_text"; await f.asset("a.png"); await f.asset("b.png");
    const published = await handleRequest(f.publish(), f.dependencies);
    expect(published.ok).toBe(true); expect(published.remote?.contentDigest).toMatch(/^sha256:/u);
    expect(f.calls.filter(call => call.url.endsWith("/initialize"))).toHaveLength(2);
    const before = f.calls.length;
    const synced = await handleRequest(f.request("sync", { network: "enabled", expectedAccountRef: account, target: published.remote }), f.dependencies);
    expect(synced).toMatchObject({ ok: true, status: "published", remoteWriteAttempted: false });
    expect(f.calls.slice(before).every(call => call.method === "GET")).toBe(true);
    const pathsBefore = await readdir(f.roots.write);
    const unproven = await handleRequest(f.request("sync", { network: "enabled", expectedAccountRef: account, target: { remoteId: "1000" } }), f.dependencies);
    expect(unproven).toMatchObject({ ok: false, code: "X_MEDIA_PROVENANCE_REQUIRED", remoteWriteAttempted: false });
    expect(await readdir(f.roots.write)).toEqual(pathsBefore);
  });
  it("uploads video in 4MiB segments and waits for bounded processing before posting", async () => {
    const f = await fixture(); f.document.publicationType = "video"; await f.asset("fixture.mp4", "video/mp4", 4 * 1024 * 1024 + 100);
    const fetch = async (url: string, options: RequestInit) => {
      if (url.endsWith("/finalize")) { f.calls.push({ url, method: "POST", options }); return f.respond({ data: { id: "9000", processing_info: { state: "pending", check_after_secs: 1 } } }); }
      if (url.includes("command=STATUS")) { f.calls.push({ url, method: "GET", options }); return f.respond({ data: { id: "9000", processing_info: { state: "succeeded" } } }); }
      return f.api(url, options);
    };
    expect(await handleRequest(f.publish(), { ...f.dependencies, fetch })).toMatchObject({ ok: true, status: "published" });
    const chunks = f.calls.filter(call => call.url.endsWith("/append")); expect(chunks).toHaveLength(2);
    expect(chunks.map(call => (call.options.body as FormData).get("segment_index"))).toEqual(["0", "1"]);
    expect(chunks.map(call => ((call.options.body as FormData).get("media") as Blob).size)).toEqual([4 * 1024 * 1024, 100]);
    expect(f.calls.findIndex(call => call.url.includes("command=STATUS"))).toBeLessThan(f.calls.findIndex(call => call.url.endsWith("/2/tweets")));
  });
  it("stops on partial append results without finalizing or creating a post", async () => {
    const f = await fixture(); f.document.publicationType = "image_text"; await f.asset("a.png");
    const fetch = async (url: string, options: RequestInit) => url.endsWith("/append") ? f.respond({ data: { id: "9000" }, errors: [{ detail: "synthetic append failed" }] }) : f.api(url, options);
    expect(await handleRequest(f.publish(), { ...f.dependencies, fetch })).toMatchObject({ ok: false, code: "X_API_PARTIAL_RESPONSE", status: "reconcile_required", remoteWriteAttempted: true });
    expect(f.calls.some(call => call.url.endsWith("/finalize") || call.url.endsWith("/2/tweets"))).toBe(false);
  });
  it("keeps media provenance when post creation succeeds but readback fails, allowing GET-only reconciliation", async () => {
    const f = await fixture(); f.document.publicationType = "image_text"; await f.asset("a.png");
    const fetch = async (url: string, options: RequestInit) => url.includes("/2/tweets/") ? f.respond({ detail: "synthetic readback unavailable" }, 503) : f.api(url, options);
    const result = await handleRequest(f.publish(), { ...f.dependencies, fetch });
    expect(result).toMatchObject({ ok: false, status: "reconcile_required", remote: { remoteId: "1000", contentDigest: expect.stringMatching(/^sha256:/u) } });
    const before = f.calls.length;
    expect(await handleRequest(f.request("sync", { network: "enabled", expectedAccountRef: account, target: result.remote }), f.dependencies)).toMatchObject({ ok: true, status: "published", remoteWriteAttempted: false });
    expect(f.calls.slice(before).every(call => call.method === "GET")).toBe(true); expect(f.posts.size).toBe(1);
  });
  it.each(["text", "author", "reply", "media"])("never marks a %s readback mismatch published", async mismatch => {
    const f = await fixture();
    const fetch = async (url: string, options: RequestInit) => {
      if (url.includes("/2/tweets/")) {
        const data = { ...f.posts.get("1000") };
        if (mismatch === "text") data.text = "Unexpected public content";
        if (mismatch === "author") data.author_id = "99999";
        if (mismatch === "reply") data.referenced_tweets = [{ type: "replied_to", id: "555" }];
        if (mismatch === "media") data.attachments = { media_keys: ["3_555"] };
        return f.respond({ data });
      }
      return f.api(url, options);
    };
    const result = await handleRequest(f.publish(), { ...f.dependencies, fetch });
    expect(result).toMatchObject({ ok: false, status: "reconcile_required", reconcileRequired: true, remote: { remoteId: "1000" } });
    expect(f.calls.filter(call => call.url.endsWith("/2/tweets"))).toHaveLength(1);
  });
  it("preserves earlier IDs on partial thread failure and refuses the same output attempt", async () => {
    const f = await fixture(); f.document.body = "A".repeat(600);
    const fetch = async (url: string, options: RequestInit) => url.endsWith("/2/tweets") && f.posts.size ? f.respond({ detail: "synthetic-private-error-must-not-leak" }, 503) : f.api(url, options);
    const result = await handleRequest(f.publish(), { ...f.dependencies, fetch });
    expect(result).toMatchObject({ ok: false, code: "X_SERVER_ERROR", reconcileRequired: true, remote: { remoteId: "1000", remoteIds: ["1000"] } });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
    const count = f.posts.size;
    expect(await handleRequest(f.publish(), f.dependencies)).toMatchObject({ ok: false, code: "X_ATTEMPT_ALREADY_STARTED", remoteWriteAttempted: false });
    expect(f.posts.size).toBe(count);
  });
  it("retains an ID even when the same API response also contains errors", async () => {
    const f = await fixture();
    const fetch = async (url: string, options: RequestInit) => url.endsWith("/2/tweets") ? f.respond({ data: { id: "1000" }, errors: [{ detail: "fixture partial" }] }) : f.api(url, options);
    expect(await handleRequest(f.publish(), { ...f.dependencies, fetch })).toMatchObject({ ok: false, code: "X_API_PARTIAL_RESPONSE", reconcileRequired: true, remote: { remoteId: "1000" } });
  });
  it("treats a timed-out POST as unknown and does not resend", async () => {
    const f = await fixture(); let writes = 0;
    const fetch = async (url: string, options: RequestInit) => {
      if (!url.endsWith("/2/tweets")) return f.api(url, options);
      writes++;
      return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("fixture timeout")), { once: true }));
    };
    expect(await handleRequest(f.publish(), { ...f.dependencies, fetch, requestTimeoutMs: 5 })).toMatchObject({ ok: false, code: "X_TIMEOUT", reconcileRequired: true });
    expect(writes).toBe(1);
  });
  it("does not access credentials or network when cancelled before execution", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await handleRequest(f.publish(), { ...f.dependencies, signal: controller.signal })).toMatchObject({ ok: false, code: "X_CANCELLED", remoteWriteAttempted: false });
    expect(f.dependencies.loadCredential).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it("rejects changed asset bytes before network and leaves source inventory untouched", async () => {
    const f = await fixture(); const asset = await f.asset("fixture.png");
    await writeFile(resolve(f.roots.source, "fixture.png"), Buffer.alloc(asset.bytes, 4));
    expect(await handleRequest(f.publish(), f.dependencies)).toMatchObject({ ok: false, code: "X_ASSET_CHANGED", remoteWriteAttempted: false });
    expect(f.calls).toEqual([]); expect(await readdir(f.roots.write)).toEqual([]);
  });
  it("rejects source and output symlinks without escaping configured roots", async () => {
    const f = await fixture(); await f.asset("fixture.png"); const outside = resolve(f.directory, "outside"); await mkdir(outside);
    await symlink(outside, resolve(f.roots.write, "escape"));
    expect(await handleRequest(f.request("prepare", { output: { rootId: "write", relativePath: "escape/child" } }), f.dependencies)).toMatchObject({ ok: false, code: "X_PATH_UNSAFE" });
    expect(await readdir(outside)).toEqual([]);
    await rm(resolve(f.roots.source, "fixture.png")); await symlink(resolve(f.roots.write, "escape"), resolve(f.roots.source, "fixture.png"));
    expect(await handleRequest(f.request("preflight"), f.dependencies)).toMatchObject({ ok: false, code: "X_PATH_UNSAFE" });
  });
  it("keeps the thin adapter's channel identity and media capabilities", () => {
    const adapter = new XAdapter({ roots: {}, now });
    expect(adapter.channel).toBe("x"); expect(adapter.supports("video", "publish")).toBe(true); expect(adapter.supports("article", "stage")).toBe(true);
  });
});

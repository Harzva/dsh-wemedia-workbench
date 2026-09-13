import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiAccountLogins, createWechatAccountChecker, createXAccountChecker } from "../../src/infrastructure/accountApiLogin.ts";
import type { ApiAccountLoginDependencies } from "../../src/infrastructure/accountApiLogin.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
const signal = () => new AbortController().signal;
const token = { access_token: "SYNTHETIC_NEW_ACCESS", refresh_token: "SYNTHETIC_NEW_REFRESH", token_type: "bearer", expires_in: 7200, scope: "tweet.read tweet.write users.read media.write offline.access" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function freePort() { const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture port"); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return address.port; }

async function fixture(dependencies: ApiAccountLoginDependencies = {}, config = "") {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "wemedia-api-login-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const project = resolve(directory, "publisher"), src = resolve(project, "src"), secret = resolve(directory, "secrets.json"); await mkdir(src, { recursive: true });
  for (const name of ["wemedia_bridge.mjs", "oauth.js", "store.js", "config.js"]) await writeFile(resolve(src, name), "// fixture; never imported or executed\n");
  const port = await freePort(), redirect = `http://127.0.0.1:${port}/oauth/x/callback`;
  const envFile = resolve(project, ".env.local"); await writeFile(envFile, `X_CLIENT_ID=synthetic-client\nX_CLIENT_SECRET=SYNTHETIC_CLIENT_SECRET\nX_REDIRECT_URI=${redirect}\nX_PUBLISHER_SECRET_FILE=${secret}\n${config}`);
  const original = JSON.stringify({ version: 1, other: { preserved: true }, x: { access_token: "SYNTHETIC_OLD_ACCESS", refresh_token: "SYNTHETIC_OLD_REFRESH" } }); await writeFile(secret, original, { mode: 0o600 });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(token), { status: 200 }));
  const drivers = await createApiAccountLogins({ adapters: { x: { enabled: true, command: resolve(src, "wemedia_bridge.mjs") } }, privateDir: resolve(directory, "private") }, { environment: {}, fetch, ...dependencies });
  const driver = drivers.x!; cleanup.push(() => driver.dispose());
  return { directory, src, secret, original, driver, drivers, fetch, redirect, envFile };
}
function callback(redirect: string, authorization: string, fields: Record<string, string> = {}) { const url = new URL(redirect); url.searchParams.set("state", new URL(authorization).searchParams.get("state")!); url.searchParams.set("code", "synthetic-code"); for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value); return url; }

describe("API account login reuse", () => {
  it("shows WeChat configuration guidance and never starts a QR or browser login", async () => {
    const f = await fixture(), driver = f.drivers.wechat!;
    expect(driver).toMatchObject({ kind: "configuration", supported: false });
    const login = await driver.start("login:wechat", signal()); expect(login).toMatchObject({ status: "unsupported", channel: "wechat" }); expect(login.message).toContain("AppID / Secret"); expect(login.url).toBeUndefined();
    expect(await readFile(f.secret, "utf8")).toBe(f.original); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("exchanges the exact PKCE session once and saves the original secret location atomically with owner-only permissions", async () => {
    const f = await fixture(), login = await f.driver.start("login:x", signal());
    expect(login.status).toBe("pending"); expect(await readFile(f.secret, "utf8")).toBe(f.original);
    const authorization = new URL(login.url!); expect(authorization.origin + authorization.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(authorization.searchParams.get("redirect_uri")).toBe(f.redirect); expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await fetch(callback(f.redirect, login.url!))).status).toBe(200);
    const current = await f.driver.poll(login, signal()); expect(current).toMatchObject({ status: "ready" }); expect(current.url).toBeUndefined();
    expect(f.fetch).toHaveBeenCalledTimes(1); const [url, request] = f.fetch.mock.calls[0]!; expect(url).toBe("https://api.x.com/2/oauth2/token"); expect(request).toMatchObject({ method: "POST", redirect: "error" });
    const form = request!.body as URLSearchParams; expect(form.get("code")).toBe("synthetic-code"); expect(form.get("redirect_uri")).toBe(f.redirect);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
    expect(JSON.parse(await readFile(f.secret, "utf8"))).toMatchObject({ other: { preserved: true }, x: { access_token: token.access_token, refresh_token: token.refresh_token } });
    expect((await stat(f.secret)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify([login, current])).not.toMatch(/SYNTHETIC_|code_verifier|secrets\.json/u);
    await f.driver.cancel(login); expect((await f.driver.poll(login, signal())).status).toBe("ready");
  });

  it("rejects a foreign state and duplicate starts without consuming the valid pending authorization", async () => {
    const f = await fixture(), login = await f.driver.start("login:first", signal());
    expect((await f.driver.start("login:second", signal())).status).toBe("failed");
    expect((await fetch(callback(f.redirect, login.url!, { state: "foreign" }))).status).toBe(400);
    expect((await f.driver.poll(login, signal())).status).toBe("pending"); expect(f.fetch).not.toHaveBeenCalled();
    expect((await fetch(callback(f.redirect, login.url!))).status).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("consumes the state before awaiting exchange and ignores a late token response after cancellation", async () => {
    const response = deferred<Response>(), entered = deferred<void>();
    const transport = vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(); return response.promise; });
    const f = await fixture({ fetch: transport }), login = await f.driver.start("login:cancel", signal());
    const first = fetch(callback(f.redirect, login.url!)).catch(() => undefined); await entered.promise;
    expect((await fetch(callback(f.redirect, login.url!))).status).toBe(400); expect(transport).toHaveBeenCalledTimes(1);
    await f.driver.cancel(login); response.resolve(new Response(JSON.stringify(token))); await first;
    await vi.waitFor(() => expect((transport.mock.results[0]?.type)).toBe("return"));
    expect((await f.driver.poll(login, signal())).status).toBe("cancelled"); expect(await readFile(f.secret, "utf8")).toBe(f.original);
  });

  it("expires, closes its callback listener, and permits a fresh session without changing credentials", async () => {
    const f = await fixture({ timeoutMs: 30 }), login = await f.driver.start("login:expiry", signal());
    await vi.waitFor(async () => expect((await f.driver.poll(login, signal())).status).toBe("expired"));
    expect((await f.driver.start("login:retry", signal())).status).toBe("pending"); expect(await readFile(f.secret, "utf8")).toBe(f.original); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("disposes while a start is awaiting configuration without leaving a callback listener behind", async () => {
    const f = await fixture(), starting = f.driver.start("login:disposed", signal()); await f.driver.dispose();
    expect((await starting).status).toBe("cancelled");
    const listener = createServer(); await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(Number(new URL(f.redirect).port), "127.0.0.1", done); });
    await new Promise<void>(done => listener.close(() => done())); expect(await readFile(f.secret, "utf8")).toBe(f.original); expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["external-change", "malformed-token", "symlink"] as const)("preserves credentials after %s rather than claiming a saved authorization", async mode => {
    const f = await fixture(), login = await f.driver.start(`login:${mode}`, signal()); let expected = f.original;
    if (mode === "external-change") { expected = JSON.stringify({ x: { access_token: "OTHER_SYNTHETIC_LOGIN" } }); await writeFile(f.secret, expected); }
    if (mode === "malformed-token") f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...token, access_token: "invalid\nsecret" })));
    if (mode === "symlink") { const alternate = resolve(f.directory, "other-secret.json"); await writeFile(alternate, f.original); await rm(f.secret); await symlink(alternate, f.secret); }
    expect((await fetch(callback(f.redirect, login.url!))).status).toBe(400);
    const result = await f.driver.poll(login, signal()); expect(result.status).toBe("failed"); expect(await readFile(f.secret, "utf8")).toBe(expected); expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|secret|\/tmp/u);
  });

  it("does not reuse another account's refresh token when a new authorization omits one", async () => {
    const f = await fixture(); const { refresh_token: _refresh, ...accessOnly } = token; f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(accessOnly)));
    const login = await f.driver.start("login:no-refresh", signal()); await fetch(callback(f.redirect, login.url!));
    expect(JSON.parse(await readFile(f.secret, "utf8")).x.refresh_token).toBe("");
  });

  it.each(["X_AUTHORIZE_URL=https://example.org/steal\n", "X_REDIRECT_URI=http://example.org/oauth/x/callback\n"])("rejects an unsafe authorization configuration without opening a listener", async config => {
    const f = await fixture(); await writeFile(f.envFile, `X_CLIENT_ID=synthetic-client\n${config}`);
    const login = await f.driver.start("login:invalid-config", signal()); expect(login.status).toBe("failed"); expect(login.url).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled(); expect(await readFile(f.secret, "utf8")).toBe(f.original);
  });

  it("reports a busy callback port without disrupting its current listener", async () => {
    const f = await fixture(), occupied = createServer((_req, res) => res.end("existing fixture"));
    await new Promise<void>(done => occupied.listen(Number(new URL(f.redirect).port), "127.0.0.1", done)); cleanup.push(() => new Promise<void>(done => occupied.close(() => done())));
    expect((await f.driver.start("login:busy", signal())).status).toBe("failed"); expect(await (await fetch(f.redirect)).text()).toBe("existing fixture"); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps configured WeChat credentials explicitly unverified and drops unrelated bridge fields", async () => {
    const f = await fixture(), command = resolve(f.directory, "wemedia_bridge.mjs");
    await writeFile(command, `let input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);if(request.operation!=='discover')process.exit(2);process.stdout.write(JSON.stringify({schemaVersion:'wemedia.wechat-bridge/v1',operation:'discover',ok:true,configured:'configured',accountRef:'wechat-account:${"a".repeat(32)}',token:'SYNTHETIC_MUST_NOT_LEAK'}));`);
    const result = await createWechatAccountChecker({ enabled: true, command })(signal());
    expect(result).toMatchObject({ status: "unchecked", present: true, permission: "unknown" }); expect(result.message).toContain("未提供独立只读在线账号核验"); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_MUST_NOT_LEAK"); expect(f.fetch).not.toHaveBeenCalled();
    expect(await createWechatAccountChecker(undefined)(signal())).toMatchObject({ status: "not_configured", present: false });
  });
});

describe("X read-only account identity check", () => {
  async function setup() {
    const f = await fixture();
    const source = JSON.stringify({ version: 1, x: { access_token: "SYNTHETIC_ACCOUNT_TOKEN", refresh_token: "SYNTHETIC_NEVER_REFRESH", expires_at: new Date(Date.now() + 3600_000).toISOString() } }); await writeFile(f.secret, source);
    const transport = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { id: "1234567890123456789", username: "DO_NOT_EXPOSE_ACCOUNT_NAME" } })));
    const check = createXAccountChecker({ enabled: true, command: resolve(f.src, "wemedia_bridge.mjs") }, { environment: {}, fetch: transport });
    return { ...f, source, transport, check };
  }
  it("identifies an unexpired token through one fixed GET and emits only the existing bridge's fingerprint", async () => {
    const f = await setup(), result = await f.check(signal());
    expect(result).toMatchObject({ status: "ready", present: true, permission: "unknown", accountRef: `x-account:${createHash("sha256").update("x-user:1234567890123456789").digest("hex").slice(0, 32)}` });
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.transport.mock.calls[0]).toMatchObject(["https://api.x.com/2/users/me", { method: "GET", redirect: "error" }]);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|1234567890123456789|DO_NOT_EXPOSE|\.json/u); expect(await readFile(f.secret, "utf8")).toBe(f.source);
  });
  it("returns expired without network or refresh even when a refresh token is available", async () => {
    const f = await setup(), source = JSON.stringify({ x: { access_token: "SYNTHETIC_EXPIRED", refresh_token: "SYNTHETIC_NEVER_REFRESH", expires_at: "2020-01-01T00:00:00Z" } }); await writeFile(f.secret, source);
    expect(await f.check(signal())).toMatchObject({ status: "expired", present: true, permission: "unknown" }); expect(f.transport).not.toHaveBeenCalled(); expect(await readFile(f.secret, "utf8")).toBe(source);
  });
  it.each([{ code: 401, status: "login_required", permission: "unknown" }, { code: 403, status: "error", permission: "missing" }, { code: 402, status: "error", permission: "unknown" }, { code: 429, status: "error", permission: "unknown" }, { code: 503, status: "error", permission: "unknown" }])("maps HTTP $code without leaking its payload or deleting credentials", async ({ code, status, permission }) => {
    const f = await setup(); f.transport.mockResolvedValueOnce(new Response("SYNTHETIC_PRIVATE_PLATFORM_ERROR", { status: code }));
    const result = await f.check(signal()); expect(result).toMatchObject({ status, permission, present: true }); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE"); expect(await readFile(f.secret, "utf8")).toBe(f.source);
  });
  it.each(["network", "invalid-identity", "partial-result", "invalid-expiry", "symlink"] as const)("does not present $s as a verified identity", async mode => {
    const f = await setup();
    if (mode === "network") f.transport.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_NETWORK_DETAIL"));
    if (mode === "invalid-identity") f.transport.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "bad-identity" } })));
    if (mode === "partial-result") f.transport.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "12345" }, errors: [{ message: "SYNTHETIC_PRIVATE_ERROR" }] })));
    if (mode === "invalid-expiry") await writeFile(f.secret, JSON.stringify({ x: { access_token: "SYNTHETIC_TOKEN", expires_at: "invalid" } }));
    if (mode === "symlink") { const alternate = resolve(f.directory, "other-account.json"); await writeFile(alternate, f.source); await rm(f.secret); await symlink(alternate, f.secret); }
    const before = await readFile(f.secret, "utf8"), result = await f.check(signal()); expect(result.status).toBe("error"); expect(result.accountRef).toBeUndefined(); expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|bad-identity/u); expect(await readFile(f.secret, "utf8")).toBe(before);
    if (mode === "invalid-expiry" || mode === "symlink") expect(f.transport).not.toHaveBeenCalled();
  });
});

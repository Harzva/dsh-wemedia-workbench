import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountLogin } from "../../src/domain/accounts.ts";
import type { AccountLoginDriver } from "../../src/ports/accounts.ts";
import { createInteractiveAccountLogins } from "../../src/infrastructure/accountLogin.ts";

const fake = vi.hoisted(() => ({ launch: vi.fn(), require: vi.fn(), beforeCommit: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:module", async original => ({ ...await original<typeof import("node:module")>(), createRequire: () => fake.require }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]).includes(".wemedia-login-")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); await fake.beforeCommit?.(); };
    }
    return handle;
  } };
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=";
const cookie = (value: string) => ({ name: "z_c0", value, domain: ".zhihu.com", path: "/", httpOnly: true, secure: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;
let directory: string;
const drivers: AccountLoginDriver[] = [];
const http = vi.fn<typeof fetch>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wemedia-account-login-"));
  for (const name of ["XHS_MCP_URL", "XHS_MCP_HOST", "XHS_MCP_PORT", "XHS_MCP_AUTH_TOKEN"]) vi.stubEnv(name, "");
  vi.stubGlobal("fetch", http); http.mockReset(); fake.launch.mockReset(); fake.require.mockReset(); fake.beforeCommit = undefined;
  fake.require.mockReturnValue({ chromium: { launch: fake.launch } });
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map(driver => driver.dispose()));
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function driver(channel: "xiaohongshu" | "zhihu") {
  const folder = join(directory, channel); await mkdir(folder, { recursive: true });
  const command = join(folder, "wemedia_bridge.mjs"); await writeFile(command, "export {};\n");
  const result = (await createInteractiveAccountLogins({ adapters: { [channel]: { enabled: true, command } }, privateDir: join(directory, "private") }))[channel]!;
  drivers.push(result); return { driver: result, folder, cookies: join(folder, "cookies.json") };
}
async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => realSleep(resolve, 2));
  expect(predicate()).toBe(true);
}
function browser(cookies = [cookie("fresh_session")]) {
  const context = { cookies: vi.fn().mockResolvedValue(cookies), newPage: vi.fn().mockResolvedValue({ goto: vi.fn().mockResolvedValue(undefined) }) };
  const instance = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
  fake.launch.mockResolvedValue(instance); return { instance, context };
}
async function waitForWindow() { await eventually(() => fake.launch.mock.calls.length === 1); await new Promise(resolve => realSleep(resolve, 5)); }
async function settled(driver: AccountLoginDriver, login: AccountLogin) {
  let result = login;
  for (let i = 0; i < 100 && result.status === "pending"; i++) { result = await driver.poll(login, signal()); if (result.status === "pending") await new Promise(resolve => realSleep(resolve, 2)); }
  return result;
}

describe("local Xiaohongshu QR login", () => {
  it("does nothing until the human starts, returns only a bounded raster QR, then verifies stable identity", async () => {
    vi.stubEnv("XHS_MCP_AUTH_TOKEN", "private_service_token");
    const { driver: login } = await driver("xiaohongshu");
    expect(http).not.toHaveBeenCalled();
    http.mockResolvedValueOnce(json({ success: true, data: { is_logged_in: false, timeout: "4m0s", img: PNG, cookie_path: "/private/should-not-escape" } }));
    const pending = await login.start("login:qr", signal());
    expect(pending).toMatchObject({ status: "pending", kind: "qr", qrDataUrl: PNG });
    expect(JSON.stringify(pending)).not.toMatch(/private_service_token|cookie_path|should-not-escape/u);
    expect(String(http.mock.calls[0]![0])).toBe("http://127.0.0.1:18060/api/v1/login/qrcode");
    expect(http.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer private_service_token" } });
    http.mockResolvedValueOnce(json({ success: true, data: { is_logged_in: true, user_id: "a".repeat(24), username: "private_account_label" } }));
    const ready = await login.poll(pending, signal());
    expect(ready.status).toBe("ready"); expect(ready.qrDataUrl).toBeUndefined();
    expect(JSON.stringify(ready)).not.toContain("private_account_label");
    expect(http.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });

  it.each(["https://example.com/mcp", "http://localhost:18060/mcp", "http://127.0.0.1:18060/mcp?token=secret", "http://user:secret@127.0.0.1:18060/mcp", "http://127.0.0.1:18060/other"])("rejects endpoint %s before contacting it", async endpoint => {
    vi.stubEnv("XHS_MCP_URL", endpoint);
    const { driver: login } = await driver("xiaohongshu");
    expect(login.supported).toBe(false); expect((await login.start("login:bad", signal())).status).toBe("unsupported");
    expect(http).not.toHaveBeenCalled(); expect(login.message).not.toContain(endpoint);
  });

  it.each(["https://remote.invalid/qr.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,PHNjcmlwdD5ib29tPC9zY3JpcHQ+"])("does not expose an untrusted QR source", async img => {
    const { driver: login } = await driver("xiaohongshu");
    http.mockResolvedValue(json({ success: true, data: { is_logged_in: false, timeout: "4m0s", img } }));
    const failed = await login.start("login:bad-image", signal());
    expect(failed.status).toBe("failed"); expect(failed.qrDataUrl).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain(img);
  });

  it("retains an already logged-in account and refuses a ready claim without a stable identity", async () => {
    const { driver: login } = await driver("xiaohongshu");
    http.mockResolvedValueOnce(json({ success: true, data: { is_logged_in: true, timeout: "0s" } }));
    http.mockResolvedValueOnce(json({ success: true, data: { is_logged_in: true, username: "nickname is not identity" } }));
    expect((await login.start("login:existing", signal())).status).toBe("failed");
    expect(http.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });

  it("cancels local checks without deleting cookies or pretending the upstream QR was revoked", async () => {
    const { driver: login } = await driver("xiaohongshu");
    http.mockResolvedValue(json({ success: true, data: { is_logged_in: false, timeout: "4m0s", img: PNG } }));
    const pending = await login.start("login:cancel", signal());
    await login.cancel(pending); const cancelled = await login.poll(pending, signal());
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.message).toContain("仍在有效期"); expect(cancelled.qrDataUrl).toBeUndefined();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("contains raw transport errors and excessive response bodies", async () => {
    const { driver: login } = await driver("xiaohongshu");
    http.mockRejectedValueOnce(new Error("Authorization: Bearer sensitive /Users/private/person"));
    expect(JSON.stringify(await login.start("login:error", signal()))).not.toMatch(/sensitive|\/Users\/private/u);
    http.mockResolvedValueOnce(json({ success: true, data: { img: "x".repeat(1024 * 1024) } }));
    expect((await login.start("login:large", signal())).status).toBe("failed");
  });

  it.each([20_000, 40_000])("starts the full QR wait after a %i ms response delay", async delay => {
    vi.useFakeTimers();
    const { driver: login } = await driver("xiaohongshu"); const startedAt = Date.now();
    http.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return json({ success: true, data: { is_logged_in: false, timeout: "4m0s", img: PNG } });
    });
    const starting = login.start("login:slow-qr", signal());
    await eventually(() => http.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(delay);
    const pending = await starting;
    expect(pending.status).toBe("pending");
    expect(pending.expiresAt).toBe(new Date(startedAt + delay + 4 * 60_000).toISOString());

    http.mockImplementation(async () => json({ success: true, data: { is_logged_in: false } }));
    await vi.advanceTimersByTimeAsync(4 * 60_000 - delay + 1);
    expect((await login.poll(pending, signal())).status).toBe("pending");
    await vi.advanceTimersByTimeAsync(delay);
    expect((await login.poll(pending, signal())).status).toBe("expired");
    expect(http).toHaveBeenCalledTimes(2);
  });
});

describe("isolated Zhihu human login", () => {
  it("keeps original credentials until the same identity is verified, then saves atomically with mode 0600", async () => {
    const { driver: login, cookies } = await driver("zhihu"); const old = JSON.stringify([cookie("old_session")]);
    await writeFile(cookies, old, { mode: 0o644 }); const ui = browser();
    http.mockImplementation(async () => json({ id: "original_account" }));
    const pending = await login.start("login:same", signal()); await waitForWindow();
    expect(await readFile(cookies, "utf8")).toBe(old);
    expect(ui.instance.newContext).toHaveBeenCalledWith();
    expect(fake.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect((await settled(login, pending)).status).toBe("ready");
    expect(JSON.parse(await readFile(cookies, "utf8"))[0].value).toBe("fresh_session");
    expect((await stat(cookies)).mode & 0o777).toBe(0o600);
    expect(ui.instance.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await login.poll(pending, signal()))).not.toMatch(/old_session|fresh_session|original_account/u);
  });

  it("does not replace a verified account with another identity", async () => {
    const { driver: login, cookies } = await driver("zhihu"); const old = JSON.stringify([cookie("old_session")]);
    await writeFile(cookies, old); browser();
    http.mockImplementation(async (_url, init) => json({ id: String((init?.headers as Record<string, string>).Cookie).includes("old_session") ? "original_account" : "other_account" }));
    const pending = await login.start("login:other", signal()); await waitForWindow();
    const failed = await settled(login, pending);
    expect(failed.status).toBe("failed"); expect(failed.message).toContain("另一知乎账号"); expect(await readFile(cookies, "utf8")).toBe(old);
  });

  it("explains explicit rebinding after expired credentials and saves only a newly verified login", async () => {
    const { driver: login, cookies } = await driver("zhihu"); await writeFile(cookies, JSON.stringify([cookie("old_session")])); browser();
    http.mockImplementation(async (_url, init) => String((init?.headers as Record<string, string>).Cookie).includes("old_session") ? json({}, 401) : json({ id: "rebound_account" }));
    const pending = await login.start("login:expired", signal()); await waitForWindow();
    expect(pending.message).not.toContain("已核验");
    expect((await settled(login, pending)).status).toBe("ready");
    expect(JSON.parse(await readFile(cookies, "utf8"))[0].value).toBe("fresh_session");
  });

  it("preserves credentials changed by another process during manual login", async () => {
    const { driver: login, cookies } = await driver("zhihu"); await writeFile(cookies, JSON.stringify([cookie("old_session")])); browser();
    http.mockImplementation(async () => json({ id: "original_account" }));
    const pending = await login.start("login:conflict", signal()); await waitForWindow();
    const external = JSON.stringify([cookie("changed_elsewhere")]); await writeFile(cookies, external);
    const failed = await settled(login, pending); expect(failed.status).toBe("failed"); expect(failed.message).toContain("其他操作修改");
    expect(await readFile(cookies, "utf8")).toBe(external);
  });

  it("does not follow a symlink credential file or claim 403 is expired", async () => {
    const { driver: login, cookies, folder } = await driver("zhihu"); const target = join(folder, "private-target");
    const old = JSON.stringify([cookie("old_session")]); await writeFile(target, old); await symlink(target, cookies); browser();
    const pending = await login.start("login:link", signal());
    expect((await settled(login, pending)).status).toBe("failed"); expect(fake.launch).not.toHaveBeenCalled(); expect(await readFile(target, "utf8")).toBe(old);
    await rm(cookies); await writeFile(cookies, old); http.mockResolvedValue(json({}, 403));
    const denied = await login.start("login:denied", signal()); expect((await settled(login, denied)).status).toBe("failed");
    expect(fake.launch).not.toHaveBeenCalled(); expect(await readFile(cookies, "utf8")).toBe(old);
  });

  it("closes a browser that finishes launching after cancellation without changing cookies", async () => {
    const { driver: login, cookies } = await driver("zhihu"); const old = JSON.stringify([cookie("old_session")]); await writeFile(cookies, old);
    const ui = browser(); let finish!: (browser: typeof ui.instance) => void;
    fake.launch.mockReturnValue(new Promise(resolve => { finish = resolve; })); http.mockResolvedValue(json({ id: "original_account" }));
    const pending = await login.start("login:late", signal()); await eventually(() => fake.launch.mock.calls.length === 1);
    await login.cancel(pending); finish(ui.instance); await eventually(() => ui.instance.close.mock.calls.length === 1);
    expect(ui.instance.newContext).not.toHaveBeenCalled(); expect(await readFile(cookies, "utf8")).toBe(old);
    expect((await login.poll(pending, signal())).status).toBe("cancelled");
  });

  it.each(["cancelled", "expired"] as const)("preserves the old credentials when %s just before atomic commit", async terminal => {
    if (terminal === "expired") vi.useFakeTimers();
    const { driver: login, cookies } = await driver("zhihu"); const old = JSON.stringify([cookie("old_session")]); await writeFile(cookies, old); browser();
    http.mockImplementation(async () => json({ id: "original_account" }));
    let release!: () => void; let atCommit = false;
    fake.beforeCommit = async () => { atCommit = true; await new Promise<void>(resolve => { release = resolve; }); };
    const pending = await login.start(`login:${terminal}-commit`, signal()); await waitForWindow();
    const polling = login.poll(pending, signal()); await eventually(() => atCommit);
    if (terminal === "expired") await vi.advanceTimersByTimeAsync(8 * 60_000 + 1); else await login.cancel(pending);
    release();
    expect((await polling).status).toBe(terminal);
    expect(await readFile(cookies, "utf8")).toBe(old);
    expect((await login.poll(pending, signal())).status).toBe(terminal);
  });

  it("reports ready if cancellation arrives after commit while the login browser is still closing", async () => {
    const { driver: login, cookies } = await driver("zhihu"); await writeFile(cookies, JSON.stringify([cookie("old_session")])); const ui = browser();
    http.mockImplementation(async () => json({ id: "original_account" }));
    let closed!: () => void;
    ui.instance.close.mockImplementation(() => new Promise<void>(resolve => { closed = resolve; }));
    const pending = await login.start("login:committed", signal()); await waitForWindow();
    const polling = login.poll(pending, signal()); await eventually(() => ui.instance.close.mock.calls.length === 1);
    await login.cancel(pending);
    expect((await login.poll(pending, signal())).status).toBe("ready");
    expect(JSON.parse(await readFile(cookies, "utf8"))[0].value).toBe("fresh_session");
    closed(); expect((await polling).status).toBe("ready");
  });
});

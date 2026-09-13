import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { AccountChannel, AccountLogin } from "../domain/accounts.ts";
import type { ConfigV1 } from "../domain/config.ts";
import { isJsonObject } from "../domain/json.ts";
import type { AccountLoginDriver } from "../ports/accounts.ts";

const LIMIT = 1024 * 1024;
const XHS_CANCEL = "已停止本地登录检查；小红书二维码可能仍在有效期内，本地服务会在到期后结束等待。";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
class LoginFault extends Error {}
const check = (value: unknown, message: string): void => { if (!value) throw new LoginFault(message); };
const active = (signal: AbortSignal): void => { if (signal.aborted) throw new LoginFault("登录操作已取消。"); };

interface LoginBrowser { newContext(): Promise<LoginContext>; close(): Promise<void> }
interface LoginContext {
  newPage(): Promise<{ goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown> }>;
  cookies(urls: string[]): Promise<unknown>;
}
interface Chromium { launch(options: { headless: false; timeout: number; executablePath?: string }): Promise<LoginBrowser> }
interface Cookie { name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" }
interface CredentialSnapshot { bytes: Buffer | null; fingerprint: string | null; cookies: Cookie[] }
interface Session {
  view: AccountLogin; controller: AbortController; timer: ReturnType<typeof setTimeout>;
  browser?: LoginBrowser; context?: LoginContext; prior?: CredentialSnapshot; expectedIdentity?: string | null;
  polling?: Promise<AccountLogin>;
}

/** These sessions hold only ephemeral login state. No QR, Cookie or raw response is persisted. */
class Sessions {
  current: Session | undefined;
  stopped = false;
  constructor(private readonly channel: AccountChannel, private readonly kind: "qr" | "browser") {}
  async begin(loginId: string, milliseconds: number, message: string): Promise<Session> {
    check(!this.stopped && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(loginId), "登录入口已关闭或请求无效。");
    await this.stop();
    const session: Session = {
      view: { loginId, channel: this.channel, kind: this.kind, status: "pending", message, expiresAt: new Date(Date.now() + milliseconds).toISOString() },
      controller: new AbortController(),
      timer: setTimeout(() => { void this.finish(session, "expired", "登录等待已到期，请重新发起。"); }, milliseconds),
    };
    session.timer.unref(); this.current = session; return session;
  }
  result(session: Session): AccountLogin { return { ...session.view }; }
  find(login: AccountLogin): Session | undefined { return this.current?.view.loginId === login.loginId && login.channel === this.channel ? this.current : undefined; }
  live(session: Session): boolean { return !this.stopped && this.current === session && session.view.status === "pending" && !session.controller.signal.aborted; }
  renew(session: Session, milliseconds: number): void {
    if (!this.live(session)) return;
    clearTimeout(session.timer);
    session.view = { ...session.view, expiresAt: new Date(Date.now() + milliseconds).toISOString() };
    session.timer = setTimeout(() => { void this.finish(session, "expired", "登录等待已到期，请重新发起。"); }, milliseconds);
    session.timer.unref();
  }
  async finish(session: Session, status: AccountLogin["status"], message: string): Promise<void> {
    if (session.view.status !== "pending") return;
    clearTimeout(session.timer); session.controller.abort();
    const { qrDataUrl: _qr, ...view } = session.view;
    session.view = { ...view, status, message };
    const browser = session.browser; delete session.browser; delete session.context;
    await browser?.close().catch(() => {});
  }
  async stop(): Promise<void> {
    if (this.current?.view.status === "pending") await this.finish(this.current, "cancelled", this.channel === "xiaohongshu" ? XHS_CANCEL : "已关闭本次登录窗口，原登录凭据未被替换。");
  }
  async dispose(): Promise<void> { this.stopped = true; await this.stop(); }
}

async function jsonGet(url: URL, headers: Record<string, string>, signal: AbortSignal, timeout = 45_000): Promise<{ status: number; body: unknown }> {
  active(signal);
  const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
  if ([401, 403, 429].includes(response.status)) { await response.body?.cancel(); return { status: response.status, body: null }; }
  check(response.ok && response.headers.get("content-type")?.includes("application/json"), "登录服务返回无效响应。");
  check(response.body, "登录服务没有返回结果。");
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; check(size <= LIMIT, "登录服务返回内容过大。"); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); }
  active(signal);
  try { return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }; }
  catch { throw new LoginFault("登录服务返回无效结果。"); }
}

function rasterQr(value: unknown): string {
  check(typeof value === "string" && value.length <= LIMIT, "二维码图片不可用。");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value as string);
  check(match && match[2]!.length % 4 === 0, "二维码须为本地栅格图片。");
  const bytes = Buffer.from(match![2]!, "base64");
  check(bytes.toString("base64") === match![2] && bytes.length >= 12 && (match![1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : match![1] === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"), "二维码图片格式无效。");
  return value as string;
}
function xhsEndpoint(): { url: URL; headers: Record<string, string> } {
  const env = process.env;
  const url = new URL(env.XHS_MCP_URL || `http://${env.XHS_MCP_HOST || "127.0.0.1"}:${env.XHS_MCP_PORT || "18060"}/mcp`);
  check(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash, "小红书登录服务必须使用已配置的本机入口。");
  const token = env.XHS_MCP_AUTH_TOKEN;
  check(!token || token.length <= 8192 && !/[\u0000-\u0020\u007f]/u.test(token), "小红书登录服务授权配置无效。");
  return { url, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}
function xhsDriver(endpoint: ReturnType<typeof xhsEndpoint>): AccountLoginDriver {
  const sessions = new Sessions("xiaohongshu", "qr");
  const request = async (path: "status" | "qrcode", signal: AbortSignal) => {
    const result = await jsonGet(new URL(`/api/v1/login/${path}`, endpoint.url), endpoint.headers, signal);
    check(result.status !== 401, "小红书本地服务授权失败，请检查服务配置。");
    check(isJsonObject(result.body) && result.body.success === true && isJsonObject(result.body.data), "小红书登录服务返回无效结果。");
    return (result.body as { data: Record<string, unknown> }).data;
  };
  const loggedIn = (body: Record<string, unknown>) => {
    check(typeof body.is_logged_in === "boolean", "小红书登录状态无法核验。");
    if (!body.is_logged_in) return false;
    check(typeof body.user_id === "string" && /^[a-f0-9]{24}$/u.test(body.user_id), "小红书已登录，但当前服务未提供可信账号身份；请检查服务版本。");
    return true;
  };
  const failed = async (session: Session, error: unknown) => {
    if (sessions.live(session)) await sessions.finish(session, "failed", error instanceof LoginFault ? error.message : "小红书登录服务暂时不可用，请检查本地服务后重试。");
    return sessions.result(session);
  };
  return {
    kind: "qr", supported: true, message: "复用本地小红书服务与原账号凭据。关闭窗口只停止检查，二维码仍可能有效。",
    async start(loginId, signal) {
      active(signal);
      const session = await sessions.begin(loginId, 4 * 60_000, "正在获取小红书登录二维码。");
      try {
        const combined = AbortSignal.any([signal, session.controller.signal]);
        const result = await request("qrcode", combined); active(combined);
        check(typeof result.is_logged_in === "boolean", "小红书二维码状态无法核验。");
        if (result.is_logged_in) {
          check(loggedIn(await request("status", combined)), "小红书登录状态已变化，请重试。");
          await sessions.finish(session, "ready", "已复用当前小红书账号；发布权限仍需单独检查。");
        } else {
          const qrDataUrl = rasterQr(result.img);
          check(result.timeout === "4m0s" || result.timeout === "4m", "小红书二维码有效期无法核验。");
          // Rendering the upstream QR can take tens of seconds. Reserve the
          // full wait after receipt rather than expiring at request-start time.
          sessions.renew(session, 4 * 60_000);
          session.view = { ...session.view, qrDataUrl, message: "请用小红书 App 扫码并确认。凭据由原本地服务保存；关闭本窗口不会立即撤销二维码。" };
        }
        return sessions.result(session);
      } catch (error) { if (signal.aborted) await sessions.stop(); return failed(session, error); }
    },
    async poll(login, signal) {
      const session = sessions.find(login); if (!session) return { ...login, status: "expired", message: "登录会话已失效，请重新发起。" };
      if (!sessions.live(session)) return sessions.result(session);
      if (!session.polling) session.polling = (async () => {
        try {
          if (loggedIn(await request("status", AbortSignal.any([signal, session.controller.signal])))) await sessions.finish(session, "ready", "小红书登录已核验；发布权限仍需单独检查。");
          return sessions.result(session);
        } catch (error) { if (signal.aborted) return sessions.result(session); return failed(session, error); }
        finally { delete session.polling; }
      })();
      return session.polling;
    },
    async cancel(login) { if (sessions.find(login)) await sessions.stop(); },
    dispose: () => sessions.dispose(),
  };
}

function parseCookies(raw: unknown, requireLogin: boolean): Cookie[] {
  check(Array.isArray(raw) && raw.length <= 200, "知乎登录凭据格式无效，原凭据已保留。");
  const cookies: Cookie[] = [];
  for (const item of raw as unknown[]) {
    if (!isJsonObject(item) || typeof item.domain !== "string" || !/^\.?zhihu\.com$/u.test(item.domain)) continue;
    check(typeof item.name === "string" && /^[A-Za-z0-9_-]+$/u.test(item.name) && typeof item.value === "string" && item.value.length <= 16384 && !/[\u0000-\u0020;\u007f]/u.test(item.value), "知乎登录凭据格式无效，原凭据已保留。");
    const cookie: Cookie = { name: item.name as string, value: item.value as string, domain: item.domain, path: typeof item.path === "string" && item.path.startsWith("/") && !/[\u0000-\u001f\u007f]/u.test(item.path) ? item.path : "/" };
    if (typeof item.expires === "number" && Number.isFinite(item.expires)) cookie.expires = item.expires;
    if (typeof item.httpOnly === "boolean") cookie.httpOnly = item.httpOnly;
    if (typeof item.secure === "boolean") cookie.secure = item.secure;
    if (item.sameSite === "Strict" || item.sameSite === "Lax" || item.sameSite === "None") cookie.sameSite = item.sameSite;
    cookies.push(cookie);
  }
  check(!requireLogin || cookies.some(cookie => cookie.name === "z_c0" && cookie.value), "知乎登录凭据缺少必要登录信息，原凭据已保留。");
  return cookies;
}
async function credentialSnapshot(file: string): Promise<CredentialSnapshot> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat(); check(before.isFile() && before.size > 0 && before.size <= LIMIT, "知乎凭据文件不可安全读取。");
    const bytes = await handle.readFile(); const after = await handle.stat(); const named = await lstat(file);
    check(!named.isSymbolicLink() && named.ino === before.ino && named.dev === before.dev && before.size === after.size && before.mtimeMs === after.mtimeMs, "知乎凭据在读取时发生变化，请重试。");
    let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new LoginFault("知乎凭据格式无效，原文件已保留。"); }
    return { bytes, fingerprint: digest(bytes), cookies: parseCookies(parsed, true) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, fingerprint: null, cookies: [] };
    if (error instanceof LoginFault) throw error;
    throw new LoginFault("知乎凭据文件不可安全读取，原文件已保留。");
  } finally { await handle?.close(); }
}
async function zhihuIdentity(cookies: Cookie[], signal: AbortSignal): Promise<string | null> {
  if (!cookies.some(cookie => cookie.name === "z_c0" && cookie.value)) return null;
  const response = await jsonGet(new URL("https://www.zhihu.com/api/v4/me"), { Accept: "application/json", Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), "User-Agent": "Mozilla/5.0", Referer: "https://www.zhihu.com/" }, signal, 20_000);
  if (response.status === 401) return null;
  check(![403, 429].includes(response.status), "知乎要求人工验证或暂时限制访问；请完成验证后重试，原凭据已保留。");
  check(isJsonObject(response.body) && typeof response.body.id === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(response.body.id), "知乎账号身份无法核验，原凭据已保留。");
  return (response.body as { id: string }).id;
}
async function saveZhihu(file: string, prior: CredentialSnapshot, cookies: Cookie[], signal: AbortSignal, committed: () => Promise<void>): Promise<void> {
  active(signal);
  const parent = dirname(file); check(await realpath(parent) === parent, "知乎凭据目录已变化，原凭据已保留。");
  const checkCurrent = async () => check((await credentialSnapshot(file)).fingerprint === prior.fingerprint, "知乎凭据已被其他操作修改；本次登录没有覆盖原文件。");
  await checkCurrent();
  const temp = resolve(parent, `.wemedia-login-${randomUUID()}.tmp`); let created = false;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    try { await handle.writeFile(JSON.stringify(cookies)); await handle.sync(); } finally { await handle.close(); }
    active(signal); await checkCurrent(); check(await realpath(parent) === parent, "知乎凭据目录已变化，原凭据已保留。"); active(signal);
    // There is no async gap between the last cancellation check, atomic rename
    // and the driver's ready state. A later cancel must report the saved result.
    renameSync(temp, file); created = false;
    await committed();
  } finally { if (created) await unlink(temp).catch(() => {}); }
}
function zhihuDriver(script: string, chromium: Chromium): AccountLoginDriver {
  const sessions = new Sessions("zhihu", "browser"); const file = resolve(dirname(script), "cookies.json");
  const fail = async (session: Session, error: unknown) => {
    if (sessions.live(session)) await sessions.finish(session, "failed", error instanceof LoginFault ? error.message : "知乎登录未完成，原凭据已保留。请检查浏览器与网络后重试。");
    return sessions.result(session);
  };
  const launch = async (session: Session) => {
    try {
      session.prior = await credentialSnapshot(file);
      session.expectedIdentity = await zhihuIdentity(session.prior.cookies, session.controller.signal); active(session.controller.signal);
      session.view.message = session.expectedIdentity ? "请在独立浏览器窗口登录原知乎账号；其他账号不会覆盖当前凭据。" : "请在独立浏览器窗口登录知乎。当前保存的账号身份无法验证；本次明确登录成功后会重新绑定，并保存到原凭据位置。";
      const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      const executablePath = await stat(chrome).then(info => info.isFile() ? chrome : undefined).catch(() => undefined);
      const browser = await chromium.launch({ headless: false, timeout: 30_000, ...(executablePath ? { executablePath } : {}) });
      if (!sessions.live(session)) { await browser.close(); return; }
      session.browser = browser; session.context = await browser.newContext(); active(session.controller.signal);
      const page = await session.context.newPage(); active(session.controller.signal);
      await page.goto("https://www.zhihu.com/signin", { waitUntil: "domcontentloaded", timeout: 30_000 }); active(session.controller.signal);
    } catch (error) { await fail(session, error); }
  };
  return {
    kind: "browser", supported: true, message: "打开独立浏览器由你人工登录；身份核验通过后保存到原凭据位置。已验证的现有账号不会被其他账号替换。",
    async start(loginId, signal) {
      active(signal);
      const session = await sessions.begin(loginId, 8 * 60_000, "正在核对原知乎账号并准备独立登录窗口；原凭据暂不改变。");
      void launch(session); return sessions.result(session);
    },
    async poll(login, signal) {
      const session = sessions.find(login); if (!session) return { ...login, status: "expired", message: "登录会话已失效，请重新发起。" };
      if (!sessions.live(session) || !session.context || !session.prior) return sessions.result(session);
      if (!session.polling) session.polling = (async () => {
        try {
          const combined = AbortSignal.any([signal, session.controller.signal]);
          const cookies = parseCookies(await session.context!.cookies(["https://www.zhihu.com/", "https://zhuanlan.zhihu.com/"]), false); active(combined);
          const identity = await zhihuIdentity(cookies, combined); active(combined);
          if (!identity) return sessions.result(session);
          check(!session.expectedIdentity || identity === session.expectedIdentity, "登录的是另一知乎账号；为保护现有账号，本次未覆盖原凭据。请登录原账号。" );
          await saveZhihu(file, session.prior!, cookies, combined, () => sessions.finish(session, "ready", "知乎登录身份已核验并安全保存；发布权限仍需单独检查。"));
          return sessions.result(session);
        } catch (error) { if (signal.aborted) return sessions.result(session); return fail(session, error); }
        finally { delete session.polling; }
      })();
      return session.polling;
    },
    async cancel(login) { if (sessions.find(login)) await sessions.stop(); },
    dispose: () => sessions.dispose(),
  };
}

function unsupported(kind: "qr" | "browser", channel: AccountChannel, message: string): AccountLoginDriver {
  return { kind, supported: false, message,
    async start(loginId) { return { loginId, channel, kind, status: "unsupported", message, expiresAt: null }; },
    async poll(login) { return { ...login, status: "unsupported", message }; }, async cancel() {}, async dispose() {},
  };
}
async function bridgePath(config: ConfigV1["adapters"][AccountChannel]): Promise<string> {
  check(config?.enabled && config.command && isAbsolute(config.command), "登录适配器未配置。");
  const path = await realpath(config!.command!); check(basename(path) === "wemedia_bridge.mjs" && (await stat(path)).isFile(), "登录适配器入口无效。"); return path;
}

/** Only configured local references are used; no credential discovery, migration or browser work at construction. */
export async function createInteractiveAccountLogins(options: { adapters: ConfigV1["adapters"]; privateDir: string }): Promise<Partial<Record<AccountChannel, AccountLoginDriver>>> {
  const result: Partial<Record<AccountChannel, AccountLoginDriver>> = {};
  if (options.adapters.xiaohongshu?.enabled) {
    try { await bridgePath(options.adapters.xiaohongshu); result.xiaohongshu = xhsDriver(xhsEndpoint()); }
    catch { result.xiaohongshu = unsupported("qr", "xiaohongshu", "本地小红书登录入口未正确配置；请检查桥接入口与本机服务地址。"); }
  }
  if (options.adapters.zhihu?.enabled) {
    try {
      const script = await bridgePath(options.adapters.zhihu); const loaded: unknown = createRequire(script)("playwright");
      check(typeof loaded === "object" && loaded !== null && "chromium" in loaded && typeof loaded.chromium === "object" && loaded.chromium !== null && "launch" in loaded.chromium && typeof loaded.chromium.launch === "function", "知乎浏览器依赖不可用。");
      result.zhihu = zhihuDriver(script, (loaded as { chromium: Chromium }).chromium);
    } catch { result.zhihu = unsupported("browser", "zhihu", "知乎人工登录需要已配置的本地桥接入口及其 Playwright 浏览器依赖；当前尚不可用。"); }
  }
  return result;
}

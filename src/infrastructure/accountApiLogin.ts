import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { AccountChannel, AccountLogin } from "../domain/accounts.ts";
import type { AdapterConfig, ConfigV1 } from "../domain/config.ts";
import type { AccountCheckResult, AccountLoginDriver } from "../ports/accounts.ts";
import { createRootCapability } from "./pathPolicy.ts";
import { SecureProcessRunner } from "./processRunner.ts";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];
const LIMIT = 64 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/u.test(value);

/** Read only an explicit, bounded regular file; never follow a credential symlink. */
async function readPrivate(path: string, missing = true): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await file.stat(); if (!info.isFile() || info.size > LIMIT) throw new Error("Unsafe account configuration"); const buffer = Buffer.alloc(LIMIT + 1); const result = await file.read(buffer, 0, buffer.length, 0); if (result.bytesRead > LIMIT) throw new Error("Account configuration too large"); return buffer.subarray(0, result.bytesRead).toString("utf8"); }
    finally { await file.close(); }
  } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

interface OAuthConfig { clientId: string; clientSecret: string; redirect: URL; secretPath: string }
async function oauthValues(project: string, environment: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const allowed = ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI", "X_PUBLISHER_PORT", "X_PUBLISHER_SECRET_FILE", "X_AUTHORIZE_URL"];
  const values: Record<string, string> = {};
  for (const key of allowed) if (environment[key] !== undefined) values[key] = environment[key]!;
  for (const file of [".env.local", ".env"]) {
    for (const line of (await readPrivate(resolve(project, file)) ?? "").split(/\r?\n/u)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
      if (match && allowed.includes(match[1]!) && values[match[1]!] === undefined) values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/u, "$2");
    }
  }
  return values;
}
async function oauthConfig(project: string, environment: NodeJS.ProcessEnv): Promise<OAuthConfig> {
  const values = await oauthValues(project, environment);
  if (!text(values.X_CLIENT_ID, 1024) || values.X_CLIENT_SECRET && !text(values.X_CLIENT_SECRET, 4096)) throw new Error("X OAuth application unavailable");
  if (values.X_AUTHORIZE_URL && values.X_AUTHORIZE_URL !== AUTHORIZE_URL) throw new Error("X authorization endpoint rejected");
  const redirect = new URL(values.X_REDIRECT_URI || `http://127.0.0.1:${values.X_PUBLISHER_PORT || "4389"}/oauth/x/callback`);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !/^\d+$/u.test(redirect.port) || Number(redirect.port) < 1 || Number(redirect.port) > 65535 || redirect.pathname !== "/oauth/x/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error("X callback rejected");
  const secretPath = values.X_PUBLISHER_SECRET_FILE || resolve(homedir(), ".config/x-publisher/secrets.json");
  if (!isAbsolute(secretPath)) throw new Error("X credential location rejected");
  return { clientId: values.X_CLIENT_ID!, clientSecret: values.X_CLIENT_SECRET || "", redirect, secretPath };
}

export interface ApiAccountLoginDependencies {
  /** Fixture transport only. Production uses the fixed official token endpoint. */
  fetch?: typeof globalThis.fetch;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
interface Pending {
  login: AccountLogin; server: Server; abort: AbortController; state: string; verifier: string;
  timer?: ReturnType<typeof setTimeout>; removeAbort: () => void; consumed: boolean;
}

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > LIMIT) throw new Error("OAuth response too large"); chunks.push(chunk.value); } return Buffer.concat(chunks).toString("utf8"); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Reuses x-publisher's PKCE, callback URI and private secret format, without its server or publish routes. */
class XAccountLogin implements AccountLoginDriver {
  readonly kind = "browser" as const;
  readonly supported = true;
  readonly message = "使用现有 X 开发者应用重新授权；授权只保存账号，不发表内容。";
  private pending: Pending | undefined;
  private starting = false;
  private startingDone: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(private project: string, private dependencies: ApiAccountLoginDependencies) {}

  private finish(pending: Pending, status: AccountLogin["status"], message: string): void {
    if (pending.login.status !== "pending") return;
    pending.login = { loginId: pending.login.loginId, channel: "x", kind: "browser", status, message, expiresAt: pending.login.expiresAt };
    if (pending.timer) clearTimeout(pending.timer);
    pending.removeAbort(); pending.abort.abort(); pending.server.close();
    if (status === "cancelled" || status === "expired") pending.server.closeAllConnections(); else pending.server.closeIdleConnections();
    pending.state = ""; pending.verifier = "";
  }

  async start(loginId: string, signal: AbortSignal): Promise<AccountLogin> {
    const failed = (message: string): AccountLogin => ({ loginId, channel: "x", kind: "browser", status: "failed", message, expiresAt: null });
    if (this.disposed || signal.aborted) return { ...failed("授权已取消。"), status: "cancelled" };
    if (this.starting || this.pending?.login.status === "pending") return failed("已有 X 授权正在进行，请先完成或取消。");
    this.starting = true;
    let started!: () => void;
    this.startingDone = new Promise<void>(done => { started = done; });
    let pending: Pending | undefined;
    try {
      const config = await oauthConfig(this.project, this.dependencies.environment ?? process.env);
      const original = await readPrivate(config.secretPath);
      // Capture the exact pre-login version so another login cannot be silently overwritten.
      const originalHash = original === undefined ? undefined : sha(original);
      if (original !== undefined && !object(JSON.parse(original))) throw new Error("Invalid credential document");
      if (this.disposed || signal.aborted) return { ...failed("授权已取消。"), status: "cancelled" };
      const state = randomBytes(24).toString("base64url"), verifier = randomBytes(32).toString("base64url");
      const authorization = new URL(AUTHORIZE_URL);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirect.href, scope: SCOPES.join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) authorization.searchParams.set(key, value);
      const timeoutMs = Math.min(Math.max(this.dependencies.timeoutMs ?? 10 * 60_000, 20), 10 * 60_000);
      const server = createServer((request, response) => {
        void (async () => {
          const current = pending!;
          const reply = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'" }); response.end(body); };
          const url = new URL(request.url || "/", config.redirect.origin);
          if (request.method !== "GET" || request.headers.host !== config.redirect.host || url.pathname !== config.redirect.pathname) { reply(404, "Not found"); return; }
          if (current.login.status !== "pending" || current.consumed || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== current.state) { reply(400, "Invalid or expired authorization state"); return; }
          if (url.searchParams.has("error")) { reply(400, "Authorization was declined"); this.finish(current, "failed", "X 授权未完成，请重试。"); return; }
          const code = url.searchParams.get("code");
          if (url.searchParams.getAll("code").length !== 1 || !text(code, 4096)) { reply(400, "Missing authorization code"); return; }
          current.consumed = true;
          try {
            const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
            if (config.clientSecret) headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
            const result = await (this.dependencies.fetch ?? fetch)(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.any([current.abort.signal, AbortSignal.timeout(30_000)]), headers, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect.href, client_id: config.clientId, code_verifier: current.verifier }) });
            const body = await boundedResponse(result);
            if (!result.ok || body.length > LIMIT) throw new Error("Token exchange rejected");
            const payload: unknown = JSON.parse(body);
            if (!object(payload) || !text(payload.access_token) || payload.refresh_token !== undefined && !text(payload.refresh_token) || typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(payload.expires_in) || Number(payload.expires_in) <= 0 || Number(payload.expires_in) > 31_536_000 || payload.scope !== undefined && (typeof payload.scope !== "string" || payload.scope.length > 4096 || /[\u0000-\u001f\u007f]/u.test(payload.scope))) throw new Error("Invalid token response");
            await mkdir(dirname(config.secretPath), { recursive: true, mode: 0o700 });
            if (await realpath(dirname(config.secretPath)) !== dirname(config.secretPath)) throw new Error("Credential directory changed");
            const latest = await readPrivate(config.secretPath);
            if ((latest === undefined ? undefined : sha(latest)) !== originalHash) throw new Error("Credential changed during authorization");
            const stored: Record<string, unknown> = latest === undefined ? { version: 1 } : JSON.parse(latest);
            stored.x = { client_id: config.clientId, access_token: payload.access_token, refresh_token: payload.refresh_token || "", token_type: "bearer", scope: payload.scope || "", expires_at: new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() };
            if (current.abort.signal.aborted || current.login.status !== "pending" || this.disposed) throw new Error("Authorization cancelled");
            // No await between the final cancellation guard, atomic rename and success;
            // a late cancel cannot label already committed credentials as rolled back.
            const temporary = `${config.secretPath}.${randomBytes(12).toString("hex")}.tmp`;
            let fd: number | undefined;
            try {
              fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
              writeFileSync(fd, `${JSON.stringify(stored, null, 2)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
              renameSync(temporary, config.secretPath);
            } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
            reply(200, "X authorization saved. Return to the workbench and check the account.");
            this.finish(current, "ready", "X 授权已保存，请检查账号状态；尚未发表内容。");
          } catch { if (!response.writableEnded) reply(400, "Authorization could not be saved. Return to the workbench."); this.finish(current, "failed", "X 授权未能安全保存，请重新授权或检查应用配置。"); }
        })().catch(() => { if (!response.writableEnded) { response.writeHead(400); response.end("Invalid callback"); } });
      });
      pending = { login: { loginId, channel: "x", kind: "browser", status: "pending", message: "请在 X 官方授权页确认，完成后返回工作台。", expiresAt: new Date(Date.now() + timeoutMs).toISOString(), url: authorization.href }, server, abort: new AbortController(), state, verifier, consumed: false, removeAbort: () => {} };
      this.pending = pending;
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(Number(config.redirect.port), "127.0.0.1", () => { server.removeListener("error", reject); done(); }); });
      server.on("error", () => this.finish(pending!, "failed", "X 授权回调不可用，请重试。"));
      if (pending.login.status !== "pending" || signal.aborted || this.disposed) {
        this.finish(pending, "cancelled", "X 授权已取消。"); server.close(); server.closeAllConnections(); return { ...pending.login };
      }
      const onAbort = () => this.finish(pending!, "cancelled", "X 授权已取消。");
      signal.addEventListener("abort", onAbort, { once: true }); pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
      pending.timer = setTimeout(() => this.finish(pending!, "expired", "X 授权已过期，请重新开始。"), timeoutMs); pending.timer.unref?.();
      if (signal.aborted || this.disposed) onAbort();
      return { ...pending.login };
    } catch { if (pending) this.finish(pending, "failed", "X 应用配置或回调端口不可用，请检查后重试。"); return pending ? { ...pending.login } : failed("X 开发者应用尚未正确配置，请先配置 Client ID 与回调地址。"); }
    finally { this.starting = false; started(); }
  }
  async poll(login: AccountLogin, _signal: AbortSignal): Promise<AccountLogin> { const { url: _url, qrDataUrl: _qr, ...safe } = login; return this.pending?.login.loginId === login.loginId ? { ...this.pending.login } : { ...safe, status: "expired", message: "X 授权会话已失效，请重新开始。" }; }
  async cancel(login: AccountLogin): Promise<void> {
    if (this.pending?.login.loginId !== login.loginId) return;
    this.finish(this.pending, "cancelled", "X 授权已取消。");
    await new Promise<void>(done => this.pending!.server.close(() => done()));
  }
  async dispose(): Promise<void> {
    this.disposed = true; if (this.pending) this.finish(this.pending, "cancelled", "X 授权已取消。");
    await this.startingDone;
    if (this.pending) { this.pending.server.closeAllConnections(); await new Promise<void>(done => this.pending!.server.close(() => done())); }
  }
}

function configurationDriver(): AccountLoginDriver {
  const message = "微信公众号使用现有 AppID / Secret 配置，不使用扫码登录；账号配置不等于发布权限。";
  return { kind: "configuration", supported: false, message, start: async loginId => ({ loginId, channel: "wechat", kind: "configuration", status: "unsupported", message, expiresAt: null }), poll: async login => ({ ...login }), cancel: async () => {}, dispose: async () => {} };
}

export async function createApiAccountLogins(options: { adapters: ConfigV1["adapters"]; privateDir: string }, dependencies: ApiAccountLoginDependencies = {}): Promise<Partial<Record<AccountChannel, AccountLoginDriver>>> {
  const drivers: Partial<Record<AccountChannel, AccountLoginDriver>> = { wechat: configurationDriver() };
  const entry = options.adapters.x;
  if (entry?.enabled && entry.command && isAbsolute(entry.command)) {
    try {
      const command = await realpath(entry.command);
      if (basename(command) !== "wemedia_bridge.mjs" || !(await lstat(command)).isFile() || basename(dirname(command)) !== "src") throw new Error("X bridge unavailable");
      const project = dirname(dirname(command));
      // These files identify the existing publisher whose callback and secret format we reuse.
      for (const file of ["oauth.js", "store.js", "config.js"]) if (!(await lstat(resolve(project, "src", file))).isFile()) throw new Error("X OAuth unavailable");
      drivers.x = new XAccountLogin(project, dependencies);
    } catch {}
  }
  return drivers;
}

/** No standalone read-only WeChat account probe exists in the current bridge.
 * Discover reuses its credential boundary; token issuance is not disguised as a pure read. */
export function createWechatAccountChecker(adapter: AdapterConfig | undefined): (signal: AbortSignal) => Promise<AccountCheckResult> {
  return async signal => {
    if (!adapter?.enabled || !adapter.command || !isAbsolute(adapter.command)) return { status: "not_configured", present: false, permission: "unknown", message: "微信桥接尚未配置。" };
    try {
      const command = await realpath(adapter.command);
      if (basename(command) !== "wemedia_bridge.mjs") throw new Error("Bridge rejected");
      const root = await createRootCapability({ id: "wechat-account", label: "微信账号检查", path: adapter.cwd ?? dirname(command), mode: "read" });
      if (!root.ok) throw new Error("Bridge unavailable");
      const runner = new SecureProcessRunner({ roots: [root.value], executables: { node: { path: process.execPath, allowedEnvKeys: [] } }, baseEnv: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` }, maxTimeoutMs: 30_000 });
      const result = await runner.run({ executable: "node", argv: [command], cwdRootId: root.value.id, cwdRelativePath: "", env: {}, timeoutMs: 30_000, maxOutputBytes: 16 * 1024, stdinText: JSON.stringify({ schemaVersion: "wemedia.wechat-bridge/v1", operation: "discover" }) }, signal);
      if (!result.ok || result.value.exitCode !== 0 || result.value.cancelled || result.value.timedOut || result.value.stdoutTruncated) throw new Error("Account check failed");
      const value: unknown = JSON.parse(result.value.stdout);
      if (!object(value) || value.schemaVersion !== "wemedia.wechat-bridge/v1" || value.operation !== "discover" || value.ok !== true) throw new Error("Account response invalid");
      if (value.configured !== "configured") return { status: "not_configured", present: false, permission: "unknown", message: "微信 AppID / Secret 尚未配置或不可读取。" };
      return { status: "unchecked", present: true, permission: "unknown", message: "已复用本地公众号配置；现有桥接未提供独立只读在线账号核验，尚未确认当前 API 权限。", ...(typeof value.accountRef === "string" && /^wechat-account:[a-f0-9]{32}$/u.test(value.accountRef) ? { accountRef: value.accountRef } : {}) };
    } catch { return { status: "error", present: null, permission: "unknown", message: signal.aborted ? "微信账号检查已取消。" : "微信账号配置暂不可检查，请确认桥接可用。" }; }
  };
}

/** Account-only read: unlike the legacy publisher's getMe(), never refresh or save tokens. */
export function createXAccountChecker(adapter: AdapterConfig | undefined, dependencies: ApiAccountLoginDependencies = {}): (signal: AbortSignal) => Promise<AccountCheckResult> {
  return async signal => {
    const result = (status: AccountCheckResult["status"], message: string, present: boolean | null, permission: AccountCheckResult["permission"] = "unknown"): AccountCheckResult => ({ status, message, present, permission });
    if (!adapter?.enabled || !adapter.command || !isAbsolute(adapter.command)) return result("not_configured", "X 本地连接尚未配置。", false);
    let present: boolean | null = null;
    try {
      if (signal.aborted) throw new Error("Cancelled");
      const command = await realpath(adapter.command);
      if (basename(command) !== "wemedia_bridge.mjs" || basename(dirname(command)) !== "src" || !(await lstat(command)).isFile()) throw new Error("X bridge unavailable");
      const project = dirname(dirname(command)), environment = dependencies.environment ?? process.env;
      let token: unknown = environment.X_OAUTH2_USER_TOKEN || environment.TWITTER_OAUTH2_USER_TOKEN;
      if (!token) {
        const values = await oauthValues(project, environment);
        const secretPath = values.X_PUBLISHER_SECRET_FILE || resolve(homedir(), ".config/x-publisher/secrets.json");
        if (!isAbsolute(secretPath)) throw new Error("X credential location rejected");
        const source = await readPrivate(secretPath);
        if (source !== undefined) {
          const document: unknown = JSON.parse(source);
          if (!object(document) || document.x !== undefined && !object(document.x)) throw new Error("X credential document invalid");
          const account = object(document.x) ? document.x : {};
          if (account.access_token) {
            present = true; token = account.access_token;
            if (account.expires_at !== undefined && account.expires_at !== "") {
              if (typeof account.expires_at !== "string" || !Number.isFinite(Date.parse(account.expires_at))) throw new Error("X expiry invalid");
              if (Date.parse(account.expires_at) <= Date.now()) return result("expired", "本地 X 授权已过期，请点击重新授权；未自动刷新或修改凭证。", true);
            }
          }
        }
        if (!token) {
          // Match the already configured bridge's explicit legacy token locations.
          for (const file of [resolve(project, ".env.local"), resolve(project, ".env"), resolve(project, "../twitter/.env.local"), resolve(project, "../twitter/.env")]) {
            for (const line of (await readPrivate(file) ?? "").split(/\r?\n/u)) {
              const match = /^(?:export\s+)?(?:X_OAUTH2_USER_TOKEN|TWITTER_OAUTH2_USER_TOKEN)\s*=\s*(.+)$/u.exec(line.trim());
              if (match) { token = match[1]!.replace(/^(["'])(.*)\1$/u, "$2").trim(); if (token) break; }
            }
            if (token) break;
          }
        }
      }
      if (!token) return result("login_required", "未找到 X 用户授权，请点击重新授权。", false);
      present = true;
      if (!text(token)) throw new Error("X credential invalid");
      if (signal.aborted) throw new Error("Cancelled");
      const response = await (dependencies.fetch ?? fetch)("https://api.x.com/2/users/me", { method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { authorization: `Bearer ${token}` } });
      if (signal.aborted) throw new Error("Cancelled");
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) return result("login_required", "X 已拒绝当前授权，请重新授权。", true);
        if (response.status === 403) return result("error", "X 账号检查被权限或平台策略阻断，请检查开发者应用权限。", true, "missing");
        if (response.status === 402) return result("error", "X 接口需要可用额度，请检查开发者账户。", true);
        if (response.status === 429) return result("error", "X 接口暂时限流，请稍后重新检查。", true);
        return result("error", "X 账号检查暂未成功，请稍后重试；原凭证未修改。", true);
      }
      const payload: unknown = JSON.parse(await boundedResponse(response));
      if (signal.aborted) throw new Error("Cancelled");
      if (!object(payload) || !object(payload.data) || typeof payload.data.id !== "string" || !/^[0-9]{1,19}$/u.test(payload.data.id) || payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0)) throw new Error("X identity invalid");
      return { ...result("ready", "X 当前在线身份已核实；发布权限与额度仍需在提交前单独检查。", true), accountRef: `x-account:${sha(`x-user:${payload.data.id}`).slice(0, 32)}` };
    } catch { return result("error", signal.aborted ? "X 账号检查已取消。" : "X 账号检查暂未完成，请检查本地授权配置或网络；未自动刷新、清除或修改凭证。", present); }
  };
}

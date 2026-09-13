import type { ConfigV1 } from "../domain/config.ts";
import type { AccountChannel } from "../domain/accounts.ts";
import type { AccountCheckResult, AccountLoginDriver, AccountProvider } from "../ports/accounts.ts";
import type { ChannelBridgeResult, PublishingAdapter } from "../ports/channelPublishing.ts";
import { createInteractiveAccountLogins } from "./accountLogin.ts";
import { createApiAccountLogins, createWechatAccountChecker, createXAccountChecker } from "./accountApiLogin.ts";

type AccountBridge = Pick<PublishingAdapter, "channel"> & {
  checkAccount(signal: AbortSignal): Promise<ChannelBridgeResult>;
};

function unavailable(channel: AccountChannel): AccountLoginDriver {
  const message = channel === "wechat" ? "公众号复用本地 AppID / Secret，通过现有公众号配置管理，无需扫码。" : "当前登录助手不可用，请检查本地连接后重试。";
  return { kind: channel === "wechat" ? "configuration" : "unsupported", supported: false, message,
    async start(loginId) { return { loginId, channel, kind: this.kind, status: "unsupported", message, expiresAt: null }; },
    async poll(login) { return login; }, async cancel() {}, async dispose() {} };
}
export function channelAccountResult(result: ChannelBridgeResult): AccountCheckResult {
  const present = result.configured === "missing" ? false : result.configured === "configured" ? true : null;
  if (result.ok && result.accountRef) return { status: "ready", message: "当前账号在线身份已核实；发布权限会在提交前单独检查。", present: true, permission: result.permission ?? "unknown", accountRef: result.accountRef };
  if (/AUTH_EXPIRED/u.test(result.code)) return { status: "expired", message: "本地授权已过期，请点击重新授权。", present: true };
  if (/LOGIN_REQUIRED|AUTH_REJECTED/u.test(result.code)) return { status: "login_required", message: "当前登录已失效，请重新登录。", present };
  if (/MISSING|NOT_CONFIGURED/u.test(result.code)) return { status: "not_configured", message: "尚未找到可用的本地授权配置。", present: false };
  if (result.ok) return { status: "unchecked", message: "已找到本地连接，尚未核实在线身份。", present };
  return { status: "error", message: /VERIFICATION|PERMISSION|DENIED/u.test(result.code) ? "平台要求额外验证或权限，请在官方页面确认后重试。" : /CREDITS/u.test(result.code) ? "平台接口需要可用额度，请检查平台账户。" : "在线检查暂未成功，请检查本地服务或网络后重试；未自动清除凭证。", present, permission: result.permission ?? "unknown" };
}
/** Only explicit adapter entries are eligible; no home-directory credential scanning. */
export async function createAccountProviders(config: ConfigV1, privateDir: string, adapters: AccountBridge[]): Promise<AccountProvider[]> {
  const results = await Promise.allSettled([createInteractiveAccountLogins({ adapters: config.adapters, privateDir }), createApiAccountLogins({ adapters: config.adapters, privateDir })]);
  const drivers: Partial<Record<AccountChannel, AccountLoginDriver>> = {};
  for (const result of results) if (result.status === "fulfilled") Object.assign(drivers, result.value);
  const providers: AccountProvider[] = [];
  if (config.adapters.wechat?.enabled) providers.push({ channel: "wechat", kind: "api_key", label: "本地公众号配置 · 当前连接", login: drivers.wechat ?? unavailable("wechat"), check: createWechatAccountChecker(config.adapters.wechat) });
  for (const adapter of adapters) if (config.adapters[adapter.channel]?.enabled) providers.push({ channel: adapter.channel, kind: adapter.channel === "x" ? "oauth" : "cookies", label: adapter.channel === "xiaohongshu" ? "本地小红书服务 · 登录凭证" : adapter.channel === "zhihu" ? "本地知乎连接 · 登录凭证" : "本地 X 连接 · OAuth 授权", login: drivers[adapter.channel] ?? unavailable(adapter.channel), check: adapter.channel === "x" ? createXAccountChecker(config.adapters.x) : async signal => channelAccountResult(await adapter.checkAccount(signal)) });
  return providers;
}

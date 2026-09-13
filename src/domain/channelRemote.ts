import type { PublishingChannel, ChannelRemote } from "./channelPublishing.ts";
import { isJsonObject } from "./json.ts";
import { SHA256_PATTERN } from "./wechatDocument.ts";

const remoteId = (channel: PublishingChannel, value: unknown): value is string => typeof value === "string" && (channel === "xiaohongshu" ? /^[a-f0-9]{24}$/u : /^[1-9][0-9]{0,29}$/u).test(value);
export function channelUrl(channel: PublishingChannel, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port || value !== u.href) return;
    const valid = channel === "zhihu" ? u.hostname === "zhuanlan.zhihu.com" && /^\/p\/\d+(?:\/edit)?$/u.test(u.pathname)
      : channel === "xiaohongshu" ? ["www.xiaohongshu.com", "xiaohongshu.com"].includes(u.hostname) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{24}$/u.test(u.pathname)
      : ["x.com", "twitter.com", "www.x.com"].includes(u.hostname) && /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+$/u.test(u.pathname);
    return valid ? value : undefined;
  } catch { return; }
}
export function decodeChannelRemote(channel: PublishingChannel, value: unknown): ChannelRemote | undefined {
  if (!isJsonObject(value) || Object.keys(value).some(k => !["remoteId", "url", "remoteIds", "contentDigest"].includes(k)) || !remoteId(channel, value.remoteId)) return;
  if (value.url !== undefined && (!channelUrl(channel, value.url) || new URL(value.url as string).pathname.split("/").filter(v => v !== "edit").at(-1) !== value.remoteId)) return;
  if (value.remoteIds !== undefined && (!Array.isArray(value.remoteIds) || value.remoteIds.length < 1 || value.remoteIds.length > 100 || !value.remoteIds.every(v => remoteId(channel, v)) || value.remoteIds[0] !== value.remoteId || new Set(value.remoteIds).size !== value.remoteIds.length)) return;
  if (value.contentDigest !== undefined && (typeof value.contentDigest !== "string" || !SHA256_PATTERN.test(value.contentDigest))) return;
  return { remoteId: value.remoteId, ...(value.url ? { url: value.url as string } : {}), ...(value.remoteIds ? { remoteIds: value.remoteIds as string[] } : {}), ...(value.contentDigest ? { contentDigest: value.contentDigest as string } : {}) };
}

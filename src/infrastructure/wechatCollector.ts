import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { CollectedReference } from "../domain/references.ts";
import { WorkbenchFault } from "../domain/workbenchFault.ts";
import type { ReferenceCollect } from "../ports/references.ts";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 50_000;
const HOST = "mp.weixin.qq.com";
const STRIP = "script,style,noscript,template,iframe,object,embed,form,input,button,svg,link,meta,title,#js_top_ad_area,#js_tags_preview_toast,#content_bottom_area,#js_pc_qr_code,#wx_stream_article_slide_tip,.__bottom-bar__";

export interface WechatCollectorDependencies {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

class CollectionFailure extends WorkbenchFault {
  constructor(message: string, code = "WECHAT_COLLECT_FAILED") { super(code, message); }
}
const failure = (message: string, code?: string): never => { throw new CollectionFailure(message, code); };

// Validate the original authority too: URL normalizes away an explicit :443.
function articleUrl(raw: string, redirected = false): URL {
  if (raw.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(raw) || !/^https:\/\/mp\.weixin\.qq\.com(?:\/|$)/u.test(raw)) {
    return failure("仅支持不含端口或账号信息的 HTTPS 公众号文章链接。");
  }
  let url: URL;
  try { url = new URL(raw); } catch { return failure("公众号文章链接无效。"); }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.port || url.username || url.password) return failure("公众号文章链接域名不受支持。");
  // These are server responses to a valid article URL, not malformed user input.
  // Stop here without requesting a challenge URL or retaining its query values.
  if (redirected && ["/mp/wappoc_appmsgcaptcha", "/mp/appmsgcaptcha", "/mp/verifycode"].includes(url.pathname)) {
    return failure("微信要求安全验证，本次未获取正文。请在浏览器打开原文核对访问状态；未保存验证页面。", "WECHAT_VERIFICATION_REQUIRED");
  }
  if (redirected && ["/cgi-bin/login", "/cgi-bin/bizlogin", "/mp/login", "/mp/loginpage"].includes(url.pathname)) {
    return failure("微信将原文转到了登录页面，当前仅采集可公开访问的正文；未保存登录页面。", "WECHAT_LOGIN_REQUIRED");
  }
  const canonical = new URL(`https://${HOST}${url.pathname}`);
  if (/^\/s\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname)) return canonical;
  if (url.pathname !== "/s") return redirected
    ? failure("微信将原文转到了非文章页面，暂时无法读取正文；未保存跳转页面。", "WECHAT_REDIRECT_UNSUPPORTED")
    : failure("请提供 /s/ 开头的公众号单篇文章链接。");
  const patterns: Record<string, RegExp> = { __biz: /^[A-Za-z0-9+/=]{1,180}$/u, mid: /^\d{1,32}$/u, idx: /^\d{1,3}$/u, sn: /^[a-fA-F0-9]{32}$/u };
  for (const [key, pattern] of Object.entries(patterns)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !pattern.test(values[0]!)) return redirected
      ? failure("微信返回的文章跳转缺少可核对的文章身份，未保存正文。", "WECHAT_REDIRECT_UNSUPPORTED")
      : failure("长文章链接需要有效且唯一的 __biz、mid、idx、sn 参数。");
    canonical.searchParams.set(key, values[0]!);
  }
  return canonical;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function htmlBody(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return failure("公众号页面超过 3 MB，未保存内容。");
  }
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    return failure("公众号返回的不是 HTML 文章页面。");
  }
  if (!response.body) return failure("公众号返回了空页面。");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) return failure("公众号页面超过 3 MB，未保存内容。");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const cleanText = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/gu, "")
  .replace(/\r\n?/gu, "\n").replace(/[^\S\n]+/gu, " ").split("\n").map(line => line.trim()).filter(Boolean).join("\n").trim();

function metadata($: CheerioAPI, selector: string, attribute?: string): string {
  const node = $(selector).first().clone();
  node.find(STRIP).remove();
  return cleanText(attribute ? node.attr(attribute) ?? "" : node.text());
}

function publicationTime($: CheerioAPI, scripts: string): string | null {
  const epoch = /\b(?:ct|createTimestamp)\s*=\s*["'](\d{10})["']/u.exec(scripts)?.[1];
  if (epoch) return new Date(Number(epoch) * 1000).toISOString();
  const value = metadata($, "#publish_time") || metadata($, 'meta[property="article:published_time"]', "content") ||
    /\bcreateTime\s*=\s*["'](\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?)["']/u.exec(scripts)?.[1] || "";
  const chinese = /^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(value);
  const normalized = chinese ? `${chinese[1]}-${chinese[2]!.padStart(2, "0")}-${chinese[3]!.padStart(2, "0")}T${(chinese[4] ?? "00").padStart(2, "0")}:${chinese[5] ?? "00"}:${chinese[6] ?? "00"}+08:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mediaUrl(raw: string | undefined, kind: "image" | "video"): string | null {
  if (!raw || raw.length > 2048 || /[\s\\]/u.test(raw)) return null;
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
  const hosts = kind === "image" ? ["mmbiz.qpic.cn", "mmbiz.qlogo.cn"] : ["mpvideo.qpic.cn", "video.weixin.qq.com", "v.qq.com", HOST];
  const authority = /^https:\/\/([^/?#]+)/u.exec(absolute)?.[1];
  if (!authority || !hosts.includes(authority)) return null;
  try {
    const url = new URL(absolute);
    if (url.username || url.password || url.port) return null;
    const safe = new URL(url.origin + url.pathname);
    for (const key of ["wx_fmt", "vid"]) { const value = url.searchParams.get(key); if (value && /^[\w-]{1,100}$/u.test(value)) safe.searchParams.set(key, value); }
    return safe.href;
  } catch { return null; }
}

function parseArticle(html: string, url: URL): CollectedReference {
  const $ = load(html);
  // Static DOM adaptation of wechat-article-exporter normalizeHtml and
  // validateHTMLContent (MIT, a7bffa6e481a). No CGI script evaluation is reused.
  // Attribution and the full upstream license: docs/third-party/wechat-collector-MIT.txt.
  const errorPage = metadata($, ".weui-msg .weui-msg__title,.mesg-block,.page_msg .title");
  const pageTitle = metadata($, "title");
  const messages = `${errorPage}\n${$("#js_content").length ? "" : pageTitle}`;
  if (/删除|无法查看|不存在|停止访问|内容违规|deleted|not available/iu.test(messages)) return failure("该公众号文章已删除或无法访问，未保存正文。", "WECHAT_ARTICLE_UNAVAILABLE");
  if (/验证|环境异常|访问频繁|captcha|verify|安全检查/iu.test(messages) || $("#js_verify,#captcha,#verify_page").length) return failure("微信要求安全验证，本次未获取正文。请在浏览器打开原文核对访问状态；未保存验证页面。", "WECHAT_VERIFICATION_REQUIRED");
  if (/登录|log\s*in|sign\s*in/iu.test(messages) || $("#js_login,#login_page").length) return failure("公众号文章需要登录，当前采集器仅访问公开页面。", "WECHAT_LOGIN_REQUIRED");
  const scripts = $("script").map((_index, node) => $(node).html() ?? "").get().join("\n");
  if ($("#js_pay_content,#js_pay_area,#js_pay_subscribe,.paywall").length || /\bis_pay_subscribe\s*[:=]\s*["']?1\b/u.test(scripts) || /付费阅读|付费后|购买后|paid content/iu.test(errorPage)) return failure("该文章包含付费或受限正文，当前采集器不采集预览代替全文。", "WECHAT_PAID_CONTENT_RESTRICTED");
  if (errorPage) return failure("公众号返回了提示页面，未保存为文章。");
  const content = $("#js_content");
  if (content.length !== 1 || $("#js_article").length !== 1 || !content.closest("#js_article").length) return failure("未找到完整的公众号文章结构，页面可能需要验证或已失效。");
  const title = (metadata($, "#activity-name") || metadata($, 'meta[property="og:title"]', "content")).slice(0, 300);
  const author = (metadata($, "#js_author_name") || metadata($, "#js_name") || metadata($, 'meta[name="author"]', "content")).slice(0, 160);
  if (!title || !author) return failure("公众号文章缺少标题或作者信息，未保存不完整页面。");
  const publishedAt = publicationTime($, scripts);
  const media: CollectedReference["media"] = [];
  const seen = new Set<string>();
  content.find("img,video,source,iframe").each((_index, element) => {
    const node = $(element), kind = element.tagName === "img" ? "image" : "video";
    const source = mediaUrl(node.attr("data-src") || node.attr("src"), kind);
    if (source && !seen.has(source)) { seen.add(source); if (media.length < 50) media.push({ kind, url: source }); }
  });
  content.find(STRIP).remove();
  // Preserve paragraph boundaries before reducing the same cleaned subtree to text.
  content.find("br").replaceWith("\n");
  content.find("p,div,section,article,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr").append("\n");
  const completeText = cleanText(content.text());
  if (!completeText) return failure("该文章没有可采集的公开文字正文。");
  const text = completeText.slice(0, MAX_TEXT).replace(/[\ud800-\udbff]$/u, "");
  const tags = [...new Set(metadata($, 'meta[name="keywords"]', "content").split(/[,，;；]/u).map(item => item.trim()).filter(Boolean))].slice(0, 20).map(tag => tag.slice(0, 50));
  return { platform: "wechat", sourceId: `wechat:${createHash("sha256").update(url.href).digest("hex")}`, url: url.href, title, author, publishedAt, kind: "article", text, tags, completeness: completeText.length > MAX_TEXT || seen.size > media.length ? "partial" : "complete", media };
}

export function createWechatCollector(dependencies: WechatCollectorDependencies = {}): ReferenceCollect {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(30_000, Math.max(1, dependencies.timeoutMs ?? 20_000));
  return async (input, callerSignal) => {
    if (input.kind !== "wechat_article") return failure("公众号采集器仅支持单篇文章链接。");
    let url = articleUrl(input.url);
    const timeout = new AbortController(), signal = AbortSignal.any([callerSignal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      signal.throwIfAborted();
      for (let redirects = 0; redirects <= 3; redirects++) {
        const pending = fetch(url.href, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal, headers: { Accept: "text/html,application/xhtml+xml" } });
        // A non-cooperative test/transport must not leave a late response body open.
        void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
        const response = await abortable(pending, signal);
        if (response.url) {
          try { articleUrl(response.url, true); }
          catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          const location = response.headers.get("location");
          if (!location || redirects === 3) return failure("公众号文章跳转过多或缺少有效目标。");
          if (/[\s\\]/u.test(location)) return failure("公众号文章跳转地址不安全。");
          const next = /^https?:|^\/\//iu.test(location) ? location.startsWith("//") ? `https:${location}` : location : new URL(location, url).href;
          url = articleUrl(next, true);
          continue;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 401) return failure("公众号要求登录，当前仅采集可公开访问的正文。", "WECHAT_LOGIN_REQUIRED");
          if (response.status === 403) return failure("公众号拒绝访问，暂时无法读取公开正文；未保存内容。", "WECHAT_ACCESS_DENIED");
          if (response.status === 429) return failure("公众号访问频率受限，请稍后重试。", "WECHAT_RATE_LIMITED");
          return failure("公众号文章请求失败，请检查文章是否仍可公开访问。");
        }
        const html = await htmlBody(response, signal);
        signal.throwIfAborted();
        const item = parseArticle(html, url);
        signal.throwIfAborted();
        return { items: [item], partial: item.completeness === "partial", message: item.completeness === "partial" ? "已采集公开文章，内容超过上限，已标记为部分内容。" : "已采集公众号公开文章；来源链接已保留。" };
      }
      return failure("公众号文章跳转未完成。");
    } catch (error) {
      if (callerSignal.aborted) return failure("公众号文章采集已取消。", "REQUEST_CANCELLED");
      if (timeout.signal.aborted) return failure("公众号文章采集超时，请稍后重试。", "WECHAT_COLLECT_TIMEOUT");
      if (error instanceof CollectionFailure) throw error;
      return failure("公众号文章采集失败，未保存内容；请检查网络或文章访问状态。");
    } finally { clearTimeout(timer); }
  };
}

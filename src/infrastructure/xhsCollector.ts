import type { CollectedReference, CollectionInput, CollectionResult } from "../domain/references.ts";
import { isJsonObject } from "../domain/json.ts";
import { WorkbenchFault } from "../domain/workbenchFault.ts";
import type { ReferenceCollect } from "../ports/references.ts";
import { redactText } from "./redaction.ts";

const ID = /^[a-f0-9]{24}$/u;
// The upstream concatenates this value into a URL. Reject separators rather
// than letting a supplied share token add a second query or fragment.
const TOKEN = /^[A-Za-z0-9_+/=-]{1,4096}$/u;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const fault = (code: string, message: string, retryable = false): never => { throw new WorkbenchFault(code, message, retryable); };
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) fault(code, message); }

interface Link { id: string; token: string }
interface Dependencies { fetch?: typeof fetch; env?: Readonly<Record<string, string | undefined>>; now?: () => number; timeoutMs?: number }
interface Runtime { fetch: typeof fetch; endpoint: URL; headers: Record<string, string>; signal: AbortSignal; bytes: number; secrets: Set<string> }

function link(input: CollectionInput): Link {
  requireValue(input.kind === "xhs_note" || input.kind === "xhs_author", "XHS_INPUT_INVALID", "请选择小红书笔记或作者作品采集。");
  requireValue(typeof input.url === "string" && input.url.length <= 8192 && !/[\u0000-\u0020\u007f]/u.test(input.url), "XHS_URL_INVALID", "请输入完整的小红书 HTTPS 分享链接。");
  let url: URL; try { url = new URL(input.url); } catch { return fault("XHS_URL_INVALID", "小红书链接格式无效。"); }
  if (["xhslink.com", "www.xhslink.com"].includes(url.hostname)) fault("XHS_SHORT_LINK_UNSUPPORTED", "请先在浏览器打开短链接，再复制完整的小红书笔记或作者分享链接；当前不自动展开短链接。");
  requireValue(url.protocol === "https:" && ["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash, "XHS_URL_INVALID", "只支持小红书官方 HTTPS 笔记或作者链接。");
  const pattern = input.kind === "xhs_note" ? /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/u : /^\/user\/profile\/([a-f0-9]{24})\/?$/u;
  const match = pattern.exec(url.pathname);
  requireValue(match, "XHS_URL_INVALID", "链接路径与所选采集类型不一致。");
  const tokens = url.searchParams.getAll("xsec_token");
  requireValue(tokens.length === 1 && TOKEN.test(tokens[0]!), "XHS_SHARE_TOKEN_REQUIRED", "本地小红书服务需要完整分享链接中的访问参数；请重新复制完整分享链接，访问参数不会保存。");
  requireValue(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 5, "XHS_LIMIT_INVALID", "每次只能采集 1 至 5 篇作者作品。");
  return { id: match[1]!, token: tokens[0]! };
}
function endpoint(env: Dependencies["env"]): { url: URL; headers: Record<string, string>; token: string } {
  const vars = env ?? process.env;
  let url: URL;
  try { url = new URL(vars.XHS_MCP_URL || `http://${vars.XHS_MCP_HOST || "127.0.0.1"}:${vars.XHS_MCP_PORT || "18060"}/mcp`); }
  catch { return fault("XHS_SERVICE_CONFIG_INVALID", "本地小红书服务地址配置无效。"); }
  requireValue(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash, "XHS_SERVICE_CONFIG_INVALID", "小红书采集只允许使用已配置的本机服务入口。");
  const token = vars.XHS_MCP_AUTH_TOKEN ?? "";
  requireValue(token.length <= 8192 && !/[\u0000-\u0020\u007f]/u.test(token), "XHS_SERVICE_CONFIG_INVALID", "本地小红书服务授权配置无效。");
  return { url, token, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}
function assertActive(runtime: Runtime): void { if (runtime.signal.aborted) fault("XHS_COLLECTION_TIMEOUT", "小红书采集等待已结束，请稍后重试。", true); }

/** Fixed read-only REST actions from xiaohongshu-mcp 332d196854a9 routes.go. */
async function request(runtime: Runtime, route: "login/status" | "feeds/detail" | "user/profile", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertActive(runtime);
  const local = new AbortController();
  const signal = AbortSignal.any([runtime.signal, local.signal]);
  const timer = setTimeout(() => local.abort(), 45_000); timer.unref();
  try {
    const response = await runtime.fetch(new URL(`/api/v1/${route}`, runtime.endpoint), {
      method: body ? "POST" : "GET", redirect: "error", signal,
      headers: { ...runtime.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) { await response.body?.cancel(); return fault("XHS_SERVICE_UNAUTHORIZED", "本地小红书服务授权失败，请检查服务连接。"); }
    requireValue(response.ok && response.headers.get("content-type")?.includes("application/json") && response.body, "XHS_READ_FAILED", "小红书内容暂时无法读取，请检查登录状态与分享链接。");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (signal.aborted) fault("XHS_COLLECTION_TIMEOUT", "小红书采集等待已结束，请稍后重试。", true);
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; runtime.bytes += next.value.length;
        requireValue(bytes <= RESPONSE_LIMIT && runtime.bytes <= TOTAL_LIMIT, "XHS_RESPONSE_LIMIT", "本次小红书内容超过安全读取大小，已停止继续采集。");
        chunks.push(next.value);
      }
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
    if (signal.aborted) fault("XHS_COLLECTION_TIMEOUT", "小红书采集等待已结束，请稍后重试。", true);
    let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fault("XHS_RESPONSE_INVALID", "小红书服务返回内容格式不正确。"); }
    requireValue(isJsonObject(value) && value.success === true && isJsonObject(value.data), "XHS_RESPONSE_INVALID", "小红书服务未返回可核验的内容。");
    return value.data;
  } catch (error) {
    if (error instanceof WorkbenchFault) throw error;
    if (signal.aborted) fault("XHS_COLLECTION_TIMEOUT", "小红书采集等待已结束，请稍后重试。", true);
    return fault("XHS_READ_FAILED", "本地小红书服务暂时不可用，或该分享链接无法读取。", true);
  } finally { clearTimeout(timer); }
}

function remember(runtime: Runtime, value: unknown): void { if (typeof value === "string" && value && value.length <= 8192) runtime.secrets.add(value); }
function publicText(runtime: Runtime, value: string, maximum: number): { value: string; partial: boolean } {
  let text = value;
  for (const secret of runtime.secrets) text = text.replaceAll(secret, "[访问凭证已移除]");
  text = text.replace(/\b(?:xsec_token|xsecToken|access_token|refresh_token|id_token)\s*[=:]\s*["']?[^\s"'&#<>]+/giu, "[访问凭证已移除]");
  text = redactText(text, { maxLength: maximum + 1 }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const partial = text !== value || text.length > maximum;
  return { value: text.slice(0, maximum), partial };
}
function mediaUrl(runtime: Runtime, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !(/^(?:[a-z0-9-]+\.)+xhscdn\.com$/u.test(url.hostname) || url.hostname === "ci.xiaohongshu.com")) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (/token|authorization|cookie/iu.test(decoded) || [...runtime.secrets].some(secret => decoded.includes(secret))) return null;
    // Media are source references, never a saved authenticated/signed URL.
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}
function project(runtime: Runtime, raw: Record<string, unknown>, expectedId: string, expectedAuthor: string | undefined, now: number): CollectedReference {
  requireValue(raw.feed_id === expectedId && isJsonObject(raw.data) && isJsonObject(raw.data.note), "XHS_NOTE_ID_MISMATCH", "返回的笔记身份与分享链接不一致，未保存该内容。");
  const note = raw.data.note;
  requireValue(note.noteId === expectedId && ["normal", "video"].includes(String(note.type)) && typeof note.title === "string" && typeof note.desc === "string" && isJsonObject(note.user), "XHS_NOTE_INVALID", "笔记正文或类型无法核验，未保存该内容。");
  requireValue(typeof note.user.userId === "string" && ID.test(note.user.userId) && (!expectedAuthor || note.user.userId === expectedAuthor), "XHS_AUTHOR_MISMATCH", "笔记作者与所选作者不一致，未保存该内容。");
  remember(runtime, note.xsecToken);
  const rawAuthor = typeof note.user.nickname === "string" && note.user.nickname.trim() ? note.user.nickname : typeof note.user.nickName === "string" ? note.user.nickName : "";
  const title = publicText(runtime, note.title, 300), text = publicText(runtime, note.desc, 50_000), author = publicText(runtime, rawAuthor, 150);
  let partial = title.partial || text.partial || author.partial || !author.value.trim();
  const time = typeof note.time === "number" && Number.isSafeInteger(note.time) && note.time >= Date.UTC(2005, 0, 1) && note.time <= now + 86_400_000 ? note.time : null;
  if (time === null) partial = true;
  const media: CollectedReference["media"] = [];
  const images = Array.isArray(note.imageList) ? note.imageList : [];
  for (const image of images.slice(0, 30)) {
    const url = isJsonObject(image) ? mediaUrl(runtime, image.urlDefault) ?? mediaUrl(runtime, image.urlPre) : null;
    if (url && !media.some(item => item.url === url)) media.push({ kind: "image", url }); else if (!url) partial = true;
  }
  if (images.length > 30) partial = true;
  if (note.type === "video") {
    let video: string | null = null;
    const streams = isJsonObject(note.video) && isJsonObject(note.video.media) && isJsonObject(note.video.media.stream) ? Object.values(note.video.media.stream).slice(0, 10) : [];
    for (const group of streams) if (Array.isArray(group)) for (const stream of group.slice(0, 10)) {
      if (!isJsonObject(stream) || video) continue;
      for (const url of Array.isArray(stream.backupUrls) ? stream.backupUrls.slice(0, 5) : []) { video = mediaUrl(runtime, url); if (video) break; }
      video ??= mediaUrl(runtime, stream.masterUrl);
    }
    if (video) media.push({ kind: "video", url: video }); else partial = true;
  } else if (!media.length) partial = true;
  const tags = [...new Set([...text.value.matchAll(/#([^#\r\n]{1,80})#/gu)].map(match => match[1]!.replace(/\[话题\]$/u, "").trim()).filter(Boolean))].slice(0, 30);
  return { platform: "xiaohongshu", sourceId: expectedId, url: `https://www.xiaohongshu.com/explore/${expectedId}`, title: title.value, author: author.value, publishedAt: time === null ? null : new Date(time).toISOString(), kind: note.type === "video" ? "video" : "image_text", text: text.value, tags, completeness: partial ? "partial" : "complete", media };
}

/** Reuses the running local MCP service. Never starts browsers/services or reads Cookie files itself. */
export function createXhsCollector(options: { enabled: boolean }, dependencies: Dependencies = {}): ReferenceCollect {
  return async (input, callerSignal): Promise<CollectionResult> => {
    if (!options.enabled) fault("XHS_COLLECTOR_DISABLED", "小红书采集尚未连接本地服务。");
    if (callerSignal.aborted) fault("REQUEST_CANCELLED", "内容采集已取消。");
    const target = link(input), service = endpoint(dependencies.env);
    const lifetime = new AbortController(); const timeout = Math.min(90_000, Math.max(1, dependencies.timeoutMs ?? 90_000));
    const timer = setTimeout(() => lifetime.abort(), timeout); timer.unref();
    const runtime: Runtime = { fetch: dependencies.fetch ?? globalThis.fetch, endpoint: service.url, headers: service.headers, signal: AbortSignal.any([callerSignal, lifetime.signal]), bytes: 0, secrets: new Set([target.token, ...(service.token ? [service.token] : [])]) };
    try {
      const status = await request(runtime, "login/status");
      requireValue(typeof status.is_logged_in === "boolean", "XHS_LOGIN_STATUS_INVALID", "小红书登录状态无法核验，请检查本地服务版本。");
      requireValue(status.is_logged_in, "XHS_LOGIN_REQUIRED", "小红书登录已失效，请先在账号管理中登录。");
      remember(runtime, status.user_id);
      const now = dependencies.now?.() ?? Date.now();
      if (input.kind === "xhs_note") {
        const detail = await request(runtime, "feeds/detail", { feed_id: target.id, xsec_token: target.token, load_all_comments: false });
        const item = project(runtime, detail, target.id, undefined, now);
        return { items: [item], partial: item.completeness === "partial", message: item.completeness === "partial" ? "已保存笔记参考；部分正文或媒体来源不完整，媒体未下载。" : "已读取单篇笔记正文与公开媒体来源；媒体未下载，不包含评论。" };
      }
      const envelope = await request(runtime, "user/profile", { user_id: target.id, xsec_token: target.token, tab: "note" });
      requireValue(isJsonObject(envelope.data) && Array.isArray(envelope.data.feeds), "XHS_PROFILE_INVALID", "作者近期作品列表无法核验。");
      const candidates: Link[] = [], seen = new Set<string>(); let skipped = 0;
      for (const raw of envelope.data.feeds) {
        if (!isJsonObject(raw) || raw.modelType !== "note") continue;
        remember(runtime, raw.xsecToken);
        if (typeof raw.id !== "string" || !ID.test(raw.id) || typeof raw.xsecToken !== "string" || !TOKEN.test(raw.xsecToken)) { skipped++; continue; }
        if (seen.has(raw.id)) continue;
        seen.add(raw.id); candidates.push({ id: raw.id, token: raw.xsecToken });
      }
      const items: CollectedReference[] = [];
      for (const candidate of candidates.slice(0, input.limit)) {
        if (callerSignal.aborted) fault("REQUEST_CANCELLED", "内容采集已取消。");
        if (lifetime.signal.aborted || runtime.bytes >= TOTAL_LIMIT) { skipped++; break; }
        try {
          const detail = await request(runtime, "feeds/detail", { feed_id: candidate.id, xsec_token: candidate.token, load_all_comments: false });
          items.push(project(runtime, detail, candidate.id, target.id, now));
        } catch (error) {
          if (callerSignal.aborted) fault("REQUEST_CANCELLED", "内容采集已取消。");
          if (error instanceof WorkbenchFault && error.code === "XHS_SERVICE_UNAUTHORIZED") throw error;
          skipped++;
          if (lifetime.signal.aborted || runtime.bytes >= TOTAL_LIMIT) break;
        }
      }
      if (!items.length && candidates.length) fault("XHS_READ_FAILED", "作者作品详情暂时无法读取，请检查完整分享链接或稍后重试。", true);
      return { items, partial: true, message: `已读取作者当前页面的 ${items.length} 篇作品参考${skipped ? "，部分作品未能读取" : ""}；仅限页面当前返回的笔记（可能含置顶），不代表按时间排序的全部历史作品。媒体未下载。` };
    } catch (error) {
      if (callerSignal.aborted) fault("REQUEST_CANCELLED", "内容采集已取消。");
      if (error instanceof WorkbenchFault) throw error;
      return fault("XHS_READ_FAILED", "小红书内容暂时无法读取，请检查本地服务与分享链接。", true);
    } finally { clearTimeout(timer); lifetime.abort(); }
  };
}

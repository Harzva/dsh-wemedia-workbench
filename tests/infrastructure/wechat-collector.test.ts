import { describe, expect, it, vi } from "vitest";
import { createWechatCollector } from "../../src/infrastructure/wechatCollector.ts";
import { WorkbenchFault } from "../../src/domain/workbenchFault.ts";

const URL = "https://mp.weixin.qq.com/s/synthetic-public-article";
const signal = () => new AbortController().signal;
function html(body = "<p>第一段：学术写作 &amp; 来源记录。</p><p>第二段正文。</p>", extra = "") {
  // Synthetic text in the same DOM structure as the pinned upstream 普通图文 samples.
  return `<!doctype html><html><head><title>学术写作</title><meta name="keywords" content="论文,写作,论文"></head><body>
    <div id="js_article"><h1 id="activity-name">学术写作 &amp; 来源</h1><span id="js_author_name">研究作者</span><a id="js_name">研究公众号</a>
    <em id="publish_time"></em><div id="js_content" style="visibility:hidden">${body}</div></div>
    <script>var ct = "1788912000"; globalThis.WECHAT_SHOULD_NOT_RUN = true;</script>${extra}</body></html>`;
}
function response(body: string, headers: Record<string, string> = {}) { return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } }); }
function fixture(body = html()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(body));
  const collect = createWechatCollector({ fetch });
  return { fetch, collect, run: (url = URL) => collect({ kind: "wechat_article", url, limit: 1 }, signal()) };
}

describe("WeChat public article collector", () => {
  it("extracts the real article structure as plain text, preserving author/date and paragraph boundaries", async () => {
    const f = fixture(), result = await f.run(`${URL}?pass_ticket=PRIVATE&token=PRIVATE#rd`), item = result.items[0]!;
    expect(item).toMatchObject({ platform: "wechat", url: URL, title: "学术写作 & 来源", author: "研究作者", publishedAt: "2026-09-09T00:00:00.000Z", kind: "article", text: "第一段：学术写作 & 来源记录。\n第二段正文。", tags: ["论文", "写作"], completeness: "complete", media: [] });
    expect(result.partial).toBe(false); expect(item.sourceId).toMatch(/^wechat:[a-f0-9]{64}$/u);
    expect(f.fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" }));
    expect(JSON.stringify(f.fetch.mock.calls)).not.toMatch(/PRIVATE|pass_ticket|authorization|cookie/iu);
    expect((globalThis as Record<string, unknown>).WECHAT_SHOULD_NOT_RUN).toBeUndefined();
  });

  it.each([
    "http://mp.weixin.qq.com/s/a", "https://mp.weixin.qq.com:443/s/a", "https://mp.weixin.qq.com:8443/s/a",
    "https://user:pass@mp.weixin.qq.com/s/a", "https://mp.weixin.qq.com@127.0.0.1/s/a", "https://127.0.0.1/s/a",
    "https://169.254.169.254/s/a", "https://[::1]/s/a", "https://mp.weixin.qq.com.evil.example/s/a", "https://mp.weixin.qq.com./s/a",
    "https://mp.weixin.qq.com/cgi-bin/appmsg", "https://mp.weixin.qq.com/s/../cgi-bin/test", "https://mp.weixin.qq.com/s/%2Ftest",
    "https://mp.weixin.qq.com\\@evil.example/s/a", "https://mp.weixin.qq.com/s/a\n", "https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=x",
  ])("rejects unsafe or non-article input before making a request: %s", async url => {
    const f = fixture(); await expect(f.run(url)).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("retains only required long-link identity fields and rejects ambiguous duplicates", async () => {
    const f = fixture(), query = "__biz=MzA%3D%3D&mid=123&idx=1&sn=0123456789abcdef0123456789abcdef";
    const item = (await f.run(`https://mp.weixin.qq.com/s?${query}&uin=PRIVATE&key=PRIVATE&scene=1`)).items[0]!;
    expect(item.url).toBe(`https://mp.weixin.qq.com/s?${query}`);
    await expect(f.run(`https://mp.weixin.qq.com/s?${query}&mid=456`)).rejects.toThrow("唯一");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a same-domain article redirect using manual redirect policy and sanitized target", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/s/redirected?token=PRIVATE" } }));
    const item = (await f.run()).items[0]!;
    expect(item.url).toBe("https://mp.weixin.qq.com/s/redirected"); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[1]![0]).toBe(item.url);
  });

  it.each(["https://evil.example/s/a", "http://mp.weixin.qq.com/s/a", "https://mp.weixin.qq.com:443/s/a", "//127.0.0.1/s/a", "/cgi-bin/login", "file:///etc/passwd"])("blocks an unsafe redirect without requesting its target: %s", async target => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } }));
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds redirect loops", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: URL } }));
    await expect(f.run()).rejects.toThrow("跳转过多"); expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["/mp/wappoc_appmsgcaptcha?poc_token=PRIVATE_CHALLENGE&target_url=PRIVATE_TARGET", "WECHAT_VERIFICATION_REQUIRED", "验证"],
    ["/cgi-bin/bizlogin?ticket=PRIVATE_CHALLENGE", "WECHAT_LOGIN_REQUIRED", "登录"],
    ["/mp/login?token=PRIVATE_CHALLENGE", "WECHAT_LOGIN_REQUIRED", "登录"],
    ["/mp/unknown?token=PRIVATE_CHALLENGE", "WECHAT_REDIRECT_UNSUPPORTED", "非文章"],
    ["/s?unknown=PRIVATE_CHALLENGE", "WECHAT_REDIRECT_UNSUPPORTED", "身份"],
  ])("classifies a server redirect without blaming the valid source URL or visiting the restricted target", async (location, code, message) => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    const error = await f.run("https://mp.weixin.qq.com/s/tr38EieqyftubIx2FMWUWw").catch(value => value);
    expect(error).toBeInstanceOf(WorkbenchFault); expect(error).toMatchObject({ code, safeMessage: expect.stringContaining(message) });
    expect(error.safeMessage).not.toMatch(/PRIVATE|请提供|poc_token|target_url/u); expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies an unexpected challenge response URL and cancels its unread body", async () => {
    const f = fixture(), cancel = vi.fn();
    const challenge = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } });
    Object.defineProperty(challenge, "url", { value: "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=PRIVATE" });
    f.fetch.mockResolvedValueOnce(challenge);
    await expect(f.run()).rejects.toMatchObject({ code: "WECHAT_VERIFICATION_REQUIRED" }); expect(cancel).toHaveBeenCalled();
  });

  it("never executes article code or follows embedded resources, and keeps only safe public media URLs", async () => {
    const f = fixture(html(`<p onclick="steal()">公开正文</p><script>EXFILTRATE_SECRET()</script><style>BODY_CSS</style><div id="js_top_ad_area">ADVERTISEMENT</div>
      <img src="data:image/png;base64,AAAA" data-src="https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png&amp;token=PRIVATE">
      <img src="https://127.0.0.1/internal"><img src="https://mmbiz.qpic.cn:443/mmbiz_png/a"><img src="javascript:alert(1)">
      <img src="https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png"><iframe src="https://v.qq.com/iframe/player.html?vid=public_vid&amp;key=PRIVATE">IFRAME_TEXT</iframe>
      <svg><script>SVG_CODE</script><text>SVG_TEXT</text></svg><form><input name="secret">FORM_TEXT</form>`));
    const item = (await f.run()).items[0]!;
    expect(item.text).toBe("公开正文");
    expect(item.media).toEqual([{ kind: "image", url: "https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png" }, { kind: "video", url: "https://v.qq.com/iframe/player.html?vid=public_vid" }]);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(item)).not.toMatch(/PRIVATE|EXFILTRATE|ADVERTISEMENT|IFRAME_TEXT|SVG_CODE|FORM_TEXT/u);
  });

  it.each([
    ["<div class='weui-msg'><div class='weui-msg__title'>该内容已被发布者删除</div></div>", "删除"],
    ["<title>环境异常</title><div class='weui-msg'><h2 class='weui-msg__title'>完成验证后即可继续访问</h2></div>", "验证"],
    ["<div class='mesg-block'>请登录后阅读全文</div>", "登录"],
    [html("免费预览", "<script>var is_pay_subscribe = '1' * 1;</script>"), "付费"],
    [html("免费预览", "<div id='js_pay_content'>购买后阅读全文</div>"), "付费"],
    ["<div id='js_content'>只是普通网页内容</div>", "结构"],
    [html().replace('id="js_author_name"', 'id="other_author"').replace('id="js_name"', 'id="other_name"'), "作者"],
    [html("<script>onlyScript()</script>"), "文字正文"],
  ])("does not save a challenge, unavailable page or paid preview as an article", async (body, message) => {
    await expect(fixture(body).run()).rejects.toThrow(message);
  });

  it("does not mistake a legitimate article about verification or paid content for a challenge", async () => {
    const f = fixture(html("<p>这篇文章讨论安全验证和付费阅读。</p>").replace("<title>学术写作</title>", "<title>安全验证</title>"));
    expect((await f.run()).items[0]!.completeness).toBe("complete");
  });

  it("uses public-account author fallback and parses visible China-local publication times without executing JS", async () => {
    const f = fixture(html().replace('<span id="js_author_name">研究作者</span>', "").replace('var ct = "1788912000";', "").replace('<em id="publish_time"></em>', '<em id="publish_time">2026年09月09日 10:45</em>'));
    expect((await f.run()).items[0]).toMatchObject({ author: "研究公众号", publishedAt: "2026-09-09T02:45:00.000Z" });
    const unknown = fixture(html().replace('var ct = "1788912000";', "")); expect((await unknown.run()).items[0]!.publishedAt).toBeNull();
  });

  it("limits text and media and visibly marks truncation as partial", async () => {
    const body = `<p>${"文".repeat(50_003)}</p>` + Array.from({ length: 55 }, (_, i) => `<img data-src="https://mmbiz.qpic.cn/mmbiz_png/${i}">`).join("");
    const result = await fixture(html(body)).run();
    expect(result.partial).toBe(true); expect(result.items[0]!.text).toHaveLength(50_000); expect(result.items[0]!.media).toHaveLength(50);
    expect(result.items[0]!.completeness).toBe("partial");
  });

  it("enforces the 3 MB limit on both declared and streamed bytes", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(response("", { "content-length": String(3 * 1024 * 1024 + 1) }));
    await expect(f.run()).rejects.toThrow("3 MB");
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1)); }, cancel: cancelled });
    f.fetch.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/html" } }));
    await expect(f.run()).rejects.toThrow("3 MB"); expect(cancelled).toHaveBeenCalled();
  });

  it("rejects non-HTML, HTTP errors and invalid UTF-8 without leaking response bodies or transport errors", async () => {
    const f = fixture();
    for (const status of [401, 403, 429, 500]) { f.fetch.mockResolvedValueOnce(new Response("PRIVATE_REMOTE_BODY", { status })); await expect(f.run()).rejects.not.toThrow("PRIVATE_REMOTE_BODY"); }
    f.fetch.mockResolvedValueOnce(new Response("{\"value\":1}", { headers: { "content-type": "application/json" } })); await expect(f.run()).rejects.toThrow("HTML");
    f.fetch.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "text/html" } })); await expect(f.run()).rejects.toThrow("采集失败");
    f.fetch.mockRejectedValueOnce(new Error("PRIVATE_TOKEN /local/private/path")); await expect(f.run()).rejects.not.toThrow("PRIVATE_TOKEN");
  });

  it("times out a stalled fetch and a stalled body, and cancels body reading", async () => {
    const collect = createWechatCollector({ timeoutMs: 10, fetch: vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined)) });
    await expect(collect({ kind: "wechat_article", url: URL, limit: 1 }, signal())).rejects.toThrow("超时");
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel });
    const collectBody = createWechatCollector({ timeoutMs: 10, fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(stream, { headers: { "content-type": "text/html" } })) });
    await expect(collectBody({ kind: "wechat_article", url: URL, limit: 1 }, signal())).rejects.toThrow("超时"); expect(cancel).toHaveBeenCalled();
  });

  it("honors cancellation before sending any request and rejects the wrong collector kind", async () => {
    const f = fixture(), aborted = new AbortController(); aborted.abort();
    await expect(f.collect({ kind: "wechat_article", url: URL, limit: 1 }, aborted.signal)).rejects.toThrow("取消");
    await expect(f.collect({ kind: "xhs_note", url: URL, limit: 1 }, signal())).rejects.toThrow("单篇"); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("passes safe actionable faults to the workbench while replacing unknown transport messages", async () => {
    const f = fixture("<div class='weui-msg'><div class='weui-msg__title'>环境异常，请完成验证</div></div>");
    const error = await f.run().catch(value => value);
    expect(error).toBeInstanceOf(WorkbenchFault); expect(error).toMatchObject({ code: "WECHAT_VERIFICATION_REQUIRED", safeMessage: expect.stringContaining("验证") });
    f.fetch.mockRejectedValueOnce(new Error("PRIVATE_URL https://localhost/secret?token=PRIVATE"));
    const network = await f.run().catch(value => value);
    expect(network).toBeInstanceOf(WorkbenchFault); expect(network.safeMessage).toContain("采集失败"); expect(network.safeMessage).not.toContain("PRIVATE");
  });
});

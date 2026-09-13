import { describe, expect, it, vi } from "vitest";
import { createXhsCollector } from "../../src/infrastructure/xhsCollector.ts";
import type { CollectionInput } from "../../src/domain/references.ts";

const NOTE = "a".repeat(24), SECOND = "b".repeat(24), THIRD = "c".repeat(24), AUTHOR = "d".repeat(24), LOGIN = "e".repeat(24);
const TOKEN = "private_share_token", SERVICE_TOKEN = "private_service_token";
const env = { XHS_MCP_AUTH_TOKEN: SERVICE_TOKEN };
const now = Date.UTC(2026, 8, 9);
const input = (kind: "xhs_note" | "xhs_author" = "xhs_note", limit = 3): CollectionInput => ({ kind, limit, url: `https://www.xiaohongshu.com/${kind === "xhs_note" ? `explore/${NOTE}` : `user/profile/${AUTHOR}`}?xsec_token=${TOKEN}&xsec_source=pc_share` });
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, data }), { status, headers: { "Content-Type": "application/json" } });
const status = () => response({ is_logged_in: true, user_id: LOGIN, username: "private login username" });
function detail(id = NOTE, changes: Record<string, unknown> = {}) {
  return { feed_id: id, data: { note: { noteId: id, title: "公开笔记", desc: "这是一篇公开笔记。#创作[话题]# #人工智能#", type: "normal", time: now - 60_000, user: { userId: AUTHOR, nickname: "公开作者" }, imageList: [{ urlDefault: "https://sns-webpic-qc.xhscdn.com/public-image.webp?sign=ephemeral_signature" }], ...changes }, comments: { list: [{ content: "never collect comments" }] } } };
}
const feed = (id: string, xsecToken = `token_for_${id}`, modelType = "note") => ({ id, xsecToken, modelType, noteCard: { user: { userId: AUTHOR }, displayTitle: "不要用列表摘要代替正文" } });
const profile = (feeds: unknown[]) => response({ data: { userBasicInfo: { nickname: "公开作者" }, feeds } });
const signal = () => new AbortController().signal;

describe("Xiaohongshu reference collector", () => {
  it("uses only login status and read-only note detail routes, removes access secrets and saves a canonical reference", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(response(detail(NOTE, { desc: `正文 #创作[话题]# ${TOKEN} xsec_token=unexpected_return_token ${SERVICE_TOKEN} ${LOGIN}` })));
    const collect = createXhsCollector({ enabled: true }, { fetch: http, env, now: () => now });
    expect(http).not.toHaveBeenCalled();
    const result = await collect(input(), signal());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ sourceId: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}`, author: "公开作者", kind: "image_text", publishedAt: new Date(now - 60_000).toISOString(), tags: ["创作"], media: [{ kind: "image", url: "https://sns-webpic-qc.xhscdn.com/public-image.webp" }] });
    expect(JSON.stringify(result)).not.toMatch(/private_share_token|private_service_token|unexpected_return_token|ephemeral_signature|private login username|never collect comments/u);
    expect(JSON.stringify(result)).not.toContain(LOGIN);
    expect(http.mock.calls.map(call => [String(call[0]), call[1]?.method])).toEqual([["http://127.0.0.1:18060/api/v1/login/status", "GET"], ["http://127.0.0.1:18060/api/v1/feeds/detail", "POST"]]);
    expect(JSON.parse(String(http.mock.calls[1]![1]?.body))).toEqual({ feed_id: NOTE, xsec_token: TOKEN, load_all_comments: false });
    expect(http.mock.calls.every(call => call[1]?.redirect === "error")).toBe(true);
    expect(http.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: `Bearer ${SERVICE_TOKEN}` });
  });

  it("reads only the current author note page, keeps good details after one failure, and never labels it full history", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(profile([feed(NOTE), feed(NOTE), feed(SECOND), feed(THIRD), feed("f".repeat(24), "live", "live_v2")]))
      .mockResolvedValueOnce(response(detail())).mockRejectedValueOnce(new Error(`Cookie: ${SERVICE_TOKEN}`)).mockResolvedValueOnce(response(detail(THIRD)));
    const result = await createXhsCollector({ enabled: true }, { fetch: http, env, now: () => now })(input("xhs_author"), signal());
    expect(result.items.map(item => item.sourceId)).toEqual([NOTE, THIRD]);
    expect(result.partial).toBe(true); expect(result.message).toContain("部分作品未能读取"); expect(result.message).toContain("不代表");
    expect(JSON.parse(String(http.mock.calls[1]![1]?.body))).toEqual({ user_id: AUTHOR, xsec_token: TOKEN, tab: "note" });
    expect(http).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toMatch(/token_for_|private_share_token|private_service_token|列表摘要/u);
  });

  it("honors the author limit and verifies each detail author and note ID", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(profile([feed(NOTE), feed(SECOND), feed(THIRD)]))
      .mockResolvedValueOnce(response(detail(NOTE, { user: { userId: SECOND, nickname: "另一作者" } }))).mockResolvedValueOnce(response(detail(SECOND)));
    const result = await createXhsCollector({ enabled: true }, { fetch: http, env, now: () => now })(input("xhs_author", 2), signal());
    expect(result.items.map(item => item.sourceId)).toEqual([SECOND]); expect(http).toHaveBeenCalledTimes(4);
    const wrong = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(response(detail(SECOND)));
    await expect(createXhsCollector({ enabled: true }, { fetch: wrong, env })(input(), signal())).rejects.toMatchObject({ code: "XHS_NOTE_ID_MISMATCH" });
  });

  it("throws an actionable login error before collecting when the session is expired", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(response({ is_logged_in: false }));
    await expect(createXhsCollector({ enabled: true }, { fetch: http, env })(input(), signal())).rejects.toMatchObject({ code: "XHS_LOGIN_REQUIRED" });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([
    `http://www.xiaohongshu.com/explore/${NOTE}?xsec_token=${TOKEN}`,
    `https://www.xiaohongshu.com.evil.invalid/explore/${NOTE}?xsec_token=${TOKEN}`,
    `https://user:secret@www.xiaohongshu.com/explore/${NOTE}?xsec_token=${TOKEN}`,
    `https://www.xiaohongshu.com/feeds/like?xsec_token=${TOKEN}`,
    `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=one&xsec_token=two`,
    `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=abc%26tab%3Dfav`,
  ])("rejects untrusted or ambiguous input before any request: %s", async url => {
    const http = vi.fn<typeof fetch>();
    await expect(createXhsCollector({ enabled: true }, { fetch: http, env })({ ...input(), url }, signal())).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });

  it("clearly rejects short links and canonical links lacking required upstream access parameters", async () => {
    const http = vi.fn<typeof fetch>(); const collect = createXhsCollector({ enabled: true }, { fetch: http, env });
    await expect(collect({ ...input(), url: "https://xhslink.com/a/Example" }, signal())).rejects.toMatchObject({ code: "XHS_SHORT_LINK_UNSUPPORTED" });
    await expect(collect({ ...input(), url: `https://www.xiaohongshu.com/explore/${NOTE}` }, signal())).rejects.toMatchObject({ code: "XHS_SHARE_TOKEN_REQUIRED" });
    await expect(collect({ ...input(), limit: 6 }, signal())).rejects.toMatchObject({ code: "XHS_LIMIT_INVALID" });
    expect(http).not.toHaveBeenCalled();
  });

  it("refuses a remote or credential-bearing local service URL and does not silently fall back", async () => {
    const http = vi.fn<typeof fetch>();
    for (const url of ["http://remote.invalid/mcp", "http://127.0.0.1:18060/mcp?auth=secret", "http://user:secret@127.0.0.1:18060/mcp"]) {
      await expect(createXhsCollector({ enabled: true }, { fetch: http, env: { XHS_MCP_URL: url } })(input(), signal())).rejects.toMatchObject({ code: "XHS_SERVICE_CONFIG_INVALID" });
    }
    await expect(createXhsCollector({ enabled: false }, { fetch: http, env })(input(), signal())).rejects.toMatchObject({ code: "XHS_COLLECTOR_DISABLED" });
    expect(http).not.toHaveBeenCalled();
  });

  it("projects video sources without signed parameters and clips overlong text with a partial marker", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(response(detail(NOTE, {
      type: "video", desc: "文".repeat(50_100), video: { media: { stream: { h264: [{ masterUrl: "https://sns-video-hw.xhscdn.com/signed.mp4?sign=never_persist", backupUrls: ["https://sns-video-hw.xhscdn.com/public.mp4"] }] } } },
      imageList: [{ urlDefault: "http://127.0.0.1/private.png" }, { urlDefault: "data:image/svg+xml,<svg/>" }],
    })));
    const result = await createXhsCollector({ enabled: true }, { fetch: http, env, now: () => now })(input(), signal());
    expect(result.items[0]).toMatchObject({ kind: "video", completeness: "partial", media: [{ kind: "video", url: "https://sns-video-hw.xhscdn.com/public.mp4" }] });
    expect(result.items[0]!.text.length).toBeLessThanOrEqual(50_000); expect(JSON.stringify(result)).not.toContain("never_persist");
  });

  it("rejects excessive responses and contains raw errors without persisting their details", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(response({ unexpected: "x".repeat(2 * 1024 * 1024) }));
    await expect(createXhsCollector({ enabled: true }, { fetch: http, env })(input(), signal())).rejects.toMatchObject({ code: "XHS_RESPONSE_LIMIT" });
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error(`xsec_token=${TOKEN} Authorization: ${SERVICE_TOKEN} /Users/private/profile`));
    await expect(createXhsCollector({ enabled: true }, { fetch: broken, env })(input(), signal())).rejects.toMatchObject({ code: "XHS_READ_FAILED", message: expect.not.stringMatching(/private_share_token|private_service_token|\/Users\/private/u) });
  });

  it("keeps already collected author items when the total deadline aborts a later detail", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(profile([feed(NOTE), feed(SECOND)]))
      .mockResolvedValueOnce(response(detail())).mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const result = await createXhsCollector({ enabled: true }, { fetch: http, env, timeoutMs: 30, now: () => now })(input("xhs_author", 2), signal());
    expect(result.items.map(item => item.sourceId)).toEqual([NOTE]); expect(result.partial).toBe(true); expect(result.message).toContain("部分作品未能读取");
  });

  it("does not return partial results after the user cancels", async () => {
    const cancellation = new AbortController();
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(status()).mockResolvedValueOnce(profile([feed(NOTE), feed(SECOND)]))
      .mockResolvedValueOnce(response(detail())).mockImplementationOnce(async () => { cancellation.abort(); throw new Error("cancelled"); });
    await expect(createXhsCollector({ enabled: true }, { fetch: http, env, now: () => now })(input("xhs_author", 2), cancellation.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });
});

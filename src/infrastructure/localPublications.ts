import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { isLibraryTimestamp } from "../domain/contentLibrary.ts";
import { isJsonObject } from "../domain/json.ts";
import { CHANNELS } from "../domain/primitives.ts";
import type { Channel } from "../domain/primitives.ts";
import type { PublicationRecord, PublicationSourceSummary } from "../domain/publication.ts";
import type { PublicationReader } from "../ports/publication.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 20_000;
const MAX_LINE_BYTES = 256 * 1024;
const PRIVATE_SEGMENT = /(?:^\.|credential|secret|password|cookie|authorization|api[-_.]?key|access[-_.]?token|refresh[-_.]?token|^node_modules$)/iu;
const PUBLISHED = new Set(["published", "already_published", "published_replacement", "published_final_cropfix", "published_via_xhs_mcp", "published_via_visible_creator"]);
const DRAFT = new Set(["draft", "drafted", "draft_created", "drafted_replacement", "draft_prepared", "local_draft", "local_draft_prepared_non_api", "draft-prepared", "drafted_smoke"]);
const READY = new Set(["ready", "prepared", "staged", "staged_local", "staged_for_manual_review", "prepared_local", "ready_after_visual_fix_not_published", "queued"]);
const REMOVED = new Set(["deleted", "removed", "hidden", "superseded"]);
const REFERENCE_FIELDS = new Set(["article_path", "clean_article_path", "draft_path", "draft_json_path", "local_draft_path", "local_html_path", "html_path", "live_draft_path", "clean_draft_path", "compact_html_path", "note_path", "record_path", "post_markdown_path"]);

export function publicationTimestamp(value: unknown): string | null {
  return isLibraryTimestamp(value) ? new Date(value).toISOString() : null;
}

/** Allow only public post addresses; remove tracking and reject auth/redirect URLs. */
export function safePublicationUrl(value: unknown, channel: Channel): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/u, "");
  if (channel === "zhihu" && (host === "zhuanlan.zhihu.com" && /^\/p\/\d+$/u.test(path) || ["www.zhihu.com", "zhihu.com"].includes(host) && /^\/question\/\d+\/answer\/\d+$/u.test(path))) return `https://${host}${path}`;
  if (channel === "xiaohongshu" && ["www.xiaohongshu.com", "xiaohongshu.com"].includes(host) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}$/iu.test(path)) return `https://${host}${path}`;
  if (channel === "x" && ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host) && /^\/[A-Za-z0-9_]{1,15}\/status\/\d+$/u.test(path)) return `https://${host}${path}`;
  if (channel === "wechat" && host === "mp.weixin.qq.com") {
    if (/^\/s\/[A-Za-z0-9_-]+$/u.test(path)) return `https://${host}${path}`;
    if (path === "/s") {
      const values = ["__biz", "mid", "idx", "sn"].map(key => [key, url.searchParams.get(key)] as const);
      if (values.every(([, item]) => item !== null && /^[A-Za-z0-9_=+-]{1,200}$/u.test(item))) return `https://${host}/s?${new URLSearchParams(values as [string, string][]).toString()}`;
    }
  }
  return null;
}

export function hasExplicitPublishedStatus(value: unknown): boolean { return typeof value === "string" && PUBLISHED.has(value); }

export type LocalPublicationSummary = PublicationSourceSummary;

interface InventoryArticle { url: string; publishedAt: string | null }
interface Snapshot {
  ledger: Record<string, unknown>[];
  xiaohongshu: Record<string, unknown>[];
  ledgerReliable: boolean;
  xiaohongshuReliable: boolean;
  inventory: Map<string, InventoryArticle>;
  summary: LocalPublicationSummary;
}

/** This reader has no process, network, credential or publication capability. */
export class LocalPublications implements PublicationReader {
  private readonly root: string;
  private pending: Promise<Snapshot> | undefined;
  constructor(private readonly options: { workspaceRoot: string; ledgerPath?: string; zhihuInventoryPath?: string; xiaohongshuLedgerPath?: string }) {
    if (!isAbsolute(options.workspaceRoot) || resolve(options.workspaceRoot) === parse(options.workspaceRoot).root) throw new Error("发布记录根目录必须是明确的绝对工作区目录");
    this.root = resolve(options.workspaceRoot);
  }

  private reference(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\\]/u.test(value)) return null;
    const absolute = isAbsolute(value) ? resolve(value) : resolve(this.root, value);
    const path = relative(this.root, absolute);
    if (!path || path.startsWith("../") || isAbsolute(path) || path.split("/").some(part => PRIVATE_SEGMENT.test(part))) return null;
    return absolute;
  }

  private workspaceIdentity(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 4096 || value !== value.trim() || /[\u0000-\u001f\u007f\\:?#]/u.test(value) || /%[0-9a-f]{2}/iu.test(value)) return null;
    const path = value.startsWith("./") ? value.slice(2) : value;
    const parts = path.split("/");
    if (isAbsolute(path) || parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || PRIVATE_SEGMENT.test(part))) return null;
    // Identity comparison only. Do not use this reference to read a body or asset.
    return this.reference(path);
  }

  private async safePath(value: string): Promise<string> {
    const path = this.reference(value);
    if (!path || await realpath(this.root) !== this.root) throw new Error("rejected");
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("rejected");
    let current = this.root;
    for (const part of relative(this.root, path).split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("rejected");
    }
    if (await realpath(path) !== path) throw new Error("rejected");
    return path;
  }

  private async read(value: string): Promise<string> {
    const path = await this.safePath(value);
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error("unsupported");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      const bytes = Number(before.size);
      if (!before.isFile() || bytes > MAX_BYTES) throw new Error("too large");
      const signature = (state: typeof before): string => `${state.dev}:${state.ino}:${state.size}:${state.mtimeNs}:${state.ctimeNs}`;
      const data = Buffer.alloc(bytes);
      const result = await handle.read(data, 0, bytes, 0);
      if (result.bytesRead !== bytes || await this.safePath(value) !== path) throw new Error("changed");
      const after = await handle.stat({ bigint: true });
      const entry = await lstat(path, { bigint: true });
      if (!entry.isFile() || signature(after) !== signature(before) || signature(entry) !== signature(before)) throw new Error("changed");
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } finally { await handle.close(); }
  }

  private async load(): Promise<Snapshot> {
    const issues = new Set<string>();
    let available = false;
    const readLines = async (path: string | undefined, code: string): Promise<{ rows: Record<string, unknown>[]; reliable: boolean }> => {
      if (path === undefined) return { rows: [], reliable: true };
      let raw: string;
      try { raw = await this.read(path); available = true; } catch { issues.add(code); return { rows: [], reliable: false }; }
      const rows: Record<string, unknown>[] = [];
      const lines = raw.split("\n");
      if (lines.length > MAX_RECORDS + 1) { issues.add(code); return { rows: [], reliable: false }; }
      let reliable = true;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("large line");
          const value: unknown = JSON.parse(line);
          if (!isJsonObject(value)) throw new Error("invalid");
          rows.push(value);
        } catch { reliable = false; issues.add(code); }
      }
      return { rows, reliable };
    };
    const [ledgerSource, xiaohongshuSource] = await Promise.all([
      readLines(this.options.ledgerPath, "LOCAL_PUBLICATION_LEDGER_UNAVAILABLE"),
      readLines(this.options.xiaohongshuLedgerPath, "LOCAL_XIAOHONGSHU_RECEIPTS_UNAVAILABLE"),
    ]);
    const ledger = ledgerSource.rows;
    const xiaohongshu = xiaohongshuSource.rows;
    const inventory = new Map<string, InventoryArticle>();
    let checkedAt: string | null = null;
    if (this.options.zhihuInventoryPath !== undefined) try {
      const value: unknown = JSON.parse(await this.read(this.options.zhihuInventoryPath));
      if (!isJsonObject(value) || !Array.isArray(value.articles) || value.articles.length > MAX_RECORDS) throw new Error("invalid");
      checkedAt = publicationTimestamp(value.fetched_at);
      if (!checkedAt) throw new Error("unknown inventory date");
      available = true;
      for (const article of value.articles) {
        if (!isJsonObject(article)) { issues.add("LOCAL_ZHIHU_INVENTORY_PARTIAL"); continue; }
        const url = safePublicationUrl(article.url, "zhihu");
        if (!url) { issues.add("LOCAL_ZHIHU_INVENTORY_PARTIAL"); continue; }
        // Inventory creation time does not establish when the article was published.
        const publishedAt = publicationTimestamp(article.published_at);
        inventory.set(url, { url, publishedAt });
      }
    } catch { inventory.clear(); checkedAt = null; issues.add("LOCAL_ZHIHU_INVENTORY_UNAVAILABLE"); }
    const channels = CHANNELS.filter(channel => channel === "zhihu" && inventory.size > 0 || channel === "xiaohongshu" && xiaohongshu.length > 0 || ledger.some(row => isJsonObject(row.platforms) && row.platforms[channel] !== undefined));
    return { ledger, xiaohongshu, ledgerReliable: ledgerSource.reliable, xiaohongshuReliable: xiaohongshuSource.reliable, inventory, summary: { available, checkedAt, counts: { ledgerRecords: ledger.length, zhihuArticles: inventory.size, xiaohongshuRecords: xiaohongshu.length }, channels, issues: [...issues] } };
  }

  private snapshot(): Promise<Snapshot> {
    if (!this.pending) {
      const promise = this.load();
      this.pending = promise;
      void promise.finally(() => { if (this.pending === promise) this.pending = undefined; }).catch(() => {});
    }
    return this.pending;
  }

  async readSummary(): Promise<LocalPublicationSummary> { return (await this.snapshot()).summary; }

  private paths(row: Record<string, unknown>): string[] {
    const objects = [row, ...(isJsonObject(row.platforms) ? Object.values(row.platforms).filter(isJsonObject) : [])];
    return objects.flatMap(object => Object.entries(object).flatMap(([key, value]) => {
      const path = REFERENCE_FIELDS.has(key) ? this.reference(value) : null;
      return path ? [path] : [];
    }));
  }

  private fact(channel: Channel, value: Record<string, unknown>, row: Record<string, unknown>, snapshot: Snapshot): PublicationRecord {
    const state = typeof value.status === "string" ? value.status : "";
    const base: PublicationRecord = { channel, status: "unknown", publishedAt: null, checkedAt: null, url: null, evidence: "none", note: "本地记录尚无可确认的发布结果" };
    if (REMOVED.has(state)) return { ...base, status: "removed", evidence: "local_receipt", note: "本地记录已移除，尚未重新在线核对" };
    if (/^(?:blocked|failed)(?:_|$)/u.test(state) || /(?:_blocked|_failed)(?:_|$)/u.test(state)) return { ...base, status: "failed", evidence: "local_receipt", note: "本地记录显示上次发布受阻，请检查平台状态" };
    if (DRAFT.has(state)) return { ...base, status: "draft", evidence: "local_draft", note: "本地记录为草稿，尚无正式发布证据" };
    if (READY.has(state)) return { ...base, status: "ready", evidence: "local_draft", note: "本地记录已准备，尚无正式发布证据" };
    if (!hasExplicitPublishedStatus(state)) return base;
    const url = safePublicationUrl(value.replacement_url, channel) ?? safePublicationUrl(value.url, channel);
    if (!url) return { ...base, evidence: "local_receipt", note: "本地回执声称发布，但缺少可核对的作品链接" };
    const article = channel === "zhihu" ? snapshot.inventory.get(url) : undefined;
    const publishedAt = article?.publishedAt ?? publicationTimestamp(value.published_at) ?? publicationTimestamp(value.publishedAt) ?? publicationTimestamp(row.published_at);
    return { ...base, status: "published", publishedAt, checkedAt: article ? snapshot.summary.checkedAt : null, url, evidence: article ? "remote_readback" : "local_receipt", note: article ? "截至库存同步时间的历史回读，不证明当前版本或当前线上状态" : "已有本地发布回执，不证明当前版本或当前线上状态" };
  }

  async lookup(input: { sourcePaths: readonly string[]; workspaceRelativePaths?: readonly string[] }): Promise<{ publications: PublicationRecord[]; issues: string[] }> {
    const sourcePaths = new Set([
      ...input.sourcePaths.slice(0, 100).map(path => this.reference(path)),
      ...(input.workspaceRelativePaths ?? []).slice(0, 100).map(path => this.workspaceIdentity(path)),
    ].filter((path): path is string => path !== null));
    if (sourcePaths.size === 0) return { publications: [], issues: [] };
    const snapshot = await this.snapshot();
    const facts = new Map<Channel, Array<{ record: PublicationRecord; at: string | null }>>();
    const add = (record: PublicationRecord, value: Record<string, unknown>, row: Record<string, unknown>, reliable: boolean): void => {
      const entries = facts.get(record.channel) ?? [];
      const at = publicationTimestamp(value.occurred_at) ?? publicationTimestamp(row.occurred_at) ?? publicationTimestamp(row.created_at) ?? publicationTimestamp(value.published_at) ?? publicationTimestamp(row.published_at);
      // A damaged later row may be the removal of an older successful post.
      const safeRecord: PublicationRecord = !reliable && record.status === "published" ? { ...record, status: "unknown", url: null, publishedAt: null, checkedAt: null, evidence: "none", note: "发布记录来源损坏，历史成功记录需重新核对" } : record;
      entries.push({ record: safeRecord, at: safeRecord !== record ? null : at });
      facts.set(record.channel, entries);
    };
    for (const row of snapshot.ledger) {
      if (!this.paths(row).some(path => sourcePaths.has(path)) || !isJsonObject(row.platforms)) continue;
      for (const channel of CHANNELS) {
        const value = row.platforms[channel];
        if (isJsonObject(value)) add(this.fact(channel, value, row, snapshot), value, row, snapshot.ledgerReliable);
      }
    }
    for (const row of snapshot.xiaohongshu) {
      if (this.paths(row).some(path => sourcePaths.has(path))) add(this.fact("xiaohongshu", row, row, snapshot), row, row, snapshot.xiaohongshuReliable);
    }
    const publications = CHANNELS.flatMap(channel => {
      const entries = facts.get(channel);
      if (!entries?.length) return [];
      const meaningful = entries.filter(({ record }) => record.status !== "unknown" || record.evidence !== "none" || record.note.includes("来源损坏"));
      const candidates = meaningful.length ? meaningful : entries;
      const uncertainConflict = candidates.some((left, index) => candidates.slice(index + 1).some(right =>
        (left.record.status !== right.record.status || left.record.status === "published" && left.record.url !== right.record.url) &&
        (!left.at || !right.at || left.at === right.at)));
      if (uncertainConflict) return [{ channel, status: "unknown", publishedAt: null, checkedAt: null, url: null, evidence: "none", note: "本地记录状态冲突且时间顺序不明确，请重新核对平台结果" } satisfies PublicationRecord];
      const ordered = [...candidates].sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
      const latest = ordered.at(-1)!.record;
      if (latest.status === "removed") return [latest];
      // A later failed retry does not undo a proven earlier publication.
      const publicationFact = [...ordered].reverse().find(({ record }) => record.status === "published" || record.status === "removed");
      return [publicationFact?.record ?? latest];
    });
    const verifiedPublications = publications.map(record => {
      // An unreadable source may contain a newer removal even when it yielded
      // zero usable rows, so another source's older success cannot fill the gap.
      if (record.status === "published" && (!snapshot.ledgerReliable || record.channel === "xiaohongshu" && !snapshot.xiaohongshuReliable)) return { ...record, status: "unknown", publishedAt: null, checkedAt: null, url: null, evidence: "none", note: "发布记录来源不完整，其他来源的历史成功结果需重新核对" } satisfies PublicationRecord;
      return record;
    });
    return { publications: verifiedPublications, issues: snapshot.summary.issues };
  }
}

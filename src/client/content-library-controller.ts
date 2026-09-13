import type { LibraryDetail, LibraryItem, LibraryListInput, LibraryMediaChunk, LibraryPage } from "../domain/contentLibrary.ts";
import { LIBRARY_MEDIA_MAX_BYTES, LIBRARY_MEDIA_CHUNK_BYTES } from "../domain/contentLibrary.ts";
import type { ArticleCategory } from "../domain/articleTaxonomy.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";
import type { BatchPreflightResult } from "../domain/batchPreflight.ts";
import { DRAFT_BATCH_LIMIT } from "../domain/draftBatch.ts";

export type ContentLibraryKind = "all" | LibraryItem["kind"];
export type ContentLibraryCategory = "all" | "article" | "video" | "image_text" | "image";
export type ContentLibraryDatePreset = "all" | "today" | "7d" | "30d" | "custom";
export type ContentLibraryPublicationStatus = "all" | "draft" | "ready" | "published" | "unknown";
export type ContentLibraryRequest =
  | ({ operation: "library_list" } & LibraryListInput)
  | { operation: "library_read"; itemId: string }
  | { operation: "batch_preflight"; contentRefs: ContentRef[]; channels: Channel[] }
  | { operation: "library_media"; itemId: string; offset: number; length: number; revisionDigest: string };
/** The owner unwraps the native Remote answer; no local paths enter the Client. */
export type ContentLibraryRequestFn = (request: ContentLibraryRequest, signal: AbortSignal) => Promise<unknown>;
export const CONTENT_MEDIA_LIMIT = LIBRARY_MEDIA_MAX_BYTES;
export const CONTENT_MEDIA_CHUNK = LIBRARY_MEDIA_CHUNK_BYTES;
export const CONTENT_SELECTION_LIMIT = DRAFT_BATCH_LIMIT;
export const CONTENT_PREFLIGHT_LIMIT = 20;

export type ContentBatchResult = BatchPreflightResult;

export interface ContentLibraryState {
  open: boolean;
  connected: boolean;
  kind: ContentLibraryKind;
  publicationType: "all" | "article" | "video" | "image_text";
  publicationStatus: ContentLibraryPublicationStatus;
  channel: "all" | Channel;
  timeField: "updated" | "created" | "published";
  category: "all" | ArticleCategory;
  conference: string;
  year: "all" | number;
  tag: string;
  facets: NonNullable<LibraryPage["facets"]>;
  datePreset: ContentLibraryDatePreset;
  dateFrom: string;
  dateTo: string;
  updatedFrom: string | null;
  updatedTo: string | null;
  sort: "updated_desc" | "updated_asc";
  filterError: string | null;
  query: string;
  items: LibraryItem[];
  total: number;
  nextCursor: string | null;
  issues: string[];
  truncated: boolean;
  listLoading: boolean;
  listError: string | null;
  selected: string | null;
  detail: LibraryDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  cancelled: boolean;
  mediaUrl: string | null;
  mediaLoadedBytes: number;
  mediaTotalBytes: number;
  checked: Array<{ contentRef: ContentRef; title: string }>;
  batchChannels: Channel[];
  batchResult: ContentBatchResult | null;
  batchLoading: boolean;
  batchError: string | null;
}

const defaultFilters = { kind: "all", publicationType: "all", publicationStatus: "all", channel: "all", timeField: "updated", category: "all", conference: "", year: "all", tag: "", datePreset: "all", dateFrom: "", dateTo: "", updatedFrom: null, updatedTo: null, sort: "updated_desc", query: "", filterError: null } as const;
const emptyFacets = (): NonNullable<LibraryPage["facets"]> => ({ categories: [], conferences: [], years: [], tags: [] });

function localDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1000 || year > 9998) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
const localDateLabel = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Local calendar days include both displayed dates; the Host receives a half-open instant range. */
export function contentDateRange(preset: ContentLibraryDatePreset, from = "", to = "", now = new Date()): { dateFrom: string; dateTo: string; updatedFrom: string | null; updatedTo: string | null } {
  if (preset === "all") return { dateFrom: "", dateTo: "", updatedFrom: null, updatedTo: null };
  if (preset !== "custom") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - (preset === "7d" ? 6 : preset === "30d" ? 29 : 0));
    from = localDateLabel(start); to = localDateLabel(now);
  }
  const start = from ? localDay(from) : null;
  const end = to ? localDay(to) : null;
  if ((from && !start) || (to && !end)) throw new Error("请输入有效日期。");
  if (start && end && start > end) throw new Error("开始日期不能晚于结束日期。");
  if (end) end.setDate(end.getDate() + 1);
  return { dateFrom: from, dateTo: to, updatedFrom: start?.toISOString() ?? null, updatedTo: end?.toISOString() ?? null };
}

export function contentFilterCount(state: ContentLibraryState): number {
  return Number(state.kind !== "all" || state.publicationType !== "all") + Number(state.publicationStatus !== "all") + Number(state.channel !== "all") + Number(!!state.updatedFrom || !!state.updatedTo) + Number(!!state.query) + Number(state.category !== "all") + Number(!!state.conference) + Number(state.year !== "all") + Number(!!state.tag);
}
export function contentCategory(state: ContentLibraryState): ContentLibraryCategory {
  return state.kind === "image" ? "image" : state.publicationType !== "all" ? state.publicationType : state.kind;
}

export interface ContentMediaUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

const mediaTypes: Record<"image" | "video", readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/ogg"],
};

/** Reject transport corruption before allocating a Blob or letting a browser decode it. */
export function decodeContentMediaChunk(chunk: LibraryMediaChunk, item: LibraryItem, offset: number, total: number): Uint8Array<ArrayBuffer> {
  if (chunk.itemId !== item.itemId || chunk.revisionDigest !== item.revisionDigest || chunk.offset !== offset || chunk.totalBytes !== total || chunk.mediaType !== item.mediaType) throw new Error("MEDIA_CHANGED");
  const encoded = chunk.dataBase64;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(CONTENT_MEDIA_CHUNK / 3) * 4 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("MEDIA_INVALID");
  const decoded = atob(encoded);
  const expected = Math.min(CONTENT_MEDIA_CHUNK, total - offset);
  if (decoded.length !== expected || chunk.eof !== (offset + decoded.length === total)) throw new Error("MEDIA_INVALID");
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

function safeError(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : "";
  if (code === "MEDIA_TOO_LARGE" || code === "LIBRARY_MEDIA_TOO_LARGE") return "文件超过 64 MB，暂时无法在这里预览。";
  if (code === "MEDIA_CHANGED" || code === "LIBRARY_MEDIA_CHANGED" || code === "LIBRARY_CHANGED") return "文件已变化，请重新加载当前内容。";
  if (code === "MEDIA_INVALID" || code === "LIBRARY_MEDIA_UNSUPPORTED") return "这个文件暂时不支持安全预览。";
  return fallback;
}

/** Owns only disposable presentation state; discovery and file access stay on Host. */
export class ContentLibraryController {
  private state: ContentLibraryState = { ...defaultFilters, facets: emptyFacets(), open: false, connected: false, items: [], total: 0, nextCursor: null, issues: [], truncated: false, listLoading: false, listError: null, selected: null, detail: null, detailLoading: false, detailError: null, cancelled: false, mediaUrl: null, mediaLoadedBytes: 0, mediaTotalBytes: 0, checked: [], batchChannels: ["wechat", "zhihu", "xiaohongshu", "x"], batchResult: null, batchLoading: false, batchError: null };
  private listeners = new Set<() => void>();
  private listRequest: AbortController | null = null;
  private detailRequest: AbortController | null = null;
  private batchRequest: AbortController | null = null;
  private stopped = false;
  private revision: string | null = null;
  constructor(private readonly request: ContentLibraryRequestFn, private readonly urls: ContentMediaUrls = { create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url) }) {}
  getSnapshot = (): ContentLibraryState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(update: Partial<ContentLibraryState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  connect(): void { if (this.stopped) return; this.patch({ connected: true }); if (this.state.open) void this.refresh(); }
  unavailable(): void {
    this.cancelList(); this.cancelDetail(); this.cancelBatch();
    this.patch({ connected: false, listError: "内容服务正在连接，请稍后重试。", detail: null, detailError: null });
  }
  open(): void {
    if (this.stopped || this.state.open) return;
    this.patch({ open: true });
    if (this.state.connected) void this.refresh();
  }
  close(): void {
    this.cancelList(); this.cancelDetail(); this.cancelBatch();
    this.patch({ open: false, detail: null, detailError: null, cancelled: false });
  }
  dispose(): void { this.close(); this.stopped = true; this.listeners.clear(); }
  private releaseMedia(): void { if (this.state.mediaUrl) this.urls.revoke(this.state.mediaUrl); this.patch({ mediaUrl: null, mediaLoadedBytes: 0, mediaTotalBytes: 0 }); }
  private cancelList(): void { this.listRequest?.abort(); this.listRequest = null; this.patch({ listLoading: false }); }
  private cancelDetail(): void { this.detailRequest?.abort(); this.detailRequest = null; this.releaseMedia(); this.patch({ detailLoading: false }); }
  cancelPreview(): void { this.cancelDetail(); this.patch({ cancelled: true }); }
  cancelSearch(): void { this.cancelList(); this.patch({ listError: "已取消读取内容，点击重试继续加载。" }); }
  clearSelection(): void { this.cancelDetail(); this.patch({ selected: null, detail: null, detailError: null, cancelled: false }); }
  private async updateFilters(update: Partial<ContentLibraryState>): Promise<void> {
    this.cancelList();
    this.revision = null;
    // A cancelled filter request must not leave rows or a cursor from another query.
    this.patch({ ...update, items: [], total: 0, nextCursor: null });
    await this.loadList(false);
  }
  async setKind(kind: ContentLibraryKind): Promise<void> { await this.updateFilters({ kind, publicationType: "all" }); }
  async setCategory(category: ContentLibraryCategory): Promise<void> {
    await this.updateFilters({ kind: category === "image" ? "image" : "all", publicationType: category === "all" || category === "image" ? "all" : category });
  }
  async setPublicationStatus(publicationStatus: ContentLibraryPublicationStatus): Promise<void> { await this.updateFilters({ publicationStatus }); }
  async setChannel(channel: ContentLibraryState["channel"]): Promise<void> { await this.updateFilters({ channel }); }
  async setTimeField(timeField: ContentLibraryState["timeField"]): Promise<void> { await this.updateFilters({ timeField }); }
  async setArticleCategory(category: ContentLibraryState["category"]): Promise<void> { await this.updateFilters({ category }); }
  async setConference(conference: string): Promise<void> { await this.updateFilters({ conference }); }
  async setYear(year: ContentLibraryState["year"]): Promise<void> { await this.updateFilters({ year }); }
  async setTag(tag: string): Promise<void> { await this.updateFilters({ tag }); }
  async setSort(sort: ContentLibraryState["sort"]): Promise<void> { await this.updateFilters({ sort }); }
  async setDateRange(datePreset: ContentLibraryDatePreset, dateFrom = "", dateTo = "", now = new Date()): Promise<void> {
    let range: ReturnType<typeof contentDateRange>;
    try { range = contentDateRange(datePreset, dateFrom, dateTo, now); }
    catch (error) { this.patch({ datePreset, dateFrom, dateTo, filterError: error instanceof Error ? error.message : "请输入有效日期。" }); return; }
    await this.updateFilters({ datePreset, ...range, filterError: null });
  }
  async clearFilters(): Promise<void> { await this.updateFilters(defaultFilters); }
  async search(query: string): Promise<void> { await this.updateFilters({ query: query.trim().slice(0, 200) }); }
  async refresh(): Promise<void> {
    const loaded = await this.loadList(false);
    if (loaded && this.state.open && this.state.connected && this.state.selected && !this.state.detailLoading) await this.select(this.state.selected);
  }
  async loadMore(): Promise<void> { if (this.state.nextCursor && !this.state.listLoading) await this.loadList(true); }
  private async loadList(append: boolean): Promise<boolean> {
    if (!this.state.connected || this.stopped) return false;
    this.cancelList();
    const owner = new AbortController(); this.listRequest = owner;
    const current = (): boolean => !this.stopped && !owner.signal.aborted && this.listRequest === owner;
    this.patch({ listLoading: true, listError: null });
    try {
      const input: ContentLibraryRequest = { operation: "library_list", pageSize: 50,
        ...(this.state.query ? { query: this.state.query } : {}), ...(this.state.kind === "all" ? {} : { kind: this.state.kind }),
        ...(this.state.publicationType === "all" ? {} : { publicationType: this.state.publicationType }),
        ...(this.state.publicationStatus === "all" ? {} : { publicationStatus: this.state.publicationStatus }),
        ...(this.state.channel === "all" ? {} : { channel: this.state.channel }), ...(this.state.timeField === "updated" ? {} : { timeField: this.state.timeField }),
        ...(this.state.category === "all" ? {} : { category: this.state.category }), ...(this.state.conference ? { conference: this.state.conference } : {}),
        ...(this.state.year === "all" ? {} : { year: this.state.year }), ...(this.state.tag ? { tag: this.state.tag } : {}),
        ...(this.state.updatedFrom ? { updatedFrom: this.state.updatedFrom } : {}), ...(this.state.updatedTo ? { updatedTo: this.state.updatedTo } : {}),
        ...(this.state.sort === "updated_desc" ? {} : { sort: this.state.sort }),
        ...(append && this.state.nextCursor ? { cursor: this.state.nextCursor } : {}) };
      const page = await this.request(input, owner.signal) as LibraryPage;
      if (!current()) return false;
      if (!page || !Array.isArray(page.items) || typeof page.total !== "number" || typeof page.revisionDigest !== "string") throw new Error("INVALID_RESPONSE");
      // A changed inventory invalidates pagination instead of mixing two snapshots.
      if (append && this.revision !== page.revisionDigest) { this.listRequest = null; return await this.loadList(false); }
      this.revision = page.revisionDigest;
      const items = append ? [...new Map([...this.state.items, ...page.items].map(item => [item.itemId, item])).values()] : page.items;
      this.patch({ items, total: page.total, nextCursor: page.nextCursor, issues: page.issues ?? [], truncated: page.truncated ?? false, facets: page.facets ?? emptyFacets() });
      return true;
    } catch (error) { if (current()) this.patch({ listError: safeError(error, "未能读取内容库，请重试。") }); return false; }
    finally { if (current()) { this.listRequest = null; this.patch({ listLoading: false }); } }
  }
  toggleChecked(item: LibraryItem, checked: boolean): void {
    const contentRef = item.publicationRef ?? item.contentRef;
    if (!contentRef) return;
    this.cancelBatch();
    const previous = this.state.checked.filter(value => value.contentRef !== contentRef);
    this.patch({ checked: checked ? previous.length < CONTENT_SELECTION_LIMIT ? [...previous, { contentRef, title: item.title }] : this.state.checked : previous, batchResult: null, batchError: null });
  }
  clearChecked(): void { this.cancelBatch(); this.patch({ checked: [], batchResult: null, batchError: null }); }
  setBatchChannels(batchChannels: Channel[]): void { this.cancelBatch(); this.patch({ batchChannels: [...new Set(batchChannels)], batchResult: null, batchError: null }); }
  cancelBatch(): void { this.batchRequest?.abort(); this.batchRequest = null; this.patch({ batchLoading: false }); }
  async runBatchPreflight(): Promise<void> {
    if (!this.state.connected || !this.state.checked.length || !this.state.batchChannels.length || this.stopped) return;
    if (this.state.checked.length > CONTENT_PREFLIGHT_LIMIT) {
      this.patch({ batchResult: null, batchError: `批量预检最多支持 ${CONTENT_PREFLIGHT_LIMIT} 份内容，请先减少勾选。` });
      return;
    }
    this.cancelBatch();
    const owner = new AbortController(); this.batchRequest = owner;
    const current = () => !this.stopped && !owner.signal.aborted && this.batchRequest === owner;
    this.patch({ batchLoading: true, batchResult: null, batchError: null });
    try {
      const result = await this.request({ operation: "batch_preflight", contentRefs: this.state.checked.map(value => value.contentRef), channels: [...this.state.batchChannels] }, owner.signal) as ContentBatchResult;
      if (!current()) return;
      if (result?.schemaVersion !== "wemedia.batch-preflight/v1" || !Array.isArray(result.results)) throw new Error("INVALID_RESPONSE");
      this.patch({ batchResult: result });
    } catch { if (current()) this.patch({ batchError: "批量检查未完成，请重试。" }); }
    finally { if (current()) { this.batchRequest = null; this.patch({ batchLoading: false }); } }
  }
  async select(itemId: string): Promise<void> {
    if (!this.state.connected || this.stopped) return;
    this.cancelDetail();
    const owner = new AbortController(); this.detailRequest = owner;
    const current = (): boolean => !this.stopped && !owner.signal.aborted && this.detailRequest === owner && this.state.selected === itemId;
    this.patch({ selected: itemId, detail: null, detailLoading: true, detailError: null, cancelled: false });
    try {
      const detail = await this.request({ operation: "library_read", itemId }, owner.signal) as LibraryDetail;
      if (!current()) return;
      if (!detail?.item || detail.item.itemId !== itemId) throw new Error("INVALID_RESPONSE");
      this.patch({ detail });
      const item = detail.item;
      if (item.publicationRef || item.kind === "article") return;
      if (!item.mediaType || !mediaTypes[item.kind]?.includes(item.mediaType)) throw new Error("MEDIA_INVALID");
      if (!Number.isSafeInteger(item.bytes) || !item.bytes || item.bytes < 0 || item.bytes > CONTENT_MEDIA_LIMIT) throw new Error(item.bytes && item.bytes > CONTENT_MEDIA_LIMIT ? "MEDIA_TOO_LARGE" : "MEDIA_INVALID");
      const total = item.bytes;
      this.patch({ mediaTotalBytes: total });
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let offset = 0; offset < total;) {
        const chunk = await this.request({ operation: "library_media", itemId, offset, length: CONTENT_MEDIA_CHUNK, revisionDigest: item.revisionDigest }, owner.signal) as LibraryMediaChunk;
        if (!current()) return;
        if (!chunk || typeof chunk !== "object") throw new Error("MEDIA_INVALID");
        const part = decodeContentMediaChunk(chunk, item, offset, total);
        parts.push(part); offset += part.length; this.patch({ mediaLoadedBytes: offset });
      }
      if (!current()) return;
      const url = this.urls.create(new Blob(parts, { type: item.mediaType }));
      if (!current()) { this.urls.revoke(url); return; }
      this.patch({ mediaUrl: url });
    } catch (error) { if (current()) { this.releaseMedia(); this.patch({ detailError: safeError(error, "未能打开这份内容，请重试。") }); } }
    finally { if (current()) { this.detailRequest = null; this.patch({ detailLoading: false }); } }
  }
}

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ContentRef } from "../domain/primitives.ts";
import { parseContentRef } from "../domain/primitives.ts";
import { isJsonObject } from "../domain/json.ts";
import type { JsonObject } from "../domain/json.ts";
import { channelDocumentPayload } from "../domain/channelDocument.ts";
import type { ChannelDocument } from "../domain/channelDocument.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import { decodePublicationEdit, PUBLICATION_ASSET_ID, PUBLICATION_DRAFT_SCHEMA, publicationText } from "../domain/publicationDraft.ts";
import type { MediaPublicationType, PublicationAsset, PublicationDraft, PublicationEdit, PublicationMediaInput } from "../domain/publicationDraft.ts";
import { isLibraryTimestamp, LIBRARY_MEDIA_CHUNK_BYTES, LIBRARY_MEDIA_MAX_BYTES } from "../domain/contentLibrary.ts";
import type { LibraryMediaChunk } from "../domain/contentLibrary.ts";
import type { ContentLibrary } from "../ports/contentLibrary.ts";
import type { PublicationDrafts, PublicationPlan } from "../ports/publicationDrafts.ts";
import type { RootCapability } from "./pathPolicy.ts";
import { resolveCreateTarget } from "./pathPolicy.ts";
import { WorkbenchStore } from "./workbenchStore.ts";

const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" };
const FOLDER = /^\.wemedia-publication-[a-f0-9-]{36}$/u;
const hash = (input: string | Uint8Array): string => `sha256:${createHash("sha256").update(input).digest("hex")}`;
const fail = (code: string, message: string): never => { throw new WorkbenchFault(code, message); };
const active = (signal: AbortSignal): void => { if (signal.aborted) fail("REQUEST_CANCELLED", "发布稿操作已取消"); };
const utf8 = (bytes: Buffer): string => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("PUBLICATION_INVALID", "发布稿文本无法读取"); } };
function pointers(state: { extensions: JsonObject }): JsonObject {
  const value = state.extensions.publicationDrafts;
  if (value === undefined) return {};
  if (!isJsonObject(value)) return fail("PUBLICATION_STATE_INVALID", "发布稿索引无法安全读取");
  return value;
}
function pointer(value: unknown): { folder: string; revisionDigest: string; history: string[] } | undefined {
  if (value === undefined) return;
  if (!isJsonObject(value) || typeof value.folder !== "string" || !FOLDER.test(value.folder) || typeof value.revisionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.revisionDigest) || !Array.isArray(value.history) || value.history.length > 100 || !value.history.every(item => typeof item === "string" && FOLDER.test(item))) return fail("PUBLICATION_STATE_INVALID", "发布稿版本引用无法安全读取");
  return { folder: value.folder, revisionDigest: value.revisionDigest, history: value.history as string[] };
}
const fingerprint = (draft: Pick<PublicationDraft, "contentRef" | "publicationType" | "title" | "body" | "media" | "coverItemId" | "channels">): string => hash(JSON.stringify({ contentRef: draft.contentRef, publicationType: draft.publicationType, title: draft.title, body: draft.body, media: draft.media.map(({ source, itemId, revisionDigest, title, caption, kind, mediaType, bytes }) => ({ source, itemId, revisionDigest, title, caption, kind, mediaType, bytes })), coverItemId: draft.coverItemId, channels: draft.channels }));
function issuesFor(type: MediaPublicationType, edit: PublicationEdit, media: PublicationAsset[]): string[] {
  const issues: string[] = [];
  if (!edit.body.trim()) issues.push("尚未填写正文或视频说明");
  if (type === "image_text" && !media.length) issues.push("图文尚未添加图片");
  if (type === "video" && !media.some(asset => asset.kind === "video")) issues.push("尚未选择视频");
  if (!edit.channels.length) issues.push("尚未选择目标平台");
  return issues;
}

/** Immutable local versions; the overlay contains pointers, not bodies or media. */
export class FilePublicationDrafts implements PublicationDrafts {
  // One verified asset at a time bounds memory and avoids rehashing a full video for every chunk.
  private cachedAsset: { path: string; signature: string; bytes: Buffer } | undefined;
  private rootIdentity: string | undefined;
  constructor(private readonly options: { root?: RootCapability; store: WorkbenchStore; library: ContentLibrary; now: () => string; channelRecords?: (contentRef: ContentRef, revision: string, documentDigest: string) => import("../domain/publication.ts").PublicationRecord[] }) {}
  private root(): RootCapability { return this.options.root ?? fail("WRITE_ROOT_MISSING", "请先配置独立的内容写入目录"); }
  private async assertRoot(): Promise<string> {
    const root = this.root();
    try {
      const before = await lstat(root.realPath, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root.realPath) !== root.realPath) return fail("PUBLICATION_ROOT_CHANGED", "内容写入目录身份已变化，请重新加载并确认目录");
      const after = await lstat(root.realPath, { bigint: true });
      const identity = [before.dev, before.ino, before.birthtimeNs].join(":");
      if (!after.isDirectory() || after.isSymbolicLink() || identity !== [after.dev, after.ino, after.birthtimeNs].join(":") || this.rootIdentity !== undefined && this.rootIdentity !== identity) return fail("PUBLICATION_ROOT_CHANGED", "内容写入目录身份已变化，请重新加载并确认目录");
      this.rootIdentity ??= identity;
      return identity;
    } catch (error) {
      if (error instanceof WorkbenchFault) throw error;
      return fail("PUBLICATION_ROOT_CHANGED", "内容写入目录身份已变化，请重新加载并确认目录");
    }
  }
  private async exact(path: string): Promise<string> {
    const root = this.root();
    await this.assertRoot();
    const parts = path.split("/");
    if (!FOLDER.test(parts[0] ?? "") || parts.length > 3 || parts.some(part => !part || part === ".." || part.includes("\\"))) return fail("PUBLICATION_PATH_INVALID", "发布稿文件引用无效");
    let current = root.realPath;
    for (const part of ["", ...parts]) {
      if (part) current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return fail("PUBLICATION_PATH_INVALID", "发布稿文件身份发生变化");
    }
    return current;
  }
  private async bytes(path: string, max: number): Promise<Buffer> {
    const file = await this.exact(path), named = await lstat(file, { bigint: true });
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(max) || before.dev !== named.dev || before.ino !== named.ino) return fail("PUBLICATION_FILE_INVALID", "发布稿文件为空、过大或发生变化");
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.length) {
        const read = await handle.read(data, offset, data.length - offset, offset);
        if (!read.bytesRead) return fail("PUBLICATION_CHANGED", "发布稿在读取中变短");
        offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await lstat(await this.exact(path), { bigint: true });
      if (data.length !== Number(before.size) || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) return fail("PUBLICATION_CHANGED", "发布稿文件在读取时发生变化");
      return data;
    } finally { await handle.close(); }
  }
  private async readVersion(contentRef: ContentRef, current: NonNullable<ReturnType<typeof pointer>>): Promise<PublicationDraft> {
    const raw: unknown = JSON.parse(utf8(await this.bytes(`${current.folder}/manifest.json`, 128 * 1024)));
    if (!isJsonObject(raw) || Object.keys(raw).length !== 11 || Object.keys(raw).some(key => !["schemaVersion", "contentRef", "publicationType", "title", "bodyFile", "media", "coverItemId", "channels", "revisionDigest", "createdAt", "updatedAt"].includes(key)) || raw.schemaVersion !== PUBLICATION_DRAFT_SCHEMA || raw.contentRef !== contentRef || (typeof raw.publicationType !== "string" || !["video", "image_text"].includes(raw.publicationType)) || raw.bodyFile !== "body.txt" || !isLibraryTimestamp(raw.createdAt) || !isLibraryTimestamp(raw.updatedAt) || !Array.isArray(raw.media)) return fail("PUBLICATION_INVALID", "发布稿清单无法安全读取");
    const body = utf8(await this.bytes(`${current.folder}/body.txt`, 128 * 1024));
    const media: PublicationAsset[] = raw.media.map(asset => {
      if (!isJsonObject(asset) || Object.keys(asset).length !== 8 || asset.source !== "draft" || typeof asset.itemId !== "string" || !PUBLICATION_ASSET_ID.test(asset.itemId) || asset.revisionDigest !== `sha256:${asset.itemId.slice(18)}` || typeof asset.mediaType !== "string" || !EXTENSIONS[asset.mediaType] || asset.kind !== (asset.mediaType.startsWith("image/") ? "image" : "video") || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) < 1 || Number(asset.bytes) > LIBRARY_MEDIA_MAX_BYTES) return fail("PUBLICATION_INVALID", "发布稿素材清单无效");
      return { source: "draft", itemId: asset.itemId, revisionDigest: asset.revisionDigest, title: publicationText(asset.title, 200), caption: publicationText(asset.caption, 1000, true), mediaType: asset.mediaType, kind: asset.kind as "image" | "video", bytes: Number(asset.bytes) };
    });
    const edit = decodePublicationEdit({ title: raw.title, body, media: media.map(({ source, itemId, revisionDigest, caption }) => ({ source, itemId, revisionDigest, caption })), coverItemId: raw.coverItemId, channels: raw.channels });
    this.validateMedia(raw.publicationType as MediaPublicationType, edit, media);
    const draft: PublicationDraft = { schemaVersion: PUBLICATION_DRAFT_SCHEMA, contentRef, publicationType: raw.publicationType as MediaPublicationType, ...edit, media, createdAt: raw.createdAt, updatedAt: raw.updatedAt, revisionDigest: current.revisionDigest, readOnlySource: this.root().mode === "read", issues: issuesFor(raw.publicationType as MediaPublicationType, edit, media), publications: [] };
    if (fingerprint(draft) !== current.revisionDigest || raw.revisionDigest !== current.revisionDigest) return fail("PUBLICATION_CHANGED", "发布稿内容与已登记版本不一致");
    return { ...draft, publications: this.options.channelRecords?.(contentRef, draft.revisionDigest, hash(channelDocumentPayload(this.channelProjection(draft, current.folder)))) ?? [] };
  }
  async read(contentRef: ContentRef): Promise<PublicationDraft> {
    if (!parseContentRef(contentRef).ok) return fail("REQUEST_INVALID", "内容编号无效");
    const current = pointer(pointers(await this.options.store.read())[contentRef]);
    if (!current) return fail("PUBLICATION_NOT_FOUND", "发布稿不存在或尚未保存");
    return this.readVersion(contentRef, current);
  }
  private channelProjection(draft: PublicationDraft, folder: string): ChannelDocument {
    const assets = draft.media.map(asset => {
      const source = `assets/${asset.itemId.slice(18)}${EXTENSIONS[asset.mediaType]}`;
      return { source, artifact: { rootId: this.root().id, relativePath: `${folder}/${source}` }, digest: asset.revisionDigest, mediaType: asset.mediaType, bytes: asset.bytes };
    });
    return { contentRef: draft.contentRef, publicationType: draft.publicationType, revisionDigest: draft.revisionDigest, title: draft.title, body: draft.body, html: "", assets, coverSource: assets[draft.media.findIndex(asset => asset.itemId === draft.coverItemId)]?.source ?? null };
  }
  async channelDocument(contentRef: ContentRef, signal: AbortSignal): Promise<ChannelDocument> {
    const draft = await this.read(contentRef);
    const current = pointer(pointers(await this.options.store.read())[contentRef])!;
    for (const asset of draft.media) {
      active(signal); await this.draftBytes(contentRef, asset);
    }
    if ((await this.read(contentRef)).revisionDigest !== draft.revisionDigest) fail("PUBLICATION_CHANGED", "发布稿已变化，请重新预览");
    return this.channelProjection(draft, current.folder);
  }
  async list(): Promise<PublicationDraft[]> {
    const entries = Object.entries(pointers(await this.options.store.read()));
    if (entries.length > 2000) return fail("PUBLICATION_LIMIT", "发布稿数量超过当前列表限制");
    const documents: PublicationDraft[] = [];
    for (const [ref, value] of entries) {
      if (!parseContentRef(ref).ok) return fail("PUBLICATION_STATE_INVALID", "发布稿身份索引无效");
      documents.push(await this.readVersion(ref as ContentRef, pointer(value)!));
    }
    return documents;
  }
  async catalog(): Promise<{ drafts: PublicationDraft[]; issues: string[] }> {
    const entries = Object.entries(pointers(await this.options.store.read()));
    if (entries.length > 2000) return fail("PUBLICATION_LIMIT", "发布稿数量超过当前列表限制");
    const drafts: PublicationDraft[] = [];
    let unavailable = 0;
    for (const [ref, value] of entries) {
      try {
        if (!parseContentRef(ref).ok) fail("PUBLICATION_STATE_INVALID", "发布稿身份索引无效");
        drafts.push(await this.readVersion(ref as ContentRef, pointer(value)!));
      } catch { unavailable += 1; }
    }
    return { drafts, issues: unavailable ? [`${unavailable} 份已登记发布稿暂不可读取或版本不一致；原文件保留，请核对本地稿件。`] : [] };
  }
  private validateMedia(type: MediaPublicationType, edit: PublicationEdit, media: PublicationAsset[]): void {
    if (new Set(media.map(asset => asset.itemId)).size !== media.length || media.reduce((total, asset) => total + asset.bytes, 0) > MAX_TOTAL_BYTES) fail("PUBLICATION_MEDIA_INVALID", "素材重复或总体积超过 128 MiB");
    if (type === "image_text" && media.some(asset => asset.kind !== "image") || type === "video" && (media.filter(asset => asset.kind === "video").length > 1 || media.filter(asset => asset.kind === "image").length > 1)) fail("PUBLICATION_MEDIA_INVALID", "图文只支持图片；视频稿支持一段视频及一张封面");
    if (edit.coverItemId && !media.some(asset => asset.itemId === edit.coverItemId && asset.kind === "image")) fail("PUBLICATION_COVER_INVALID", "封面必须是已选图片");
  }
  private async libraryBytes(itemId: string, revision: string, signal: AbortSignal): Promise<{ asset: PublicationAsset; bytes: Buffer }> {
    const { item } = await this.options.library.read(itemId, signal);
    if (!["image", "video"].includes(item.kind) || item.contentRef || item.publicationRef || item.revisionDigest !== revision || !item.mediaType || !EXTENSIONS[item.mediaType] || !item.bytes || item.bytes > LIBRARY_MEDIA_MAX_BYTES) return fail("PUBLICATION_MEDIA_CHANGED", "请选择内容库中当前可用的图片或视频素材");
    const chunks: Buffer[] = []; let offset = 0;
    while (offset < item.bytes) {
      active(signal);
      const chunk = await this.options.library.media({ itemId, revisionDigest: revision, offset, length: LIBRARY_MEDIA_CHUNK_BYTES }, signal);
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (chunk.itemId !== itemId || chunk.revisionDigest !== revision || chunk.offset !== offset || chunk.totalBytes !== item.bytes || chunk.mediaType !== item.mediaType || !bytes.length || bytes.length > LIBRARY_MEDIA_CHUNK_BYTES || offset + bytes.length > item.bytes || chunk.eof !== (offset + bytes.length === item.bytes)) return fail("PUBLICATION_MEDIA_CHANGED", "素材在读取中发生变化");
      chunks.push(bytes); offset += bytes.length;
    }
    const data = Buffer.concat(chunks), digest = hash(data);
    return { bytes: data, asset: { source: "draft", itemId: `publication-asset:${digest.slice(7)}`, revisionDigest: digest, caption: "", title: publicationText(item.title.slice(0, 200), 200), kind: item.kind as "image" | "video", mediaType: item.mediaType, bytes: data.length } };
  }
  private async draftBytes(contentRef: ContentRef, asset: PublicationAsset): Promise<Buffer> {
    const current = pointer(pointers(await this.options.store.read())[contentRef]);
    if (!current) return fail("PUBLICATION_NOT_FOUND", "发布稿不存在");
    const path = `${current.folder}/assets/${asset.itemId.slice(18)}${EXTENSIONS[asset.mediaType]}`;
    const signature = async (): Promise<string> => {
      const info = await lstat(await this.exact(path), { bigint: true });
      if (!info.isFile() || info.size !== BigInt(asset.bytes)) return fail("PUBLICATION_MEDIA_CHANGED", "已保存素材被替换或损坏，请重新选择");
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    };
    const before = await signature();
    if (this.cachedAsset?.path === path && this.cachedAsset.signature === before) return this.cachedAsset.bytes;
    this.cachedAsset = undefined;
    const bytes = await this.bytes(path, LIBRARY_MEDIA_MAX_BYTES);
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.revisionDigest || before !== await signature()) return fail("PUBLICATION_MEDIA_CHANGED", "已保存素材被替换或损坏，请重新选择");
    this.cachedAsset = { path, signature: before, bytes };
    return bytes;
  }
  private async prepare(contentRef: ContentRef, type: MediaPublicationType, expectedRevision: string | null, value: PublicationEdit, signal: AbortSignal, retain: boolean): Promise<{ plan: PublicationPlan; buffers: Buffer[] }> {
    active(signal); const rootIdentity = await this.assertRoot();
    if (!parseContentRef(contentRef).ok || !["image_text", "video"].includes(type)) return fail("REQUEST_INVALID", "发布稿身份或类型无效");
    const edit = decodePublicationEdit(value), stored = pointer(pointers(await this.options.store.read())[contentRef]);
    const previous = stored ? await this.readVersion(contentRef, stored) : undefined;
    if ((previous?.revisionDigest ?? null) !== expectedRevision || previous && previous.publicationType !== type) return fail("REVISION_CHANGED", "发布稿已变化，请重新预览");
    const media: PublicationAsset[] = [], buffers: Buffer[] = [], mapped = new Map<string, string>(); let total = 0;
    for (const selection of edit.media) {
      active(signal);
      let result: { asset: PublicationAsset; bytes: Buffer };
      if (selection.source === "library") result = await this.libraryBytes(selection.itemId, selection.revisionDigest, signal);
      else {
        const asset = previous?.media.find(item => item.itemId === selection.itemId && item.revisionDigest === selection.revisionDigest);
        if (!asset) return fail("PUBLICATION_MEDIA_INVALID", "已保存素材不属于当前发布稿");
        result = { asset, bytes: await this.draftBytes(contentRef, asset) };
      }
      total += result.bytes.length; if (total > MAX_TOTAL_BYTES) return fail("PUBLICATION_MEDIA_INVALID", "素材总量超过 128 MiB");
      mapped.set(selection.itemId, result.asset.itemId); media.push({ ...result.asset, caption: selection.caption });
      if (retain) buffers.push(result.bytes);
    }
    const normalized = { ...edit, coverItemId: edit.coverItemId ? mapped.get(edit.coverItemId)! : null };
    this.validateMedia(type, normalized, media);
    const now = this.options.now();
    const publication: PublicationDraft = { schemaVersion: PUBLICATION_DRAFT_SCHEMA, contentRef, publicationType: type, ...normalized, media, revisionDigest: "", createdAt: previous?.createdAt ?? now, updatedAt: now, readOnlySource: this.root().mode === "read", issues: issuesFor(type, normalized, media), publications: [] };
    publication.revisionDigest = fingerprint(publication);
    await this.assertRoot();
    return { plan: { contentRef, publicationType: type, expectedRevision, edit, inputDigest: hash(JSON.stringify({ rootIdentity, contentRef, type, expectedRevision, edit, revisionDigest: publication.revisionDigest })), publication }, buffers };
  }
  async plan(contentRef: ContentRef, type: MediaPublicationType, expectedRevision: string | null, edit: PublicationEdit, signal: AbortSignal): Promise<PublicationPlan> { return (await this.prepare(contentRef, type, expectedRevision, edit, signal, false)).plan; }
  async commit(plan: PublicationPlan, signal: AbortSignal, assertCurrent: () => void): Promise<PublicationDraft> {
    if (this.root().mode !== "write") return fail("WRITE_ROOT_MISSING", "内容写入已停用，请先重新启用独立写入目录");
    const prepared = await this.prepare(plan.contentRef, plan.publicationType, plan.expectedRevision, plan.edit, signal, true);
    if (prepared.plan.inputDigest !== plan.inputDigest) return fail("INTENT_CHANGED", "文案、封面或素材与预览不一致");
    active(signal); assertCurrent();
    const root = this.root(), folder = `.wemedia-publication-${randomUUID()}`;
    const created = await resolveCreateTarget(root, folder);
    if (!created.ok) return fail("WRITE_TARGET_REJECTED", "无法创建独立发布稿版本");
    await this.assertRoot();
    await mkdir(created.value.absolutePath, { mode: 0o700 });
    await mkdir(resolve(await this.exact(folder), "assets"), { mode: 0o700 });
    const write = async (path: string, bytes: string | Buffer): Promise<void> => {
      active(signal); assertCurrent();
      await this.exact(path.includes("/assets/") ? `${folder}/assets` : folder);
      const file = await open(resolve(root.realPath, path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    };
    const draft = prepared.plan.publication;
    for (const [index, asset] of draft.media.entries()) await write(`${folder}/assets/${asset.itemId.slice(18)}${EXTENSIONS[asset.mediaType]}`, prepared.buffers[index]!);
    await write(`${folder}/body.txt`, draft.body);
    await write(`${folder}/manifest.json`, JSON.stringify({ schemaVersion: PUBLICATION_DRAFT_SCHEMA, contentRef: draft.contentRef, publicationType: draft.publicationType, title: draft.title, bodyFile: "body.txt", media: draft.media, coverItemId: draft.coverItemId, channels: draft.channels, revisionDigest: draft.revisionDigest, createdAt: draft.createdAt, updatedAt: draft.updatedAt }));
    await this.assertRoot();
    await this.options.store.update(async state => {
      await this.assertRoot();
      active(signal); assertCurrent();
      const current = pointers(state), previous = pointer(current[plan.contentRef]);
      if ((previous?.revisionDigest ?? null) !== plan.expectedRevision) fail("REVISION_CHANGED", "保存期间发布稿已变化，新文件未登记为当前版本");
      current[plan.contentRef] = { folder, revisionDigest: draft.revisionDigest, history: [...(previous?.history ?? []), ...(previous ? [previous.folder] : [])].slice(-100) };
      state.extensions.publicationDrafts = current;
    });
    return this.read(plan.contentRef);
  }
  async media(input: PublicationMediaInput, signal: AbortSignal): Promise<LibraryMediaChunk> {
    active(signal);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > LIBRARY_MEDIA_CHUNK_BYTES) return fail("REQUEST_INVALID", "素材读取范围无效");
    const draft = await this.read(input.contentRef);
    if (draft.revisionDigest !== input.revisionDigest) return fail("PUBLICATION_CHANGED", "发布稿版本已变化");
    const asset = draft.media.find(item => item.itemId === input.itemId);
    if (!asset || input.offset >= asset.bytes) return fail("PUBLICATION_MEDIA_INVALID", "素材不属于当前稿件或范围无效");
    const bytes = await this.draftBytes(input.contentRef, asset); active(signal);
    const current = pointer(pointers(await this.options.store.read())[input.contentRef]);
    if (current?.revisionDigest !== draft.revisionDigest) return fail("PUBLICATION_CHANGED", "发布稿在读取时发生变化");
    const chunk = bytes.subarray(input.offset, input.offset + input.length);
    return { itemId: input.itemId, revisionDigest: draft.revisionDigest, offset: input.offset, totalBytes: bytes.length, mediaType: asset.mediaType, dataBase64: chunk.toString("base64"), eof: input.offset + chunk.length === bytes.length };
  }
}

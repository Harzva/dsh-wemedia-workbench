import type { MappingChangeInput } from "./contentMapping.ts";
import { MAPPING_OPERATIONS } from "./contentMapping.ts";
import { decodePublicationEdit, publicationText, PUBLICATION_ASSET_ID } from "./publicationDraft.ts";
import { isTaxonomyLabel } from "./articleTaxonomy.ts";
import type { ArticleCategory } from "./articleTaxonomy.ts";
import { isJsonObject, isJsonValue } from "./json.ts";
import type { Channel, ContentRef } from "./primitives.ts";
import { parseContentRef } from "./primitives.ts";
import { decodeArticleMetadata, safeRelativeFile, SHA256_PATTERN } from "./wechatDocument.ts";
import { REVIEW_KINDS, WORKBENCH_ACTIONS, WorkbenchFault } from "./workbench.ts";
import type { ArticleEdit, WorkbenchRequest } from "./workbench.ts";
import { isLibraryTimestamp, LIBRARY_ITEM_ID, LIBRARY_MEDIA_CHUNK_BYTES, LIBRARY_MEDIA_MAX_BYTES } from "./contentLibrary.ts";
import type { LibraryKind, LibrarySort, PublicationStatus, PublicationType } from "./contentLibrary.ts";
import { PUBLISHING_CHANNELS, CHANNEL_ACTIONS } from "./channelPublishing.ts";
import type { PublishingChannel, ChannelAction } from "./channelPublishing.ts";
import { ACCOUNT_CHANNELS } from "./accounts.ts";
import type { AccountChannel } from "./accounts.ts";
import { decodeDraftBatchRequest } from "./draftBatch.ts";
import { ARTICLE_TEMPLATE_IDS, articleTemplate, type ArticleTemplateId } from "./articleTemplates.ts";

const fields: Record<WorkbenchRequest["operation"], readonly string[]> = {
  preview_draft_batch: ["scope", "contentRefs"], start_draft_batch: ["intentId"],
  advance_draft_batch: ["batchId"], get_draft_batch: ["batchId"], cancel_draft_batch: ["batchId"], list_draft_batches: [],
  reference_list: [], reference_read: ["id"], reference_collect: ["kind", "url", "limit"], reference_brief: ["ids", "action", "instruction"],
  account_list: [], account_check: ["channel"], account_login_start: ["channel"], account_login_poll: ["loginId"], account_login_cancel: ["loginId"],
  channel_inspect: ["contentRef"], channel_preflight: ["contentRef", "channel", "online"], channel_preview_action: ["contentRef", "channel", "action", "targetRef", "targetUrl"], channel_start_action: ["intentId"],
  platform_catalog: [], setup_inspect: [], setup_preview: ["rootIds", "writeRootId"], setup_apply: ["intentId"],
  mapping_inspect: ["contentRef", "query", "cursor", "pageSize"], mapping_preview: ["change"], mapping_apply: ["intentId"],
  batch_preflight: ["contentRefs", "channels"],
  publication_read: ["contentRef"], create_publication: ["publicationType", "title"], preview_publication_save: ["contentRef", "expectedRevision", "edit"], publication_media: ["contentRef", "itemId", "revisionDigest", "offset", "length"],
  library_list: ["channel", "timeField", "query", "kind", "publicationType", "publicationStatus", "category", "conference", "year", "tag", "updatedFrom", "updatedTo", "sort", "cursor", "pageSize"], library_read: ["itemId"], library_media: ["itemId", "offset", "length", "revisionDigest"],
  history: ["contentRef"], compare_versions: ["contentRef", "fromId", "toId"], evidence_detail: ["contentRef", "evidenceId"],
  snapshot: [], refresh: [], search: ["query", "cursor", "pageSize"],
  inspect: ["contentRef"], preflight: ["contentRef"], preview: ["contentRef"],
  ai_inspect: ["contentRef"], ai_preview: ["contentRef"],
  preview_workflow_import: ["contentRef", "kind", "artifact"], apply_workflow_import: ["intentId"],
  task_brief: ["contentRef", "action"], preview_action: ["contentRef", "action", "targetRef", "edit"],
  start_action: ["intentId"], get_job: ["jobId"], cancel_job: ["jobId"],
  record_review: ["contentRef", "kind", "revisionDigest", "artifact", "summary"],
  article_templates: [],
  create_content: ["title", "sourceUrl", "kind", "templateId", "applyIntentId"],
};
function invalid(): never { throw new WorkbenchFault("REQUEST_INVALID", "请求格式无效或包含不受支持的字段"); }
function string(value: unknown, max = 256, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) invalid();
  return value;
}
export function decodeArticleEdit(value: unknown): ArticleEdit {
  if (!isJsonObject(value) || Object.keys(value).some(key => !["metadata", "html", "markdown"].includes(key))) invalid();
  return { metadata: decodeArticleMetadata(value.metadata), html: string(value.html, 1024 * 1024, true), markdown: string(value.markdown, 1024 * 1024, true) };
}
export function decodeWorkbenchRequest(input: unknown): WorkbenchRequest {
  if (!isJsonObject(input) || !isJsonValue(input) || JSON.stringify(input).length > 3 * 1024 * 1024 || typeof input.operation !== "string" || !Object.hasOwn(fields, input.operation)) invalid();
  const operation = input.operation as WorkbenchRequest["operation"];
  if (Object.keys(input).some(key => key !== "operation" && !fields[operation].includes(key))) invalid();
  const content = (): ContentRef => {
    const value = string(input.contentRef);
    if (!parseContentRef(value).ok) invalid();
    return value as ContentRef;
  };
  switch (operation) {
    case "article_templates": return { operation };
    case "preview_draft_batch": case "start_draft_batch": case "advance_draft_batch": case "get_draft_batch": case "cancel_draft_batch": case "list_draft_batches":
      return decodeDraftBatchRequest(input);
    case "reference_list": return { operation };
    case "reference_read": {
      if (typeof input.id !== "string" || !/^ref:[a-f0-9]{32}$/u.test(input.id)) invalid();
      return { operation, id: input.id };
    }
    case "reference_collect": {
      if (!["wechat_article", "xhs_note", "xhs_author"].includes(String(input.kind))) invalid();
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 5)) invalid();
      return { operation, kind: input.kind as import("./references.ts").CollectionKind, url: string(input.url, 8192), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) };
    }
    case "reference_brief": {
      if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 5 || input.ids.some(id => typeof id !== "string" || !/^ref:[a-f0-9]{32}$/u.test(id)) || new Set(input.ids).size !== input.ids.length || !["analyze", "write"].includes(String(input.action))) invalid();
      return { operation, ids: input.ids as string[], action: input.action as "analyze" | "write", ...(input.instruction === undefined ? {} : { instruction: string(input.instruction, 2000, true) }) };
    }
    case "account_list": return { operation };
    case "account_check": case "account_login_start": {
      if (!ACCOUNT_CHANNELS.includes(input.channel as AccountChannel)) invalid();
      return { operation, channel: input.channel as AccountChannel };
    }
    case "account_login_poll": case "account_login_cancel": {
      const loginId = string(input.loginId, 80);
      if (!/^accountlogin:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(loginId)) invalid();
      return { operation, loginId };
    }
    case "channel_inspect": return { operation, contentRef: content() };
    case "channel_start_action": return { operation, intentId: string(input.intentId) };
    case "channel_preflight": case "channel_preview_action": {
      if (!PUBLISHING_CHANNELS.includes(input.channel as PublishingChannel)) invalid();
      const channel = input.channel as PublishingChannel;
      if (operation === "channel_preflight") {
        if (input.online !== undefined && typeof input.online !== "boolean") invalid();
        return { operation, contentRef: content(), channel, ...(input.online === undefined ? {} : { online: input.online as boolean }) };
      }
      if (!CHANNEL_ACTIONS.includes(input.action as ChannelAction) || input.targetRef !== undefined && input.targetUrl !== undefined || input.targetUrl !== undefined && input.action !== "sync") invalid();
      return { operation, contentRef: content(), channel, action: input.action as ChannelAction, ...(input.targetRef === undefined ? {} : { targetRef: string(input.targetRef) }), ...(input.targetUrl === undefined ? {} : { targetUrl: string(input.targetUrl, 2048) }) };
    }
    case "setup_inspect": return { operation };
    case "setup_apply": case "mapping_apply": return { operation, intentId: string(input.intentId) };
    case "setup_preview": {
      if (!Array.isArray(input.rootIds) || input.rootIds.length > 100 || !input.rootIds.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) || new Set(input.rootIds).size !== input.rootIds.length || input.writeRootId !== null && input.writeRootId !== "write") invalid();
      return { operation, rootIds: input.rootIds as string[], writeRootId: input.writeRootId };
    }
    case "mapping_inspect": {
      if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || Number(input.pageSize) < 1 || Number(input.pageSize) > 100)) invalid();
      return { operation, contentRef: content(), ...(input.query === undefined ? {} : { query: string(input.query, 500, true) }), ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, 256) }), ...(input.pageSize === undefined ? {} : { pageSize: Number(input.pageSize) }) };
    }
    case "mapping_preview": {
      const change = input.change;
      if (!isJsonObject(change) || Object.keys(change).some(key => !["contentRef", "operation", "sourceRecordIds", "retainedSourceRecordIds", "channel"].includes(key)) || typeof change.contentRef !== "string" || !parseContentRef(change.contentRef).ok || !MAPPING_OPERATIONS.includes(change.operation as typeof MAPPING_OPERATIONS[number]) || !Array.isArray(change.sourceRecordIds) || change.sourceRecordIds.length < 1 || change.sourceRecordIds.length > 50 || !change.sourceRecordIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/u.test(id)) || new Set(change.sourceRecordIds).size !== change.sourceRecordIds.length) invalid();
      if (change.channel !== undefined && (change.operation !== "map_variant" || typeof change.channel !== "string" || !["wechat", "zhihu", "xiaohongshu", "x"].includes(change.channel)) || change.operation === "map_variant" && change.channel === undefined) invalid();
      if (change.operation === "separate" && change.retainedSourceRecordIds === undefined) invalid();
      if (change.retainedSourceRecordIds !== undefined && (change.operation !== "separate" || !Array.isArray(change.retainedSourceRecordIds) || change.retainedSourceRecordIds.length < 1 || change.retainedSourceRecordIds.length > 50 || !change.retainedSourceRecordIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) || new Set(change.retainedSourceRecordIds).size !== change.retainedSourceRecordIds.length)) invalid();
      return { operation, change: change as unknown as MappingChangeInput };
    }
    case "batch_preflight": {
      if (!Array.isArray(input.contentRefs) || input.contentRefs.length < 1 || input.contentRefs.length > 20 || !input.contentRefs.every(ref => typeof ref === "string" && parseContentRef(ref).ok) || new Set(input.contentRefs).size !== input.contentRefs.length || !Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > 4 || !input.channels.every(channel => typeof channel === "string" && ["wechat", "zhihu", "xiaohongshu", "x"].includes(channel)) || new Set(input.channels).size !== input.channels.length) invalid();
      return { operation, contentRefs: input.contentRefs as ContentRef[], channels: input.channels as Channel[] };
    }
    case "library_list": {
      if (input.channel !== undefined && (typeof input.channel !== "string" || !["wechat", "zhihu", "xiaohongshu", "x"].includes(input.channel))) invalid();
      if (input.timeField !== undefined && (typeof input.timeField !== "string" || !["updated", "created", "published"].includes(input.timeField))) invalid();
      if (input.category !== undefined && (typeof input.category !== "string" || !["conference", "arxiv", "other"].includes(input.category))) invalid();
      if (input.conference !== undefined && !isTaxonomyLabel(input.conference) || input.tag !== undefined && !isTaxonomyLabel(input.tag)) invalid();
      if (input.year !== undefined && (!Number.isInteger(input.year) || Number(input.year) < 1900 || Number(input.year) > 2099)) invalid();
      if (input.kind !== undefined && (typeof input.kind !== "string" || !["article", "image", "video"].includes(input.kind))) invalid();
      if (input.publicationType !== undefined && (typeof input.publicationType !== "string" || !["article", "video", "image_text"].includes(input.publicationType))) invalid();
      if (input.publicationStatus !== undefined && (typeof input.publicationStatus !== "string" || !["draft", "ready", "published", "unknown"].includes(input.publicationStatus))) invalid();
      if (input.sort !== undefined && (typeof input.sort !== "string" || !["updated_desc", "updated_asc"].includes(input.sort))) invalid();
      if (input.updatedFrom !== undefined && !isLibraryTimestamp(input.updatedFrom) || input.updatedTo !== undefined && !isLibraryTimestamp(input.updatedTo)) invalid();
      if (typeof input.updatedFrom === "string" && typeof input.updatedTo === "string" && Date.parse(input.updatedFrom) >= Date.parse(input.updatedTo)) invalid();
      if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || Number(input.pageSize) < 1 || Number(input.pageSize) > 100)) invalid();
      return { operation, ...(input.channel === undefined ? {} : { channel: input.channel as Channel }), ...(input.timeField === undefined ? {} : { timeField: input.timeField as "updated" | "created" | "published" }), ...(input.category === undefined ? {} : { category: input.category as ArticleCategory }), ...(input.conference === undefined ? {} : { conference: input.conference as string }), ...(input.year === undefined ? {} : { year: input.year as number }), ...(input.tag === undefined ? {} : { tag: input.tag as string }), ...(input.query === undefined ? {} : { query: string(input.query, 500, true) }), ...(input.kind === undefined ? {} : { kind: input.kind as LibraryKind }), ...(input.publicationType === undefined ? {} : { publicationType: input.publicationType as PublicationType }), ...(input.publicationStatus === undefined ? {} : { publicationStatus: input.publicationStatus as PublicationStatus }), ...(input.updatedFrom === undefined ? {} : { updatedFrom: input.updatedFrom as string }), ...(input.updatedTo === undefined ? {} : { updatedTo: input.updatedTo as string }), ...(input.sort === undefined ? {} : { sort: input.sort as LibrarySort }), ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, 200) }), ...(input.pageSize === undefined ? {} : { pageSize: Number(input.pageSize) }) };
    }
    case "publication_read": return { operation, contentRef: content() };
    case "create_publication": {
      if (input.publicationType !== "video" && input.publicationType !== "image_text") invalid();
      return { operation, publicationType: input.publicationType, title: publicationText(input.title, 200) };
    }
    case "preview_publication_save": {
      if (typeof input.expectedRevision !== "string" || !SHA256_PATTERN.test(input.expectedRevision)) invalid();
      return { operation, contentRef: content(), expectedRevision: input.expectedRevision, edit: decodePublicationEdit(input.edit) };
    }
    case "publication_media": {
      if (typeof input.itemId !== "string" || !PUBLICATION_ASSET_ID.test(input.itemId) || typeof input.revisionDigest !== "string" || !SHA256_PATTERN.test(input.revisionDigest) || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) >= LIBRARY_MEDIA_MAX_BYTES || !Number.isSafeInteger(input.length) || Number(input.length) < 1 || Number(input.length) > LIBRARY_MEDIA_CHUNK_BYTES) invalid();
      return { operation, contentRef: content(), itemId: input.itemId, revisionDigest: input.revisionDigest, offset: Number(input.offset), length: Number(input.length) };
    }
    case "library_read": case "library_media": {
      const itemId = string(input.itemId);
      if (!LIBRARY_ITEM_ID.test(itemId)) invalid();
      if (operation === "library_read") return { operation, itemId };
      if (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) >= LIBRARY_MEDIA_MAX_BYTES || !Number.isSafeInteger(input.length) || Number(input.length) < 1 || Number(input.length) > LIBRARY_MEDIA_CHUNK_BYTES || typeof input.revisionDigest !== "string" || !SHA256_PATTERN.test(input.revisionDigest)) invalid();
      return { operation, itemId, offset: Number(input.offset), length: Number(input.length), revisionDigest: input.revisionDigest };
    }
    case "platform_catalog": case "snapshot": case "refresh": return { operation };
    case "history": case "inspect": case "preflight": case "preview": case "ai_inspect": case "ai_preview": return { operation, contentRef: content() };
    case "compare_versions": return { operation, contentRef: content(), fromId: string(input.fromId), toId: string(input.toId) };
    case "evidence_detail": return { operation, contentRef: content(), evidenceId: string(input.evidenceId) };
    case "apply_workflow_import": return { operation, intentId: string(input.intentId) };
    case "preview_workflow_import": {
      if (!["review", "draft"].includes(String(input.kind)) || !isJsonObject(input.artifact) || !safeRelativeFile(input.artifact.relativePath) || !input.artifact.relativePath.endsWith(".json") || Object.keys(input.artifact).some(key => !["rootId", "relativePath"].includes(key))) invalid();
      return { operation, contentRef: content(), kind: input.kind as "review" | "draft", artifact: { rootId: string(input.artifact.rootId, 64), relativePath: input.artifact.relativePath } };
    }
    case "search": {
      const query = string(input.query, 500, true);
      if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || Number(input.pageSize) < 1 || Number(input.pageSize) > 100)) invalid();
      return { operation, query, ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, 200) }), ...(input.pageSize === undefined ? {} : { pageSize: Number(input.pageSize) }) };
    }
    case "task_brief": {
      if (!["research", "write_draft", "review"].includes(String(input.action))) invalid();
      return { operation, contentRef: content(), action: input.action as "research" | "write_draft" | "review" };
    }
    case "preview_action": {
      if (!WORKBENCH_ACTIONS.includes(input.action as typeof WORKBENCH_ACTIONS[number])) invalid();
      const action = input.action as typeof WORKBENCH_ACTIONS[number];
      if ((action === "save_revision") !== (input.edit !== undefined) || (action === "create_draft" && input.targetRef !== undefined)) invalid();
      return { operation, contentRef: content(), action, ...(input.targetRef === undefined ? {} : { targetRef: string(input.targetRef) }), ...(input.edit === undefined ? {} : { edit: decodeArticleEdit(input.edit) }) };
    }
    case "start_action": return { operation, intentId: string(input.intentId) };
    case "get_job": case "cancel_job": return { operation, jobId: string(input.jobId) };
    case "record_review": {
      if (!REVIEW_KINDS.includes(input.kind as typeof REVIEW_KINDS[number]) || typeof input.revisionDigest !== "string" || !SHA256_PATTERN.test(input.revisionDigest) || !isJsonObject(input.artifact) || !safeRelativeFile(input.artifact.relativePath) || Object.keys(input.artifact).some(key => !["rootId", "relativePath"].includes(key))) invalid();
      return { operation, contentRef: content(), kind: input.kind as typeof REVIEW_KINDS[number], revisionDigest: input.revisionDigest, artifact: { rootId: string(input.artifact.rootId, 64), relativePath: input.artifact.relativePath }, summary: string(input.summary, 2000) };
    }
    case "create_content": {
      if (input.kind !== "paper" && input.kind !== "article") invalid();
      if (input.templateId !== undefined && !ARTICLE_TEMPLATE_IDS.includes(input.templateId as ArticleTemplateId)) invalid();
      const templateId = (input.templateId ?? "blank") as ArticleTemplateId;
      const template = articleTemplate(templateId);
      if (template.kind !== "any" && template.kind !== input.kind) invalid();
      return { operation, title: string(input.title, 200), sourceUrl: string(input.sourceUrl, 2048, true), kind: input.kind, ...(input.templateId === undefined ? {} : { templateId }), ...(input.applyIntentId === undefined ? {} : { applyIntentId: string(input.applyIntentId) }) };
    }
  }
}

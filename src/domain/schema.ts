import type { SourceRecord } from "./content.ts";
import { SIDE_EFFECT_LEVELS } from "./capability.ts";
import { failure, success } from "./errors.ts";
import type { DomainResult } from "./errors.ts";
import type { ManualIdentityDecision } from "./identity.ts";
import { isJsonObject, isJsonValue } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { JOB_STATUSES } from "./job.ts";
import type { Job, JobProgress } from "./job.ts";
import type { LedgerEvent } from "./ledger.ts";
import { LEDGER_EVENT_SCHEMA_VERSION } from "./ledger.ts";
import { isChannel, isUuidV4, parseContentRef } from "./primitives.ts";
import type { Channel, ContentRef } from "./primitives.ts";

export const CONTENT_SCHEMA_VERSION = "wemedia.content/v1" as const;
export const OVERLAY_SCHEMA_VERSION = "wemedia.overlay/v1" as const;
export const INDEX_CACHE_SCHEMA_VERSION = "wemedia.index-cache/v1" as const;

export interface ContentManifestV1 extends JsonObject {
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  contentId: string;
  title: string;
  sourceIds: string[];
  variants: Partial<Record<Channel, string>>;
  extensions: JsonObject;
  topicKey?: string;
  canonicalDraft?: string;
}

export interface OverlayV1 extends JsonObject {
  schemaVersion: typeof OVERLAY_SCHEMA_VERSION;
  revision: number;
  contentBindings: Record<string, ContentRef>;
  manualDecisions: ManualIdentityDecision[];
  variantState: Record<string, JsonValue>;
  jobs: Record<string, Job>;
  extensions: JsonObject;
}

export interface IndexCacheV1 extends JsonObject {
  schemaVersion: typeof INDEX_CACHE_SCHEMA_VERSION;
  generationId: string;
  builtAt: string;
  sources: SourceRecord[];
}

function version(value: JsonObject, expected: string): DomainResult<void> {
  if (typeof value.schemaVersion !== "string") {
    return failure("SCHEMA_MISSING_FIELD", "schemaVersion is required", { path: "schemaVersion" });
  }
  if (value.schemaVersion !== expected) {
    return failure("SCHEMA_VERSION_UNSUPPORTED", "schema version is not supported", {
      path: "schemaVersion",
      details: { expected, received: value.schemaVersion },
    });
  }
  return success(undefined);
}

function object(value: unknown, label: string): DomainResult<JsonObject> {
  return isJsonObject(value) && isJsonValue(value)
    ? success(value)
    : failure("SCHEMA_INVALID_TYPE", `${label} must be a JSON object`, { path: label });
}

function optionalJsonObject(value: JsonObject, key: string): DomainResult<JsonObject | undefined> {
  const item = value[key];
  return item === undefined || (isJsonObject(item) && isJsonValue(item))
    ? success(item)
    : failure("SCHEMA_INVALID_TYPE", `${key} must be a JSON object`, { path: key });
}

function requiredNumber(value: JsonObject, key: string): DomainResult<number> {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item)
    ? success(item)
    : failure(item === undefined ? "SCHEMA_MISSING_FIELD" : "SCHEMA_INVALID_TYPE", `${key} must be a finite number`, { path: key });
}

function optionalNumber(value: JsonObject, key: string): DomainResult<number | undefined> {
  const item = value[key];
  return item === undefined || (typeof item === "number" && Number.isFinite(item))
    ? success(item)
    : failure("SCHEMA_INVALID_TYPE", `${key} must be a finite number`, { path: key });
}

function optionalBoolean(value: JsonObject, key: string): DomainResult<boolean | undefined> {
  const item = value[key];
  return item === undefined || typeof item === "boolean"
    ? success(item)
    : failure("SCHEMA_INVALID_TYPE", `${key} must be a boolean`, { path: key });
}

function requiredString(value: JsonObject, key: string): DomainResult<string> {
  const item = value[key];
  return typeof item === "string" && item.trim() !== ""
    ? success(item)
    : failure(item === undefined ? "SCHEMA_MISSING_FIELD" : "SCHEMA_INVALID_VALUE", `${key} must be a non-empty string`, { path: key });
}

function optionalString(value: JsonObject, key: string): DomainResult<string | undefined> {
  const item = value[key];
  return item === undefined || typeof item === "string"
    ? success(item)
    : failure("SCHEMA_INVALID_TYPE", `${key} must be a string`, { path: key });
}

function stringArray(value: JsonObject, key: string, optional = false): DomainResult<string[]> {
  const item = value[key];
  if (item === undefined && optional) return success([]);
  return Array.isArray(item) && item.every((entry) => typeof entry === "string")
    ? success([...item])
    : failure(item === undefined ? "SCHEMA_MISSING_FIELD" : "SCHEMA_INVALID_TYPE", `${key} must be an array of strings`, { path: key });
}

function unknownExtensions(value: JsonObject, known: readonly string[]): DomainResult<JsonObject> {
  const existing = value.extensions;
  if (existing !== undefined && !isJsonObject(existing)) {
    return failure("SCHEMA_INVALID_TYPE", "extensions must be a JSON object", { path: "extensions" });
  }
  const extensions: JsonObject = existing === undefined ? {} : { ...existing };
  for (const [key, item] of Object.entries(value)) {
    if (!known.includes(key)) extensions[key] = item;
  }
  return success(extensions);
}

function decodeManualDecision(value: JsonObject): DomainResult<ManualIdentityDecision> {
  const decisionId = requiredString(value, "decisionId");
  if (!decisionId.ok) return decisionId;
  const kind = value.kind;
  if (kind !== "bind" && kind !== "separate") return failure("SCHEMA_INVALID_VALUE", "manual decision kind is invalid", { path: "kind" });
  const sourceRecordIds = stringArray(value, "sourceRecordIds");
  if (!sourceRecordIds.ok) return sourceRecordIds;
  const inputDigest = requiredString(value, "inputDigest");
  if (!inputDigest.ok) return inputDigest;
  const decidedAt = requiredString(value, "decidedAt");
  if (!decidedAt.ok) return decidedAt;
  const revision = requiredNumber(value, "revision");
  if (!revision.ok || !Number.isSafeInteger(revision.value) || revision.value < 0) {
    return failure("SCHEMA_INVALID_VALUE", "manual decision revision must be a non-negative safe integer", { path: "revision" });
  }
  const status = value.status;
  if (status !== "active" && status !== "needs_revalidation") return failure("SCHEMA_INVALID_VALUE", "manual decision status is invalid", { path: "status" });
  const ref = optionalString(value, "contentRef");
  if (!ref.ok) return ref;
  if (ref.value !== undefined && !parseContentRef(ref.value).ok) return failure("CONTENT_REF_INVALID", "manual binding contentRef is invalid", { path: "contentRef" });
  return success({
    decisionId: decisionId.value,
    kind,
    sourceRecordIds: sourceRecordIds.value,
    inputDigest: inputDigest.value,
    decidedAt: decidedAt.value,
    revision: revision.value,
    status,
    ...(ref.value === undefined ? {} : { contentRef: ref.value as ContentRef }),
  });
}

function decodeJob(value: JsonObject): DomainResult<Job> {
  const strings = ["jobId", "generationId", "action", "safeMessage", "createdAt"] as const;
  const decodedStrings: Record<(typeof strings)[number], string> = {
    jobId: "", generationId: "", action: "", safeMessage: "", createdAt: "",
  };
  for (const key of strings) {
    const decoded = requiredString(value, key);
    if (!decoded.ok) return decoded;
    decodedStrings[key] = decoded.value;
  }
  if (typeof value.retryable !== "boolean") return failure("SCHEMA_INVALID_TYPE", "retryable must be a boolean", { path: "retryable" });
  const status = value.status;
  if (typeof status !== "string" || !(JOB_STATUSES as readonly string[]).includes(status)) return failure("SCHEMA_INVALID_VALUE", "job status is invalid", { path: "status" });
  const sideEffect = value.sideEffect;
  if (typeof sideEffect !== "string" || !(SIDE_EFFECT_LEVELS as readonly string[]).includes(sideEffect)) return failure("SCHEMA_INVALID_VALUE", "job sideEffect is invalid", { path: "sideEffect" });
  const artifactRefs = stringArray(value, "artifactRefs");
  if (!artifactRefs.ok) return artifactRefs;
  const progressValue = value.progress;
  if (!isJsonObject(progressValue)) return failure("SCHEMA_INVALID_TYPE", "job progress must be a JSON object", { path: "progress" });
  const current = requiredNumber(progressValue, "current");
  if (!current.ok) return current;
  const total = optionalNumber(progressValue, "total");
  if (!total.ok) return total;
  const unit = optionalString(progressValue, "unit");
  if (!unit.ok) return unit;
  const progress: JobProgress = {
    current: current.value,
    ...(total.value === undefined ? {} : { total: total.value }),
    ...(unit.value === undefined ? {} : { unit: unit.value }),
  };
  const channelValue = value.channel;
  if (channelValue !== undefined && (typeof channelValue !== "string" || !isChannel(channelValue))) return failure("SCHEMA_INVALID_VALUE", "job channel is invalid", { path: "channel" });
  const optionalKeys = ["startedAt", "finishedAt", "deadline", "resultEventId"] as const;
  const optionalValues: Partial<Record<(typeof optionalKeys)[number], string>> = {};
  for (const key of optionalKeys) {
    const decoded = optionalString(value, key);
    if (!decoded.ok) return decoded;
    if (decoded.value !== undefined) optionalValues[key] = decoded.value;
  }
  return success({
    ...decodedStrings,
    status: status as Job["status"],
    sideEffect: sideEffect as Job["sideEffect"],
    progress,
    retryable: value.retryable,
    artifactRefs: artifactRefs.value,
    ...(channelValue === undefined ? {} : { channel: channelValue as Channel }),
    ...optionalValues,
  });
}

function decodeSourceRecord(value: JsonObject): DomainResult<SourceRecord> {
  const requiredKeys = ["recordId", "rootId", "relativePath", "digest", "title"] as const;
  const decoded: Record<(typeof requiredKeys)[number], string> = {
    recordId: "", rootId: "", relativePath: "", digest: "", title: "",
  };
  for (const key of requiredKeys) {
    const item = requiredString(value, key);
    if (!item.ok) return item;
    decoded[key] = item.value;
  }
  const sourceIds = stringArray(value, "sourceIds");
  if (!sourceIds.ok) return sourceIds;
  const optionalKeys = ["explicitContentId", "topicKey", "canonicalArtifactKey", "derivedFromPath", "articleId", "contentPath", "previewPath", "mediaType"] as const;
  const optionalValues: Partial<Record<(typeof optionalKeys)[number], string>> = {};
  for (const key of optionalKeys) {
    const item = optionalString(value, key);
    if (!item.ok) return item;
    if (item.value !== undefined) optionalValues[key] = item.value;
  }
  const channelValue = value.channel;
  if (channelValue !== undefined && (typeof channelValue !== "string" || !isChannel(channelValue))) return failure("SCHEMA_INVALID_VALUE", "source channel is invalid", { path: "channel" });
  const remote = optionalJsonObject(value, "remote");
  if (!remote.ok) return remote;
  const kinds = ["manifest", "markdown", "asset", "ledger", "wechat_manifest"];
  if (value.recordKind !== undefined && (typeof value.recordKind !== "string" || !kinds.includes(value.recordKind))) {
    return failure("SCHEMA_INVALID_VALUE", "source record kind is invalid");
  }
  return success({
    ...decoded,
    sourceIds: sourceIds.value,
    ...optionalValues,
    ...(channelValue === undefined ? {} : { channel: channelValue as Channel }),
    ...(remote.value === undefined ? {} : { remote: remote.value }),
    ...(value.recordKind === undefined ? {} : { recordKind: value.recordKind as NonNullable<SourceRecord["recordKind"]> }),
  });
}

export function decodeContentManifest(input: unknown): DomainResult<ContentManifestV1> {
  const decodedObject = object(input, "content");
  if (!decodedObject.ok) return decodedObject;
  const value = decodedObject.value;
  const versionResult = version(value, CONTENT_SCHEMA_VERSION);
  if (!versionResult.ok) return versionResult;
  const contentId = requiredString(value, "contentId");
  if (!contentId.ok) return contentId;
  if (!isUuidV4(contentId.value)) return failure("UUID_V4_INVALID", "contentId must be a UUIDv4", { path: "contentId" });
  const title = requiredString(value, "title");
  if (!title.ok) return title;
  const sourceIds = stringArray(value, "sourceIds", true);
  if (!sourceIds.ok) return sourceIds;
  const topicKey = optionalString(value, "topicKey");
  if (!topicKey.ok) return topicKey;
  const canonicalDraft = optionalString(value, "canonicalDraft");
  if (!canonicalDraft.ok) return canonicalDraft;
  const variantsValue = value.variants ?? {};
  if (!isJsonObject(variantsValue)) return failure("SCHEMA_INVALID_TYPE", "variants must be a JSON object", { path: "variants" });
  const variants: Partial<Record<Channel, string>> = {};
  for (const [channel, artifact] of Object.entries(variantsValue)) {
    if (!isChannel(channel) || typeof artifact !== "string") {
      return failure("SCHEMA_INVALID_VALUE", "variant entries must use a supported channel and string artifact path", { path: `variants.${channel}` });
    }
    variants[channel] = artifact;
  }
  const extensions = unknownExtensions(value, ["schemaVersion", "contentId", "title", "topicKey", "sourceIds", "canonicalDraft", "variants", "extensions"]);
  if (!extensions.ok) return extensions;
  return success({
    schemaVersion: CONTENT_SCHEMA_VERSION,
    contentId: contentId.value.toLowerCase(),
    title: title.value,
    sourceIds: sourceIds.value,
    variants,
    extensions: extensions.value,
    ...(topicKey.value === undefined ? {} : { topicKey: topicKey.value }),
    ...(canonicalDraft.value === undefined ? {} : { canonicalDraft: canonicalDraft.value }),
  });
}

export function decodeOverlay(input: unknown): DomainResult<OverlayV1> {
  const decodedObject = object(input, "overlay");
  if (!decodedObject.ok) return decodedObject;
  const value = decodedObject.value;
  const versionResult = version(value, OVERLAY_SCHEMA_VERSION);
  if (!versionResult.ok) return versionResult;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return failure("SCHEMA_INVALID_VALUE", "revision must be a non-negative safe integer", { path: "revision" });
  }
  const bindings = value.contentBindings ?? {};
  const decisions = value.manualDecisions ?? [];
  const variantState = value.variantState ?? {};
  const jobs = value.jobs ?? {};
  if (!isJsonObject(bindings) || !Object.values(bindings).every((item) => typeof item === "string" && parseContentRef(item).ok)) {
    return failure("SCHEMA_INVALID_VALUE", "contentBindings must map record IDs to content references", { path: "contentBindings" });
  }
  if (!Array.isArray(decisions) || !decisions.every(isJsonObject)) {
    return failure("SCHEMA_INVALID_TYPE", "manualDecisions must be an array of JSON objects", { path: "manualDecisions" });
  }
  if (!isJsonObject(variantState) || !isJsonValue(variantState) || !isJsonObject(jobs) || !isJsonValue(jobs)) {
    return failure("SCHEMA_INVALID_TYPE", "variantState and jobs must be JSON objects");
  }
  const extensions = unknownExtensions(value, ["schemaVersion", "revision", "contentBindings", "manualDecisions", "variantState", "jobs", "extensions"]);
  if (!extensions.ok) return extensions;
  const decodedDecisions: ManualIdentityDecision[] = [];
  for (const decision of decisions) {
    const decoded = decodeManualDecision(decision);
    if (!decoded.ok) return decoded;
    decodedDecisions.push(decoded.value);
  }
  const decodedJobs: Record<string, Job> = {};
  for (const [key, job] of Object.entries(jobs)) {
    if (!isJsonObject(job)) return failure("SCHEMA_INVALID_TYPE", "job entries must be JSON objects", { path: `jobs.${key}` });
    const decoded = decodeJob(job);
    if (!decoded.ok) return decoded;
    decodedJobs[key] = decoded.value;
  }
  return success({
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    revision: value.revision as number,
    contentBindings: bindings as Record<string, ContentRef>,
    manualDecisions: decodedDecisions,
    variantState,
    jobs: decodedJobs,
    extensions: extensions.value,
  });
}

export function decodeLedgerEvent(input: unknown): DomainResult<LedgerEvent> {
  const decodedObject = object(input, "ledgerEvent");
  if (!decodedObject.ok) return decodedObject;
  const value = decodedObject.value;
  const versionResult = version(value, LEDGER_EVENT_SCHEMA_VERSION);
  if (!versionResult.ok) return versionResult;
  const stringKeys = ["eventId", "eventKey", "occurredAt", "contentRef", "action"] as const;
  const strings: Record<(typeof stringKeys)[number], string> = { eventId: "", eventKey: "", occurredAt: "", contentRef: "", action: "" };
  for (const key of stringKeys) {
    const checked = requiredString(value, key);
    if (!checked.ok) return checked;
    strings[key] = checked.value;
  }
  if (!parseContentRef(strings.contentRef).ok) return failure("CONTENT_REF_INVALID", "ledger contentRef is invalid", { path: "contentRef" });
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !["succeeded", "failed", "cancelled", "timed_out", "corrected"].includes(outcome)) return failure("SCHEMA_INVALID_VALUE", "ledger outcome is invalid", { path: "outcome" });
  const sideEffect = value.sideEffect;
  if (typeof sideEffect !== "string" || !(SIDE_EFFECT_LEVELS as readonly string[]).includes(sideEffect)) return failure("SCHEMA_INVALID_VALUE", "ledger sideEffect is invalid", { path: "sideEffect" });
  if (!isJsonObject(value.evidence)) return failure("SCHEMA_INVALID_TYPE", "evidence must be a JSON object", { path: "evidence" });
  const adapter = requiredString(value.evidence, "adapter");
  if (!adapter.ok) return adapter;
  const code = requiredString(value.evidence, "code");
  if (!code.ok) return code;
  const adapterVersion = optionalString(value.evidence, "adapterVersion");
  if (!adapterVersion.ok) return adapterVersion;
  const channelValue = value.channel;
  if (channelValue !== undefined && (typeof channelValue !== "string" || !isChannel(channelValue))) return failure("SCHEMA_INVALID_VALUE", "ledger channel is invalid", { path: "channel" });
  const jobId = optionalString(value, "jobId");
  if (!jobId.ok) return jobId;
  const supersedesEventId = optionalString(value, "supersedesEventId");
  if (!supersedesEventId.ok) return supersedesEventId;
  const artifactDigests = stringArray(value, "artifactDigests", true);
  if (!artifactDigests.ok) return artifactDigests;
  const remote = optionalJsonObject(value, "remote");
  if (!remote.ok) return remote;
  return success({
    schemaVersion: LEDGER_EVENT_SCHEMA_VERSION,
    eventId: strings.eventId,
    eventKey: strings.eventKey,
    occurredAt: strings.occurredAt,
    contentRef: strings.contentRef as ContentRef,
    action: strings.action,
    outcome: outcome as LedgerEvent["outcome"],
    sideEffect: sideEffect as LedgerEvent["sideEffect"],
    evidence: {
      adapter: adapter.value,
      code: code.value,
      ...(adapterVersion.value === undefined ? {} : { adapterVersion: adapterVersion.value }),
    },
    ...(channelValue === undefined ? {} : { channel: channelValue as Channel }),
    ...(jobId.value === undefined ? {} : { jobId: jobId.value }),
    ...(value.artifactDigests === undefined ? {} : { artifactDigests: artifactDigests.value }),
    ...(remote.value === undefined ? {} : { remote: remote.value }),
    ...(supersedesEventId.value === undefined ? {} : { supersedesEventId: supersedesEventId.value }),
  });
}

export function decodeIndexCache(input: unknown): DomainResult<IndexCacheV1> {
  const decodedObject = object(input, "indexCache");
  if (!decodedObject.ok) return decodedObject;
  const value = decodedObject.value;
  const versionResult = version(value, INDEX_CACHE_SCHEMA_VERSION);
  if (!versionResult.ok) return versionResult;
  const generationId = requiredString(value, "generationId");
  if (!generationId.ok) return generationId;
  const builtAt = requiredString(value, "builtAt");
  if (!builtAt.ok) return builtAt;
  if (!Array.isArray(value.sources) || !value.sources.every(isJsonObject)) {
    return failure("SCHEMA_INVALID_TYPE", "sources must be an array of JSON objects", { path: "sources" });
  }
  const sources: SourceRecord[] = [];
  for (const source of value.sources) {
    const decoded = decodeSourceRecord(source);
    if (!decoded.ok) return decoded;
    sources.push(decoded.value);
  }
  return success({
    schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
    generationId: generationId.value,
    builtAt: builtAt.value,
    sources,
  });
}

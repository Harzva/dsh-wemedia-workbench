import { CONTENT_MAPPING_SCHEMA, MAPPING_OPERATIONS } from "../domain/contentMapping.ts";
import type { ContentMappingView, MappingApplyResult, MappingChangeInput, MappingInspectInput, MappingPreview, MappingSourceView, StoredContentMapping } from "../domain/contentMapping.ts";
import { identitySetDigest, revalidateManualDecision } from "../domain/identity.ts";
import type { ManualIdentityDecision } from "../domain/identity.ts";
import { CHANNELS, formatContentRef, parseContentRef } from "../domain/primitives.ts";
import type { ContentRef } from "../domain/primitives.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import { mappingSnapshotSignature } from "../ports/contentMapping.ts";
import type { ContentMappings, MappingCaller, MappingMutation, MappingSnapshot, MappingSource } from "../ports/contentMapping.ts";

function fail(code: string, message: string): never { throw new WorkbenchFault(code, message); }
const safeText = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/(?:file:\/\/[^\s<>"']+|\/(?:Users|Volumes|private|home|etc)\/[^\s<>"']+)/giu, "[本地路径]").slice(0, 200);
const sourceView = (source: MappingSource, bindings: Record<string, ContentRef>): MappingSourceView => ({ sourceRecordId: source.record.recordId, title: safeText(source.record.title), rootId: source.record.rootId, rootLabel: safeText(source.rootLabel), contentRef: bindings[source.record.recordId] ?? null, digest: source.digest });
const callerKey = (caller: MappingCaller): string => {
  if (!["user", "agent"].includes(caller.kind) || caller.kind === "agent" && !caller.sessionId) return fail("MAPPING_CALLER_UNAVAILABLE", "当前调用方身份不可用，请在当前会话重新预览");
  return JSON.stringify([caller.kind, caller.sessionId ?? null]);
};
interface SavedMappingIntent { preview: MappingPreview; caller: string; snapshot: MappingSnapshot; mutation: MappingMutation; detached: ContentRef[]; consumed: boolean }

/** Local mapping writes share one overlay transaction; article files are never rewritten. */
export class ContentMappingService {
  private readonly intents = new Map<string, SavedMappingIntent>();
  private stopped = false;
  constructor(private readonly options: { mappings: ContentMappings; generationId: string; clock: Clock; ids: IdGenerator; hasher: { digest(value: string): string } }) {}
  dispose(): void { this.stopped = true; this.intents.clear(); }
  private active(signal?: AbortSignal): void {
    if (this.stopped) fail("GENERATION_DISPOSED", "当前配置已停止，请连接新工作台后重试");
    if (signal?.aborted) fail("REQUEST_CANCELLED", "来源关系操作已取消");
  }
  private known(snapshot: MappingSnapshot, contentRef: ContentRef): void {
    if (!parseContentRef(contentRef).ok || !snapshot.knownContentRefs.includes(contentRef)) fail("MAPPING_CONTENT_UNKNOWN", "该文章身份尚未登记，请先刷新内容");
  }
  async inspect(input: MappingInspectInput, signal?: AbortSignal): Promise<ContentMappingView> {
    this.active(signal);
    const size = input.pageSize ?? 40;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100 || input.query !== undefined && (typeof input.query !== "string" || input.query.length > 500)) fail("REQUEST_INVALID", "映射查询参数无效");
    const snapshot = await this.options.mappings.read(); this.active(signal); this.known(snapshot, input.contentRef);
    const mapping = snapshot.mappings.entries[input.contentRef];
    const byId = new Map(snapshot.sources.map(source => [source.record.recordId, source]));
    const canonical = mapping?.canonical ?? null;
    const currentCanonical = canonical ? byId.get(canonical.sourceRecordId) : undefined;
    const query = (input.query ?? "").trim().toLocaleLowerCase();
    const sources = snapshot.sources.filter(source => `${source.record.title} ${source.rootLabel}`.toLocaleLowerCase().includes(query)).sort((a, b) => (snapshot.bindings[a.record.recordId] === input.contentRef ? 0 : 1) - (snapshot.bindings[b.record.recordId] === input.contentRef ? 0 : 1) || a.record.title.localeCompare(b.record.title) || a.record.recordId.localeCompare(b.record.recordId));
    const digest = this.options.hasher.digest(JSON.stringify([this.options.generationId, mappingSnapshotSignature(snapshot), input.contentRef, query, size]));
    let offset = 0;
    if (input.cursor) {
      const parsed = /^(\d+)\|(.+)$/u.exec(input.cursor);
      if (!parsed || parsed[2] !== digest || !Number.isSafeInteger(Number(parsed[1]))) fail("CURSOR_STALE", "映射来源已变化，请从第一页刷新");
      offset = Number(parsed[1]);
      if (offset > sources.length) fail("CURSOR_STALE", "映射分页已失效，请刷新");
    }
    const relevant = new Set(Object.keys(snapshot.bindings).filter(id => snapshot.bindings[id] === input.contentRef));
    return { schemaVersion: CONTENT_MAPPING_SCHEMA, generationId: this.options.generationId, revision: snapshot.revision, contentRef: input.contentRef,
      canonical: canonical ? { ...canonical, available: !!currentCanonical, stale: !currentCanonical || currentCanonical.digest !== canonical.sourceDigest, currentDigest: currentCanonical?.digest ?? null } : null,
      variants: CHANNELS.flatMap(channel => {
        const variant = mapping?.variants[channel]; if (!variant) return [];
        const source = byId.get(variant.sourceRecordId);
        return [{ ...variant, channel, available: !!source, dirty: !source || source.bytesDigest !== variant.generatedDigest, stale: !currentCanonical || canonical?.sourceRecordId !== variant.derivedFromRecordId || currentCanonical.digest !== variant.sourceDigest, currentDigest: source?.bytesDigest ?? null }];
      }), sources: sources.slice(offset, offset + size).map(source => sourceView(source, snapshot.bindings)), total: sources.length,
      nextCursor: offset + size < sources.length ? `${offset + size}|${digest}` : null,
      conflicts: snapshot.conflicts.filter(conflict => relevant.has(conflict.leftRecordId) || relevant.has(conflict.rightRecordId)),
      revalidationRequired: snapshot.manualDecisions.some(decision => decision.status === "needs_revalidation" && decision.sourceRecordIds.some(id => relevant.has(id))) };
  }
  private validate(input: MappingChangeInput, snapshot: MappingSnapshot): MappingSource[] {
    this.known(snapshot, input.contentRef);
    if (!MAPPING_OPERATIONS.includes(input.operation) || !Array.isArray(input.sourceRecordIds) || input.sourceRecordIds.length < 1 || input.sourceRecordIds.length > 50 || new Set(input.sourceRecordIds).size !== input.sourceRecordIds.length || input.sourceRecordIds.some(id => typeof id !== "string" || !id || id.length > 200)) fail("REQUEST_INVALID", "请选择明确且不重复的文章来源");
    if ((input.operation === "map_variant") !== (input.channel !== undefined) || input.channel !== undefined && !CHANNELS.includes(input.channel) || input.operation !== "separate" && input.retainedSourceRecordIds !== undefined) fail("REQUEST_INVALID", "映射动作包含不适用的参数");
    const selected = input.sourceRecordIds.map(id => snapshot.sources.find(source => source.record.recordId === id));
    if (selected.some(source => !source)) fail("MAPPING_SOURCE_CHANGED", "所选来源已不可读取，请重新选择");
    if (["select_canonical", "map_variant"].includes(input.operation) && selected.length !== 1 || input.operation === "bind" && selected.length < 2) fail("REQUEST_INVALID", "该映射动作的来源数量无效");
    if (input.operation === "select_canonical" && snapshot.bindings[input.sourceRecordIds[0]!] !== input.contentRef) fail("MAPPING_BINDING_REQUIRED", "请先将来源绑定到当前文章，再选择主稿");
    if (input.operation === "map_variant" && !snapshot.mappings.entries[input.contentRef]?.canonical) fail("MAPPING_CANONICAL_REQUIRED", "请先明确当前文章的主稿");
    if (input.operation === "bind" && !selected.some(source => snapshot.bindings[source!.record.recordId] === input.contentRef)) fail("MAPPING_BINDING_REQUIRED", "绑定必须包含当前文章已登记的来源");
    if (input.operation === "separate") {
      const retained = input.retainedSourceRecordIds;
      const bound = Object.keys(snapshot.bindings).filter(id => snapshot.bindings[id] === input.contentRef && snapshot.sources.some(source => source.record.recordId === id));
      if (!Array.isArray(retained) || !retained.length || new Set(retained).size !== retained.length || retained.length >= selected.length || retained.some(id => !input.sourceRecordIds.includes(id)) || bound.length !== selected.length || bound.some(id => !input.sourceRecordIds.includes(id))) fail("MAPPING_SEPARATION_INVALID", "分离需明确当前全部来源及保留原文章身份的一组来源");
      const canonical = snapshot.mappings.entries[input.contentRef]?.canonical;
      if (canonical && !retained.includes(canonical.sourceRecordId)) fail("MAPPING_CANONICAL_RETENTION_REQUIRED", "请将当前主稿保留在原文章身份中，再分离其他来源");
    }
    return selected as MappingSource[];
  }
  async preview(input: MappingChangeInput, caller: MappingCaller, signal?: AbortSignal): Promise<MappingPreview> {
    this.active(signal); const owner = callerKey(caller);
    const snapshot = await this.options.mappings.read(); this.active(signal);
    const selected = this.validate(input, snapshot);
    const now = this.options.clock.nowIso();
    const mutation: MappingMutation = { mappings: structuredClone(snapshot.mappings), bindings: { ...snapshot.bindings }, manualDecisions: snapshot.manualDecisions.map(decision => revalidateManualDecision(decision, snapshot.sources.map(source => source.record))) };
    const mapping: StoredContentMapping = mutation.mappings.entries[input.contentRef] ?? { contentRef: input.contentRef, canonical: null, variants: {} };
    mutation.mappings.entries[input.contentRef] = mapping;
    const detached: ContentRef[] = [];
    const decisions: ManualIdentityDecision[] = [];
    const decision = (kind: "bind" | "separate", sources: MappingSource[], contentRef?: ContentRef): void => {
      decisions.push({ decisionId: this.options.ids.opaqueId("identity-decision"), kind, sourceRecordIds: sources.map(source => source.record.recordId).sort(), inputDigest: identitySetDigest(sources.map(source => source.record)), decidedAt: now, revision: snapshot.revision + 1, status: "active", ...(contentRef ? { contentRef } : {}) });
    };
    if (input.operation === "select_canonical") mapping.canonical = { sourceRecordId: selected[0]!.record.recordId, sourceDigest: selected[0]!.digest, selectedAt: now };
    if (input.operation === "map_variant") {
      const canonical = snapshot.sources.find(source => source.record.recordId === mapping.canonical!.sourceRecordId);
      if (!canonical || canonical.digest !== mapping.canonical!.sourceDigest) fail("MAPPING_CANONICAL_STALE", "主稿已经变化，请重新确认主稿后映射变体");
      const current = mapping.variants[input.channel!];
      const currentSource = current && snapshot.sources.find(source => source.record.recordId === current.sourceRecordId);
      if (current && (!currentSource || currentSource.bytesDigest !== current.generatedDigest)) fail("MAPPING_VARIANT_DIRTY", "现有变体有人工修改或已不可读取，未覆盖其映射和来源记录");
      mapping.variants[input.channel!] = { sourceRecordId: selected[0]!.record.recordId, derivedFromRecordId: canonical.record.recordId, sourceDigest: canonical.digest, generatedDigest: selected[0]!.bytesDigest, mappedAt: now, provenance: "explicit_mapping" };
    }
    if (input.operation === "bind") {
      for (const source of selected) mutation.bindings[source.record.recordId] = input.contentRef;
      decision("bind", selected, input.contentRef);
    }
    if (input.operation === "separate") {
      const retained = new Set(input.retainedSourceRecordIds!);
      const allocated = new Set(snapshot.knownContentRefs);
      for (const source of selected.filter(source => !retained.has(source.record.recordId))) {
        let created: ContentRef | undefined;
        for (let attempt = 0; attempt < 10 && !created; attempt += 1) {
          const ref = formatContentRef(this.options.ids.uuidV4());
          if (!ref.ok) fail("MAPPING_ID_INVALID", "内容身份生成失败");
          if (!allocated.has(ref.value)) created = ref.value;
        }
        if (!created) fail("MAPPING_ID_CONFLICT", "无法分配独立文章身份，请重试");
        allocated.add(created); detached.push(created); mutation.bindings[source.record.recordId] = created;
      }
      for (let left = 0; left < selected.length; left += 1) for (let right = left + 1; right < selected.length; right += 1) {
        if (!retained.has(selected[left]!.record.recordId) || !retained.has(selected[right]!.record.recordId)) decision("separate", [selected[left]!, selected[right]!]);
      }
    }
    mutation.manualDecisions = [...decisions, ...mutation.manualDecisions];
    const inputDigest = this.options.hasher.digest(JSON.stringify([this.options.generationId, owner, input, mappingSnapshotSignature(snapshot), mutation]));
    for (const [id, saved] of this.intents) if (saved.consumed || Date.parse(saved.preview.expiresAt) <= Date.parse(now)) this.intents.delete(id);
    if (this.intents.size >= 200) fail("MAPPING_INTENT_LIMIT", "待确认的映射操作过多，请稍后重新预览");
    const expectedChanges = input.operation === "select_canonical" ? ["明确当前文章的主稿；现有变体保留原始来源摘要。"] : input.operation === "map_variant" ? ["记录渠道变体及当前来源摘要；保留原稿字节。"] : input.operation === "bind" ? ["人工绑定所选来源；历史账本、已保存文章和远端目标仍保留原身份。"] : [`保留明确选择的来源及原文章身份；为其他 ${detached.length} 个来源建立独立身份。`, "历史账本和远端目标不会迁移到新身份。"];
    const preview: MappingPreview = { intentId: this.options.ids.opaqueId("mapping-intent"), generationId: this.options.generationId, contentRef: input.contentRef, operation: input.operation, sideEffect: "local_write", inputDigest, expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(), expectedRevision: snapshot.revision, expectedChanges, sources: selected.map(source => sourceView(source, snapshot.bindings)) };
    this.intents.set(preview.intentId, { preview, caller: owner, snapshot: structuredClone(snapshot), mutation, detached, consumed: false });
    return structuredClone(preview);
  }
  async apply(intentId: string, caller: MappingCaller, signal?: AbortSignal): Promise<MappingApplyResult> {
    this.active(signal); const owner = callerKey(caller);
    const saved = this.intents.get(intentId);
    if (!saved || saved.consumed || saved.preview.generationId !== this.options.generationId) fail("MAPPING_INTENT_INVALID", "映射预览已失效或已使用，请重新预览");
    if (saved.caller !== owner) fail("MAPPING_CALLER_CHANGED", "映射预览属于另一调用方，请重新预览");
    saved.consumed = true;
    const current = (): void => {
      this.active(signal);
      if (saved.preview.generationId !== this.options.generationId) fail("MAPPING_INTENT_INVALID", "映射预览所属配置已失效，请重新预览");
      if (Date.parse(saved.preview.expiresAt) <= Date.parse(this.options.clock.nowIso())) fail("MAPPING_INTENT_EXPIRED", "映射预览已过期，请重新预览");
    };
    current();
    const snapshot = await this.options.mappings.read(); current();
    if (mappingSnapshotSignature(snapshot) !== mappingSnapshotSignature(saved.snapshot)) fail("MAPPING_INPUT_CHANGED", "来源、文件内容或工作台状态已经变化，请重新预览");
    const revision = await this.options.mappings.commit(saved.snapshot, saved.mutation, current);
    return { intentId, contentRef: saved.preview.contentRef, operation: saved.preview.operation, revision, detachedContentRefs: [...saved.detached] };
  }
}

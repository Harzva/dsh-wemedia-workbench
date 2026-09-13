import type { SourceRecord } from "../domain/content.ts";
import type { OverlayV1 } from "../domain/schema.ts";
import { isJsonObject } from "../domain/json.ts";
import { parseContentRef } from "../domain/primitives.ts";
import type { ContentRef } from "../domain/primitives.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { WorkbenchCatalog } from "../ports/workbench.ts";
import { IndexService } from "./indexService.ts";
import { IdentityService } from "./identityService.ts";
import { mappingArtifact } from "../domain/contentMapping.ts";

export class WorkbenchCatalogService implements WorkbenchCatalog {
  constructor(private readonly index: IndexService, private readonly identity: IdentityService, private readonly generationId: string, private readonly now: () => string) {}
  async refresh(overlay: OverlayV1) {
    const result = await this.index.refresh(this.generationId, this.now());
    if (!result.ok) throw new WorkbenchFault("INDEX_UNAVAILABLE", "内容索引不可用，请检查已配置目录");
    const sources: SourceRecord[] = result.value.sources.filter(source => source.recordKind === "wechat_manifest");
    const mappingSources = result.value.sources.filter(source => mappingArtifact(source) !== null);
    const bindings = { ...overlay.contentBindings };
    const documents = overlay.extensions.wechatDocuments;
    if (isJsonObject(documents)) {
      for (const [reference, saved] of Object.entries(documents)) {
        if (!parseContentRef(reference).ok || !isJsonObject(saved) || !isJsonObject(saved.document)) continue;
        for (const source of sources) {
          if (source.rootId === saved.document.rootId && source.relativePath === saved.document.relativePath) bindings[source.recordId] = reference as ContentRef;
        }
      }
    }
    const resolved = this.identity.resolve(mappingSources, { ...overlay, contentBindings: bindings });
    if (!resolved.ok) throw new WorkbenchFault("IDENTITY_INVALID", "内容身份无法可靠解析");
    return { sources, mappingSources, components: resolved.value.components, manualDecisions: resolved.value.manualDecisions, bindings: resolved.value.updatedBindings, issues: [...result.value.issues.map(issue => issue.code), ...(result.value.stale ? ["INDEX_STALE"] : [])] };
  }
}

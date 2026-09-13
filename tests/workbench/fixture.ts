import { testPng } from "../fixtures/png.ts";
import { articleParagraphs } from "../../src/domain/inspection.ts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkbenchCatalogService } from "../../src/application/workbenchCatalog.ts";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import { IndexService } from "../../src/application/indexService.ts";
import { IdentityService } from "../../src/application/identityService.ts";
import { FileIndexCacheRepository } from "../../src/infrastructure/indexCacheRepository.ts";
import { FileOverlayRepository } from "../../src/infrastructure/overlayRepository.ts";
import { createRootCapability } from "../../src/infrastructure/pathPolicy.ts";
import { scanRoots } from "../../src/infrastructure/scanner.ts";
import { FileWorkbenchDocuments, sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { FileWorkbenchJobs } from "../../src/infrastructure/workbenchJobs.ts";
import { WorkbenchStore } from "../../src/infrastructure/workbenchStore.ts";
import { success } from "../../src/domain/errors.ts";
import type { WorkbenchAdapter, WorkbenchApprovalProvider } from "../../src/ports/workbench.ts";
import type { ArticleDocument } from "../../src/domain/workbench.ts";

export async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "wm-vertical-"));
  const sourcePath = resolve(directory, "source"), writePath = resolve(directory, "write"), dataPath = resolve(directory, "state");
  await Promise.all([sourcePath, writePath, dataPath].map(path => mkdir(path)));
  const descriptors = [{ id: "source", label: "Read-only source", path: sourcePath, mode: "read" as const }, { id: "write", label: "New revisions", path: writePath, mode: "write" as const }];
  const roots = await Promise.all(descriptors.map(async descriptor => { const result = await createRootCapability(descriptor); if (!result.ok) throw new Error("fixture root"); return result.value; }));
  const store = new WorkbenchStore(new FileOverlayRepository(resolve(dataPath, "overlay.json")));
  const ids = { uuidV4: randomUUID, opaqueId: (prefix: string) => `${prefix}:${randomUUID()}` };
  let time = "2026-09-06T00:00:00.000Z";
  const now = () => time;
  const catalog = new WorkbenchCatalogService(new IndexService({ scan: () => scanRoots(roots.map(root => ({ ...root, enabled: true, include: [], exclude: [] })), { maxFileBytes: 1024 * 1024 }) }, new FileIndexCacheRepository(resolve(dataPath, "index.json"))), new IdentityService(ids), "fixture", now);
  const documents = new FileWorkbenchDocuments({ roots, writeRoot: roots[1]!, store, catalog, now, settings: { roots: roots.map(root => ({ id: root.id, label: root.label, mode: root.mode, available: true })), hasWriteRoot: true, hasDataDir: true, approvalAvailable: false, issues: [] } });
  let account = `wechat-account:${"a".repeat(32)}`;
  let remoteCalls = 0;
  const adapter: WorkbenchAdapter = {
    accountRef: () => account,
    discover: async () => ({ channel: "wechat", adapter: "fixture", configured: "configured", actions: [] }),
    check: async doc => ({ inputDigest: doc.revisionDigest, status: "pass", issues: [] }),
    run: async (action, document) => { remoteCalls += 1; return { ok: true, code: "WECHAT_DRAFT_VERIFIED", phase: action === "sync" ? "sync" : "draft", channel: "wechat", sideEffect: action === "sync" ? "read" : "remote_draft", artifacts: [], issues: [], retryable: false, remote: { remoteId: "FixtureMediaID" }, revisionDigest: document.revisionDigest, verifiedAt: now(), uploads: [] }; },
  };
  let grant = true;
  let afterApproval: (() => Promise<void>) | undefined;
  const approvals: WorkbenchApprovalProvider = { available: () => true, forCaller: caller => caller.kind === "agent" ? {
    request: async () => { await afterApproval?.(); return success({ approved: grant, ...(grant ? { reference: "fixture-approval" } : {}) }); },
    verify: async () => success({ approved: grant }),
  } : undefined };
  const jobs = new FileWorkbenchJobs(store);
  const service = new WorkbenchService({ documents, draftBatchStore: store, jobs, adapter, approvals, clock: { nowIso: now, monotonicMs: () => Date.parse(time) }, ids, hasher: { digest: sha256 } });
  await service.initialize();
  const create = async (): Promise<ArticleDocument> => documents.create({ contentRef: `wmc:${randomUUID()}`, metadata: { articleId: `fixture-${randomUUID()}`, title: "Fixture article", author: "Editor", digest: "An accurately sourced article with a clear description.", kind: "article", sourceUrl: "https://example.org/article", pdfUrl: "", codeUrl: "", titlePrefix: "" } });
  return { directory, sourcePath, writePath, dataPath, roots, store, documents, adapter, approvals, jobs, service, create, now, setTime: (value: string) => { time = value; }, setAccount: (value: string) => { account = value; }, setGrant: (value: boolean) => { grant = value; }, setAfterApproval: (value: () => Promise<void>) => { afterApproval = value; }, remoteCalls: () => remoteCalls,
    cleanup: async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); },
    reviewAll: async (document: ArticleDocument) => {
      for (const kind of ["facts", "editorial", "images_formulas", "mobile_visual"] as const) {
        const file = `${kind}.${kind === "mobile_visual" ? "png" : "json"}`;
        if (kind === "mobile_visual") {
          // Structural unit-test bytes only; never claimed as visual acceptance.
          await writeFile(resolve(writePath, file), testPng());
        } else await writeFile(resolve(writePath, file), JSON.stringify({ schemaVersion: "wemedia.review/v1", kind, revisionDigest: document.revisionDigest, verdict: "pass", findings: ["Fixture-specific review evidence"], details: {
          body: "Synthetic fixture review; not a real editorial attestation.", markdownDigest: sha256(document.markdown), sources: [],
          paragraphs: articleParagraphs(document.html).map((_, i) => i + 1), facts: articleParagraphs(document.html).map((claim, i) => ({ id: `f${i}`, paragraph: i + 1, claim, disposition: "not_applicable", sourceIds: [], note: "Synthetic fixture paragraph, no real-world fact is asserted." })),
          assets: document.assets.map(asset => ({ source: asset.source, digest: asset.digest, kind: "other", sourceIds: [], formulaSource: "", note: "Synthetic fixture image, not an original paper figure." })),
        } }));
        await documents.recordReview(document.contentRef, { kind, revisionDigest: document.revisionDigest, artifact: { rootId: "write", relativePath: file }, summary: "Fixture attestation", reviewer: "agent" });
      }
    },
  };
}

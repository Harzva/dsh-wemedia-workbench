import { ReferenceLibraryService } from "../application/referenceLibraryService.ts";
import { createWechatCollector } from "../infrastructure/wechatCollector.ts";
import { createXhsCollector } from "../infrastructure/xhsCollector.ts";
import { AccountManagementService } from "../application/accountManagementService.ts";
import { createAccountProviders } from "../infrastructure/accountProviders.ts";
import { LocalSetup } from "../infrastructure/localSetup.ts";
import { FileContentMappings } from "../infrastructure/contentMappings.ts";
import { FilePublicationDrafts } from "../infrastructure/publicationDrafts.ts";
import { IsolatedNotifier } from "../infrastructure/localNotifier.ts";
import { LocalPublications } from "../infrastructure/localPublications.ts";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ConfigV1 } from "../config.ts";
import { IndexService } from "../application/indexService.ts";
import { IdentityService } from "../application/identityService.ts";
import { WorkbenchCatalogService } from "../application/workbenchCatalog.ts";
import { WorkbenchService } from "../application/workbenchService.ts";
import { WechatAdapter } from "../adapters/wechat.ts";
import { ChannelBridgeAdapter } from "../adapters/channelBridge.ts";
import { ChannelPublishingService } from "../application/channelPublishingService.ts";
import { PUBLISHING_CHANNELS } from "../domain/channelPublishing.ts";
import { FileIndexCacheRepository } from "../infrastructure/indexCacheRepository.ts";
import { FileLedgerRepository } from "../infrastructure/ledgerRepository.ts";
import { FileOverlayRepository } from "../infrastructure/overlayRepository.ts";
import { MemoryIndexRepository, MemoryOverlayRepository } from "../infrastructure/memoryRepositories.ts";
import { createRootCapability, isWithinRoot, normalizeRelativePath, validateDataDirBoundary } from "../infrastructure/pathPolicy.ts";
import type { RootCapability } from "../infrastructure/pathPolicy.ts";
import { SecureProcessRunner } from "../infrastructure/processRunner.ts";
import { scanRoots } from "../infrastructure/scanner.ts";
import { FileWorkbenchDocuments, sha256 } from "../infrastructure/workbenchDocuments.ts";
import { FileWorkbenchJobs } from "../infrastructure/workbenchJobs.ts";
import { FileContentLibrary } from "../infrastructure/contentLibrary.ts";
import { WorkbenchStore } from "../infrastructure/workbenchStore.ts";
import { createDefaultQualityRegistry } from "../quality/registry.ts";
import type { WorkbenchApprovalProvider } from "../ports/workbench.ts";
import type { WorkbenchSettings } from "../domain/workbench.ts";
import type { CommandSpec } from "../ports/process.ts";

export async function composeWorkbench(config: ConfigV1, approvals: WorkbenchApprovalProvider, setupHost?: { getConfig(): ConfigV1; applyConfig(next: ConfigV1): Promise<void> }): Promise<WorkbenchService> {
  const issues: string[] = [];
  const roots: RootCapability[] = [];
  const boundaryRoots: RootCapability[] = [];
  const rootSettings: WorkbenchSettings["roots"] = [];
  const ids = new Set<string>(["write", "wechat-adapter"]);
  for (const entry of config.roots) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(entry.id) || ids.has(entry.id) || !isAbsolute(entry.path)) { issues.push("ROOT_CONFIG_INVALID"); continue; }
    ids.add(entry.id);
    const resolved = await createRootCapability(entry);
    if (entry.enabled) rootSettings.push({ id: entry.id, label: entry.label, mode: "read", available: resolved.ok });
    if (resolved.ok) { boundaryRoots.push(resolved.value); if (entry.enabled) roots.push(resolved.value); }
    else if (entry.enabled) issues.push("ROOT_UNAVAILABLE");
  }
  let writeRoot: RootCapability | undefined;
  let writeCandidate: RootCapability | undefined;
  if (config.writeRoot && isAbsolute(config.writeRoot)) {
    const result = await createRootCapability({ id: "write", label: "文章写入目录", path: config.writeRoot, mode: config.writeRootEnabled === false ? "read" : "write" });
    if (result.ok && !boundaryRoots.some(root => isWithinRoot(root.realPath, result.value.realPath) || isWithinRoot(result.value.realPath, root.realPath))) {
      writeCandidate = result.value; roots.push(writeCandidate);
      if (config.writeRootEnabled !== false) writeRoot = writeCandidate;
    }
    else issues.push("WRITE_ROOT_UNAVAILABLE_OR_OVERLAPPING");
    if (result.ok) boundaryRoots.push(result.value);
  }
  rootSettings.push({ id: "write", label: "文章写入目录", mode: config.writeRootEnabled === false ? "read" : "write", available: Boolean(writeCandidate) });
  let dataDir: RootCapability | undefined;
  if (config.dataDir && isAbsolute(config.dataDir) && dirname(config.dataDir) !== config.dataDir) {
    try {
      // Validate lexical overlap before creating any configured state directory.
      const configuredBoundaries = [...config.roots.map(root => root.path), ...(config.writeRoot ? [config.writeRoot] : [])].filter(isAbsolute).map(path => resolve(path));
      if ([...boundaryRoots.map(root => root.realPath), ...configuredBoundaries].some(path => isWithinRoot(path, resolve(config.dataDir)) || isWithinRoot(resolve(config.dataDir), path))) throw new Error("overlap");
      await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      const candidate = await createRootCapability({ id: "data", label: "工作台状态", path: config.dataDir, mode: "write" });
      if (candidate.ok && (await validateDataDirBoundary(candidate.value, boundaryRoots)).ok) dataDir = candidate.value;
    } catch { /* No path or native error crosses into the public settings DTO. */ }
  }
  if (!dataDir) { issues.push("DATA_DIR_REQUIRED"); writeRoot = undefined; }
  if (!writeRoot && config.writeRootEnabled !== false) issues.push("WRITE_ROOT_REQUIRED");
  // Without durable identities, configured content is not exposed under
  // unstable transient IDs. Empty mode remains useful for setup diagnostics.
  const indexedRoots = dataDir ? roots : [];
  const store = new WorkbenchStore(dataDir ? new FileOverlayRepository(resolve(dataDir.realPath, "overlay.json")) : new MemoryOverlayRepository());
  const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => performance.now() };
  const generator = { uuidV4: randomUUID, opaqueId: (prefix: string) => `${prefix}:${randomUUID()}` };
  const hasher = { digest: sha256 };
  const cache = dataDir ? new FileIndexCacheRepository(resolve(dataDir.realPath, "index.json")) : new MemoryIndexRepository();
  const catalog = new WorkbenchCatalogService(new IndexService({ scan: () => scanRoots(indexedRoots.map(root => { const configured = config.roots.find(item => item.id === root.id); return { ...root, enabled: true, include: configured?.include ?? [], exclude: configured?.exclude ?? [] }; }), { maxFileBytes: config.scan.maxFileBytes }) }, cache), new IdentityService(generator), generator.opaqueId("index"), clock.nowIso);
  const settings: WorkbenchSettings = { roots: rootSettings, hasWriteRoot: Boolean(writeRoot), hasDataDir: Boolean(dataDir), approvalAvailable: approvals.available(), issues };
  let publications: LocalPublications | undefined;
  if (config.publicationSources) {
    try { publications = new LocalPublications(config.publicationSources); }
    catch { issues.push("PUBLICATION_SOURCE_CONFIG_INVALID"); }
  }
  let channelService: ChannelPublishingService | undefined;
  const channelRecords = (ref: import("../domain/primitives.ts").ContentRef, revision: string, documentDigest: string) => channelService?.records(ref, revision, documentDigest) ?? [];
  const documents = new FileWorkbenchDocuments({ channelRecords, ...(publications ? { publications } : {}), roots: indexedRoots, ...(writeRoot ? { writeRoot } : {}), store, catalog, settings, now: clock.nowIso });
  let publicationDrafts: FilePublicationDrafts;
  const library = new FileContentLibrary({ documents, sourceBindings: async () => (await store.read()).contentBindings, publicationDrafts: () => publicationDrafts.catalog(), ...(publications ? { publications } : {}), roots: indexedRoots.map(root => {
    const configured = config.roots.find(item => item.id === root.id);
    return { ...root, enabled: true, include: configured?.include ?? [], exclude: configured?.exclude ?? [] };
  }) });
  publicationDrafts = new FilePublicationDrafts({ channelRecords, ...(dataDir && writeCandidate ? { root: writeCandidate } : {}), store, library, now: clock.nowIso });
  let command: CommandSpec | undefined;
  let runner: SecureProcessRunner | undefined;
  const adapterConfig = config.adapters.wechat;
  if (dataDir && adapterConfig?.enabled && adapterConfig.command && isAbsolute(adapterConfig.command)) {
    try {
      const script = await realpath(adapterConfig.command);
      if (basename(script) !== "wemedia_bridge.mjs" || !(await stat(script)).isFile()) throw new Error("bridge");
      const cwd = await createRootCapability({ id: "wechat-adapter", label: "微信适配入口", path: adapterConfig.cwd ?? dirname(script), mode: "read" });
      if (!cwd.ok) throw new Error("cwd");
      runner = new SecureProcessRunner({ roots: [cwd.value], executables: { "wechat-bridge-node": { path: process.execPath, allowedEnvKeys: [] } }, baseEnv: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` }, maxTimeoutMs: 300_000, terminationGraceMs: 2000 });
      command = { executable: "wechat-bridge-node", argv: [script], cwdRootId: cwd.value.id, cwdRelativePath: "", env: {}, timeoutMs: adapterConfig.timeoutMs ?? 180_000, maxOutputBytes: 256 * 1024 };
    } catch { issues.push("WECHAT_BRIDGE_CONFIG_INVALID"); }
  }
  const adapter = new WechatAdapter({ ...(runner ? { runner } : {}), ...(command ? { command } : {}), roots: Object.fromEntries(indexedRoots.map(root => [root.id, root.realPath])), privateState: (contentRef, target) => documents.privateRemoteState(contentRef, target), now: clock.nowIso });
  const channelAdapters = await Promise.all(PUBLISHING_CHANNELS.map(async channel => {
    const entry = config.adapters[channel];
    let channelRunner: SecureProcessRunner | undefined, channelCommand: CommandSpec | undefined;
    if (dataDir && entry?.enabled && entry.command && isAbsolute(entry.command)) {
      try {
        const script = await realpath(entry.command);
        if (basename(script) !== "wemedia_bridge.mjs" || !(await stat(script)).isFile()) throw new Error("bridge");
        const cwd = await createRootCapability({ id: `${channel}-adapter`, label: `${channel}渠道桥接`, path: entry.cwd ?? dirname(script), mode: "read" });
        if (!cwd.ok) throw new Error("cwd");
        channelRunner = new SecureProcessRunner({ roots: [cwd.value], executables: { "channel-node": { path: process.execPath, allowedEnvKeys: [] } }, baseEnv: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` }, maxTimeoutMs: 300_000, terminationGraceMs: 2000 });
        channelCommand = { executable: "channel-node", argv: [script], cwdRootId: cwd.value.id, cwdRelativePath: "", env: {}, timeoutMs: entry.timeoutMs ?? 180_000, maxOutputBytes: 256 * 1024 };
      } catch { issues.push(`${channel.toUpperCase()}_BRIDGE_CONFIG_INVALID`); }
    }
    return new ChannelBridgeAdapter(channel, { ...(channelRunner ? { runner: channelRunner } : {}), ...(channelCommand ? { command: channelCommand } : {}), roots: Object.fromEntries(indexedRoots.map(root => [root.id, root.realPath])), now: clock.nowIso });
  }));
  const accountProviders = dataDir ? await createAccountProviders(config, resolve(dataDir.realPath, "accounts"), channelAdapters) : [];
  return new WorkbenchService({ documents, library, ...(dataDir ? { references: (canCollect: () => boolean) => new ReferenceLibraryService({ store, canCollect, wechat: createWechatCollector(), xhs: createXhsCollector({ enabled: config.adapters.xiaohongshu?.enabled === true }), clock, hasher }) } : {}), ...(dataDir ? { accounts: (canLogin: () => boolean) => new AccountManagementService({ providers: accountProviders, store, canLogin, clock, ids: generator }) } : {}), ...(dataDir ? { channelPublishing: (generationId: string, canStart: () => boolean) => channelService = new ChannelPublishingService({ generationId, canStart, adapters: channelAdapters, documents, publications: publicationDrafts, store, ledger: new FileLedgerRepository(resolve(dataDir!.realPath, "channel-ledger.jsonl")), approvals, clock, ids: generator, hasher, writeAvailable: () => settings.hasWriteRoot && settings.hasDataDir }) } : {}), mappings: new FileContentMappings({ catalog, store, roots: indexedRoots, readBytes: documents.readBytes.bind(documents) }), ...(setupHost ? { setup: new LocalSetup({ ...setupHost, hasher }) } : {}), publicationDrafts, notifier: new IsolatedNotifier(), ...(publications ? { publications } : {}), jobs: new FileWorkbenchJobs(store), adapter, approvals, clock, ids: generator, hasher, quality: createDefaultQualityRegistry(path => normalizeRelativePath(path).ok), ...(dataDir ? { ledger: new FileLedgerRepository(resolve(dataDir!.realPath, "ledger.jsonl")) } : {}) });
}

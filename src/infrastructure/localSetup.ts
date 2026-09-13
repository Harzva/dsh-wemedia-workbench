import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ConfigV1 } from "../domain/config.ts";
import type { SetupCandidate, SetupSelection } from "../domain/setup.ts";
import { WorkbenchFault } from "../domain/workbench.ts";
import type { SetupPort, SetupProposal, SetupState } from "../ports/setup.ts";
import { isWithinRoot } from "./pathPolicy.ts";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const fail = (code: string, message: string): never => { throw new WorkbenchFault(code, message); };
const active = (signal?: AbortSignal): void => { if (signal?.aborted) fail("REQUEST_CANCELLED", "设置操作已取消"); };
const overlap = (left: string, right: string): boolean => isWithinRoot(left, right) || isWithinRoot(right, left);
const publicLabel = (label: string, fallback: string): string => label.replace(/[\u0000-\u001f\u007f<>]/gu, "").replace(/(?:file:\/\/|https?:\/\/|(?:^|\s)\/|[A-Za-z]:\\)\S+/giu, "[目录]").replace(/(?:token|secret|password|cookie|authorization|api.?key)\s*[:=]\s*\S+/giu, "[敏感信息]").trim().slice(0, 100) || fallback;
interface Directory { path: string; identity: string; available: boolean }
interface LocalState { state: SetupState; config: ConfigV1; configDigest: string; directories: Map<string, Directory>; data: Directory; write: Directory | null }

/** No directory enumeration, creation, credential reads or profile-file writes. */
export class LocalSetup implements SetupPort {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { getConfig: () => ConfigV1; applyConfig: (config: ConfigV1) => Promise<void>; hasher: { digest(value: string): string } }) {}
  private configuration(): { config: ConfigV1; digest: string } {
    try {
      const config = structuredClone(this.options.getConfig());
      if (!config || !Array.isArray(config.roots) || config.roots.length > 100 || typeof config.dataDir !== "string" || config.writeRootEnabled !== undefined && typeof config.writeRootEnabled !== "boolean") throw new Error("config");
      return { config, digest: this.options.hasher.digest(JSON.stringify(config)) };
    } catch { return fail("SETUP_CONFIG_INVALID", "原生目录配置无法安全读取，请先检查配置"); }
  }
  private async directory(path: unknown, writable: boolean): Promise<Directory> {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f]/u.test(path) || dirname(resolve(path)) === resolve(path)) return { path: "", identity: "invalid", available: false };
    const normalized = resolve(path);
    try {
      const first = await lstat(normalized, { bigint: true });
      const canonical = await realpath(normalized);
      // A rejected alias still contributes its physical boundary: disabling
      // that candidate cannot turn the same old source into a writable root.
      if (!first.isDirectory() || first.isSymbolicLink() || canonical !== normalized) return { path: canonical, identity: "symlink-or-alias", available: false };
      await access(normalized, constants.R_OK | (writable ? constants.W_OK : 0));
      const final = await lstat(normalized, { bigint: true });
      if (!final.isDirectory() || final.isSymbolicLink() || final.dev !== first.dev || final.ino !== first.ino || final.birthtimeNs !== first.birthtimeNs) return { path: normalized, identity: "changed", available: false };
      return { path: normalized, identity: `${final.dev}:${final.ino}:${final.birthtimeNs}:${final.mode}`, available: true };
    } catch { return { path: normalized, identity: "unavailable", available: false }; }
  }
  private async read(signal?: AbortSignal): Promise<LocalState> {
    active(signal); const { config, digest } = this.configuration();
    const issues = new Set<string>(), directories = new Map<string, Directory>(), roots: SetupCandidate[] = [];
    const counts = new Map<string, number>();
    for (const root of config.roots) if (root && typeof root.id === "string") counts.set(root.id, (counts.get(root.id) ?? 0) + 1);
    for (const root of config.roots) {
      active(signal);
      if (!root || typeof root.id !== "string" || !ID.test(root.id) || ["write", "data", "wechat-adapter"].includes(root.id) || typeof root.label !== "string" || root.mode !== "read" || typeof root.enabled !== "boolean" || !Array.isArray(root.include) || !Array.isArray(root.exclude)) { issues.add("ROOT_CONFIG_INVALID"); continue; }
      if (directories.has(root.id)) continue;
      const directory = await this.directory(root.path, false);
      if (counts.get(root.id) !== 1) { directory.available = false; issues.add("ROOT_ID_CONFLICT"); }
      if (!directory.available) issues.add("ROOT_UNAVAILABLE");
      directories.set(root.id, directory);
      roots.push({ id: root.id, label: publicLabel(root.label, root.id), available: directory.available, selected: root.enabled });
    }
    const data = await this.directory(config.dataDir, true);
    if (data.available && [...directories.values()].some(root => root.path && overlap(data.path, root.path))) { data.available = false; issues.add("DATA_DIR_OVERLAP"); }
    if (!data.available) issues.add("DATA_DIR_UNAVAILABLE");
    const write = config.writeRoot ? await this.directory(config.writeRoot, true) : null;
    if (write?.available && ([...directories.values()].some(root => root.path && overlap(write.path, root.path)) || data.path && overlap(write.path, data.path))) { write.available = false; issues.add("WRITE_ROOT_OVERLAP"); }
    if (write && !write.available) issues.add("WRITE_ROOT_UNAVAILABLE");
    active(signal);
    if (this.configuration().digest !== digest) fail("SETUP_CONFIG_CHANGED", "配置读取期间已变化，请重新预览");
    const writeSelected = write !== null && config.writeRootEnabled !== false;
    const selection: SetupSelection = { rootIds: roots.filter(root => root.selected).map(root => root.id).sort(), writeRootId: writeSelected ? "write" : null };
    const writeRoots: SetupCandidate[] = write ? [{ id: "write", label: "独立写入目录", available: write.available, selected: writeSelected }] : [];
    const signature = this.options.hasher.digest(JSON.stringify([digest, [...directories], data, write]));
    return { config, configDigest: digest, directories, data, write, state: { roots, writeRoots, selection, dataDirAvailable: data.available, issues: [...issues], signature } };
  }
  private selection(input: SetupSelection, local: LocalState): SetupProposal {
    if (!input || Object.keys(input).some(key => !["rootIds", "writeRootId"].includes(key)) || !Array.isArray(input.rootIds) || input.rootIds.length > 100 || input.rootIds.some(id => typeof id !== "string" || !ID.test(id)) || new Set(input.rootIds).size !== input.rootIds.length || input.writeRootId !== null && input.writeRootId !== "write") return fail("REQUEST_INVALID", "请选择明确且不重复的已配置目录");
    if (input.rootIds.some(id => !local.directories.has(id)) || input.writeRootId === "write" && !local.write) fail("SETUP_ROOT_UNKNOWN", "所选目录不在原生配置候选中，请先配置后重新预览");
    const blockingCodes: string[] = [];
    if (local.state.issues.includes("ROOT_CONFIG_INVALID") || local.state.issues.includes("ROOT_ID_CONFLICT")) blockingCodes.push("ROOT_CONFIG_INVALID");
    if (input.rootIds.some(id => !local.directories.get(id)?.available)) blockingCodes.push("ROOT_UNAVAILABLE");
    if (input.writeRootId && !local.write?.available) blockingCodes.push("WRITE_ROOT_UNAVAILABLE");
    if ((input.rootIds.length > 0 || input.writeRootId !== null || local.config.dataDir !== "") && !local.data.available) blockingCodes.push("DATA_DIR_UNAVAILABLE");
    return { state: local.state, selection: { rootIds: [...input.rootIds].sort(), writeRootId: input.writeRootId }, blockingCodes };
  }
  async inspect(signal?: AbortSignal): Promise<SetupState> { return (await this.read(signal)).state; }
  async preview(selection: SetupSelection, signal?: AbortSignal): Promise<SetupProposal> { return this.selection(selection, await this.read(signal)); }
  apply(selection: SetupSelection, expectedSignature: string, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    const saved = structuredClone(selection);
    const operation = this.queue.then(async () => {
      active(signal); const local = await this.read(signal), proposal = this.selection(saved, local);
      if (local.state.signature !== expectedSignature) fail("SETUP_CONFIG_CHANGED", "配置或目录身份已变化，请重新预览");
      if (proposal.blockingCodes.length) fail("SETUP_BLOCKED", "目录选择无法安全应用，请检查原生配置");
      const next = structuredClone(local.config);
      next.roots = next.roots.map(root => ({ ...root, enabled: proposal.selection.rootIds.includes(root.id) }));
      next.writeRootEnabled = proposal.selection.writeRootId !== null;
      active(signal); assertCurrent();
      if (this.configuration().digest !== local.configDigest) fail("SETUP_CONFIG_CHANGED", "提交前配置已变化，请重新预览");
      try { await this.options.applyConfig(next); }
      catch { fail("SETUP_APPLY_FAILED", "原生配置未确认保存；请重新连接并核对，不要重复应用旧预览"); }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

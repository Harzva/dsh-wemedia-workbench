export const CONFIG_SCHEMA_VERSION = "wemedia.config/v1" as const;

export type Channel = "wechat" | "zhihu" | "xiaohongshu" | "x";

export interface RootConfig {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
  mode: "read";
  include: string[];
  exclude: string[];
}

export interface AdapterConfig {
  enabled: boolean;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ConfigV1 {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  dataDir: string;
  roots: RootConfig[];
  writeRoot?: string;
  /** Missing preserves the legacy enabled behavior; the configured candidate stays private. */
  writeRootEnabled?: boolean;
  /** Explicit local receipt files, read only; never a directory discovery scope. */
  publicationSources?: {
    workspaceRoot: string;
    ledgerPath?: string;
    zhihuInventoryPath?: string;
    xiaohongshuLedgerPath?: string;
  };
  adapters: Partial<Record<Channel, AdapterConfig>>;
  scan: {
    debounceMs: number;
    maxFileBytes: number;
  };
}

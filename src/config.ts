import Schema from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cosmokit";

import { CONFIG_SCHEMA_VERSION } from "./domain/config.ts";
import type { ConfigV1 } from "./domain/config.ts";
export { CONFIG_SCHEMA_VERSION } from "./domain/config.ts";
export type { Channel, RootConfig, AdapterConfig, ConfigV1 } from "./domain/config.ts";

const RootConfigSchema = Schema.object({
  id: Schema.string().required(),
  label: Schema.string().required(),
  path: Schema.string().required(),
  enabled: Schema.boolean().default(true),
  mode: Schema.const("read").default("read"),
  include: Schema.array(Schema.string()).default([]),
  exclude: Schema.array(Schema.string()).default([]),
});

const AdapterConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  command: Schema.string(),
  cwd: Schema.string(),
  timeoutMs: Schema.number().min(1_000).max(300_000),
});

const AdaptersSchema = Schema.object({
  wechat: AdapterConfigSchema,
  zhihu: AdapterConfigSchema,
  xiaohongshu: AdapterConfigSchema,
  x: AdapterConfigSchema,
}) as Schema<ConfigV1["adapters"]>;

const ScanSchema = Schema.object({
  debounceMs: Schema.number().min(50).max(60_000).default(500),
  maxFileBytes: Schema.number().min(1_024).max(16_777_216).default(1_048_576),
}) as Schema<ConfigV1["scan"]>;

export type RuntimeConfig = Omit<ConfigV1, "roots" | "writeRootEnabled" | "scan"> & {
  roots: Volatile<ConfigV1["roots"]>;
  writeRootEnabled: Volatile<boolean>;
  scan: Volatile<ConfigV1["scan"]>;
};

export const Config: Schema<ConfigV1, RuntimeConfig> = Schema.object({
  schemaVersion: Schema.const(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  dataDir: Schema.string().default(""),
  roots: Schema.array(RootConfigSchema).default([]).volatile(),
  writeRoot: Schema.string(),
  writeRootEnabled: Schema.boolean().default(true).volatile(),
  publicationSources: Schema.union([Schema.const(undefined), Schema.object({
    workspaceRoot: Schema.string().required(),
    ledgerPath: Schema.string(),
    zhihuInventoryPath: Schema.string(),
    xiaohongshuLedgerPath: Schema.string(),
  })]),
  adapters: AdaptersSchema.default({}),
  scan: ScanSchema.default({
    debounceMs: 500,
    maxFileBytes: 1_048_576,
  }).volatile(),
}) as Schema<ConfigV1, RuntimeConfig>;

export function snapshotRuntimeConfig(config: RuntimeConfig): ConfigV1 {
  return {
    ...config,
    roots: structuredClone(config.roots.get()) as ConfigV1["roots"],
    writeRootEnabled: config.writeRootEnabled.get(),
    scan: structuredClone(config.scan.get()) as ConfigV1["scan"],
  };
}

export function createDefaultConfig(): ConfigV1 {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    dataDir: "",
    roots: [],
    writeRootEnabled: true,
    adapters: {
      wechat: { enabled: false },
      zhihu: { enabled: false },
      xiaohongshu: { enabled: false },
      x: { enabled: false },
    },
    scan: {
      debounceMs: 500,
      maxFileBytes: 1_048_576,
    },
  };
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Schema from "@deepseek-ai/schemastery";
import { describe, expect, it } from "vitest";

import { Config, CONFIG_SCHEMA_VERSION, createDefaultConfig } from "../../src/config.ts";
import type { ConfigV1 } from "../../src/config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageManifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as {
  name?: string;
  version?: string;
  main?: string;
  exports?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  packageManager?: string;
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } };
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const runtimeFiles = [
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
] as const;

describe("package identity and DSH contracts", () => {
  it("declares an independent versioned package and exact runtime entries", () => {
    expect(packageManifest.name).toBe("dsh-wemedia-workbench");
    expect(packageManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageManifest.engines?.node).toBe(">=22.19.0");
    expect(packageManifest.packageManager).toBe("pnpm@10.16.1");
    expect(packageManifest.main).toBe("./lib/index.js");
    expect(packageManifest.exports).toEqual({
      ".": "./lib/index.js",
      "./client": "./lib/client.js",
      "./typert": "./lib/typert.host.js",
      "./package.json": "./package.json",
    });
    expect(packageManifest.files).toEqual([
      ...runtimeFiles,
      "cordis.patch.yml",
      "README.md",
      "docs/adapter-contract.md",
      "docs/formula-typesetting.md",
      "docs/ptc-workflows.md",
      "scripts/render-formulas.py",
      "scripts/crop-pdf-asset.py",
      "docs/pdf-asset-cropping.md",
      "docs/workflow-lessons.md",
      "docs/ai-assisted-workflow.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "docs/third-party/wechat-collector-MIT.txt",
      "LICENSE",
    ]);
    expect(packageManifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(packageManifest.dsh?.client?.platform).toBe("web");
  });

  it("keeps every declared DSH peer aligned with the development baseline", () => {
    const peers = packageManifest.peerDependencies ?? {};
    const development = packageManifest.devDependencies ?? {};
    for (const [dependency, version] of Object.entries(peers)) {
      expect(development[dependency], dependency).toBe(version);
    }
    expect(development["@deepseek-ai/dsh"]).toBe("0.1.1-rc.2");
    expect(peers["@deepseek-ai/cordis"]).toBe("4.0.1");
    expect(peers.react).toBe("18.3.1");
    for (const [dependency, version] of Object.entries(peers)) {
      if (dependency.startsWith("@deepseek-ai/dsh-")) {
        expect(version, dependency).toBe("0.1.1-rc.2");
      }
    }
  });

  it("uses an additive loader patch without replacing host shells", () => {
    const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
    expect(patch).toBe(
      "- insert:\n    - id: dsh-wemedia-workbench\n      name: dsh-wemedia-workbench\n",
    );
    expect(patch).not.toMatch(/disabled:\s*true/);
  });
});

describe("safe ConfigV1 baseline", () => {
  it("resolves to an empty local-only configuration", () => {
    const resolved = Schema.resolve({}, Config, { autofix: true })[0] as ConfigV1;
    expect(resolved).toEqual(createDefaultConfig());
    expect(resolved.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(resolved.roots).toEqual([]);
    expect(Object.values(resolved.adapters)).toHaveLength(4);
    expect(Object.values(resolved.adapters).every(({ enabled }) => !enabled)).toBe(true);
    expect(resolved.writeRoot).toBeUndefined();
    expect(resolved.dataDir).toBe("");
  });
});

describe("built and packed artifact", () => {
  it("resolves Host, Client, and typert exports from built files", () => {
    for (const file of runtimeFiles) expect(existsSync(resolve(root, file))).toBe(true);
    const probe = [
      "const host = await import('dsh-wemedia-workbench');",
      "if (host.name !== 'dsh-wemedia-workbench' || typeof host.apply !== 'function') process.exit(1);",
      "const typert = await import('dsh-wemedia-workbench/typert');",
      "if (typert.TYPERT?.package !== 'dsh-wemedia-workbench') process.exit(1);",
      "if (!import.meta.resolve('dsh-wemedia-workbench/client').endsWith('/lib/client.js')) process.exit(1);",
    ].join("\n");
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: root,
      stdio: "pipe",
    })).not.toThrow();
  });

  it("packs only the declared runtime and documentation files", () => {
    // Never depend on permissions or contents of the user's global npm cache.
    const cache = mkdtempSync(resolve(tmpdir(), "wm-pack-cache-"));
    let output: string;
    try {
      output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } finally { rmSync(cache, { recursive: true, force: true }); }
    const metadata = JSON.parse(output) as Array<{ files?: Array<{ path: string }> }>;
    const packed = (metadata[0]?.files ?? []).map(({ path }) => path).sort();
    expect(packed).toEqual([
      "CONTRIBUTING.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "cordis.patch.yml",
      "docs/adapter-contract.md",
      "docs/ai-assisted-workflow.md",
      "docs/formula-typesetting.md",
      "docs/pdf-asset-cropping.md",
      "docs/ptc-workflows.md",
      "docs/third-party/wechat-collector-MIT.txt",
      "docs/workflow-lessons.md",
      "lib/client.js",
      "lib/index.js",
      "lib/typert.host.js",
      "package.json",
      "scripts/crop-pdf-asset.py",
      "scripts/render-formulas.py",
    ]);
  });

  it("contains no operational legacy identity or machine-private path", () => {
    const checkedFiles = [
      "package.json",
      "cordis.patch.yml",
      "tsdown.config.ts",
      "README.md",
      "docs/adapter-contract.md",
      "docs/formula-typesetting.md",
      "docs/ai-assisted-workflow.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "docs/ptc-workflows.md",
      "docs/pdf-asset-cropping.md",
      "docs/workflow-lessons.md",
      "scripts/crop-pdf-asset.py",
      "docs/third-party/wechat-collector-MIT.txt",
      "src/index.ts",
      "src/config.ts",
      "src/client/index.tsx",
      "src/remote/contribution.ts",
      ...runtimeFiles,
    ];
    const forbiddenIdentity = new RegExp(["o", "i", "l", "_"].join(""), "i");
    const privateRoot = new RegExp(
      `(?:${"/"}Users${"/"}[^/]+${"/"}|${"/"}Volumes${"/"}[^/]+${"/"})`,
    );
    for (const file of checkedFiles) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).not.toMatch(forbiddenIdentity);
      expect(content, file).not.toMatch(privateRoot);
    }
  });
});

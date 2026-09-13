import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type SourceBlob = { path: string; data: Uint8Array | string; mode?: string; type?: string };
type Finding = { path: string; line: number; rule: string };
type ScannerModule = {
  PUBLIC_SOURCE_RULES: Record<string, string>;
  formatFinding: (finding: Finding) => string;
  scanBlob: (blob: SourceBlob) => Finding[];
  scanBlobs: (blobs: SourceBlob[]) => Finding[];
  scanGitRepository: (options?: { cwd?: string; ref?: string }) => Finding[];
};

// The helper is intentionally a JavaScript CLI; this test owns its small runtime contract.
// @ts-expect-error The source-only helper has no generated declaration file.
const scannerModule = await import("../../scripts/check-public-source.mjs") as ScannerModule;
const {
  PUBLIC_SOURCE_RULES,
  formatFinding,
  scanBlob,
  scanBlobs,
  scanGitRepository,
} = scannerModule;

const scanner = fileURLToPath(new URL("../../scripts/check-public-source.mjs", import.meta.url));

describe("public source scanner", () => {
  it("accepts public text and only the narrow synthetic test exception", () => {
    expect(scanBlobs([
      { path: "README.md", data: "A public README.\n" },
      { path: "tests/fixtures/negative.test.ts", data: "expect('/Users/test/private').not.toContain('x'); const value = 'SYNTHETIC_TOKEN';\n" },
      { path: "docs/ai-assisted-workflow.md", data: "Do not publish credentials or private paths.\n" },
      { path: "scripts/check-public-source.mjs", data: readFileSync(scanner) },
    ])).toEqual([]);
  });

  it("rejects private docs, private files, material blobs and high-confidence text", () => {
    const opaqueExample = ["looks", "like", "a", "secret", "123"].join("-");
    const machinePathExample = ["", "Users", "real-user", "private-workspace"].join("/");
    const findings = scanBlobs([
      { path: "docs/internal-run.md", data: "private run record\n" },
      { path: ".env.production", data: "PUBLIC_TOKEN=not-public\n" },
      { path: "assets/table.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]) },
      { path: "models/checkpoint.safetensors", data: new Uint8Array([1, 2, 3]) },
      { path: "src/config.ts", data: `const access_token = '${opaqueExample}';\n` },
      { path: "README.md", data: `See ${machinePathExample}.\n` },
    ]);
    expect(findings).toEqual(expect.arrayContaining([
      { path: "docs/internal-run.md", line: 1, rule: PUBLIC_SOURCE_RULES.PRIVATE_DOC_PATH },
      { path: ".env.production", line: 1, rule: PUBLIC_SOURCE_RULES.PRIVATE_FILE_PATH },
      { path: "assets/table.png", line: 1, rule: PUBLIC_SOURCE_RULES.BINARY_MATERIAL },
      { path: "models/checkpoint.safetensors", line: 1, rule: PUBLIC_SOURCE_RULES.PRIVATE_RUNTIME_PATH },
      { path: "models/checkpoint.safetensors", line: 1, rule: PUBLIC_SOURCE_RULES.BINARY_MATERIAL },
      { path: "src/config.ts", line: 1, rule: PUBLIC_SOURCE_RULES.TEXT_SECRET },
      { path: "README.md", line: 1, rule: PUBLIC_SOURCE_RULES.MACHINE_ABSOLUTE_PATH },
    ]));
  });

  it("does not print blob values in diagnostics", () => {
    const secret = "UNIQUE_SYNTHETIC_SECRET_VALUE_123";
    const findings = scanBlob({ path: "README.md", data: `access_token: '${secret}'\n` });
    const output = findings.map(formatFinding).join("\n");
    expect(output).toContain("README.md:1:TEXT_SECRET");
    expect(output).not.toContain(secret);
  });

  it("does not exempt an arbitrary test secret or a same-line secret", () => {
    const opaqueExample = ["long", "real", "looking", "value"].join("-");
    const rejectedExample = ["live", "looking", "value"].join("-");
    const findings = scanBlobs([
      { path: "tests/example.test.ts", data: `const private_key = '${opaqueExample}';\nAuthorization: Bearer ${opaqueExample}\n` },
      { path: "tests/fixtures/same-line.test.ts", data: `const path = '/Users/test/private'; const api_key = '${opaqueExample}';\n` },
      { path: "tests/fixtures/rejected.test.ts", data: `const api_key = '${rejectedExample}'; // reject\n` },
      { path: "docs/example.md", data: "https://example.org/?token=synthetic-value\n" },
    ]);
    expect(findings.filter(({ rule }) => rule === PUBLIC_SOURCE_RULES.TEXT_SECRET)).toHaveLength(5);
  });

  it("reads only the index by default and supports an explicit tree ref", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "public-source git-"));
    try {
      mkdirSync(resolve(directory, "docs"));
      writeFileSync(resolve(directory, "README.md"), "public\n");
      writeFileSync(resolve(directory, "docs", "private.md"), "private\n");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
      execFileSync("git", ["add", "README.md"], { cwd: directory });
      expect(scanGitRepository({ cwd: directory })).toEqual([]);
      execFileSync("git", ["add", "docs/private.md"], { cwd: directory });
      expect(scanGitRepository({ cwd: directory })).toEqual([
        { path: "docs/private.md", line: 1, rule: PUBLIC_SOURCE_RULES.PRIVATE_DOC_PATH },
      ]);
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: directory });
      const result = spawnSync(process.execPath, [scanner, "--ref=HEAD"], { cwd: directory, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("docs/private.md:1:PRIVATE_DOC_PATH");
      expect(`${result.stdout}${result.stderr}`).not.toContain("private run");
      const missingRef = spawnSync(process.execPath, [scanner, "--ref"], { cwd: directory, encoding: "utf8" });
      expect(missingRef.status).toBe(2);
      expect(missingRef.stderr).toContain("<cli>:1:CLI_ARGUMENTS");
      const spacedScript = resolve(directory, "public source check.mjs");
      copyFileSync(scanner, spacedScript);
      const spacedResult = spawnSync(process.execPath, [spacedScript, "--ref=HEAD"], { cwd: directory, encoding: "utf8" });
      expect(spacedResult.status).toBe(1);
      expect(spacedResult.stderr).toContain("docs/private.md:1:PRIVATE_DOC_PATH");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { isExportDeclaration, isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const layerRoots = {
  domain: resolve(root, "src/domain"),
  ports: resolve(root, "src/ports"),
  application: resolve(root, "src/application"),
  quality: resolve(root, "src/quality"),
  infrastructure: resolve(root, "src/infrastructure"),
} as const;
const sourceRoots = Object.values(layerRoots);
const api = new API();
const snapshot = api.updateSnapshot({ openProjects: [resolve(root, "tsconfig.json")] });
const project = snapshot.getProjects()[0];

afterAll(() => {
  snapshot.dispose();
  api.close();
});

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : extname(path) === ".ts" ? [path] : [];
  });
}

function imports(file: string): string[] {
  const source = project?.program.getSourceFile(file);
  if (source === undefined) throw new Error(`TypeScript program did not load ${file}`);
  return source.statements.flatMap((statement) => {
    if ((isImportDeclaration(statement) || isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && isStringLiteral(statement.moduleSpecifier)) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

describe("Phase 4 dependency direction", () => {
  it("keeps domain and ports free of platforms and reverse dependencies", () => {
    for (const file of sourceRoots.flatMap(files)) {
      const layer = (Object.entries(layerRoots).find(([, path]) => file.startsWith(`${path}/`))?.[0] ?? "unknown") as keyof typeof layerRoots;
      for (const specifier of imports(file)) {
        if (layer !== "infrastructure") {
          expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^(?:node:|react(?:\/|$)|cordis(?:\/|$)|@deepseek-ai\/)/);
        }
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/\/(?:adapters|client|dsh|remote)\//);
        if (layer === "domain") {
          expect(specifier, `${file} imports ${specifier}`).not.toMatch(/\/(?:ports|application|infrastructure)\//);
        }
        if (layer === "ports" && specifier.startsWith("..")) {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.\/domain\//);
        }
        if (layer === "application" && specifier.startsWith("..")) {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.\/(?:domain|ports)\//);
        }
        if (layer === "quality" && specifier.startsWith("..")) {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.\/(?:domain|ports)\//);
        }
        if (layer === "infrastructure" && specifier.startsWith("..")) {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.\/(?:domain|ports)\//);
        }
      }
    }
  });

  it("has an acyclic local import graph", () => {
    const all = sourceRoots.flatMap(files);
    const known = new Set(all);
    const graph = new Map(all.map((file) => [file, imports(file)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(file), specifier))
      .filter((dependency) => known.has(dependency))]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string): void => {
      expect(visiting.has(file), `dependency cycle at ${file}`).toBe(false);
      if (visited.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of all) visit(file);
  });
});

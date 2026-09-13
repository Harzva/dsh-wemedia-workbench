import { open } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { CONTENT_SCHEMA_VERSION, decodeContentManifest } from "../domain/schema.ts";
import type { ContentManifestV1 } from "../domain/schema.ts";
import type { RootCapability, SafePathRef } from "./pathPolicy.ts";
import { resolveCreateTarget, resolveReadablePath } from "./pathPolicy.ts";

export interface ContentProjectPlan {
  rootId: string;
  projectPath: string;
  manifest: ContentManifestV1;
  directories: string[];
  files: Array<{ relativePath: string; kind: "manifest" | "markdown" }>;
}

function manifestFailure<T>(safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage);
}

export function safeSlug(title: string, maxLength = 72): DomainResult<string> {
  const normalized = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/[\s_-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, maxLength)
    .replace(/[.-]+$/g, "");
  return normalized === "" ? manifestFailure("title does not produce a safe project slug") : success(normalized);
}

export function planContentProject(input: {
  rootId: string;
  date: string;
  title: string;
  contentId: string;
  topicKey?: string;
  sourceIds?: string[];
}): DomainResult<ContentProjectPlan> {
  const slug = safeSlug(input.title);
  if (!slug.ok) return slug;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return manifestFailure("project date must use YYYY-MM-DD");
  const decoded = decodeContentManifest({
    schemaVersion: CONTENT_SCHEMA_VERSION,
    contentId: input.contentId,
    title: input.title.trim(),
    sourceIds: input.sourceIds ?? [],
    canonicalDraft: "draft.md",
    variants: {},
    extensions: {},
    ...(input.topicKey === undefined ? {} : { topicKey: input.topicKey }),
  });
  if (!decoded.ok) return decoded;
  const projectPath = `${input.date}_${slug.value}`;
  return success({
    rootId: input.rootId,
    projectPath,
    manifest: decoded.value,
    directories: [projectPath, `${projectPath}/variants`, `${projectPath}/assets`, `${projectPath}/sources`, `${projectPath}/publish`],
    files: [
      { relativePath: `${projectPath}/draft.md`, kind: "markdown" },
      { relativePath: `${projectPath}/content.json`, kind: "manifest" },
    ],
  });
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function applyContentProject(
  writeRoot: RootCapability,
  plan: ContentProjectPlan,
): Promise<DomainResult<SafePathRef>> {
  if (writeRoot.id !== plan.rootId || writeRoot.mode !== "write") return manifestFailure("project plan does not match the configured write root");
  const target = await resolveCreateTarget(writeRoot, plan.projectPath);
  if (!target.ok) return target;
  try {
    await mkdir(target.value.absolutePath, { recursive: false, mode: 0o700 });
    for (const directory of plan.directories.slice(1)) {
      await mkdir(resolve(writeRoot.realPath, directory), { recursive: false, mode: 0o700 });
    }
    await writeExclusive(resolve(writeRoot.realPath, `${plan.projectPath}/draft.md`), `# ${plan.manifest.title}\n`);
    await writeExclusive(
      resolve(writeRoot.realPath, `${plan.projectPath}/content.json`),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
    );
    const directoryHandle = await open(target.value.absolutePath, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return success({ rootId: writeRoot.id, relativePath: plan.projectPath });
  } catch {
    return manifestFailure("content project could not be created exclusively");
  }
}

export async function readContentManifest(
  root: RootCapability,
  relativePath: string,
): Promise<DomainResult<ContentManifestV1>> {
  const resolved = await resolveReadablePath(root, relativePath);
  if (!resolved.ok || resolved.value.kind !== "file") return manifestFailure("content manifest is unavailable");
  try {
    const handle = await open(resolved.value.absolutePath, "r");
    const text = await handle.readFile("utf8").finally(() => handle.close());
    return decodeContentManifest(JSON.parse(text) as unknown);
  } catch {
    return manifestFailure("content manifest could not be decoded");
  }
}

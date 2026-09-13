import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, posix, resolve } from "node:path";

import type { SourceRecord } from "../domain/content.ts";
import { decodeContentManifest } from "../domain/schema.ts";
import { decodeWechatDocument } from "../domain/wechatDocument.ts";
import type { RootCapability } from "./pathPolicy.ts";
import { resolveReadablePath } from "./pathPolicy.ts";

export interface ScanRoot extends RootCapability {
  enabled: boolean;
  include: string[];
  exclude: string[];
}

export interface ScanIssue {
  rootId: string;
  relativePath: string;
  code: "root_unavailable" | "path_rejected" | "file_unreadable" | "manifest_invalid" | "file_too_large";
  safeMessage: string;
}

export interface ScanObservation {
  rootId: string;
  relativePath: string;
  operation: "metadata_read" | "content_read";
}

export interface ScanOptions {
  maxFileBytes: number;
  observe?: (event: ScanObservation) => void;
}

export interface ScanResult {
  sources: SourceRecord[];
  issues: ScanIssue[];
  fingerprint: string;
  successfulRootIds: string[];
}

const TEXT_EXTENSIONS = new Set([".md", ".markdown"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pdf", ".mp4", ".mov"]);
export const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**", "**/.DS_Store", "**/.wemedia-publication-*/**", "**/.wemedia-channel-*/**"];

function globPattern(pattern: string): RegExp {
  const input = pattern.replaceAll("\\", "/");
  let output = "^";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "*" && input[index + 1] === "*") {
      if (input[index + 2] === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += character === undefined ? "" : character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`);
}

export function matches(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(relativePath));
}

function isSupported(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  const extension = extname(name);
  return TEXT_EXTENSIONS.has(extension) || ASSET_EXTENSIONS.has(extension) || name === "content.json" || extension === ".jsonl" || name.endsWith(".local-wechat-draft.json") || name === "wechat-document.json";
}

function hash(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseScalar(value: string): string {
  return value.trim().replace(/^(?:"|')|(?:"|')$/g, "");
}

function parseSourceIds(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      return [];
    }
  }
  return trimmed.split(",").map(parseScalar).filter(Boolean);
}

function parseMarkdownMetadata(text: string, fallbackTitle: string): {
  title: string;
  explicitContentId?: string;
  topicKey?: string;
  sourceIds: string[];
} {
  const frontmatter = text.startsWith("---\n") ? text.slice(4, text.indexOf("\n---", 4) === -1 ? 4 : text.indexOf("\n---", 4)) : "";
  const values = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = parseScalar(values.get("title") ?? heading ?? fallbackTitle);
  const explicitContentId = values.get("contentId") ?? values.get("content_id");
  const topicKey = values.get("topicKey") ?? values.get("topic_key");
  const sourceIds = parseSourceIds(values.get("sourceIds") ?? values.get("source_ids") ?? "");
  return {
    title,
    sourceIds,
    ...(explicitContentId === undefined ? {} : { explicitContentId: parseScalar(explicitContentId) }),
    ...(topicKey === undefined ? {} : { topicKey: parseScalar(topicKey) }),
  };
}

async function readPrefix(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(bytes);
    const result = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export function sourceRecordId(rootId: string, relativePath: string): string {
  return `src:${createHash("sha256").update(`${rootId}\u0000${relativePath}`).digest("hex").slice(0, 24)}`;
}

async function scanFile(
  root: ScanRoot,
  relativePath: string,
  options: ScanOptions,
): Promise<{ source?: SourceRecord; issue?: ScanIssue }> {
  const resolved = await resolveReadablePath(root, relativePath);
  if (!resolved.ok || resolved.value.kind !== "file") {
    return { issue: { rootId: root.id, relativePath, code: "path_rejected", safeMessage: "candidate path is outside the readable root or unavailable" } };
  }
  try {
    const info = await stat(resolved.value.absolutePath, { bigint: true });
    options.observe?.({ rootId: root.id, relativePath, operation: "metadata_read" });
    const name = basename(relativePath);
    const extension = extname(name).toLowerCase();
    const base = {
      recordId: sourceRecordId(root.id, relativePath),
      rootId: root.id,
      relativePath,
      title: name.replace(extname(name), ""),
      sourceIds: [] as string[],
    };
    if (ASSET_EXTENSIONS.has(extension)) {
      return {
        source: {
          ...base,
          digest: hash(`${info.size}:${info.mtimeNs}:${info.ino}`),
          recordKind: "asset",
          mediaType: extension.slice(1),
        },
      };
    }
    if (info.size > BigInt(options.maxFileBytes)) {
      return { issue: { rootId: root.id, relativePath, code: "file_too_large", safeMessage: "text candidate exceeds the configured metadata limit" } };
    }
    const bytes = await readPrefix(resolved.value.absolutePath, Number(info.size));
    options.observe?.({ rootId: root.id, relativePath, operation: "content_read" });
    const text = new TextDecoder().decode(bytes);
    const digest = hash(bytes);
    if (name.toLowerCase().endsWith(".local-wechat-draft.json") || name.toLowerCase() === "wechat-document.json") {
      try {
        const document = decodeWechatDocument(JSON.parse(text) as unknown);
        const articleId = document.metadata.articleId;
        return { source: {
          ...base, digest, title: document.metadata.title, recordKind: "wechat_manifest",
          articleId, channel: "wechat", sourceIds: [`wechat:${articleId.toLowerCase()}`],
          topicKey: `wechat:${articleId.toLowerCase()}`,
          contentPath: posix.join(posix.dirname(relativePath), document.contentFile),
          ...(document.previewFile === undefined ? {} : { previewPath: posix.join(posix.dirname(relativePath), document.previewFile) }),
        } };
      } catch {
        return { issue: { rootId: root.id, relativePath, code: "manifest_invalid", safeMessage: "WeChat document metadata is invalid or unsupported" } };
      }
    }
    if (name.toLowerCase() === "content.json") {
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        return { issue: { rootId: root.id, relativePath, code: "manifest_invalid", safeMessage: "content manifest is not valid JSON" } };
      }
      const manifest = decodeContentManifest(json);
      if (!manifest.ok) return { issue: { rootId: root.id, relativePath, code: "manifest_invalid", safeMessage: manifest.error.safeMessage } };
      return {
        source: {
          ...base,
          digest,
          title: manifest.value.title,
          explicitContentId: manifest.value.contentId,
          sourceIds: manifest.value.sourceIds,
          ...(manifest.value.topicKey === undefined ? {} : { topicKey: manifest.value.topicKey }),
          ...(manifest.value.canonicalDraft === undefined ? {} : { canonicalArtifactKey: `${root.id}:${posix.join(posix.dirname(relativePath), manifest.value.canonicalDraft)}` }),
          recordKind: "manifest",
        },
      };
    }
    if (TEXT_EXTENSIONS.has(extension)) {
      return { source: { ...base, ...parseMarkdownMetadata(text, base.title), digest, recordKind: "markdown" } };
    }
    return { source: { ...base, digest, recordKind: "ledger" } };
  } catch {
    return { issue: { rootId: root.id, relativePath, code: "file_unreadable", safeMessage: "candidate metadata could not be read" } };
  }
}

async function walkRoot(root: ScanRoot): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const exclusions = [...DEFAULT_EXCLUDES, ...root.exclude];
      if (matches(relativePath, exclusions) || (entry.isDirectory() && matches(`${relativePath}/`, exclusions))) continue;
      if (entry.isDirectory()) {
        await visit(resolve(directory, entry.name), relativePath);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isSupported(relativePath)) {
        if (root.include.length === 0 || matches(relativePath, root.include)) output.push(relativePath);
      }
    }
  };
  await visit(root.realPath, "");
  return output;
}

export async function scanRoots(roots: readonly ScanRoot[], options: ScanOptions): Promise<ScanResult> {
  const sources: SourceRecord[] = [];
  const issues: ScanIssue[] = [];
  const successfulRootIds: string[] = [];
  for (const root of [...roots].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!root.enabled) continue;
    try {
      const candidates = await walkRoot(root);
      for (const relativePath of candidates) {
        const result = await scanFile(root, relativePath, options);
        if (result.source !== undefined) sources.push(result.source);
        if (result.issue !== undefined) issues.push(result.issue);
      }
      successfulRootIds.push(root.id);
    } catch {
      issues.push({ rootId: root.id, relativePath: "", code: "root_unavailable", safeMessage: "readable root could not be scanned" });
    }
  }
  sources.sort((left, right) => left.recordId.localeCompare(right.recordId));
  return {
    sources,
    issues,
    successfulRootIds,
    fingerprint: hash(sources.map(({ recordId: id, digest }) => `${id}:${digest}`).join("\n")),
  };
}

#!/usr/bin/env node
/**
 * Audit the Git index or a committed tree before publishing this repository.
 * This is a deterministic public-source filter, not a complete secret scanner.
 * It reads Git blobs only and never inspects the working tree.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ path: string, data: Uint8Array|string, mode?: string, type?: string }} SourceBlob */
/** @typedef {{ path: string, line: number, rule: string }} PublicSourceFinding */

export const PUBLIC_SOURCE_RULES = Object.freeze({
  UNSAFE_PATH: "UNSAFE_PATH",
  PRIVATE_DOC_PATH: "PRIVATE_DOC_PATH",
  PRIVATE_FILE_PATH: "PRIVATE_FILE_PATH",
  PRIVATE_RUNTIME_PATH: "PRIVATE_RUNTIME_PATH",
  BINARY_MATERIAL: "BINARY_MATERIAL",
  SPECIAL_GIT_ENTRY: "SPECIAL_GIT_ENTRY",
  MACHINE_ABSOLUTE_PATH: "MACHINE_ABSOLUTE_PATH",
  TEXT_SECRET: "TEXT_SECRET",
  PEM_PRIVATE_KEY: "PEM_PRIVATE_KEY",
  GIT_READ: "GIT_READ",
  CLI_ARGUMENTS: "CLI_ARGUMENTS",
});

/**
 * Keep this list intentionally small. A new public document must be reviewed
 * and added explicitly instead of becoming public because it happens to be
 * beneath docs/.
 */
export const PUBLIC_DOC_PATHS = Object.freeze(new Set([
  "docs/adapter-contract.md",
  "docs/ai-assisted-workflow.md",
  "docs/formula-typesetting.md",
  "docs/pdf-asset-cropping.md",
  "docs/ptc-workflows.md",
  "docs/workflow-lessons.md",
  "docs/third-party/wechat-collector-MIT.txt",
]));

const PRIVATE_FILE_PARTS = /^(?:\.env(?:\.(?!example(?:$|\.))[A-Za-z0-9._-]+)?|credentials(?:[._-][A-Za-z0-9._-]+)?|cookies?(?:[._-][A-Za-z0-9._-]+)?)$/iu;
const PRIVATE_SUFFIXES = /\.(?:local\.(?:json|toml|yaml|yml)|log|trace|sqlite3?|db|bak|swp|swo)$/iu;
const BINARY_SUFFIXES = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|pdf|mp4|mov|webm|avi|mkv|mp3|wav|flac|ogg|zip|tar|tgz|gz|bz2|xz|7z|rar|dmg|exe|dll|so|dylib|node|wasm|class|jar|bin|model|weights?|safetensors|gguf|onnx|pt|pth|ckpt|pkl|pickle|npz|npy|pyc|pyo|pyd)$/iu;
const PRIVATE_DIRECTORY_PARTS = new Set([
  ".data",
  ".venv",
  "__pycache__",
  "artifacts",
  "coverage",
  "models",
  "checkpoints",
  "weights",
  "runs",
  "screenshots",
  "uploads",
  "node_modules",
]);

const MACHINE_ROOTS = Object.freeze([
  "Users",
  "Volumes",
  "private",
  "home",
  "root",
  "tmp",
  "etc",
  "var/folders",
]);
const MACHINE_ROOT_PATTERN = MACHINE_ROOTS.map((root) => root.replace("/", "\\/"));
const MACHINE_ABSOLUTE_PATH = new RegExp(
  `(?:^|[^A-Za-z0-9_])/(?:${MACHINE_ROOT_PATTERN.join("|")})/[^\\s"'\x60<>()[\\]{};,]+`,
  "giu",
);
const WINDOWS_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`<>()[\]{};,]+/gu;

const SECRET_KEY_PARTS = Object.freeze([
  "api[_-]?key",
  "access[_-]?token",
  "refresh[_-]?token",
  "client[_-]?secret",
  "xsec[_-]?token",
  "authorization",
  "cookie",
  "password",
  "private[_-]?key",
  "token",
]);
const SECRET_KEY_PATTERN = `(?:${SECRET_KEY_PARTS.join("|")})`;
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  `\\b${SECRET_KEY_PATTERN}\\b\\s*[:=]\\s*(["'\x60])([^\\r\\n]*?)\\1`,
  "giu",
);
const BARE_SECRET_ASSIGNMENT = new RegExp(
  `\\b${SECRET_KEY_PATTERN}\\b\\s*[:=]\\s*([A-Za-z0-9_+\\/-]{4,})`,
  "giu",
);
const AUTH_QUERY_PARAMETER = new RegExp(
  `[?&]${SECRET_KEY_PATTERN}\\s*=\\s*([A-Za-z0-9._~+%/=\\-]+)`,
  "giu",
);
const AUTH_HEADER = new RegExp(
  `\\bauthorization\\b\\s*[:=]\\s*(?:["'\x60])?bearer\\s+([A-Za-z0-9._~+\\/=\\-]{4,})`,
  "giu",
);
const PEM_PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;

const SYNTHETIC_SECRET_VALUE = /^(?:(?:synthetic|private|fixture|secret|test|dummy|fake|hidden|invalid|sensitive|unexpected[_-]?return|never[_-]?persist|never[_-]?refresh|not[-_ ]?returned)(?:[-_][A-Za-z0-9_-]+)*|[A-Za-z0-9]+[_-]synthetic(?:[-_][A-Za-z0-9_-]+)*|one|two|abc%26tab%3Dfav)$/iu;
const TEST_SAFE_USER = "(?:private|test|fixture|example)";
const TEST_SAFE_PATH_PART = "[A-Za-z0-9._-]+";
const REGEX_BACKSLASH = String.fromCharCode(92).repeat(2);
const TEST_PATH_SEPARATOR = `[${REGEX_BACKSLASH}/]{1,2}`;
const SYNTHETIC_TEST_PATH = new RegExp(
  `(?:/(?:Users)/${TEST_SAFE_USER}(?:/|$)|/(?:private|tmp|home|root)/${TEST_SAFE_PATH_PART}(?:${TEST_PATH_SEPARATOR}|$)|/etc/(?:passwd|hosts)(?:${TEST_PATH_SEPARATOR}|$)|[A-Za-z]:${TEST_PATH_SEPARATOR}(?:private|test|fixture|example)${TEST_PATH_SEPARATOR}${TEST_SAFE_PATH_PART}|[A-Za-z]:${TEST_PATH_SEPARATOR}(?:figure\\.png|device))`,
  "iu",
);
const CODE_IDENTIFIER_VALUE = new Set([
  "authorization",
  "boolean",
  "cookies",
  "cookie",
  "data",
  "env",
  "htmltoken",
  "marker",
  "null",
  "number",
  "object",
  "payload",
  "record",
  "secret",
  "string",
  "token",
  "undefined",
  "unknown",
  "url",
  "value",
]);

function normalizedPath(value) {
  return value.replaceAll("\\", "/");
}

function isTestPath(path) {
  return normalizedPath(path).startsWith("tests/");
}

function syntheticTestLine(path, line, matchedPath, matchedValue) {
  if (!isTestPath(path)) return false;
  if (matchedPath !== undefined && SYNTHETIC_TEST_PATH.test(matchedPath)) return true;
  if (matchedValue !== undefined && (SYNTHETIC_SECRET_VALUE.test(matchedValue) || /^invalid\\[nrt]secret$/u.test(matchedValue))) return true;
  return false;
}

function addFinding(findings, path, line, rule) {
  const finding = { path, line: Math.max(1, line), rule };
  if (!findings.some((item) => item.path === finding.path && item.line === finding.line && item.rule === finding.rule)) {
    findings.push(finding);
  }
}

function pathFindings(path) {
  const findings = [];
  const normalized = normalizedPath(path);
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";

  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || parts.includes("..") || /[\r\n\t]/u.test(normalized)) {
    addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.UNSAFE_PATH);
  }

  if (normalized.startsWith("docs/") && !PUBLIC_DOC_PATHS.has(normalized)) {
    addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.PRIVATE_DOC_PATH);
  }

  for (const part of parts) {
    if (PRIVATE_DIRECTORY_PARTS.has(part.toLowerCase())) {
      addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.PRIVATE_RUNTIME_PATH);
      break;
    }
  }

  if (PRIVATE_FILE_PARTS.test(basename) && basename !== ".env.example") {
    addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.PRIVATE_FILE_PATH);
  }
  if (PRIVATE_SUFFIXES.test(basename)) {
    addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.PRIVATE_FILE_PATH);
  }
  if (BINARY_SUFFIXES.test(basename)) {
    addFinding(findings, path, 1, PUBLIC_SOURCE_RULES.BINARY_MATERIAL);
  }
  return findings;
}

function looksBinary(data) {
  for (const byte of data) {
    if (byte === 0 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte < 0x20)) return true;
  }
  return false;
}

function decodeBlob(data) {
  if (typeof data === "string") return data;
  if (looksBinary(data)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function likelyLiteral(value, key) {
  const trimmed = value.trim();
  if (!trimmed || !/^[\x21-\x7e]+$/u.test(trimmed) || /[\s${}]/u.test(trimmed)) return false;
  if (key.toLowerCase() === "token" && trimmed.length < 8) return false;
  return trimmed.length >= 8 || key.toLowerCase() !== "token";
}

function scanTextLine(path, line, lineNumber, findings) {
  MACHINE_ABSOLUTE_PATH.lastIndex = 0;
  WINDOWS_ABSOLUTE_PATH.lastIndex = 0;
  for (const pattern of [MACHINE_ABSOLUTE_PATH, WINDOWS_ABSOLUTE_PATH]) {
    for (const match of line.matchAll(pattern)) {
      const matchedPath = match[0];
      if (!syntheticTestLine(path, line, matchedPath)) addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.MACHINE_ABSOLUTE_PATH);
    }
  }

  PEM_PRIVATE_KEY.lastIndex = 0;
  if (PEM_PRIVATE_KEY.test(line) && !syntheticTestLine(path, line)) {
    addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.PEM_PRIVATE_KEY);
  }

  AUTH_QUERY_PARAMETER.lastIndex = 0;
  for (const match of line.matchAll(AUTH_QUERY_PARAMETER)) {
    const value = match[1] ?? "";
    if (!value.includes("$") && !value.includes("{")) {
      if (!syntheticTestLine(path, line, undefined, value)) addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.TEXT_SECRET);
    }
  }

  AUTH_HEADER.lastIndex = 0;
  for (const match of line.matchAll(AUTH_HEADER)) {
    const value = match[1] ?? "";
    if (!syntheticTestLine(path, line, undefined, value)) addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.TEXT_SECRET);
  }

  QUOTED_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of line.matchAll(QUOTED_SECRET_ASSIGNMENT)) {
    const full = match[0] ?? "";
    const keyMatch = full.match(new RegExp(`^\\s*${SECRET_KEY_PATTERN}`, "iu"));
    const key = keyMatch?.[0]?.trim().toLowerCase() ?? "token";
    const value = match[2] ?? "";
    if (likelyLiteral(value, key) && !syntheticTestLine(path, line, undefined, value)) {
      addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.TEXT_SECRET);
    }
  }

  BARE_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of line.matchAll(BARE_SECRET_ASSIGNMENT)) {
    const value = match[1] ?? "";
    const key = (match[0] ?? "").split(/[:=]/u, 1)[0]?.trim().toLowerCase() ?? "token";
    if (CODE_IDENTIFIER_VALUE.has(value.toLowerCase())) continue;
    const end = (match.index ?? 0) + (match[0]?.length ?? 0);
    const next = line[end] ?? "";
    if (value.includes(".") || value.includes("$") || value.includes("{") || /[.[({!?]/u.test(next)) continue;
    if (/^_[A-Za-z0-9_]+$/u.test(value)) continue;
    if (key === "token" && value.length < 8) continue;
    if (/^[A-Z]/u.test(value) && next !== "" && !/[#?&]/u.test(next)) continue;
    if (value.length >= 4 && !syntheticTestLine(path, line, undefined, value)) {
      addFinding(findings, path, lineNumber, PUBLIC_SOURCE_RULES.TEXT_SECRET);
    }
  }
}

/** Scan one repository-relative Git path and its UTF-8 blob. */
export function scanBlob(blob) {
  const findings = pathFindings(blob.path);
  if (blob.type !== undefined && blob.type !== "blob") {
    addFinding(findings, blob.path, 1, PUBLIC_SOURCE_RULES.SPECIAL_GIT_ENTRY);
    return findings;
  }
  if (blob.mode !== undefined && !["100644", "100755"].includes(blob.mode)) {
    addFinding(findings, blob.path, 1, PUBLIC_SOURCE_RULES.SPECIAL_GIT_ENTRY);
  }
  const data = typeof blob.data === "string" ? new TextEncoder().encode(blob.data) : blob.data;
  if (BINARY_SUFFIXES.test(blob.path) || looksBinary(data)) {
    addFinding(findings, blob.path, 1, PUBLIC_SOURCE_RULES.BINARY_MATERIAL);
    return findings;
  }
  const text = decodeBlob(data);
  if (text === null) {
    addFinding(findings, blob.path, 1, PUBLIC_SOURCE_RULES.BINARY_MATERIAL);
    return findings;
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) scanTextLine(blob.path, lines[index] ?? "", index + 1, findings);
  return findings;
}

/** Scan synthetic or externally supplied blobs without touching the filesystem. */
export function scanBlobs(blobs) {
  return blobs.flatMap((blob) => scanBlob(blob)).sort(compareFindings);
}

function compareFindings(left, right) {
  return left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule);
}

function parseGitListing(raw, ref) {
  const entries = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const header = record.slice(0, tab);
    const path = record.slice(tab + 1);
    if (ref) {
      const [mode = "", type = "", object = ""] = header.split(" ");
      entries.push({ path, mode, type, object });
    } else {
      const [mode = "", object = "", stage = ""] = header.split(" ");
      entries.push({ path, mode, type: "blob", object, stage });
    }
  }
  return entries;
}

function safeGitOutput(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Read only Git blobs from the index, or from a tree-ish when ref is given. */
export function readGitBlobs({ cwd = process.cwd(), ref } = {}) {
  if (ref !== undefined && (!ref || ref.startsWith("-") || ref.includes("\0"))) throw new Error("invalid ref");
  const listing = ref === undefined
    ? safeGitOutput(cwd, ["ls-files", "--stage", "-z"])
    : safeGitOutput(cwd, ["ls-tree", "-r", "-z", "--full-tree", ref]);
  const entries = parseGitListing(listing, ref);
  return entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    type: entry.type,
    data: entry.type === "blob" ? safeGitOutput(cwd, ["cat-file", "blob", entry.object]) : new Uint8Array(),
  }));
}

/** Audit Git's index by default, or a committed tree with { ref: "HEAD" }. */
export function scanGitRepository(options = {}) {
  return scanBlobs(readGitBlobs(options));
}

function displayPath(path) {
  return [...path].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
    return character;
  }).join("");
}

/** Format diagnostics without including blob contents or regex matches. */
export function formatFinding(finding) {
  return `${displayPath(finding.path)}:${finding.line}:${finding.rule}`;
}

export function formatFindings(findings) {
  return findings.slice().sort(compareFindings).map(formatFinding).join("\n");
}

function parseCli(argv) {
  let ref;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--ref") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) return { error: true };
      ref = next;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--ref=")) {
      ref = argument.slice("--ref=".length);
      continue;
    }
    return { error: true };
  }
  return { ref };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    process.stdout.write("Usage: check-public-source.mjs [--ref=<tree-ish>]\nAudits Git blobs only; this is not a complete secret audit.\n");
    return 0;
  }
  if (parsed.error || (parsed.ref !== undefined && (!parsed.ref || parsed.ref.startsWith("-")))) {
    process.stderr.write(`<cli>:1:${PUBLIC_SOURCE_RULES.CLI_ARGUMENTS}\n`);
    return 2;
  }
  try {
    const findings = scanGitRepository({ ref: parsed.ref });
    if (findings.length > 0) {
      process.stderr.write(`${formatFindings(findings)}\n`);
      return 1;
    }
    process.stdout.write("PASS\n");
    return 0;
  } catch {
    process.stderr.write(`<git>:1:${PUBLIC_SOURCE_RULES.GIT_READ}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(resolve(invokedPath))).href) {
  process.exitCode = main();
}

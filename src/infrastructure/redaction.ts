export interface RedactionOptions {
  secretValues?: readonly string[];
  privatePaths?: readonly string[];
  maxLength?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceKnownValues(input: string, values: readonly string[], replacement: string): string {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length)
    .reduce((text, value) => text.replace(new RegExp(escapeRegExp(value), "gu"), replacement), input);
}

export function redactText(input: string, options: RedactionOptions = {}): string {
  let output = replaceKnownValues(input, options.secretValues ?? [], "[REDACTED_SECRET]");
  output = replaceKnownValues(output, options.privatePaths ?? [], "[REDACTED_PATH]");
  output = output
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, "$1[REDACTED_SECRET]")
    .replace(/\b(cookie\s*[:=]\s*)[^\r\n]+/giu, "$1[REDACTED_SECRET]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*(["']?)[^\s,"';]+\2/giu, "$1=[REDACTED_SECRET]")
    // Only an absolute-path boundary qualifies. Deep HTTPS URLs and relative
    // artifact references are data, not machine paths.
    .replace(/(?<![\p{L}\p{N}._:\/-])(?:\/[A-Za-z0-9._ -]+){3,}/gu, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\){2,}[^\\\r\n]*/gu, "[REDACTED_PATH]");

  const maximum = Math.max(0, options.maxLength ?? 4_096);
  if (output.length <= maximum) return output;
  return `${output.slice(0, maximum)}[TRUNCATED]`;
}

export function safeErrorSummary(error: unknown, options: RedactionOptions = {}): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "operation failed";
  return redactText(message, { ...options, maxLength: options.maxLength ?? 1_024 });
}

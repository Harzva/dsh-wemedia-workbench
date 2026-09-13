export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function safeRelativeFile(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value !== value.normalize("NFC")) return false;
  if (/[\u0000-\u001f\u007f\\:]/u.test(value) || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part));
}

import type { JsonValue } from "./json.ts";

export const DOMAIN_ERROR_CODES = [
  "SCHEMA_INVALID_TYPE",
  "SCHEMA_MISSING_FIELD",
  "SCHEMA_INVALID_VALUE",
  "SCHEMA_VERSION_UNSUPPORTED",
  "UUID_V4_INVALID",
  "CONTENT_REF_INVALID",
  "IDENTITY_CONFLICT",
  "STATE_TRANSITION_INVALID",
  "STATE_RESUME_UNAVAILABLE",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  safeMessage: string;
  path?: string;
  details?: JsonValue;
}

export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export function success<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function failure(
  code: DomainErrorCode,
  safeMessage: string,
  options: { path?: string; details?: JsonValue } = {},
): DomainResult<never> {
  return {
    ok: false,
    error: {
      code,
      safeMessage,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

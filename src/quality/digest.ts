import { fnv1a64 } from "../domain/identity.ts";
import { canonicalJson } from "../domain/json.ts";
import type { JsonValue } from "../domain/json.ts";

export function qualityDigest(value: JsonValue): string {
  return fnv1a64(canonicalJson(value));
}

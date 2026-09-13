import { failure, success } from "./errors.ts";
import type { DomainResult } from "./errors.ts";

export const CHANNELS = ["wechat", "zhihu", "xiaohongshu", "x"] as const;
export type Channel = (typeof CHANNELS)[number];

export type ContentRef = `wmc:${string}`;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function formatContentRef(uuid: string): DomainResult<ContentRef> {
  if (!isUuidV4(uuid)) {
    return failure("UUID_V4_INVALID", "content ID must be a UUIDv4");
  }
  return success(`wmc:${uuid.toLowerCase()}` as ContentRef);
}

export function parseContentRef(value: string): DomainResult<string> {
  if (!value.startsWith("wmc:")) {
    return failure("CONTENT_REF_INVALID", "content reference must use the wmc scheme");
  }
  const uuid = value.slice(4);
  if (!isUuidV4(uuid)) {
    return failure("CONTENT_REF_INVALID", "content reference must contain a UUIDv4");
  }
  return success(uuid.toLowerCase());
}

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

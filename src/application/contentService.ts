import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import { fnv1a64 } from "../domain/identity.ts";
import { canonicalJson } from "../domain/json.ts";
import type { Channel, ContentRef } from "../domain/primitives.ts";
import type { OverallState } from "../domain/state.ts";
import type { ProjectedContent } from "./projectionService.ts";

export interface ContentSearchFilter {
  query?: string;
  rootId?: string;
  channel?: Channel;
  overallState?: OverallState;
}

export interface ContentSummary {
  contentRef: ContentRef;
  title: string;
  overallState: OverallState;
  channels: Channel[];
  rootIds: string[];
}

export interface ContentPage {
  items: ContentSummary[];
  nextCursor?: string;
  total: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function queryDigest(filter: ContentSearchFilter): string {
  return fnv1a64(canonicalJson({
    ...(filter.query === undefined ? {} : { query: normalize(filter.query) }),
    ...(filter.rootId === undefined ? {} : { rootId: filter.rootId }),
    ...(filter.channel === undefined ? {} : { channel: filter.channel }),
    ...(filter.overallState === undefined ? {} : { overallState: filter.overallState }),
  }));
}

function decodeCursor(cursor: string | undefined, digest: string): DomainResult<number> {
  if (cursor === undefined) return success(0);
  const match = /^v1\|(\d+)\|([0-9a-f]{16})$/.exec(cursor);
  if (match === null || `fnv1a64:${match[2]}` !== digest) return failure("SCHEMA_INVALID_VALUE", "search cursor does not match the current query");
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? success(offset) : failure("SCHEMA_INVALID_VALUE", "search cursor is invalid");
}

export class ContentService {
  constructor(private readonly contents: () => readonly ProjectedContent[]) {}

  search(filter: ContentSearchFilter, pageSize = 50, cursor?: string): DomainResult<ContentPage> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return failure("SCHEMA_INVALID_VALUE", "page size must be between 1 and 100");
    const digest = queryDigest(filter);
    const decodedCursor = decodeCursor(cursor, digest);
    if (!decodedCursor.ok) return decodedCursor;
    const query = normalize(filter.query ?? "");
    const matching = [...this.contents()]
      .filter((content) => query === "" || normalize([content.title, ...content.aliases, content.topicKey ?? "", ...content.sourceIds].join(" ")).includes(query))
      .filter((content) => filter.rootId === undefined || content.artifacts.some(({ rootId }) => rootId === filter.rootId))
      .filter((content) => filter.channel === undefined || content.channels[filter.channel].state !== "not_started")
      .filter((content) => filter.overallState === undefined || content.overallState === filter.overallState)
      .sort((left, right) => `${normalize(left.title)}:${left.contentRef}`.localeCompare(`${normalize(right.title)}:${right.contentRef}`));
    const end = Math.min(decodedCursor.value + pageSize, matching.length);
    const items = matching.slice(decodedCursor.value, end).map((content) => ({
      contentRef: content.contentRef,
      title: content.title,
      overallState: content.overallState,
      channels: (Object.keys(content.channels) as Channel[]).filter((channel) => content.channels[channel].state !== "not_started"),
      rootIds: [...new Set(content.artifacts.map(({ rootId }) => rootId))].sort(),
    }));
    return success({
      items,
      total: matching.length,
      ...(end < matching.length ? { nextCursor: `v1|${end}|${digest.slice("fnv1a64:".length)}` } : {}),
    });
  }

  inspect(contentRef: ContentRef): DomainResult<ProjectedContent | null> {
    return success(this.contents().find((content) => content.contentRef === contentRef) ?? null);
  }
}

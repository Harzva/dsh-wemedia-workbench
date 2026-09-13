import type { ContentRef } from "../domain/primitives.ts";
import type { MediaPublicationType, PublicationDraft, PublicationEdit, PublicationMediaInput } from "../domain/publicationDraft.ts";
import type { LibraryMediaChunk } from "../domain/contentLibrary.ts";

/** Private plan stores identities and hashes, never whole media buffers. */
export interface PublicationPlan {
  contentRef: ContentRef;
  publicationType: MediaPublicationType;
  expectedRevision: string | null;
  edit: PublicationEdit;
  inputDigest: string;
  publication: PublicationDraft;
}
export interface PublicationDrafts {
  channelDocument?(contentRef: ContentRef, signal: AbortSignal): Promise<import("./channelPublishing.ts").ChannelDocument>;
  list(): Promise<PublicationDraft[]>;
  read(contentRef: ContentRef): Promise<PublicationDraft>;
  plan(contentRef: ContentRef, publicationType: MediaPublicationType, expectedRevision: string | null, edit: PublicationEdit, signal: AbortSignal): Promise<PublicationPlan>;
  commit(plan: PublicationPlan, signal: AbortSignal, assertCurrent: () => void): Promise<PublicationDraft>;
  media(input: PublicationMediaInput, signal: AbortSignal): Promise<LibraryMediaChunk>;
}

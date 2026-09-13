import type { ArtifactRef } from "./content.ts";
import type { ContentRef } from "./primitives.ts";
import type { PublishingType } from "./channelPublishing.ts";
import type { ArticleDocument } from "./workbench.ts";
import { canonicalJson } from "./json.ts";

/** Internal publication payload; host adapters resolve the artifact references. */
export interface ChannelDocument {
  contentRef: ContentRef; publicationType: PublishingType; revisionDigest: string;
  title: string; body: string; html: string; coverSource: string | null;
  assets: Array<{ source: string; artifact: ArtifactRef; digest: string; mediaType: string; bytes: number }>;
}

export function articleChannelDocument(d: Pick<ArticleDocument, "contentRef" | "metadata" | "markdown" | "paragraphs" | "html" | "revisionDigest" | "assets">): ChannelDocument {
  return { contentRef: d.contentRef, publicationType: "article", title: d.metadata.title, body: d.markdown.trim() || d.paragraphs?.join("\n\n") || d.html.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " "), html: d.html, revisionDigest: d.revisionDigest, assets: d.assets.map(a => ({ source: a.source, artifact: a.artifact, digest: a.digest, mediaType: a.mediaType, bytes: a.bytes })), coverSource: d.assets[0]?.source ?? null };
}

/** Keep complete text and asset bindings separate from legacy article revision hashes. */
export function channelDocumentPayload(d: ChannelDocument): string {
  return canonicalJson({ contentRef: d.contentRef, publicationType: d.publicationType, revisionDigest: d.revisionDigest, title: d.title, body: d.body, html: d.html, coverSource: d.coverSource,
    assets: d.assets.map(a => ({ source: a.source, artifact: { rootId: a.artifact.rootId, relativePath: a.artifact.relativePath }, digest: a.digest, mediaType: a.mediaType, bytes: a.bytes })) });
}

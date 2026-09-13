import { REVIEW_KINDS } from "./workbench.ts";
import type { ArticleDocument, WorkbenchContentSummary } from "./workbench.ts";

/** Current article evidence determines workflow state independently of list pagination. */
export function articleWorkflowStatus(document: Pick<ArticleDocument, "revisionDigest" | "targets" | "reviews">): WorkbenchContentSummary["status"] {
  if (document.targets.some(target => target.verifiedRevision === document.revisionDigest)) return "draft_verified";
  if (document.targets.length) return "needs_revalidation";
  const ready = REVIEW_KINDS.every(kind => document.reviews.some(review => review.kind === kind && review.valid && review.revisionDigest === document.revisionDigest && (kind === "mobile_visual" || review.coverage?.complete)));
  return ready ? "ready" : document.reviews.length ? "needs_review" : "drafting";
}

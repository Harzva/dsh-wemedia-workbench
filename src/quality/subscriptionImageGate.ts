import type { GateFinding, QualityGate } from "./types.ts";

export const subscriptionImageGate: QualityGate = {
  gateId: "subscription-images",
  version: "1",
  selectInput: (input) => ({ subscription: input.subscription ?? null, artifacts: input.artifacts.filter(({ kind }) => kind === "original" || kind === "generated").sort((left, right) => `${left.rootId}:${left.relativePath}`.localeCompare(`${right.rootId}:${right.relativePath}`)) }),
  evaluate(input) {
    const subscription = input.subscription;
    if (subscription === undefined || !subscription.enabled) {
      return [{ status: "pass", code: "SUBSCRIPTION_IMAGE_NOT_APPLICABLE", safeMessage: "subscription image checks are not applicable", evidenceRefs: [] }];
    }
    const images = input.artifacts.filter(({ kind }) => kind === "original" || kind === "generated");
    const findings: GateFinding[] = [];
    if (images.length === 0) findings.push({ status: "block", code: "SUBSCRIPTION_IMAGE_MISSING", safeMessage: "subscription content requires at least one image", evidenceRefs: ["images"] });
    if (subscription.sourceSectionLine !== undefined && images.some(({ line }) => line !== undefined && line > subscription.sourceSectionLine!)) {
      findings.push({ status: "block", code: "SUBSCRIPTION_IMAGE_AFTER_SOURCE", safeMessage: "an image appears after the source section", evidenceRefs: ["source-section"] });
    }
    if ((subscription.tailImageCount ?? 0) >= 3) findings.push({ status: "warn", code: "SUBSCRIPTION_IMAGE_END_PILE", safeMessage: "multiple images are clustered at the end", evidenceRefs: ["article-tail"] });
    if (subscription.originalsAvailable && subscription.originalsDisposition !== "used" && subscription.originalsDisposition !== "discarded_with_reason") {
      findings.push({ status: "block", code: "SUBSCRIPTION_ORIGINALS_UNRESOLVED", safeMessage: "available original images require use or a discard reason", evidenceRefs: ["originals"] });
    }
    if (subscription.generatedOverflowCheck !== "pass") findings.push({ status: "block", code: "GENERATED_IMAGE_OVERFLOW_UNVERIFIED", safeMessage: "generated image overflow must pass review", evidenceRefs: ["generated-overflow"] });
    if (subscription.generatedVisualReview !== "pass") findings.push({ status: "block", code: "GENERATED_IMAGE_VISUAL_UNVERIFIED", safeMessage: "generated images require visual review", evidenceRefs: ["generated-visual"] });
    return findings.length === 0 ? [{ status: "pass", code: "SUBSCRIPTION_IMAGE_OK", safeMessage: "subscription image checks passed", evidenceRefs: [] }] : findings;
  },
};

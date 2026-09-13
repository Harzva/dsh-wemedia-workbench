import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { WorkbenchService } from "../../src/application/workbenchService.ts";
import type { ActionPreview, WorkbenchAnswer, WorkbenchJob } from "../../src/domain/workbench.ts";
import type { ContentRef } from "../../src/domain/primitives.ts";
import { normalizeRelativePath } from "../../src/infrastructure/pathPolicy.ts";
import { sha256 } from "../../src/infrastructure/workbenchDocuments.ts";
import { createDefaultQualityRegistry } from "../../src/quality/registry.ts";
import { fixture } from "./fixture.ts";

const agent = { kind: "agent" as const, sessionId: "intent-corpus-session", callId: "intent-corpus-call" };

function value<T>(answer: WorkbenchAnswer): T {
  if (!answer.ok) throw new Error(answer.error.code);
  return answer.value as T;
}

async function qualityService(f: Awaited<ReturnType<typeof fixture>>) {
  const service = new WorkbenchService({
    documents: f.documents,
    jobs: f.jobs,
    adapter: f.adapter,
    approvals: f.approvals,
    clock: { nowIso: f.now, monotonicMs: () => Date.parse(f.now()) },
    ids: { uuidV4: randomUUID, opaqueId: prefix => `${prefix}:${randomUUID()}` },
    hasher: { digest: sha256 },
    quality: createDefaultQualityRegistry(path => normalizeRelativePath(path).ok),
  });
  await service.initialize();
  return service;
}

async function rename(f: Awaited<ReturnType<typeof fixture>>, contentRef: ContentRef, title: string) {
  const current = await f.documents.read(contentRef);
  return f.documents.saveRevision(contentRef, current.revisionDigest, {
    metadata: { ...current.metadata, title },
    html: current.html,
    markdown: current.markdown,
  }, current.assets);
}

it("blocks approval when an unrelated article title changes and never calls remote", async () => {
  const f = await fixture();
  const service = await qualityService(f);
  try {
    const unrelated = await f.create();
    await rename(f, unrelated.contentRef, "Unrelated baseline");
    const target = await f.create();
    await f.reviewAll(target);
    f.setAfterApproval(async () => { await rename(f, unrelated.contentRef, "Unrelated changed"); });

    const preview = value<ActionPreview>(await service.request({ operation: "preview_action", contentRef: target.contentRef, action: "create_draft" }, agent));
    const answer = await service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent);

    expect(answer).toMatchObject({ ok: false, error: { code: "INTENT_CHANGED" } });
    expect(f.remoteCalls()).toBe(0);
    expect(await f.jobs.loadAll()).toEqual([expect.objectContaining({ status: "failed", resultCode: "INTENT_CHANGED", inputDigest: preview.intent.inputDigest })]);
  } finally {
    await service.dispose();
    await f.cleanup();
  }
});

it("allows the same approval flow when the quality corpus stays stable", async () => {
  const f = await fixture();
  const service = await qualityService(f);
  try {
    const target = await f.create();
    await f.reviewAll(target);
    const preview = value<ActionPreview>(await service.request({ operation: "preview_action", contentRef: target.contentRef, action: "create_draft" }, agent));
    const job = value<WorkbenchJob>(await service.request({ operation: "start_action", intentId: preview.intent.intentId }, agent));

    expect((await service.settle(job.jobId)).status).toBe("succeeded");
    expect(f.remoteCalls()).toBe(1);
  } finally {
    await service.dispose();
    await f.cleanup();
  }
});

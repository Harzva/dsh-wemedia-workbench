# Batch workflow lessons

These are reusable execution rules, not a delivery record for any private batch.

## Current programmable surface

The workbench exposes 45 native DSH tools and the same typed tools through DSH
PTC. UI RPC and model tools share `WorkbenchService`. There is no standalone
workbench executable or package `bin` entry. Channel adapters use configured,
controlled external bridge processes; those are not a unified workbench CLI.

The formula renderer and PDF crop helper are deterministic local CLI helpers.
A future unified CLI should reuse the service contract, identity, native
approval, revision checks and job reconciliation. It must not introduce a
second state store or bypass the host's policy through direct file writes.

The current batch preflight is read-only and sequential. It does not create
intents, jobs or remote drafts, and it is not a persistent batch writer.
Once local content is frozen, a rolling per-article preflight, native approval,
write and readback can make delivery progress without waiting for an entire
batch check. Hold blocked articles explicitly; do not count them as delivered.

## Completion is a checked state

- A preview creates an intent, not a saved article or remote draft.
- `queued` and `running` are incomplete. Only `waiting_user` means that the
  native approval decision is pending. Follow the same job with bounded waits.
- After a local save, inspect the actual current revision, paragraphs and
  renamed assets before building review evidence.
- For a WeChat draft, require `succeeded`, `WECHAT_DRAFT_VERIFIED` and exactly
  one target whose `verifiedRevision` equals the current `revisionDigest`.
- A failed or uncertain write is not a reason to blindly submit another one.
  Read its result and existing targets first; cancellation is not rollback.
- `INTENT_CHANGED` proves the current binding differs, not why it differs.
  Do not attribute it to another session or a report edit without evidence.

The duplicate gate currently hashes its `existingRecords` input, including
other article titles. That gate digest is part of the intent stamp. An
unrelated article save can therefore invalidate a pending approval even when
the target article and reports are unchanged. Finish the batch's local saves
before its serialized remote-write phase. This scheduling rule preserves the
duplicate guard; it does not imply that every binding failure has this cause.

## Evidence is bound to bytes and revision

A report generator can rewrite several JSON reports at once. Re-registering
facts does not itself invalidate sibling review kinds; changed artifact bytes
can make their old SHA bindings stale. Compare actual files and register every
changed kind. Same path does not mean same artifact.

Use fresh per-article paragraph/source mappings. Review factual claims in
headings as well as prose; do not classify a heading from its tag or isolated
keywords. A structurally valid report is not proof that its sources support
its claims. In particular, distinguish human baselines, model stages, absolute
values, percentage points and relative changes before comparing numbers.

An editorial-keyword hit is not by itself proof of leaked production notes.
Reader-facing result evidence and descriptions of a model's internal
explanations can match overly broad note detectors. Inspect the complete
passage and source before classifying it. A verified false positive can be
resolved by a semantically equivalent wording change through the normal
revision, review and visual-evidence cycle. Keep a regression case for a
future contextual detector; do not weaken a live gate during draft execution.

Each review kind can be completed independently. Overall readiness requires
all four kinds. Check JSON coverage for facts/editorial/images-formulas;
mobile evidence is an actual revision-bound PNG, not a fabricated JSON report.
Verify the actual page width after setting a mobile viewport. Check every
image loaded and inspect the full page before capturing evidence. Small paper
tables need readable explanation; do not claim every original label is legible.

## Crop only when needed

Reuse existing inspected candidates and cached detector output first. A missing
table does not automatically require another model download or a full MinerU
run. Explicit bbox space, actual page geometry, source/output SHA and visual
verification are separate requirements. See [PDF asset cropping](pdf-asset-cropping.md).

## Keep batch context bounded

Use a durable, private checkpoint for article IDs, current revisions, pending
corrections and verified delivery evidence. Keep each execution session focused
on the next bounded stage instead of replaying full article bodies and every
historical tool result. A recovery handoff must name exactly one active writer
and explicitly retire earlier session ownership.

Before stopping an execution session, reconcile active jobs. Stopping model
generation does not cancel or roll back a dispatched write. A failed native
compaction can leave the conversation unchanged; its generic summary-failure
message does not establish an API quota or context-limit error. Do not repeat
the attempt or increase a context-window setting without concrete evidence.

Model selection, configured context capacity and a successful real tool call
are distinct facts. Verify provider-specific capacity before overriding it.
When recovery uses a new short-context session, preserve the authorized model,
workspace, account and approval boundary, then inspect current state again.

## Treat subscription exhaustion as a checkpoint boundary

Distinguish a transient rate limit from an explicit subscription-window
exhaustion response. When the provider reports an exhausted window and a reset
time, retain that evidence and stop repeated model retries until the condition
changes. A failed generation does not prove that its preceding tool call failed
or that no remote write happened: reconcile native jobs, revisions, targets and
review registrations before recording the exact remaining work.

Do not silently switch the authorized model, subscription endpoint or paid API
route. Keep account and approval settings unchanged during quota recovery.
Completed local artifacts are not registered reviews until native state confirms
their current revision and byte digest. Preserve a concise private checkpoint;
do not put provider responses, account details or private paths in public docs.

## Rollout boundary

Guidance and helper changes do not change approval policy, remote write logic
or persisted state schemas. Source tests and synthetic PDF checks do not prove
that a live model will follow every instruction. Validate a built version in
an isolated DSH profile before switching a production draft session; do not
hot-replace an active batch. Retain the known-good build for rollback.

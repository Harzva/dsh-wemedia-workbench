# Security

This plugin can read configured content and invoke explicitly configured
channel bridges. Treat access to a write root, bridge or DSH profile as a
security boundary. Default configuration does not enable remote adapters.

## Safe operation

- Keep credentials and machine-specific configuration outside the repository.
- Use separate source roots and write roots; do not grant broader access merely to resolve an error.
- Remote actions must use native, intent-bound approval. Do not bypass approval or mutate the ledger to simulate success.
- Reconcile unknown or timed-out results read-only before any retry.
- Validate new builds in an isolated DSH profile without production accounts.
- Keep models, adapters and optional dependency licenses explicit. No subscription or platform entitlement is included.

## Reporting

Do not post tokens, cookies, account identifiers, private drafts or raw logs in
public issues. Use GitHub private vulnerability reporting when it is enabled;
otherwise open a minimal issue requesting a private contact channel without
including exploit details or sensitive material. This project does not promise
a response SLA or independent security certification.

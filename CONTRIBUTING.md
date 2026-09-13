# Contributing

This is an early-development DSH plugin. Keep changes scoped and describe the
behavior verified, not only the code added.

## Local checks

Use Node.js >=22.19.0 and pnpm 10.16.1 in an independent checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

For the optional PDF helper, use a separately installed, appropriately licensed
PyMuPDF environment and run `python -m unittest tests/test_crop_pdf_asset.py -v`.
The local helper baseline was checked with Python 3.14.7, PyMuPDF 1.28.0,
Matplotlib 3.11.1, NumPy 2.5.1 and Pillow 12.2.0. These are observed versions,
not a locked Python distribution or a promise about other environments.

External bridge integration tests are opt-in. Set `WEMEDIA_TEST_ZHIHU_BRIDGE`,
`WEMEDIA_TEST_XHS_BRIDGE` or `WEMEDIA_TEST_X_BRIDGE` to the corresponding local
bridge file to run its suite. Unconfigured suites are reported as skipped;
an explicitly configured missing bridge is an error. These external bridges
are not included in the repository and must be reviewed and licensed separately.
Core adapter/mock tests still run without them. Default CI does not verify
external bridges, real logins or real remote publication.

Do not build into a checkout loaded by a running DSH instance. Test bundles in
an isolated profile with no accounts before proposing a release. Never use
production publication to test an implementation change.

## Changes and evidence

- Preserve read-only source roots, immutable revisions and native approvals.
- Use the shared application service for UI, native tools and PTC. Do not add a bypass CLI.
- Add focused tests for changed behavior, especially approval, identity, cancellation and recovery.
- Distinguish synthetic/offline tests from real provider, account and platform verification.
- Explain AI assistance honestly; do not claim human review when only agents or tests reviewed a change.
- Preserve upstream copyright notices and identify copied or adapted code.

## Public data boundary

Use synthetic fixtures and placeholder paths. Do not commit account state,
cookies, tokens, environment values, private paths, raw chats, real article
libraries or session handoffs. Existing local ignored files must not be staged
with `git add -f` or copied into release artifacts. Inspect the exact Git diff
and packed files before publishing; a filename ignore rule is not a secret scan.

See [SECURITY.md](SECURITY.md) for sensitive reports and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency boundaries.

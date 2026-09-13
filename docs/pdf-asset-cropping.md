# Traceable PDF asset cropping

`scripts/crop-pdf-asset.py` is a deterministic, local-only helper for making
one PNG crop and its provenance manifest. It does not install packages, call a
model, upload data, or update DSH state.

Use an existing Python environment that already provides PyMuPDF (`fitz`):

```sh
python scripts/crop-pdf-asset.py \
  --pdf INPUT.pdf \
  --page 5 \
  --bbox 88 94 600 478 \
  --bbox-space render-pixels \
  --render-width 1224 \
  --render-height 1584 \
  --output-dir write-root/article/assets \
  --name table-1
```

The page number is PDF 1-based. The command refuses a missing page, an empty
or non-finite box, a box outside its declared coordinate space, a distorted
render size, or an existing PNG/manifest. It creates the output directory but
never overwrites a file. The manifest is sorted and timestamp-free so the same
PDF, page, bbox, render settings, and tool version produce the same manifest.

## Coordinate spaces

`page-points` uses the displayed `page.rect` coordinate frame after the PDF
page rotation. The manifest also records the unrotated `mediabox` and the PDF
rotation, so this is not an implicit 612 x 792 assumption.

`render-pixels` uses an already rendered page image coordinate frame. Give
`--render-width` and `--render-height`, or use `--source-render-image` in
candidate mode. The dimensions are checked against one common page scale with
at most one pixel of per-dimension raster rounding; visibly stretched frames
are rejected.

`normalized` uses values from 0 through 1. `mineru-1000` uses the explicit
MinerU-style 0 through 1000 page coordinate frame. The tool never guesses
between these spaces.

For PDF mode, choose either `--dpi` or an aspect-preserving explicit render
size. For candidate mode, pass `--candidate` to reuse a reviewed PNG. Pass
`--source-render-image` when the candidate bbox came from a rendered page, and
pass a relative `--source-detector-ref` such as
`analysis/figure-table-inventory.json#table-1`. Absolute references and path
traversal are rejected and no absolute input path is placed in the manifest.

## Existing candidate mode

This is the preferred path when an inventory already contains a candidate
crop:

```sh
python scripts/crop-pdf-asset.py \
  --pdf INPUT.pdf \
  --page 5 \
  --bbox 88 94 600 478 \
  --bbox-space render-pixels \
  --candidate CANDIDATE.png \
  --source-render-image PAGE-005.png \
  --source-detector-ref analysis/figure-table-inventory.json#table-1 \
  --output-dir write-root/article/assets \
  --name table-1
```

The output PNG is byte-for-byte copied from the candidate. Its manifest binds
the candidate SHA, source-render SHA and dimensions, source PDF SHA, page rect,
rotation, normalized bbox, detector reference, and output SHA. A candidate is
not an assertion that the crop is correct: `candidate_only` or equivalent
inventory status remains a human/agent visual-review concern.
The candidate itself must be a real PNG; a detector JPEG is not silently
renamed to `.png`.

When a source render image or explicit render dimensions are provided, the
candidate pixel dimensions must exactly equal the declared bbox crop size. A
wrong-size candidate is rejected rather than silently resized. The manifest
labels this check as `size-matched-source-render` or
`size-matched-declared-render`. If no render frame is available, the request
is still recorded only as `caller-declared-unverified`; the tool cannot prove
that the candidate content came from the stated PDF region.

## Manifest contract

The output is `<name>.png` plus `<name>.manifest.json` with schema
`pdf.asset.crop/v1`. It records:

- source PDF filename, byte count and SHA256;
- 1-based and zero-based page numbers, displayed rect, mediabox and rotation;
- the input bbox and explicit coordinate space;
- page-point and normalized forms, and rendered pixel bounds when a render
  frame is available;
- render dimensions, scale and DPI when the page was rendered;
- candidate/source-render metadata when an existing image was reused;
- output filename, dimensions, byte count and SHA256.

The bbox section also records a validation label. `rendered-from-pdf` means
this helper rendered the page and copied the exact pixel rectangle. The
size-matched labels prove only coordinate-size correspondence, not visual
content or detector correctness.

The manifest intentionally does not contain private absolute paths. It is a
provenance record, not a DSH review or an approval record.

## DSH workflow boundary

For a paper asset, the safe sequence is:

1. Inspect the existing inventory and MinerU/layout cache read-only.
2. Look at the candidate image and its source page; do not treat detector
   confidence as visual acceptance.
3. If needed, run this helper with an explicit 1-based page and bbox space.
4. Read the resulting PNG and inspect it again.
5. Save the selected asset through the native article workflow, then record the
   exact revision-bound review/evidence as separately authorized.

Do not call `workflow_import` to import an image. This helper only creates a
local PNG and manifest; it does not alter a draft, a review record, or a remote
target.

## Tests

Run the independent synthetic-PDF tests with the existing PyMuPDF environment:

```sh
python -m unittest tests/test_crop_pdf_asset.py -v
```

The tests cover letter, A4, landscape and rotated pages; all supported bbox
spaces; candidate reuse and provenance; deterministic PNG/manifest bytes;
non-finite, empty, out-of-bounds and wrong-page input; aspect mismatch; and
existing-output refusal.

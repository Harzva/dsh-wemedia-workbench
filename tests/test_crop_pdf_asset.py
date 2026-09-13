#!/usr/bin/env python3
"""Independent unit tests for scripts/crop-pdf-asset.py.

Run with the existing PDF runtime, for example:
  /path/to/python -m unittest tests/test_crop_pdf_asset.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

try:
    import fitz
except ImportError:  # pragma: no cover - depends on the selected Python runtime
    fitz = None


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "crop-pdf-asset.py"
if fitz is not None:
    spec = importlib.util.spec_from_file_location("crop_pdf_asset", SCRIPT)
    assert spec and spec.loader
    crop_pdf_asset = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(crop_pdf_asset)
else:  # pragma: no cover - skip the complete suite when PyMuPDF is unavailable
    crop_pdf_asset = None


@unittest.skipUnless(fitz is not None, "PyMuPDF is required for PDF crop tests")
class CropPdfAssetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pdf = self.root / "synthetic.pdf"
        document = fitz.open()
        for width, height, rotation, label in (
            (612, 792, 0, "letter"),
            (595, 842, 0, "a4"),
            (792, 612, 0, "landscape"),
            (612, 792, 90, "rotated"),
            (595.28, 841.89, 0, "a4-noninteger"),
        ):
            page = document.new_page(width=width, height=height)
            if rotation:
                page.set_rotation(rotation)
            page.insert_text((36, 36), label)
        document.save(self.pdf)
        document.close()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def invoke(self, *args: str) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = crop_pdf_asset.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def manifest(self, output_dir: Path, name: str) -> dict:
        return json.loads((output_dir / f"{name}.manifest.json").read_text(encoding="utf-8"))

    def assert_image_size(self, path: Path, expected: tuple[int, int]) -> None:
        pixmap = fitz.Pixmap(str(path))
        self.assertEqual((pixmap.width, pixmap.height), expected)

    def render_page(self, page_number: int, dpi: int, output: Path) -> tuple[int, int]:
        document = fitz.open(self.pdf)
        pixmap = document[page_number - 1].get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
        pixmap.save(output)
        size = (pixmap.width, pixmap.height)
        document.close()
        return size

    def test_real_page_rects_and_deterministic_output(self) -> None:
        first = self.root / "first"
        second = self.root / "second"
        args = (
            "--pdf", str(self.pdf),
            "--page", "1",
            "--bbox", "88", "94", "600", "478",
            "--bbox-space", "page-points",
            "--dpi", "72",
            "--output-dir", str(first),
            "--name", "table",
        )
        self.assertEqual(self.invoke(*args)[0], 0)
        second_args = tuple(str(second) if value == str(first) else value for value in args)
        self.assertEqual(self.invoke(*second_args)[0], 0)
        self.assertEqual((first / "table.png").read_bytes(), (second / "table.png").read_bytes())
        self.assertEqual(
            (first / "table.manifest.json").read_bytes(),
            (second / "table.manifest.json").read_bytes(),
        )
        self.assert_image_size(first / "table.png", (512, 384))
        manifest = self.manifest(first, "table")
        self.assertEqual(manifest["source"]["page"]["rect_points"], [0.0, 0.0, 612.0, 792.0])
        self.assertEqual(manifest["bbox"]["render_pixels"], [88, 94, 600, 478])
        self.assertNotIn(str(self.root), (first / "table.manifest.json").read_text(encoding="utf-8"))

    def test_a4_landscape_and_rotated_pages_use_actual_rect(self) -> None:
        cases = (
            (2, [0, 0, 1, 1], "normalized", (595, 842), [0.0, 0.0, 595.0, 842.0], 0),
            (3, [0, 0, 1000, 1000], "mineru-1000", (792, 612), [0.0, 0.0, 792.0, 612.0], 0),
            (4, [0, 0, 792, 612], "page-points", (792, 612), [0.0, 0.0, 792.0, 612.0], 90),
        )
        for page, bbox, space, expected_size, expected_rect, rotation in cases:
            name = f"page-{page}"
            output_dir = self.root / name
            args = [
                "--pdf", str(self.pdf), "--page", str(page),
                "--bbox", *(str(value) for value in bbox),
                "--bbox-space", space, "--dpi", "72",
                "--output-dir", str(output_dir), "--name", name,
            ]
            self.assertEqual(self.invoke(*args)[0], 0)
            self.assert_image_size(output_dir / f"{name}.png", expected_size)
            manifest = self.manifest(output_dir, name)
            self.assertEqual(manifest["source"]["page"]["rect_points"], expected_rect)
            self.assertEqual(manifest["source"]["page"]["rotation"], rotation)

        noninteger_dir = self.root / "a4-noninteger"
        args = [
            "--pdf", str(self.pdf), "--page", "5",
            "--bbox", "0", "0", "1", "1", "--bbox-space", "normalized",
            "--render-width", "1191", "--render-height", "1684",
            "--output-dir", str(noninteger_dir), "--name", "a4-noninteger",
        ]
        self.assertEqual(self.invoke(*args)[0], 0)
        self.assert_image_size(noninteger_dir / "a4-noninteger.png", (1191, 1684))
        manifest = self.manifest(noninteger_dir, "a4-noninteger")
        self.assertEqual(manifest["render"]["width"], 1191)
        self.assertEqual(manifest["render"]["height"], 1684)
        self.assertLessEqual(manifest["render"]["rounding_tolerance_px"], 1.0)

    def test_render_pixels_and_existing_candidate_keep_source_provenance(self) -> None:
        page_image = self.root / "page-001.png"
        render_size = self.render_page(1, 144, page_image)
        mismatch_dir = self.root / "mismatch"
        mismatch_args = [
            "--pdf", str(self.pdf), "--page", "1",
            "--bbox", "88", "94", "600", "478", "--bbox-space", "render-pixels",
            "--candidate", str(page_image), "--source-render-image", str(page_image),
            "--output-dir", str(mismatch_dir), "--name", "wrong-size",
        ]
        self.assertEqual(self.invoke(*mismatch_args)[0], 2)
        self.assertFalse((mismatch_dir / "wrong-size.png").exists())

        candidate_dir = self.root / "candidate"
        candidate_args = [
            "--pdf", str(self.pdf), "--page", "1",
            "--bbox", "88", "94", "600", "478",
            "--bbox-space", "render-pixels",
            "--render-width", str(render_size[0]), "--render-height", str(render_size[1]),
            "--output-dir", str(candidate_dir), "--name", "candidate",
        ]
        self.assertEqual(self.invoke(*candidate_args)[0], 0)
        candidate = candidate_dir / "candidate.png"
        existing_dir = self.root / "existing"
        existing_args = [
            "--pdf", str(self.pdf), "--page", "1",
            "--bbox", "88", "94", "600", "478",
            "--bbox-space", "render-pixels", "--candidate", str(candidate),
            "--source-render-image", str(page_image),
            "--source-detector-ref", "analysis/figure-table-inventory.json#table-1",
            "--output-dir", str(existing_dir), "--name", "candidate",
        ]
        self.assertEqual(self.invoke(*existing_args)[0], 0)
        copied = existing_dir / "candidate.png"
        self.assertEqual(candidate.read_bytes(), copied.read_bytes())
        manifest = self.manifest(existing_dir, "candidate")
        self.assertEqual(manifest["source"]["mode"], "existing-candidate")
        self.assertEqual(manifest["source"]["detector_ref"], "analysis/figure-table-inventory.json#table-1")
        self.assertEqual(manifest["source"]["source_render"]["width"], render_size[0])
        self.assertEqual(manifest["bbox"]["validation"], "size-matched-source-render")
        self.assertEqual(manifest["output"]["sha256"], manifest["source"]["candidate"]["sha256"])

        unverified_dir = self.root / "unverified"
        unverified_args = [
            "--pdf", str(self.pdf), "--page", "1",
            "--bbox", "88", "94", "600", "478", "--bbox-space", "page-points",
            "--candidate", str(candidate), "--output-dir", str(unverified_dir), "--name", "unverified",
        ]
        self.assertEqual(self.invoke(*unverified_args)[0], 0)
        self.assertEqual(self.manifest(unverified_dir, "unverified")["bbox"]["validation"], "caller-declared-unverified")

    def test_invalid_requests_and_existing_outputs_are_rejected(self) -> None:
        invalid = self.root / "invalid"
        def args_for(bbox: tuple[str, str, str, str]) -> list[str]:
            return [
                "--pdf", str(self.pdf), "--page", "1",
                "--bbox", *bbox,
                "--bbox-space", "page-points", "--dpi", "72",
                "--output-dir", str(invalid), "--name", "asset",
            ]

        common = args_for(("0", "0", "612", "792"))
        empty = args_for(("0", "0", "0", "792"))
        outside = args_for(("0", "0", "613", "792"))
        self.assertEqual(self.invoke(*empty)[0], 2)
        self.assertEqual(self.invoke(*outside)[0], 2)
        bad_page = [
            "--pdf", str(self.pdf), "--page", "1",
            "--bbox", "0", "0", "1", "1", "--bbox-space", "normalized", "--dpi", "72",
            "--output-dir", str(invalid), "--name", "bad-page",
        ]
        bad_page[3] = "9"
        self.assertEqual(self.invoke(*bad_page)[0], 2)
        self.assertEqual(self.invoke(*common)[0], 0)
        original_png = (invalid / "asset.png").read_bytes()
        self.assertEqual(self.invoke(*common)[0], 2)
        self.assertEqual((invalid / "asset.png").read_bytes(), original_png)

    def test_non_finite_bbox_and_aspect_mismatch_are_rejected(self) -> None:
        output_dir = self.root / "bad"
        non_finite = [
            "--pdf", str(self.pdf), "--page", "1", "--bbox", "nan", "0", "1", "1",
            "--bbox-space", "normalized", "--dpi", "72", "--output-dir", str(output_dir), "--name", "nan",
        ]
        self.assertEqual(self.invoke(*non_finite)[0], 2)
        mismatched = [
            "--pdf", str(self.pdf), "--page", "1", "--bbox", "0", "0", "1", "1",
            "--bbox-space", "normalized", "--render-width", "100", "--render-height", "100",
            "--output-dir", str(output_dir), "--name", "aspect",
        ]
        self.assertEqual(self.invoke(*mismatched)[0], 2)

    def test_detector_reference_rejects_windows_absolute_and_traversal_forms(self) -> None:
        for reference in (r"\\server\share\inventory.json", r"C:\private\inventory.json", r"analysis\..\private.json", "file:///private/inventory.json", "https://example.test/inventory.json"):
            with self.assertRaises(crop_pdf_asset.CropError):
                crop_pdf_asset.safe_reference(reference, "detector")

    def test_rotated_crop_selects_displayed_pixels_not_unrotated_coordinates(self) -> None:
        pdf = self.root / "colored.pdf"
        document = fitz.open()
        page = document.new_page(width=100, height=200)
        page.draw_rect(fitz.Rect(0, 0, 50, 100), color=None, fill=(1, 0, 0))
        page.set_rotation(90)
        document.save(pdf)
        document.close()
        output = self.root / "rotated-crop"
        code, _, error = self.invoke(
            "--pdf", str(pdf), "--page", "1", "--bbox", "120", "10", "180", "40",
            "--bbox-space", "page-points", "--dpi", "72", "--output-dir", str(output), "--name", "red",
        )
        self.assertEqual(code, 0, error)
        pixels = fitz.Pixmap(str(output / "red.png"))
        self.assertEqual((pixels.width, pixels.height), (60, 30))
        self.assertEqual(pixels.samples, bytes([255, 0, 0]) * 60 * 30)


if __name__ == "__main__":
    unittest.main()

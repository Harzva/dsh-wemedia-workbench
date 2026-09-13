#!/usr/bin/env python3
"""Create a traceable PNG crop from a PDF page or an existing candidate PNG.

The command intentionally requires an explicit coordinate space.  It never
clips an invalid box, overwrites an output, or writes an absolute input path
to the manifest.  The manifest is deterministic for the same inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

try:
    import fitz
except ImportError as exc:  # pragma: no cover - exercised by an environment check
    raise SystemExit(
        "PyMuPDF is required; run this command with an existing environment "
        "that provides the 'fitz' module. No package installation is performed."
    ) from exc


SCHEMA = "pdf.asset.crop/v1"
TOOL_VERSION = "1"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
COORDINATE_SPACES = ("page-points", "render-pixels", "normalized", "mineru-1000")


class CropError(ValueError):
    """A user-correctable crop request error."""


def sha256_bytes(data: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(data)
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def number(value: float) -> float:
    """Round coordinates for stable JSON without hiding relevant precision."""

    rounded = round(float(value), 12)
    if rounded == 0:
        return 0.0
    return rounded


def numbers(values: Sequence[float]) -> list[float]:
    return [number(value) for value in values]


def rect_values(rect: Any) -> list[float]:
    return numbers((rect.x0, rect.y0, rect.x1, rect.y1))


def require_file(value: str, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.exists():
        raise CropError(f"{label} does not exist: {value}")
    if not path.is_file():
        raise CropError(f"{label} is not a file: {value}")
    return path.resolve()


def safe_name(value: str, label: str) -> str:
    if not value or Path(value).name != value or not NAME_RE.fullmatch(value):
        raise CropError(f"{label} must be a single ASCII filename component: {value!r}")
    return value


def safe_reference(value: str | None, label: str) -> str | None:
    if value is None:
        return None
    if not value or "\x00" in value or "\n" in value or "\r" in value:
        raise CropError(f"{label} must be a non-empty relative reference")
    normalized = value.replace("\\", "/")
    if (
        Path(value).is_absolute()
        or PurePosixPath(normalized).is_absolute()
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", normalized)
    ):
        raise CropError(f"{label} must not be an absolute path")
    if ".." in PurePosixPath(normalized).parts:
        raise CropError(f"{label} must not escape its reference root")
    return value


def parse_bbox(values: Sequence[float]) -> list[float]:
    if len(values) != 4:
        raise CropError("--bbox requires exactly four numbers: x0 y0 x1 y1")
    bbox = [float(value) for value in values]
    if not all(math.isfinite(value) for value in bbox):
        raise CropError("bbox coordinates must be finite")
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise CropError("bbox must have positive width and height")
    return bbox


def page_metadata(page: Any, page_number: int) -> dict[str, Any]:
    return {
        "page_number": page_number,
        "page_index": page_number - 1,
        "rect_points": rect_values(page.rect),
        "mediabox_points": rect_values(page.mediabox),
        "rotation": int(page.rotation),
    }


def image_metadata(path: Path) -> tuple[dict[str, Any], tuple[int, int]]:
    try:
        pixmap = fitz.Pixmap(str(path))
    except Exception as exc:  # PyMuPDF exposes several image parse exceptions.
        raise CropError(f"source image is not a readable raster image: {path.name}") from exc
    if pixmap.width <= 0 or pixmap.height <= 0:
        raise CropError(f"source image has invalid dimensions: {path.name}")
    metadata = {
        "name": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "width": pixmap.width,
        "height": pixmap.height,
    }
    return metadata, (pixmap.width, pixmap.height)


def require_png(path: Path, label: str) -> None:
    if path.suffix.lower() != ".png" or not path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        raise CropError(f"{label} must be a PNG image: {path.name}")


def render_dimension_scales(page: Any, width: int, height: int) -> tuple[float, float, float]:
    """Return per-axis scales and the shared-scale rounding error in pixels."""

    page_width = float(page.rect.width)
    page_height = float(page.rect.height)
    scale_x = width / page_width
    scale_y = height / page_height
    shared_scale = (scale_x + scale_y) / 2.0
    width_error = abs(width - shared_scale * page_width)
    height_error = abs(height - shared_scale * page_height)
    rounding_error = max(width_error, height_error)
    if rounding_error > 1.0 + 1e-6:
        raise CropError(
            f"render size {width}x{height} is not within one pixel of a uniform page scale "
            f"(rounding error {rounding_error:.3f}px)"
        )
    return scale_x, scale_y, rounding_error


def render_setup(page: Any, dpi: float | None, width: int | None, height: int | None) -> tuple[Any, dict[str, Any]]:
    if (width is None) != (height is None):
        raise CropError("--render-width and --render-height must be provided together")
    if dpi is not None and width is not None:
        raise CropError("use either --dpi or --render-width/--render-height, not both")
    if dpi is None and width is None:
        raise CropError("PDF rendering requires --dpi or --render-width/--render-height")
    if dpi is not None:
        if not math.isfinite(dpi) or dpi <= 0:
            raise CropError("--dpi must be a finite positive number")
        scale_x = scale_y = dpi / 72.0
        requested: dict[str, Any] = {"dpi": number(dpi)}
    else:
        assert width is not None and height is not None
        if width <= 0 or height <= 0:
            raise CropError("render dimensions must be positive")
        scale_x, scale_y, rounding_error = render_dimension_scales(page, width, height)
        requested = {"width": width, "height": height}
    if dpi is not None:
        rounding_error = 0.0

    matrix = fitz.Matrix(scale_x, scale_y)
    pixmap = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False)
    if width is not None and (pixmap.width != width or pixmap.height != height):
        raise CropError(
            f"requested render size {width}x{height} produced {pixmap.width}x{pixmap.height}"
        )
    render = {
        "coordinate_frame": "page.rect after PDF rotation",
        "width": pixmap.width,
        "height": pixmap.height,
        "scale_x": number(scale_x),
        "scale_y": number(scale_y),
        "rounding_tolerance_px": number(rounding_error),
        "requested": requested,
    }
    if dpi is not None:
        render["dpi"] = number(dpi)
    else:
        render["dpi"] = number(scale_x * 72.0)
    return pixmap, render


def validate_page_bbox(bbox: Sequence[float], page: Any, space: str, render_size: tuple[int, int] | None) -> None:
    if space == "page-points":
        lower = (float(page.rect.x0), float(page.rect.y0), float(page.rect.x0), float(page.rect.y0))
        upper = (float(page.rect.x1), float(page.rect.y1), float(page.rect.x1), float(page.rect.y1))
    elif space == "render-pixels":
        if render_size is None:
            raise CropError("render-pixels requires source render dimensions")
        lower = (0.0, 0.0, 0.0, 0.0)
        upper = (float(render_size[0]), float(render_size[1]), float(render_size[0]), float(render_size[1]))
    elif space == "normalized":
        lower = (0.0, 0.0, 0.0, 0.0)
        upper = (1.0, 1.0, 1.0, 1.0)
    elif space == "mineru-1000":
        lower = (0.0, 0.0, 0.0, 0.0)
        upper = (1000.0, 1000.0, 1000.0, 1000.0)
    else:
        raise CropError(f"unsupported bbox coordinate space: {space}")
    if any(
        value < low or value > high
        for value, low, high in zip(bbox, lower, upper, strict=True)
    ):
        raise CropError(f"bbox is outside the declared {space} bounds {list(zip(lower, upper))}")


def validate_render_size(page: Any, render_size: tuple[int, int]) -> float:
    """Validate a source render with integer pixel rounding, returning its error."""

    _scale_x, _scale_y, rounding_error = render_dimension_scales(page, *render_size)
    return rounding_error


def to_page_points(
    bbox: Sequence[float], page: Any, space: str, render_size: tuple[int, int] | None
) -> tuple[list[float], list[float]]:
    """Return page.rect coordinates and a normalized bbox in the displayed frame."""

    validate_page_bbox(bbox, page, space, render_size)
    page_rect = page.rect
    page_width = float(page_rect.width)
    page_height = float(page_rect.height)
    if space == "page-points":
        page_bbox = list(bbox)
        normalized = [
            (bbox[0] - page_rect.x0) / page_width,
            (bbox[1] - page_rect.y0) / page_height,
            (bbox[2] - page_rect.x0) / page_width,
            (bbox[3] - page_rect.y0) / page_height,
        ]
    else:
        if space == "normalized":
            normalized = list(bbox)
        elif space == "mineru-1000":
            normalized = [value / 1000.0 for value in bbox]
        else:
            assert render_size is not None
            normalized = [
                bbox[0] / render_size[0],
                bbox[1] / render_size[1],
                bbox[2] / render_size[0],
                bbox[3] / render_size[1],
            ]
        page_bbox = [
            page_rect.x0 + normalized[0] * page_width,
            page_rect.y0 + normalized[1] * page_height,
            page_rect.x0 + normalized[2] * page_width,
            page_rect.y0 + normalized[3] * page_height,
        ]
    return numbers(page_bbox), numbers(normalized)


def pixel_bbox(normalized: Sequence[float], width: int, height: int) -> list[int]:
    def edge(value: float, size: int, upper: bool) -> int:
        raw = value * size
        nearest = round(raw)
        # Normalized page-point coordinates often represent an exact pixel
        # boundary but carry a small binary-float residue after division.
        if abs(raw - nearest) <= 1e-7:
            raw = float(nearest)
        return math.ceil(raw) if upper else math.floor(raw)

    result = [
        edge(normalized[0], width, False),
        edge(normalized[1], height, False),
        edge(normalized[2], width, True),
        edge(normalized[3], height, True),
    ]
    if result[0] < 0 or result[1] < 0 or result[2] > width or result[3] > height:
        raise CropError("normalized bbox maps outside the rendered page")
    if result[0] >= result[2] or result[1] >= result[3]:
        raise CropError("bbox maps to an empty rendered crop")
    return result


def exact_crop(full: Any, bbox: Sequence[int]) -> Any:
    """Copy an exact integer pixel rectangle without relying on image libraries."""

    x0, y0, x1, y1 = bbox
    if not (0 <= x0 < x1 <= full.width and 0 <= y0 < y1 <= full.height):
        raise CropError("pixel crop is outside the rendered page")
    if full.n != 3:
        raise CropError("internal renderer did not produce an RGB pixmap")
    output = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, x1 - x0, y1 - y0))
    source = full.samples_mv
    target = output.samples_mv
    row_bytes = (x1 - x0) * full.n
    for row in range(y1 - y0):
        source_start = (y0 + row) * full.stride + x0 * full.n
        target_start = row * output.stride
        target[target_start : target_start + row_bytes] = source[source_start : source_start + row_bytes]
    return output


def exclusive_write(path: Path, data: bytes) -> None:
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError as exc:
        raise CropError(f"refusing to overwrite existing output: {path.name}") from exc
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def build_manifest(
    *,
    pdf_path: Path,
    pdf_sha256: str,
    page_data: dict[str, Any],
    bbox: Sequence[float],
    space: str,
    page_bbox: Sequence[float],
    normalized_bbox: Sequence[float],
    bbox_validation: str,
    source_render: dict[str, Any] | None,
    source_candidate: dict[str, Any] | None,
    detector_ref: str | None,
    output_name: str,
    output_bytes: bytes,
    output_size: tuple[int, int],
    render: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "tool": {"name": "crop-pdf-asset.py", "version": TOOL_VERSION},
        "source": {
            "pdf": {
                "name": pdf_path.name,
                "sha256": pdf_sha256,
                "bytes": pdf_path.stat().st_size,
            },
            "page": page_data,
            "mode": "existing-candidate" if source_candidate else "pdf-render",
            "candidate": source_candidate,
            "source_render": source_render,
            "detector_ref": detector_ref,
        },
        "bbox": {
            "input": numbers(bbox),
            "input_space": space,
            "page_points": numbers(page_bbox),
            "normalized": numbers(normalized_bbox),
            "validation": bbox_validation,
            "render_pixels": pixel_bbox(normalized_bbox, render["width"], render["height"])
            if render is not None
            else (
                pixel_bbox(normalized_bbox, source_render["width"], source_render["height"])
                if source_render is not None
                else None
            ),
        },
        "render": render,
        "output": {
            "name": output_name,
            "sha256": sha256_bytes(output_bytes),
            "bytes": len(output_bytes),
            "width": output_size[0],
            "height": output_size[1],
        },
    }


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, help="source PDF")
    parser.add_argument("--page", required=True, type=int, help="1-based PDF page number")
    parser.add_argument("--bbox", required=True, nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--bbox-space", required=True, choices=COORDINATE_SPACES)
    parser.add_argument("--candidate", help="existing candidate PNG to copy instead of rendering")
    parser.add_argument("--source-render-image", help="page render used by a candidate bbox")
    parser.add_argument("--source-detector-ref", help="relative inventory/detector reference")
    parser.add_argument("--dpi", type=float, help="render DPI for PDF mode")
    parser.add_argument("--render-width", type=int, help="explicit render width for PDF mode or candidate metadata")
    parser.add_argument("--render-height", type=int, help="explicit render height for PDF mode or candidate metadata")
    parser.add_argument("--output-dir", required=True, help="directory for the new PNG and manifest")
    parser.add_argument("--name", required=True, help="ASCII output stem without extension")
    return parser.parse_args(argv)


def run(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    pdf_path = require_file(args.pdf, "PDF")
    if args.page < 1:
        raise CropError("--page is 1-based and must be positive")
    output_stem = safe_name(args.name, "--name")
    space = args.bbox_space
    bbox = parse_bbox(args.bbox)
    detector_ref = safe_reference(args.source_detector_ref, "--source-detector-ref")
    candidate_path = require_file(args.candidate, "candidate") if args.candidate else None
    source_render_path = (
        require_file(args.source_render_image, "source render image")
        if args.source_render_image
        else None
    )

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"{output_stem}.png"
    manifest_name = f"{output_stem}.manifest.json"
    output_path = output_dir / output_name
    manifest_path = output_dir / manifest_name
    if output_path.exists() or manifest_path.exists():
        raise CropError("refusing to overwrite an existing PNG or manifest")

    try:
        document = fitz.open(str(pdf_path))
    except Exception as exc:
        raise CropError(f"unable to open PDF: {pdf_path.name}") from exc
    try:
        if args.page > document.page_count:
            raise CropError(f"--page {args.page} exceeds PDF page count {document.page_count}")
        page = document.load_page(args.page - 1)
        pdf_sha256 = sha256_file(pdf_path)
        page_info = page_metadata(page, args.page)

        source_render: dict[str, Any] | None = None
        source_render_size: tuple[int, int] | None = None
        if source_render_path:
            source_render, source_render_size = image_metadata(source_render_path)
        explicit_render_size = None
        if args.render_width is not None or args.render_height is not None:
            if args.render_width is None or args.render_height is None:
                raise CropError("--render-width and --render-height must be provided together")
            if args.render_width <= 0 or args.render_height <= 0:
                raise CropError("render dimensions must be positive")
            explicit_render_size = (args.render_width, args.render_height)
        if source_render_size and explicit_render_size and source_render_size != explicit_render_size:
            raise CropError(
                f"source render image is {source_render_size[0]}x{source_render_size[1]}, "
                f"not the declared {explicit_render_size[0]}x{explicit_render_size[1]}"
            )
        declared_render_size = source_render_size or explicit_render_size
        render_rounding_error = None
        if declared_render_size:
            render_rounding_error = validate_render_size(page, declared_render_size)

        if candidate_path:
            require_png(candidate_path, "candidate")
            if args.dpi is not None:
                raise CropError("--dpi is only valid when rendering from the PDF")
            if space == "render-pixels" and declared_render_size is None:
                raise CropError("candidate render-pixels requires --source-render-image or explicit render dimensions")
            page_bbox, normalized_bbox = to_page_points(bbox, page, space, declared_render_size)
            candidate_metadata, candidate_size = image_metadata(candidate_path)
            source_candidate = candidate_metadata
            output_bytes = candidate_path.read_bytes()
            output_size = candidate_size
            render = None
            if declared_render_size is None:
                bbox_validation = "caller-declared-unverified"
            else:
                expected_bbox = pixel_bbox(normalized_bbox, *declared_render_size)
                expected_size = (expected_bbox[2] - expected_bbox[0], expected_bbox[3] - expected_bbox[1])
                if candidate_size != expected_size:
                    raise CropError(
                        f"candidate dimensions {candidate_size[0]}x{candidate_size[1]} do not match "
                        f"bbox crop {expected_size[0]}x{expected_size[1]} in the declared render frame"
                    )
                bbox_validation = (
                    "size-matched-source-render" if source_render else "size-matched-declared-render"
                )
            if declared_render_size is not None:
                render = {
                    "coordinate_frame": "source render image" if source_render else "declared source render frame",
                    "width": declared_render_size[0],
                    "height": declared_render_size[1],
                    "dpi": None,
                    "rounding_tolerance_px": number(render_rounding_error or 0.0),
                    "requested": {"width": declared_render_size[0], "height": declared_render_size[1]},
                }
            if output_path.resolve() == candidate_path:
                raise CropError("output must not be the same file as the candidate")
        else:
            if source_render_path:
                raise CropError("--source-render-image is only valid with --candidate")
            full, render = render_setup(page, args.dpi, args.render_width, args.render_height)
            page_bbox, normalized_bbox = to_page_points(bbox, page, space, (full.width, full.height))
            rendered_bbox = pixel_bbox(normalized_bbox, full.width, full.height)
            crop = exact_crop(full, rendered_bbox)
            output_bytes = crop.tobytes("png")
            output_size = (crop.width, crop.height)
            source_candidate = None
            bbox_validation = "rendered-from-pdf"
    finally:
        document.close()

    manifest = build_manifest(
        pdf_path=pdf_path,
        pdf_sha256=pdf_sha256,
        page_data=page_info,
        bbox=bbox,
        space=space,
        page_bbox=page_bbox,
        normalized_bbox=normalized_bbox,
        bbox_validation=bbox_validation,
        source_render=source_render,
        source_candidate=source_candidate,
        detector_ref=detector_ref,
        output_name=output_name,
        output_bytes=output_bytes,
        output_size=output_size,
        render=render,
    )
    manifest_bytes = json_bytes(manifest)
    if output_path.resolve() == pdf_path or manifest_path.resolve() == pdf_path:
        raise CropError("output must not overwrite the source PDF")

    created: list[Path] = []
    try:
        exclusive_write(output_path, output_bytes)
        created.append(output_path)
        exclusive_write(manifest_path, manifest_bytes)
        created.append(manifest_path)
    except Exception:
        for path in created:
            try:
                path.unlink()
            except OSError:
                pass
        raise
    print(json.dumps({"image": str(output_path), "manifest": str(manifest_path), "sha256": manifest["output"]["sha256"]}, sort_keys=True))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return run(sys.argv[1:] if argv is None else argv)
    except CropError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError, fitz.FileDataError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

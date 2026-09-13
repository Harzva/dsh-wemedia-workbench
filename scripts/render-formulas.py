#!/usr/bin/env python3
"""Render reviewed mathematical expressions locally; no TeX process or network.

Uses Matplotlib's public MathText API independently of article-builder scripts.
Input: {"formulas": [{"basename", "lines", "source": {"url", "page", "section"}, "alt"}]}.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import ipaddress
import json
import math
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import matplotlib

matplotlib.use("Agg")
matplotlib.rcParams["text.usetex"] = False
from matplotlib.font_manager import FontProperties
from matplotlib.mathtext import MathTextParser
import numpy as np
from PIL import Image, __version__ as pillow_version


SCALE = 3
CSS_WIDTH = 318
CSS_FONT = 20
CSS_PADDING = 8
CSS_LINE_GAP = 12
MAX_INPUT = 256 * 1024
PRIVATE_TEXT = re.compile(r"/(?:Users|Volumes|private|home|etc)/|(?:token|secret|cookie|password|authorization|api.?key)\s*[:=]", re.I)


def public_text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must be nonempty text, at most {maximum} characters")
    if any(ord(char) < 32 or ord(char) == 127 for char in value) or PRIVATE_TEXT.search(value):
        raise ValueError(f"{label} contains control characters or private reference text")
    return value.strip()


def source_reference(value: object, label: str) -> dict:
    if not isinstance(value, dict) or set(value) != {"url", "page", "section"}:
        raise ValueError(f"{label} requires exactly url, page and section")
    url = public_text(value["url"], f"{label}.url", 2048)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None, 443):
        raise ValueError(f"{label}.url must be a public HTTPS source URL")
    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith((".localhost", ".local")) or "." not in hostname:
        raise ValueError(f"{label}.url must not refer to a local host")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError(f"{label}.url must not refer to a private IP address")
    if any(re.search(r"token|secret|cookie|password|authorization|credential|api.?key|signature|xsec", key, re.I) for key, _ in parse_qsl(parsed.query)):
        raise ValueError(f"{label}.url must not contain authentication parameters")
    page = value["page"]
    if type(page) is not int or not 1 <= page <= 100_000:
        raise ValueError(f"{label}.page must be a positive page number")
    return {"url": url, "page": page, "section": public_text(value["section"], f"{label}.section", 200)}


def validated_formulas(raw: object) -> list[dict]:
    if not isinstance(raw, dict) or set(raw) != {"formulas"}:
        raise ValueError("Input must contain exactly a formulas array")
    formulas = raw["formulas"]
    if not isinstance(formulas, list) or not 1 <= len(formulas) <= 16:
        raise ValueError("Provide between 1 and 16 formulas")
    output, names = [], set()
    for index, item in enumerate(formulas, 1):
        label = f"formula {index}"
        if not isinstance(item, dict) or set(item) != {"basename", "lines", "source", "alt"}:
            raise ValueError(f"{label} requires exactly basename, lines, source and alt")
        name = item["basename"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name) or name in names:
            raise ValueError(f"{label}.basename must be unique, lowercase, and contain only letters, digits, hyphens or underscores")
        names.add(name)
        lines = item["lines"]
        if not isinstance(lines, list) or not 1 <= len(lines) <= 8:
            raise ValueError(f"{label} requires between 1 and 8 lines")
        checked = []
        for row, line in enumerate(lines, 1):
            line = public_text(line, f"{label} line {row}", 2000)
            if not line.isascii() or "$" in line:
                raise ValueError(f"{label} line {row}: use ASCII LaTeX commands without $ delimiters; keep Chinese explanations in HTML")
            checked.append(line)
        output.append({"basename": name, "lines": checked, "source": source_reference(item["source"], f"{label}.source"), "alt": public_text(item["alt"], f"{label}.alt", 500)})
    return output


def render_formula(item: dict, parser: MathTextParser) -> tuple[bytes, dict]:
    masks = []
    font = FontProperties(family="STIXGeneral", size=CSS_FONT, math_fontfamily="stix")
    available = (CSS_WIDTH - 2 * CSS_PADDING) * SCALE
    for index, line in enumerate(item["lines"], 1):
        try:
            parsed = parser.parse(f"${line}$", dpi=72 * SCALE, prop=font, antialiased=True)
        except (ValueError, RuntimeError) as error:
            raise ValueError(f"{item['basename']} line {index}: unsupported MathText expression; correct it before rendering") from error
        mask = Image.fromarray(np.asarray(parsed.image).copy())
        bounds = mask.getbbox()
        if bounds is None:
            raise ValueError(f"{item['basename']} line {index}: expression rendered blank")
        mask = mask.crop(bounds)
        if mask.width > available:
            raise ValueError(f"{item['basename']} line {index}: needs {math.ceil(mask.width / SCALE)} CSS px, but only {available // SCALE} are available; split the formula into semantic lines (font size stays {CSS_FONT} CSS px)")
        masks.append(mask)
    width = math.ceil((max(mask.width for mask in masks) + 2 * CSS_PADDING * SCALE) / SCALE) * SCALE
    height = math.ceil((sum(mask.height for mask in masks) + ((len(masks) - 1) * CSS_LINE_GAP + 2 * CSS_PADDING) * SCALE) / SCALE) * SCALE
    if height > 1024 * SCALE:
        raise ValueError(f"{item['basename']}: formula is too tall; divide it into separate formulas")
    canvas = Image.new("RGB", (width, height), "white")
    top = CSS_PADDING * SCALE
    for mask in masks:
        canvas.paste((23, 33, 43), ((width - mask.width) // 2, top), mask)
        top += mask.height + CSS_LINE_GAP * SCALE
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", optimize=True)
    data = buffer.getvalue()
    return data, {**item, "file": f"{item['basename']}.png", "width": width, "height": height, "cssWidth": width // SCALE, "cssHeight": height // SCALE, "sha256": hashlib.sha256(data).hexdigest(), "latexSha256": hashlib.sha256(json.dumps(item["lines"], ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()}


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("input", type=Path, help="JSON containing 1–16 formulas and their source references")
    cli.add_argument("--output", type=Path, required=True, help="A new directory under an existing parent; never overwritten")
    args = cli.parse_args()
    try:
        if args.output.exists() or args.output.is_symlink():
            raise ValueError("Output already exists; choose a new directory")
        with args.input.open("rb") as handle:
            data = handle.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise ValueError("Input exceeds 256 KiB")
        formulas = validated_formulas(json.loads(data))
        parser = MathTextParser("agg")
        rendered = [render_formula(item, parser) for item in formulas]
        mapping = {"schemaVersion": "wemedia.formulas/v1", "renderer": {"name": "matplotlib.mathtext", "version": matplotlib.__version__, "pillowVersion": pillow_version, "font": "STIX", "scale": SCALE, "maxCssWidth": CSS_WIDTH, "cssFontSize": CSS_FONT, "cssPadding": CSS_PADDING, "cssLineGap": CSS_LINE_GAP, "background": "white", "externalTex": False}, "notice": "Mathematical typesetting only; source references are supplied by the author and have not been verified.", "formulas": [record for _, record in rendered]}
        args.output.mkdir(mode=0o700)
        for png, record in rendered:
            with (args.output / record["file"]).open("xb") as handle:
                handle.write(png)
        with (args.output / "source-map.json").open("x", encoding="utf-8") as handle:
            json.dump(mapping, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(f"Rendered {len(rendered)} formula PNG(s) and source-map.json; mathematical facts still require review.")
        return 0
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        print(f"Formula rendering failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

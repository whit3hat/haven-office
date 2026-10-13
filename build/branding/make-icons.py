#!/usr/bin/env python3
"""Render the Haven Office app marks into build/icon.png and build/icon.ico.

Placeholder artwork: a flat near-black rounded tile with a zinc hairline border
and a light "H" monogram, in the same palette the launcher uses (#0a0a0a
surfaces, zinc text). Replace this script together with the generated assets
when a real Haven mark exists.

No image libraries are installed on the build host, so this writes PNG and ICO
bytes directly (stdlib zlib/struct only) and antialiases by supersampling.

    python3 build/branding/make-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parent.parent

SURFACE = (0x0F, 0x0F, 0x11)
BORDER = (0x27, 0x27, 0x2A)
GLYPH = (0xFA, 0xFA, 0xFA)

CORNER_RADIUS = 0.225          # fraction of the edge
BORDER_WIDTH = 0.012           # fraction of the edge
BAR_WIDTH = 0.115              # "H" stem width
BAR_TOP, BAR_BOTTOM = 0.275, 0.725
LEFT_BAR_X = 0.295
RIGHT_BAR_X = 1.0 - LEFT_BAR_X - BAR_WIDTH
CROSSBAR_HALF_HEIGHT = 0.047

# electron-builder documents 512x512 as the minimum for .icns generation; 1024
# is what macOS wants for the @2x slice, so render at 1024 and let it downscale.
PNG_SIZE = 1024
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def inside_rounded_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    if r <= 0:
        return True
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def inside_glyph(x: float, y: float) -> bool:
    if BAR_TOP <= y <= BAR_BOTTOM:
        if LEFT_BAR_X <= x <= LEFT_BAR_X + BAR_WIDTH:
            return True
        if RIGHT_BAR_X <= x <= RIGHT_BAR_X + BAR_WIDTH:
            return True
    if LEFT_BAR_X <= x <= RIGHT_BAR_X + BAR_WIDTH:
        if abs(y - 0.5) <= CROSSBAR_HALF_HEIGHT:
            return True
    return False


def render_rgba(size: int, samples: int = 3) -> bytearray:
    """Return raw RGBA rows (top-down) for a size x size mark."""
    inset = BORDER_WIDTH
    inner_radius = max(CORNER_RADIUS - BORDER_WIDTH, 0.0)
    step = 1.0 / (size * samples)
    offset = step / 2.0
    sample_total = float(samples * samples)
    rows = bytearray()

    for py in range(size):
        row = bytearray()
        for px in range(size):
            tile = inner = glyph = 0
            for sy in range(samples):
                y = (py * samples + sy) * step + offset
                for sx in range(samples):
                    x = (px * samples + sx) * step + offset
                    if not inside_rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, CORNER_RADIUS):
                        continue
                    tile += 1
                    if inside_rounded_rect(x, y, inset, inset, 1.0 - inset, 1.0 - inset, inner_radius):
                        inner += 1
                        if inside_glyph(x, y):
                            glyph += 1

            if tile == 0:
                row += b"\x00\x00\x00\x00"
                continue

            a_tile = tile / sample_total
            a_border = (tile - inner) / sample_total
            a_glyph = glyph / sample_total
            a_surface = max(a_tile - a_border - a_glyph, 0.0)

            # Premultiplied mix over the tile's own alpha, then un-premultiply.
            channels = []
            for i in range(3):
                mixed = SURFACE[i] * a_surface + BORDER[i] * a_border + GLYPH[i] * a_glyph
                channels.append(int(round(min(mixed / a_tile, 255.0))))
            row += bytes(channels) + bytes([int(round(a_tile * 255.0))])

        rows += b"\x00" + row

    return rows


def png_bytes(size: int, raw_rows: bytes) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw_rows), 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(images: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    payload = b""
    for size, data in images:
        dimension = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    return header + entries + payload


def main() -> None:
    png_path = BUILD_DIR / "icon.png"
    png_path.write_bytes(png_bytes(PNG_SIZE, render_rgba(PNG_SIZE)))
    print(f"wrote {png_path} ({PNG_SIZE}x{PNG_SIZE})")

    images = []
    for size in ICO_SIZES:
        samples = 3 if size >= 128 else 6
        images.append((size, png_bytes(size, render_rgba(size, samples))))
    ico_path = BUILD_DIR / "icon.ico"
    ico_path.write_bytes(ico_bytes(images))
    print(f"wrote {ico_path} ({', '.join(str(s) for s in ICO_SIZES)})")


if __name__ == "__main__":
    main()

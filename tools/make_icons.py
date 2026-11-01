#!/usr/bin/env python3
"""Generate the extension icons (a clock face) at 16/48/128 px."""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "extension", "icons")


def rounded(x, y, w, h, r):
    if r <= 0:
        return 0 <= x < w and 0 <= y < h
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    px = []
    r_out = size * 0.22
    r_in = size * 0.44
    hand_w = max(1.0, size * 0.055)
    for y in range(size):
        row = []
        for x in range(size):
            cx = x + 0.5 - size / 2
            cy = y + 0.5 - size / 2
            d = (cx * cx + cy * cy) ** 0.5
            if not rounded(x + 0.5, y + 0.5, size, size, r_out):
                row.append((0, 0, 0, 0))
                continue
            if d > r_in:
                row.append((0x1E, 0x4B, 0x8C, 255))  # blue rim
                continue
            # clock hands: minute hand up, hour hand to the right
            on_minute = abs(cx) <= hand_w and -r_in * 0.72 <= cy <= 0
            on_hour = abs(cy) <= hand_w and 0 <= cx <= r_in * 0.5
            if on_minute or on_hour:
                row.append((0x1E, 0x4B, 0x8C, 255))
            else:
                row.append((0xFF, 0xFF, 0xFF, 255))
        px.append(row)
    return px


def write_png(path, px):
    size = len(px)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *p) for p in row) for row in px
    )

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        write_png(os.path.join(OUT, f"icon-{s}.png"), render(s))
        print("wrote", os.path.join(OUT, f"icon-{s}.png"))

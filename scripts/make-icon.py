#!/usr/bin/env python3
"""Build the geometric Nova monogram with only Python and macOS tools."""
from pathlib import Path
from subprocess import check_call
import struct
import zlib

root = Path(__file__).resolve().parent.parent
build = root / "build"
build.mkdir(exist_ok=True)
size = 1024
polygon = [(312, 310), (382, 310), (642, 620), (642, 310), (712, 310), (712, 714), (642, 714), (382, 404), (382, 714), (312, 714)]
def inside_polygon(x, y):
    inside = False
    last = polygon[-1]
    for point in polygon:
        ax, ay = last
        bx, by = point
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
        last = point
    return inside

def rounded(x, y, inset, radius):
    if not inset <= x < size - inset or not inset <= y < size - inset:
        return False
    dx = max(inset + radius - x, 0, x - (size - inset - radius))
    dy = max(inset + radius - y, 0, y - (size - inset - radius))
    return dx * dx + dy * dy <= radius * radius

raw = bytearray()
for y in range(size):
    raw.append(0)
    for x in range(size):
        pixel = (0, 0, 0, 0)
        if rounded(x, y, 56, 200):
            pixel = (39, 47, 46, 255) if not rounded(x, y, 64, 192) else (20, 23, 25, 255)
            if inside_polygon(x, y):
                pixel = (99, 202, 166, 255)
        raw.extend(pixel)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
png = build / "icon.png"
png.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
iconset = build / "icon.iconset"
iconset.mkdir(exist_ok=True)
for dim in (16, 32, 64, 128, 256, 512, 1024):
    check_call(["sips", "-z", str(dim), str(dim), str(png), "--out", str(iconset / f"icon_{dim}x{dim}.png")])
    if dim <= 512:
        check_call(["sips", "-z", str(dim * 2), str(dim * 2), str(png), "--out", str(iconset / f"icon_{dim}x{dim}@2x.png")])
check_call(["iconutil", "-c", "icns", str(iconset), "-o", str(build / "icon.icns")])
frames = [(dim, (iconset / f"icon_{dim}x{dim}.png").read_bytes()) for dim in (16, 32, 64, 128, 256)]
header = struct.pack("<HHH", 0, 1, len(frames))
offset = 6 + 16 * len(frames)
directory = bytearray()
for dim, data in frames:
    directory.extend(struct.pack("<BBBBHHII", dim % 256, dim % 256, 0, 0, 1, 32, len(data), offset))
    offset += len(data)
(build / "icon.ico").write_bytes(header + directory + b"".join(data for _, data in frames))
print("Generated Nova Collar PNG, macOS and Windows icons.")

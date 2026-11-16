"""Test data made in code: a picture and a firmware file. Standard library only."""

import hashlib
import random
import struct
import zlib

# The six colours of the display, as (R, G, B)
COLOURS = [(0, 0, 0), (255, 255, 255), (0, 0, 255), (0, 255, 0), (255, 0, 0), (255, 255, 0)]

# 4 bit colour codes the display accepts (see buildBmp() in web/src/app.js)
VALID_PIXEL_CODES = {0, 1, 2, 3, 5, 6}


def png(width, height, pixel):
    """Encodes an RGB picture; `pixel(x, y)` returns (r, g, b)."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: none
        for x in range(width):
            rows += bytes(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


def test_picture(width=400, height=240):
    """Colour bars in the six display colours above a grey ramp."""

    def pixel(x, y):
        if y < height * 2 // 3:
            return COLOURS[min(5, x * 6 // width)]
        grey = x * 255 // (width - 1)
        return (grey, grey, grey)

    return png(width, height, pixel)


def noise_picture(width=800, height=480, seed=1):
    """Random pixels: the picture file made from it is large, its upload takes several windows."""
    rng = random.Random(seed)
    rows = b"".join(b"\x00" + rng.randbytes(width * 3) for _ in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b"")


def raw_picture(width, height, seed=1):
    """The payload of a display (4 bit per pixel): vertical bars in its six colour codes, shifted by `seed`."""
    codes = sorted(VALID_PIXEL_CODES)
    row = bytearray(width // 2)
    for x in range(0, width, 2):
        code = codes[(x * 6 // width + seed) % 6]
        row[x // 2] = (code << 4) | code
    return bytes(row) * height


def gallery_container(display, width, height, seed=1, thumb=None, window=12):
    """A picture file of the gallery as the web UI makes it. The preview is a PNG here: the device does not look at it.
    window: of the deflate stream, as a power of two. 0: not named in the file (the usual 32 KB)."""
    raw = raw_picture(width, height, seed)
    thumb = png(16, 10, lambda x, y: COLOURS[(x // 3 + seed) % 6]) if thumb is None else thumb
    packer = zlib.compressobj(6, zlib.DEFLATED, -(window or 15))
    packed = packer.compress(raw) + packer.flush()
    header = b"PG" + bytes([1, int(display)]) + struct.pack("<HBBII", len(thumb), window, 0, len(raw), zlib.crc32(raw) & 0xFFFFFFFF)
    return header + thumb + packed


def firmware_image(size=100_000, seed=1):
    """A file the web UI accepts as an ESP32-C6 application image (header, chip id, SHA-256)."""
    body = bytearray(random.Random(seed).randbytes(size - 32))
    body[0] = 0xE9  # ESP image magic
    struct.pack_into("<H", body, 12, 0x000D)  # chip id: ESP32-C6
    body[23] = 1  # SHA-256 appended
    struct.pack_into("<I", body, 32, 0xABCD5432)  # app description magic
    return bytes(body) + hashlib.sha256(body).digest()


def with_checksum(image):
    """Recomputes the appended SHA-256 after the content of a firmware image was changed."""
    body = bytes(image[:-32])
    return body + hashlib.sha256(body).digest()


def pixel_codes(image):
    """The set of 4 bit colour codes used in an image buffer of the device."""
    codes = set()
    for byte in set(image):
        codes.add(byte >> 4)
        codes.add(byte & 0x0F)
    return codes


def bmp_header(width, height, bits=24, top_down=False):
    """A BMP file header; the pixel data is not needed for the format check."""
    header = bytearray(64)
    header[0:2] = b"BM"
    struct.pack_into("<IiiHHI", header, 14, 40, width, -height if top_down else height, 1, bits, 0)
    return bytes(header)

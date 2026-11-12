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


def jpeg_header(width, height, progressive=False, sampling=0x22, components=3):
    """The headers of a JPEG up to the picture data: all the web UI reads to judge a file."""
    frame = struct.pack(">BHHB", 8, height, width, components)
    for index in range(components):
        frame += bytes([index + 1, sampling if index == 0 else 0x11, 0 if index == 0 else 1])
    marker = 0xC2 if progressive else 0xC0
    start_of_frame = bytes([0xFF, marker]) + struct.pack(">H", len(frame) + 2) + frame
    start_of_scan = bytes([0xFF, 0xDA, 0x00, 0x0C]) + bytes(10)
    return bytes([0xFF, 0xD8]) + start_of_frame + start_of_scan + bytes(64)


def bmp_header(width, height, bits=24, top_down=False):
    """A BMP file header; the pixel data is not needed for the format check."""
    header = bytearray(64)
    header[0:2] = b"BM"
    struct.pack_into("<IiiHHI", header, 14, 40, width, -height if top_down else height, 1, bits, 0)
    return bytes(header)

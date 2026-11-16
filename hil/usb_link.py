"""Client of the USB link of the offline firmware (src/usb_link.cpp, README "USB link").

The link carries the read / write / notify operations of the Bluetooth interface in frames on the
serial line. It only exists while the device is in setup mode.
"""

import json
import struct
import time
import zlib

import serial

from . import settings

START = b"\xa5\x5a"
HELLO, PING, BYE = 0x01, 0x02, 0x03
READ, WRITE, WRITE_NR = 0x10, 0x11, 0x12
NOTIFY, ERROR, ANSWER = 0x20, 0x7F, 0x80

STATUS_NO_SPACE = 0xFFFC
STATUS_DISPLAY_BUSY = 0xFFFD
STATUS_UPLOAD_ERROR = 0xFFFF
WINDOW = 32768


class UsbLinkError(RuntimeError):
    pass


def key_of(uuid):
    """The first 32 bits of a characteristic UUID."""
    return int(uuid[:8], 16)


def encode_frame(kind, seq, key=0, payload=b""):
    body = struct.pack("<BBHI", kind, seq, len(payload), key) + bytes(payload)
    return START + body + struct.pack("<I", zlib.crc32(body) & 0xFFFFFFFF)


def decode_frames(buffer):
    """Takes complete frames out of `buffer` (a bytearray) and returns them as (kind, seq, key, payload).
    Text between frames (the log of the device) is dropped."""
    frames = []
    while True:
        start = buffer.find(START)
        if start < 0:
            del buffer[:max(0, len(buffer) - 1)]
            return frames
        del buffer[:start]
        if len(buffer) < 10:
            return frames
        kind, seq, length, key = struct.unpack_from("<BBHI", buffer, 2)
        if length > settings.USB_LINK_MAX_PAYLOAD:
            del buffer[:2]  # not a frame
            continue
        end = 10 + length + 4
        if len(buffer) < end:
            return frames
        (crc,) = struct.unpack_from("<I", buffer, 10 + length)
        if crc != zlib.crc32(bytes(buffer[2:10 + length])) & 0xFFFFFFFF:
            del buffer[:2]
            continue
        frames.append((kind, seq, key, bytes(buffer[10:10 + length])))
        del buffer[:end]


class UsbLink:
    """One session. The serial port must be free (close the log reader of the test first)."""

    def __init__(self, port):
        self.port = port
        self.ser = None
        self.seq = 0
        self.buffer = bytearray()
        self.notifications = []
        self.hello = {}

    def __enter__(self):
        self.ser = serial.Serial(self.port, 115200, timeout=0.05)
        end = time.time() + 120  # a frame that shows the next picture first answers after the refresh
        answer = None
        while answer is None:
            if time.time() > end:
                raise UsbLinkError("The device did not answer HELLO: it is not in setup mode, or its firmware has no USB link.")
            self.ser.write(encode_frame(HELLO, 0))
            answer = self._wait(HELLO | ANSWER, 0, timeout=0.5, fail=False)
        self.hello = json.loads(answer)
        self.ser.flush()
        time.sleep(0.1)
        self.ser.baudrate = int(self.hello["baud"])
        self.buffer.clear()
        for _ in range(20):
            if self._request(PING, timeout=0.5, fail=False) is not None:
                return self
        raise UsbLinkError(f"No answer at {self.hello['baud']} baud.")

    def __exit__(self, exc_type, exc, tb):
        try:
            self.ser.write(encode_frame(BYE, 0))
            self.ser.flush()
            time.sleep(0.2)
        finally:
            self.ser.close()

    def _wait(self, kind, seq, timeout, fail=True):
        end = time.time() + timeout
        while True:
            self.buffer += self.ser.read(4096)
            for frame_kind, frame_seq, key, payload in decode_frames(self.buffer):
                if frame_kind == NOTIFY:
                    self.notifications.append((key, payload))
                elif frame_kind == ERROR and frame_seq == seq:
                    raise UsbLinkError(f"The device refused the request (characteristic {key:08x}).")
                elif frame_kind == kind and frame_seq == seq:
                    return payload
            if time.time() > end:
                if fail:
                    raise UsbLinkError(f"No answer to request 0x{kind & 0x7F:02x} within {timeout} s.")
                return None

    def _request(self, kind, key=0, payload=b"", timeout=30, fail=True):
        self.seq = (self.seq % 255) + 1
        self.ser.write(encode_frame(kind, self.seq, key, payload))
        return self._wait(kind | ANSWER, self.seq, timeout, fail)

    # --- characteristics --------------------------------------------------

    def read(self, uuid):
        return self._request(READ, key_of(uuid))

    def read_json(self, uuid):
        return json.loads(self.read(uuid).decode("utf-8"))

    def write(self, uuid, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._request(WRITE, key_of(uuid), data)

    def write_without_response(self, uuid, data):
        self.ser.write(encode_frame(WRITE_NR, 0, key_of(uuid), data))

    # --- commands and uploads ---------------------------------------------

    def status(self):
        return struct.unpack("<HIH", self.read(settings.CHR_UPLOAD_CMD))

    def command(self, text, busy_timeout=120):
        """Sends a command and returns (position, value, max payload). Waits while the display is refreshed."""
        end = time.time() + busy_timeout
        while True:
            self.write(settings.CHR_UPLOAD_CMD, text)
            status = self.status()
            if status[0] != STATUS_DISPLAY_BUSY:
                return status
            if time.time() > end:
                raise UsbLinkError(f"Display still busy after {busy_timeout} s ({text}).")
            time.sleep(2)

    def upload(self, start, data):
        """An upload as over Bluetooth (protocol V2), begun with the command `start`."""
        position, window_size, max_payload = self.command(start)
        if position == STATUS_NO_SPACE:
            raise UsbLinkError("Device has no room for this upload.")
        if position == STATUS_UPLOAD_ERROR:
            raise UsbLinkError(f"Device refused '{start}'.")
        self.command("V2")
        if not 1024 <= window_size <= WINDOW:
            window_size = WINDOW
        for offset in range(0, len(data), window_size):
            window = data[offset:offset + window_size]
            for attempt in range(5):
                for seq, start_byte in enumerate(range(0, len(window), max_payload)):
                    self.write_without_response(settings.CHR_UPLOAD_DATA, bytes([seq & 0xFF]) + window[start_byte:start_byte + max_payload])
                position, crc, _ = self.status()
                if position == len(window) and crc == zlib.crc32(window) & 0xFFFFFFFF:
                    break
                self.command("CLEAR")
            else:
                raise UsbLinkError(f"Window at offset {offset} could not be transferred.")
            if self.command("FLUSH")[0] == STATUS_UPLOAD_ERROR:
                raise UsbLinkError("Device reported a write error during the upload.")
        total = zlib.crc32(data) & 0xFFFFFFFF
        position, crc, _ = self.command(f"END:{total:08x}")
        if position == STATUS_UPLOAD_ERROR or crc != total:
            raise UsbLinkError("Device rejected the upload: CRC of the stored data does not match.")

    def gallery_put(self, container):
        picture_id = f"{zlib.crc32(container) & 0xFFFFFFFF:08x}"
        self.upload(f"GAL_PUT:{picture_id},{len(container)}", container)
        return picture_id

    def read_stream(self, what):
        position, length, _ = self.command(f"READ:{what}")
        if position == STATUS_UPLOAD_ERROR:
            raise UsbLinkError(f"Device cannot open '{what}'.")
        data = bytearray()
        while len(data) < length:
            chunk = self.read(settings.CHR_READ_DATA)
            if not chunk:
                raise UsbLinkError(f"Stream '{what}' ended after {len(data)} of {length} bytes.")
            data += chunk
        return bytes(data)

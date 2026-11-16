"""A device that exists only in the test process: the BLE interface of the offline firmware.

It follows src/main.cpp (CharacteristicCallbacks): the same characteristics, the same
limits, the same upload protocol (V2 with sequence numbers and window CRC, or the
legacy protocol of old builds for a firmware) and the gallery (picture files, play order,
read streams). The same operations are offered on the serial line (src/usb_link.cpp).
The hardware tests run the same web UI flows against a real device, which keeps this
model honest.

Faults can be switched on per test: lost packets, a flash error, a link that drops, a busy
display, a full storage.
"""

import asyncio
import json
import re
import struct
import zlib

SVC_DEVICE = "7f74170e-7b0e-11ed-a1eb-0242ac120002"
CHR_WIFI_CONNECTED = "4c578d4c-7b0e-11ed-a1eb-0242ac120002"
CHR_WIFI_INFO = "4c578d4d-7b0e-11ed-a1eb-0242ac120002"
CHR_WIFI_SCAN = "5131a3fc-7b0e-11ed-a1eb-0242ac120002"
CHR_SYSTEM_INFO = "60000001-7b0e-11ed-a1eb-0242ac120002"

SVC_WIFI = "0515c086-7b0c-11ed-a1eb-0242ac120002"
CHR_WIFI_SSID = "090b0ef2-7b0d-11ed-a1eb-0242ac120002"
CHR_WIFI_PASSWORD = "a62eed84-7b0d-11ed-a1eb-0242ac120002"

SVC_SETTINGS = "10000000-0000-0000-0000-000000000001"
CHR_URL = "10000001-0000-0000-0000-000000000001"
CHR_IMAGE_MODE = "10000002-0000-0000-0000-000000000001"
CHR_UPLOAD_DATA = "10000003-0000-0000-0000-000000000001"
CHR_UPLOAD_CMD = "10000004-0000-0000-0000-000000000001"
CHR_TIMEOUT = "10000005-0000-0000-0000-000000000001"
CHR_HTTP_USER = "10000007-0000-0000-0000-000000000001"
CHR_HTTP_PASSWORD = "10000008-0000-0000-0000-000000000001"
CHR_MOTION_WAKEUP = "10000009-0000-0000-0000-000000000001"
CHR_CHARGER_MODE = "1000000a-0000-0000-0000-000000000001"
CHR_SETTINGS_URL = "1000000b-0000-0000-0000-000000000001"
CHR_AUTO_ROTATION = "1000000c-0000-0000-0000-000000000001"
CHR_FW_VERSION = "1000000d-0000-0000-0000-000000000001"
CHR_GALLERY_STATE = "1000000e-0000-0000-0000-000000000001"
CHR_READ_DATA = "1000000f-0000-0000-0000-000000000001"

SERVICES = {
    SVC_DEVICE: (CHR_WIFI_CONNECTED, CHR_WIFI_INFO, CHR_WIFI_SCAN, CHR_SYSTEM_INFO),
    SVC_WIFI: (CHR_WIFI_SSID, CHR_WIFI_PASSWORD),
    SVC_SETTINGS: (
        CHR_URL, CHR_IMAGE_MODE, CHR_UPLOAD_DATA, CHR_UPLOAD_CMD, CHR_TIMEOUT, CHR_HTTP_USER,
        CHR_HTTP_PASSWORD, CHR_MOTION_WAKEUP, CHR_CHARGER_MODE, CHR_SETTINGS_URL,
        CHR_AUTO_ROTATION, CHR_FW_VERSION, CHR_GALLERY_STATE, CHR_READ_DATA,
    ),
}
WRITE_ONLY = (CHR_WIFI_PASSWORD, CHR_HTTP_PASSWORD, CHR_UPLOAD_DATA)

# Limits of the firmware (src/main.cpp)
MAX_SETTING_STRING_LEN = 128
MAX_WIFI_SSID_LEN = 32
MAX_WIFI_PASS_LEN = 64
MIN_SLEEP_TIMEOUT = 60
MAX_SLEEP_TIMEOUT = 2592000
BLE_BUFFER_SIZE = 32768
MIN_OTA_FW_SIZE = 65536
MAX_OTA_FW_SIZE = 0x1D0000

STATUS_UPLOAD_ERROR = 0xFFFF
STATUS_SEQ_ERROR = 0xFFFE
STATUS_DISPLAY_BUSY = 0xFFFD  # a gallery command refused: the display is being refreshed
STATUS_NO_SPACE = 0xFFFC
BAT_OFF_VALUE = 4000  # mV

# Gallery (src/types.h)
GALLERY_MAX_ITEMS = 400
GALLERY_HEADER_SIZE = 16
GALLERY_MAX_THUMB_SIZE = 8192
GALLERY_SIZE_MARGIN = 1024
GALLERY_READ_CHUNK = 500
GALLERY_WINDOW_BITS = 12  # window the web UI packs a picture with
STORAGE = {"epd7": ("flash", 15_600_000), "epd13": ("sd", 120_000_000)}  # kind, bytes for pictures
READ_COMMAND = re.compile(r"READ:(list|thumb:[0-9a-f]{8}|pic:[0-9a-f]{8})(?:,(\d+))?")

DISPLAYS = {"epd7": ("7", 800, 480), "epd13": ("13", 1200, 1600)}

# USB link (src/usb_link.cpp, src/usb_link.h)
USB_START = b"\xa5\x5a"
USB_HELLO, USB_PING, USB_BYE = 0x01, 0x02, 0x03
USB_READ, USB_WRITE, USB_WRITE_NR = 0x10, 0x11, 0x12
USB_NOTIFY, USB_ERROR, USB_ANSWER = 0x20, 0x7F, 0x80
USB_LINK_START_BAUD = 115200
USB_LINK_BAUD = 921600
USB_LINK_MAX_PAYLOAD = 512
USB_LINK_CHUNK = 496  # largest data packet of an upload over USB
BLE_CHUNK = 240

# Text settings: characteristic -> (key, maximum length)
TEXT_SETTINGS = {
    CHR_URL: ("url", MAX_SETTING_STRING_LEN),
    CHR_SETTINGS_URL: ("settings_url", MAX_SETTING_STRING_LEN),
    CHR_HTTP_USER: ("http_user", MAX_SETTING_STRING_LEN),
    CHR_HTTP_PASSWORD: ("http_password", MAX_SETTING_STRING_LEN),
}
SWITCH_SETTINGS = {
    CHR_MOTION_WAKEUP: "motion_wakeup",
    CHR_CHARGER_MODE: "charger_mode",
    CHR_AUTO_ROTATION: "auto_rotation",
}


def crc32(data):
    return zlib.crc32(bytes(data)) & 0xFFFFFFFF


def usb_frame(kind, seq, key=0, payload=b""):
    body = struct.pack("<BBHI", kind, seq, len(payload), key) + bytes(payload)
    return USB_START + body + struct.pack("<I", crc32(body))


def usb_frames(buffer):
    """Takes the complete frames out of `buffer` (a bytearray): (kind, seq, key, payload)."""
    frames = []
    while True:
        start = buffer.find(USB_START)
        if start < 0:
            del buffer[:max(0, len(buffer) - 1)]
            return frames
        del buffer[:start]
        if len(buffer) < 10:
            return frames
        kind, seq, length, key = struct.unpack_from("<BBHI", buffer, 2)
        end = 10 + length + 4
        if length > USB_LINK_MAX_PAYLOAD:
            del buffer[:2]  # not a frame
        elif len(buffer) < end:
            return frames
        elif struct.unpack_from("<I", buffer, 10 + length)[0] != crc32(buffer[2:10 + length]):
            del buffer[:2]
        else:
            frames.append((kind, seq, key, bytes(buffer[10:10 + length])))
            del buffer[:end]


def picture_id(container):
    """The id of a picture file: its CRC32 as 8 hex digits."""
    return f"{crc32(container):08x}"


def parse_container(container, display, image_bytes):
    """Checks a picture file as the firmware does and unpacks it: (thumb, raw). None if it is invalid."""
    if len(container) < GALLERY_HEADER_SIZE or container[:2] != b"PG" or container[2] != 1 or container[3] != int(display):
        return None
    thumb_len, _, raw_len, raw_crc = struct.unpack_from("<HHII", container, 4)
    if thumb_len > GALLERY_MAX_THUMB_SIZE or raw_len != image_bytes:
        return None
    if not GALLERY_HEADER_SIZE + thumb_len <= len(container) <= GALLERY_HEADER_SIZE + thumb_len + raw_len + GALLERY_SIZE_MARGIN:
        return None
    window = container[6] or 15  # of the deflate stream: the firmware unpacks with a buffer of that size
    if not 9 <= window <= 15:
        return None
    try:
        raw = zlib.decompress(bytes(container[GALLERY_HEADER_SIZE + thumb_len:]), wbits=-window)
    except zlib.error:
        return None
    if len(raw) != raw_len or crc32(raw) != raw_crc:
        return None
    return bytes(container[GALLERY_HEADER_SIZE:GALLERY_HEADER_SIZE + thumb_len]), raw


class GattError(Exception):
    """Becomes a DOMException with this name in the page."""

    def __init__(self, name, message):
        super().__init__(message)
        self.name = name


def factory_settings():
    return {
        "url": "", "settings_url": "", "http_user": "", "http_password": "", "timeout": 3600,
        "image_mode": 1, "motion_wakeup": False, "charger_mode": False, "auto_rotation": True,
    }


class SimulatedDevice:
    def __init__(self, target="epd7", version="0.1.0", name=None, legacy=False, gallery=True):
        self.target = target
        self.display, self.width, self.height = DISPLAYS[target]
        self.image_bytes = self.width * self.height // 2
        self.name = name or f"{target}-a1b2c3d4e5f6"
        self.version = version
        self.legacy = legacy  # old build: 2 byte status, CRC per packet, no version report
        self.gallery_supported = gallery and not legacy  # False: a firmware before the gallery

        self.settings = factory_settings()
        self.saved_settings = dict(self.settings)  # what SAVE_SETTINGS wrote to the EEPROM
        self.wifi_ssid = ""
        self.wifi_password = ""
        self.wifi_connected = False
        self.networks = {}  # ssid -> (password, rssi): the networks "in range"
        self.voltage = 4100
        self.usb = True
        self.setup_timeout = False  # the device announced the end of its setup mode
        self.display_busy_commands = 0  # number of gallery commands refused because the display is refreshing
        self.notify_limit = None  # bytes a notification carries (MTU - 3), None = unlimited
        self._display_busy = False

        # Gallery
        self.pictures = {}  # id -> picture file
        self.order = []  # ids in play order
        self.shuffle = False
        self.auto = True
        self.current = ""  # id of the picture on the display
        self.rev = 1
        self.storage, self.storage_total = STORAGE[target]

        # Records for the assertions of a test
        self.commands = []
        self.chooser_filters = None
        self.shown = []  # ids of GAL_SHOW, in order
        self.firmware = None  # firmware accepted by END_FW
        self.connections = 0
        self.connected = False

        # USB link
        self.usb_awake = True  # in setup mode: the device answers HELLO
        self.usb_session = False
        self.usb_sessions = 0
        self.usb_port_missing = False  # the port chooser offers no port (driver missing)
        self.port_filters = None
        self.serial_open = False
        self.serial_received = bytearray()  # bytes outside of frames (bootloader command, ...)
        self._serial_baud = 0  # speed of the PC side
        self._usb_baud = USB_LINK_START_BAUD  # speed of the device side
        self._usb_rx = bytearray()
        self._chunk = BLE_CHUNK

        # Faults
        self.chooser_cancelled = False
        self.drop_packets = 0  # number of data packets to lose (one per window, from now on)
        self.fail_flash = False  # flash write fails at the next FLUSH
        self.drop_link_after = None  # close the link after this many data packets
        self.window_size = BLE_BUFFER_SIZE  # receive buffer of a gallery upload: smaller if memory is short
        self.drop_link_at_pictures = None  # close the link during the upload that follows this many stored pictures
        self.reject_firmware_size = False
        self.packet_delay = 0.0  # seconds per data packet: slows an upload down

        self.emit = None  # set by the harness: async (event dict) -> None
        self._subscribed = set()
        self._tasks = set()
        self._data_packets = 0
        self._read_stream = b""  # the stream opened by READ:...
        self._read_pos = 0
        self._reset_upload()

    # --- helpers ----------------------------------------------------------

    def _reset_upload(self):
        self._put = None  # (id, size) of the picture file that is being uploaded
        self._order_count = None  # number of ids of the play order that is being uploaded
        self._fw_open = False
        self._command_error = None  # status code of the last command, None = done
        self._v2 = False
        self._upload_error = False
        self._seq_error = False
        self._expected_seq = 0
        self._expected_fw_bytes = 0
        self._buffer = bytearray()
        self._stored = bytearray()
        self._final_crc = 0
        self._buffer_overflow = False
        self._dropped_in_window = False

    def _later(self, delay, coro_factory):
        async def run():
            await asyncio.sleep(delay)
            await coro_factory()

        task = asyncio.get_running_loop().create_task(run())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _notify(self, uuid):
        if self.connected and uuid in self._subscribed and self.emit:
            await self.emit({"type": "notify", "uuid": uuid, "data": self._value(uuid)[:self.notify_limit]})
        if self.usb_session:
            await self._usb_send(USB_NOTIFY, 0, int(uuid[:8], 16), self._value(uuid))

    async def drop_link(self):
        """The device closes the connection (reboot, reset, out of range)."""
        self._usb_end()
        if not self.connected:
            return
        self.connected = False
        self._subscribed.clear()
        if self.emit:
            await self.emit({"type": "disconnected"})

    async def unplug_usb(self):
        """The USB cable is pulled."""
        self._usb_end()
        self.serial_open = False
        if self.emit:
            await self.emit({"type": "serial_lost"})

    def system_info(self):
        info = {"voltage": self.voltage, "usb": self.usb, "charging": False, "display": self.display}
        if not self.legacy:
            info.update(version=self.version, fw="offline")
        if self.gallery_supported:
            info["gallery"] = 1
        if self.setup_timeout:
            info["setupTimeout"] = True
        return info

    async def end_setup_mode(self):
        """On battery power the firmware ends the setup mode when the client is idle for too long
        (SETUP_IDLE_TIMEOUT): it announces that in the system info and then stops Bluetooth."""
        self.setup_timeout = True
        await self._notify(CHR_SYSTEM_INFO)
        self._later(0.5, self.drop_link)

    # --- gallery: what a test puts on the device and looks at ----------------

    def add_picture(self, container):
        """Stores a picture file as if it had been uploaded earlier. Returns its id."""
        pid = picture_id(container)
        if pid not in self.pictures:
            self.order.append(pid)
        self.pictures[pid] = bytes(container)
        self.rev += 1
        return pid

    def picture(self, pid):
        """(thumb, raw) of a stored picture."""
        return parse_container(self.pictures[pid], self.display, self.image_bytes)

    @property
    def used(self):
        return sum(len(data) for data in self.pictures.values())

    def gallery_state(self):
        return {
            "count": len(self.pictures), "used": self.used, "free": max(0, self.storage_total - self.used),
            "total": self.storage_total, "storage": self.storage, "shuffle": int(self.shuffle), "auto": int(self.auto),
            "current": self.current, "rev": self.rev,
        }

    def gallery_list(self):
        items = [[pid, len(self.pictures[pid]), struct.unpack_from("<H", self.pictures[pid], 4)[0]] for pid in self.order]
        return json.dumps({"items": items}, separators=(",", ":")).encode("utf-8")

    async def _gallery_changed(self, list_changed=True):
        if list_changed:
            self.rev += 1
        await self._notify(CHR_GALLERY_STATE)

    def scan_result(self):
        return "".join(f"{ssid}´{rssi}´´" for ssid, (_, rssi) in self.networks.items())

    def _value(self, uuid):
        s = self.settings
        text = {
            CHR_URL: s["url"],
            CHR_SETTINGS_URL: s["settings_url"],
            CHR_HTTP_USER: s["http_user"],
            CHR_TIMEOUT: str(s["timeout"]),
            CHR_IMAGE_MODE: str(s["image_mode"]),
            CHR_MOTION_WAKEUP: "1" if s["motion_wakeup"] else "0",
            CHR_CHARGER_MODE: "1" if s["charger_mode"] else "0",
            CHR_AUTO_ROTATION: "1" if s["auto_rotation"] else "0",
            CHR_FW_VERSION: self.version,
            CHR_WIFI_SSID: self.wifi_ssid,
            CHR_WIFI_SCAN: self.scan_result(),
            CHR_SYSTEM_INFO: json.dumps(self.system_info()),
            CHR_GALLERY_STATE: json.dumps(self.gallery_state(), separators=(",", ":")),
            CHR_WIFI_INFO: (
                json.dumps({"ip": "192.168.4.23", "rssi": self.networks.get(self.wifi_ssid, ("", -61))[1], "ssid": self.wifi_ssid})
                if self.wifi_connected else "{}"
            ),
        }
        if uuid == CHR_WIFI_CONNECTED:
            return bytes([1 if self.wifi_connected else 0])
        if uuid == CHR_UPLOAD_CMD:
            return self._status()
        if uuid == CHR_READ_DATA:
            chunk = self._read_stream[self._read_pos:self._read_pos + GALLERY_READ_CHUNK]
            self._read_pos += len(chunk)
            return bytes(chunk)
        return text[uuid].encode("utf-8")

    @property
    def _upload_open(self):
        return self._put is not None or self._order_count is not None or self._fw_open

    def _status(self):
        position = STATUS_UPLOAD_ERROR if self._upload_error else STATUS_SEQ_ERROR if self._seq_error else len(self._buffer)
        if self._command_error is not None:
            position = self._command_error
        if self._display_busy:
            position = STATUS_DISPLAY_BUSY
        if self.legacy:
            return struct.pack("<H", position)
        value = 0
        if position < STATUS_NO_SPACE:
            if self._buffer:
                value = crc32(self._buffer)
            elif not self._upload_open:
                value = self._final_crc  # CRC of the stored file, or the length of the opened stream
            else:
                value = BLE_BUFFER_SIZE if self._fw_open else self.window_size  # how much a window takes
        return struct.pack("<HIH", position, value, self._chunk)

    def _exists(self, uuid):
        if self.legacy and uuid == CHR_FW_VERSION:
            return False
        if not self.gallery_supported and uuid in (CHR_GALLERY_STATE, CHR_READ_DATA):
            return False
        return any(uuid in chars for chars in SERVICES.values())

    # --- bridge -----------------------------------------------------------

    async def handle(self, op, args):
        if op == "request_device":
            self.chooser_filters = args.get("filters")
            if self.chooser_cancelled:
                raise GattError("NotFoundError", "User cancelled the requestDevice() chooser.")
            return {"name": self.name}
        if op == "connect":
            self.connected = True
            self.connections += 1
            return {}
        if op == "disconnect":
            self.connected = False
            self._subscribed.clear()
            return {}
        if op == "request_port":
            self.port_filters = args.get("filters")
            if self.usb_port_missing:
                raise GattError("NotFoundError", "No port selected by the user.")
            return {}
        if op == "serial_open":
            self.serial_open = True
            self._serial_baud = args["baud"]
            self._usb_rx = bytearray()
            return {}
        if op == "serial_close":
            self.serial_open = False
            return {}
        if op == "serial_write":
            await self._serial_write(args["data"])
            return {}
        if not self.connected:
            raise GattError("NetworkError", "GATT Server is disconnected. Cannot perform GATT operations.")
        if op == "has_service":
            return {"exists": args["uuid"] in SERVICES}
        if op == "has_characteristic":
            return {"exists": args["uuid"] in SERVICES.get(args["service"], ()) and self._exists(args["uuid"])}
        if op == "subscribe":
            self._subscribed.add(args["uuid"])
            return {}
        if op == "read":
            if args["uuid"] in WRITE_ONLY:
                raise GattError("NotSupportedError", "GATT operation not permitted.")
            return {"data": self._value(args["uuid"])}
        if op == "write":
            await self._write(args["uuid"], args["data"])
            return {}
        raise GattError("NotSupportedError", f"Unknown operation {op}")

    # --- USB link -----------------------------------------------------------

    def _usb_end(self):
        self.usb_session = False
        self._usb_baud = USB_LINK_START_BAUD
        self._chunk = BLE_CHUNK

    async def _usb_send(self, kind, seq, key=0, payload=b"", log=b""):
        """A frame to the PC. Log text of the firmware shares the line with the frames."""
        if self.serial_open and self._serial_baud == self._usb_baud and self.emit:
            await self.emit({"type": "serial", "data": log + usb_frame(kind, seq, key, payload)})

    async def _serial_write(self, data):
        if not self.serial_open or self._serial_baud != self._usb_baud:
            return  # wrong speed: the device sees noise
        if not self.usb_session and USB_START[0] not in data and not self._usb_rx:
            self.serial_received += data
        self._usb_rx += data
        for kind, seq, key, payload in usb_frames(self._usb_rx):
            await self._usb_frame(kind, seq, key, payload)

    async def _usb_frame(self, kind, seq, key, payload):
        if kind == USB_HELLO:
            if not self.usb_awake:
                return
            info = json.dumps({"proto": 1, "name": self.name, "baud": USB_LINK_BAUD}, separators=(",", ":"))
            await self._usb_send(USB_HELLO | USB_ANSWER, seq, 0, info.encode("utf-8"), log=b"[USB] Session started\r\n")
            self._usb_baud = USB_LINK_BAUD
            self._chunk = USB_LINK_CHUNK
            if not self.usb_session:
                self.usb_sessions += 1
            self.usb_session = True
            return
        if not self.usb_session:
            return
        if kind == USB_PING:
            await self._usb_send(USB_PING | USB_ANSWER, seq)
            return
        if kind == USB_BYE:
            self._usb_end()
            return

        uuid = next((u for chars in SERVICES.values() for u in chars if int(u[:8], 16) == key and self._exists(u)), None)
        readable = kind == USB_READ and uuid not in WRITE_ONLY
        if uuid is None or not (readable or kind in (USB_WRITE, USB_WRITE_NR)):
            if kind != USB_WRITE_NR:
                await self._usb_send(USB_ERROR, seq, key, b"\x01")
            return
        if kind == USB_READ:
            await self._usb_send(USB_READ | USB_ANSWER, seq, key, self._value(uuid), log=b"[BLE] read\r\n" if uuid == CHR_SYSTEM_INFO else b"")
            return
        try:
            await self._write(uuid, payload)
        except GattError:
            return  # the device is gone: no answer
        if kind == USB_WRITE and self.usb_session:
            await self._usb_send(USB_WRITE | USB_ANSWER, seq, key, b"\x00")

    async def _write(self, uuid, data):
        if uuid == CHR_UPLOAD_DATA:
            await self._upload_data(data)
            return
        text = data.decode("utf-8", errors="replace")
        if uuid == CHR_UPLOAD_CMD:
            self.commands.append(text)
            await self._command(text)
        elif uuid in TEXT_SETTINGS:
            key, limit = TEXT_SETTINGS[uuid]
            if len(data) <= limit:  # longer values are ignored by the firmware
                self.settings[key] = text
                if uuid == CHR_URL and text:
                    self.settings["image_mode"] = 1
        elif uuid in SWITCH_SETTINGS:
            self.settings[SWITCH_SETTINGS[uuid]] = text in ("1", "true")
        elif uuid == CHR_TIMEOUT:
            if text.strip().lstrip("-").isdigit() and MIN_SLEEP_TIMEOUT <= int(text) <= MAX_SLEEP_TIMEOUT:
                self.settings["timeout"] = int(text)
        elif uuid == CHR_IMAGE_MODE:
            if text in ("0", "1"):
                self.settings["image_mode"] = int(text)
        elif uuid == CHR_WIFI_SSID:
            if len(data) <= MAX_WIFI_SSID_LEN:
                self.wifi_ssid = text
        elif uuid == CHR_WIFI_PASSWORD:
            if len(data) <= MAX_WIFI_PASS_LEN:
                self.wifi_password = text
                self._later(0.6, self._join_wifi)
        else:
            raise GattError("NotSupportedError", "GATT operation not permitted.")

    async def _join_wifi(self):
        known = self.networks.get(self.wifi_ssid)
        self.wifi_connected = bool(known) and known[0] == self.wifi_password
        await self._notify(CHR_WIFI_CONNECTED)
        await self._notify(CHR_WIFI_INFO)

    # --- upload (picture file, play order, firmware) -----------------------

    async def _upload_data(self, data):
        self._data_packets += 1
        if self.packet_delay:
            await asyncio.sleep(self.packet_delay)
        if self.drop_link_after is not None and self._data_packets > self.drop_link_after:
            self.drop_link_after = None
            await self.drop_link()
            raise GattError("NetworkError", "GATT Server is disconnected. Cannot perform GATT operations.")
        if self.drop_link_at_pictures is not None and self._put and len(self.pictures) >= self.drop_link_at_pictures and len(self._buffer) > 4000:
            self.drop_link_at_pictures = None
            await self.drop_link()
            raise GattError("NetworkError", "GATT Server is disconnected. Cannot perform GATT operations.")
        if not self._upload_open or self._upload_error:
            return
        if self.drop_packets and not self._dropped_in_window and self._expected_seq == 3:
            self.drop_packets -= 1
            self._dropped_in_window = True
            return  # lost on the air: the next packet arrives with the wrong sequence number

        if self._v2:
            if self._seq_error or len(data) <= 1:
                return
            if data[0] != self._expected_seq:
                self._seq_error = True
                return
            self._expected_seq = (self._expected_seq + 1) & 0xFF
            payload = data[1:]
        else:
            if len(data) <= 4:
                return
            payload = data[4:]
            if struct.unpack_from("<I", data)[0] != crc32(payload):
                self._seq_error = True
                return
            self._expected_seq += 1
        if len(self._buffer) + len(payload) <= (BLE_BUFFER_SIZE if self._fw_open else self.window_size):
            self._buffer += payload
        else:
            self._seq_error = True

    def _flush(self):
        """Moves the RAM buffer into the storage / OTA partition. False on error."""
        if not self._buffer:
            return True
        if self._fw_open:
            if not self._stored and self._buffer[0] != 0xE9:
                return False
            if self._expected_fw_bytes and len(self._stored) + len(self._buffer) > self._expected_fw_bytes:
                return False
        if self.fail_flash:
            self.fail_flash = False
            return False
        self._stored += self._buffer
        self._buffer = bytearray()
        self._expected_seq = 0
        self._dropped_in_window = False
        return True

    async def _command(self, cmd):
        if cmd == "SCAN_WIFI":
            self._later(0.4, lambda: self._notify(CHR_WIFI_SCAN))
        elif cmd == "V2":
            self._v2 = not self.legacy
        elif cmd.startswith(("GAL_", "READ:")):
            if not self.gallery_supported:
                return  # a firmware before the gallery does not know these commands
            if self.display_busy_commands > 0:
                self.display_busy_commands -= 1
                self._display_busy = True
                return
            self._display_busy = False
            self._reset_upload()
            await self._gallery_command(cmd)
        elif cmd == "START_FW" or cmd.startswith("START_FW:"):
            self._reset_upload()
            self._fw_open = True
        elif cmd.startswith("FW_SIZE:"):
            size = int(cmd[8:]) if cmd[8:].isdigit() else 0
            if not self._fw_open or self._stored or not MIN_OTA_FW_SIZE <= size <= MAX_OTA_FW_SIZE or self.reject_firmware_size:
                self._fw_open = False
                self._upload_error = True
            else:
                self._expected_fw_bytes = size
        elif cmd == "FLUSH":
            if self._seq_error or self._upload_error or not self._flush():
                self._upload_error = True
        elif cmd == "CLEAR":
            self._buffer = bytearray()
            self._expected_seq = 0
            self._seq_error = False
            self._dropped_in_window = False
        elif cmd == "END" or cmd.startswith("END:"):
            await self._end_gallery_upload(int(cmd[4:], 16) if cmd.startswith("END:") and len(cmd) > 4 else None)
        elif cmd == "END_FW" or cmd.startswith("END_FW:"):
            await self._end_firmware(int(cmd[7:], 16) if cmd.startswith("END_FW:") and len(cmd) > 7 else None)
        elif cmd == "SAVE_SETTINGS":
            self.saved_settings = dict(self.settings)
        elif cmd == "RESET":
            self.settings = factory_settings()
            self.saved_settings = dict(self.settings)
            self.wifi_ssid = self.wifi_password = ""
            self.wifi_connected = False
            self.pictures, self.order, self.current = {}, [], ""
            self.shuffle, self.auto = False, True
            self._later(0.2, self.drop_link)  # the device restarts
        # EXIT_SETUP: nothing to model, it is recorded in self.commands

    async def _gallery_command(self, cmd):
        name, _, arg = cmd.partition(":")
        known = re.fullmatch(r"[0-9a-f]{8}", arg) is not None and arg in self.pictures
        if name == "GAL_PUT":
            pid, _, size = arg.partition(",")
            size = int(size) if size.isdigit() else 0
            limit = GALLERY_HEADER_SIZE + GALLERY_MAX_THUMB_SIZE + self.image_bytes + GALLERY_SIZE_MARGIN
            free = self.storage_total - self.used + len(self.pictures.get(pid, b""))
            if not re.fullmatch(r"[0-9a-f]{8}", pid) or not GALLERY_HEADER_SIZE <= size <= limit:
                self._command_error = STATUS_UPLOAD_ERROR
            elif size > free or (pid not in self.pictures and len(self.pictures) >= GALLERY_MAX_ITEMS):
                self._command_error = STATUS_NO_SPACE
            else:
                self._put = (pid, size)
        elif name == "GAL_ORDER":
            if arg.isdigit() and int(arg) <= GALLERY_MAX_ITEMS:
                self._order_count = int(arg)
            else:
                self._command_error = STATUS_UPLOAD_ERROR
        elif name == "GAL_DEL":
            if known:
                del self.pictures[arg]
                self.order.remove(arg)
                await self._gallery_changed()
        elif name == "GAL_CLEAR":
            self.pictures, self.order = {}, []
            await self._gallery_changed()
        elif name == "GAL_SET":
            values = arg.split(",")
            if len(values) == 2 and all(v in ("0", "1") for v in values):
                self.shuffle, self.auto = values[0] == "1", values[1] == "1"
                await self._gallery_changed(list_changed=False)
            else:
                self._command_error = STATUS_UPLOAD_ERROR
        elif name == "GAL_SHOW":
            if known:
                self.current = arg
                self.shown.append(arg)
                self.settings["image_mode"] = 0
                self.saved_settings = dict(self.settings)
                await self._gallery_changed(list_changed=False)
            else:
                self._command_error = STATUS_UPLOAD_ERROR
        elif name == "READ":
            match = READ_COMMAND.fullmatch(cmd)
            what = match.group(1) if match else ""
            if what == "list":
                stream = self.gallery_list()
            elif what[-8:] in self.pictures:
                data = self.pictures[what[-8:]]
                stream = data if what.startswith("pic:") else data[GALLERY_HEADER_SIZE:GALLERY_HEADER_SIZE + struct.unpack_from("<H", data, 4)[0]]
            else:
                self._command_error = STATUS_UPLOAD_ERROR
                return
            self._read_stream = stream
            self._read_pos = min(int(match.group(2) or 0), len(stream))
            self._final_crc = len(stream)
        else:
            self._command_error = STATUS_UPLOAD_ERROR

    async def _end_gallery_upload(self, expected_crc):
        ok = (self._put is not None or self._order_count is not None) and not self._upload_error and not self._seq_error and self._flush()
        stored = bytes(self._stored)
        ok = ok and expected_crc is not None and crc32(stored) == expected_crc
        put, order_count = self._put, self._order_count
        self._put = self._order_count = None
        self._buffer = bytearray()
        if ok and put is not None:
            pid, size = put
            ok = len(stored) == size and picture_id(stored) == pid and parse_container(stored, self.display, self.image_bytes) is not None
            if ok:
                if pid not in self.pictures:
                    self.order.append(pid)  # a new picture goes to the end of the order
                self.pictures[pid] = stored
        elif ok:
            ok = len(stored) == 4 * order_count
            if ok:
                listed = [f"{value:08x}" for value in struct.unpack(f"<{order_count}I", stored)]
                listed = [pid for pid in dict.fromkeys(listed) if pid in self.pictures]
                self.order = listed + [pid for pid in self.order if pid not in listed]
        if not ok:
            self._upload_error = True
            return
        self._final_crc = crc32(stored)
        await self._gallery_changed()

    async def _end_firmware(self, expected_crc):
        ok = self._fw_open and not self._upload_error and not self._seq_error and self._flush()
        ok = ok and len(self._stored) >= MIN_OTA_FW_SIZE
        ok = ok and (not self._expected_fw_bytes or len(self._stored) == self._expected_fw_bytes)
        ok = ok and (expected_crc is None or crc32(self._stored) == expected_crc)
        self._fw_open = False
        self._buffer = bytearray()
        if not ok:
            self._upload_error = True
            return
        self._final_crc = crc32(self._stored)
        self.firmware = bytes(self._stored)
        if self.legacy:
            await self.drop_link()  # old builds restart inside the write callback
            raise GattError("NetworkError", "GATT Server is disconnected. Cannot perform GATT operations.")
        self._later(1.5, self.drop_link)  # current firmware reboots shortly after answering

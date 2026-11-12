"""A device that exists only in the test process: the BLE interface of the offline firmware.

It follows src/main.cpp (CharacteristicCallbacks): the same characteristics, the same
limits and the same upload protocol (V2 with sequence numbers and window CRC, or the
legacy protocol of old builds). The hardware tests run the same web UI flows against a
real device, which keeps this model honest.

Faults can be switched on per test: lost packets, a flash error, a link that drops.
"""

import asyncio
import json
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

SERVICES = {
    SVC_DEVICE: (CHR_WIFI_CONNECTED, CHR_WIFI_INFO, CHR_WIFI_SCAN, CHR_SYSTEM_INFO),
    SVC_WIFI: (CHR_WIFI_SSID, CHR_WIFI_PASSWORD),
    SVC_SETTINGS: (
        CHR_URL, CHR_IMAGE_MODE, CHR_UPLOAD_DATA, CHR_UPLOAD_CMD, CHR_TIMEOUT, CHR_HTTP_USER,
        CHR_HTTP_PASSWORD, CHR_MOTION_WAKEUP, CHR_CHARGER_MODE, CHR_SETTINGS_URL,
        CHR_AUTO_ROTATION, CHR_FW_VERSION,
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

DISPLAYS = {"epd7": ("7", 800, 480), "epd13": ("13", 1200, 1600)}

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
    def __init__(self, target="epd7", version="0.1.0", name=None, legacy=False):
        self.target = target
        self.display, self.width, self.height = DISPLAYS[target]
        self.image_bytes = self.width * self.height // 2
        self.name = name or f"{target}-a1b2c3d4e5f6"
        self.version = version
        self.legacy = legacy  # old build: 2 byte status, CRC per packet, no version report

        self.settings = factory_settings()
        self.saved_settings = dict(self.settings)  # what SAVE_SETTINGS wrote to the EEPROM
        self.wifi_ssid = ""
        self.wifi_password = ""
        self.wifi_connected = False
        self.networks = {}  # ssid -> (password, rssi): the networks "in range"
        self.voltage = 4100
        self.usb = True

        # Records for the assertions of a test
        self.commands = []
        self.chooser_filters = None
        self.image = None  # last complete image accepted by END
        self.displayed = None  # image shown after APPLY
        self.firmware = None  # firmware accepted by END_FW
        self.connections = 0
        self.connected = False

        # Faults
        self.chooser_cancelled = False
        self.drop_packets = 0  # number of data packets to lose (one per window, from now on)
        self.fail_flash = False  # flash write fails at the next FLUSH
        self.drop_link_after = None  # close the link after this many data packets
        self.reject_firmware_size = False
        self.packet_delay = 0.0  # seconds per data packet: slows an upload down

        self.emit = None  # set by the harness: async (event dict) -> None
        self._subscribed = set()
        self._tasks = set()
        self._data_packets = 0
        self._reset_upload()

    # --- helpers ----------------------------------------------------------

    def _reset_upload(self):
        self._image_open = False
        self._fw_open = False
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
            await self.emit({"type": "notify", "uuid": uuid, "data": self._value(uuid)})

    async def drop_link(self):
        """The device closes the connection (reboot, reset, out of range)."""
        if not self.connected:
            return
        self.connected = False
        self._subscribed.clear()
        if self.emit:
            await self.emit({"type": "disconnected"})

    def system_info(self):
        info = {"voltage": self.voltage, "usb": self.usb, "charging": False, "display": self.display}
        if not self.legacy:
            info.update(version=self.version, fw="offline")
        return info

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
            CHR_WIFI_INFO: (
                json.dumps({"ip": "192.168.4.23", "rssi": self.networks.get(self.wifi_ssid, ("", -61))[1], "ssid": self.wifi_ssid})
                if self.wifi_connected else "{}"
            ),
        }
        if uuid == CHR_WIFI_CONNECTED:
            return bytes([1 if self.wifi_connected else 0])
        if uuid == CHR_UPLOAD_CMD:
            return self._status()
        return text[uuid].encode("utf-8")

    def _status(self):
        position = STATUS_UPLOAD_ERROR if self._upload_error else STATUS_SEQ_ERROR if self._seq_error else len(self._buffer)
        if self.legacy:
            return struct.pack("<H", position)
        crc = 0
        if not self._upload_error and not self._seq_error:
            if self._buffer:
                crc = crc32(self._buffer)
            elif not self._image_open and not self._fw_open:
                crc = self._final_crc
        return struct.pack("<HIH", position, crc, 240)

    def _exists(self, uuid):
        if self.legacy and uuid == CHR_FW_VERSION:
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

    # --- upload (image and firmware) --------------------------------------

    async def _upload_data(self, data):
        self._data_packets += 1
        if self.packet_delay:
            await asyncio.sleep(self.packet_delay)
        if self.drop_link_after is not None and self._data_packets > self.drop_link_after:
            self.drop_link_after = None
            await self.drop_link()
            raise GattError("NetworkError", "GATT Server is disconnected. Cannot perform GATT operations.")
        if not (self._image_open or self._fw_open) or self._upload_error:
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
        if len(self._buffer) + len(payload) <= BLE_BUFFER_SIZE:
            self._buffer += payload
        else:
            self._seq_error = True

    def _flush(self):
        """Moves the RAM buffer into the flash slot / OTA partition. False on error."""
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
        elif cmd == "START":
            self._reset_upload()
            self._image_open = True
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
            self._end_image(int(cmd[4:], 16) if cmd.startswith("END:") and len(cmd) > 4 else None)
        elif cmd == "END_FW" or cmd.startswith("END_FW:"):
            await self._end_firmware(int(cmd[7:], 16) if cmd.startswith("END_FW:") and len(cmd) > 7 else None)
        elif cmd == "APPLY":
            self.displayed = self.image
        elif cmd == "SAVE_SETTINGS":
            self.saved_settings = dict(self.settings)
        elif cmd == "RESET":
            self.settings = factory_settings()
            self.saved_settings = dict(self.settings)
            self.wifi_ssid = self.wifi_password = ""
            self.wifi_connected = False
            self.image = self.displayed = None
            self._later(0.2, self.drop_link)  # the device restarts
        # EXIT_SETUP: nothing to model, it is recorded in self.commands

    def _end_image(self, expected_crc):
        ok = self._image_open and not self._upload_error and not self._seq_error and self._flush()
        ok = ok and len(self._stored) == self.image_bytes
        ok = ok and (expected_crc is None or crc32(self._stored) == expected_crc)
        self._image_open = False
        self._buffer = bytearray()
        if ok:
            self._final_crc = crc32(self._stored)
            self.image = bytes(self._stored)
            self.settings["image_mode"] = 0
            self.saved_settings = dict(self.settings)
        else:
            self._upload_error = True

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

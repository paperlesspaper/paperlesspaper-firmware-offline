"""The same limits and identifiers are written down in several places. They must agree.

    firmware           src/main.cpp, src/types.h, src/epaper_display.h, src/usb_link.*, part.csv
    web UI             web/src/app.js (DEVICE_LIMITS), web/src/DeviceBleInterface.js, web/src/usbLink.js
    simulated device   webtest/simdevice.py
    hardware tests     hil/settings.py

A limit that differs between firmware and web UI is a bug a user meets: the page accepts a
value the device silently ignores. A difference to the simulated device makes the browser
tests check something the firmware does not do.

Only files are read here: no browser, no hardware.
"""

import os
import re

import pytest

from webtest import simdevice

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def read(path):
    with open(os.path.join(REPO_ROOT, *path.split("/")), "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def number(text):
    return int(text.rstrip("uUlL"), 0)


def firmware_define(name):
    """Value of `#define NAME <number>` in the firmware sources."""
    for path in ("src/main.cpp", "src/types.h"):
        match = re.search(rf"^\s*#define\s+{name}\s+(0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*)\b", read(path), re.MULTILINE)
        if match:
            return number(match.group(1))
    pytest.fail(
        f"{name} is no longer written as `#define {name} <number>` in src/main.cpp or src/types.h. "
        "If it was renamed or moved, adjust webtest/test_consistency.py."
    )


def web_limit(key):
    """Value of DEVICE_LIMITS.<key> in web/src/app.js."""
    block = re.search(r"const DEVICE_LIMITS = \{(.*?)\};", read("web/src/app.js"), re.DOTALL)
    match = re.search(rf"\b{key}:\s*(\d+)", block.group(1)) if block else None
    if not match:
        pytest.fail(f"DEVICE_LIMITS.{key} was not found in web/src/app.js. If it was renamed, adjust webtest/test_consistency.py.")
    return int(match.group(1))


def assignment(path, name, pattern=r"^{name} = (0[xX][0-9a-fA-F]+|\d+)"):
    match = re.search(pattern.format(name=name), read(path), re.MULTILINE)
    if not match:
        pytest.fail(f"{name} was not found in {path}. If it was renamed, adjust webtest/test_consistency.py.")
    return number(match.group(1))


def assert_equal(name, values):
    """`values` maps the place a number is written down to the number."""
    assert len(set(values.values())) == 1, f"{name} differs: " + ", ".join(f"{place} = {value}" for place, value in values.items())


# firmware constant -> key in DEVICE_LIMITS of the web UI
LIMITS = {
    "MAX_WIFI_SSID_LEN": "wifiSsidBytes",
    "MAX_WIFI_PASS_LEN": "wifiPassBytes",
    "MAX_SETTING_STRING_LEN": "settingStringBytes",
    "MIN_SLEEP_TIMEOUT": "timeoutMin",
    "MAX_SLEEP_TIMEOUT": "timeoutMax",
    "BAT_OFF_VALUE": "batteryOffMv",
}


@pytest.mark.parametrize("name", LIMITS)
def test_setting_limit(name):
    assert_equal(name, {
        "firmware": firmware_define(name),
        f"web UI (DEVICE_LIMITS.{LIMITS[name]})": web_limit(LIMITS[name]),
        "simulated device": getattr(simdevice, name),
    })


GALLERY_CONSTANTS = [
    "GALLERY_MAX_ITEMS", "GALLERY_HEADER_SIZE", "GALLERY_MAX_THUMB_SIZE", "GALLERY_SIZE_MARGIN",
    "STATUS_NO_SPACE", "STATUS_DISPLAY_BUSY", "STATUS_SEQ_ERROR", "STATUS_UPLOAD_ERROR",
]


@pytest.mark.parametrize("name", GALLERY_CONSTANTS)
def test_gallery_constant(name):
    """Limits of a picture file and the status codes of the gallery commands."""
    assert_equal(name, {
        "firmware": firmware_define(name),
        "web UI (galleryFormat.js)": assignment("web/src/galleryFormat.js", name, r"^export const {name} = (0[xX][0-9a-fA-F]+|\d+)"),
        "simulated device": getattr(simdevice, name),
    })


def test_gallery_window():
    """The window a picture is packed with decides how much memory the device needs to unpack it."""
    web = assignment("web/src/galleryFormat.js", "GALLERY_WINDOW_BITS", r"^export const {name} = (\d+)")
    assert_equal("GALLERY_WINDOW_BITS", {"web UI (galleryFormat.js)": web, "simulated device": simdevice.GALLERY_WINDOW_BITS})
    assert 9 <= web <= 12, "Above 12 the device needs more than 4 KB in one piece, which the 13.3 inch frame may not have."


def test_gallery_read_chunk():
    assert_equal("GALLERY_READ_CHUNK", {
        "firmware": firmware_define("GALLERY_READ_CHUNK"),
        "simulated device": simdevice.GALLERY_READ_CHUNK,
    })


def test_gallery_picture_formats():
    """Display type and picture size of a picture file: web UI and simulated device."""
    source = read("web/src/galleryFormat.js")
    web = {m.group(1): (int(m.group(2)), int(m.group(3))) for m in re.finditer(r"^\s*(\d+): \{ width: (\d+), height: (\d+)", source, re.MULTILINE)}
    simulated = {display: (width, height) for display, width, height in simdevice.DISPLAYS.values()}
    assert web == simulated, f"Picture formats differ: web UI {web}, simulated device {simulated}."


def test_upload_buffer_size():
    assert_equal("BLE_BUFFER_SIZE", {
        "firmware": firmware_define("BLE_BUFFER_SIZE"),
        "simulated device": simdevice.BLE_BUFFER_SIZE,
    })


def test_firmware_size_limits():
    js_constant = r"^export const {name} = (0[xX][0-9a-fA-F]+|\d+)"
    assert_equal("MAX_OTA_FW_SIZE", {
        "firmware": firmware_define("MAX_OTA_FW_SIZE"),
        "web UI": assignment("web/src/DeviceBleInterface.js", "MAX_OTA_FW_SIZE", js_constant),
        "simulated device": simdevice.MAX_OTA_FW_SIZE,
        "hardware tests": assignment("hil/settings.py", "MAX_OTA_FW_SIZE"),
    })
    # The firmware has no named constant for the lower limit (65536 is written inline).
    assert_equal("MIN_OTA_FW_SIZE", {
        "web UI": assignment("web/src/DeviceBleInterface.js", "MIN_OTA_FW_SIZE", js_constant),
        "simulated device": simdevice.MIN_OTA_FW_SIZE,
        "hardware tests": assignment("hil/settings.py", "MIN_OTA_FW_SIZE"),
    })


def test_firmware_fits_the_ota_partitions():
    sizes = {}
    for line in read("part.csv").splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) >= 5 and fields[0] in ("app0", "app1"):
            sizes[fields[0]] = number(fields[4])
    assert set(sizes) == {"app0", "app1"}, f"app0 and app1 were not both found in part.csv: {sizes}"
    limit = firmware_define("MAX_OTA_FW_SIZE")
    assert limit <= min(sizes.values()), f"MAX_OTA_FW_SIZE ({limit:#x}) is larger than an OTA partition in part.csv ({sizes})."


def test_usb_flash_addresses_match_the_partition_table():
    """Flashing over USB writes to fixed addresses. A firmware that is written to app0 only starts
    if otadata is reset as well: after an update over the air the device starts app1."""
    partitions = {}
    for line in read("part.csv").splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) >= 5 and not fields[0].startswith("#"):
            partitions[fields[0]] = (number(fields[3]), number(fields[4]))
    js_constant = r"^const {name} = (0[xX][0-9a-fA-F]+|\d+)"
    web = {name: assignment("web/src/app.js", name, js_constant)
           for name in ("APP_ADDRESS", "OTADATA_ADDRESS", "OTADATA_SIZE", "SPIFFS_ADDRESS", "SPIFFS_SIZE")}
    assert web["APP_ADDRESS"] == partitions["app0"][0]
    assert (web["OTADATA_ADDRESS"], web["OTADATA_SIZE"]) == partitions["otadata"]
    assert (web["SPIFFS_ADDRESS"], web["SPIFFS_SIZE"]) == partitions["spiffs"]
    assert "address: OTADATA_ADDRESS" in read("web/src/app.js"), "flashSerial() no longer resets otadata."
    # the hardware test flashes over USB with the same addresses
    for name in ("APP_ADDRESS", "OTADATA_ADDRESS", "OTADATA_SIZE"):
        assert assignment("hil/settings.py", name) == web[name], f"{name} differs between hil/settings.py and web/src/app.js."


def test_picture_sizes():
    """Bytes of a picture per display: 4 bit per pixel. (The web UI is checked against the
    simulated device by the upload tests.)"""
    header = read("src/epaper_display.h")
    widths = re.findall(r"^\s*#define\s+EPD_WIDTH\s+(\d+)", header, re.MULTILINE)
    heights = re.findall(r"^\s*#define\s+EPD_HEIGHT\s+(\d+)", header, re.MULTILINE)
    assert widths and len(widths) == len(heights), "EPD_WIDTH / EPD_HEIGHT are no longer defined in pairs in src/epaper_display.h."
    firmware = sorted(int(w) * int(h) // 2 for w, h in zip(widths, heights))
    simulated = sorted(width * height // 2 for _, width, height in simdevice.DISPLAYS.values())
    assert firmware == simulated, f"Picture sizes differ: firmware {firmware} bytes, simulated device {simulated} bytes."


def constant(path, pattern, name):
    match = re.search(pattern.format(name=name), read(path), re.MULTILINE)
    if not match:
        pytest.fail(f"{name} was not found in {path}. If it was renamed, adjust webtest/test_consistency.py.")
    return number(match.group(1))


C_DEFINE = r"^\s*#define\s+{name}\s+(0[xX][0-9a-fA-F]+|\d+)"
C_CONST = r"^\s*const \w+ {name} = (0[xX][0-9a-fA-F]+|\d+);"
JS_CONST = r"^(?:export )?const {name} = (0[xX][0-9a-fA-F]+|\d+);"
PY_CONST = r"^{name} = (0[xX][0-9a-fA-F]+|\d+)"


def test_usb_link_limits():
    """Speed, largest payload and session timeout of the USB link."""
    assert_equal("USB_LINK_BAUD", {
        "src/usb_link.h": constant("src/usb_link.h", C_DEFINE, "USB_LINK_BAUD"),
        "webtest/simdevice.py": simdevice.USB_LINK_BAUD,
        "hil/settings.py": constant("hil/settings.py", PY_CONST, "USB_LINK_BAUD"),
    })
    assert_equal("USB_LINK_MAX_PAYLOAD", {
        "src/usb_link.h": constant("src/usb_link.h", C_DEFINE, "USB_LINK_MAX_PAYLOAD"),
        "web/src/usbLink.js": constant("web/src/usbLink.js", JS_CONST, "USB_LINK_MAX_PAYLOAD"),
        "webtest/simdevice.py": simdevice.USB_LINK_MAX_PAYLOAD,
        "hil/settings.py": constant("hil/settings.py", PY_CONST, "USB_LINK_MAX_PAYLOAD"),
    })
    timeout = constant("src/usb_link.h", C_DEFINE, "USB_LINK_SESSION_TIMEOUT")
    assert_equal("USB_LINK_SESSION_TIMEOUT", {
        "src/usb_link.h": timeout,
        "web/src/usbLink.js": constant("web/src/usbLink.js", JS_CONST, "USB_LINK_SESSION_TIMEOUT"),
    })
    keep_alive = constant("web/src/usbLink.js", JS_CONST, "KEEP_ALIVE_MS")
    assert keep_alive * 2 < timeout * 1000, "The page must send a frame well before the device ends the session."
    assert simdevice.USB_LINK_CHUNK + 1 <= simdevice.USB_LINK_MAX_PAYLOAD, "A data packet (sequence number + data) must fit into a frame."


@pytest.mark.parametrize("name", ["HELLO", "PING", "BYE", "READ", "WRITE", "WRITE_NR", "NOTIFY", "ERROR", "ANSWER"])
def test_usb_link_frame_type(name):
    assert_equal(f"frame type {name}", {
        "src/usb_link.cpp": constant("src/usb_link.cpp", C_CONST, f"TYPE_{name}"),
        "web/src/usbLink.js": constant("web/src/usbLink.js", JS_CONST, f"TYPE_{name}"),
        "webtest/simdevice.py": getattr(simdevice, f"USB_{name}"),
    })


def test_usb_link_frame_start():
    firmware = bytes(constant("src/usb_link.cpp", C_CONST, f"START_{i}") for i in (0, 1))
    web = bytes(constant("web/src/usbLink.js", JS_CONST, f"START_{i}") for i in (0, 1))
    assert firmware == web == simdevice.USB_START


def uuids_in(path):
    return {uuid.lower() for uuid in UUID.findall(read(path))}


@pytest.mark.parametrize("place, used", [
    ("web/src/DeviceBleInterface.js", None),
    ("hil/settings.py", None),
    ("webtest/simdevice.py", {uuid for service, chars in simdevice.SERVICES.items() for uuid in (service, *chars)}),
])
def test_ble_identifiers_exist_in_the_firmware(place, used):
    """Every service and characteristic the web UI and the tests use must be offered by the firmware."""
    firmware = uuids_in("src/main.cpp")
    assert firmware, "No BLE identifiers found in src/main.cpp."
    used = used if used is not None else uuids_in(place)
    assert used, f"No BLE identifiers found in {place}."
    unknown = sorted(used - firmware)
    assert not unknown, f"{place} uses BLE identifiers the firmware does not offer: {unknown}"

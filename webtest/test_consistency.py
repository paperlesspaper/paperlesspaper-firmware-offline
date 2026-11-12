"""The same limits and identifiers are written down in several places. They must agree.

    firmware           src/main.cpp, src/types.h, src/epaper_display.h, part.csv
    web UI             web/src/app.js (DEVICE_LIMITS), web/src/DeviceBleInterface.js
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
}


@pytest.mark.parametrize("name", LIMITS)
def test_setting_limit(name):
    assert_equal(name, {
        "firmware": firmware_define(name),
        f"web UI (DEVICE_LIMITS.{LIMITS[name]})": web_limit(LIMITS[name]),
        "simulated device": getattr(simdevice, name),
    })


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

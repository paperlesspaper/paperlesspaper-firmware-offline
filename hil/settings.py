"""Configuration of the offline firmware HIL tests.

Port, relay and device assignment come from the cloud testbench
(hardware_mapping.json / environment), everything else is defined here.
"""

import os
from dataclasses import dataclass

from .cloud import cloud_config

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _env_int(name, default):
    return int(os.environ.get(name, str(default)))


@dataclass(frozen=True)
class Target:
    name: str  # "epd7" / "epd13"
    display: str  # value of "display" in the BLE system info
    width: int
    height: int
    relay_off_seconds: float  # the 13" board holds its voltage longer

    @property
    def image_bytes(self):
        return self.width * self.height // 2

    @property
    def port(self):
        return getattr(cloud_config, f"{self.name.upper()}_COM_PORT")

    @property
    def relay_port(self):
        return getattr(cloud_config, f"{self.name.upper()}_RELAY_PORT")

    @property
    def other_relay_port(self):
        other = "EPD13" if self.name == "epd7" else "EPD7"
        return getattr(cloud_config, f"{other}_RELAY_PORT")

    @property
    def device_id(self):
        return getattr(cloud_config, f"{self.name.upper()}_DEVICE_ID")

    @property
    def candidate_bin(self):
        return os.environ.get(
            f"OFFLINE_CANDIDATE_{self.name.upper()}",
            os.path.join(REPO_ROOT, ".pio", "build", self.name, "firmware.bin"),
        )

    @property
    def cloud_manifest_url(self):
        return getattr(cloud_config, f"PRODUCTION_MANIFEST_URL_{self.name.upper()}")


TARGETS = {
    "epd7": Target("epd7", "7", 800, 480, 1.0),
    "epd13": Target("epd13", "13", 1600, 1200, 1.5),
}

# Version the candidate reports in "[MAIN] INIT Device V: ..." (set by the workflow).
EXPECTED_CANDIDATE_VERSION = os.environ.get("OFFLINE_CANDIDATE_VERSION", "")

# Firmware timing (src/main.cpp)
STARTUP_COUNTER_WINDOW = 3.0  # counter of quick button presses is cleared after 3 s
SETUP_MODE_TIMEOUT = 30  # setup mode ends after 30 s without BLE connection
FACTORY_RESET_PRESSES = 5

# Timeouts in seconds
BOOT_TIMEOUT = _env_int("HIL_BOOT_TIMEOUT", 20)
BLE_READY_TIMEOUT = _env_int("HIL_BLE_READY_TIMEOUT", 30)
BLE_FW_UPLOAD_TIMEOUT = _env_int("HIL_BLE_FW_UPLOAD_TIMEOUT", 1500)
REFRESH_TIMEOUT = _env_int("HIL_RENDER_TIMEOUT", 240)

LOCK_TIMEOUT = _env_int("HIL_LOCK_TIMEOUT", 3600)
LOCK_FILE = os.environ.get("HIL_LOCK_FILE", "")

# BLE GATT (src/main.cpp, BleInit)
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

OFFLINE_SERVICES = (SVC_DEVICE, SVC_WIFI, SVC_SETTINGS)
OFFLINE_CHARACTERISTICS = (
    CHR_WIFI_CONNECTED, CHR_WIFI_INFO, CHR_WIFI_SCAN, CHR_SYSTEM_INFO,
    CHR_WIFI_SSID, CHR_WIFI_PASSWORD,
    CHR_URL, CHR_IMAGE_MODE, CHR_UPLOAD_DATA, CHR_UPLOAD_CMD, CHR_TIMEOUT,
    CHR_HTTP_USER, CHR_HTTP_PASSWORD, CHR_MOTION_WAKEUP, CHR_CHARGER_MODE,
    CHR_SETTINGS_URL, CHR_AUTO_ROTATION, CHR_FW_VERSION,
)

# Factory defaults after a reset (resetAll / initFirstBoot)
DEFAULT_TIMEOUT = "3600"
DEFAULT_IMAGE_MODE = "1"

MIN_OTA_FW_SIZE = 65536
MAX_OTA_FW_SIZE = 0x1D0000

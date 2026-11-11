"""HIL lifecycle of the offline firmware on one device.

The tests run in order and build on each other. The hardware is shared with
the cloud firmware testbench, whose runs expect the cloud production firmware
on the device: test_00 installs the offline candidate whatever is on the
device, test_99 always puts the cloud production firmware back.
"""

import os

import pytest

from . import settings
from .ble_client import BleSession, ble_run, upload_firmware
from .cloud import cloud_config, fetch_production_firmware


def _require_candidate(run_state):
    if not run_state.get("candidate_running"):
        pytest.skip("Candidate firmware is not running (test_00 failed).")


def _flash_over_ble(device, firmware_path):
    """Flashes a firmware over BLE and returns the boot info of the new firmware."""
    since = device.log_position()
    protocol = upload_firmware(device.uid, firmware_path)
    print(f"✅ [{device.target.name}] Firmware transferred ({protocol} protocol), waiting for reboot...")
    return device.wait_for_reboot(since, timeout=90)


def test_00_install_candidate(device, target, run_state):
    """Flashes the candidate over BLE, from the cloud firmware or from an offline firmware."""
    assert os.path.isfile(target.candidate_bin), f"Candidate firmware not found: {target.candidate_bin}"

    start = device.identify()
    run_state["start_firmware"] = start.firmware

    if start.firmware == "cloud":
        # The cloud firmware only offers BLE after a factory reset.
        device.factory_reset_cloud()
    else:
        device.enter_setup_mode()

    booted = _flash_over_ble(device, target.candidate_bin)

    assert booted.firmware == "offline", "Device did not boot the offline firmware after the update."
    if settings.EXPECTED_CANDIDATE_VERSION:
        assert booted.version == settings.EXPECTED_CANDIDATE_VERSION, (
            f"Device runs V{booted.version}, expected candidate V{settings.EXPECTED_CANDIDATE_VERSION}."
        )
    run_state["candidate_version"] = booted.version
    run_state["candidate_running"] = True


def test_01_factory_reset(device, run_state):
    """Five quick button presses reset all settings to their defaults."""
    _require_candidate(run_state)

    booted = device.factory_reset_offline()
    assert booted.firmware == "offline"
    assert booted.version == run_state["candidate_version"]

    device.enter_setup_mode()

    async def read_settings():
        async with BleSession(device.uid) as ble:
            return {
                "timeout": await ble.read_text(settings.CHR_TIMEOUT),
                "image_mode": await ble.read_text(settings.CHR_IMAGE_MODE),
                "url": await ble.read_text(settings.CHR_URL),
                "settings_url": await ble.read_text(settings.CHR_SETTINGS_URL),
                "ssid": await ble.read_text(settings.CHR_WIFI_SSID),
                "http_user": await ble.read_text(settings.CHR_HTTP_USER),
            }

    assert ble_run(read_settings()) == {
        "timeout": settings.DEFAULT_TIMEOUT,
        "image_mode": settings.DEFAULT_IMAGE_MODE,
        "url": "",
        "settings_url": "",
        "ssid": "",
        "http_user": "",
    }


def test_02_gatt_contract(device, target, run_state):
    """The BLE interface the Web-UI relies on is complete and reports this device correctly."""
    _require_candidate(run_state)
    device.enter_setup_mode()

    async def inspect():
        async with BleSession(device.uid) as ble:
            return {
                "name": ble.advertised_name,
                "services": ble.service_uuids(),
                "characteristics": ble.characteristic_uuids(),
                "system": await ble.read_system_info(),
                "fw_version": await ble.read_text(settings.CHR_FW_VERSION),
                "status": await ble.status(),
            }

    found = ble_run(inspect())

    assert found["name"] == device.uid
    assert set(settings.OFFLINE_SERVICES) <= found["services"]
    missing = set(settings.OFFLINE_CHARACTERISTICS) - found["characteristics"]
    assert not missing, f"Characteristics missing: {sorted(missing)}"

    system = found["system"]
    assert system["fw"] == "offline"
    assert system["display"] == target.display
    assert system["version"] == run_state["candidate_version"]
    assert found["fw_version"] == run_state["candidate_version"]
    assert system["usb"] is True
    assert isinstance(system["voltage"], int) and system["voltage"] > 0
    assert found["status"].is_v2, "Upload status must be the 8 byte V2 format."


def test_99_restore_cloud_firmware(device, target):
    """Leaves the device as the cloud testbench expects it: cloud production firmware.

    Runs even if earlier tests failed.
    """
    current = device.identify()
    bin_path, cloud_version = fetch_production_firmware(target.cloud_manifest_url, cache_dir=cloud_config.CACHE_DIR)

    if current.firmware == "cloud":
        print(f"ℹ️ [{target.name}] Device already runs the cloud firmware V{current.version}.")
        return

    # Clear the offline settings first, so no test WiFi or URL stays in the EEPROM.
    device.enter_setup_mode()
    since = device.log_position()

    async def reset_settings():
        async with BleSession(device.uid) as ble:
            try:
                await ble.command("RESET")
            except Exception:
                pass  # the device restarts inside the write callback

    ble_run(reset_settings())
    device.wait_for(r"\[MAIN\] Reset - WIFI 1", timeout=15)
    device.wait_for_reboot(since, timeout=30)

    device.enter_setup_mode()
    booted = _flash_over_ble(device, bin_path)

    assert booted.firmware == "cloud", "Device still runs the offline firmware after the restore."
    assert booted.version == cloud_version, f"Device runs V{booted.version}, expected cloud production V{cloud_version}."

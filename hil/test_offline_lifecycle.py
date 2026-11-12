"""HIL lifecycle of the offline firmware on one device.

The tests run in order and build on each other. The hardware is shared with
the cloud firmware testbench, whose runs expect the cloud production firmware
on the device: test_00 installs the offline candidate whatever is on the
device, test_99 always puts the cloud production firmware back.

test_10 to test_13 use the device through the web UI: the built page (web/dist)
runs in a headless browser and reaches the device over the PC's Bluetooth
(hil/web_bridge.py).
"""

import os

import pytest

from . import settings
from .ble_client import BleSession, ble_run, upload_firmware
from .cloud import cloud_config, fetch_production_firmware
from .web_bridge import web_ui


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

    probe = "hil-probe-pw"

    async def inspect():
        async with BleSession(device.uid) as ble:
            # Passwords are write-only: a stored password must not come back over BLE.
            await ble.write_text(settings.CHR_HTTP_PASSWORD, probe)
            password_reads = {
                uuid: await ble.try_read(uuid) for uuid in (settings.CHR_HTTP_PASSWORD, settings.CHR_WIFI_PASSWORD)
            }
            await ble.write_text(settings.CHR_HTTP_PASSWORD, "")
            return {
                "password_reads": password_reads,
                "password_properties": {uuid: ble.characteristic_properties(uuid) for uuid in password_reads},
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

    for uuid, properties in found["password_properties"].items():
        assert "write" in properties and "read" not in properties, f"Password characteristic {uuid} must be write-only."
    for uuid, value in found["password_reads"].items():
        assert not value, f"Password characteristic {uuid} returned {len(value)} bytes on read."

    system = found["system"]
    assert system["fw"] == "offline"
    assert system["display"] == target.display
    assert system["version"] == run_state["candidate_version"]
    assert found["fw_version"] == run_state["candidate_version"]
    assert system["usb"] is True
    assert isinstance(system["voltage"], int) and system["voltage"] > 0
    assert found["status"].is_v2, "Upload status must be the 8 byte V2 format."


# --- the device through the web UI ----------------------------------------

WEB_URL = "http://frame.invalid/picture.bmp"
WEB_SETTINGS = {
    "#settingUrl": WEB_URL,
    "#settingTimeout": "900",
    "#settingSettingsUrl": "http://frame.invalid/settings.json",
    "#settingHttpAuthUser": "hil-user",
}


def test_10_web_ui_shows_the_device(device, target, run_state):
    """The web UI of this build connects and shows what the device reports."""
    _require_candidate(run_state)
    version = run_state["candidate_version"]

    async def body():
        async with web_ui(device) as (app, bridge, site):
            shown = {
                "expected": (await app.text("#expectedOfflineFwBadge")).lstrip("v"),
                "firmware": await app.text("#systemFwVersion"),
                "name_shown": device.uid in await app.text("#systemDeviceName"),
                "display": await app.text("#displayBadge"),
                "display_locked": await app.locator("#displaySizeSelect").is_disabled(),
                "warning_hidden": await app.page.evaluate("document.getElementById('firmwareVersionWarning').hidden"),
                "voltage": await app.text("#systemVoltage"),
            }
            await app.view("geraet")
            shown["timeout"] = await app.page.input_value("#settingTimeout")
            shown["url"] = await app.page.input_value("#settingUrl")
            await app.disconnect()
            return shown

    shown = ble_run(body(), timeout=240)

    # Web UI and firmware of one build belong together: no update warning for its own firmware.
    assert shown["expected"] == version, f"The web UI expects V{shown['expected']}, the candidate is V{version}."
    assert shown["firmware"] == f"v{version} ✓"
    assert shown["warning_hidden"]
    assert shown["name_shown"], "The web UI does not show the name of the device."
    assert shown["display"].startswith('13.3"' if target.name == "epd13" else '7.3"')
    assert shown["display_locked"]
    assert " V" in shown["voltage"]
    assert (shown["timeout"], shown["url"]) == (settings.DEFAULT_TIMEOUT, ""), "Settings after the factory reset."
    device.wait_for(r"\[BLE\] EXIT_SETUP received", timeout=10)


def test_11_web_ui_saves_settings(device, run_state):
    """Settings saved in the web UI survive a power cycle and are shown again on the next connection."""
    _require_candidate(run_state)

    async def save():
        async with web_ui(device) as (app, bridge, site):
            await app.view("geraet")
            for selector, value in WEB_SETTINGS.items():
                await app.page.fill(selector, value)
            await app.page.fill("#settingHttpAuthPassword", "hil-probe-pw")
            await app.click("#btnSaveSettings")
            await app.wait_status("Einstellungen gespeichert")
            return list(bridge.commands)

    assert "SAVE_SETTINGS" in ble_run(save(), timeout=240)
    device.wait_for(r"\[BLE\] SAVE_SETTINGS received", timeout=10)

    async def read_back():  # web_ui() power-cycles the device into setup mode again
        async with web_ui(device) as (app, bridge, site):
            await app.view("geraet")
            values = {selector: await app.page.input_value(selector) for selector in WEB_SETTINGS}
            values["password"] = await app.page.input_value("#settingHttpAuthPassword")
            return values

    values = ble_run(read_back(), timeout=240)
    assert values.pop("password") == "", "The web UI must not show a stored password."
    assert values == WEB_SETTINGS


def test_12_web_ui_uploads_a_picture(device, target, run_state):
    """A picture prepared in the browser reaches the flash of the device unchanged and is displayed."""
    _require_candidate(run_state)
    from webtest import assets

    width, height = (1200, 1600) if target.name == "epd13" else (800, 480)
    image_bytes = width * height // 2

    async def body():
        async with web_ui(device) as (app, bridge, site):
            await app.load_image(assets.test_picture(width // 2, height // 2))
            result = await app.transfer(lambda: app.click("#btnUploadImage"), timeout=600000)
            return result, await app.status(), list(bridge.commands)

    result, status, commands = ble_run(body(), timeout=900)
    assert result is None, f"The web UI reported a failed upload: {result}"
    assert "Upload abgeschlossen" in status
    assert commands[-1] == "APPLY" and commands[-2].startswith("END:"), f"Unexpected end of the upload: {commands[-3:]}"
    sent_crc = int(commands[-2][4:], 16)

    ended = device.wait_for(r"\[BLE\] Upload ENDED\. Bytes: (\d+), FlashCRC: 0x([0-9A-Fa-f]{8}) \((\w+)\)", timeout=30)
    assert ended.group(3) == "OK", "The device rejected the picture."
    assert int(ended.group(1)) == image_bytes
    assert int(ended.group(2), 16) == sent_crc, "The picture in the flash differs from what the browser sent."

    # What the display driver reads from the slot is the same picture.
    slot = device.wait_for(r"\[IMAGE\] Slot CRC: 0x([0-9A-Fa-f]{8}) \(.*?(\d+) bytes\)", timeout=60)
    assert (int(slot.group(1), 16), int(slot.group(2))) == (sent_crc, image_bytes)
    device.wait_for(r"\[EPD\] Set Image Done", timeout=settings.REFRESH_TIMEOUT)


def test_13_web_ui_updates_the_firmware(device, target, run_state):
    """The firmware update of the web UI: the page loads the offline firmware published next to it
    and installs it over BLE."""
    _require_candidate(run_state)
    files = {f"firmware_offline_{target.name}.bin": target.candidate_bin}
    since = {}

    async def body():
        async with web_ui(device, files=files) as (app, bridge, site):
            since["log"] = device.log_position()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            selected = await app.page.input_value("#offlineOtaDeviceSelect")
            result = await app.transfer(
                lambda: app.click("#btnConfirmOfflineOta"), timeout=settings.BLE_FW_UPLOAD_TIMEOUT * 1000
            )
            return selected, result, list(bridge.commands)

    selected, result, commands = ble_run(body(), timeout=settings.BLE_FW_UPLOAD_TIMEOUT + 300)
    assert selected == target.name, "The web UI offers the firmware of another device type."
    assert result and result[0] == "Firmware installiert", f"The web UI reported: {result}"
    assert commands[2] == f"FW_SIZE:{os.path.getsize(target.candidate_bin)}"

    booted = device.wait_for_reboot(since["log"], timeout=90)
    assert booted.firmware == "offline"
    assert booted.version == run_state["candidate_version"]


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

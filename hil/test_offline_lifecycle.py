"""HIL lifecycle of the offline firmware on one device.

The tests run in order and build on each other. The hardware is shared with
the cloud firmware testbench, whose runs expect the cloud production firmware
on the device: test_00 installs the offline candidate whatever is on the
device, test_99 always puts the cloud production firmware back.

test_10 to test_13 use the device through the web UI: the built page (web/dist)
runs in a headless browser and reaches the device over the PC's Bluetooth
(hil/web_bridge.py). test_14 flashes over USB with esptool, with the steps of the web UI.
test_15 uses the web UI over the USB cable.
"""

import json
import os
import time

import pytest

from . import settings
from .ble_client import BleError, BleSession, ble_run, upload_firmware
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


def _replace_leftover_firmware(device, firmware_path):
    """As _flash_over_ble(), for an offline firmware that a failed run left on the device. If it does not
    take an update over BLE, it is replaced over USB: the bench must not get stuck on it."""
    try:
        return _flash_over_ble(device, firmware_path)
    except BleError as err:
        print(f"⚠️ [{device.target.name}] The firmware on the device refused the update over BLE ({err}). Flashing over USB.")
        device.enter_bootloader()
        return device.flash_over_usb(firmware_path)


def test_00_install_candidate(device, target, run_state):
    """Flashes the candidate over BLE, from the cloud firmware or from an offline firmware."""
    assert os.path.isfile(target.candidate_bin), f"Candidate firmware not found: {target.candidate_bin}"

    start = device.identify()
    run_state["start_firmware"] = start.firmware

    if start.firmware == "cloud":
        # The cloud firmware only offers BLE after a factory reset.
        device.factory_reset_cloud()
        booted = _flash_over_ble(device, target.candidate_bin)
    else:
        device.enter_setup_mode()
        booted = _replace_leftover_firmware(device, target.candidate_bin)

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


def _picture_size(target):
    """Width and height of a picture row by row (the 13.3" display is used upright)."""
    return (1200, 1600) if target.name == "epd13" else (800, 480)


def test_03_gallery(device, target, run_state):
    """Pictures are stored, listed and read back unchanged and shown on request. Two presses of the
    button show the next one at once, one press after 10 s without a connection."""
    _require_candidate(run_state)
    from webtest import assets

    containers = [assets.gallery_container(target.display, *_picture_size(target), seed=seed) for seed in (1, 2)]
    device.enter_setup_mode()

    async def fill():
        async with BleSession(device.uid) as ble:
            await ble.gallery_command("GAL_CLEAR")
            ids = [await ble.gallery_put(container) for container in containers]
            await ble.gallery_order([ids[1], ids[0]])
            await ble.gallery_command("GAL_SET:0,1")
            found = {
                "ids": ids,
                "list": await ble.gallery_list(),
                "picture": await ble.read_stream(f"pic:{ids[0]}"),
                "preview": await ble.read_stream(f"thumb:{ids[0]}"),
                "state": await ble.gallery_state(),
            }
            found["show"] = (await ble.gallery_command(f"GAL_SHOW:{ids[1]}")).position
            return found

    found = ble_run(fill(), timeout=900)
    ids = found["ids"]
    preview_len = int.from_bytes(containers[0][4:6], "little")
    assert [entry[0] for entry in found["list"]] == [ids[1], ids[0]], "The play order was not stored."
    assert [entry[1] for entry in found["list"]] == [len(containers[1]), len(containers[0])]
    assert found["picture"] == containers[0], "The picture file read back differs from the one sent."
    assert found["preview"] == containers[0][16:16 + preview_len]
    assert found["state"]["count"] == 2
    assert found["state"]["storage"] == ("sd" if target.name == "epd13" else "flash")
    assert (found["state"]["shuffle"], found["state"]["auto"]) == (0, 1)
    assert found["show"] == 0, "The device refused to show the picture."

    device.wait_for(rf"\[GALLERY\] Showing \S*{ids[1]}", timeout=60)
    shown = device.wait_for(r"\[EPD\] Set Image Done: (-?\d+)", timeout=settings.REFRESH_TIMEOUT)
    assert shown.group(1) == "0", "The picture was not displayed."

    # Two presses skip the setup mode and show the next picture of the order.
    device.press(2)
    device.wait_for(rf"\[GALLERY\] Showing \S*{ids[0]}", timeout=60)
    shown = device.wait_for(r"\[EPD\] Set Image Done: (-?\d+)", timeout=settings.REFRESH_TIMEOUT)
    assert shown.group(1) == "0", "The next picture was not displayed."

    # One press and nobody connects: the next picture follows after 10 s.
    device.press(1)
    pressed = time.time()
    device.wait_for(rf"\[GALLERY\] Showing \S*{ids[1]}", timeout=60)
    waited = time.time() - pressed
    shown = device.wait_for(r"\[EPD\] Set Image Done: (-?\d+)", timeout=settings.REFRESH_TIMEOUT)
    assert shown.group(1) == "0", "The picture after one press was not displayed."
    assert waited >= 8, f"The picture changed {waited:.0f} s after the press: no time to connect first."


def test_04_usb_link(device, target, run_state):
    """The USB serial line offers what Bluetooth offers: settings, uploads, downloads and showing a
    picture. The session survives the display refresh, and a connected client keeps the picture."""
    _require_candidate(run_state)
    from webtest import assets

    from .usb_link import STATUS_DISPLAY_BUSY, UsbLink

    container = assets.gallery_container(target.display, *_picture_size(target), seed=3)
    device.enter_setup_mode()
    device.ctrl.disconnect()  # the session needs the serial port
    try:
        with UsbLink(target.port) as link:
            found = {
                "hello": dict(link.hello),
                "system": link.read_json(settings.CHR_SYSTEM_INFO),
                "before": link.read_json(settings.CHR_GALLERY_STATE),
            }
            link.write(settings.CHR_TIMEOUT, "1800")
            found["timeout"] = link.read(settings.CHR_TIMEOUT).decode()
            link.write(settings.CHR_TIMEOUT, settings.DEFAULT_TIMEOUT)
            try:
                picture_id = link.gallery_put(container)
                found["picture"] = link.read_stream(f"pic:{picture_id}")
                found["list"] = [entry[0] for entry in json.loads(link.read_stream("list"))["items"]]
                # The session goes on after a display refresh; the new state is notified at its end.
                link.notifications.clear()
                found["show"] = link.command(f"GAL_SHOW:{picture_id}")[0]
                shown = link.wait_notification(settings.CHR_GALLERY_STATE, settings.REFRESH_TIMEOUT)
                found["shown"] = json.loads(shown.decode("utf-8"))
                # A client is connected: the press that started the setup mode shows no other picture.
                time.sleep(1)
                link.write(settings.CHR_UPLOAD_CMD, "GAL_SET:0,1")
                found["busy"] = link.status()[0] == STATUS_DISPLAY_BUSY
            finally:
                link.command("GAL_CLEAR")  # the tests of the web UI start with an empty gallery
            found["after"] = link.read_json(settings.CHR_GALLERY_STATE)
    finally:
        device.ctrl.connect(retries=20, retry_delay=0.5)

    assert found["hello"]["name"] == device.uid
    assert found["system"]["fw"] == "offline" and found["system"]["version"] == run_state["candidate_version"]
    assert found["before"]["count"] == 2, "The pictures of the Bluetooth test are missing."
    assert found["timeout"] == "1800"
    assert found["picture"] == container, "The picture file read back over USB differs from the one sent."
    assert picture_id in found["list"] and len(found["list"]) == 3
    assert found["show"] == 0, "The device refused to show the picture."
    assert found["shown"]["current"] == picture_id
    assert not found["busy"], "The device showed the next picture although a client was connected."
    assert found["after"]["count"] == 0


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
            await app.url_settings()
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
            await app.url_settings()
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
            await app.url_settings()
            values = {selector: await app.page.input_value(selector) for selector in WEB_SETTINGS}
            values["password"] = await app.page.input_value("#settingHttpAuthPassword")
            return values

    values = ble_run(read_back(), timeout=240)
    assert values.pop("password") == "", "The web UI must not show a stored password."
    assert values == WEB_SETTINGS


def test_12_web_ui_syncs_the_gallery(device, target, run_state):
    """A picture prepared in the browser reaches the gallery of the device unchanged and is displayed."""
    _require_candidate(run_state)
    from webtest import assets

    width, height = _picture_size(target)

    async def body():
        async with web_ui(device) as (app, bridge, site):
            await app.add_pictures([assets.test_picture(width // 2, height // 2)])
            result = await app.sync(timeout=600000)
            return result, await app.status(), await app.tiles(), list(bridge.commands)

    result, status, tiles, commands = ble_run(body(), timeout=900)
    assert result is None, f"The web UI reported a failed sync: {result}"
    assert "Galerie synchronisiert" in status
    assert [tile["status"] for tile in tiles if tile["key"]] == ["synced"]
    put = next((cmd for cmd in commands if cmd.startswith("GAL_PUT:")), None)
    assert put, f"The web UI sent no picture: {commands}"
    picture_id, size = put[8:].split(",")
    assert f"END:{picture_id}" in commands and f"GAL_SHOW:{picture_id}" in commands, f"Unexpected commands: {commands}"

    ended = device.wait_for(r"\[BLE\] Upload ENDED\. Bytes: (\d+), FlashCRC: 0x([0-9A-Fa-f]{8}) \((\w+)\)", timeout=30)
    assert ended.group(3) == "OK", "The device rejected the picture."
    assert int(ended.group(1)) == int(size)
    assert ended.group(2).lower() == picture_id, "The picture file on the device differs from what the browser sent."

    # The device shows the picture the page asked for.
    device.wait_for(rf"\[GALLERY\] Showing \S*{picture_id}", timeout=60)
    shown = device.wait_for(r"\[EPD\] Set Image Done: (-?\d+)", timeout=settings.REFRESH_TIMEOUT)
    assert shown.group(1) == "0", "The picture was not displayed."


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
    start = commands.index("START_FW")  # the page reads the gallery in the background before
    assert commands[start:start + 3] == ["START_FW", "V2", f"FW_SIZE:{os.path.getsize(target.candidate_bin)}"]

    booted = device.wait_for_reboot(since["log"], timeout=90)
    assert booted.firmware == "offline"
    assert booted.version == run_state["candidate_version"]


def test_14_usb_flash_starts_the_flashed_firmware(device, target, run_state):
    """Flashing over USB works without the boot button, and the flashed firmware is the one that
    starts: also when the device ran from the second app slot, as it does after an update over BLE."""
    _require_candidate(run_state)

    booted = device.identify()
    if booted.slot != "app1":
        # An update over BLE goes to the other slot: from app0 to app1.
        device.enter_setup_mode()
        booted = _flash_over_ble(device, target.candidate_bin)
    assert booted.slot == "app1", f"Device runs from {booted.slot}, the test needs it on app1."

    device.enter_bootloader()
    booted = device.flash_over_usb(target.candidate_bin)

    assert booted.firmware == "offline"
    assert booted.version == run_state["candidate_version"]
    assert booted.slot == "app0", f"The firmware flashed over USB does not start: the device still runs from {booted.slot}."


def test_15_web_ui_over_usb(device, target, run_state):
    """The web UI over the USB cable: it shows the device, sends a picture to the gallery and reads the
    gallery back. Bluetooth is not used."""
    _require_candidate(run_state)
    from webtest import assets

    width, height = _picture_size(target)

    async def body():
        async with web_ui(device, usb=True) as (app, bridge, site):
            found = {
                "name_shown": device.uid in await app.text("#systemDeviceName"),
                "firmware": await app.text("#systemFwVersion"),
            }
            await app.add_pictures([assets.test_picture(width // 4, height // 4)])
            found["sync"] = await app.sync(timeout=600000)
            found["status"] = await app.status()
            # the picture of test_12 is only on the device: its preview is read over USB
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-remote] img').length >= 1", timeout=120000)
            found["tiles"] = await app.tiles()
            found["bluetooth"] = bridge.connections
            await app.disconnect()
            return found

    found = ble_run(body(), timeout=900)
    assert found["name_shown"], "The web UI does not show the name of the device."
    assert found["firmware"] == f"v{run_state['candidate_version']} ✓"
    assert found["sync"] is None, f"The web UI reported a failed sync: {found['sync']}"
    assert "Galerie synchronisiert" in found["status"]
    local = [tile for tile in found["tiles"] if tile["key"]]
    assert [tile["status"] for tile in local] == ["synced"]
    # A sync does not change the display: the device keeps showing the picture of test_12.
    shown = [tile for tile in found["tiles"] if tile["shown"]]
    assert len(shown) == 1 and shown[0]["remote"], f"The page does not mark the picture on the display: {found['tiles']}"
    assert found["bluetooth"] == 0, "The page used Bluetooth."


def test_99_restore_cloud_firmware(device, target, run_state):
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
    # A connection later than 10 s after the press meets the next gallery picture: the restart follows that refresh.
    device.wait_for_reboot(since, timeout=30 + settings.REFRESH_TIMEOUT)

    device.enter_setup_mode()
    # The update over BLE is the candidate's job; another offline firmware only has to go.
    flash = _flash_over_ble if run_state.get("candidate_running") else _replace_leftover_firmware
    booted = flash(device, bin_path)

    assert booted.firmware == "cloud", "Device still runs the offline firmware after the restore."
    assert booted.version == cloud_version, f"Device runs V{booted.version}, expected cloud production V{cloud_version}."

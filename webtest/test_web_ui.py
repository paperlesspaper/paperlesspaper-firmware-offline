"""Browser tests of the web UI against a simulated device. No hardware needed.

    cd web && npm run build
    python -m pytest webtest -v

Each test opens the built page (web/dist) in a headless Chromium and uses it like a
person would: clicks, form input, file selection. The device is webtest/simdevice.py.
"""

import asyncio
import json
import struct

import pytest

from webtest import assets
from webtest.harness import run
from webtest.simdevice import SimulatedDevice, crc32

TARGETS = ["epd7", "epd13"]


async def expected_version(app):
    """The firmware version this build of the web UI expects on the device."""
    return (await app.text("#expectedOfflineFwBadge")).lstrip("v")


async def until(condition, timeout=10.0):
    """Waits until something on the device side has happened."""
    for _ in range(int(timeout / 0.05)):
        if condition():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("The expected state of the device was not reached in time.")


async def hidden(app, selector):
    return await app.page.evaluate("selector => document.querySelector(selector).hidden", selector)


# --- start page -----------------------------------------------------------


def test_page_starts_clean(app_session):
    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            assert "Warte auf Verbindung" in await app.status()
            assert await app.locator("#btnConnect").is_enabled()
            assert await hidden(app, "#bluetoothUnsupported")
            assert await expected_version(app), "The page does not name the firmware version it expects."
            await app.view("geraet")
            assert not await hidden(app, "#notConnectedState")
            assert await hidden(app, "#controls")

    run(body())


def test_browser_without_bluetooth_still_edits_pictures(app_session):
    """Without Web Bluetooth the editor and the BMP download must keep working."""

    async def body():
        async with app_session(bluetooth=False) as (app, site):
            assert not await hidden(app, "#bluetoothUnsupported")
            assert await app.locator("#btnConnect").is_disabled()

            await app.load_image(assets.test_picture())
            assert await app.locator("#btnUploadImage").is_disabled()
            async with app.page.expect_download() as download_info:
                await app.click("#btnDownloadBin")
            download = await download_info.value
            with open(await download.path(), "rb") as f:
                bmp = f.read()

            assert download.suggested_filename == "epaper_image.bmp"
            assert bmp[:2] == b"BM" and len(bmp) == 118 + 800 * 480 // 2
            width, height, _, bits = struct.unpack_from("<iiHH", bmp, 18)
            assert (width, height, bits) == (800, -480, 4)
            assert assets.pixel_codes(bmp[118:]) <= assets.VALID_PIXEL_CODES

    run(body())


@pytest.mark.parametrize("edge", ["top", "left"])
def test_button_stays_under_the_pointer(app_session, edge):
    """Hover and press move a button down and to the right. A pointer on its top or left edge
    must not lose the button by that: it would flicker, and a press there would not count."""

    async def under_pointer(page, point):
        return await page.evaluate(
            "([x, y]) => document.getElementById('btnPickImage').contains(document.elementFromPoint(x, y))", list(point)
        )

    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            page = app.page
            await asyncio.sleep(0.5)  # fonts are loaded, the layout is final
            box = await page.evaluate(
                "() => { const r = document.getElementById('btnPickImage').getBoundingClientRect();"
                " return { x: r.left, y: r.top, width: r.width, height: r.height }; }"
            )
            if edge == "top":
                point = (box["x"] + box["width"] / 2, box["y"] + 0.5)
            else:
                point = (box["x"] + 0.5, box["y"] + box["height"] / 2)

            await page.mouse.move(*point)
            await asyncio.sleep(0.3)  # hover style applied
            assert await under_pointer(page, point), "The hovered button moved away from the pointer."

            async with page.expect_file_chooser(timeout=3000):  # the press arrives as a click
                await page.mouse.down()
                await asyncio.sleep(0.3)  # pressed style applied
                assert await under_pointer(page, point), "The pressed button moved away from the pointer."
                await page.mouse.up()

    run(body())


# --- connection -----------------------------------------------------------


@pytest.mark.parametrize("target", TARGETS)
def test_connect_shows_device_and_loads_its_settings(app_session, target):
    async def body():
        device = SimulatedDevice(target)
        device.settings.update(url="http://frame.local/picture.jpg", timeout=7200, http_user="bob",
                               settings_url="http://frame.local/settings.json", motion_wakeup=True, auto_rotation=False)
        device.wifi_ssid = "Werkstatt"
        async with app_session(device) as (app, site):
            device.version = await expected_version(app)
            await app.connect()

            assert device.chooser_filters == [{"namePrefix": "epd"}]
            assert device.name in await app.text("#systemDeviceName")
            assert await app.text("#systemFwVersion") == f"v{device.version} ✓"
            assert await hidden(app, "#firmwareVersionWarning")
            assert "4.10 V" in await app.text("#systemVoltage")

            large = target == "epd13"
            assert await app.text("#displayBadge") == ('13.3" · 1200×1600' if large else '7.3" · 800×480')
            assert await app.page.input_value("#displaySizeSelect") == ("13" if large else "7")
            assert await app.locator("#displaySizeSelect").is_disabled(), "Display size must follow the device."

            await app.view("geraet")
            page = app.page
            assert await page.input_value("#settingUrl") == "http://frame.local/picture.jpg"
            assert await page.input_value("#settingTimeout") == "7200"
            assert await page.input_value("#settingHttpAuthUser") == "bob"
            assert await page.input_value("#settingSettingsUrl") == "http://frame.local/settings.json"
            assert await page.input_value("#settingHttpAuthPassword") == "", "A password must never be shown."
            assert await page.is_checked("#settingMotionWakeup")
            assert not await page.is_checked("#settingAutoRotation")
            assert await page.input_value("#wifiSsid") == "Werkstatt"
            assert not await hidden(app, "#syncBadgeSettings")

            await app.disconnect()
            assert "EXIT_SETUP" in device.commands, "Disconnecting must end the setup mode of the device."
            assert (await app.ble_stats())["maxParallel"] == 1, "Two GATT operations ran at the same time."

    run(body())


def test_cancelled_device_chooser(app_session):
    async def body():
        device = SimulatedDevice()
        device.chooser_cancelled = True
        async with app_session(device) as (app, site):
            app.expected_errors.append("NotFoundError")
            await app.click("#btnConnect")
            await app.wait_status("Geräteauswahl abgebrochen")
            assert await app.locator("#btnConnect").is_visible()
            assert device.connections == 0

    run(body())


@pytest.mark.parametrize("version, legacy, chip", [("0.0.1", False, "v0.0.1 ⚠"), ("", True, "Veraltet ⚠")])
def test_outdated_firmware_is_announced(app_session, version, legacy, chip):
    async def body():
        device = SimulatedDevice(version=version, legacy=legacy)
        async with app_session(device) as (app, site):
            await app.connect()
            assert not await hidden(app, "#firmwareVersionWarning")
            assert await app.text("#systemFwVersion") == chip
            await app.click("#btnJumpToOta")
            assert not await hidden(app, "#viewOta"), "The warning must lead to the firmware view."

    run(body())


# --- settings -------------------------------------------------------------


def test_save_settings(app_session):
    async def body():
        device = SimulatedDevice()
        files = {"picture.bmp": assets.bmp_header(800, 480, bits=4, top_down=True)}
        async with app_session(device, files=files) as (app, site):
            await app.connect()
            await app.view("geraet")
            page = app.page
            url = site.url + "picture.bmp"
            await page.fill("#settingUrl", url)
            await page.fill("#settingTimeout", "900")
            await page.fill("#settingSettingsUrl", site.url + "settings.json")
            await page.fill("#settingHttpAuthUser", "alice")
            await page.fill("#settingHttpAuthPassword", "s3cret")
            await app.click("#btnSaveSettings")
            await app.wait_status("Einstellungen gespeichert")

            saved = device.saved_settings
            assert (saved["url"], saved["timeout"], saved["settings_url"]) == (url, 900, site.url + "settings.json")
            assert (saved["http_user"], saved["http_password"]) == ("alice", "s3cret")
            # After saving, the page checks the picture behind the new URL on its own.
            await page.wait_for_function("() => document.getElementById('urlValidationStatus').dataset.tone === 'ok'")

            # An empty password field keeps the stored password ...
            await page.fill("#settingHttpAuthPassword", "")
            await page.fill("#settingTimeout", "1200")
            await app.click("#btnSaveSettings")
            await until(lambda: device.commands.count("SAVE_SETTINGS") == 2)
            assert device.saved_settings["timeout"] == 1200
            assert device.saved_settings["http_password"] == "s3cret"

            # ... and without a user name it is cleared.
            await page.fill("#settingHttpAuthUser", "")
            await app.click("#btnSaveSettings")
            await until(lambda: device.commands.count("SAVE_SETTINGS") == 3)
            assert (device.saved_settings["http_user"], device.saved_settings["http_password"]) == ("", "")
            assert (await app.ble_stats())["maxParallel"] == 1

    run(body())


@pytest.mark.parametrize("field, value, error", [
    ("#settingUrl", "ftp://frame.local/picture.jpg", "#settingUrlError"),
    ("#settingUrl", "http://frame.local/" + "a" * 120, "#settingUrlError"),
    ("#settingTimeout", "30", "#settingTimeoutError"),
    ("#settingTimeout", "2592001", "#settingTimeoutError"),
    ("#settingSettingsUrl", "frame.local/settings.json", "#settingSettingsUrlError"),
    ("#settingHttpAuthUser", "u" * 129, "#settingHttpAuthUserError"),
])
def test_invalid_settings_are_not_sent(app_session, field, value, error):
    """The device silently ignores values outside its limits, so the page must refuse them."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            before = dict(device.settings)
            await app.page.fill(field, value)
            await app.click("#btnSaveSettings")
            await app.wait_status("Bitte die markierten Felder korrigieren")
            assert not await hidden(app, error)
            assert "SAVE_SETTINGS" not in device.commands
            assert device.settings == before

    run(body())


def test_switches_are_stored_immediately(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.open_expert_area()
            page = app.page

            await page.locator("#settingMotionWakeup").check()
            await app.wait_status("Motion Wakeup aktiviert")
            assert device.saved_settings["motion_wakeup"] is True

            await page.locator("#settingAutoRotation").uncheck()
            await app.wait_status("Auto Rotation deaktiviert")
            assert device.saved_settings["auto_rotation"] is False

            # Charging is a safety matter: it needs a confirmation.
            await page.locator("#settingChargerMode").click()
            await app.confirm(accept=False)
            assert not await page.is_checked("#settingChargerMode")
            assert device.settings["charger_mode"] is False

            await page.locator("#settingChargerMode").click()
            await app.confirm(accept=True)
            await app.wait_status("Charger Mode aktiviert")
            assert device.saved_settings["charger_mode"] is True

    run(body())


def test_factory_reset_needs_confirmation(app_session):
    async def body():
        device = SimulatedDevice()
        device.settings["url"] = "http://frame.local/picture.jpg"
        async with app_session(device) as (app, site):
            await app.connect()
            await app.open_expert_area()

            await app.click("#btnFactoryReset")
            await app.confirm(accept=False)
            assert "RESET" not in device.commands

            await app.click("#btnFactoryReset")
            await app.confirm(accept=True)
            await app.wait_status("zurückgesetzt")
            assert "RESET" in device.commands
            assert device.settings["url"] == ""

    run(body())


# --- Wi-Fi ----------------------------------------------------------------


def test_wifi_scan_and_join(app_session):
    async def body():
        device = SimulatedDevice()
        device.networks = {"Keller": ("pw-keller", -82), "Werkstatt": ("pw-werkstatt", -48), "Gast": ("pw-gast", -66)}
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            page = app.page

            await app.click("#btnScanWifi")
            await page.wait_for_selector("#wifiList .wifi-item")
            names = await page.locator("#wifiList .wifi-ssid").all_inner_texts()
            assert names == ["Werkstatt", "Gast", "Keller"], "Networks must be listed strongest first."

            await page.locator("#wifiList .wifi-item").first.click()
            assert await page.input_value("#wifiSsid") == "Werkstatt"
            await page.fill("#wifiPass", "pw-werkstatt")
            await app.click("#btnSaveWifi")
            await app.wait_status("WLAN gespeichert & Erfolgreich Verbunden", timeout=20000)

            assert (device.wifi_ssid, device.wifi_password) == ("Werkstatt", "pw-werkstatt")
            assert not await hidden(app, "#wifiConnectedInfo")
            assert await app.text("#infoSsid") == "Werkstatt"
            assert await app.text("#infoIp") == "192.168.4.23"
            assert device.settings["image_mode"] == 1, "After joining a network the device must load from the URL."

    run(body())


def test_wifi_wrong_password_is_reported(app_session):
    async def body():
        device = SimulatedDevice()
        device.networks = {"Werkstatt": ("pw-werkstatt", -48)}
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            await app.page.fill("#wifiSsid", "Werkstatt")
            await app.page.fill("#wifiPass", "falsch")
            await app.click("#btnSaveWifi")
            await app.wait_status("Verbindung fehlgeschlagen", timeout=30000)
            assert not await hidden(app, "#wifiInputMask")

    run(body(), timeout=60)


def test_wifi_name_is_required(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            await app.page.fill("#wifiPass", "irgendwas")
            await app.click("#btnSaveWifi")
            assert not await hidden(app, "#wifiSsidError")
            assert device.wifi_password == ""

    run(body())


# --- picture upload -------------------------------------------------------


def bar_codes(image, width, height):
    """The most frequent colour code in each of the six colour bars of assets.test_picture()."""
    row_bytes = width // 2
    result = []
    for bar in range(6):
        counts = {}
        for y in range(height // 8, height // 2, 16):
            start = y * row_bytes + (bar * width // 6 + width // 24) // 2
            for byte in image[start:start + width // 16]:
                for code in (byte >> 4, byte & 0x0F):
                    counts[code] = counts.get(code, 0) + 1
        result.append(max(counts, key=counts.get))
    return result


@pytest.mark.parametrize("target", TARGETS)
def test_picture_upload(app_session, target):
    async def body():
        device = SimulatedDevice(target)
        async with app_session(device) as (app, site):
            await app.connect()
            # A picture in the format of the display: no rotation, no scaling artefacts.
            await app.load_image(assets.test_picture(device.width // 2, device.height // 2))
            result = await app.transfer(lambda: app.click("#btnUploadImage"), timeout=180000)

            assert result is None, f"Upload ended with an error screen: {result}"
            assert "Upload abgeschlossen" in await app.status()
            assert device.image is not None and len(device.image) == device.image_bytes
            assert device.displayed == device.image, "APPLY was not sent after the upload."
            assert assets.pixel_codes(device.image) <= assets.VALID_PIXEL_CODES
            assert device.commands[-2:] == [f"END:{crc32(device.image):08x}", "APPLY"]
            assert device.settings["image_mode"] == 0
            # black, white, blue, green, red, yellow in the colour codes of the display
            assert bar_codes(device.image, device.width, device.height) == [0, 6, 1, 2, 3, 5]
            assert (await app.ble_stats())["maxParallel"] == 1

    run(body(), timeout=240)


def test_send_without_connection_connects_first(app_session):
    """'Senden' without a connected device explains how to connect, connects and then sends by itself."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.load_image(assets.test_picture(device.width // 2, device.height // 2))
            assert not await app.is_connected()
            assert await app.locator("#btnUploadImage").is_enabled(), "Sending must be offered without a connection."

            async def connect_and_send():
                await app.click("#btnUploadImage")
                await app.page.wait_for_selector("#connectDialog[open]")
                # the same steps as in the device view while nothing is connected
                assert await app.text("#connectDialogSteps") == await app.text("#notConnectedState .step-list")
                await app.click("#btnConnectAndSend")

            result = await app.transfer(connect_and_send, timeout=180000)

            assert result is None, f"Upload ended with an error screen: {result}"
            assert await app.is_connected()
            assert device.image is not None and len(device.image) == device.image_bytes
            assert device.displayed == device.image, "APPLY was not sent after the upload."

    run(body(), timeout=240)


def test_cancelled_connect_dialog_sends_nothing(app_session):
    """Closing the dialog must not leave an upload waiting for the next connection."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.load_image(assets.test_picture())
            await app.click("#btnUploadImage")
            await app.page.wait_for_selector("#connectDialog[open]")
            await app.click("#btnCancelConnectDialog")

            await app.connect()
            await asyncio.sleep(1)
            assert await app.page.evaluate("window.__transferOpens") == 0
            assert device.image is None

    run(body())


def test_upload_repeats_a_window_after_packet_loss(app_session):
    async def body():
        device = SimulatedDevice()
        device.drop_packets = 2
        async with app_session(device) as (app, site):
            await app.connect()
            await app.load_image(assets.test_picture())
            result = await app.transfer(lambda: app.click("#btnUploadImage"))

            assert result is None, f"Upload ended with an error screen: {result}"
            assert device.commands.count("CLEAR") == 2
            assert "Paketverlust korrigiert" in await app.status_log()
            assert device.displayed is not None and len(device.displayed) == device.image_bytes

    run(body())


def test_upload_with_legacy_protocol(app_session):
    """Old builds answer with a 2 byte status: the page must fall back to the first protocol."""

    async def body():
        device = SimulatedDevice(legacy=True)
        async with app_session(device) as (app, site):
            await app.connect()
            await app.load_image(assets.test_picture())
            result = await app.transfer(lambda: app.click("#btnUploadImage"))

            assert result is None, f"Upload ended with an error screen: {result}"
            assert "V2" not in device.commands and device.commands[-2:] == ["END", "APPLY"]
            assert device.displayed is not None and len(device.displayed) == device.image_bytes

    run(body())


def test_upload_reports_a_flash_error(app_session):
    async def body():
        device = SimulatedDevice()
        device.fail_flash = True
        async with app_session(device) as (app, site):
            app.expected_errors.append("Schreibfehler")
            await app.connect()
            await app.load_image(assets.test_picture())
            title, message = await app.transfer(lambda: app.click("#btnUploadImage"))

            assert title == "Senden fehlgeschlagen" and "Schreibfehler" in message
            assert device.displayed is None
            assert await app.locator("#btnUploadImage").is_enabled(), "The page must stay usable after an error."

    run(body())


def test_upload_survives_a_dropped_connection(app_session):
    async def body():
        device = SimulatedDevice()
        device.drop_link_after = 150
        async with app_session(device) as (app, site):
            app.expected_errors += ["GATT", "NetworkError"]
            await app.connect()
            await app.load_image(assets.test_picture())
            title, message = await app.transfer(lambda: app.click("#btnUploadImage"))

            assert title == "Senden fehlgeschlagen"
            assert device.displayed is None
            # The page reconnects on its own after 5 s.
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden", timeout=15000)
            assert device.connections == 2

    run(body())


def test_upload_can_be_aborted(app_session):
    async def body():
        device = SimulatedDevice()
        device.packet_delay = 0.01
        async with app_session(device) as (app, site):
            app.expected_errors += ["GATT", "NetworkError", "disconnect"]
            await app.connect()
            await app.load_image(assets.test_picture())

            async def start_and_abort():
                await app.click("#btnUploadImage")
                await app.page.wait_for_function("() => parseInt(document.getElementById('transferPct').textContent) > 0")
                await app.click("#btnTransferAbort")

            result = await app.transfer(start_and_abort)
            assert result is None, f"An aborted upload must not show an error screen: {result}"
            assert "abgebrochen" in await app.status()
            assert device.displayed is None
            assert not await app.is_connected()

    run(body())


# --- firmware update ------------------------------------------------------


@pytest.mark.parametrize("target", TARGETS)
def test_offline_firmware_update(app_session, target):
    """The page flashes the offline firmware that is published next to it, for the connected device."""

    async def body():
        firmware = assets.firmware_image(seed=7)
        device = SimulatedDevice(target)
        async with app_session(device, files={f"firmware_offline_{target}.bin": firmware}) as (app, site):
            await app.connect()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            assert await app.page.input_value("#offlineOtaDeviceSelect") == target
            assert await app.locator("#offlineOtaDeviceSelect").is_disabled(), "The firmware must match the connected device."
            title, message = await app.transfer(lambda: app.click("#btnConfirmOfflineOta"))

            assert title == "Firmware installiert", message
            assert device.firmware == firmware
            assert device.commands[:3] == ["START_FW", "V2", f"FW_SIZE:{len(firmware)}"]
            assert device.commands[-1] == f"END_FW:{crc32(firmware):08x}"
            assert f"/firmware_offline_{target}.bin" in site.requests
            await app.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")
            assert (await app.ble_stats())["maxParallel"] == 1

    run(body())


def test_cloud_firmware_update(app_session):
    """Way back to the cloud firmware: manifest and file come from ./factory/ of the site."""

    async def body():
        firmware = assets.firmware_image(seed=11)
        files = {
            "factory/espfota_epd7_pre.json": json.dumps({"type": "esp32-fota-http", "version": "3.0.99", "url": "http://x/firmware.bin"}).encode(),
            "factory/firmware_epd7_pre.bin": firmware,
        }
        device = SimulatedDevice()
        async with app_session(device, files=files) as (app, site):
            await app.connect()
            await app.open_more_firmware()
            await app.click("#btnFetchOriginalFw")
            await app.page.wait_for_function("() => document.getElementById('otaVersion').textContent === '3.0.99'")
            title, message = await app.transfer(lambda: app.click("#btnConfirmOta"))

            assert title == "Firmware installiert", message
            assert device.firmware == firmware

    run(body())


def broken_firmware(kind):
    """A firmware file with exactly one defect, so each check of the page is tested on its own."""
    if kind == "html":
        return b"<!DOCTYPE html><html><body>404 Not Found</body></html>" + bytes(70000)
    image = bytearray(assets.firmware_image())
    if kind == "too small":
        return bytes(image[:4096])
    if kind == "corrupt":
        image[5000] ^= 0xFF
        return bytes(image)
    if kind == "wrong chip":
        struct.pack_into("<H", image, 12, 0x0005)
    elif kind == "bootloader":
        struct.pack_into("<I", image, 32, 0)
    return assets.with_checksum(image)


@pytest.mark.parametrize("kind, reason", [
    ("html", "Text/HTML"),
    ("too small", "zu klein"),
    ("wrong chip", "Falsche Ziel-Hardware"),
    ("bootloader", "Ungültiges App-Image"),
    ("corrupt", "SHA-256"),
])
def test_broken_firmware_file_is_refused(app_session, kind, reason):
    """A file that would brick the device must be refused before anything is sent."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            app.expected_errors += ["Firmware", "App-Image", "Ziel-Hardware"]
            await app.connect()
            await app.view("firmware")
            await app.page.set_input_files("#fwInput", {"name": "firmware.bin", "mimeType": "application/octet-stream", "buffer": broken_firmware(kind)})
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "Ungültige Firmware-Datei" in await app.text("#messageTitle")
            assert reason in await app.text("#messageText")
            await app.click("#messageOk")
            assert not any(c.startswith("START_FW") for c in device.commands)

    run(body())


def test_own_firmware_file_is_flashed_after_confirmation(app_session):
    async def body():
        firmware = assets.firmware_image(seed=3)
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("firmware")
            picked = {"name": "firmware.bin", "mimeType": "application/octet-stream", "buffer": firmware}

            await app.page.set_input_files("#fwInput", picked)
            await app.confirm(accept=False)
            assert device.firmware is None and "START_FW" not in device.commands

            await app.page.set_input_files("#fwInput", picked)
            title, message = await app.transfer(lambda: app.confirm(accept=True))
            assert title == "Firmware installiert", message
            assert device.firmware == firmware

    run(body())


def test_firmware_refused_by_the_device(app_session):
    async def body():
        device = SimulatedDevice()
        device.reject_firmware_size = True
        async with app_session(device, files={"firmware_offline_epd7.bin": assets.firmware_image()}) as (app, site):
            app.expected_errors.append("OTA-Partition")
            await app.connect()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            title, message = await app.transfer(lambda: app.click("#btnConfirmOfflineOta"))

            assert title == "Firmware-Update fehlgeschlagen" and "OTA-Partition" in message
            assert device.firmware is None
            assert await app.is_connected(), "A refused update must not end the connection."

    run(body())


def test_firmware_update_without_connection_offers_to_connect(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device, files={"firmware_offline_epd7.bin": assets.firmware_image()}) as (app, site):
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "Nicht verbunden" in await app.text("#messageTitle")
            await app.click("#messageCancel")
            assert device.connections == 0

    run(body())


# --- check of the download URL --------------------------------------------


URL_CASES = [
    ("fits.jpg", assets.jpeg_header(800, 480), "ok", "füllt das Display ganz aus"),
    ("large.jpg", assets.jpeg_header(4000, 3000), "ok", "verkleinert"),
    ("progressive.jpg", assets.jpeg_header(800, 480, progressive=True), "warn", "Progressives JPEG"),
    ("odd-sampling.jpg", assets.jpeg_header(800, 480, sampling=0x41), "err", "Farbunterabtastung"),
    ("cmyk.jpg", assets.jpeg_header(800, 480, components=4), "err", "kein RGB-Bild"),
    ("editor.bmp", assets.bmp_header(800, 480, bits=4, top_down=True), "ok", "BMP aus dem Bild-Editor"),
    ("palette.bmp", assets.bmp_header(800, 480, bits=8), "err", "kann das Gerät nicht anzeigen"),
    ("picture.png", assets.test_picture(), "err", "ein PNG"),
    ("page.html", b"<!DOCTYPE html><html></html>" + bytes(64), "err", "eine Webseite oder Textdatei"),
    ("missing.jpg", None, "warn", "HTTP 404"),
]


@pytest.mark.parametrize("name, content, tone, fragment", [pytest.param(*case, id=case[0]) for case in URL_CASES])
def test_download_url_check(app_session, name, content, tone, fragment):
    """The page tells whether the device can show the picture behind the download URL."""

    async def body():
        files = {name: content} if content is not None else {}
        async with app_session(SimulatedDevice(), files=files) as (app, site):
            if content is None:
                app.expected_errors.append("404")
            await app.connect()
            await app.view("geraet")
            await app.page.fill("#settingUrl", site.url + name)
            await app.click("#btnCheckImageUrl")
            await app.page.wait_for_function(
                "() => { const s = document.getElementById('urlValidationStatus'); return !s.hidden && s.dataset.tone !== 'info'; }"
            )
            assert fragment in await app.text("#urlValidationStatus")
            assert await app.page.get_attribute("#urlValidationStatus", "data-tone") == tone

    run(body())

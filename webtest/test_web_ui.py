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

from webtest import assets, simdevice
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
            assert await hidden(app, "#wifiCard") and await hidden(app, "#deviceSettings")

    run(body())


NO_SERIAL = "Object.defineProperty(Navigator.prototype, 'serial', { get: () => undefined, configurable: true }); delete Navigator.prototype.serial;"


def test_browser_without_bluetooth_connects_over_usb(app_session):
    """Web Serial alone is enough to reach the device: the USB link is offered."""

    async def body():
        async with app_session(bluetooth=False) as (app, site):
            assert not await hidden(app, "#bluetoothUnsupported")
            assert "USB" in await app.text("#bluetoothUnsupportedText")
            assert await app.locator("#btnConnect").is_enabled(), "Verbinden then takes the USB cable."
            assert await app.locator("#btnSyncGallery").is_enabled()

    run(body())


def test_browser_without_bluetooth_still_edits_pictures(app_session):
    """Without Web Bluetooth and Web Serial the gallery, the editor and the BMP download must keep working."""

    async def body():
        async with app_session(bluetooth=False, init_script=NO_SERIAL) as (app, site):
            assert not await hidden(app, "#bluetoothUnsupported")
            assert await app.locator("#btnConnect").is_disabled()
            assert await app.locator("#btnSyncGallery").is_disabled()
            assert await app.text("#syncHint") == "kein Bluetooth"

            await app.load_image(assets.test_picture())
            assert await app.locator("#btnSaveToGallery").is_enabled()
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

            await app.save_picture()
            assert len(await app.tiles()) == 1

    run(body())


@pytest.mark.parametrize("edge", ["top", "left"])
def test_button_stays_under_the_pointer(app_session, edge):
    """Hover and press move a button down and to the right. A pointer on its top or left edge
    must not lose the button by that: it would flicker, and a press there would not count."""

    async def under_pointer(page, point):
        return await page.evaluate(
            "([x, y]) => document.getElementById('btnSyncGallery').contains(document.elementFromPoint(x, y))", list(point)
        )

    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            page = app.page
            await asyncio.sleep(0.5)  # fonts are loaded, the layout is final
            box = await page.evaluate(
                "() => { const r = document.getElementById('btnSyncGallery').getBoundingClientRect();"
                " return { x: r.left, y: r.top, width: r.width, height: r.height }; }"
            )
            if edge == "top":
                point = (box["x"] + box["width"] / 2, box["y"] + 0.5)
            else:
                point = (box["x"] + 0.5, box["y"] + box["height"] / 2)

            await page.mouse.move(*point)
            await asyncio.sleep(0.3)  # hover style applied
            assert await under_pointer(page, point), "The hovered button moved away from the pointer."

            await page.mouse.down()
            await asyncio.sleep(0.3)  # pressed style applied
            assert await under_pointer(page, point), "The pressed button moved away from the pointer."
            await page.mouse.up()
            await page.wait_for_selector("#connectDialog[open]", timeout=3000)  # the press arrived as a click

    run(body())


# --- connection -----------------------------------------------------------


@pytest.mark.parametrize("width", [320, 390, 768])
def test_device_info_fits_on_a_narrow_screen(app_session, width):
    """Device, battery, USB and firmware are all visible at once, shortened, without scrolling."""

    async def body():
        device = SimulatedDevice("epd13")
        async with app_session(device) as (app, site):
            device.version = await expected_version(app)
            await app.page.set_viewport_size({"width": width, "height": 800})
            await app.connect()
            await app.page.wait_for_function("() => document.getElementById('systemVoltage').textContent.includes('V')")

            strip = await app.page.evaluate(
                """() => {
                    const inner = document.querySelector('.device-strip-inner');
                    const chips = [...inner.querySelectorAll('.chip')].map((chip) => {
                        const box = chip.getBoundingClientRect();
                        const value = chip.querySelector('span[id]');
                        return {
                            id: chip.id, left: box.left, right: box.right, top: box.top,
                            shown: value.dataset.short || value.textContent,
                            cut: value.scrollWidth > value.clientWidth + 1,
                        };
                    });
                    return { chips, scrolls: inner.scrollWidth > inner.clientWidth + 1, width: innerWidth };
                }"""
            )
            assert not strip["scrolls"], "The device strip must not scroll sideways."
            assert len(strip["chips"]) == 4
            for chip in strip["chips"]:
                assert chip["left"] >= 0 and chip["right"] <= strip["width"], f"{chip['id']} is outside the screen"
                assert chip["top"] == strip["chips"][0]["top"], "All values belong in one row."
                assert not chip["cut"], f"{chip['id']} is cut off: {chip['shown']}"
            shown = {chip["id"]: chip["shown"] for chip in strip["chips"]}
            assert shown["chipDevice"] == f"epd13-…{device.name[-4:]}"
            assert shown["chipFw"] == f"v{device.version} ✓"
            # the complete text stays in the document
            assert device.name in await app.text("#systemDeviceName")

    run(body())


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

            # a device that downloads its picture: "Bild" stays where it was and marks what the device uses
            page = app.page
            await app.view("bild")
            assert await page.get_attribute("#btnSourceGallery", "aria-pressed") == "true", "Connecting must not change the view."
            assert not await hidden(app, "#sourceUrlActive") and await hidden(app, "#sourceGalleryActive")
            await app.url_settings()
            assert await page.input_value("#settingUrl") == "http://frame.local/picture.jpg"
            assert await page.input_value("#settingTimeout") == "7200"
            assert await page.input_value("#settingHttpAuthUser") == "bob"
            assert await page.input_value("#settingSettingsUrl") == "http://frame.local/settings.json"
            assert await page.input_value("#settingHttpAuthPassword") == "", "A password must never be shown."
            assert not await hidden(app, "#syncBadgeSettings")
            await app.view("geraet")
            assert await page.is_checked("#settingMotionWakeup")
            assert not await page.is_checked("#settingAutoRotation")
            assert await page.input_value("#wifiSsid") == "Werkstatt"

            await app.disconnect()
            assert "EXIT_SETUP" in device.commands, "Disconnecting must end the setup mode of the device."
            assert (await app.ble_stats())["maxParallel"] == 1, "Two GATT operations ran at the same time."

    run(body())


def test_device_ends_an_idle_setup_mode(app_session):
    """The device leaves the setup mode on its own: the page says why and does not try to reconnect."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await device.end_setup_mode()
            await app.wait_status("ohne Eingabe beendet")
            assert not await app.is_connected()
            assert await app.locator("#btnConnect").is_visible()

            await asyncio.sleep(6)  # an unexpected disconnect is followed by a reconnect after 5 s
            assert device.connections == 1, "The page must not reconnect to a device that went to sleep."
            assert "ohne Eingabe beendet" in await app.status()

    run(body())


def test_cancelled_device_chooser(app_session):
    async def body():
        device = SimulatedDevice()
        device.chooser_cancelled = True
        async with app_session(device) as (app, site):
            app.expected_errors.append("NotFoundError")
            await app.start_connect()
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
            await app.url_settings()
            page = app.page
            url = site.url + "picture.bmp"
            await page.fill("#settingUrl", url)
            await page.fill("#settingTimeout", "900")
            await page.fill("#settingSettingsUrl", site.url + "settings.json")
            await page.fill("#settingHttpAuthUser", "alice")
            await page.fill("#settingHttpAuthPassword", "s3cret")
            await app.click("#btnSaveSettings")
            await app.wait_status("Einstellungen gespeichert")
            await app.confirm(accept=False)  # stay connected for more settings

            saved = device.saved_settings
            assert (saved["url"], saved["timeout"], saved["settings_url"]) == (url, 900, site.url + "settings.json")
            assert (saved["http_user"], saved["http_password"]) == ("alice", "s3cret")

            # An empty password field keeps the stored password ...
            await page.fill("#settingHttpAuthPassword", "")
            await page.fill("#settingTimeout", "1200")
            await app.click("#btnSaveSettings")
            await until(lambda: device.commands.count("SAVE_SETTINGS") == 2)
            await app.confirm(accept=False)
            assert device.saved_settings["timeout"] == 1200
            assert device.saved_settings["http_password"] == "s3cret"

            # ... and without a user name it is cleared.
            await page.fill("#settingHttpAuthUser", "")
            await app.click("#btnSaveSettings")
            await until(lambda: device.commands.count("SAVE_SETTINGS") == 3)
            await app.confirm(accept=False)
            assert await app.is_connected() and "EXIT_SETUP" not in device.commands
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
            await app.url_settings()
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


def test_settings_json_cannot_switch_the_charger_on(app_session):
    """Charging normal batteries is dangerous: a settings file may switch the charger off, not on."""

    async def body():
        device = SimulatedDevice()
        files = {"settings.json": json.dumps({"timeout": 900, "chargerMode": True}).encode()}
        async with app_session(device, files=files) as (app, site):
            await app.connect()
            await app.url_settings()
            await app.page.fill("#settingSettingsUrl", site.url + "settings.json")
            await app.click("#btnPreviewJson")
            await app.click("#btnApplyJson")
            await app.wait_status("nicht übernommen")
            assert device.saved_settings["timeout"] == 900
            assert device.saved_settings["charger_mode"] is False
            assert not await app.page.is_checked("#settingChargerMode")

    run(body())


@pytest.mark.parametrize("voltage, tone, text", [
    (5200, "ok", "5.20 V"),
    (4300, "warn", "schwach"),
    (3900, "err", "leer"),
])
def test_battery_level_matches_the_firmware(app_session, voltage, tone, text):
    """4 AA cells: the device stops below 4.0 V, so that is empty and not 'fine'."""

    async def body():
        device = SimulatedDevice()
        device.voltage = voltage
        async with app_session(device) as (app, site):
            await app.connect()
            assert text in await app.text("#systemVoltage")
            assert await app.page.evaluate("document.getElementById('systemVoltage').parentElement.dataset.tone") == tone

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
        device.settings["image_mode"] = 0  # the device shows its gallery
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
            assert device.settings["image_mode"] == 0, "Joining a network must not change what the device shows."

    run(body())


def test_changing_the_wifi_can_be_cancelled(app_session):
    async def body():
        device = SimulatedDevice()
        device.networks = {"Werkstatt": ("pw-werkstatt", -48)}
        device.wifi_ssid, device.wifi_password, device.wifi_connected = "Werkstatt", "pw-werkstatt", True
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            await app.page.wait_for_selector("#wifiConnectedInfo:not([hidden])")
            await app.click("#btnEditWifi")
            assert not await hidden(app, "#wifiInputMask") and await app.locator("#btnCancelWifi").is_visible()
            await app.page.fill("#wifiSsid", "Anderes Netz")
            await app.page.fill("#wifiPass", "geheim")
            await app.click("#btnCancelWifi")
            assert await hidden(app, "#wifiInputMask") and not await hidden(app, "#wifiConnectedInfo")
            assert await app.page.input_value("#wifiPass") == "" and await app.page.input_value("#wifiSsid") == "Werkstatt"
            assert (device.wifi_ssid, device.wifi_password) == ("Werkstatt", "pw-werkstatt"), "Nothing was sent."

    run(body())


def test_log_is_always_shown_in_the_device_view(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.view("geraet")
            assert await app.locator("#statusLogOutput").is_visible(), "Also without a device: it says why connecting fails."
            # the settings are on the right, with or without a device
            boxes = await app.page.evaluate(
                "() => Object.fromEntries(['notConnectedState', 'logCard', 'expertCard'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, [r.left, r.top]]; }))"
            )
            assert boxes["logCard"][0] == boxes["notConnectedState"][0] and boxes["logCard"][1] > boxes["notConnectedState"][1]
            assert boxes["expertCard"][0] > boxes["notConnectedState"][0] and boxes["expertCard"][1] == boxes["notConnectedState"][1]
            assert await app.page.locator("#btnLog").count() == 0
            await app.connect()
            assert await app.locator("#statusLogOutput").is_visible()
            assert "Erfolgreich Verbunden" in await app.status_log()
            # wide screens: below the WLAN box, next to the expert settings
            boxes = await app.page.evaluate(
                "() => Object.fromEntries(['wifiCard', 'logCard', 'expertCard'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, [r.left, r.top]]; }))"
            )
            assert boxes["logCard"][0] == boxes["wifiCard"][0] and boxes["logCard"][1] > boxes["wifiCard"][1]
            assert boxes["expertCard"][0] > boxes["wifiCard"][0]
            # phones: at the end of the page
            await app.page.set_viewport_size({"width": 390, "height": 800})
            tops = await app.page.evaluate("() => ['wifiCard', 'expertCard', 'logCard'].map(id => document.getElementById(id).getBoundingClientRect().top)")
            assert tops == sorted(tops)

    run(body())


def test_wifi_list_is_complete_with_a_small_mtu(app_session):
    """A notification carries at most MTU - 3 bytes. The page must read the whole list."""

    async def body():
        device = SimulatedDevice()
        device.networks = {f"Netzwerk-Nummer-{i:02d}": ("pw", -40 - i) for i in range(20)}
        device.notify_limit = 182  # macOS
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("geraet")
            await app.click("#btnScanWifi")
            await app.page.wait_for_selector("#wifiList .wifi-item")
            names = await app.page.locator("#wifiList .wifi-ssid").all_inner_texts()
            assert names == list(device.networks), "Networks are missing or cut off."
            assert (await app.ble_stats())["maxParallel"] == 1

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


# --- gallery ----------------------------------------------------------------


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


def distinct_pictures(count, width=400, height=240):
    """Pictures that differ, so that every one gets its own id."""
    return [assets.test_picture(width - 20 * index, height - 12 * index) for index in range(count)]


async def gallery_loaded(app, timeout=20000):
    """Waits until the page has read the gallery of the connected device."""
    await app.page.wait_for_function(
        "() => ['alles synchron', 'Änderung'].some(text => document.getElementById('syncHint').textContent.includes(text))", timeout=timeout
    )


async def local_ids(app, device):
    """Ids of the pictures of the gallery in its order, as far as they are on the device."""
    statuses = [tile for tile in await app.tiles() if tile["key"]]
    assert all(tile["status"] == "synced" for tile in statuses), statuses
    remote = {tile["remote"] for tile in await app.tiles() if tile["remote"]}
    return [pid for pid in device.order if pid not in remote]


def test_quick_add_of_several_files(app_session):
    """Several files at once become pictures of the gallery, without a device and without the editor."""

    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            assert not await hidden(app, "#galleryEmpty")
            await app.add_pictures(distinct_pictures(3))

            tiles = await app.tiles()
            assert len(tiles) == 3 and all(tile["key"] and tile["has_image"] for tile in tiles)
            assert all(tile["status"] is None for tile in tiles), "Without a device there is nothing to compare with."
            assert await app.text("#galleryCount") == "3 Bilder"
            assert await hidden(app, "#galleryEmpty") and await hidden(app, "#galleryStoreNote")
            assert "3 Bilder hinzugefügt" in await app.status()

            # a file that is no picture is not added
            await app.page.set_input_files("#galleryFileInput", {"name": "notes.txt", "mimeType": "text/plain", "buffer": b"hello"})
            await app.wait_status("keine Bilddateien")
            assert len(await app.tiles()) == 3

    run(body())


def test_gallery_survives_a_reload(app_session):
    """Pictures, their order and their originals are kept in the browser."""

    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            await app.add_pictures(distinct_pictures(3))
            keys = [tile["key"] for tile in await app.tiles()]

            # the last picture moves to the front, with the keyboard
            await app.move_tile(keys[2], -2)
            moved = [keys[2], keys[0], keys[1]]
            assert [tile["key"] for tile in await app.tiles()] == moved
            assert await app.page.evaluate("document.activeElement.closest('.tile').dataset.key") == keys[2], "The moved picture keeps the focus."

            await app.page.reload()
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-key]').length === 3")
            tiles = await app.tiles()
            assert [tile["key"] for tile in tiles] == moved and all(tile["has_image"] for tile in tiles)

            # the original is still there: the editor opens it with its settings
            await app.open_tile(0)
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            assert await app.text("#imageSecTitle") == "Bild bearbeiten"
            assert await app.locator("#btnSaveToGallery").is_enabled()

    run(body())


def test_tiles_are_reordered_by_dragging(app_session):
    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            await app.add_pictures(distinct_pictures(3))
            keys = [tile["key"] for tile in await app.tiles()]
            tiles = app.page.locator("#galleryGrid .tile")
            await tiles.nth(0).drag_to(tiles.nth(2))
            assert [tile["key"] for tile in await app.tiles()] == [keys[1], keys[2], keys[0]]

    run(body())


def test_gallery_without_browser_storage(app_session):
    """Without IndexedDB the gallery works for the session and says that it will not last."""

    async def body():
        no_storage = "Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });"
        async with app_session(SimulatedDevice(), init_script=no_storage) as (app, site):
            assert not await hidden(app, "#galleryStoreNote")
            await app.add_pictures(distinct_pictures(1))
            assert len(await app.tiles()) == 1

            await app.page.reload()
            await app.page.wait_for_selector("#galleryEmpty:not([hidden])")
            assert len(await app.tiles()) == 0

    run(body())


def test_picture_from_the_editor(app_session):
    """One picture is edited in the dialog and saved to the gallery; the sync brings it to the display."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await gallery_loaded(app)
            await app.load_image(assets.test_picture(device.width // 2, device.height // 2))
            assert await app.text("#imageSecTitle") == "Bild bearbeiten"
            # the editor offers these three actions and nothing else
            buttons = await app.page.locator("#editorDialog .editor-foot button").all_text_contents()
            assert sorted(text.strip().lower() for text in buttons) == ["bmp-download", "schließen", "speichern"]
            assert await app.page.locator("#editorDialog .editor-preview button:not(#btnRotate)").count() == 0
            await app.click("#btnRotate")
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            await app.save_picture()
            tiles = await app.tiles()
            assert len(tiles) == 1 and tiles[0]["status"] == "new"
            assert not device.pictures, "Saving to the gallery sends nothing."

            result = await app.sync()

            assert result is None, f"The sync ended with an error screen: {result}"
            assert len(device.pictures) == 1 and device.shown == device.order
            assert device.settings["image_mode"] == 0
            await app.page.wait_for_function("() => document.querySelector('#galleryGrid .tile').dataset.status === 'synced'")
            assert (await app.tiles())[0]["shown"], "The tile of the picture on the display is marked."
            assert (await app.ble_stats())["maxParallel"] == 1

    run(body())


@pytest.mark.parametrize("target", TARGETS)
def test_gallery_sync(app_session, target):
    """Pictures, play settings and interval go to the device; a picture that is only there stays."""

    async def body():
        device = SimulatedDevice(target)
        only_there = device.add_picture(assets.gallery_container(device.display, device.width, device.height, seed=4))
        async with app_session(device) as (app, site):
            await app.connect()
            # Pictures in the format of the display: no rotation, no scaling artefacts.
            await app.add_pictures([assets.test_picture(device.width // 2, device.height // 2), assets.test_picture(device.width // 4, device.height // 4)])
            await app.click("#btnPlayShuffle")
            await app.click("#btnPlayManual")
            await app.click("#btnPlayAuto")
            await app.page.fill("#galleryInterval", "2")
            await gallery_loaded(app)
            assert "Änderungen" in await app.text("#syncHint")

            result = await app.sync(timeout=240000)

            assert result is None, f"Sync ended with an error screen: {result}"
            assert "Galerie synchronisiert" in await app.status()
            assert len(device.pictures) == 3 and only_there in device.pictures
            first, second = [pid for pid in device.order if pid != only_there]
            thumb, raw = device.picture(first)
            assert len(raw) == device.image_bytes and assets.pixel_codes(raw) <= assets.VALID_PIXEL_CODES
            assert thumb[:2] == b"\xff\xd8" and len(thumb) <= 8192, "The preview is a small JPEG."
            # black, white, blue, green, red, yellow in the colour codes of the display
            assert bar_codes(raw, device.width, device.height) == [0, 6, 1, 2, 3, 5]
            assert device.shuffle and device.auto
            assert device.saved_settings["timeout"] == 7200
            assert device.shown == [first], "The first picture of the gallery is shown, not the one that was already there."
            assert device.settings["image_mode"] == 0
            assert f"GAL_PUT:{first},{len(device.pictures[first])}" in device.commands

            tiles = await app.tiles()
            assert [tile["status"] for tile in tiles] == ["synced", "synced", "remote"]
            assert tiles[0]["shown"] and tiles[2]["remote"] == only_there
            assert await app.text("#syncHint") == "alles synchron"
            assert "3 Bilder" in await app.text("#galleryDeviceText")
            assert (await app.ble_stats())["maxParallel"] == 1

            # nothing to do: a second sync sends no picture again
            puts = sum(cmd.startswith("GAL_PUT") for cmd in device.commands)
            assert await app.sync() is None
            assert sum(cmd.startswith("GAL_PUT") for cmd in device.commands) == puts

    run(body(), timeout=400)


def test_sync_with_little_memory_on_the_device(app_session):
    """A device that is short of memory takes an upload in smaller windows."""

    async def body():
        device = SimulatedDevice("epd13")
        device.window_size = 4096
        async with app_session(device) as (app, site):
            await app.connect()
            await app.add_pictures([assets.noise_picture(device.width // 4, device.height // 4)])
            assert await app.sync(timeout=240000) is None
            size = len(device.pictures[device.order[0]])
            assert size > 3 * 4096, "The picture must need several windows."
            assert device.commands.count("FLUSH") >= size // 4096
            assert device.shown == device.order

    run(body(), timeout=300)


def test_plus_box_adds_pictures(app_session):
    """The empty box at the end of the gallery opens the file chooser; no other button adds pictures."""

    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            assert await app.page.locator("#galleryGrid > li").count() == 1, "Only the box with the plus."
            async with app.page.expect_file_chooser(timeout=3000) as chooser_info:
                await app.click("#btnAddPictures")
            chooser = await chooser_info.value
            assert chooser.is_multiple()
            await chooser.set_files([{"name": "a.png", "mimeType": "image/png", "buffer": assets.test_picture()}])
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-key]').length === 1")
            await app.wait_idle()
            assert await app.page.evaluate("document.querySelector('#galleryGrid > li:last-child').className") == "tile-add"
            assert await app.page.locator("#btnNewPicture").count() == 0

    run(body())


@pytest.mark.parametrize("answer", ["sync", "later"])
def test_connecting_offers_to_sync_a_gallery_that_differs(app_session, answer):
    """The device shows its gallery and the one in the browser has changed: the page asks right after connecting."""

    async def body():
        device = SimulatedDevice()
        device.settings["image_mode"] = 0
        async with app_session(device) as (app, site):
            await app.add_pictures(distinct_pictures(1))
            opens = await app.page.evaluate("window.__transferOpens")
            await app.connect()
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "Galerie synchronisieren?" in await app.text("#messageTitle")

            if answer == "sync":
                await app.click("#messageOk")
                await app.page.wait_for_function("() => document.getElementById('status').textContent.includes('Galerie synchronisiert')", timeout=120000)
                assert len(device.pictures) == 1 and device.shown == device.order
            else:
                await app.click("#messageCancel")
                await asyncio.sleep(1)
                assert not device.pictures and await app.page.evaluate("window.__transferOpens") == opens
                assert (await app.tiles())[0]["status"] == "new"

    run(body(), timeout=240)


def test_connecting_does_not_offer_a_sync_to_a_device_that_downloads(app_session):
    async def body():
        device = SimulatedDevice()
        device.settings.update(url="http://frame.local/picture.jpg", image_mode=1)
        async with app_session(device) as (app, site):
            await app.add_pictures(distinct_pictures(1))
            await app.connect()
            await gallery_loaded(app)
            await asyncio.sleep(0.5)
            assert not await app.page.evaluate("document.getElementById('messageDialog').open")
            # the gallery stays open, marks the download as active and says what a sync does
            assert await app.page.get_attribute("#btnSourceGallery", "aria-pressed") == "true"
            assert not await hidden(app, "#sourceUrlActive")
            assert "Download-URL" in await app.text("#galleryDeviceText")

    run(body())


@pytest.mark.parametrize("usb", [False, True])
def test_download_settings_are_prepared_without_a_device(app_session, usb):
    """The download from a URL is filled in first; "Synchronisieren" then connects and stores it."""

    async def body():
        device = SimulatedDevice()
        device.settings.update(timeout=7200, http_user="old-user")
        files = {"picture.bmp": assets.bmp_header(800, 480, bits=4, top_down=True)}
        async with app_session(device, files=files) as (app, site):
            await app.url_settings()
            assert await hidden(app, "#sourceGallery")
            url = site.url + "picture.bmp"
            await app.page.fill("#settingUrl", url)
            await app.page.fill("#settingTimeout", "900")
            await app.click("#btnSaveSettings")

            await app.page.wait_for_selector("#connectDialog[open]")
            labels = [" ".join(text.split()) for text in await app.page.locator("#connectDialog .modal-actions button").all_text_contents()]
            assert labels == ["Abbrechen", "USB per USB verbinden", "Bluetooth per Bluetooth verbinden"]
            await app.click("#btnConnectUsbAndSend" if usb else "#btnConnectAndSend")

            await app.wait_status("Einstellungen gespeichert", timeout=40000)
            saved = device.saved_settings
            assert (saved["url"], saved["timeout"]) == (url, 900), "What was filled in goes to the device, not the other way round."
            assert saved["http_user"] == "", "The form was not filled from the device."
            assert device.settings["image_mode"] == 1
            assert (device.usb_sessions, device.connections) == ((1, 0) if usb else (0, 1))
            assert await app.page.input_value("#settingUrl") == url

            # the device downloads once the setup mode has ended: the page offers to disconnect
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "Abruf jetzt starten?" in await app.text("#messageTitle")
            await app.confirm(accept=usb)
            if usb:
                await app.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")
                assert device.commands[-1] == "EXIT_SETUP"
            else:
                assert await app.is_connected() and "EXIT_SETUP" not in device.commands

    run(body())


def test_connecting_asks_for_bluetooth_or_usb_unless_one_is_preferred(app_session):
    """"Verbinden" asks which way to take. Under "Gerät" one way can be chosen for good."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            # asked every time
            await app.click("#btnConnect")
            await app.page.wait_for_selector("#connectDialog[open]")
            assert await app.text("#connectDialogTitle") == "Mit E-Paper verbinden"
            await app.click("#btnCancelConnectDialog")
            assert device.connections == 0 and device.usb_sessions == 0

            # Bluetooth preferred: no question
            await app.view("geraet")
            assert await app.page.input_value("#connectWaySelect") == "ask"
            await app.page.select_option("#connectWaySelect", "ble")
            await app.click("#btnConnect")
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden")
            assert not await app.page.evaluate("document.getElementById('connectDialog').open")
            assert device.connections == 1 and device.usb_sessions == 0
            await app.disconnect()

            # USB preferred, kept over a reload: the sync button connects over the cable
            await app.view("geraet")
            await app.page.select_option("#connectWaySelect", "usb")
            await app.page.reload()
            await app.page.wait_for_selector("#status", state="attached")
            await app.view("geraet")
            assert await app.page.input_value("#connectWaySelect") == "usb"
            await app.add_pictures(distinct_pictures(1))
            result = await app.transfer(lambda: app.click("#btnSyncGallery"), timeout=120000)
            assert result is None, f"Sync ended with an error screen: {result}"
            assert device.usb_sessions == 1 and device.connections == 1, "The second connection used the cable."
            assert len(device.pictures) == 1

    run(body(), timeout=240)


def test_device_info_is_shown_in_the_device_view(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("bild")
            assert not await app.locator("#systemStatusBar").is_visible(), "Not in every view any more."
            await app.view("geraet")
            assert await app.locator("#systemStatusBar").is_visible()
            assert device.name in await app.text("#systemDeviceName")

            # phone: one block without gaps, the name in full on a line of its own
            await app.page.set_viewport_size({"width": 390, "height": 800})
            layout = await app.page.evaluate(
                """() => {
                    const rect = (id) => document.getElementById(id).getBoundingClientRect();
                    const name = document.getElementById('systemDeviceName');
                    return {
                        name: [name.scrollWidth, name.clientWidth, getComputedStyle(name).fontSize, getComputedStyle(name, '::after').content],
                        page: Math.round(rect('viewConnect').width), device: rect('chipDevice'), battery: rect('chipBattery'), usb: rect('chipUsb'), fw: rect('chipFw'), wifi: rect('wifiCard'),
                    };
                }"""
            )
            width, visible, font_size, short_form = layout["name"]
            assert width <= visible and font_size != "0px" and short_form == "none", "The whole name is shown."
            assert round(layout["device"]["width"]) == layout["page"] and round(layout["battery"]["top"]) == round(layout["device"]["bottom"])
            assert round(layout["usb"]["left"]) == round(layout["battery"]["right"]) and round(layout["fw"]["left"]) == round(layout["usb"]["right"])
            assert round(layout["wifi"]["top"]) == round(layout["battery"]["bottom"]), "No space between the values and the box below."

    run(body())


@pytest.mark.parametrize("confirmed", [True, False])
def test_switching_to_the_download_warns_about_the_gallery(app_session, confirmed):
    """A download URL replaces the gallery on the device: the page says so before it saves."""

    async def body():
        device = SimulatedDevice()
        device.settings["image_mode"] = 0
        files = {"picture.bmp": assets.bmp_header(800, 480, bits=4, top_down=True)}
        async with app_session(device, files=files) as (app, site):
            await app.connect()
            await app.add_pictures(distinct_pictures(2))
            assert await app.sync() is None
            assert len(device.pictures) == 2

            await app.url_settings()
            await app.page.fill("#settingUrl", site.url + "picture.bmp")
            await app.page.fill("#settingTimeout", "900")
            await app.click("#btnSaveSettings")
            await app.page.wait_for_selector("#messageDialog[open]")
            text = await app.text("#messageText")
            assert "2 Bilder" in text and "gelöscht" in text and "Intervall" in text
            await app.confirm(accept=confirmed)

            if confirmed:
                await app.wait_status("Einstellungen gespeichert")
                await until(lambda: not device.pictures)
                assert "GAL_CLEAR" in device.commands
                assert device.saved_settings["url"] == site.url + "picture.bmp" and device.settings["image_mode"] == 1
                assert device.saved_settings["timeout"] == 900
                await app.confirm(accept=False)  # "Abruf jetzt starten?": stay connected
                await app.click("#btnSourceGallery")
                await app.page.wait_for_function("() => [...document.querySelectorAll('#galleryGrid .tile')].every(t => t.dataset.status === 'new')")
                assert len(await app.tiles()) == 2, "The pictures stay in the browser."

                # saving again does not warn: the device already downloads
                await app.url_settings()
                await app.page.fill("#settingTimeout", "1200")
                await app.click("#btnSaveSettings")
                await until(lambda: device.saved_settings["timeout"] == 1200)
                await app.page.wait_for_selector("#messageDialog[open]")
                assert "Abruf jetzt starten?" in await app.text("#messageTitle")
            else:
                await asyncio.sleep(0.5)
                assert "SAVE_SETTINGS" not in device.commands[-3:] and len(device.pictures) == 2
                assert device.settings["url"] == "" and device.settings["image_mode"] == 0

    run(body(), timeout=300)


def test_orientation_of_the_frame_turns_all_pictures(app_session):
    """The frame hangs upright: every picture of the gallery is prepared again, turned by a quarter."""

    async def body():
        device = SimulatedDevice()
        device.settings["image_mode"] = 0
        async with app_session(device) as (app, site):
            await app.connect()
            # bars across the top, as wide as the display: upright they run down its long side
            await app.add_pictures([assets.test_picture(device.width // 2, device.height // 2), assets.test_picture(device.height // 2, device.width // 2)])
            assert await app.sync() is None
            before = dict(device.pictures)
            assert await app.page.get_attribute("#btnOrientLandscape", "aria-pressed") == "true", "The 7.3 inch display is built across."
            first = device.order[0]
            assert bar_codes(device.picture(first)[1], device.width, device.height) == [0, 6, 1, 2, 3, 5]

            await app.click("#btnOrientPortrait")
            await app.wait_status("neu ausgerichtet", timeout=120000)
            assert [tile["status"] for tile in await app.tiles()] == ["changed", "changed"]
            assert await app.page.evaluate("document.getElementById('galleryGrid').hasAttribute('data-turned')")
            assert device.pictures == before, "Nothing changes on the device before the sync."

            assert await app.sync() is None
            assert len(device.pictures) == 2 and not set(device.pictures) & set(before), "Both pictures were replaced."
            # the picture that was made upright (480 x 800 halved) now fills the display: its bars
            # run along the short side of the picture rows
            raw = device.picture(device.order[1])[1]
            row_bytes = device.width // 2

            def column(first_byte):  # the most frequent colour at six heights of the picture
                found = []
                for y in range(device.height // 12, device.height, device.height // 6):
                    codes = [code for byte in raw[y * row_bytes + first_byte:y * row_bytes + first_byte + 12] for code in (byte >> 4, byte & 0x0F)]
                    found.append(max(set(codes), key=codes.count))
                return sorted(found)

            assert [0, 1, 2, 3, 5, 6] in (column(8), column(row_bytes - 20)), "The bars lie along the rows now."

            # a new picture is prepared for the same orientation, and the choice survives a reload
            await app.page.reload()
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-key]').length === 2")
            assert await app.page.get_attribute("#btnOrientPortrait", "aria-pressed") == "true"

    run(body(), timeout=400)


def test_connecting_never_changes_the_view(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.url_settings()
            await app.start_connect()
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden")
            await gallery_loaded(app)
            assert await app.page.get_attribute("#btnSourceUrl", "aria-pressed") == "true"
            assert not await hidden(app, "#sourceGalleryActive"), "A device without a download URL uses the gallery."
            # the choice is remembered for the next visit
            await app.page.reload()
            await app.page.wait_for_selector("#status", state="attached")
            assert await app.page.get_attribute("#btnSourceUrl", "aria-pressed") == "true"

    run(body())


def test_sync_applies_order_changes_and_deletions(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await app.add_pictures(distinct_pictures(3))
            assert await app.sync() is None
            a, b, c = await local_ids(app, device)

            # c moves to the front
            keys = [tile["key"] for tile in await app.tiles()]
            await app.move_tile(keys[2], -2)
            assert await app.text("#syncHint") == "1 Änderung"
            assert await app.sync() is None
            assert "GAL_ORDER:3" in device.commands and device.order == [c, a, b]

            # b is removed, a is edited
            await app.delete_tile("#galleryGrid .tile >> nth=2")  # b is the last one now
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile').length === 2")
            await app.open_tile(1)
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            await app.click("#btnRotate")
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            await app.save_picture()
            assert [tile["status"] for tile in await app.tiles()] == ["synced", "changed"]
            assert b in device.pictures, "Nothing changes on the device before the sync."

            assert await app.sync() is None

            assert f"GAL_DEL:{b}" in device.commands and f"GAL_DEL:{a}" in device.commands, "The removed picture and the old version of the edited one are deleted."
            assert len(device.pictures) == 2 and device.order[0] == c and a not in device.pictures
            assert [tile["status"] for tile in await app.tiles()] == ["synced", "synced"]

    run(body(), timeout=300)


def test_sync_reports_pictures_that_do_not_fit(app_session):
    async def body():
        device = SimulatedDevice()
        device.storage_total = 4000  # no picture fits
        async with app_session(device) as (app, site):
            await app.connect()
            await app.add_pictures(distinct_pictures(2))
            title, message = await app.sync()

            assert title == "Nicht alles übertragen" and "2 Bilder passten nicht" in message
            assert not device.pictures and not device.shown
            assert [tile["status"] for tile in await app.tiles()] == ["new", "new"]
            assert await app.locator("#btnSyncGallery").is_enabled()

            device.storage_total = 15_000_000
            assert await app.sync() is None
            assert len(device.pictures) == 2

    run(body(), timeout=300)


def test_sync_waits_for_the_display_refresh(app_session):
    """While the device draws a picture it refuses gallery commands. The page waits and tries again."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect()
            await gallery_loaded(app)
            await app.add_pictures(distinct_pictures(1))
            device.display_busy_commands = 2
            result = await app.sync()

            assert result is None, f"Sync ended with an error screen: {result}"
            assert "aktualisiert noch das Display" in await app.status_log()
            assert len(device.pictures) == 1 and device.shown == device.order

    run(body(), timeout=240)


def test_sync_without_connection_connects_first(app_session):
    """'Synchronisieren' without a connected device explains how to connect, connects and then syncs by itself."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.add_pictures(distinct_pictures(1))
            assert not await app.is_connected()
            assert await app.locator("#btnSyncGallery").is_enabled(), "Syncing must be offered without a connection."

            async def connect_and_sync():
                await app.click("#btnSyncGallery")
                await app.page.wait_for_selector("#connectDialog[open]")
                # the same steps as in the device view while nothing is connected
                assert await app.text("#connectDialogSteps") == await app.text("#notConnectedState .step-list")
                await app.click("#btnConnectAndSend")

            result = await app.transfer(connect_and_sync, timeout=180000)

            assert result is None, f"Sync ended with an error screen: {result}"
            assert await app.is_connected()
            assert len(device.pictures) == 1 and device.shown == device.order

    run(body(), timeout=240)


def test_cancelled_connect_dialog_syncs_nothing(app_session):
    """Closing the dialog must not leave a sync waiting for the next connection."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.add_pictures(distinct_pictures(1))
            await app.click("#btnSyncGallery")
            await app.page.wait_for_selector("#connectDialog[open]")
            await app.click("#btnCancelConnectDialog")

            await app.connect()
            await asyncio.sleep(1)
            assert await app.page.evaluate("window.__transferOpens") == 0
            assert not device.pictures

    run(body())


def test_upload_repeats_a_window_after_packet_loss(app_session):
    async def body():
        device = SimulatedDevice()
        device.drop_packets = 2
        async with app_session(device) as (app, site):
            await app.connect()
            await app.add_pictures([assets.noise_picture(seed=1)])  # large enough for several windows
            result = await app.sync()

            assert result is None, f"Sync ended with an error screen: {result}"
            assert device.commands.count("CLEAR") == 2
            assert "Paketverlust korrigiert" in await app.status_log()
            assert len(device.pictures) == 1

    run(body())


def test_sync_reports_a_storage_error(app_session):
    async def body():
        device = SimulatedDevice()
        device.fail_flash = True
        async with app_session(device) as (app, site):
            app.expected_errors.append("Schreibfehler")
            await app.connect()
            await app.add_pictures(distinct_pictures(1))
            title, message = await app.sync()

            assert title == "Synchronisieren fehlgeschlagen" and "Schreibfehler" in message
            assert not device.pictures
            assert await app.locator("#btnSyncGallery").is_enabled(), "The page must stay usable after an error."

    run(body())


def test_interrupted_sync_is_resumed(app_session):
    """A dropped link ends the sync. Pressing the button again sends only what is still missing."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            app.expected_errors += ["GATT", "NetworkError"]
            await app.connect()
            await app.add_pictures([assets.noise_picture(seed=index) for index in range(3)])
            device.drop_link_at_pictures = 1  # in the middle of the second picture
            title, message = await app.sync()

            assert title == "Synchronisieren fehlgeschlagen"
            done = len(device.pictures)
            assert done == 1, f"{done} of 3 pictures arrived before the link dropped."
            # The page reconnects on its own after 5 s.
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden", timeout=15000)
            await gallery_loaded(app)
            assert sorted(tile["status"] for tile in await app.tiles()) == sorted(["synced"] * done + ["new"] * (3 - done))

            puts = sum(cmd.startswith("GAL_PUT") for cmd in device.commands)
            assert await app.sync() is None
            assert len(device.pictures) == 3 and device.connections == 2
            assert sum(cmd.startswith("GAL_PUT") for cmd in device.commands) == puts + 3 - done, "Pictures that had arrived are not sent again."

    run(body(), timeout=300)


def test_sync_can_be_aborted(app_session):
    async def body():
        device = SimulatedDevice()
        device.packet_delay = 0.01
        async with app_session(device) as (app, site):
            app.expected_errors += ["GATT", "NetworkError", "disconnect"]
            await app.connect()
            await app.add_pictures([assets.noise_picture(seed=5)])

            async def start_and_abort():
                await app.click("#btnSyncGallery")
                await app.page.wait_for_function("() => parseInt(document.getElementById('transferPct').textContent) > 0")
                await app.click("#btnTransferAbort")

            result = await app.transfer(start_and_abort)
            assert result is None, f"An aborted sync must not show an error screen: {result}"
            assert "abgebrochen" in await app.status()
            assert not device.pictures
            assert not await app.is_connected()

    run(body())


def test_pictures_that_are_only_on_the_device(app_session):
    """They show up with their previews, can be opened, taken over and deleted."""

    async def body():
        device = SimulatedDevice()
        kept = device.add_picture(assets.gallery_container(device.display, device.width, device.height, seed=1))
        doomed = device.add_picture(assets.gallery_container(device.display, device.width, device.height, seed=2))
        device.display_busy_commands = 1  # the display is still being refreshed when the page connects
        async with app_session(device) as (app, site):
            await app.connect()
            await app.view("bild")
            # list and previews arrive in the background
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-remote] img').length === 2", timeout=30000)
            tiles = await app.tiles()
            assert [tile["remote"] for tile in tiles] == [kept, doomed] and all(tile["status"] == "remote" for tile in tiles)
            assert {f"READ:thumb:{kept}", f"READ:thumb:{doomed}"} <= set(device.commands)
            assert (await app.ble_stats())["maxParallel"] == 1, "Two GATT operations ran at the same time."

            # opening one reads the whole picture from the device
            result = await app.transfer(lambda: app.page.locator(f'#galleryGrid .tile[data-remote="{kept}"] .tile-open').click())
            assert result is None, f"Reading the picture ended with an error screen: {result}"
            await app.page.wait_for_selector("#editorDialog[open]")
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            assert not await hidden(app, "#editorDeviceNote"), "A picture without original is announced as such."
            async with app.page.expect_download() as download_info:
                await app.click("#btnDownloadBin")
            with open(await (await download_info.value).path(), "rb") as f:
                assert f.read()[118:] == device.picture(kept)[1], "An unchanged picture from the device stays exactly as it is."

            # saved unchanged it becomes a picture of the gallery, with the same file
            await app.save_picture()
            await gallery_loaded(app)
            tiles = await app.tiles()
            assert [(bool(tile["key"]), tile["status"]) for tile in tiles] == [(True, "synced"), (False, "remote")]

            # the other one is deleted on the device at the next sync
            await app.delete_tile(f'#galleryGrid .tile[data-remote="{doomed}"]')
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile').length === 1")
            assert doomed in device.pictures, "Nothing changes on the device before the sync."

            assert await app.sync() is None
            assert list(device.pictures) == [kept] and f"GAL_DEL:{doomed}" in device.commands
            assert not any(cmd.startswith("GAL_PUT") for cmd in device.commands), "The picture that was taken over is already there."

    run(body(), timeout=300)


def test_picture_with_the_large_window_is_packed_again(app_session):
    """A picture file from an older page needs 32 KB of memory on the device to unpack. Taken over
    into the gallery it is replaced by the same picture in a file that needs 4 KB."""

    async def body():
        device = SimulatedDevice()
        old = device.add_picture(assets.gallery_container(device.display, device.width, device.height, seed=1, window=0))
        picture = device.picture(old)[1]
        async with app_session(device) as (app, site):
            await app.connect()
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-remote] img').length === 1", timeout=30000)
            await app.transfer(lambda: app.page.locator(f'#galleryGrid .tile[data-remote="{old}"] .tile-open').click())
            await app.page.wait_for_selector("#editorDialog[open]")
            await app.wait_status("Bildvorschau optimiert", timeout=60000)
            await app.save_picture()
            assert await app.sync() is None

            assert list(device.pictures) != [old] and len(device.pictures) == 1
            new = device.order[0]
            assert device.pictures[new][6] == simdevice.GALLERY_WINDOW_BITS, "The file names the small window."
            assert device.picture(new)[1] == picture, "The picture itself is unchanged."

    run(body(), timeout=300)


def test_firmware_without_gallery(app_session):
    """An older firmware cannot take the gallery: the page says so and offers the update, nothing else."""

    async def body():
        device = SimulatedDevice(gallery=False)
        async with app_session(device) as (app, site):
            await app.connect()
            await app.add_pictures(distinct_pictures(1))

            assert not await hidden(app, "#galleryFirmwareNote")
            assert await app.locator("#btnSyncGallery").is_disabled()
            assert await app.text("#syncHint") == "Firmware-Update nötig"
            assert len(await app.tiles()) == 1 and (await app.tiles())[0]["status"] is None

            await app.click("#btnGalleryFirmware")
            assert not await hidden(app, "#viewOta"), "The note must lead to the firmware view."
            assert not any(cmd.startswith(("GAL_", "READ:")) for cmd in device.commands)

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
            assert "Reset-Taste" in message and "Bluetooth" in message, "The result must say how to connect again."
            assert device.firmware == firmware
            firmware_commands = [cmd for cmd in device.commands if not cmd.startswith("READ:")]  # the page first reads the gallery
            assert firmware_commands[:3] == ["START_FW", "V2", f"FW_SIZE:{len(firmware)}"]
            assert device.commands[-1] == f"END_FW:{crc32(firmware):08x}"
            assert f"/firmware_offline_{target}.bin" in site.requests
            await app.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")
            assert (await app.ble_stats())["maxParallel"] == 1

    run(body())


def test_firmware_update_with_little_memory_on_the_device(app_session):
    """A device that is short of memory (the 13.3" frame) takes the firmware in smaller windows."""

    async def body():
        firmware = assets.firmware_image(seed=8)
        device = SimulatedDevice("epd13")
        device.window_size = 4096
        async with app_session(device, files={"firmware_offline_epd13.bin": firmware}) as (app, site):
            await app.connect()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            title, message = await app.transfer(lambda: app.click("#btnConfirmOfflineOta"), timeout=240000)
            assert title == "Firmware installiert", message
            assert device.firmware == firmware
            assert device.commands.count("FLUSH") >= len(firmware) // 4096

    run(body(), timeout=300)


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
            assert "paperlesspaper-App" in message
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


def test_firmware_update_from_an_old_firmware(app_session):
    """A device with a firmware before the gallery (first upload protocol) must still take the update."""

    async def body():
        firmware = assets.firmware_image(seed=5)
        device = SimulatedDevice(legacy=True)
        async with app_session(device, files={"firmware_offline_epd7.bin": firmware}) as (app, site):
            await app.connect()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            title, message = await app.transfer(lambda: app.click("#btnConfirmOfflineOta"))

            assert title == "Firmware installiert", message
            assert device.firmware == firmware
            assert "V2" not in device.commands and device.commands[-1] == "END_FW"

    run(body())


def test_firmware_dialog_offers_the_backup_of_the_certificates(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device, files={"firmware_offline_epd7.bin": assets.firmware_image()}) as (app, site):
            await app.connect()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            await app.page.wait_for_selector("#otaOfflineDialog[open]")
            assert "Zertifikate" in await app.text("#offlineOtaBackupNote")
            assert await app.locator("#btnOfflineOtaBackup").is_enabled()
            # the backup runs over USB: without a port the page explains what is missing
            device.usb_port_missing = True
            await app.click("#btnOfflineOtaBackup")
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "nicht in der Liste" in await app.text("#messageTitle")
            await app.click("#messageCancel")
            assert await app.page.evaluate("document.getElementById('otaOfflineDialog').open"), "The firmware dialog stays open."
            assert device.firmware is None

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
            assert await app.locator("#bleCloudHint").is_visible()
            await app.click("#btnUpdateOfflineFw")
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "Nicht verbunden" in await app.text("#messageTitle")
            # the cloud firmware only offers Bluetooth after its factory reset
            assert "Reset-Taste 5×" in await app.text("#messageDetail")
            await app.click("#messageCancel")
            assert device.connections == 0
            await app.connect()
            await app.view("firmware")
            assert not await app.locator("#bleCloudHint").is_visible()

    run(body())


USB_STUBS = """usbDevice => {
    const notFound = () => Promise.reject(new DOMException("No device selected.", "NotFoundError"));
    navigator.serial.requestPort = notFound;
    navigator.usb.requestDevice = usbDevice ? () => Promise.resolve({ productName: usbDevice }) : notFound;
}"""


@pytest.mark.parametrize("usb_device, title", [
    ("CP2102N USB to UART Bridge Controller", "Treiber fehlt"),
    (None, "Kein E-Paper am USB gefunden"),
])
def test_missing_serial_port_is_explained(app_session, usb_device, title):
    """Without its driver the device is not offered as a serial port. The page says so and tells
    a missing driver from a device that is not connected."""

    async def body():
        async with app_session(SimulatedDevice(), files={"firmware_offline_epd7.bin": assets.firmware_image()}) as (app, site):
            await app.page.evaluate(USB_STUBS, usb_device)
            await app.view("firmware")
            await app.click("#btnOtaSerial")
            await app.click("#btnUpdateOfflineFw")
            await app.click("#btnConfirmOfflineOta")

            await app.page.wait_for_selector("#messageDialog[open]")
            assert "nicht in der Liste" in await app.text("#messageTitle")
            assert "silabs.com" in await app.page.get_attribute("#messageLink a", "href")
            await app.click("#messageOk")

            await app.page.wait_for_function("title => document.getElementById('messageTitle').textContent.includes(title)", arg=title)
            if usb_device:
                assert usb_device in await app.text("#messageDetail")
            await app.click("#messageOk")
            assert not await app.page.evaluate("document.getElementById('transferDialog').open")

    run(body())


def test_help_link_opens_the_usb_section(app_session):
    async def body():
        async with app_session(SimulatedDevice()) as (app, site):
            await app.view("firmware")
            await app.click("#btnOtaSerial")
            await app.click('[data-help-target="helpUsb"]')
            await app.page.wait_for_selector("#viewHelp:not([hidden])")
            assert await app.page.get_attribute('[aria-controls="helpUsb"]', "aria-expanded") == "true"

    run(body())


# --- USB link ---------------------------------------------------------------


@pytest.mark.parametrize("target", TARGETS)
def test_usb_connect_and_save_settings(app_session, target):
    """Over the USB cable the page does the same as over Bluetooth, without using Bluetooth."""

    async def body():
        device = SimulatedDevice(target)
        device.settings.update(timeout=7200, http_user="bob")
        async with app_session(device) as (app, site):
            device.version = await expected_version(app)
            await app.connect_usb()

            stats = await app.ble_stats()
            assert stats["serialOpens"] == [115200, 921600], "The session starts slow and continues at the speed the device names."
            assert stats["chooserCalls"] == 0 and device.connections == 0, "Bluetooth must not be used."
            assert device.usb_sessions == 1
            assert device.name in await app.text("#systemDeviceName")
            assert await app.text("#systemFwVersion") == f"v{device.version} ✓"
            assert await app.page.input_value("#displaySizeSelect") == ("13" if target == "epd13" else "7")

            await app.url_settings()
            assert await app.page.input_value("#settingTimeout") == "7200"
            assert await app.page.input_value("#settingHttpAuthUser") == "bob"
            await app.page.fill("#settingTimeout", "900")
            await app.click("#btnSaveSettings")
            await app.wait_status("Einstellungen gespeichert")
            assert device.saved_settings["timeout"] == 900

            # a notification of the device arrives without a subscription
            device.voltage = 3700
            await device._notify(simdevice.CHR_SYSTEM_INFO)
            await app.page.wait_for_function("() => document.getElementById('systemVoltage').textContent.includes('3.70')")

            await app.disconnect()
            assert device.commands[-1] == "EXIT_SETUP"
            await until(lambda: not device.usb_session and not device.serial_open)

    run(body())


def test_usb_gallery_sync(app_session):
    async def body():
        device = SimulatedDevice()
        only_there = device.add_picture(assets.gallery_container(device.display, device.width, device.height, seed=4))
        async with app_session(device) as (app, site):
            await app.add_pictures(distinct_pictures(2))

            async def connect_and_sync():
                await app.click("#btnSyncGallery")
                await app.page.wait_for_selector("#connectDialog[open]")
                await app.click("#btnConnectUsbAndSend")

            result = await app.transfer(connect_and_sync, timeout=180000)

            assert result is None, f"Sync ended with an error screen: {result}"
            assert device.connections == 0 and device.usb_sessions == 1
            assert len(device.pictures) == 3 and device.shown == [device.order[1]]
            # the preview of the picture that is only on the device is read over USB
            await app.page.wait_for_function("() => document.querySelectorAll('#galleryGrid .tile[data-remote] img').length === 1", timeout=30000)
            tiles = await app.tiles()
            assert [tile["status"] for tile in tiles] == ["synced", "synced", "remote"]
            assert tiles[2]["remote"] == only_there

    run(body(), timeout=300)


def test_usb_firmware_update(app_session):
    async def body():
        firmware = assets.firmware_image(seed=6)
        device = SimulatedDevice()
        async with app_session(device, files={"firmware_offline_epd7.bin": firmware}) as (app, site):
            await app.connect_usb()
            await app.view("firmware")
            await app.click("#btnUpdateOfflineFw")
            title, message = await app.transfer(lambda: app.click("#btnConfirmOfflineOta"))

            assert title == "Firmware installiert", message
            assert device.firmware == firmware
            await app.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")
            await until(lambda: not device.serial_open)

    run(body())


def test_usb_cable_pulled_and_plugged_in_again(app_session):
    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect_usb()
            await device.unplug_usb()
            await app.wait_status("Verbindung unterbrochen")
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden", timeout=30000)
            assert device.usb_sessions == 2

    run(body())


def test_usb_device_asleep_asks_for_the_reset_button(app_session):
    async def body():
        device = SimulatedDevice()
        device.usb_awake = False
        async with app_session(device) as (app, site):
            app.expected_errors.append("antwortet nicht über USB")
            await app.start_connect(usb=True)
            await app.wait_status("Reset-Taste", timeout=20000)
            await app.wait_status("Neuer Versuch", timeout=20000)
            device.usb_awake = True  # the user presses reset
            await app.page.wait_for_function("() => !document.getElementById('systemStatusBar').hidden", timeout=30000)

    run(body())


def test_usb_port_is_released_for_the_serial_monitor(app_session):
    """The flasher and the monitor open the same port: the session ends, the device stays in setup mode."""

    async def body():
        device = SimulatedDevice()
        async with app_session(device) as (app, site):
            await app.connect_usb()
            await app.open_more_firmware()
            await app.click("#btnOtaSerial")
            await app.click("#btnToggleSerialMonitor")
            await app.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")
            await app.page.wait_for_function("() => window.__bleStats.serialOpens.length === 3")  # the monitor has the port
            assert (await app.ble_stats())["serialOpens"][-1] == 115200
            assert device.serial_open and not device.usb_session
            assert "EXIT_SETUP" not in device.commands
            await app.click("#btnToggleSerialMonitor")
            await until(lambda: not device.serial_open)

    run(body())


def test_missing_usb_port_is_explained_when_connecting(app_session):
    async def body():
        device = SimulatedDevice()
        device.usb_port_missing = True
        async with app_session(device) as (app, site):
            await app.start_connect(usb=True)
            await app.page.wait_for_selector("#messageDialog[open]")
            assert "nicht in der Liste" in await app.text("#messageTitle")
            await app.click("#messageCancel")
            assert not await app.is_connected() and device.usb_sessions == 0

    run(body())

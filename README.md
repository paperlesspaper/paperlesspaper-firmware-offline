# paperlesspaper Offline Firmware

Offline-first firmware for the paperlesspaper E-Paper frames (ESP32-C6, Spectra 6, 7.3" and 13.3").
The frame runs without any cloud: send images from your browser over Bluetooth, or let the frame download them from a server in your own network.

### 🚀 [Open the Web UI & Flasher](https://paperlesspaper.github.io/paperlesspaper-firmware-offline/)

Set up the frame, send images and flash firmware directly in the browser. Nothing to install.
Requires Chrome, Edge or Opera (Web Bluetooth / Web Serial). The Web UI is in German.

> [!WARNING]
> **Back up your certificates before you switch firmware.** The cloud firmware needs device-specific certificates that are stored in the `spiffs` partition. If that partition is erased, the frame can no longer connect to the paperlesspaper cloud. The certificates are not part of this repository; replacements are only available from customer support. See [Certificates](#certificates).

## Contents

- [Quick start](#quick-start)
- [Cloud vs. offline firmware](#cloud-vs-offline-firmware)
- [Buttons](#buttons)
- [Image sources](#image-sources)
- [Remote settings (JSON)](#remote-settings-json)
- [Web UI](#web-ui)
- [Certificates](#certificates)
- [Build from source](#build-from-source)
- [BLE protocol](#ble-protocol)
- [Hardware-in-the-loop test](#hardware-in-the-loop-test)
- [Roadmap](#roadmap)

## Quick start

1. Open the [Web UI](https://paperlesspaper.github.io/paperlesspaper-firmware-offline/).
2. Press the **reset button** (big button on the back) once. Bluetooth is now active for 30 seconds.
3. Click **Verbinden** and select your frame (`epd7-…` or `epd13-…`).
4. Open **Firmware** and flash the **Offline Firmware**.
5. Send an image in **Bild**, or set up WiFi and a download URL in **Gerät**.

Still running the cloud firmware? It only offers Bluetooth after a factory reset: press the reset button 5 times in quick succession and wait for the WiFi setup screen. Alternatively, flash over USB (**Firmware → USB-Kabel**).

## Cloud vs. offline firmware

| | [Cloud firmware](https://github.com/paperlesspaper/paperlesspaper-firmware) (default) | Offline firmware |
| :--- | :--- | :--- |
| **Purpose** | Works out of the box with the paperlesspaper servers | Independent of company servers, private, runs in your own network |
| **Internet** | Required | Not required |
| **Image source** | paperlesspaper cloud ([API](https://docs.paperlesspaper.de/api-guide)) | Bluetooth upload from the browser, or download from any URL (Home Assistant, NAS, Raspberry Pi, …) |
| **Dithering** | In the cloud | In the Web UI or on the device |
| **Configuration** | paperlesspaper web app | Web UI over Bluetooth, or a settings JSON on your server |
| **Firmware updates** | Automatic (OTA) | Manual in the Web UI, over Bluetooth or USB |
| **Support** | Official paperlesspaper support | Community, via GitHub issues |

You can switch between both firmwares at any time in the Web UI.

## Buttons

| Action | Result |
| :--- | :--- |
| Press reset **once** | Setup mode: Bluetooth is active for 30 seconds. Without a connection the frame continues with a normal update. |
| Press reset **twice** | Skips setup mode and downloads the image again, even if it has not changed. |
| Press reset **5 times** | Factory reset: deletes settings, WiFi credentials and the stored image. |
| Hold the small button, press reset, release the small button | Bootloader mode for USB flashing. |

Multiple presses count when each press follows the previous one within 3 seconds.

## Image sources

The frame shows one image and then goes to deep sleep. Where the image comes from depends on what you did last:

### Bluetooth upload

Choose an image in the Web UI (**Bild**). It is fitted to the display, dithered to the 6 display colors and sent to the frame.
The frame keeps this image and sleeps until you press the reset button. There is no timed wake-up in this mode.

### WiFi download

Enter WiFi credentials, a download URL and an update interval in the Web UI (**Gerät**). The frame wakes up at the interval (60 seconds to 30 days, default 1 hour), downloads the image, shows it and sleeps again. Saving a download URL switches the frame back from Bluetooth upload to WiFi download.

| Format | What the frame does |
| :--- | :--- |
| **4-bit BMP** from the Web UI (**BMP herunterladen**) | Shown as it is. Best quality, recommended. |
| **JPEG** | Dithered on the device (Floyd-Steinberg). Use baseline RGB JPEGs with standard Huffman tables: progressive JPEGs are only decoded at 1/8 of their resolution, and JPEGs saved with "optimized" Huffman tables can be rejected. |
| **BMP** with 24 or 32 bit, or 4 bit in another size | Dithered on the device. Compressed and 8-bit BMPs are not supported. |

Pictures that are dithered on the device are fitted to the display:

- **Larger** than the display: scaled down to fit. The aspect ratio is kept.
- **Smaller** than the display: shown in their original size.
- The picture is centered, the rest of the display stays white.

Display resolution: 800×480 (7.3", landscape) or 1200×1600 (13.3", portrait). The frame does not turn a landscape picture into portrait or the other way round, so provide pictures in this orientation.

Details:

- **URL:** `http://` or `https://`, up to 128 characters. HTTPS certificates are not verified.
- **Check:** the button **Prüfen** next to the download URL in the Web UI tells you whether the frame can show the picture and how it will be placed.
- **Login:** optional HTTP Basic Auth for the image download.
- **Caching:** if the server sends an `ETag` (preferred) or `Last-Modified` header, an unchanged image is neither written to flash nor refreshed on the display.
- **Server-controlled interval:** the response header `X-OpenPaper-Sleep-Seconds` (60–86400) sets the time until the next wake-up.
- **Errors:** if the download fails, the frame shows an error message and tries again after 1 to 5 minutes.
- **Motion wake-up (optional):** the frame also updates when it is moved.
- **Low battery:** below 4.0 V without USB power the frame skips updates to protect the batteries.

## Remote settings (JSON)

Enter a **Settings-JSON-URL** in the Web UI to manage the frame from your server without Bluetooth. The frame loads the file on every wake-up, before the image. If the server sends `Last-Modified`, an unchanged file is skipped.

```json
{
  "timeout": 3600,
  "motionWakeup": false,
  "chargerMode": false,
  "autoRotation": true,
  "downloadUrl": "http://my-server.local/image.bmp",
  "httpAuthUser": "",
  "httpAuthPassword": ""
}
```

| Key | Meaning |
| :--- | :--- |
| `timeout` | Update interval in seconds (60–2592000) |
| `downloadUrl` | Image URL. Switches the frame to WiFi download. |
| `httpAuthUser`, `httpAuthPassword` | HTTP Basic Auth for the image download |
| `motionWakeup` | Update when the frame is moved |
| `autoRotation` | Rotate the image according to the orientation sensor |
| `chargerMode` | Charge the batteries over USB-C. **Only with NiMH batteries!** |

All keys are optional. The button **Prüfen** in the Web UI shows the file and applies it directly.

## Web UI

| Tab | Purpose |
| :--- | :--- |
| **Bild** | Image editor with live preview: palette, dithering, brightness, contrast, saturation. Send the image over Bluetooth or download it as BMP. |
| **Gerät** | WiFi, download URL, interval, settings JSON, motion wake-up, auto rotation, charger mode, factory reset. |
| **Firmware** | Flash the offline, cloud or your own firmware over Bluetooth or USB. Back up and restore certificates (USB). Serial monitor (115200 baud). |
| **Hilfe** | Short instructions. |

**Stable and preview:** the link above opens the stable version (branch `main`). The version button next to the title switches to the preview (branch `dev`). Each version flashes the firmware built from its own branch.

**Run locally:**

```bash
cd web
npm install
npm run dev      # or: npm run build (output in web/dist)
```

Web Bluetooth only works over HTTPS or on `localhost`.

## Certificates

The cloud firmware authenticates with device-specific AWS IoT certificates in the `spiffs` partition (`0x3B0000`, 256 KB). Flashing a firmware in the Web UI does not touch this partition.

- **Back up:** **Firmware → USB-Kabel → Zertifikate sichern** reads the partition and saves it as a `.bin` file.
- **Restore:** **Zertifikate wiederherstellen** writes a backup, or a file from customer support, back to the frame.
- **Back to the cloud firmware:** **Firmware → Original Cloud Firmware → Flashen**.

Backup and restore need a USB cable and bootloader mode (see [Buttons](#buttons)).

## Build from source

**Hardware:** ESP32-C6 (PlatformIO board `esp32-c6-devkitm-1`), Spectra 6 display 7.3" (EL073TF1) or 13.3" (EL133UF3), KXTJ3-1057 accelerometer, batteries with charger (safety timer 4 h, 4 cells, intermittent).

**Software:** Visual Studio Code with PlatformIO (Arduino framework).

```bash
git clone https://github.com/paperlesspaper/paperlesspaper-firmware-offline.git
cd paperlesspaper-firmware-offline
pio run -e epd7 -t upload     # 7.3" display
pio run -e epd13 -t upload    # 13.3" display
```

Put the frame into bootloader mode before uploading. You can also flash `.pio/build/<env>/firmware.bin` in the Web UI (**Firmware → Eigene Firmware**).

> [!CAUTION]
> Do not erase the whole flash and do not upload a filesystem image. Both delete the certificates.

## BLE protocol

The frame advertises as `epd7-<mac>` or `epd13-<mac>` while it is in setup mode.

> [!NOTE]
> The BLE interface has no authentication. While the frame is in setup mode, anyone within radio range can change settings, reset the frame or install firmware.

<details>
<summary><b>Services and characteristics</b></summary>

#### Device data: `7f74170e-7b0e-11ed-a1eb-0242ac120002`

All characteristics: read, notify. UUID suffix: `-7b0e-11ed-a1eb-0242ac120002`.

| UUID | Name | Value |
| :--- | :--- | :--- |
| `4c578d4c` | WiFi connected | One byte: `1` connected, `0` not connected |
| `4c578d4d` | WiFi info | JSON, e.g. `{"ip": "192.168.1.20", "rssi": -65}`; `{}` when not connected |
| `5131a3fc` | WiFi scan | `SSID´RSSI´´SSID2´RSSI2´´…`, filled after the command `SCAN_WIFI` |
| `60000001` | System info | JSON with `voltage` (mV), `usb`, `charging`, `version`, `fw` (`offline`), `display` (`7` or `13`). Updated every 10 seconds. |

#### WiFi: `0515c086-7b0c-11ed-a1eb-0242ac120002`

UUID suffix: `-7b0d-11ed-a1eb-0242ac120002`.

| UUID | Name | Properties | Notes |
| :--- | :--- | :--- | :--- |
| `090b0ef2` | SSID | read, write | Up to 32 characters. Write it before the password. |
| `a62eed84` | Password | write | Up to 64 characters. Writing it starts a connection test (10 seconds). The credentials are stored only if the test succeeds. |

#### Settings: `10000000-0000-0000-0000-000000000001`

UUID suffix: `-0000-0000-0000-000000000001`.

| UUID | Name | Properties | Notes |
| :--- | :--- | :--- | :--- |
| `10000001` | Download URL | read, write | A non-empty URL sets the image mode to `1`. |
| `10000002` | Image mode | read, write | `0` = image sent over BLE, `1` = download from URL |
| `10000003` | Upload data | write, write without response | Binary data for image and firmware uploads |
| `10000004` | Upload command | read, write | Commands and upload status, see below |
| `10000005` | Timeout | read, write | Update interval in seconds, 60–2592000 |
| `10000007` | HTTP user | read, write | HTTP Basic Auth |
| `10000008` | HTTP password | write | HTTP Basic Auth |
| `10000009` | Motion wake-up | read, write | `1` / `0` |
| `1000000a` | Charger mode | read, write | `1` / `0`, NiMH only. Stored immediately. |
| `1000000b` | Settings URL | read, write | URL of the settings JSON |
| `1000000c` | Auto rotation | read, write | `1` / `0`. Stored immediately. |
| `1000000d` | Firmware version | read | Version of the running firmware |

Texts (URLs, HTTP user and password) may be up to 128 characters long. Longer values and timeouts outside the range are ignored. Send `SAVE_SETTINGS` to store the written values permanently.

</details>

<details>
<summary><b>Commands and uploads</b></summary>

Commands are written as text to the upload command characteristic (`10000004`).

| Command | Effect |
| :--- | :--- |
| `SAVE_SETTINGS` | Stores the settings written so far. |
| `SCAN_WIFI` | Starts a WiFi scan. The result arrives as a notification on the WiFi scan characteristic. |
| `APPLY` | Shows the stored image on the display. |
| `EXIT_SETUP` | Leaves setup mode. The frame continues with a normal update. |
| `RESET` | Factory reset and restart. |

**Upload status:** reading `10000004` returns 8 bytes (little endian):

| Bytes | Content |
| :--- | :--- |
| 0–1 | Bytes in the RAM buffer. `0xFFFF` = upload error, `0xFFFE` = sequence error. |
| 2–5 | CRC32 of the RAM buffer. After `END` / `END_FW`: CRC32 of the stored image or firmware. |
| 6–7 | Maximum payload per packet |

**Image upload**

The payload is the raw display image: 4 bits per pixel, row by row, `width × height / 2` bytes (192,000 for 7.3", 960,000 for 13.3"). Color codes: `0` black, `1` blue, `2` green, `3` red, `5` yellow, `6` white.

1. `START` prepares the flash memory and a 32 KB RAM buffer.
2. `V2` selects protocol V2: every packet is 1 byte sequence number + data. The sequence number starts at 0 in every window. (Without `V2`, every packet is 4 bytes CRC32 + data.)
3. Send the data in windows of 32768 bytes to `10000003`.
4. Read the status after each window. If byte count and CRC32 match, send `FLUSH` to write the window to flash. Otherwise send `CLEAR` and repeat the window.
5. `END:<crc32 hex>` finishes the upload. The frame reads the image back from flash and discards it if length or CRC32 do not match.
6. `APPLY` shows the image.

**Firmware upload (OTA)**

1. `START_FW` starts the update.
2. `V2`, then `FW_SIZE:<bytes>` announces the size (65536 to 1900544 bytes).
3. Send the data in windows as for an image. `FLUSH` writes the window to the OTA partition.
4. `END_FW:<crc32 hex>` checks size and CRC32 and restarts the frame with the new firmware about one second later. If a check fails, the old firmware stays active.

A disconnect during an upload discards it.

**USB flashing**

The Web UI uses `esptool-js` over Web Serial at 921600 baud. The firmware is written to `0x10000`, the certificates to `0x3B0000`.

</details>

## Hardware-in-the-loop test

Every push to `main` and `dev` is tested on real hardware before it is published. [`deploy.yml`](.github/workflows/deploy.yml) calls [`hil-test.yml`](.github/workflows/hil-test.yml) and deploys only if the risk analysis and the hardware test pass. The test can also be started manually.

<details>
<summary><b>Details</b></summary>

- **Hardware:** the tests (`hil/`) run on the same self-hosted Windows runner and devices as the [cloud firmware](https://github.com/paperlesspaper/paperlesspaper-firmware). Relays, serial ports and log masking come from its `testbench/` folder. The workflow checks that repository out to `_cloud/`. Locally, a checkout next to this repository is found automatically, or set `CLOUD_TESTBENCH_ROOT`.
- **Steps per device:** flash the candidate over BLE (from cloud or offline firmware) → factory reset with 5 power cycles → check the BLE interface → use the device through the web UI (see below) → flash the cloud production firmware back. The last step always runs because the cloud tests depend on it.
- **Web UI test** (`webtest/`): the built page (`web/dist`) runs in a headless Chromium and is used like a person would use it. `navigator.bluetooth` is replaced by `webtest/shim.js`, which forwards every Bluetooth operation to the test.
  - *Without hardware* (job "Web UI test", before anything is flashed): the page talks to a simulated device (`webtest/simdevice.py`, the BLE protocol of `src/main.cpp`). Covered: connection, settings and their validation, Wi-Fi, picture upload for both displays including packet loss, errors and abort, firmware update and refused firmware files, the check of the download URL.
  - *With hardware* (`test_10` to `test_13` in `hil/`): the same page reaches the real device over the PC's Bluetooth (`hil/web_bridge.py`): settings survive a power cycle, a picture prepared in the browser arrives in the flash unchanged (CRC from the serial log) and is displayed, the firmware update of the page installs the candidate.
  - *Consistency* (`webtest/test_consistency.py`, same job): the limits and BLE identifiers written down in the firmware, the web UI, the simulated device and the hardware tests must agree. Change them in all places together.
  - Not covered: Chrome's own Bluetooth stack and device chooser, and flashing over USB.
  ```powershell
  pip install -r webtest/requirements.txt
  python -m playwright install chromium
  cd web; npm ci; npm run build; cd ..
  python -m pytest webtest -v          # set WEBTEST_HEADED=1 to watch the browser
  ```
- **Run locally** (on the PC with the test hardware):
  ```powershell
  pip install -r hil/requirements.txt
  pio run -e epd7
  python -m hil.run --target epd7 -v
  ```
- **AI steps** (`tools/`, Google Gemini, secret `GEMINI_API_KEY`): before the build, `ai_risk_analysis.py` rates the changes of the push. A rating of HIGH / BLOCKED stops the run before any device is flashed. The test report (`hil/report.py`) summarizes tests and risk rating and adds an AI diagnosis for failed tests. Without the secret, the tests run without these steps. The API receives the diff, the source code in `src/` and log excerpts; secrets, device IDs and paths are masked first.
- **Result files:** only `hil_result_<device>.json` leaves the test PC (test names, result, duration, masked error text). The raw JUnit file is not uploaded because it can contain device IDs.
- **Do not cancel a running test.** It flashes devices over BLE. A device with incomplete firmware can only be recovered by hand.

</details>

## Roadmap

- Store multiple images
- [Immich](https://immich.app/) integration

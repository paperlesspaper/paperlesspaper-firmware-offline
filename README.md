# paperlesspaper Offline Firmware

Offline-first firmware for the paperlesspaper E-Paper frames (ESP32-C6, Spectra 6, 7.3" and 13.3").
The frame runs without any cloud: keep a gallery of images on the frame, sent from your browser over Bluetooth or USB, or let the frame download them from a server in your own network.

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
- [USB link](#usb-link)
- [Hardware-in-the-loop test](#hardware-in-the-loop-test)
- [Roadmap](#roadmap)

## Quick start

1. Open the [Web UI](https://paperlesspaper.github.io/paperlesspaper-firmware-offline/).
2. Press the **reset button** (big button on the back) once. Bluetooth is now active for 30 seconds.
3. Click **Verbinden** and select your frame (`epd7-…` or `epd13-…`).
4. Open **Firmware** and flash the **Offline Firmware**.
5. Add images in **Bild** and press **Synchronisieren**. Or set up WiFi in **Gerät** and a download URL in **Bild** → **Abruf per URL**.

Still running the cloud firmware? It only offers Bluetooth after a factory reset: press the reset button 5 times in quick succession and wait for the WiFi setup screen. Alternatively, flash over USB (**Firmware → USB-Kabel**). The wooden cover can stay on: only the reset button is needed.

The frame is not offered as a serial port? On Windows the driver of its USB bridge may be missing: the frame is then listed in the Device Manager under "Other devices" as "CP2102N USB to UART Bridge Controller". Install the [CP210x Universal Windows Driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers?tab=downloads) (right-click `silabser.inf` → Install). The Web UI explains this when no port is selected and can check whether the frame is connected at all (**USB prüfen**).

## Cloud vs. offline firmware

| | [Cloud firmware](https://github.com/paperlesspaper/paperlesspaper-firmware) (default) | Offline firmware |
| :--- | :--- | :--- |
| **Purpose** | Works out of the box with the paperlesspaper servers | Independent of company servers, private, runs in your own network |
| **Internet** | Required | Not required |
| **Image source** | paperlesspaper cloud ([API](https://docs.paperlesspaper.de/api-guide)) | A gallery sent from the browser (Bluetooth or USB), or download from any URL (Home Assistant, NAS, Raspberry Pi, …) |
| **Dithering** | In the cloud | In the Web UI or on the device |
| **Configuration** | paperlesspaper web app | Web UI over Bluetooth or USB, or a settings JSON on your server |
| **Firmware updates** | Automatic (OTA) | Manual in the Web UI, over Bluetooth or USB |
| **Support** | Official paperlesspaper support | Community, via GitHub issues |

You can switch between both firmwares at any time in the Web UI.

## Buttons

| Action | Result |
| :--- | :--- |
| Press reset **once** | Setup mode: Bluetooth is active for 30 seconds, and the Web UI can connect over USB. Without a connection the frame continues with a normal update. On battery power the frame ends a connection after 10 minutes without input. With a gallery of several pictures the frame shows the next one if nobody connects within 10 seconds; a connection keeps the picture. Bluetooth stays active while the picture changes. |
| Press reset **twice** | Skips setup mode. Gallery: shows the next picture at once. Download: downloads the image again, even if it has not changed. |
| Press reset **5 times** | Factory reset: deletes settings, WiFi credentials, the gallery and the stored image. |
| Hold the small button, press reset, release the small button | Bootloader mode by hand. The small button sits under the wooden cover. Only needed if USB flashing does not start otherwise (older firmware, or a firmware that no longer starts): the Web UI switches the frame to the bootloader itself, a sleeping frame after one press of reset. |

Multiple presses count when each press follows the previous one within 3 seconds.

## Image sources

The frame shows one image and then goes to deep sleep. Where the image comes from depends on what you did last:

### Gallery

Add images in the Web UI (**Bild**). Each one is fitted to the display and dithered to the 6 display colors. **Synchronisieren** sends the gallery to the frame, over Bluetooth or USB. The originals and your edits stay in the browser, so a picture can be edited again later.

- **Storage:** the pictures are stored compressed. The 7.3" frame keeps them in its flash (16 MB), the 13.3" frame on its SD card (128 MB). How many fit depends on the pictures: a photo takes about a third of its uncompressed size (192 KB for 7.3", 960 KB for 13.3").
- **Playing:** in the stored order or shuffled (every picture once per round).
- **Changing:** at the update interval (60 seconds to 30 days), or only on a press of the reset button. Without the interval the frame never wakes up on its own. The reset button shows the next picture: two presses at once, one press after 10 seconds without a connection.
- **Orientation:** landscape or portrait, chosen in the Web UI. All pictures of the gallery are prepared again for the way the frame hangs.
- **No WiFi needed.** While the gallery is shown, nothing is downloaded.
- Pictures that are on the frame but not in this browser (sent from another browser) are kept and marked in the Web UI.

### WiFi download

Enter WiFi credentials in the Web UI (**Gerät**), and a download URL and an update interval in **Bild** → **Abruf per URL**. The frame wakes up at the interval (60 seconds to 30 days, default 1 hour), downloads the image, shows it and sleeps again. Saving a download URL switches the frame from the gallery to WiFi download; syncing the gallery switches back. Saving WiFi credentials alone changes nothing. When the Web UI switches a frame to the download, it asks first and then deletes the gallery on the frame (the browser still has it).

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
- **File size:** up to 6 MB (less if the flash of the frame is smaller). The server does not have to send `Content-Length`: responses with `Transfer-Encoding: chunked` are supported.
- **Login:** optional HTTP Basic Auth for the image download.
- **Caching:** if the server sends an `ETag` (preferred) or `Last-Modified` header, an unchanged image is neither written to flash nor refreshed on the display. Without these headers the frame downloads the file every time and compares it with the last one (checksum): an unchanged image is not refreshed.
- **Server-controlled interval:** the response header `X-OpenPaper-Sleep-Seconds` (60–86400) sets the time until the next wake-up.
- **Errors:** if the download fails, the frame shows an error message once and tries again after 5 minutes, then 15 minutes, then 1 hour, and from then on at the update interval (at least 1 hour). A press of the reset button starts over.
- **Not set up:** without WiFi credentials or a download URL, and without a picture in the gallery, the frame shows a setup hint once and sleeps until the reset button is pressed.
- **Motion wake-up (optional):** the frame also updates when it is moved.
- **Low battery:** below 4.0 V (4 AA cells) without USB power the frame skips updates to protect the batteries. It says so once on the display.

### Device status headers

The frame sends its status as request headers with every request to the image URL and to the Settings-JSON-URL. A server can record them without waking the frame an extra time.

| Header | Example | Meaning |
| :--- | :--- | :--- |
| `X-OpenPaper-Battery-Millivolts` | `5120` | Battery voltage in mV, measured at wake-up before WiFi is switched on |
| `X-OpenPaper-USB-Connected` | `0` | `1` if USB power is connected |
| `X-OpenPaper-Charging` | `0` | `1` if the batteries are being charged (only with charger mode switched on) |
| `X-OpenPaper-Firmware-Version` | `0.1.35` | Firmware version |
| `X-OpenPaper-Display` | `epd7` | `epd7` (7.3") or `epd13` (13.3") |
| `X-OpenPaper-Wakeup` | `timer` | Why the frame woke up: `timer`, `button`, `motion` or `reset` |
| `X-OpenPaper-WiFi-RSSI` | `-67` | WiFi signal strength in dBm |
| `X-OpenPaper-Orientation` | `0` | Side the frame stands on, `0`–`3`. `0` and `2` are opposite sides, `1` and `3` as well; between the two pairs the frame is turned by 90°. Missing if the sensor gave no reading. |

If the server answers with a redirect, the headers are not sent to the redirect target. Exception: a permanent redirect (301) from `http://` to `https://`.

## Remote settings (JSON)

Enter a **Settings-JSON-URL** in the Web UI to manage the frame from your server without Bluetooth. The frame loads the file on every wake-up, before the image. If the server sends an `ETag` (preferred) or `Last-Modified` header, an unchanged file is skipped.

- **URL:** `http://` or `https://`, up to 128 characters. Redirects are followed as for the image.
- **Size:** up to 4 KB. A larger file is ignored.
- **Login:** the HTTP Basic Auth of the image download is sent with this request only if the settings file is on the same server as the image (same protocol, host and port). Otherwise the file must be readable without a login.

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
| `chargerMode` | `false` switches charging over USB-C off. `true` is ignored: charging normal batteries is dangerous, so it can only be switched on in the Web UI (**Gerät**), which asks whether NiMH batteries are inserted. |

All keys are optional. The button **Prüfen** in the Web UI shows the file and applies it directly.

## Web UI

| Tab | Purpose |
| :--- | :--- |
| **Bild** | A switch at the top: **Galerie** or **Abruf per URL**. Gallery: the box with the **+** adds pictures, a click on a picture opens the editor (palette, dithering, brightness, contrast, saturation, BMP download), the ✕ on it deletes it, dragging changes the order. Orientation (landscape / portrait), shuffle and interval of the playback. **Synchronisieren** sends the gallery to the frame and shows what is stored there; after connecting, the page offers it if the two differ. Abruf per URL: download URL, interval, settings JSON, HTTP auth; it can be filled in before a frame is connected, **Synchronisieren** then connects and stores it. |
| **Gerät** | Name, battery, USB and firmware of the connected frame. WiFi, motion wake-up, auto rotation, charger mode, factory reset. The log of the page. |
| **Firmware** | Flash the offline, cloud or your own firmware over Bluetooth or USB. Back up and restore certificates (USB); the dialog before flashing the offline firmware offers the backup too. Serial monitor (115200 baud). |
| **Hilfe** | Short instructions. |

**Connecting:** **Verbinden** asks whether to use Bluetooth or the USB-C cable (Chrome, Edge or Opera on a PC); under **Gerät** one of the two can be chosen for good. Both offer the same functions; press reset on the frame first. Certificates are only read and written over USB in the bootloader (**Firmware**).

**Stable and preview:** the link above opens the stable version (branch `main`). The version button next to the title switches to the preview (branch `dev`). Each version flashes the firmware built from its own branch.

**Run locally:**

```bash
cd web
npm install
npm run dev      # or: npm run build (output in web/dist)
```

Web Bluetooth and Web Serial only work over HTTPS or on `localhost`.

## Certificates

The cloud firmware authenticates with device-specific AWS IoT certificates in the `spiffs` partition (`0x3B0000`, 256 KB). Flashing a firmware in the Web UI does not touch this partition.

- **Back up:** **Firmware → USB-Kabel → Zertifikate sichern** reads the partition and saves it as a `.bin` file.
- **Restore:** **Zertifikate wiederherstellen** writes a backup, or a file from customer support, back to the frame.
- **Back to the cloud firmware:** **Firmware → Original Cloud Firmware → Flashen**.

Backup and restore need a USB cable. The wooden cover can stay on: if needed, the Web UI asks for a press of reset.

## Build from source

**Hardware:** ESP32-C6 (PlatformIO board `esp32-c6-devkitm-1`), Spectra 6 display 7.3" (EL073TF1) or 13.3" (EL133UF3), KXTJ3-1057 accelerometer, batteries with charger (safety timer 4 h, 4 cells, intermittent).

**Software:** Visual Studio Code with PlatformIO (Arduino framework).

```bash
git clone https://github.com/paperlesspaper/paperlesspaper-firmware-offline.git
cd paperlesspaper-firmware-offline
pio run -e epd7 -t upload     # 7.3" display
pio run -e epd13 -t upload    # 13.3" display
```

The external flash (16 MB, W25Q128) holds a [LittleFS](https://github.com/littlefs-project/littlefs) file system (sources in `lib/littlefs`). Its first 64 KB stay untouched: the cloud firmware keeps its directory there.

Put the frame into bootloader mode before uploading (see [Buttons](#buttons)). You can also flash `.pio/build/<env>/firmware.bin` in the Web UI (**Firmware → Eigene Firmware**).

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
| `4c578d4d` | WiFi info | JSON, e.g. `{"ip": "192.168.1.20", "rssi": -65, "ssid": "MyWiFi"}`; `{}` when not connected |
| `5131a3fc` | WiFi scan | `SSID´RSSI´´SSID2´RSSI2´´…`, filled after the command `SCAN_WIFI`. Up to about 500 bytes: read the value after the notification, a notification carries only MTU − 3 bytes. |
| `60000001` | System info | JSON with `voltage` (mV), `usb`, `charging`, `version`, `fw` (`offline`), `gallery` (`1`: the gallery commands exist), `display` (`7` or `13`). Updated every 10 seconds. `setupTimeout: true` announces that the frame ends the setup mode (client idle for 10 minutes on battery power). |

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
| `10000002` | Image mode | read, write | `0` = gallery, `1` = download from URL |
| `10000003` | Upload data | write, write without response | Binary data for gallery and firmware uploads |
| `10000004` | Upload command | read, write | Commands and upload status, see below |
| `10000005` | Timeout | read, write | Update interval in seconds, 60–2592000 |
| `10000007` | HTTP user | read, write | HTTP Basic Auth |
| `10000008` | HTTP password | write | HTTP Basic Auth |
| `10000009` | Motion wake-up | read, write | `1` / `0` |
| `1000000a` | Charger mode | read, write | `1` / `0`, NiMH only. Stored immediately. |
| `1000000b` | Settings URL | read, write | URL of the settings JSON |
| `1000000c` | Auto rotation | read, write | `1` / `0`. Stored immediately. |
| `1000000d` | Firmware version | read | Version of the running firmware |
| `1000000e` | Gallery state | read, notify | JSON, see [Gallery](#gallery-1) below |
| `1000000f` | Read data | read | Next chunk (up to 500 bytes) of the stream opened with `READ:…` |

Texts (URLs, HTTP user and password) may be up to 128 characters long. Longer values and timeouts outside the range are ignored. Send `SAVE_SETTINGS` to store the written values permanently.

</details>

<details>
<summary><b>Commands and uploads</b></summary>

Commands are written as text to the upload command characteristic (`10000004`).

| Command | Effect |
| :--- | :--- |
| `SAVE_SETTINGS` | Stores the settings written so far. |
| `SCAN_WIFI` | Starts a WiFi scan. The result arrives as a notification on the WiFi scan characteristic. |
| `EXIT_SETUP` | Leaves setup mode. The frame continues with a normal update. |
| `RESET` | Factory reset and restart. |

**Upload status:** reading `10000004` returns 8 bytes (little endian):

| Bytes | Content |
| :--- | :--- |
| 0–1 | Bytes in the RAM buffer. `0xFFFF` = error, `0xFFFE` = sequence error, `0xFFFD` = gallery command refused because the display is being refreshed (try again a few seconds later), `0xFFFC` = not enough space. |
| 2–5 | CRC32 of the RAM buffer. After `END` / `END_FW`: CRC32 of the stored upload. After `READ:…`: length of the stream. |
| 6–7 | Maximum payload per packet |

**Uploads**

Gallery pictures, the play order and firmware are uploaded the same way:

1. A start command (`GAL_PUT:…`, `GAL_ORDER:…` or `START_FW`) prepares the target and a RAM buffer of 32 KB. For a gallery upload the buffer is smaller if memory is short: the status after the start command carries its size in `value` (4096 to 32768).
2. `V2` selects protocol V2: every packet is 1 byte sequence number + data. The sequence number starts at 0 in every window. (Without `V2`, every packet is 4 bytes CRC32 + data.)
3. Send the data in windows of that size (firmware: always 32768 bytes) to `10000003`.
4. Read the status after each window. If byte count and CRC32 match, send `FLUSH` to store the window. Otherwise send `CLEAR` and repeat the window.
5. `END:<crc32 hex>` (firmware: `END_FW:<crc32 hex>`) finishes the upload.

<a name="gallery-1"></a>**Gallery**

A picture is one file. All numbers are little endian:

| Offset | Size | Content |
| ---: | ---: | :--- |
| 0 | 2 | `PG` |
| 2 | 1 | version, `1` |
| 3 | 1 | display, `7` or `13` |
| 4 | 2 | length of the preview, up to 8192 |
| 6 | 1 | window of the deflate stream as a power of two, `9` to `15` (`0` means 15). The frame needs that much memory in one piece to unpack: the Web UI uses `12` (4 KB) |
| 7 | 1 | reserved, `0` |
| 8 | 4 | length of the picture after inflating: 192,000 (7.3") or 960,000 (13.3") |
| 12 | 4 | CRC32 of the inflated picture |
| 16 | | the preview: a small JPEG made by the Web UI, the frame does not look at it |
| | | the picture, compressed as raw deflate |

The inflated picture is the raw display image: 4 bits per pixel, row by row. Color codes: `0` black, `1` blue, `2` green, `3` red, `5` yellow, `6` white. The 13.3" display is used upright: its rows are 1200 pixels wide. A file may be at most 16 + preview + picture + 1024 bytes long.

The **id** of a picture is the CRC32 of its file as 8 lowercase hex digits. It is the name of the file on the frame.

| Command | Effect |
| :--- | :--- |
| `GAL_PUT:<id>,<size>` | Starts the upload of a picture file. Status `0xFFFC`: it does not fit, or the gallery holds 400 pictures. At `END` the frame reads the file back and discards it unless length, CRC32 (which must be the id) and header are right. A new picture is added at the end of the order. |
| `GAL_ORDER:<n>` | Starts the upload of the play order: `n` ids, 4 bytes each. Pictures that are not listed keep their place after the listed ones. |
| `GAL_DEL:<id>` | Deletes a picture. |
| `GAL_CLEAR` | Deletes all pictures. |
| `GAL_SET:<shuffle>,<auto>` | Play settings, each `0` or `1`. `auto` = `0`: the picture only changes on a press of the reset button. |
| `GAL_SHOW:<id>` | Shows this picture now and switches the image mode to `0`. |
| `READ:list` | Opens the list for reading: `{"items":[["<id>",<file size>,<preview length>], …]}` in play order. |
| `READ:thumb:<id>` | Opens the preview of a picture. |
| `READ:pic:<id>` | Opens the whole picture file. |

After `READ:…` the status holds the length of the stream. Read `1000000f` until that many bytes have arrived. `READ:pic:<id>,<offset>` resumes at an offset.

The gallery state (`1000000e`) is notified after every change:

```json
{"count":12,"used":812345,"free":14000000,"total":15728640,"storage":"flash","shuffle":0,"auto":1,"current":"1a2b3c4d","rev":17}
```

`used` / `free` / `total` are bytes, `storage` is `flash` or `sd`, `current` is the picture on the display, `rev` changes whenever the list changes.

**Firmware upload (OTA)**

1. `START_FW` starts the update.
2. `V2`, then `FW_SIZE:<bytes>` announces the size (65536 to 1900544 bytes).
3. Send the data in windows as described above. `FLUSH` writes the window to the OTA partition.
4. `END_FW:<crc32 hex>` checks size and CRC32 and restarts the frame with the new firmware about one second later. If a check fails, the old firmware stays active.

A disconnect during an upload discards it.

**USB flashing**

The board has no auto reset. While the frame starts (it prints `[MAIN] test mode check...`) and while it is in setup mode, the character `B` on the serial line (115200 baud) restarts it into the ROM bootloader, if USB power is connected. The cloud firmware has the same command. The Web UI sends it, so the boot button is not needed: a frame in setup mode switches at once, a sleeping frame after one press of reset. The Web UI tries the first for 4 seconds and then asks for a press of reset. The boot button (under the wooden cover) is only the fallback for a firmware without this command or one that no longer starts.

The Web UI uses `esptool-js` over Web Serial at 921600 baud. The firmware is written to `0x10000` (app slot `app0`), the certificates to `0x3B0000`. With a firmware, `otadata` (`0xE000`) is erased as well, so that the bootloader starts `app0`: after an update over the air or over Bluetooth the frame may start `app1`.

</details>

## USB link

Everything a client can do over Bluetooth it can also do over the USB serial line, firmware update included. The frame must be in setup mode (press reset once); a USB session keeps it there.

<details>
<summary><b>Frames</b></summary>

The session starts at 115200 baud, where the frame also prints its log. All numbers are little endian:

| Offset | Size | Content |
| ---: | ---: | :--- |
| 0 | 2 | start `0xA5 0x5A` |
| 2 | 1 | type |
| 3 | 1 | `seq`, chosen by the client and repeated in the answer |
| 4 | 2 | length of the payload, up to 512 |
| 6 | 4 | `key`: the first 32 bits of the characteristic UUID (`0x10000004` for `10000004-…`), `0` otherwise |
| 10 | | payload |
| | 4 | CRC32 of everything from the type to the end of the payload |

| Type | Direction | Meaning |
| ---: | :--- | :--- |
| `0x01` HELLO | to the frame | Starts a session. |
| `0x81` | from the frame | `{"proto":1,"name":"epd7-…","baud":921600}`. The frame then switches to that speed, the client reopens the port with it. |
| `0x02` PING / `0x82` | | Keep-alive: the frame ends a session after 20 seconds without a frame and returns to 115200 baud. |
| `0x03` BYE | to the frame | Ends the session. |
| `0x10` READ / `0x90` | | Reads a characteristic. The answer carries the value. |
| `0x11` WRITE / `0x91` | | Writes a characteristic. The answer carries one byte, `0`. |
| `0x12` WRITE_NR | to the frame | Writes without an answer (the data packets of an upload). |
| `0x20` NOTIFY | from the frame | The value of a characteristic has changed. |
| `0x7F` ERROR | from the frame | Unknown characteristic, or it cannot be read or written. |

The frame keeps printing log lines between the frames: a client skips everything that is not a frame with a correct CRC32. While a session is open, the bootloader command `B` is not evaluated.

</details>

## Hardware-in-the-loop test

Every push to `main` and `dev` is tested on real hardware before it is published. [`deploy.yml`](.github/workflows/deploy.yml) calls [`hil-test.yml`](.github/workflows/hil-test.yml) and deploys only if the risk analysis and the hardware test pass. The test can also be started manually.

A merge of `dev` into `main` is not tested twice: if `main` has exactly the files of a `dev` deployment that passed, the firmware of that deployment is published with its version and the hardware test is skipped. If `main` differs (a direct commit, a merge with other changes), the test runs. A manual run of `deploy.yml` with **force_hil** runs it in any case.

<details>
<summary><b>Details</b></summary>

- **Hardware:** the tests (`hil/`) run on the same self-hosted Windows runner and devices as the [cloud firmware](https://github.com/paperlesspaper/paperlesspaper-firmware). Relays, serial ports and log masking come from its `testbench/` folder. The workflow checks that repository out to `_cloud/`. Locally, a checkout next to this repository is found automatically, or set `CLOUD_TESTBENCH_ROOT`.
- **Steps per device:** flash the candidate over BLE (from cloud or offline firmware) → factory reset with 5 power cycles → check the BLE interface → gallery over Bluetooth (store, read back, show, next picture with two presses and with one) → the same interface over the USB link, including a display refresh during the session → use the device through the web UI (see below) → flash over USB without the boot button and check that the flashed firmware starts from `app0` → web UI over the USB cable → flash the cloud production firmware back. The last step always runs because the cloud tests depend on it.
- **Web UI test** (`webtest/`): the built page (`web/dist`) runs in a headless Chromium and is used like a person would use it. `navigator.bluetooth` and `navigator.serial` are replaced by `webtest/shim.js`, which forwards every Bluetooth operation and the bytes of the serial port to the test.
  - *Without hardware* (job "Web UI test", before anything is flashed): the page talks to a simulated device (`webtest/simdevice.py`, the BLE protocol of `src/main.cpp` and the USB link of `src/usb_link.cpp`). Covered: connection, settings and their validation, Wi-Fi, the gallery (editor, order, sync for both displays including packet loss, a full storage, a busy display, errors, abort and resume, pictures that are only on the device), firmware update and refused firmware files, and the USB link (connect, settings, gallery sync, firmware update, a pulled cable, a sleeping device).
  - *With hardware* (`test_10` to `test_13` and `test_15` in `hil/`): the same page reaches the real device over the PC's Bluetooth or its serial port (`hil/web_bridge.py`): settings survive a power cycle, a picture prepared in the browser arrives in the gallery unchanged (CRC from the serial log) and is displayed, the firmware update of the page installs the candidate, and a gallery sync works over the USB cable.
  - *Consistency* (`webtest/test_consistency.py`, same job): the limits, BLE identifiers, gallery constants and USB link frames written down in the firmware, the web UI, the simulated device and the hardware tests must agree. Change them in all places together.
  - Not covered: Chrome's own Bluetooth and serial stacks and their choosers, and the flasher of the page (`esptool-js`). Flashing over USB is tested with `esptool` and the same steps (`test_14`).
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

- Download a gallery from a URL
- [Immich](https://immich.app/) integration

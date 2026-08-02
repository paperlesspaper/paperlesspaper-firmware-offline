# E-Paper ESP32-C6 Firmware

Offline first Firmware for an ESP32-C6 based E-Paper display device, featuring Web-BLE configuration, direct image upload via Bluetooth, WiFi HTTP image download, and OTA updates.

> ⚠️ **WARNING:** If you delete the spiffs partition on your device, the certificates for cloud connection are gone. The device can´t connect to our servers anymore.


## Comparison: Cloud Firmware vs. Offline Firmware

| Feature / Attribute | [Cloud Firmware](https://github.com/paperlesspaper/paperlesspaper-firmware) (Default) | [Offline Firmware](https://github.com/paperlesspaper/paperlesspaper-firmware-offline/) (Alternative) |
| :--- | :--- | :--- |
| **Primary Purpose** | Convenient out-of-the-box usage via official infrastructure. Ideal for users who do not want to maintain their own server setup. | Maximum independence, privacy, and long-term sustainability ("Offline-First"). Makes the frame completely independent of company servers. |
| **Server Dependency** | Requires an active internet connection and access to official [paperlesspaper.de](https://paperlesspaper.de/) servers. | **100% local and standalone.** Operates entirely within your local network without any internet requirement (HTTP or BLE). |
| **Image Source & Fetching** | Images are fetched centrally from the cloud via the official [API](https://docs.paperlesspaper.de/api-guide). | Flexible sources: Direct local upload via Bluetooth or automated HTTP download from any local URL (e.g., Home Assistant, Synology, Raspberry Pi). |
| **Image Processing (Dithering)** | **Server-side:** Optimal color dithering is pre-calculated in the cloud. The display receives raw, ready-to-render data. | **On-Device or Local Dithering:** The ESP32-C6 dynamically scales and dithers standard JPEGs and 24-bit BMPs (Floyd-Steinberg) directly on-chip to match the display palette or uses pre dithered BMP. |
| **Configuration** | Managed via the official paperlesspaper web dashboard and onboarding portal. | Configured via Bluetooth using the hosted [Web-UI & Flasher](https://paperlesspaper.github.io/paperlesspaper-firmware-offline/) or automated via a local `settings.json` file. |
| **Firmware Updates (OTA)** | Fully automatic Over-the-Air (OTA) updates managed directly via cloud infrastructure. | Manual updates conducted wirelessly over Bluetooth (Web-BLE) or directly over USB cable (Web Serial) in the browser. |
| **Support & Assistance** | **Official Vendor Support:** Direct support for setup, hardware issues, and cloud services provided via official paperlesspaper channels. | **Community & Self-Service:** Issue tracking, feature requests, and technical discussions managed independently via GitHub repository issues. |
| **Switching & Reverting** | Cloud Firmware can be replaced via Offline Firmware Web Tool | Can be returned to Cloud Firmware via Web Tool ⚠️ **Important Note:** If you delete the spiffs partition on your device, the certificates for cloud connection are gone. The device can´t connect to our servers anymore. |

## Hardware Requirements

- **Microcontroller**: ESP32-C6-DevKitM-1
- **Display**: Spectra 6 7.3" (EL073TF1) **OR** Spectra 6 13.3" (EL133UF3)
- **Sensors**: KXTJ3-1057 Accelerometer
- **Other**: Battery, Charger circuit (see Hardware Settings below)

## Software Requirements

- **IDE**: Visual Studio Code
- **Extension**: PlatformIO
- **Framework**: Arduino (via PlatformIO)

## Installation & Setup

1.  **Clone the Repository**

    ```bash
    git clone <repository-url>
    cd <repository-name>
    ```

2.  **Web-UI (Setup & Flasher)**
    You can use the **hosted version** of the Web-UI directly from your browser (requires a Web Bluetooth / Web Serial compatible browser like Chrome or Edge):
    👉 **[Launch Web-UI & Flasher](https://paperlesspaper.github.io/paperlesspaper-firmware-offline/)**
    *   **Wireless Flashing**: Update settings and upload images/firmware wirelessly via Bluetooth (Web-BLE).
    *   **USB Flashing**: Flash the firmware binary directly over a USB-C cable (Web Serial) using the built-in esptool.

    *Alternatively, to run the web frontend locally:*
    - Navigate to the `web/` folder.
    - Install dependencies: `npm install`
    - Build or run via Vite: `npm run dev` or `npm run build`
    - You can set WiFi credentials, a local HTTP download URL, the sleep timeout, or upload an image directly via Web-BLE.

3.  **Self-host with Docker**
    - Build firmware artifacts locally first (default, no external firmware host dependency):
      ```bash
      ./scripts/build-local-firmware-assets.sh
      ```
    - Build and run the container:
      ```bash
      docker compose up --build
      ```
    - Open the Web-UI at `http://localhost:8080` (or your configured `HOST_PORT`).
    - The container serves:
      - the built Web-UI (`web/dist`)
      - offline firmware files (`/firmware_offline_epd7.bin`, `/firmware_offline_epd13.bin`)
      - factory OTA files (`/factory/*`)
    - Build-time mode (default: local):
      - `FIRMWARE_SOURCE=local` (default): use `build-artifacts/firmware/*`
      - `FIRMWARE_SOURCE=remote`: use remote firmware URLs below
    - Remote mode example:
      ```bash
      FIRMWARE_SOURCE=remote docker compose up --build
      ```
    - Runtime environment variables (optional, defaults are built in):
      - `APP_PROXY_1_BASE` (default: `https://corsproxy.io/?`)
      - `APP_PROXY_2_BASE` (default: `https://api.allorigins.win/raw?url=`)
      - `APP_FACTORY_PRE_JSON_BASE_URL` (default: empty -> same-origin fallback in app)
      - `APP_FACTORY_PRE_BIN_BASE_URL` (default: empty -> same-origin fallback in app)
      - `APP_OFFLINE_FIRMWARE_BASE_URL` (default: empty -> same-origin fallback in app)
    - Build-time firmware source overrides (optional):
      - `OFFLINE_FIRMWARE_EPD7_URL`, `OFFLINE_FIRMWARE_EPD13_URL`
      - `FACTORY_JSON_EPD7_PRE_URL`, `FACTORY_JSON_EPD13_PRE_URL`
      - `FACTORY_FIRMWARE_EPD7_PRE_URL`, `FACTORY_FIRMWARE_EPD13_PRE_URL`

4.  **Build and Upload Firmware**
    - Select your display size in `src/main.cpp` via the macro `#define SET_DISPLAY` (`0` for 7-inch, `1` for 13-inch).
    - Start your Devices **Boot Mode** (see "Hardware Settings" below for instructions)
    - Run the PlatformIO task: `General` -> `Upload`.

## Modes of Operation
- **Setup Mode (BLE Activation)**: Press the **reset button once** (the big button) to wake the device and activate Bluetooth (BLE). 
  - Once active, you can connect to the device via the Web-UI to configure settings or upload an image.
  - If you do not connect via BLE, the device will automatically fall back to normal operation after 30 seconds: it will try to connect to the configured WiFi to download a new image, or, if WiFi is unavailable/not configured, it will simply load the last stored image before going back to deep sleep.
- **Force Download / Skip Setup**: Press the **reset button twice** (or more) in quick succession to boot the device:
  - This skips the BLE Setup Mode entirely to speed up the process.
  - It also forces a fresh image download from the configured URL, bypassing HTTP cache/modification checks (`forceDownload`), so the display is guaranteed to refresh.
- **BLE Upload**: Easily load and dither an image in the Web-UI and transmit it to the display entirely offline via Bluetooth. (BLE expects pre-dithered raw payloads for maximum transmission efficiency). The Web-UI automatically detects your display size via BLE (7" vs 13") and adjusts the layout. For the 13" display, the live-preview is rendered at 1/4 resolution for smooth slider performance, while the final image is automatically processed in full 1200x1600 resolution upon upload.
- **WiFi Download**: Configure a Download URL (e.g., `http://local-server/image.jpg` or `.bmp`), and the ESP32 will fetch the display contents via WiFi upon waking up. 
  - **On-Device Dithering**: The firmware automatically detects whether the downloaded file is a pre-dithered 4-bit BMP, a standard 24-bit BMP, or a JPEG image. 
  - 24-bit BMPs and JPEGs are dynamically scaled and perfectly dithered (Floyd-Steinberg) directly on the ESP32 to match the display's 6-color palette. This significantly reduces server-side preprocessing and allows fetching normal web JPEGs directly!
- **Deep Sleep**: The device enters deep sleep to save power after an update. It wakes up via:
  - Timer (configurable duration).
  - Accelerometer (motion) (optional).
  - Button press.

## Memory Map (EEPROM/Flash)

- `0-39`: WiFi Name
- `40-105`: WiFi Password
- `210`: Sleep Time
- `220`: Display Orientation Store
- `499`: Magic Flag (First Boot Indicator)
- `500+`: Settings Store

> **First Boot Initialization**: Beim ersten Start (oder wenn die Magic Flag bei Adresse 499 nicht `42` ist) wird der EEPROM automatisch bereinigt und mit sinnvollen Standardwerten (z.B. Timeout = 3600s) initialisiert.

## Remote JSON Settings

The firmware supports fetching its configuration automatically from an HTTP JSON endpoint. This allows you to manage the device behavior directly from your smart home server or cloud without connecting via BLE.

- Configure the **Settings JSON URL** in the Web-UI or via BLE.
- When the device wakes up and connects to WiFi, it will automatically fetch the JSON.
- It leverages the HTTP `Last-Modified` and `If-Modified-Since` headers to avoid unnecessary parsing and EEPROM writes, saving battery and flash memory life.
- In the Web-UI, you can click "Prüfen" to preview the JSON and apply it directly. The Web-UI uses an intelligent CORS proxy fallback to bypass browser security restrictions when testing public URLs.

An example `settings_sample.json` is provided in the repository:
```json
{
  "timeout": 3600,
  "motionWakeup": false,
  "chargerMode": false,
  "downloadUrl": "https://paperlesspaper.de/b?d=MY_DEVICE_ID",
  "httpAuthUser": "",
  "httpAuthPassword": ""
}
```

## Hardware Settings

- **Charger**: Safety TMR 4h, 4-cell intermittent.
- **Reset**: 5+ presses
- **Boot Mode**: Hold the small button, short press the reset button (big button) while holding the small button, then release the small button.

## BLE Protocol Documentation

Die Kommunikation zwischen der Web-UI und der E-Paper Firmware erfolgt über Bluetooth Low Energy (BLE). Das Gerät stellt dazu verschiedene Services und Characteristics (UUIDs) bereit.

### 1. Device Data Service
**Service UUID**: `7f74170e-7b0e-11ed-a1eb-0242ac120002`
Liest den aktuellen Status des Geräts (WLAN etc.).

| UUID | Name | Properties | Beschreibung |
|------|------|------------|--------------|
| `4c578d4c-...` | **WiFi Connected** | Read, Notify | Gibt `1` zurück, wenn mit WLAN verbunden, sonst `0`. |
| `4c578d4d-...` | **WiFi Info** | Read, Notify | JSON-String mit Verbindungsdetails (z.B. `{"ip": "192...", "rssi": -65}`). |
| `4c578d4e-...` | **System Info** | Read, Notify | JSON-String mit Systemdaten (Batteriespannung in mV, USB-Status, Ladestatus). |
| `5131a3fc-...` | **WiFi Scan** | Read, Notify | Liste gefundener WLANs. Wird asynchron befüllt, wenn das Kommando `SCAN_WIFI` über den Upload CMD Kanal gesendet wurde. Format: `SSID´RSSI´´SSID2´RSSI2´´`. |

### 2. WiFi Data Service
**Service UUID**: `0515c086-7b0c-11ed-a1eb-0242ac120002`
Überträgt Zugangsdaten an den ESP32. Die Zugangsdaten werden beim Ändern direkt angewendet und getestet.

| UUID | Name | Properties | Beschreibung |
|------|------|------------|--------------|
| `090b0ef2-...` | **SSID** | Read, Write | WLAN Name. |
| `a62eed84-...` | **Password** | Read, Write | WLAN Passwort. |

### 3. E-Paper Settings Service
**Service UUID**: `10000000-0000-0000-0000-000000000001`
Verwaltet alle Einstellungen und kümmert sich um den Upload von Bildern und Firmware-Updates.

| UUID | Name | Properties | Beschreibung |
|------|------|------------|--------------|
| `10000001-...` | **Download URL** | Read, Write | HTTP URL für den Bild-Download. Bei Eingabe einer URL wechselt das Gerät automatisch in den URL-Modus (Image Mode = 1). |
| `10000002-...` | **Image Mode** | Read, Write | Modus: `0` = Lokales Bild (BLE), `1` = Web URL. |
| `10000003-...` | **Upload Data** | Write | Stream für Binärdaten (Bilder / Firmware). Das 1. Byte ist der CRC8 des restlichen Payloads. |
| `10000004-...` | **Upload CMD** | Read, Write | Befehlskanal (siehe "Befehle" unten). Bei "Read" liefert er die aktuell im RAM befindlichen Bytes (für den Bild-Upload Checkpoint-Mechanismus). |
| `10000005-...` | **Timeout** | Read, Write | Sleep Timeout in Sekunden (z.B. `3600`). |
| `1000000b-...` | **Settings URL** | Read, Write | Optionale HTTP(s) URL zu einem JSON-Config File. |
| `10000007-...` | **HTTP User** | Read, Write | Benutzername für HTTP Basic Auth. |
| `10000008-...` | **HTTP Pass** | Read, Write | Passwort für HTTP Basic Auth. |
| `10000009-...` | **Motion Wakeup** | Read, Write | `1` / `true` = Aufwecken bei Bewegung aktiviert (nur URL Modus). |
| `1000000a-...` | **Charger Mode** | Read, Write | `1` / `true` = Ladefunktion für NiMH-Akkus aktiviert. |
| `1000000c-...` | **Auto Rotation** | Read, Write | `1` / `true` = Automatische Bildschirmausrichtung via Accelerometer aktiviert. |

---

### Upload & Befehle (CMD Channel `10000004-...`)

Der CMD Channel verarbeitet Strings, um Uploads zu steuern oder das Gerät zurückzusetzen:

- `RESET`: Löscht alle Einstellungen im EEPROM (Factory Reset) und startet neu.
- `APPLY`: Beendet den Setup-Modus vorzeitig und lädt das neu empfangene Bild auf das Display.
- `SCAN_WIFI`: Startet einen asynchronen WLAN-Scan. Die Ergebnisse werden anschließend per Notification über den `WiFi Scan` Characteristic zurückgesendet.

#### Ablauf: Bild Upload (BMP)
Bilder werden in kleine "Checkpoints" (Fenster) unterteilt, um Paketverlusten vorzubeugen:
1. `START`: Bereitet den Flash-Speicher (`tmp.bmp`) und den RAM-Puffer für ein neues Bild vor.
2. Senden der Daten (über `Upload Data`): In Chunks à z.B. 238 Bytes + 1 Byte CRC.
3. Nach einem Checkpoint-Fenster (z.B. 80 Pakete) liest die Web-UI den `Upload CMD` (Read). Stimmen die gesendeten Bytes mit dem im ESP gepufferten Wert überein, wird der Befehl `FLUSH` gesendet, um die Daten aus dem RAM in den Flash zu schreiben. Bei einem Fehler (Bytes fehlen) sendet die UI `CLEAR`, um den RAM zu leeren, und überträgt das Fenster erneut.
4. `END`: Schließt die Datei ab.
5. `APPLY`: Zeigt das Bild direkt auf dem Display an.

#### Ablauf: Firmware Upload (OTA via BLE)
Die Firmware wird direkt in die OTA-Partition geflasht. Es gibt keinen Checkpoint-Mechanismus in der Web-UI, dafür wartet sie auf das erfolgreiche Senden jedes einzelnen Pakets:
1. `START_FW`: Initialisiert den OTA-Prozess (`Update.begin()`).
2. Senden der Daten (über `Upload Data`): In Chunks. Jeder Chunk wird vom ESP per CRC geprüft und direkt mit `Update.write()` geschrieben.
3. `END_FW`: Schließt den OTA-Prozess ab (`Update.end()`) und startet das Gerät automatisch in der neuen Firmware neu.

#### Ablauf: Firmware Upload (via USB / Web Serial)
Falls Bluetooth nicht verfügbar ist oder du das Gerät lieber direkt per Kabel flashen möchtest, unterstützt die Web-UI das Flashen über die Web Serial API (mittels `esptool-js`):
1. **Verbindung herstellen**: Verbinde das E-Paper-Display per USB-C-Kabel mit deinem PC.
2. **Bootloader-Modus aktivieren**: Halte den kleinen Knopf auf der Rückseite gedrückt, drücke kurz den Reset-Knopf (großer Knopf) und lass den kleinen Knopf dann los.
3. **Flashen**: Wähle in der Web-UI den Reiter "USB-Kabel (COM-Port)", klicke auf den Flash-Button, wähle den passenden COM-Port im Browser-Dialog aus und der Flasher überträgt die App-Partition (Baudrate: `921600`, Offset: `0x10000`) automatisch auf das Gerät.


## Roadmap (not ordered)

- (done) settings json for http endpoint to change device behavior in local network
- (done) settings for motion wakeup and charger via ble
- (done) ota upload via ble (revert back to cloud firmware)
- (done) load device settings to web ui via ble (2 way sync)
- (done) on device dithering with jpg support
- (done) electron tool to update offline firmware or web flasher
- (done) add rotation setting to bluetooth
- (done) host the tool on our infrastructure (select latest firmware build too)
- store multiple images
- https://immich.app/ integration into firmware and config via ble
- bluetooth broadcast mode

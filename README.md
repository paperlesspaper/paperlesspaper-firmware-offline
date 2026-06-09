# E-Paper ESP32-C6 Firmware

Offline first Firmware for an ESP32-C6 based E-Paper display device, featuring Web-BLE configuration, direct image upload via Bluetooth, WiFi HTTP image download, and OTA updates.

> ⚠️ **WARNING:** Once this offline firmware is installed, there is currently no way to revert back to the original cloud firmware. A tool to enable this reversion will be released in the future.

## Hardware Requirements

- **Microcontroller**: ESP32-C6-DevKitM-1
- **Display**: Spectra 6 7.3 (EL073TF1)
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

2.  **Web-UI (BLE Setup & Image Upload)**
    This project includes a web-based frontend in the `web/` directory. It uses Web Bluetooth (BLE) to communicate with the E-Paper display directly from your browser.
    - Navigate to the `web/` folder.
    - Install dependencies: `npm install`
    - Build or run via Vite: `npm run build`
    - You can set WiFi credentials, a local HTTP download URL, the sleep timeout, or upload an image directly via Web-BLE.

3.  **Build and Upload Firmware**
    - Start your Devices **Boot Mode** (see "Hardware Settings" below for instructions)
    - Run the PlatformIO task: `General` -> `Upload`.

## Modes of Operation
- **Setup Mode (BLE Activation)**: Press the **reset button once** (the big button) to wake the device and activate Bluetooth (BLE). 
  - Once active, you can connect to the device via the Web-UI to configure settings or upload an image.
  - If you do not connect via BLE, the device will automatically fall back to normal operation after 30 seconds: it will try to connect to the configured WiFi to download a new image, or, if WiFi is unavailable/not configured, it will simply load the last stored image before going back to deep sleep.
- **BLE Upload**: Easily load and dither an image in the Web-UI and transmit it to the display entirely offline via Bluetooth.
- **WiFi Download**: Configure a Download URL (e.g., `http://local-server/image.bmp`), and the ESP32 will fetch the display contents via WiFi upon waking up.
- **Deep Sleep**: The device enters deep sleep to save power after an update. It wakes up via:
  - Timer (configurable duration).
  - Accelerometer (motion) (optional).
  - Button press.

## Memory Map (EEPROM/Flash)

- `0-39`: WiFi Name
- `40-105`: WiFi Password
- `210`: Sleep Time
- `220`: Dispay Orientation Store
- `499`: Magic Flag (First Boot Indicator)
- `500+`: Settings Store

> **First Boot Initialization**: Beim ersten Start (oder wenn die Magic Flag bei Adresse 499 nicht `42` ist) wird der EEPROM automatisch bereinigt und mit sinnvollen Standardwerten (z.B. Timeout = 3600s) initialisiert.

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
| `10000001-...` | **Download URL** | Read, Write | HTTP URL für den Bild-Download. |
| `10000002-...` | **Image Mode** | Read, Write | Modus: `0` = Lokales Bild (BLE), `1` = Web URL. |
| `10000003-...` | **Upload Data** | Write | Stream für Binärdaten (Bilder / Firmware). Das 1. Byte ist der CRC8 des restlichen Payloads. |
| `10000004-...` | **Upload CMD** | Read, Write | Befehlskanal (siehe "Befehle" unten). Bei "Read" liefert er die aktuell im RAM befindlichen Bytes (für den Bild-Upload Checkpoint-Mechanismus). |
| `10000005-...` | **Timeout** | Read, Write | Sleep Timeout in Sekunden (z.B. `3600`). |
| `10000006-...` | **Clear Screen** | Read, Write | `1` / `true` = Display vor Update flashen. |
| `10000007-...` | **HTTP User** | Read, Write | Benutzername für HTTP Basic Auth. |
| `10000008-...` | **HTTP Pass** | Read, Write | Passwort für HTTP Basic Auth. |

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

## Roadmap (not ordered)

- settings json for http endpoint to change device behavior in local network
- (done) settings for motion wakeup and charger via ble
- store multiple images
- (done) ota upload via ble (revert back to cloud firmware)
- (done) load device settings to web ui via ble (2 way sync)
- on device dithering with jpg support
- https://immich.app/ integration into firmware and config via ble
- (done) electron tool to update offline firmware or web flasher
- host the tool on our infrastructure (select latest firmware build too)

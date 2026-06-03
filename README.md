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
  - If you do not connect via BLE, the device will automatically fall back to normal operation after 60 seconds: it will try to connect to the configured WiFi to download a new image, or, if WiFi is unavailable/not configured, it will simply load the last stored image before going back to deep sleep.
- **BLE Upload**: Easily load and dither an image in the Web-UI and transmit it to the display entirely offline via Bluetooth.
- **WiFi Download**: Configure a Download URL (e.g., `http://local-server/image.bmp`), and the ESP32 will fetch the display contents via WiFi upon waking up.
- **Deep Sleep**: The device enters deep sleep to save power after an update. It wakes up via:
  - Timer (configurable duration).
  - Accelerometer (motion) (optional).
  - Button press.

## Memory Map (EEPROM/Flash)

- `0-39`: WiFi Name
- `40-105`: WiFi Password
- `140`: Reconnect Count
- `150`: File Version
- `160`: Activated Flag
- `170`: Activation Counter
- `190`: Display Revision Store
- `200`: WiFi Lost State
- `210`: Sleep Time
- `220`: Dispay Orientation Store
- `500+`: Settings Store

## Hardware Settings

- **Charger**: Safety TMR 4h, 4-cell intermittent.
- **Reset**: 5+ presses
- **Boot Mode**: Hold the small button, short press the reset button (big button) while holding the small button, then release the small button.

## Roadmap (not ordered)

- settings json for http endpoint to change device behavior in local network
- ota upload via ble (revert back to cloud firmware)
- settings for motion wakeup and charger via ble
- store multiple images
- load device settings to web ui via ble (2 way sync)
- on device dithering
- https://immich.app/ integration into firmware and config via ble
- electron tool to update offline firmware or web flasher
- host the tool on our infrastructure

# Copilot Instructions for `paperlesspaper-firmware-offline`

## Project overview

An offline-first ESP32-C6 firmware for Spectra 6 e-paper displays (7.3" and 13"), paired with a single-file web app for BLE-based setup and image upload. Three cooperating parts: ESP32 firmware (C++/PlatformIO/Arduino), a Vite-based Web UI (vanilla JS + Tailwind), and a GitHub Actions deployment pipeline.

## Build, test, and lint commands

### Firmware (PlatformIO)
- Build: `pio run -e ESP32-C6-DevKitM-1`
- Upload to device (USB): `pio run -e ESP32-C6-DevKitM-1 -t upload`
- Serial monitor: `pio device monitor -b 115200`

### Web UI (`web/`)
- Install deps: `npm ci`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Preview build: `npm run preview`

### Dithering profiler (`profiler/`)
- Install deps: `npm ci`
- Dev server: `npm run dev`
- Build: `npm run build`

### Tests / lint
- There is currently no dedicated automated test suite in this repository (no test runner config or test scripts).
- There is currently no dedicated lint script in `package.json` or CI.

## High-level architecture

This repository has three cooperating parts:

1. **ESP32 firmware (`src/main.cpp`, `src/epaper_display.*`, `src/types.h`)**
   - `main.cpp` orchestrates boot flow, setup mode, BLE/Wi-Fi behavior, HTTP download, image processing, persistence, and deep sleep. BLE is implemented via `NimBLEDevice`.
   - `epaper_display.cpp` is the display driver layer (rendering, quick refresh tuning, 7"/13" differences, pixel color mapping, overlays, rotation). Uses GxEPD2 libraries.
   - `types.h` defines shared runtime structs (`Settings`, `WifiSettings`, `SystemData`, display settings/info).
   - Hardware: ESP32-C6, KXTJ3-1057 accelerometer (motion wake source).

2. **Web BLE setup/flasher (`web/src/app.js`, `web/src/DeviceBleInterface.js`, `web/src/GeneratePicture.js`)**
   - `DeviceBleInterface.js` is the protocol client: BLE UUIDs, characteristic reads/writes, notification listeners, checkpointed uploads (CRC32 + `FLUSH`/`CLEAR`), OTA commands (`START_FW`/`END_FW`).
   - `GeneratePicture.js` performs image preparation and dithering (`epdoptimize`), then packs display pixels into 4-bit indexed payload format.
   - `app.js` is the UI orchestration layer (settings forms, preview, upload, OTA via BLE or Web Serial `esptool-js`).

3. **Deployment pipeline (`.github/workflows/deploy.yml`)**
   - Builds firmware for both display targets.
   - Builds web UI and bundles offline firmware binaries into `web/dist`.
   - Publishes the single-file web app to GitHub Pages.

### Runtime data flow (important)
- **BLE mode**: Web UI generates packed image payload -> firmware receives chunks into `tmp.bmp` via checkpoint protocol -> `APPLY` triggers display render.
- **URL mode**: Firmware wakes -> connects Wi-Fi -> optional remote JSON settings fetch -> downloads image (`tmp_raw.bin`) -> converts if needed (JPEG / 24-bit BMP -> dithered packed format) -> renders `tmp.bmp`.
- Settings are persisted in EEPROM and restored on boot; remote settings use `If-Modified-Since`/`Last-Modified` caching.

## Operating modes and wake sources

- **Setup mode**: triggered by a single reset-button press → activates BLE so the web UI can configure Wi-Fi, settings, and push images.
- **Wi-Fi download mode**: firmware wakes, connects Wi-Fi, optionally fetches remote settings JSON, downloads and renders image, then sleeps.
- **Deep sleep wake sources**: timer (configurable interval), motion (KXTJ3-1057 accelerometer interrupt), button press.

## Key conventions specific to this codebase

- **Ask clarifying questions**: if requirements are ambiguous, incomplete, or could be interpreted multiple ways, ask before making broad assumptions.
- **BLE protocol is strict and mirrored on both sides**: if you change UUIDs, command strings, or upload semantics, update all relevant files together: `src/main.cpp`, `web/src/DeviceBleInterface.js`, `web/src/app.js`, and `web/src/index.html`.
- **Upload packet format**: first 4 bytes are CRC32 of payload chunk, followed by chunk bytes; firmware verifies CRC before buffering.
- **Checkpoint contract**: Web UI reads `UPLOAD_CMD` characteristic as current RAM byte count, then sends `FLUSH` on match or `CLEAR` on mismatch.
- **Display payload format**: 4-bit color indices packed two pixels per byte; active palette indices are `0,1,2,3,5,6` (index `4` unused).
- **Dual display support is compile-time + runtime-aware**:
  - Compile-time paths use `EPD_TYPE_13INCH` / 7-inch alternatives.
  - BLE device name prefix (`epd13-` vs `epd7-`) is used by the web UI for behavior/layout.
- **Preserve EEPROM address compatibility**: settings offsets in `main.cpp` are a compatibility contract with existing devices. Concrete ranges: Wi-Fi settings at `0–105`, general settings from `500+`. Do not shift or reorder these without a migration strategy.
- **Web build is intentionally single-file oriented** (`vite-plugin-singlefile` + relative `base: "./"`). Keep OTA/asset paths relative where expected.
- **HTML formatting in `web/src/index.html` is intentionally non-standard in places** (notably top-level tag indentation and a `prettier-ignore` block). Keep existing formatting style stable when editing this file.
- **Formatting defaults currently in repo**:
  - C++ style is governed by `.clang-format` (not LLVM defaults; custom brace/indent behavior).
  - Web formatting is governed by `web/.prettierrc` (global `tabWidth: 2`, HTML override `tabWidth: 4`, `singleQuote: true` for HTML override only).

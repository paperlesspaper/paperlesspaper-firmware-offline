import { STATUS_NO_SPACE, STATUS_DISPLAY_BUSY, STATUS_SEQ_ERROR, STATUS_UPLOAD_ERROR, hexId } from "./galleryFormat.js";
import { UsbLinkDevice } from "./usbLink.js";

export const MAX_OTA_FW_SIZE = 0x1d0000; // 1.900.544 Bytes (app0/app1 in part.csv)
export const MIN_OTA_FW_SIZE = 65536;
const DISPLAY_BUSY_WAIT_S = 90; // a display refresh takes up to about 45 s
const READ_SLICE_CHUNKS = 24; // chunks of a stream read in one go, then other GATT work gets its turn

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error the caller handles by its code: "NO_SPACE", "BUSY". */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function validateEsp32FirmwareBinary(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length < MIN_OTA_FW_SIZE) {
    throw new Error(`Ungültige Firmware-Datei: Datei ist zu klein (${(bytes.length / 1024).toFixed(1)} KB).`);
  }
  if (bytes.length > MAX_OTA_FW_SIZE) {
    throw new Error(`Firmware-Datei ist zu groß (${(bytes.length / 1024).toFixed(1)} KB, maximal ${(MAX_OTA_FW_SIZE / 1024).toFixed(0)} KB für die OTA-Partition).`);
  }

  // ESP32 Image Header Magic (0xE9)
  if (bytes[0] !== 0xe9) {
    if (bytes[0] === 0x3c || bytes[0] === 0x7b) {
      throw new Error("Ungültige Firmware-Datei: Statt einer Binärdatei wurde Text/HTML geladen (evtl. 404-Fehler).");
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      throw new Error("Ungültige Firmware-Datei: ZIP-Archiv erkannt. Bitte entpacke zuerst die .bin-Datei.");
    }
    throw new Error(`Ungültige Firmware-Datei: Kein gültiger ESP32-Image-Header (Magic 0x${bytes[0].toString(16).padStart(2, "0")} statt 0xe9).`);
  }

  // ESP32-C6 Chip ID (uint16 LE an Offset 12 == 0x000D)
  const chipId = bytes[12] | (bytes[13] << 8);
  if (chipId !== 0x000d) {
    throw new Error(`Falsche Ziel-Hardware in Firmware-Datei (Chip-ID 0x${chipId.toString(16)}, erwartet ESP32-C6 / 0x000d).`);
  }

  // ESP_APP_DESC_MAGIC_WORD (uint32 LE an Offset 32 == 0xABCD5432) – unterscheidet App-Image (0x10000) von Bootloader/Merged-Image (0x0)
  const appDescMagic = (bytes[32] | (bytes[33] << 8) | (bytes[34] << 16) | (bytes[35] << 24)) >>> 0;
  if (appDescMagic !== 0xabcd5432) {
    throw new Error("Ungültiges App-Image: Dies scheint ein Bootloader- oder Komplett-Image (0x0) bzw. eine SPIFFS-Datei zu sein. Bitte verwende das App-Image (firmware.bin).");
  }

  // Falls SHA-256 angehängt ist (hash_appended == 1 an Offset 23), vor dem Upload kryptografisch prüfen
  if (bytes[23] === 0x01 && globalThis.crypto?.subtle) {
    const body = bytes.subarray(0, bytes.length - 32);
    const expectedHash = bytes.subarray(bytes.length - 32);
    const digestBuf = await globalThis.crypto.subtle.digest("SHA-256", body);
    const actualHash = new Uint8Array(digestBuf);
    for (let i = 0; i < 32; i++) {
      if (actualHash[i] !== expectedHash[i]) {
        throw new Error("Firmware-Datei ist beschädigt (SHA-256 Prüfsumme ungültig). Bitte lade die Datei erneut herunter.");
      }
    }
  }

  return true;
}

export class DeviceBleInterface {
  constructor() {
    this.WIFI_SERVICE_UUID = "0515c086-7b0c-11ed-a1eb-0242ac120002";
    this.WIFI_SSID_UUID = "090b0ef2-7b0d-11ed-a1eb-0242ac120002";
    this.WIFI_PASS_UUID = "a62eed84-7b0d-11ed-a1eb-0242ac120002";
    this.SETTINGS_SERVICE_UUID = "10000000-0000-0000-0000-000000000001";
    this.URL_UUID = "10000001-0000-0000-0000-000000000001";
    this.MODE_UUID = "10000002-0000-0000-0000-000000000001";
    this.UPLOAD_DATA_UUID = "10000003-0000-0000-0000-000000000001"; // WRITE_NR
    this.UPLOAD_CMD_UUID = "10000004-0000-0000-0000-000000000001"; // WRITE
    this.TIMEOUT_UUID = "10000005-0000-0000-0000-000000000001";
    this.HTTP_AUTH_USER_UUID = "10000007-0000-0000-0000-000000000001"; // READ/WRITE
    this.HTTP_AUTH_PASS_UUID = "10000008-0000-0000-0000-000000000001"; // WRITE only
    this.MOTION_WAKEUP_UUID = "10000009-0000-0000-0000-000000000001"; // READ/WRITE
    this.CHARGER_MODE_UUID = "1000000a-0000-0000-0000-000000000001"; // READ/WRITE
    this.SETTINGS_URL_UUID = "1000000b-0000-0000-0000-000000000001"; // READ/WRITE
    this.AUTO_ROTATION_UUID = "1000000c-0000-0000-0000-000000000001"; // READ/WRITE
    this.FIRMWARE_VERSION_UUID = "1000000d-0000-0000-0000-000000000001"; // READ
    this.GALLERY_STATE_UUID = "1000000e-0000-0000-0000-000000000001"; // READ/NOTIFY
    this.READ_DATA_UUID = "1000000f-0000-0000-0000-000000000001"; // READ

    this.DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_INFO_UUID = "4c578d4d-7b0e-11ed-a1eb-0242ac120002";
    this.SYSTEM_INFO_UUID = "60000001-7b0e-11ed-a1eb-0242ac120002";

    this.bleDevice = null; // BluetoothDevice, or a UsbLinkDevice of the same shape
    this.transport = "ble"; // "ble" | "usb"
    this.settingsService = null;
    this.wifiService = null;
    this.deviceDataService = null;
    this.deviceFirmwareVersion = null;
    this.deviceFirmwareType = null;
    this.gallerySupported = false; // the firmware reports "gallery": 1
    this.isConnected = false;
    this.isPaperL = false;
    this._boundHandleDisconnect = () => this.handleDisconnect();

    this.reconnectInterval = null;
    this.manualDisconnect = false;
    this.otaRebooting = false;
    this.otaNextStep = "";
    this.resetRebooting = false;
    this.setupTimedOut = false;
    this.reconnectAttempts = 0;
    this.isScanningWifi = false;
    this.isWritingDirectSettings = false;

    // "disconnected" | "connecting" | "connected" | "reconnecting"
    this.connectionState = "disconnected";
    this._connecting = false;
    // Web Bluetooth allows only one GATT operation at a time: settings writes are queued.
    this._opChain = Promise.resolve();

    // Callbacks
    // onStatusChange(text, level) – level is "idle" | "busy" | "ok" | "warn" | "err"
    this.onStatusChange = () => {};
    this.onConnectionStateChange = () => {};
    this.onConnected = () => {};
    this.onDisconnected = () => {};
    this.onWifiStatusChange = () => {};
    this.onWifiInfoChange = () => {};
    this.onWifiScanResult = () => {};
    this.onSystemStatusChange = () => {};
    this.onSettingsLoaded = () => {};
    this.onUploadProgress = () => {};
    this.onFirmwareVersionCheck = () => {};
    this.onGalleryStateChange = () => {};
  }

  encodeText(text) {
    return new TextEncoder().encode(text);
  }

  calcCRC32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  detectIsPaperL() {
    const name = String(this.bleDevice?.name || "")
      .trim()
      .toLowerCase();
    return name.startsWith("epd13");
  }

  /** Web Bluetooth needs a supporting browser and a secure context (https or localhost). */
  static isSupported() {
    return typeof navigator !== "undefined" && "bluetooth" in navigator && Boolean(navigator.bluetooth);
  }

  /** The USB link needs Web Serial (Chrome, Edge or Opera on a PC). */
  static isUsbSupported() {
    return typeof navigator !== "undefined" && "serial" in navigator && Boolean(navigator.serial);
  }

  _setState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.onConnectionStateChange(state);
  }

  _clearReconnect() {
    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
    this.reconnectInterval = null;
  }

  /** Runs GATT work strictly one after another ("GATT operation already in progress" otherwise). */
  _enqueue(task) {
    const run = this._opChain.then(task, task);
    this._opChain = run.catch(() => {});
    return run;
  }

  /** usbPort: a serial port of Web Serial. With it the device is connected over USB instead of Bluetooth. */
  async connect({ usbPort = null } = {}) {
    if (!usbPort && !DeviceBleInterface.isSupported()) {
      this.onStatusChange("Dieser Browser unterstützt kein Web Bluetooth. Nutze Chrome, Edge oder Opera.", "err");
      return;
    }
    try {
      this.manualDisconnect = false;
      this.otaRebooting = false;
      this.resetRebooting = false;
      this.setupTimedOut = false;
      this.reconnectAttempts = 0;
      this._clearReconnect();
      if (this.bleDevice) {
        this.bleDevice.removeEventListener("gattserverdisconnected", this._boundHandleDisconnect);
        if (this.bleDevice.gatt?.connected) {
          this.bleDevice.gatt.disconnect();
        }
        if (this.isConnected) {
          // The listener is already removed, so reset the state by hand.
          this.isConnected = false;
          this.settingsService = null;
          this.wifiService = null;
          this.deviceDataService = null;
          this.onDisconnected();
        }
        await this.bleDevice.gatt?.closed?.(); // USB: the serial port is free again
      }
      this._setState("connecting");
      this.transport = usbPort ? "usb" : "ble";
      if (usbPort) {
        this.bleDevice = new UsbLinkDevice(usbPort);
      } else {
        this.onStatusChange("Fordere Bluetooth-Kopplung an...", "busy");
        this.bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "epd" }],
          optionalServices: [this.SETTINGS_SERVICE_UUID, this.WIFI_SERVICE_UUID, this.DEVICE_DATA_SERVICE_UUID],
        });
      }

      this.isPaperL = this.detectIsPaperL();
      this.bleDevice.addEventListener("gattserverdisconnected", this._boundHandleDisconnect);

      await this.connectToGatt(usbPort ? undefined : this.isPaperL);
    } catch (error) {
      console.error(error);
      this._setState("disconnected");
      if (error?.name === "NotFoundError") {
        // The user closed the device chooser.
        this.onStatusChange("Geräteauswahl abgebrochen.", "warn");
      } else if (error?.name === "SecurityError") {
        this.onStatusChange("Bluetooth ist nur über HTTPS (oder localhost) verfügbar.", "err");
      } else {
        this.onStatusChange("Kopplung fehlgeschlagen: " + (error?.message || error), "err");
      }
    }
  }

  async connectToGatt(isPaperL) {
    if (!this.bleDevice || this._connecting) return;
    if (this.bleDevice.gatt.connected && this.isConnected) return;

    const usb = this.transport === "usb";
    const resolvedIsPaperL = typeof isPaperL === "boolean" ? isPaperL : this.detectIsPaperL();
    this.isPaperL = resolvedIsPaperL;
    this._connecting = true;

    try {
      this._setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
      const attempt = this.reconnectAttempts > 0 ? `(Versuch ${this.reconnectAttempts})` : "";
      this.onStatusChange(usb ? `Verbinde per USB... Schläft das E-Paper, drücke einmal die Reset-Taste. ${attempt}` : `Verbinde zu GATT Server... ${attempt}`, "busy");
      const server = await this.bleDevice.gatt.connect();
      if (this.manualDisconnect) throw new Error("Verbindungsaufbau abgebrochen");
      if (usb) this.isPaperL = this.detectIsPaperL(); // the name is known since the device answered
      this.reconnectAttempts = 0;

      this.onStatusChange("Lade Services...", "busy");
      this.deviceFirmwareVersion = null;
      this.deviceFirmwareType = null;
      this.gallerySupported = false;
      this.settingsService = await server.getPrimaryService(this.SETTINGS_SERVICE_UUID);
      this.wifiService = await server.getPrimaryService(this.WIFI_SERVICE_UUID);
      this.deviceDataService = await server.getPrimaryService(this.DEVICE_DATA_SERVICE_UUID);

      await this.readAllSettings();
      await this.setupWifiListeners();
      await this.setupSystemListeners();
      await this.setupGalleryListeners();

      if (!this.deviceFirmwareVersion) {
        try {
          const fwVerChar = await this.settingsService.getCharacteristic(this.FIRMWARE_VERSION_UUID);
          const fwVerStr = new TextDecoder()
            .decode(await fwVerChar.readValue())
            .replace(/\0/g, "")
            .trim();
          if (fwVerStr) {
            this.deviceFirmwareVersion = fwVerStr;
            this.deviceFirmwareType = "offline";
          }
        } catch (e) {
          // Ältere Firmware ohne 1000000d Characteristic
        }
      }

      this.isConnected = true;
      this._setState("connected");
      this.onFirmwareVersionCheck({
        version: this.deviceFirmwareVersion,
        fw: this.deviceFirmwareType,
        isPaperL: Boolean(this.isPaperL),
      });
      this.onStatusChange("Erfolgreich Verbunden!", "ok");
      this.onConnected(this.isPaperL);
    } catch (error) {
      console.error(error);
      this.isConnected = false;
      this.settingsService = null;
      this.wifiService = null;
      this.deviceDataService = null;
      // A half-open link (GATT connected, service discovery failed) would make every retry return
      // early and hang forever. handleDisconnect() ignores this event because isConnected is false.
      try {
        if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
      } catch (e) {
        console.warn("Could not close half-open GATT link", e);
      }
      if (!this.manualDisconnect) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= 12) {
          this._setState("reconnecting");
          this.onStatusChange(
            usb
              ? `${error?.message || "Keine Antwort über USB."} Neuer Versuch in 5s... (${this.reconnectAttempts}/12)`
              : `Verbindungsfehler. Reconnect in 5s... (${this.reconnectAttempts}/12)`,
            "warn",
          );
          this._clearReconnect();
          this.reconnectInterval = setTimeout(() => {
            this.connectToGatt(this.isPaperL);
          }, 5000);
        } else {
          this._setState("disconnected");
          this.onStatusChange("Verbindung endgültig verloren.", "err");
          this.onDisconnected();
        }
      } else {
        this._setState("disconnected");
        this.onStatusChange("Verbindung abgebrochen oder getrennt.", "warn");
        this.onDisconnected();
      }
    } finally {
      this._connecting = false;
    }
  }

  handleDisconnect() {
    // Drops during connection setup are handled by the retry logic in connectToGatt().
    if (!this.isConnected) return;

    this.isConnected = false;
    this.settingsService = null;
    this.wifiService = null;
    this.deviceDataService = null;
    this.isScanningWifi = false;

    this._clearReconnect();

    if (!this.manualDisconnect) {
      this.reconnectAttempts = 1;
      this._setState("reconnecting");
      this.onStatusChange(`Verbindung unterbrochen. Reconnect in 5s... (${this.reconnectAttempts}/12)`, "warn");
      this.reconnectInterval = setTimeout(() => {
        this.connectToGatt(this.isPaperL);
      }, 5000);
    } else if (this.otaRebooting) {
      this.otaRebooting = false;
      this._setState("disconnected");
      this.onStatusChange(`Firmware erfolgreich installiert! Das Gerät startet neu. ${this.otaNextStep}`.trim(), "ok");
    } else if (this.resetRebooting) {
      this.resetRebooting = false;
      this._setState("disconnected");
      this.onStatusChange("Gerät wurde zurückgesetzt und startet neu.", "ok");
    } else if (this.setupTimedOut) {
      this.setupTimedOut = false;
      this._setState("disconnected");
      this.onStatusChange("Das E-Paper hat die Verbindung nach 10 Minuten ohne Eingabe beendet, um die Batterien zu schonen. Zum Weitermachen die Reset-Taste drücken und neu verbinden.", "warn");
    } else {
      this._setState("disconnected");
      this.onStatusChange("Gerät getrennt.", "warn");
    }

    // UI disconnect aufrufen
    this.onDisconnected();
  }

  /** Disconnects, or cancels a pending connection / reconnect attempt. */
  async disconnect() {
    this.manualDisconnect = true;
    this._clearReconnect();

    if (this.bleDevice && this.bleDevice.gatt.connected) {
      this.onStatusChange("Trenne Verbindung...", "busy");

      if (this.settingsService) {
        try {
          const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
          await cmdChar.writeValue(this.encodeText("EXIT_SETUP"));
        } catch (e) {
          console.warn("Could not send EXIT_SETUP", e);
        }
      }

      // Fires "gattserverdisconnected" -> handleDisconnect() (or the catch in connectToGatt()).
      this.bleDevice.gatt.disconnect();
    } else if (this._connecting) {
      // Aborts the pending gatt.connect(); connectToGatt() then reports the cancelled attempt.
      try {
        this.bleDevice?.gatt?.disconnect();
      } catch (e) {
        console.warn("Could not abort pending connection", e);
      }
    } else if (this.connectionState !== "disconnected") {
      // Waiting for the next reconnect attempt: nothing is connected, just stop trying.
      this._setState("disconnected");
      this.onStatusChange("Verbindungsversuch abgebrochen.", "warn");
      this.onDisconnected();
    }
  }

  /** Ends a USB session but leaves the device in setup mode: the serial port is free for the flasher. */
  async releaseUsb() {
    if (this.transport !== "usb" || !this.bleDevice) return;
    this.manualDisconnect = true;
    this._clearReconnect();
    if (this.bleDevice.gatt.connected || this._connecting) {
      this.bleDevice.gatt.disconnect();
    } else if (this.connectionState !== "disconnected") {
      this._setState("disconnected");
      this.onDisconnected();
    }
    await this.bleDevice.gatt.closed();
  }

  async readAllSettings() {
    this.onStatusChange("Lese Geräteeinstellungen...", "busy");
    const settings = {};

    try {
      const urlChar = await this.settingsService.getCharacteristic(this.URL_UUID);
      const urlVal = await urlChar.readValue();
      settings.url = new TextDecoder().decode(urlVal).replace(/\0/g, "");

      const timeoutChar = await this.settingsService.getCharacteristic(this.TIMEOUT_UUID);
      const timeoutVal = await timeoutChar.readValue();
      settings.timeout = new TextDecoder().decode(timeoutVal).replace(/\0/g, "");

      const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
      const mode = parseInt(new TextDecoder().decode(await modeChar.readValue()), 10);
      if (Number.isFinite(mode)) settings.imageMode = mode; // 0 = gallery, 1 = download URL

      try {
        const httpAuthUserChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_USER_UUID);
        settings.httpAuthUser = new TextDecoder().decode(await httpAuthUserChar.readValue()).replace(/\0/g, "");

        // The password is write-only on the device and is never read back.

        const motionWakeupChar = await this.settingsService.getCharacteristic(this.MOTION_WAKEUP_UUID);
        const motionWakeupVal = new TextDecoder().decode(await motionWakeupChar.readValue());
        settings.motionWakeup = motionWakeupVal === "1" || motionWakeupVal === "true";

        const chargerModeChar = await this.settingsService.getCharacteristic(this.CHARGER_MODE_UUID);
        const chargerModeVal = new TextDecoder().decode(await chargerModeChar.readValue());
        settings.chargerMode = chargerModeVal === "1" || chargerModeVal === "true";

        try {
          const autoRotationChar = await this.settingsService.getCharacteristic(this.AUTO_ROTATION_UUID);
          const autoRotationVal = new TextDecoder().decode(await autoRotationChar.readValue());
          settings.autoRotation = autoRotationVal === "1" || autoRotationVal === "true";
        } catch (e) {
          console.warn("Auto Rotation not supported by this firmware", e);
        }

        const settingsUrlChar = await this.settingsService.getCharacteristic(this.SETTINGS_URL_UUID);
        settings.settingsUrl = new TextDecoder().decode(await settingsUrlChar.readValue()).replace(/\0/g, "");
      } catch (e) {}

      try {
        const ssidChar = await this.wifiService.getCharacteristic(this.WIFI_SSID_UUID);
        const ssidStr = new TextDecoder().decode(await ssidChar.readValue()).replace(/\0/g, "");
        if (ssidStr !== "" && ssidStr !== "wifi-ssid") {
          settings.wifiSsid = ssidStr;
        }
      } catch (e) {
        console.warn("WLAN SSID konnte nicht geladen werden:", e);
      }

      this.onSettingsLoaded(settings);
    } catch (e) {
      console.warn("Sync failed:", e);
    }
  }

  async setupWifiListeners() {
    try {
      const connectedChar = await this.deviceDataService.getCharacteristic(this.WIFI_CONNECTED_UUID);
      connectedChar.addEventListener("characteristicvaluechanged", (e) => {
        const val = e.target.value.getUint8(0);
        this.onWifiStatusChange(val === 1 || val === 49);
      });
      await connectedChar.startNotifications();
      const isConVal = await connectedChar.readValue();
      const isConNum = isConVal.getUint8(0);
      this.onWifiStatusChange(isConNum === 1 || isConNum === 49);
    } catch (e) {
      console.error("Failed to setup connectedChar", e);
    }

    try {
      const infoChar = await this.deviceDataService.getCharacteristic(this.WIFI_INFO_UUID);
      infoChar.addEventListener("characteristicvaluechanged", (e) => {
        const jsonStr = new TextDecoder().decode(e.target.value).replace(/\0/g, "");
        if (jsonStr.length > 2) {
          try {
            this.onWifiInfoChange(JSON.parse(jsonStr));
          } catch (ex) {}
        }
      });
      await infoChar.startNotifications();
      const infoVal = await infoChar.readValue();
      const infoJsonStr = new TextDecoder().decode(infoVal).replace(/\0/g, "");
      if (infoJsonStr.length > 2) {
        try {
          this.onWifiInfoChange(JSON.parse(infoJsonStr));
        } catch (ex) {}
      }
    } catch (e) {
      console.error("Failed to setup infoChar", e);
    }

    try {
      const scanChar = await this.deviceDataService.getCharacteristic(this.WIFI_SCAN_UUID);
      const processScanData = (data) => {
        const scanText = new TextDecoder().decode(data);
        if (scanText && scanText.length > 0) {
          const networks = [];
          scanText.split("´´").forEach((net) => {
            if (!net) return;
            const parts = net.split("´");
            if (parts.length >= 1 && parts[0] && !parts[0].includes("...")) {
              networks.push({ ssid: parts[0], rssi: parts[1] });
            }
          });
          if (networks.length > 0) {
            this.onWifiScanResult(networks);
          }
        }
      };
      await scanChar.startNotifications();
      // A notification carries at most MTU - 3 bytes (182 on macOS), a long list arrives cut off.
      // So the notification only says that the list is ready, the list itself is read.
      let readingScan = true; // readValue() fires this event as well
      scanChar.addEventListener("characteristicvaluechanged", (event) => {
        if (readingScan) return;
        readingScan = true;
        const notified = event.target.value;
        this._enqueue(() => scanChar.readValue())
          .then(processScanData, () => processScanData(notified))
          .finally(() => {
            readingScan = false;
          });
      });
      const initialScanData = await scanChar.readValue();
      readingScan = false;
      if (initialScanData.byteLength > 0) {
        processScanData(initialScanData);
      }
    } catch (e) {
      console.warn("WLAN Liste konnte nicht geladen werden:", e);
    }
  }

  async setupSystemListeners() {
    try {
      const sysInfoChar = await this.deviceDataService.getCharacteristic(this.SYSTEM_INFO_UUID);
      const updateSysInfo = (data) => {
        const jsonStr = new TextDecoder().decode(data).replace(/\0/g, "");
        if (jsonStr.length > 2) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && parsed.setupTimeout === true) {
              // On battery power the device ends its setup mode when the client is idle for too
              // long. It is on its way to sleep: reconnecting would only fail.
              this.manualDisconnect = true;
              this.setupTimedOut = true;
              this._clearReconnect();
              if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
              return;
            }
            if (parsed && typeof parsed.version === "string" && parsed.version.trim()) {
              this.deviceFirmwareVersion = parsed.version.trim();
            }
            if (parsed && typeof parsed.fw === "string" && parsed.fw.trim()) {
              this.deviceFirmwareType = parsed.fw.trim();
            }
            if (parsed && "gallery" in parsed) this.gallerySupported = parsed.gallery === 1 || parsed.gallery === true;
            if (parsed && (parsed.display === "13" || parsed.display === 13 || parsed.display === "epd13")) {
              this.isPaperL = true;
            } else if (parsed && (parsed.display === "7" || parsed.display === 7 || parsed.display === "epd7")) {
              this.isPaperL = false;
            }
            this.onSystemStatusChange(parsed);
          } catch (err) {}
        }
      };

      sysInfoChar.addEventListener("characteristicvaluechanged", (e) => updateSysInfo(e.target.value));
      await sysInfoChar.startNotifications();

      const sysInfoData = await sysInfoChar.readValue();
      updateSysInfo(sysInfoData);
    } catch (e) {
      console.error("Failed to setup system info", e);
    }
  }

  /** Resolves to true when a scan was started (results arrive via onWifiScanResult). */
  scanWifi() {
    return this._enqueue(() => this._scanWifi());
  }

  async _scanWifi() {
    if (!this.settingsService || this.isScanningWifi) return false;
    try {
      this.isScanningWifi = true;
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      await cmdChar.writeValue(this.encodeText("SCAN_WIFI"));
      setTimeout(() => {
        this.isScanningWifi = false;
      }, 5000);
      return true;
    } catch (e) {
      console.error("Failed to trigger WLAN Scan:", e);
      this.isScanningWifi = false;
      throw e;
    }
  }

  saveWifi(ssid, password) {
    return this._enqueue(() => this._saveWifi(ssid, password));
  }

  async _saveWifi(ssid, password) {
    if (!this.wifiService) return false;

    try {
      this.onStatusChange("Speichere WLAN...", "busy");
      const ssidChar = await this.wifiService.getCharacteristic(this.WIFI_SSID_UUID);
      await ssidChar.writeValue(this.encodeText(ssid));

      const passChar = await this.wifiService.getCharacteristic(this.WIFI_PASS_UUID);
      await passChar.writeValue(this.encodeText(password));

      this.onStatusChange("Prüfe WLAN-Verbindung...", "busy");

      const connectedChar = await this.deviceDataService.getCharacteristic(this.WIFI_CONNECTED_UUID);
      await new Promise((r) => setTimeout(r, 2000));

      let isConnected = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const data = await connectedChar.readValue();
          const val = data.getUint8(0);
          if (val === 1 || val === 49) {
            isConnected = true;
            break;
          }
        } catch (err) {
          console.warn("Konnten Status nicht lesen:", err);
        }
      }

      if (isConnected) {
        this.onWifiStatusChange(true);
        this.onStatusChange("WLAN gespeichert & Erfolgreich Verbunden! ✅", "ok");
        return true;
      } else {
        this.onWifiStatusChange(false);
        // The device stores the credentials only after a successful connection test.
        this.onStatusChange("WLAN-Verbindung fehlgeschlagen – Zugangsdaten wurden nicht gespeichert (Passwort falsch?)", "err");
        return false;
      }
    } catch (e) {
      console.error(e);
      this.onStatusChange("Fehler beim Speichern des WLANs.", "err");
      return false;
    }
  }

  saveSettings(settings) {
    return this._enqueue(() => this._saveSettings(settings));
  }

  async _saveSettings(settings) {
    if (!this.settingsService) return false;
    try {
      this.onStatusChange("Speichere Einstellungen...", "busy");
      const encoder = new TextEncoder();

      const urlChar = await this.settingsService.getCharacteristic(this.URL_UUID);
      await urlChar.writeValue(encoder.encode(settings.url || ""));

      const timeoutChar = await this.settingsService.getCharacteristic(this.TIMEOUT_UUID);
      await timeoutChar.writeValue(encoder.encode(settings.timeout || "3600"));

      try {
        const httpAuthUserChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_USER_UUID);
        await httpAuthUserChar.writeValue(encoder.encode(settings.httpAuthUser || ""));

        // undefined = keep the password stored on the device
        if (settings.httpAuthPassword !== undefined) {
          const httpAuthPasswordChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_PASS_UUID);
          await httpAuthPasswordChar.writeValue(encoder.encode(settings.httpAuthPassword));
        }

        const motionWakeupChar = await this.settingsService.getCharacteristic(this.MOTION_WAKEUP_UUID);
        await motionWakeupChar.writeValue(encoder.encode(settings.motionWakeup ? "1" : "0"));

        const chargerModeChar = await this.settingsService.getCharacteristic(this.CHARGER_MODE_UUID);
        await chargerModeChar.writeValue(encoder.encode(settings.chargerMode ? "1" : "0"));

        const autoRotationChar = await this.settingsService.getCharacteristic(this.AUTO_ROTATION_UUID);
        await autoRotationChar.writeValue(encoder.encode(settings.autoRotation ? "1" : "0"));

        const settingsUrlChar = await this.settingsService.getCharacteristic(this.SETTINGS_URL_UUID);
        await settingsUrlChar.writeValue(encoder.encode(settings.settingsUrl || ""));
      } catch (e) {
        console.warn("Alte Firmware: Erweiterte Settings werden ignoriert", e);
      }

      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      await cmdChar.writeValue(encoder.encode("SAVE_SETTINGS"));

      this.onStatusChange("Einstellungen gespeichert!", "ok");
      return true;
    } catch (error) {
      console.error(error);
      this.onStatusChange("Fehler beim Speichern der Einstellungen", "err");
      return false;
    }
  }

  /** Writes a single switch and persists it. Resolves to true when the device accepted it. */
  directSaveSetting(type, value) {
    return this._enqueue(() => this._directSaveSetting(type, value));
  }

  async _directSaveSetting(type, value) {
    if (!this.settingsService) return false;
    try {
      this.isWritingDirectSettings = true;
      let charUUID = null;
      if (type === "motionWakeup") charUUID = this.MOTION_WAKEUP_UUID;
      if (type === "chargerMode") charUUID = this.CHARGER_MODE_UUID;
      if (type === "autoRotation") charUUID = this.AUTO_ROTATION_UUID;

      if (charUUID) {
        const char = await this.settingsService.getCharacteristic(charUUID);
        await char.writeValue(this.encodeText(value ? "1" : "0"));

        const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
        await cmdChar.writeValue(this.encodeText("SAVE_SETTINGS"));
        return true;
      }
      return false;
    } catch (err) {
      console.error(`Failed to update ${type} directly`, err);
      return false;
    } finally {
      this.isWritingDirectSettings = false;
    }
  }

  factoryReset() {
    return this._enqueue(() => this._factoryReset());
  }

  async _factoryReset() {
    if (!this.settingsService) return;
    try {
      this.onStatusChange("Führe Factory Reset aus...", "busy");
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      // The device restarts after the reset and is then no longer in setup mode: the dropped
      // link is expected and reconnecting would only fail twelve times.
      this.manualDisconnect = true;
      this.resetRebooting = true;
      this._clearReconnect();
      try {
        await cmdChar.writeValue(this.encodeText("RESET"));
      } catch (writeErr) {
        // Firmware before the deferred restart resets inside the write: the answer never
        // arrives, the link drops instead. Only a failed write on a live link is an error.
        if (this.bleDevice?.gatt?.connected) throw writeErr;
        console.warn("RESET was not answered, the device restarted:", writeErr);
      }
      if (this.resetRebooting) {
        // still connected (otherwise handleDisconnect() has already reported the restart)
        this.onStatusChange("Gerät wird zurückgesetzt und neugestartet.", "ok");
      }

      setTimeout(() => {
        if (this.bleDevice && this.bleDevice.gatt.connected) {
          this.bleDevice.gatt.disconnect();
        }
      }, 1500);
    } catch (e) {
      console.error(e);
      this.manualDisconnect = false;
      this.resetRebooting = false;
      this.onStatusChange("Fehler beim Factory Reset.", "err");
    }
  }

  // --- gallery -------------------------------------------------------------

  _parseJson(view) {
    try {
      const text = new TextDecoder().decode(view).replace(/\0/g, "");
      return text.length > 1 ? JSON.parse(text) : null;
    } catch (e) {
      return null;
    }
  }

  async setupGalleryListeners() {
    if (!this.gallerySupported) return;
    try {
      const stateChar = await this.settingsService.getCharacteristic(this.GALLERY_STATE_UUID);
      const report = (data) => {
        const parsed = this._parseJson(data);
        if (parsed) this.onGalleryStateChange(parsed);
        return Boolean(parsed);
      };
      await stateChar.startNotifications();
      let reading = true; // readValue() fires this event as well
      stateChar.addEventListener("characteristicvaluechanged", (event) => {
        if (reading || report(event.target.value)) return;
        // cut off by a small MTU: read the whole value
        reading = true;
        this._enqueue(() => stateChar.readValue())
          .then(report, () => {})
          .finally(() => {
            reading = false;
          });
      });
      report(await stateChar.readValue());
      reading = false;
    } catch (e) {
      console.warn("Gallery state could not be read:", e);
    }
  }

  _requireGallery() {
    if (!this.settingsService) throw new Error("Keine Verbindung zum E-Paper.");
    if (!this.gallerySupported) throw new Error("Die Firmware des E-Paper kennt die Galerie noch nicht. Bitte zuerst die Firmware aktualisieren.");
  }

  /** Writes a command and reads its status. */
  async _command(cmdChar, text) {
    await cmdChar.writeValue(this.encodeText(text));
    const view = await cmdChar.readValue();
    return {
      pos: view.getUint16(0, true),
      value: view.byteLength >= 6 ? view.getUint32(2, true) : 0,
      maxPayload: view.byteLength >= 8 ? view.getUint16(6, true) : 0,
    };
  }

  /**
   * A gallery command. While the display is refreshed the device answers "busy": the command is
   * repeated until it is taken. quiet: give up at once instead, with the error code "BUSY".
   */
  async _galleryCommand(cmdChar, text, { quiet = false } = {}) {
    for (let waited = 0; ; waited += 2) {
      const status = await this._command(cmdChar, text);
      if (status.pos !== STATUS_DISPLAY_BUSY) return status;
      if (quiet) throw codedError("BUSY", "Das E-Paper aktualisiert gerade das Display.");
      if (waited >= DISPLAY_BUSY_WAIT_S) {
        throw new Error("Das E-Paper aktualisiert noch das Display. Bitte in einer Minute erneut versuchen.");
      }
      this.onStatusChange("Das E-Paper aktualisiert noch das Display – danach geht es weiter…", "busy");
      await sleep(2000);
    }
  }

  /** One gallery command without data. */
  _gallerySimple(text, failMessage) {
    return this._enqueue(async () => {
      this._requireGallery();
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      const status = await this._galleryCommand(cmdChar, text);
      if (status.pos >= STATUS_NO_SPACE) throw new Error(failMessage);
      return status;
    });
  }

  galleryDelete(id) {
    return this._gallerySimple(`GAL_DEL:${id}`, "Das Bild konnte auf dem E-Paper nicht gelöscht werden.");
  }

  gallerySet(shuffle, auto) {
    return this._gallerySimple(`GAL_SET:${shuffle ? 1 : 0},${auto ? 1 : 0}`, "Die Wiedergabe-Einstellungen konnten nicht gespeichert werden.");
  }

  galleryClear() {
    return this._gallerySimple("GAL_CLEAR", "Die Galerie auf dem E-Paper konnte nicht gelöscht werden.");
  }

  galleryShow(id) {
    return this._gallerySimple(`GAL_SHOW:${id}`, "Das E-Paper kennt dieses Bild nicht.");
  }

  readGalleryState() {
    return this._enqueue(async () => {
      this._requireGallery();
      const stateChar = await this.settingsService.getCharacteristic(this.GALLERY_STATE_UUID);
      return this._parseJson(await stateChar.readValue());
    });
  }

  /**
   * Reads a stream of the device ("list", "thumb:<id>", "pic:<id>"). A long stream is read in
   * slices, so that other GATT work is not held up; every slice resumes at its offset.
   */
  async readStream(what, { onProgress = null, quiet = false } = {}) {
    const parts = [];
    let received = 0;
    let total = null;
    while (total === null || received < total) {
      await this._enqueue(async () => {
        this._requireGallery();
        const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
        const dataChar = await this.settingsService.getCharacteristic(this.READ_DATA_UUID);
        const status = await this._galleryCommand(cmdChar, received ? `READ:${what},${received}` : `READ:${what}`, { quiet });
        if (status.pos >= STATUS_NO_SPACE) throw new Error("Das E-Paper kann diese Daten nicht liefern.");
        total = status.value;
        for (let i = 0; i < READ_SLICE_CHUNKS && received < total; i++) {
          const view = await dataChar.readValue();
          if (view.byteLength === 0) throw new Error("Das E-Paper hat die Übertragung vorzeitig beendet.");
          parts.push(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
          received += view.byteLength;
        }
      });
      if (onProgress && total) onProgress(Math.min(received, total), total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return total < received ? bytes.subarray(0, total) : bytes;
  }

  /** Pictures on the device in play order: [{ id, size, thumbLen }] */
  async readGalleryList(options) {
    const bytes = await this.readStream("list", options);
    let parsed = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error("Die Bilderliste des E-Paper ist ungültig.");
    }
    return (parsed?.items || []).map(([id, size, thumbLen]) => ({ id: String(id).toLowerCase(), size: Number(size) || 0, thumbLen: Number(thumbLen) || 0 }));
  }

  readGalleryThumb(id, options) {
    return this.readStream(`thumb:${id}`, options);
  }

  readGalleryPicture(id, onProgress) {
    return this.readStream(`pic:${id}`, { onProgress });
  }

  /** onProgress(fraction 0..1). Rejects with the code "NO_SPACE" if the picture does not fit. */
  galleryPut(id, container, { onProgress = null, label = "Sende Bild" } = {}) {
    return this._enqueue(() => this._upload(container, { start: `GAL_PUT:${id},${container.length}`, onProgress, label }));
  }

  /** ids: the play order. */
  galleryOrder(ids) {
    const bytes = new Uint8Array(ids.length * 4);
    const view = new DataView(bytes.buffer);
    ids.forEach((id, index) => view.setUint32(index * 4, parseInt(id, 16) >>> 0, true));
    return this._enqueue(() => this._upload(bytes, { start: `GAL_ORDER:${ids.length}`, label: "Übertrage die Reihenfolge" }));
  }

  /** Stores the update interval alone (the other settings keep the values of the device). */
  saveTimeout(seconds) {
    return this._enqueue(async () => {
      if (!this.settingsService) throw new Error("Keine Verbindung zum E-Paper.");
      const timeoutChar = await this.settingsService.getCharacteristic(this.TIMEOUT_UUID);
      await timeoutChar.writeValue(this.encodeText(String(seconds)));
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      await cmdChar.writeValue(this.encodeText("SAVE_SETTINGS"));
    });
  }

  /** 0 = gallery, 1 = URL download, null if unknown. */
  readImageMode() {
    return this._enqueue(async () => {
      if (!this.settingsService) return null;
      try {
        const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
        const mode = parseInt(new TextDecoder().decode(await modeChar.readValue()), 10);
        return Number.isFinite(mode) ? mode : null;
      } catch (e) {
        return null;
      }
    });
  }

  // --- upload (firmware, gallery) ------------------------------------------

  /**
   * Sends data in windows that the device confirms one by one.
   * start: the command that opens a gallery upload (GAL_PUT, GAL_ORDER). Without it the data is
   * a firmware; only that one still knows the first protocol of old builds (2 byte status).
   */
  async _upload(buffer, { start = null, onProgress = null, label = "Sende Daten" } = {}) {
    if (!this.settingsService) {
      // Silently returning here looked like a successful upload to the caller.
      throw new Error("Keine Verbindung zum E-Paper.");
    }
    const isFirmware = !start;
    const progress = (percent) => {
      if (isFirmware) this.onUploadProgress("firmware", percent);
      else if (onProgress) onProgress(percent / 100);
    };

    try {
      progress(0);
      const dataBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

      if (isFirmware) {
        this.onStatusChange("Prüfe Firmware-Datei...", "busy");
        await validateEsp32FirmwareBinary(dataBytes);
      } else {
        this._requireGallery();
      }

      const dataChar = await this.settingsService.getCharacteristic(this.UPLOAD_DATA_UUID);
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);

      let useV2 = true;
      let negotiatedPayload = 0;
      let windowSize = 0; // bytes the device takes before a FLUSH, 0 = the usual 32 KB
      if (isFirmware) {
        this.onStatusChange("Starte Firmware Update...", "busy");
        await cmdChar.writeValue(this.encodeText("START_FW"));
        const initView = await cmdChar.readValue();
        if (initView.getUint16(0, true) === STATUS_UPLOAD_ERROR) {
          throw new Error("OTA-Partition auf dem Gerät konnte nicht geöffnet werden (Flash/RAM Fehler).");
        }
        useV2 = initView.byteLength >= 8;
        if (useV2) negotiatedPayload = initView.getUint16(6, true);
      } else {
        const status = await this._galleryCommand(cmdChar, start);
        if (status.pos === STATUS_NO_SPACE) throw codedError("NO_SPACE", "Auf dem E-Paper ist nicht genug Speicher frei.");
        if (status.pos >= STATUS_SEQ_ERROR) throw new Error("Das E-Paper hat die Übertragung abgelehnt.");
        negotiatedPayload = status.maxPayload;
        windowSize = status.value;
      }

      let chunkSize = 238;
      let checkpointSize = 19040;
      let burstSize = 1;
      let burstDelayMs = 6;

      if (useV2) {
        await cmdChar.writeValue(this.encodeText("V2"));
        if (isFirmware) {
          await cmdChar.writeValue(this.encodeText(`FW_SIZE:${dataBytes.length}`));
          const sizeView = await cmdChar.readValue();
          if (sizeView.getUint16(0, true) === STATUS_UPLOAD_ERROR) {
            throw new Error(`Firmware-Größe (${(dataBytes.length / 1024).toFixed(1)} KB) passt nicht in die OTA-Partition des Geräts.`);
          }
        }
        chunkSize = negotiatedPayload >= 20 && negotiatedPayload <= 508 ? negotiatedPayload : 240;
        // 128 * 256B: exakte SPI-NOR-Flash-Page-Ausrichtung. With little free memory the device asks for less.
        checkpointSize = windowSize >= 1024 && windowSize <= 32768 ? windowSize : 32768;
        burstSize = 6;
        burstDelayMs = 1;
      }

      const totalCrc = this.calcCRC32(dataBytes);
      const totalCrcHex = hexId(totalCrc);
      let offset = 0;
      let retryCount = 0;

      while (offset < dataBytes.length) {
        const windowEnd = Math.min(offset + checkpointSize, dataBytes.length);
        const bytesToSend = windowEnd - offset;
        let seq = 0;
        let sendErrorOccurred = false;

        try {
          for (let currentOffset = offset; currentOffset < windowEnd; currentOffset += chunkSize) {
            const endChunk = Math.min(currentOffset + chunkSize, windowEnd);
            const chunkData = dataBytes.subarray(currentOffset, endChunk);
            let packet;

            if (useV2) {
              packet = new Uint8Array(chunkData.length + 1);
              packet[0] = seq & 0xff;
              packet.set(chunkData, 1);
            } else {
              packet = new Uint8Array(chunkData.length + 4);
              const crc = this.calcCRC32(chunkData);
              packet[0] = crc & 0xff;
              packet[1] = (crc >> 8) & 0xff;
              packet[2] = (crc >> 16) & 0xff;
              packet[3] = (crc >>> 24) & 0xff;
              packet.set(chunkData, 4);
            }

            seq++;
            const isLastInWindow = endChunk >= windowEnd;

            if (isLastInWindow) {
              if (dataChar.writeValueWithResponse) {
                await dataChar.writeValueWithResponse(packet);
              } else {
                await dataChar.writeValue(packet);
              }
            } else {
              await dataChar.writeValueWithoutResponse(packet);
              if (seq % burstSize === 0 && burstDelayMs > 0) {
                await sleep(burstDelayMs);
              }
            }
          }
        } catch (sendErr) {
          if (!this.bleDevice || !this.bleDevice.gatt || !this.bleDevice.gatt.connected) {
            throw sendErr;
          }
          console.warn("BLE Sende-Warnung im Fenster, wiederhole Checkpoint:", sendErr);
          sendErrorOccurred = true;
          await sleep(40);
        }

        let isWindowValid = false;
        let ramBytes = 0;

        if (!sendErrorOccurred) {
          const statusView = await cmdChar.readValue();
          ramBytes = statusView.getUint16(0, true);

          if (useV2 && ramBytes === STATUS_UPLOAD_ERROR) {
            throw new Error(isFirmware ? "Schreibfehler in der internen OTA-Partition während des Firmware-Uploads." : "Schreibfehler im Speicher des E-Paper während des Uploads.");
          }

          if (useV2 && statusView.byteLength >= 6) {
            const remoteCrc = statusView.getUint32(2, true);
            const localCrc = this.calcCRC32(dataBytes.subarray(offset, windowEnd));
            isWindowValid = ramBytes === bytesToSend && remoteCrc === localCrc;
            if (!isWindowValid) {
              console.warn(`Checkpoint Mismatch! Erwartet: ${bytesToSend}B (CRC 0x${localCrc.toString(16)}), RAM hat: ${ramBytes}B (CRC 0x${remoteCrc.toString(16)})`);
            }
          } else {
            isWindowValid = ramBytes === bytesToSend;
          }
        }

        if (isWindowValid) {
          await cmdChar.writeValue(this.encodeText("FLUSH"));
          if (useV2 && (!isFirmware || offset === 0)) {
            const flushView = await cmdChar.readValue();
            if (flushView.getUint16(0, true) === STATUS_UPLOAD_ERROR) {
              throw new Error(isFirmware ? "Gerät hat den Firmware-Header beim Schreiben in die OTA-Partition abgelehnt." : "Schreibfehler im Speicher des E-Paper während des Uploads.");
            }
          }
          offset = windowEnd;
          retryCount = 0;
        } else {
          if (burstSize > 2) {
            burstSize = Math.max(1, Math.floor(burstSize / 2));
          } else {
            burstDelayMs = Math.min(12, burstDelayMs + 2);
          }
          await sleep(30);
          await cmdChar.writeValue(this.encodeText("CLEAR"));
          retryCount++;

          if (retryCount > 10) {
            throw new Error(`Upload fehlgeschlagen! Checkpoint bei ${offset} konnte nicht übertragen werden.`);
          }
          this.onStatusChange(`Paketverlust korrigiert – wiederhole Checkpoint... (Versuch ${retryCount})`, "warn");
        }

        const percent = Math.round((offset / dataBytes.length) * 100);
        progress(percent);
        if (isWindowValid) {
          // keep the "retrying checkpoint" warning visible instead of overwriting it right away
          this.onStatusChange(isFirmware ? `Sende Firmware... ${percent}%` : `${label}… ${percent}%`, "busy");
        }
      }

      progress(100);

      if (isFirmware) {
        this.onStatusChange("Verifiziere Firmware im Flash (CRC32 & SHA-256)...", "busy");
        const hasDeferredReboot = Boolean(this.deviceFirmwareVersion);

        try {
          await cmdChar.writeValue(this.encodeText(useV2 ? `END_FW:${totalCrcHex}` : "END_FW"));
          const statusView = await cmdChar.readValue();
          const statusVal = statusView.getUint16(0, true);
          const deviceCrc = statusView.byteLength >= 6 ? statusView.getUint32(2, true) : totalCrc;

          if (statusVal === STATUS_UPLOAD_ERROR || statusVal === STATUS_SEQ_ERROR || (useV2 && deviceCrc !== totalCrc)) {
            throw new Error("Firmware-Integritätsprüfung auf dem Gerät fehlgeschlagen (CRC32/SHA-256 Mismatch). Alte Firmware bleibt aktiv.");
          }
        } catch (e) {
          const isDisconnectErr = e?.message && (e.message.includes("GATT") || e.message.includes("disconnect") || e.message.includes("NetworkError"));
          // Nur ältere Firmwares (< 0.1.0 ohne Versionsmeldung) starten noch direkt im GATT-Callback neu
          if (hasDeferredReboot || !isDisconnectErr) {
            throw e;
          }
        }

        this.manualDisconnect = true;
        this.otaRebooting = true;
        if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
        this.onStatusChange(`Firmware erfolgreich verifiziert! Das Gerät startet neu. ${this.otaNextStep}`.trim(), "ok");

        setTimeout(() => {
          if (this.bleDevice && this.bleDevice.gatt.connected) {
            this.bleDevice.gatt.disconnect();
          }
        }, 800);
      } else {
        const status = await this._command(cmdChar, `END:${totalCrcHex}`);
        if (status.pos >= STATUS_NO_SPACE || status.value !== totalCrc) {
          throw new Error("Das E-Paper hat die Daten nicht übernommen (Prüfung nach der Übertragung fehlgeschlagen).");
        }
      }
    } catch (error) {
      if (error?.code === "NO_SPACE") throw error; // handled by the caller, not an error of the transfer
      console.error(error);
      this.onStatusChange(`Fehler beim ${isFirmware ? "Firmware " : ""}Upload: ` + error.message, "err");
      error.reported = true; // the status line already shows this error
      throw error;
    }
  }

  /** nextStep: what the user does after the restart, appended to the success message. */
  uploadFirmware(buffer, nextStep = "") {
    this.otaNextStep = nextStep;
    return this._enqueue(() => this._upload(buffer));
  }
}

export const MAX_OTA_FW_SIZE = 0x1d0000; // 1.900.544 Bytes (app0/app1 in part.csv)
export const MIN_OTA_FW_SIZE = 65536;

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

    this.DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_INFO_UUID = "4c578d4d-7b0e-11ed-a1eb-0242ac120002";
    this.SYSTEM_INFO_UUID = "60000001-7b0e-11ed-a1eb-0242ac120002";

    this.bleDevice = null;
    this.settingsService = null;
    this.wifiService = null;
    this.deviceDataService = null;
    this.deviceFirmwareVersion = null;
    this.deviceFirmwareType = null;
    this.isConnected = false;
    this.isPaperL = false;
    this._boundHandleDisconnect = () => this.handleDisconnect();

    this.reconnectInterval = null;
    this.manualDisconnect = false;
    this.otaRebooting = false;
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

  async connect() {
    if (!DeviceBleInterface.isSupported()) {
      this.onStatusChange("Dieser Browser unterstützt kein Web Bluetooth. Nutze Chrome, Edge oder Opera.", "err");
      return;
    }
    try {
      this.manualDisconnect = false;
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
      }
      this._setState("connecting");
      this.onStatusChange("Fordere Bluetooth-Kopplung an...", "busy");
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "epd" }],
        optionalServices: [this.SETTINGS_SERVICE_UUID, this.WIFI_SERVICE_UUID, this.DEVICE_DATA_SERVICE_UUID],
      });

      this.isPaperL = this.detectIsPaperL();
      this.bleDevice.addEventListener("gattserverdisconnected", this._boundHandleDisconnect);

      await this.connectToGatt(this.isPaperL);
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

    const resolvedIsPaperL = typeof isPaperL === "boolean" ? isPaperL : this.detectIsPaperL();
    this.isPaperL = resolvedIsPaperL;
    this._connecting = true;

    try {
      this._setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
      this.onStatusChange(`Verbinde zu GATT Server... ${this.reconnectAttempts > 0 ? `(Versuch ${this.reconnectAttempts})` : ""}`, "busy");
      const server = await this.bleDevice.gatt.connect();
      if (this.manualDisconnect) throw new Error("Verbindungsaufbau abgebrochen");
      this.reconnectAttempts = 0;

      this.onStatusChange("Lade Services...", "busy");
      this.deviceFirmwareVersion = null;
      this.deviceFirmwareType = null;
      this.settingsService = await server.getPrimaryService(this.SETTINGS_SERVICE_UUID);
      this.wifiService = await server.getPrimaryService(this.WIFI_SERVICE_UUID);
      this.deviceDataService = await server.getPrimaryService(this.DEVICE_DATA_SERVICE_UUID);

      await this.readAllSettings();
      await this.setupWifiListeners();
      await this.setupSystemListeners();

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
          this.onStatusChange(`Verbindungsfehler. Reconnect in 5s... (${this.reconnectAttempts}/12)`, "warn");
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
      this.onStatusChange("Firmware erfolgreich installiert! Gerät startet neu... 🚀", "ok");
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
      scanChar.addEventListener("characteristicvaluechanged", (event) => {
        processScanData(event.target.value);
      });
      const initialScanData = await scanChar.readValue();
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
            if (parsed && typeof parsed.version === "string" && parsed.version.trim()) {
              this.deviceFirmwareVersion = parsed.version.trim();
            }
            if (parsed && typeof parsed.fw === "string" && parsed.fw.trim()) {
              this.deviceFirmwareType = parsed.fw.trim();
            }
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
        try {
          const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
          await modeChar.writeValue(this.encodeText("1"));
        } catch (err) {}
        return true;
      } else {
        this.onWifiStatusChange(false);
        this.onStatusChange("WLAN gespeichert, aber Verbindung fehlgeschlagen (Passwort falsch?)", "err");
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
      await cmdChar.writeValue(this.encodeText("RESET"));
      this.onStatusChange("Gerät wird zurückgesetzt und neugestartet.", "ok");

      setTimeout(() => {
        if (this.bleDevice && this.bleDevice.gatt.connected) {
          this.bleDevice.gatt.disconnect();
        }
      }, 1500);
    } catch (e) {
      console.error(e);
      this.onStatusChange("Fehler beim Factory Reset.", "err");
    }
  }

  async uploadData(buffer, isFirmware = false) {
    if (!this.settingsService) {
      // Silently returning here looked like a successful upload to the caller.
      throw new Error("Keine Verbindung zum E-Paper.");
    }

    try {
      this.onUploadProgress(isFirmware ? "firmware" : "image", 0);
      const dataBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

      if (isFirmware) {
        this.onStatusChange("Prüfe Firmware-Datei...", "busy");
        await validateEsp32FirmwareBinary(dataBytes);
      } else {
        try {
          const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
          await modeChar.writeValue(this.encodeText("0"));
        } catch (err) {
          console.warn("Modus konnte nicht auf BLE gesetzt werden:", err);
        }
      }

      const dataChar = await this.settingsService.getCharacteristic(this.UPLOAD_DATA_UUID);
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);

      this.onStatusChange(isFirmware ? "Starte Firmware Update..." : "Öffne Flash Puffer...", "busy");
      await cmdChar.writeValue(this.encodeText(isFirmware ? "START_FW" : "START"));

      const initView = await cmdChar.readValue();
      const initStatus = initView.getUint16(0, true);
      if (initStatus === 0xffff) {
        throw new Error(isFirmware ? "OTA-Partition auf dem Gerät konnte nicht geöffnet werden (Flash/RAM Fehler)." : "Geräte-Puffer konnte nicht initialisiert werden (Flash/RAM Fehler).");
      }

      const useV2 = initView.byteLength >= 8;
      let chunkSize = 238;
      let checkpointSize = 19040;
      let burstSize = 1;
      let burstDelayMs = 6;

      if (useV2) {
        await cmdChar.writeValue(this.encodeText("V2"));
        if (isFirmware) {
          await cmdChar.writeValue(this.encodeText(`FW_SIZE:${dataBytes.length}`));
          const sizeView = await cmdChar.readValue();
          if (sizeView.getUint16(0, true) === 0xffff) {
            throw new Error(`Firmware-Größe (${(dataBytes.length / 1024).toFixed(1)} KB) passt nicht in die OTA-Partition des Geräts.`);
          }
        }
        const negotiatedPayload = initView.getUint16(6, true);
        chunkSize = negotiatedPayload >= 20 && negotiatedPayload <= 508 ? negotiatedPayload : 240;
        checkpointSize = 32768; // 128 * 256B: exakte SPI-NOR-Flash-Page-Ausrichtung
        burstSize = 6;
        burstDelayMs = 1;
      }

      const totalCrc = this.calcCRC32(dataBytes);
      const totalCrcHex = totalCrc.toString(16).padStart(8, "0");
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
                await new Promise((r) => setTimeout(r, burstDelayMs));
              }
            }
          }
        } catch (sendErr) {
          if (!this.bleDevice || !this.bleDevice.gatt || !this.bleDevice.gatt.connected) {
            throw sendErr;
          }
          console.warn("BLE Sende-Warnung im Fenster, wiederhole Checkpoint:", sendErr);
          sendErrorOccurred = true;
          await new Promise((r) => setTimeout(r, 40));
        }

        let isWindowValid = false;
        let ramBytes = 0;

        if (!sendErrorOccurred) {
          const statusView = await cmdChar.readValue();
          ramBytes = statusView.getUint16(0, true);

          if (useV2 && ramBytes === 0xffff) {
            throw new Error(isFirmware ? "Schreibfehler in der internen OTA-Partition während des Firmware-Uploads." : "Schreibfehler im externen Flash-Speicher während des Uploads.");
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
          if (isFirmware && useV2 && offset === 0) {
            const firstFlushView = await cmdChar.readValue();
            if (firstFlushView.getUint16(0, true) === 0xffff) {
              throw new Error("Gerät hat den Firmware-Header beim Schreiben in die OTA-Partition abgelehnt.");
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
          await new Promise((r) => setTimeout(r, 30));
          await cmdChar.writeValue(this.encodeText("CLEAR"));
          retryCount++;

          if (retryCount > 10) {
            throw new Error(`Upload fehlgeschlagen! Checkpoint bei ${offset} konnte nicht übertragen werden.`);
          }
          this.onStatusChange(`Paketverlust korrigiert – wiederhole Checkpoint... (Versuch ${retryCount})`, "warn");
        }

        let percent = Math.round((offset / dataBytes.length) * 100);
        this.onUploadProgress(isFirmware ? "firmware" : "image", percent);
        if (isWindowValid) {
          // keep the "retrying checkpoint" warning visible instead of overwriting it right away
          this.onStatusChange(`Sende ${isFirmware ? "Firmware" : "Daten"}... ${percent}%`, "busy");
        }
      }

      this.onUploadProgress(isFirmware ? "firmware" : "image", 100);

      if (isFirmware) {
        this.onStatusChange("Verifiziere Firmware im Flash (CRC32 & SHA-256)...", "busy");
        const hasDeferredReboot = Boolean(this.deviceFirmwareVersion);

        try {
          await cmdChar.writeValue(this.encodeText(useV2 ? `END_FW:${totalCrcHex}` : "END_FW"));
          const statusView = await cmdChar.readValue();
          const statusVal = statusView.getUint16(0, true);
          const deviceCrc = statusView.byteLength >= 6 ? statusView.getUint32(2, true) : totalCrc;

          if (statusVal === 0xffff || statusVal === 0xfffe || (useV2 && deviceCrc !== totalCrc)) {
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
        this.onStatusChange("Firmware erfolgreich verifiziert! Gerät startet neu... 🚀", "ok");

        setTimeout(() => {
          if (this.bleDevice && this.bleDevice.gatt.connected) {
            this.bleDevice.gatt.disconnect();
          }
        }, 800);
      } else {
        this.onStatusChange("Prüfe & speichere im Flash...", "busy");
        await cmdChar.writeValue(this.encodeText(useV2 ? `END:${totalCrcHex}` : "END"));
        if (useV2) {
          const endStatusView = await cmdChar.readValue();
          const endStatus = endStatusView.getUint16(0, true);
          const flashCrc = endStatusView.byteLength >= 6 ? endStatusView.getUint32(2, true) : totalCrc;
          if (endStatus === 0xffff || flashCrc !== totalCrc) {
            throw new Error(`Bild-Integritätsprüfung im Flash fehlgeschlagen (Flash-CRC 0x${flashCrc.toString(16)} != 0x${totalCrcHex}).`);
          }
        }
        this.onStatusChange("Aktualisiere das Display...", "busy");
        await new Promise((r) => setTimeout(r, 200));
        await cmdChar.writeValue(this.encodeText("APPLY"));
        this.onStatusChange("Upload abgeschlossen! 🚀", "ok");
      }
    } catch (error) {
      console.error(error);
      this.onStatusChange(`Fehler beim ${isFirmware ? "Firmware " : ""}Upload: ` + error.message, "err");
      error.reported = true; // the status line already shows this error
      throw error;
    }
  }

  async uploadImage(buffer) {
    return this.uploadData(buffer, false);
  }

  async uploadFirmware(buffer) {
    return this.uploadData(buffer, true);
  }
}

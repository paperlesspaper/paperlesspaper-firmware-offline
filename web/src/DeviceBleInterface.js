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
    this.HTTP_AUTH_PASS_UUID = "10000008-0000-0000-0000-000000000001"; // READ/WRITE
    this.MOTION_WAKEUP_UUID = "10000009-0000-0000-0000-000000000001"; // READ/WRITE
    this.CHARGER_MODE_UUID = "1000000a-0000-0000-0000-000000000001"; // READ/WRITE
    this.SETTINGS_URL_UUID = "1000000b-0000-0000-0000-000000000001"; // READ/WRITE
    this.AUTO_ROTATION_UUID = "1000000c-0000-0000-0000-000000000001"; // READ/WRITE

    this.DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";
    this.WIFI_INFO_UUID = "4c578d4d-7b0e-11ed-a1eb-0242ac120002";
    this.SYSTEM_INFO_UUID = "60000001-7b0e-11ed-a1eb-0242ac120002";

    this.bleDevice = null;
    this.settingsService = null;
    this.wifiService = null;
    this.deviceDataService = null;
    
    this.reconnectInterval = null;
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this.isScanningWifi = false;
    this.isWritingDirectSettings = false;

    // Callbacks
    this.onStatusChange = () => {};
    this.onConnected = () => {};
    this.onDisconnected = () => {};
    this.onWifiStatusChange = () => {};
    this.onWifiInfoChange = () => {};
    this.onWifiScanResult = () => {};
    this.onSystemStatusChange = () => {};
    this.onSettingsLoaded = () => {};
    this.onUploadProgress = () => {};
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

  async connect() {
    try {
      this.manualDisconnect = false;
      this.onStatusChange("Fordere Bluetooth-Kopplung an...", "text-blue-500");
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "epd" }],
        optionalServices: [this.SETTINGS_SERVICE_UUID, this.WIFI_SERVICE_UUID, this.DEVICE_DATA_SERVICE_UUID],
      });

      let isPaperL = false;
      if (this.bleDevice.name && this.bleDevice.name.startsWith("epd13-")) {
        isPaperL = true;
      }

      this.bleDevice.addEventListener("gattserverdisconnected", () => this.handleDisconnect());

      await this.connectToGatt(isPaperL);
    } catch (error) {
      console.error(error);
      this.onStatusChange("Kopplung abgebrochen oder Fehler: " + error.message, "text-red-500");
    }
  }

  async connectToGatt(isPaperL) {
    if (this.bleDevice && this.bleDevice.gatt.connected) return;

    try {
      this.onStatusChange(`Verbinde zu GATT Server... ${this.reconnectAttempts > 0 ? `(Versuch ${this.reconnectAttempts})` : ""}`, "text-blue-500");
      const server = await this.bleDevice.gatt.connect();
      this.reconnectAttempts = 0;

      this.onStatusChange("Lade Services...", "text-blue-500");
      this.settingsService = await server.getPrimaryService(this.SETTINGS_SERVICE_UUID);
      this.wifiService = await server.getPrimaryService(this.WIFI_SERVICE_UUID);
      this.deviceDataService = await server.getPrimaryService(this.DEVICE_DATA_SERVICE_UUID);

      await this.readAllSettings();
      await this.setupWifiListeners();
      await this.setupSystemListeners();

      this.onStatusChange("Erfolgreich Verbunden!", "text-green-600");
      this.onConnected(isPaperL);
    } catch (error) {
      console.error(error);
      if (!this.manualDisconnect) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= 12) {
          this.onStatusChange(`Verbindungsfehler. Reconnect in 5s... (${this.reconnectAttempts}/12)`, "text-orange-500");
          if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
          this.reconnectInterval = setTimeout(() => {
            this.connectToGatt(isPaperL);
          }, 5000);
        } else {
          this.onStatusChange("Verbindung endgültig verloren.", "text-red-500");
          this.onDisconnected();
        }
      } else {
        this.onStatusChange("Verbindung abgebrochen oder getrennt.", "text-orange-500");
        this.onDisconnected();
      }
    }
  }

  handleDisconnect() {
    this.settingsService = null;
    this.wifiService = null;
    this.deviceDataService = null;
    this.isScanningWifi = false;

    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);

    if (!this.manualDisconnect) {
      this.reconnectAttempts = 1;
      this.onStatusChange(`Verbindung unterbrochen. Reconnect in 5s... (${this.reconnectAttempts}/12)`, "text-orange-500");
      this.reconnectInterval = setTimeout(() => {
        this.connectToGatt();
      }, 5000);
    } else {
      this.onStatusChange("Gerät getrennt.", "text-orange-500");
      this.onDisconnected();
    }
    
    // Wir rufen hier nochmal explizit den UI disconnect auf
    this.onDisconnected();
  }

  async disconnect() {
    if (this.bleDevice && this.bleDevice.gatt.connected) {
      this.manualDisconnect = true;
      if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
      this.onStatusChange("Trenne Verbindung...", "text-orange-500");

      try {
        const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
        await cmdChar.writeValue(this.encodeText("EXIT_SETUP"));
      } catch (e) {
        console.warn("Could not send EXIT_SETUP", e);
      }

      this.bleDevice.gatt.disconnect();
    }
  }

  async readAllSettings() {
    this.onStatusChange("Lese Geräteeinstellungen...", "text-blue-500");
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

        const httpAuthPasswordChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_PASS_UUID);
        settings.httpAuthPassword = new TextDecoder().decode(await httpAuthPasswordChar.readValue()).replace(/\0/g, "");

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
            this.onSystemStatusChange(JSON.parse(jsonStr));
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

  async scanWifi() {
    if (this.settingsService && !this.isScanningWifi) {
      try {
        this.isScanningWifi = true;
        const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
        await cmdChar.writeValue(this.encodeText("SCAN_WIFI"));
        setTimeout(() => {
          this.isScanningWifi = false;
        }, 5000);
      } catch (e) {
        console.error("Failed to trigger WLAN Scan:", e);
        this.isScanningWifi = false;
        throw e;
      }
    }
  }

  async saveWifi(ssid, password) {
    if (!this.wifiService) return false;

    try {
      this.onStatusChange("Speichere WLAN...", "text-blue-500");
      const ssidChar = await this.wifiService.getCharacteristic(this.WIFI_SSID_UUID);
      await ssidChar.writeValue(this.encodeText(ssid));

      const passChar = await this.wifiService.getCharacteristic(this.WIFI_PASS_UUID);
      await passChar.writeValue(this.encodeText(password));

      this.onStatusChange("Prüfe WLAN-Verbindung...", "text-yellow-500");

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
        this.onStatusChange("WLAN gespeichert & Erfolgreich Verbunden! ✅", "text-green-600");
        try {
          const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
          await modeChar.writeValue(this.encodeText("1"));
        } catch (err) {}
        return true;
      } else {
        this.onWifiStatusChange(false);
        this.onStatusChange("WLAN gespeichert, aber Verbindung fehlgeschlagen (Passwort falsch?)", "text-red-500");
        return false;
      }
    } catch (e) {
      console.error(e);
      this.onStatusChange("Fehler beim Speichern des WLANs.", "text-red-500");
      return false;
    }
  }

  async saveSettings(settings) {
    if (!this.settingsService) return false;
    try {
      this.onStatusChange("Speichere Einstellungen...", "text-purple-500");
      const encoder = new TextEncoder();

      const urlChar = await this.settingsService.getCharacteristic(this.URL_UUID);
      await urlChar.writeValue(encoder.encode(settings.url || ""));

      const timeoutChar = await this.settingsService.getCharacteristic(this.TIMEOUT_UUID);
      await timeoutChar.writeValue(encoder.encode(settings.timeout || "3600"));

      try {
        const httpAuthUserChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_USER_UUID);
        await httpAuthUserChar.writeValue(encoder.encode(settings.httpAuthUser || ""));

        const httpAuthPasswordChar = await this.settingsService.getCharacteristic(this.HTTP_AUTH_PASS_UUID);
        await httpAuthPasswordChar.writeValue(encoder.encode(settings.httpAuthPassword || ""));

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

      this.onStatusChange("Einstellungen gespeichert!", "text-green-500");
      return true;
    } catch (error) {
      console.error(error);
      this.onStatusChange("Fehler beim Speichern der Einstellungen", "text-red-500");
      return false;
    }
  }

  async directSaveSetting(type, value) {
    if (!this.settingsService) return;
    try {
      this.isWritingDirectSettings = true;
      let charUUID = null;
      if (type === 'motionWakeup') charUUID = this.MOTION_WAKEUP_UUID;
      if (type === 'chargerMode') charUUID = this.CHARGER_MODE_UUID;
      if (type === 'autoRotation') charUUID = this.AUTO_ROTATION_UUID;
      
      if (charUUID) {
        const char = await this.settingsService.getCharacteristic(charUUID);
        await char.writeValue(this.encodeText(value ? "1" : "0"));

        const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
        await cmdChar.writeValue(this.encodeText("SAVE_SETTINGS"));
      }
    } catch (err) {
      console.error(`Failed to update ${type} directly`, err);
    } finally {
      this.isWritingDirectSettings = false;
    }
  }

  async factoryReset() {
    if (!this.settingsService) return;
    try {
      this.onStatusChange("Führe Factory Reset aus...", "text-red-500");
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);
      await cmdChar.writeValue(this.encodeText("RESET"));
      this.onStatusChange("Gerät wird zurückgesetzt und neugestartet.", "text-green-600");

      setTimeout(() => {
        if (this.bleDevice && this.bleDevice.gatt.connected) {
          this.bleDevice.gatt.disconnect();
        }
      }, 1500);
    } catch (e) {
      console.error(e);
      this.onStatusChange("Fehler beim Factory Reset.", "text-red-500");
    }
  }

  async uploadData(buffer, isFirmware = false) {
    if (!this.settingsService) return;
    
    try {
      this.onUploadProgress(isFirmware ? 'firmware' : 'image', 0);
      
      if (!isFirmware) {
        try {
          const modeChar = await this.settingsService.getCharacteristic(this.MODE_UUID);
          await modeChar.writeValue(this.encodeText("0"));
        } catch (err) {
          console.warn("Modus konnte nicht auf BLE gesetzt werden:", err);
        }
      }

      const dataChar = await this.settingsService.getCharacteristic(this.UPLOAD_DATA_UUID);
      const cmdChar = await this.settingsService.getCharacteristic(this.UPLOAD_CMD_UUID);

      this.onStatusChange(isFirmware ? "Starte Firmware Update..." : "Öffne Flash Puffer...", "text-blue-500");
      await cmdChar.writeValue(this.encodeText(isFirmware ? "START_FW" : "START"));

      const chunkSize = 238;
      const checkpointSize = 19040;
      let offset = 0;
      let retryCount = 0;

      while (offset < buffer.length) {
        let windowEnd = Math.min(offset + checkpointSize, buffer.length);
        let bytesToSend = windowEnd - offset;

        for (let currentOffset = offset; currentOffset < windowEnd; currentOffset += chunkSize) {
          let chunkData = buffer.slice(currentOffset, currentOffset + chunkSize);

          let packet = new Uint8Array(chunkData.length + 4);
          let crc = this.calcCRC32(chunkData);
          packet[0] = crc & 0xff;
          packet[1] = (crc >> 8) & 0xff;
          packet[2] = (crc >> 16) & 0xff;
          packet[3] = (crc >>> 24) & 0xff;
          packet.set(chunkData, 4);

          let isLastInWindow = currentOffset + chunkSize >= windowEnd;

          if (isLastInWindow) {
            await dataChar.writeValue(packet);
          } else {
            await dataChar.writeValueWithoutResponse(packet);
            await new Promise((r) => setTimeout(r, 6));
          }
        }

        let statusView = await cmdChar.readValue();
        let ramBytes = statusView.getUint16(0, true);

        if (ramBytes === bytesToSend) {
          await cmdChar.writeValue(this.encodeText("FLUSH"));
          offset = windowEnd;
          retryCount = 0;
        } else {
          console.warn(`Paketverlust! Erwartet: ${bytesToSend}, RAM hat: ${ramBytes}`);
          await cmdChar.writeValue(this.encodeText("CLEAR"));
          retryCount++;

          if (retryCount > 10) {
            throw new Error(`Upload fehlgeschlagen! Checkpoint bei ${offset} konnte nicht übertragen werden.`);
          }
          this.onStatusChange(`Paketverlust! Wiederhole Checkpoint... (Versuch ${retryCount})`, "text-orange-500");
        }

        let percent = Math.round((offset / buffer.length) * 100);
        this.onUploadProgress(isFirmware ? 'firmware' : 'image', percent);
        this.onStatusChange(`Sende ${isFirmware ? 'Firmware' : 'Daten'}... ${percent}%`, "text-green-500");
      }

      this.onUploadProgress(isFirmware ? 'firmware' : 'image', 100);
      
      if (isFirmware) {
        this.onStatusChange("Beende Firmware Update & Neustart...", "text-blue-500");
        await cmdChar.writeValue(this.encodeText("END_FW"));
        setTimeout(() => {
          if (this.bleDevice && this.bleDevice.gatt.connected) {
            this.bleDevice.gatt.disconnect();
          }
        }, 1500);
      } else {
        this.onStatusChange("Speichere im Flash...", "text-blue-500");
        await cmdChar.writeValue(this.encodeText("END"));
        this.onStatusChange("Aktualisiere das Display...", "text-blue-500");
        await new Promise((r) => setTimeout(r, 500));
        await cmdChar.writeValue(this.encodeText("APPLY"));
        this.onStatusChange("Upload abgeschlossen! 🚀", "text-green-600");
      }
    } catch (error) {
      console.error(error);
      this.onStatusChange(`Fehler beim ${isFirmware ? 'Firmware ' : ''}Upload: ` + error.message, "text-red-500");
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

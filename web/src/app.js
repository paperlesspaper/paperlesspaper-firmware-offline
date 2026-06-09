function getBasePalette(val) {
  if (val === "spectra6Custom") return spectra6CustomPalette;
  if (val === "spectra6Calibrated") return spectra6CalibratedPalette;
  return spectra6OriginalPalette;
}
import { ditherImage, applyImageAdjustments, spectra6OriginalPalette, spectra6Palette as spectra6CalibratedPalette, replaceColors, suggestCanvasProcessingOptions, getProcessingPresetOptions } from "epdoptimize";

/*
const spectra6CustomPalette = [
  { name: "black", color: "#1f2226", deviceColor: "#000000" },
  { name: "white", color: "#d6d6d6", deviceColor: "#FFFFFF" },
  { name: "blue", color: "#416ce1", deviceColor: "#0000FF" },
  { name: "green", color: "#35563a", deviceColor: "#00FF00" },
  { name: "red", color: "#ea4843", deviceColor: "#FF0000" },
  { name: "yellow", color: "#c1bb1e", deviceColor: "#FFFF00" },
];*/
//test palette
const spectra6CustomPalette = [
  { name: "black", color: "#1f2226", deviceColor: "#000000" },
  { name: "white", color: "#d6d6d6", deviceColor: "#FFFFFF" },
  { name: "blue", color: "#416ce1", deviceColor: "#0000FF" },
  { name: "green", color: "#067406", deviceColor: "#00FF00" },
  { name: "red", color: "#ea4843", deviceColor: "#FF0000" },
  { name: "yellow", color: "#dbd529", deviceColor: "#FFFF00" },
];
// BLE UUIDs
const WIFI_SERVICE_UUID = "0515c086-7b0c-11ed-a1eb-0242ac120002";
const WIFI_SSID_UUID = "090b0ef2-7b0d-11ed-a1eb-0242ac120002";
const WIFI_PASS_UUID = "a62eed84-7b0d-11ed-a1eb-0242ac120002";

const SETTINGS_SERVICE_UUID = "10000000-0000-0000-0000-000000000001";
const URL_UUID = "10000001-0000-0000-0000-000000000001";
const MODE_UUID = "10000002-0000-0000-0000-000000000001";
const UPLOAD_DATA_UUID = "10000003-0000-0000-0000-000000000001"; // WRITE_NR
const UPLOAD_CMD_UUID = "10000004-0000-0000-0000-000000000001"; // WRITE
const TIMEOUT_UUID = "10000005-0000-0000-0000-000000000001";
const HTTP_AUTH_USER_UUID = "10000007-0000-0000-0000-000000000001"; // READ/WRITE
const HTTP_AUTH_PASS_UUID = "10000008-0000-0000-0000-000000000001"; // READ/WRITE
const MOTION_WAKEUP_UUID = "10000009-0000-0000-0000-000000000001"; // READ/WRITE
const CHARGER_MODE_UUID = "1000000a-0000-0000-0000-000000000001"; // READ/WRITE

const DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
const WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
const WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";
const WIFI_INFO_UUID = "4c578d4d-7b0e-11ed-a1eb-0242ac120002";
const SYSTEM_INFO_UUID = "60000001-7b0e-11ed-a1eb-0242ac120002";
// ACHTUNG: Passe EPD_WIDTH/HEIGHT bei Bedarf an dein Panel an
const EPD_WIDTH = 800;
const EPD_HEIGHT = 480;

let bleDevice = null;
let settingsService = null;
let wifiService = null;
let processedImageBuffer = null;
let reconnectInterval = null;
let manualDisconnect = false;

const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const statusText = document.getElementById("statusText");
const controls = document.getElementById("controls");
const controlsOta = document.getElementById("controlsOta");

const btnSaveWifi = document.getElementById("btnSaveWifi");
const wifiSsid = document.getElementById("wifiSsid");
const btnScanWifi = document.getElementById("btnScanWifi");
const wifiList = document.getElementById("wifiList");
const wifiPass = document.getElementById("wifiPass");
const btnTogglePass = document.getElementById("btnTogglePass");
const eyeIconOpen = document.getElementById("eyeIconOpen");
const eyeIconClosed = document.getElementById("eyeIconClosed");

const btnSaveSettings = document.getElementById("btnSaveSettings");
const btnFactoryReset = document.getElementById("btnFactoryReset");
const settingTimeout = document.getElementById("settingTimeout");
const settingUrl = document.getElementById("settingUrl");
const settingHttpAuthUser = document.getElementById("settingHttpAuthUser");
const settingHttpAuthPassword = document.getElementById("settingHttpAuthPassword");
const settingMotionWakeup = document.getElementById("settingMotionWakeup");
const settingChargerMode = document.getElementById("settingChargerMode");
const btnToggleHttpAuthPass = document.getElementById("btnToggleHttpAuthPass");
const eyeHttpAuthIconOpen = document.getElementById("eyeHttpAuthIconOpen");
const eyeHttpAuthIconClosed = document.getElementById("eyeHttpAuthIconClosed");

const fileInput = document.getElementById("fileInput");
const btnUploadImage = document.getElementById("btnUploadImage");
const btnDownloadBin = document.getElementById("btnDownloadBin");
const canvas = document.getElementById("previewCanvas");
canvas.width = EPD_WIDTH;
canvas.height = EPD_HEIGHT;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");

const btnFetchOriginalFw = document.getElementById("btnFetchOriginalFw");
const fwInput = document.getElementById("fwInput");
const btnSelectFw = document.getElementById("btnSelectFw");
const fwProgressContainer = document.getElementById("fwProgressContainer");
const fwProgressBar = document.getElementById("fwProgressBar");

const syncBadgeWifi = document.getElementById("syncBadgeWifi");
const syncBadgeSettings = document.getElementById("syncBadgeSettings");

const wifiConnectedInfo = document.getElementById("wifiConnectedInfo");
const btnEditWifi = document.getElementById("btnEditWifi");
const wifiInputMask = document.getElementById("wifiInputMask");
const infoSsid = document.getElementById("infoSsid");
const infoIp = document.getElementById("infoIp");
const infoRssi = document.getElementById("infoRssi");
const infoQuality = document.getElementById("infoQuality");

if (btnEditWifi) {
  btnEditWifi.addEventListener("click", () => {
    wifiConnectedInfo.classList.add("hidden");
    wifiInputMask.classList.remove("hidden");
  });
}

const ditheringType = document.getElementById("ditheringType");
const errorDiffusionMatrix = document.getElementById("errorDiffusionMatrix");
const serpentine = document.getElementById("serpentine");
const colorMatchingMode = document.getElementById("colorMatchingMode");
const paletteSelect = document.getElementById("paletteSelect");
const paletteEditor = document.getElementById("paletteEditor");
const processingBrightness = document.getElementById("processingBrightness");
const processingContrast = document.getElementById("processingContrast");
const processingSaturation = document.getElementById("processingSaturation");
const btnRedither = document.getElementById("btnRedither");
const btnAutoDither = document.getElementById("btnAutoDither");
const btnRotate = document.getElementById("btnRotate");

let originalImage = null;
let customPalette = null;
let imageRotation = 0;

if (btnTogglePass) {
  btnTogglePass.addEventListener("click", () => {
    if (wifiPass.type === "password") {
      wifiPass.type = "text";
      eyeIconOpen.classList.remove("hidden");
      eyeIconClosed.classList.add("hidden");
    } else {
      wifiPass.type = "password";
      eyeIconOpen.classList.add("hidden");
      eyeIconClosed.classList.remove("hidden");
    }
  });
}

if (btnToggleHttpAuthPass) {
  btnToggleHttpAuthPass.addEventListener("click", () => {
    if (settingHttpAuthPassword.type === "password") {
      settingHttpAuthPassword.type = "text";
      eyeHttpAuthIconOpen.classList.remove("hidden");
      eyeHttpAuthIconClosed.classList.add("hidden");
    } else {
      settingHttpAuthPassword.type = "password";
      eyeHttpAuthIconOpen.classList.add("hidden");
      eyeHttpAuthIconClosed.classList.remove("hidden");
    }
  });
}

function encodeText(text) {
  return new TextEncoder().encode(text);
}

function setStatus(text, colorClass = "text-gray-500") {
  if (statusText) {
    statusText.className = `mt-3 text-sm font-semibold ${colorClass}`;
    statusText.innerText = text;
  }
}

function updateWifiStatusUI(isConnected) {
  if (isConnected) {
    wifiInputMask.classList.add("hidden");
    wifiConnectedInfo.classList.remove("hidden");
  } else {
    wifiInputMask.classList.remove("hidden");
    wifiConnectedInfo.classList.add("hidden");
  }
}

async function connectToDevice() {
  if (bleDevice && bleDevice.gatt.connected) return;

  try {
    setStatus("Verbinde zu GATT Server...", "text-blue-500");
    const server = await bleDevice.gatt.connect();

    setStatus("Lade Services...", "text-blue-500");
    settingsService = await server.getPrimaryService(SETTINGS_SERVICE_UUID);
    wifiService = await server.getPrimaryService(WIFI_SERVICE_UUID);

    // Initialen Device Sync starten
    try {
      setStatus("Lese Geräteeinstellungen...", "text-blue-500");
      // Lese WLAN
      const ssidChar = await wifiService.getCharacteristic(WIFI_SSID_UUID);
      const ssidVal = await ssidChar.readValue();
      const ssidStr = new TextDecoder().decode(ssidVal).replace(/\0/g, "");
      if (ssidStr !== "" && ssidStr !== "wifi-ssid") {
        wifiSsid.value = ssidStr;
        syncBadgeWifi.classList.remove("hidden");
      }

      // Lese URL
      const urlChar = await settingsService.getCharacteristic(URL_UUID);
      const urlVal = await urlChar.readValue();
      const urlStr = new TextDecoder().decode(urlVal).replace(/\0/g, "");
      if (urlStr !== "") {
        settingUrl.value = urlStr;
        syncBadgeSettings.classList.remove("hidden");
      }

      // Lese Timeout
      const timeoutChar = await settingsService.getCharacteristic(TIMEOUT_UUID);
      const timeoutVal = await timeoutChar.readValue();
      const timeoutStr = new TextDecoder().decode(timeoutVal).replace(/\0/g, "");
      if (timeoutStr !== "") {
        settingTimeout.value = timeoutStr;
        syncBadgeSettings.classList.remove("hidden");
      }

      // Lese HTTP Auth Settings
      try {
        const httpAuthUserChar = await settingsService.getCharacteristic(HTTP_AUTH_USER_UUID);
        const userVal = await httpAuthUserChar.readValue();
        settingHttpAuthUser.value = new TextDecoder().decode(userVal).replace(/\0/g, "");

        const httpAuthPasswordChar = await settingsService.getCharacteristic(HTTP_AUTH_PASS_UUID);
        const passVal = await httpAuthPasswordChar.readValue();
        settingHttpAuthPassword.value = new TextDecoder().decode(passVal).replace(/\0/g, "");
        const motionWakeupChar = await settingsService.getCharacteristic(MOTION_WAKEUP_UUID);
        const motionWakeupData = await motionWakeupChar.readValue();
        const motionWakeupVal = new TextDecoder().decode(motionWakeupData);
        settingMotionWakeup.checked = (motionWakeupVal === "1" || motionWakeupVal === "true");

        const chargerModeChar = await settingsService.getCharacteristic(CHARGER_MODE_UUID);
        const chargerModeData = await chargerModeChar.readValue();
        const chargerModeVal = new TextDecoder().decode(chargerModeData);
        settingChargerMode.checked = (chargerModeVal === "1" || chargerModeVal === "true");
      } catch (e) {
        // Falls alte Firmware die UUIDs nicht hat
      }

      // Initialen WLAN Connect Status prüfen
      const deviceDataService = await server.getPrimaryService(DEVICE_DATA_SERVICE_UUID);
      const connectedChar = await deviceDataService.getCharacteristic(WIFI_CONNECTED_UUID);

      connectedChar.addEventListener("characteristicvaluechanged", (e) => {
        const val = e.target.value.getUint8(0);
        updateWifiStatusUI(val === 1 || val === 49);
      });
      await connectedChar.startNotifications();

      const isConVal = await connectedChar.readValue();
      const isConNum = isConVal.getUint8(0);
      updateWifiStatusUI(isConNum === 1 || isConNum === 49);
      try {
        const infoChar = await deviceDataService.getCharacteristic(WIFI_INFO_UUID);
        const infoData = await infoChar.readValue();
        const info = JSON.parse(new TextDecoder().decode(infoData));
        if (info.ip) {
            lblNetworkInfo.innerHTML = `Verbunden mit ${info.ssid}<br><span class="text-xs">IP: ${info.ip} | Signal: ${info.rssi}dBm</span>`;
        }
      } catch(e) {
          console.error("Failed to read wifi info", e);
      }

      try {
        const sysInfoChar = await deviceDataService.getCharacteristic(SYSTEM_INFO_UUID);
        const sysInfoData = await sysInfoChar.readValue();
        const jsonStr = new TextDecoder().decode(sysInfoData).replace(/\0/g, "");
        const sysInfo = JSON.parse(jsonStr);
        
        const statusBar = document.getElementById("systemStatusBar");
        const voltageEl = document.getElementById("systemVoltage");
        const chargerEl = document.getElementById("systemChargerStatus");
        const chargerIconBg = document.getElementById("chargerIconBg");
        const chargerIcon = document.getElementById("chargerIcon");
        const batteryIconBg = document.getElementById("batteryIconBg");
        const batteryIcon = document.getElementById("batteryIcon");

        const updateSystemStatusBar = (info) => {
            if (!statusBar) return;
            // Unhide status bar
            statusBar.classList.remove("hidden");
            setTimeout(() => statusBar.classList.remove("scale-95", "opacity-0"), 50);

            // Update voltage
            if (info.voltage > 4000) {
                const v = (info.voltage / 1000).toFixed(2);
                voltageEl.innerText = `${v} V`;
                batteryIconBg.setAttribute("class", "bg-green-100 p-2 rounded-full");
                batteryIcon.setAttribute("class", "w-5 h-5 text-green-600");
            } else {
                voltageEl.innerText = "Keine Batterie";
                batteryIconBg.setAttribute("class", "bg-red-100 p-2 rounded-full");
                batteryIcon.setAttribute("class", "w-5 h-5 text-red-600");
            }

            // Update USB status
            if (info.usb) {
                if (info.charging) {
                    chargerEl.innerText = "Verbunden (Lädt)";
                    chargerEl.className = "text-sm font-bold text-green-600";
                    chargerIconBg.setAttribute("class", "bg-green-100 p-2 rounded-full transition-colors");
                    chargerIcon.setAttribute("class", "w-5 h-5 text-green-600 transition-colors");
                } else {
                    chargerEl.innerText = "Verbunden";
                    chargerEl.className = "text-sm font-bold text-blue-600";
                    chargerIconBg.setAttribute("class", "bg-blue-100 p-2 rounded-full transition-colors");
                    chargerIcon.setAttribute("class", "w-5 h-5 text-blue-600 transition-colors");
                }
            } else {
                chargerEl.innerText = "Nicht verbunden";
                chargerEl.className = "text-sm font-bold text-gray-500";
                chargerIconBg.setAttribute("class", "bg-gray-100 p-2 rounded-full transition-colors");
                chargerIcon.setAttribute("class", "w-5 h-5 text-gray-500 transition-colors");
            }
        };

        updateSystemStatusBar(sysInfo);

        sysInfoChar.addEventListener("characteristicvaluechanged", (e) => {
            const str = new TextDecoder().decode(e.target.value).replace(/\0/g, "");
            if (str.length > 2) {
                try {
                    updateSystemStatusBar(JSON.parse(str));
                } catch(err) { }
            }
        });
        await sysInfoChar.startNotifications();
      } catch(e) {
          console.error("Failed to read system info", e);
      }

      // Hide loading screen and show app
      try {
        const infoChar = await deviceDataService.getCharacteristic(WIFI_INFO_UUID);
        infoChar.addEventListener("characteristicvaluechanged", (e) => {
          const jsonStr = new TextDecoder().decode(e.target.value).replace(/\0/g, "");
          if (jsonStr.length > 2) {
            try {
              const data = JSON.parse(jsonStr);
              if (data.ip) {
                infoIp.innerText = data.ip;
                infoRssi.innerText = data.rssi + " dBm";
                infoSsid.innerText = wifiSsid.value || "Netzwerk";
                if (data.rssi > -60) infoQuality.innerText = "Ausgezeichnet";
                else if (data.rssi > -75) infoQuality.innerText = "Gut";
                else infoQuality.innerText = "Schwach";
              }
            } catch (ex) { }
          }
        });
        await infoChar.startNotifications();

        const infoVal = await infoChar.readValue();
        const infoJsonStr = new TextDecoder().decode(infoVal).replace(/\0/g, "");
        if (infoJsonStr.length > 2) {
          const data = JSON.parse(infoJsonStr);
          if (data.ip) {
            infoIp.innerText = data.ip;
            infoRssi.innerText = data.rssi + " dBm";
            infoSsid.innerText = wifiSsid.value || "Netzwerk";
            if (data.rssi > -60) infoQuality.innerText = "Ausgezeichnet";
            else if (data.rssi > -75) infoQuality.innerText = "Gut";
            else infoQuality.innerText = "Schwach";
          }
        }
      } catch (ex) { }
    } catch (e) {
      console.warn("Sync failed:", e);
    }

    // Lade verfügbare WLANs herunter
    try {
      const deviceDataService = await server.getPrimaryService(DEVICE_DATA_SERVICE_UUID);
      const scanChar = await deviceDataService.getCharacteristic(WIFI_SCAN_UUID);
      
      const processScanData = (data) => {
        const scanText = new TextDecoder().decode(data);
        if (scanText && scanText.length > 0) {
          wifiList.innerHTML = ""; // Vorherige löschen
          const networks = scanText.split("´´");
          let foundNetworks = false;
          networks.forEach((net) => {
            if (!net) return;
            const parts = net.split("´");
            if (parts.length >= 1 && parts[0] && !parts[0].includes("...")) {
              const option = document.createElement("option");
              option.value = parts[0];
              if (parts[1]) {
                option.text = `${parts[0]} (Signal: ${parts[1]} dBm)`;
              }
              wifiList.appendChild(option);
              foundNetworks = true;
            }
          });
          
          if(foundNetworks) {
              isWifiScanned = true;
          }
          if(btnScanWifi && btnScanWifi.innerText === "Suche...") {
              btnScanWifi.innerText = "Scan";
              btnScanWifi.disabled = false;
              btnScanWifi.classList.remove("opacity-50", "cursor-wait");
          }
        }
      };

      await scanChar.startNotifications();
      scanChar.addEventListener('characteristicvaluechanged', (event) => {
          processScanData(event.target.value);
      });
      
      const initialScanData = await scanChar.readValue();
      if(initialScanData.byteLength > 0) {
          processScanData(initialScanData);
      }
    } catch (e) {
      console.warn("WLAN Liste konnte nicht geladen werden:", e);
    }

    setStatus("Erfolgreich Verbunden!", "text-green-600");
    btnConnect.classList.add("hidden");
    btnDisconnect.classList.remove("hidden");
    
    if (controlsOta) {
        controlsOta.classList.remove("hidden");
        setTimeout(() => controlsOta.classList.remove("opacity-0"), 100);
    }
    
    if (btnUploadImage) {
        btnUploadImage.disabled = false;
        btnUploadImage.classList.replace("bg-gray-400", "bg-green-500");
        btnUploadImage.innerText = "Bild auf Display senden (BLE)";
    }

    // UI einblenden
    controls.classList.remove("hidden");
    setTimeout(() => controls.classList.remove("opacity-0"), 100);
  } catch (error) {
    console.error(error);
    if (!manualDisconnect) {
        setStatus("Verbindungsfehler. Versuche Reconnect...", "text-orange-500");
        if (reconnectInterval) clearTimeout(reconnectInterval);
        reconnectInterval = setTimeout(() => {
            connectToDevice();
        }, 3000);
    } else {
        setStatus("Verbindung abgebrochen oder getrennt.", "text-orange-500");
        btnConnect.classList.remove("hidden");
        btnDisconnect.classList.add("hidden");
    }
  }
}

btnConnect.addEventListener("click", async () => {
  try {
    manualDisconnect = false;
    setStatus("Fordere Bluetooth-Kopplung an...", "text-blue-500");
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "epd" }],
      optionalServices: [SETTINGS_SERVICE_UUID, WIFI_SERVICE_UUID, DEVICE_DATA_SERVICE_UUID],
    });

    bleDevice.addEventListener("gattserverdisconnected", () => {
      controls.classList.add("hidden", "opacity-0");
      settingsService = null;
      wifiService = null;
      
      if (controlsOta) controlsOta.classList.add("hidden", "opacity-0");
      
      const statusBar = document.getElementById("systemStatusBar");
      if (statusBar) {
          statusBar.classList.add("opacity-0", "scale-95");
          setTimeout(() => statusBar.classList.add("hidden"), 500);
      }
      
      if (btnUploadImage) {
          btnUploadImage.disabled = true;
          btnUploadImage.classList.replace("bg-green-500", "bg-gray-400");
          btnUploadImage.innerText = "Bild auf Display senden (BLE - nicht verbunden)";
      }
      
      isScanningWifi = false;
      isWifiScanned = false;
      wifiList.innerHTML = "";
      
      if (reconnectInterval) clearTimeout(reconnectInterval);
      
      if (!manualDisconnect) {
          setStatus("Verbindung unterbrochen. Versuche Reconnect...", "text-orange-500");
          reconnectInterval = setTimeout(() => {
              connectToDevice();
          }, 3000);
      } else {
          setStatus("Gerät getrennt.", "text-orange-500");
          btnConnect.classList.remove("hidden");
          btnDisconnect.classList.add("hidden");
      }
    });

    await connectToDevice();
  } catch (error) {
    console.error(error);
    setStatus("Kopplung abgebrochen oder Fehler: " + error.message, "text-red-500");
  }
});

btnDisconnect.addEventListener("click", async () => {
  if (bleDevice && bleDevice.gatt.connected) {
    manualDisconnect = true;
    if (reconnectInterval) clearTimeout(reconnectInterval);
    setStatus("Trenne Verbindung...", "text-orange-500");
    
    try {
        const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
        await cmdChar.writeValue(encodeText("EXIT_SETUP"));
    } catch(e) {
        console.warn("Could not send EXIT_SETUP", e);
    }
    
    bleDevice.gatt.disconnect();
  }
});

let isScanningWifi = false;
let isWifiScanned = false;

btnScanWifi.addEventListener("click", async () => {
    if (settingsService && !isScanningWifi && !isWifiScanned) {
        try {
            isScanningWifi = true;
            btnScanWifi.innerText = "Suche...";
            btnScanWifi.disabled = true;
            btnScanWifi.classList.add("opacity-50", "cursor-wait");
            const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
            await cmdChar.writeValue(encodeText("SCAN_WIFI"));
            setTimeout(() => { 
                isScanningWifi = false; 
                if (btnScanWifi.innerText === "Suche...") {
                    btnScanWifi.innerText = "Scan";
                    btnScanWifi.disabled = false;
                    btnScanWifi.classList.remove("opacity-50", "cursor-wait");
                }
            }, 5000);
        } catch (e) {
            console.error("Failed to trigger WLAN Scan:", e);
            btnScanWifi.innerText = "Scan";
            btnScanWifi.disabled = false;
            btnScanWifi.classList.remove("opacity-50", "cursor-wait");
            isScanningWifi = false;
        }
    }
});

btnSaveWifi.addEventListener("click", async () => {
  if (!wifiService) return;
  const originalText = btnSaveWifi.innerText;

  try {
    btnSaveWifi.innerText = "Verbinde...";
    btnSaveWifi.disabled = true;
    btnSaveWifi.classList.add("opacity-50", "cursor-wait");

    setStatus("Speichere WLAN...", "text-blue-500");
    const ssidChar = await wifiService.getCharacteristic(WIFI_SSID_UUID);
    await ssidChar.writeValue(encodeText(wifiSsid.value));

    const passChar = await wifiService.getCharacteristic(WIFI_PASS_UUID);
    await passChar.writeValue(encodeText(wifiPass.value));

    setStatus("Prüfe WLAN-Verbindung...", "text-yellow-500");

    // Poll the connection status
    const deviceDataService = await bleDevice.gatt.getPrimaryService(DEVICE_DATA_SERVICE_UUID);
    const connectedChar = await deviceDataService.getCharacteristic(WIFI_CONNECTED_UUID);

    // Initial wait to allow firmware to process isDeployWifi and set status to 0
    await new Promise((r) => setTimeout(r, 2000));

    let isConnected = false;
    for (let i = 0; i < 20; i++) {
      // Max 10 Sekunden warten
      await new Promise((r) => setTimeout(r, 500));
      try {
        const data = await connectedChar.readValue();
        const val = data.getUint8(0);
        // Kann als Boolean (1) oder als ASCII-String "1" (49) ankommen
        if (val === 1 || val === 49) {
          isConnected = true;
          break;
        }
      } catch (err) {
        console.warn("Konnten Status nicht lesen:", err);
      }
    }

    if (isConnected) {
      updateWifiStatusUI(true);
      setStatus("WLAN gespeichert & Erfolgreich Verbunden! ✅", "text-green-600");

      // Wenn ein WLAN erfolgreich verbunden ist, setze den Modus direkt auf WLAN (1)
      try {
        const modeChar = await settingsService.getCharacteristic(MODE_UUID);
        await modeChar.writeValue(encodeText("1"));
      } catch (err) {
        console.warn("Modus konnte nicht auf WLAN gesetzt werden:", err);
      }
    } else {
      updateWifiStatusUI(false);
      setStatus("WLAN gespeichert, aber Verbindung fehlgeschlagen (Passwort falsch?)", "text-red-500");
    }
  } catch (e) {
    console.error(e);
    setStatus("Fehler beim Speichern des WLANs.", "text-red-500");
  } finally {
    btnSaveWifi.innerText = originalText;
    btnSaveWifi.disabled = false;
    btnSaveWifi.classList.remove("opacity-50", "cursor-wait");
  }
});

btnSaveSettings.addEventListener("click", async () => {
  if (!settingsService) return;
  try {
    setStatus("Speichere Einstellungen...", "text-purple-500");

    const urlValidationStatus = document.getElementById("urlValidationStatus");
    if (urlValidationStatus) {
      urlValidationStatus.classList.add("hidden");
    }

    if (settingUrl.value) {
      const urlChar = await settingsService.getCharacteristic(URL_UUID);
      await urlChar.writeValue(encodeText(settingUrl.value));

      // Modus automatisch auf URL-Download (1) setzen, da eine URL gespeichert wird
      try {
        const modeChar = await settingsService.getCharacteristic(MODE_UUID);
        await modeChar.writeValue(encodeText("1"));
      } catch (err) {
        console.warn("Modus konnte nicht auf URL gesetzt werden:", err);
      }

      // URL auf Gültigkeit prüfen (als Bild)
      if (urlValidationStatus) {
        urlValidationStatus.classList.remove("hidden");
        urlValidationStatus.className = "text-sm font-medium mb-4 text-purple-500";
        urlValidationStatus.innerText = "Prüfe URL...";
        
        try {
          await new Promise((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
            img.onload = () => { clearTimeout(timeout); resolve(); };
            img.onerror = () => { clearTimeout(timeout); reject(new Error("Invalid")); };
            img.src = settingUrl.value;
          });
          urlValidationStatus.className = "text-sm font-medium mb-4 text-green-500";
          urlValidationStatus.innerText = "✓ URL ist erreichbar und gültig.";
        } catch (err) {
          urlValidationStatus.className = "text-sm font-medium mb-4 text-orange-500";
          urlValidationStatus.innerText = "⚠ URL konnte nicht als Bild geladen werden (evtl. ungültig oder offline). Wird dennoch gespeichert.";
        }
      }
    }

    const httpAuthUserChar = await settingsService.getCharacteristic(HTTP_AUTH_USER_UUID);
    await httpAuthUserChar.writeValue(encodeText(settingHttpAuthUser.value || ""));

    const httpAuthPasswordChar = await settingsService.getCharacteristic(HTTP_AUTH_PASS_UUID);
    await httpAuthPasswordChar.writeValue(encodeText(settingHttpAuthPassword.value || ""));

    const timeoutChar = await settingsService.getCharacteristic(TIMEOUT_UUID);
    await timeoutChar.writeValue(encodeText(settingTimeout.value || "3600"));

    const motionWakeupChar = await settingsService.getCharacteristic(MOTION_WAKEUP_UUID);
    await motionWakeupChar.writeValue(encodeText(settingMotionWakeup.checked ? "1" : "0"));

    const chargerModeChar = await settingsService.getCharacteristic(CHARGER_MODE_UUID);
    await chargerModeChar.writeValue(encodeText(settingChargerMode.checked ? "1" : "0"));

    // Tell the firmware to save all written settings to EEPROM at once
    const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
    await cmdChar.writeValue(encodeText("SAVE_SETTINGS"));

    setStatus("Einstellungen erfolgreich gespeichert!", "text-green-600");
  } catch (e) {
    console.error(e);
    setStatus("Fehler: Sind die neuen UUIDs bereits in main.cpp enthalten?", "text-red-500");
  }
});

btnFactoryReset.addEventListener("click", async () => {
  if (!settingsService) return;
  if (!confirm("Möchtest du das Gerät wirklich auf Werkseinstellungen zurücksetzen? Alle Einstellungen, WLAN-Zugangsdaten und gespeicherte Bilder werden gelöscht.")) {
    return;
  }

  try {
    setStatus("Führe Factory Reset aus...", "text-red-500");
    const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
    await cmdChar.writeValue(encodeText("RESET"));
    setStatus("Gerät wird zurückgesetzt und neugestartet.", "text-green-600");

    // Disconnect after a short delay since the device will restart
    setTimeout(() => {
      if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
      }
    }, 1500);
  } catch (e) {
    console.error(e);
    setStatus("Fehler beim Factory Reset.", "text-red-500");
  }
});

let isWritingDirectSettings = false;

settingMotionWakeup.addEventListener("change", async (e) => {
    if (!settingsService) return;
    if (isWritingDirectSettings) {
        e.target.checked = !e.target.checked; // Revert UI
        return;
    }
    try {
        isWritingDirectSettings = true;
        settingMotionWakeup.disabled = true;
        const motionWakeupChar = await settingsService.getCharacteristic(MOTION_WAKEUP_UUID);
        await motionWakeupChar.writeValue(encodeText(settingMotionWakeup.checked ? "1" : "0"));
        
        const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
        await cmdChar.writeValue(encodeText("SAVE_SETTINGS"));
    } catch (err) {
        console.error("Failed to update motion wakeup directly", err);
    } finally {
        settingMotionWakeup.disabled = false;
        isWritingDirectSettings = false;
    }
});

settingChargerMode.addEventListener("change", async (e) => {
    if (!settingsService) return;
    if (isWritingDirectSettings) {
        e.target.checked = !e.target.checked; // Revert UI
        return;
    }
    try {
        isWritingDirectSettings = true;
        settingChargerMode.disabled = true;
        const chargerModeChar = await settingsService.getCharacteristic(CHARGER_MODE_UUID);
        await chargerModeChar.writeValue(encodeText(settingChargerMode.checked ? "1" : "0"));
        
        const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
        await cmdChar.writeValue(encodeText("SAVE_SETTINGS"));
    } catch (err) {
        console.error("Failed to update charger mode directly", err);
    } finally {
        settingChargerMode.disabled = false;
        isWritingDirectSettings = false;
    }
});

const SPECTRA_COLOR_INDICES = {
  black: 0,
  blue: 1,
  green: 2,
  red: 3,
  yellow: 5,
  white: 6,
};

function hexToRgb(h) {
  const num = parseInt(h.replace("#", ""), 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function getClosestColorIndex(r, g, b, palette) {
  let minDst = Infinity;
  let bestIdx = 6;
  for (const entry of palette) {
    const c = hexToRgb(entry.color);
    const dst = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (dst < minDst) {
      minDst = dst;
      bestIdx = SPECTRA_COLOR_INDICES[entry.name] ?? 6;
    }
  }
  return bestIdx;
}

function drawOriginalToCanvas(targetCtx) {
  if (!originalImage) return;

  targetCtx.fillStyle = "white";
  targetCtx.fillRect(0, 0, EPD_WIDTH, EPD_HEIGHT);

  const isRotated = imageRotation === 90 || imageRotation === 270;
  const virtW = isRotated ? originalImage.height : originalImage.width;
  const virtH = isRotated ? originalImage.width : originalImage.height;

  // Modus: CONTAIN (Bild komplett sichtbar, "eingepasst").
  let scale = Math.min(EPD_WIDTH / virtW, EPD_HEIGHT / virtH);
  let renderW = originalImage.width * scale;
  let renderH = originalImage.height * scale;

  targetCtx.save();
  // Zum Mittelpunkt des Canvas verschieben
  targetCtx.translate(EPD_WIDTH / 2, EPD_HEIGHT / 2);
  targetCtx.rotate((imageRotation * Math.PI) / 180);

  // Das Bild relativ zu seinem eigenen Zentrum zeichnen
  targetCtx.drawImage(originalImage, -renderW / 2, -renderH / 2, renderW, renderH);

  targetCtx.restore();
}

async function updatePreviewAndBuffer(options = {}) {
  if (!originalImage) return;

  drawOriginalToCanvas(ctx);

  let imageData = ctx.getImageData(0, 0, EPD_WIDTH, EPD_HEIGHT);

  const ditheringTypeVal = ditheringType.value;
  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
  const activePalette = customPalette || getBasePalette(paletteSelect ? paletteSelect.value : "spectra6Custom");
  const colorMode = colorMatchingMode.value;

  const brightnessInt = parseInt(processingBrightness.value, 10);
  const contrastInt = parseInt(processingContrast.value, 10);
  const saturationInt = parseInt(processingSaturation.value, 10);

  const toneMappingMode = brightnessInt !== 0 || contrastInt !== 0 || saturationInt !== 0 ? "contrast" : "off";

  const ditherOptions = {
    ...options, // Damit btnAutoDither das überschreiben kann
    ditheringType: options.ditheringType ?? ditheringTypeVal,
    errorDiffusionMatrix: options.errorDiffusionMatrix ?? matrix,
    serpentine: options.serpentine ?? isSerpentine,
    colorMatching: options.colorMatching ?? colorMode,
    toneMapping: options.toneMapping || {
      mode: toneMappingMode,
      exposure: brightnessInt / 100,
      contrast: contrastInt / 100,
      saturation: saturationInt / 100,
    },
  };

  setStatus("Erzeuge Dithering...", "text-yellow-600");

  try {
    await ditherImage(canvas, canvas, {
      ...ditherOptions,
      palette: activePalette,
    });

    const ditheredData = ctx.getImageData(0, 0, EPD_WIDTH, EPD_HEIGHT);

    let ditheredRaw = ditheredData.data;
    let outputCount = Math.ceil((EPD_WIDTH * EPD_HEIGHT) / 2);
    processedImageBuffer = new Uint8Array(outputCount);

    for (let y = 0; y < EPD_HEIGHT; y++) {
      for (let x = 0; x < EPD_WIDTH; x++) {
        let i = (y * EPD_WIDTH + x) * 4;
        let r = ditheredRaw[i],
          g = ditheredRaw[i + 1],
          b = ditheredRaw[i + 2];

        // Finde über den Euklidischen Abstand immer die allerbeste Farbe aus dem Array von KNOWN_COLORS,
        // so umgehen wir fehlerhafte Hex-Vergleiche, falls der Dither leicht abweichende RGB-Werte nutzt (010101 anstatt 000000).
        let colorIndex = getClosestColorIndex(r, g, b, activePalette);

        let outIdx = Math.floor((y * EPD_WIDTH + x) / 2);
        if (x % 2 === 0) processedImageBuffer[outIdx] = colorIndex << 4;
        else processedImageBuffer[outIdx] |= colorIndex;
      }
    }

    btnUploadImage.disabled = false;
    btnDownloadBin.disabled = false;
    setStatus("Bild optimiert und bereit zum Upload!", "text-green-600");
  } catch (e) {
    setStatus("Fehler beim Dithering: " + e.message, "text-red-500");
    console.error(e);
  }
}

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  originalImage = new Image();
  originalImage.onload = () => {
    // Automatisches rotieren, wenn das Bild im Hochformat (Portrait) ist und das Display Querformat hat
    if (originalImage.height > originalImage.width && EPD_WIDTH > EPD_HEIGHT) {
      imageRotation = 270; // 90° gegen den Uhrzeigersinn
    } else {
      imageRotation = 0;
    }
    updatePreviewAndBuffer();
  };
  originalImage.src = URL.createObjectURL(file);
});

if (btnRotate) {
  btnRotate.addEventListener("click", () => {
    if (originalImage) {
      imageRotation = (imageRotation + 90) % 360;
      updatePreviewAndBuffer();
    }
  });
}

btnRedither.addEventListener("click", () => {
  if (originalImage) updatePreviewAndBuffer();
});

btnAutoDither.addEventListener("click", () => {
  if (!originalImage) return;

  drawOriginalToCanvas(ctx);

  const activePalette = customPalette || getBasePalette(paletteSelect ? paletteSelect.value : "spectra6Custom");

  const suggestion = suggestCanvasProcessingOptions(canvas, activePalette, {
    intent: "natural",
  });
  if (suggestion && suggestion.ditherOptions) {
    let resolvedOptions = suggestion.ditherOptions;

    // Wenn ein Preset zurückkommt, dessen Werte für die UI entpacken
    if (resolvedOptions.processingPreset) {
      const presetValues = getProcessingPresetOptions(resolvedOptions.processingPreset);
      resolvedOptions = { ...presetValues, ...resolvedOptions };
    }

    // UI nach Vorschlag updaten
    ditheringType.value = resolvedOptions.ditheringType || "errorDiffusion";
    errorDiffusionMatrix.value = resolvedOptions.errorDiffusionMatrix || "floydSteinberg";
    serpentine.checked = resolvedOptions.serpentine ?? true;
    colorMatchingMode.value = resolvedOptions.colorMatching || "rgb";

    if (resolvedOptions.toneMapping) {
      processingBrightness.value = Math.round((resolvedOptions.toneMapping.exposure ?? 0) * 100) || 0;
      processingContrast.value = Math.round((resolvedOptions.toneMapping.contrast ?? 0) * 100) || 0;
      processingSaturation.value = Math.round((resolvedOptions.toneMapping.saturation ?? 0) * 100) || 0;
    } else {
      processingBrightness.value = 0;
      processingContrast.value = 0;
      processingSaturation.value = 0;
    }

    setStatus(`Automatisches Setting gefunden: ${suggestion.classification.style}, Typ: ${suggestion.imageKind}`, "text-blue-500");

    // Anwenden ohne Preset Name, da wir die Parameter explizit manuell setzen
    // und so dem Benutzer weitere Anpassungen ermöglichen
    delete resolvedOptions.processingPreset;
    updatePreviewAndBuffer(resolvedOptions);
  }
});

btnDownloadBin.addEventListener("click", () => {
  if (!processedImageBuffer) return;

  const headerSize = 118;
  const bufferSize = processedImageBuffer.length;
  const fileSize = headerSize + bufferSize;
  const bmpBuffer = new ArrayBuffer(fileSize);
  const view = new DataView(bmpBuffer);
  const bytes = new Uint8Array(bmpBuffer);

  // BITMAPFILEHEADER
  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, headerSize, true);

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, EPD_WIDTH, true);
  view.setInt32(22, -EPD_HEIGHT, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 4, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, bufferSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 16, true);
  view.setUint32(50, 16, true);

  const pOffset = 54;
  for (let i = 0; i < 16; i++) {
    let r = 0,
      g = 0,
      b = 0;
    // Mappe unsere Firmware Farbcodes auf RGB für die BMP Vorschau am PC
    if (i === 1) b = 255;
    if (i === 2) g = 255;
    if (i === 3) r = 255;
    if (i === 5) {
      r = 255;
      g = 255;
    }
    if (i === 6) {
      r = 255;
      g = 255;
      b = 255;
    }

    view.setUint8(pOffset + i * 4 + 0, b);
    view.setUint8(pOffset + i * 4 + 1, g);
    view.setUint8(pOffset + i * 4 + 2, r);
    view.setUint8(pOffset + i * 4 + 3, 0);
  }

  // Pixels kopieren
  bytes.set(processedImageBuffer, headerSize);

  const blob = new Blob([bmpBuffer], { type: "image/bmp" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "epaper_image.bmp";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
});

function calcCRC32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xEDB88320);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- BLE Upload ---
btnUploadImage.addEventListener("click", async () => {
  if (!settingsService || !processedImageBuffer) return;

  try {
    btnUploadImage.disabled = true;
    progressContainer.classList.remove("hidden");
    progressBar.style.width = "0%";

    try {
      // Wenn ein Bild per BLE hochgeladen wird, setze den Modus auf BLE (0)
      const modeChar = await settingsService.getCharacteristic(MODE_UUID);
      await modeChar.writeValue(encodeText("0"));
    } catch (err) {
      console.warn("Modus konnte nicht auf BLE gesetzt werden:", err);
    }

    const dataChar = await settingsService.getCharacteristic(UPLOAD_DATA_UUID);
    const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);

    setStatus("Öffne Flash Puffer...", "text-blue-500");
    await cmdChar.writeValue(encodeText("START"));

    // Upload in 238 Byte Chunks (plus 1 Byte CRC = 239 Bytes)
    const chunkSize = 238;
    const checkpointSize = 19040; // 80 Pakete á 238 Bytes
    let offset = 0;
    let retryCount = 0;

    while (offset < processedImageBuffer.length) {
      let windowEnd = Math.min(offset + checkpointSize, processedImageBuffer.length);
      let bytesToSend = windowEnd - offset;

      // Sende den Checkpoint-Block
      for (let currentOffset = offset; currentOffset < windowEnd; currentOffset += chunkSize) {
        let chunkData = processedImageBuffer.slice(currentOffset, currentOffset + chunkSize);

        // Berechne CRC und baue Paket (1 Byte CRC + Payload)
        let packet = new Uint8Array(chunkData.length + 4);
        let crc = calcCRC32(chunkData);
        packet[0] = crc & 0xFF;
        packet[1] = (crc >> 8) & 0xFF;
        packet[2] = (crc >> 16) & 0xFF;
        packet[3] = (crc >>> 24) & 0xFF;
        packet.set(chunkData, 4);

        let isLastInWindow = (currentOffset + chunkSize) >= windowEnd;

        if (isLastInWindow) {
          await dataChar.writeValue(packet); // Warten auf ACK beim letzten Paket im Block
        } else {
          await dataChar.writeValueWithoutResponse(packet);
          await new Promise((r) => setTimeout(r, 6)); // Minimales Delay
        }
      }

      // Prüfe, wie viele Bytes der ESP im RAM hat
      let statusView = await cmdChar.readValue();
      let ramBytes = statusView.getUint16(0, true);

      if (ramBytes === bytesToSend) {
        // Erfolg: Alle Daten des Checkpoints sind im ESP-RAM. In den Flash schreiben!
        await cmdChar.writeValue(encodeText("FLUSH"));
        offset = windowEnd; // Gehe zum nächsten Checkpoint
        retryCount = 0;
      } else {
        // Fehler: Paketverlust! ESP-RAM verwerfen und Block neu senden.
        console.warn(`Paketverlust! Erwartet: ${bytesToSend}, RAM hat: ${ramBytes}`);
        await cmdChar.writeValue(encodeText("CLEAR"));
        retryCount++;

        if (retryCount > 10) {
          throw new Error(`Upload fehlgeschlagen! Checkpoint bei ${offset} konnte nicht übertragen werden.`);
        }
        setStatus(`Paketverlust! Wiederhole Checkpoint... (Versuch ${retryCount})`, "text-orange-500");
      }

      let percent = Math.round((offset / processedImageBuffer.length) * 100);
      progressBar.style.width = percent + "%";
      setStatus(`Sende Daten... ${percent}%`, "text-green-500");
    }

    progressBar.style.width = "100%";
    setStatus("Speichere im Flash...", "text-blue-500");
    await cmdChar.writeValue(encodeText("END"));

    setStatus("Aktualisiere das Display...", "text-blue-500");
    // Ca 500ms warten, damit Flash fertig synchronisiert
    await new Promise((r) => setTimeout(r, 500));
    await cmdChar.writeValue(encodeText("APPLY"));

    setStatus("Upload abgeschlossen! 🚀", "text-green-600");
  } catch (error) {
    console.error(error);
    setStatus("Fehler beim Upload: " + error.message, "text-red-500");
    progressBar.classList.add("bg-red-500");
  } finally {
    btnUploadImage.disabled = false;
    btnDownloadBin.disabled = false;
  }
});

// --- Unified Firmware Update (BLE) ---
async function uploadFirmwareBle(buffer) {
  if (!settingsService) return;
  try {
    btnSelectFw.disabled = true;
    btnFetchOriginalFw.disabled = true;
    fwProgressContainer.classList.remove("hidden");
    fwProgressBar.style.width = "0%";

    const dataChar = await settingsService.getCharacteristic(UPLOAD_DATA_UUID);
    const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);

    setStatus("Starte Firmware Update...", "text-blue-500");
    await cmdChar.writeValue(encodeText("START_FW"));

    const chunkSize = 238;
    const checkpointSize = 19040; // 80 Pakete á 238 Bytes
    let offset = 0;
    let retryCount = 0;

    while (offset < buffer.length) {
      let windowEnd = Math.min(offset + checkpointSize, buffer.length);
      let bytesToSend = windowEnd - offset;

      for (let currentOffset = offset; currentOffset < windowEnd; currentOffset += chunkSize) {
        let chunkData = buffer.slice(currentOffset, currentOffset + chunkSize);

        let packet = new Uint8Array(chunkData.length + 4);
        let crc = calcCRC32(chunkData);
        packet[0] = crc & 0xFF;
        packet[1] = (crc >> 8) & 0xFF;
        packet[2] = (crc >> 16) & 0xFF;
        packet[3] = (crc >>> 24) & 0xFF;
        packet.set(chunkData, 4);

        let isLastInWindow = (currentOffset + chunkSize) >= windowEnd;

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
        await cmdChar.writeValue(encodeText("FLUSH"));
        offset = windowEnd; 
        retryCount = 0;
      } else {
        console.warn(`FW Paketverlust! Erwartet: ${bytesToSend}, RAM hat: ${ramBytes}`);
        await cmdChar.writeValue(encodeText("CLEAR"));
        retryCount++;

        if (retryCount > 10) {
          throw new Error(`Upload fehlgeschlagen! Checkpoint bei ${offset} konnte nicht übertragen werden.`);
        }
        setStatus(`Paketverlust! Wiederhole Checkpoint... (Versuch ${retryCount})`, "text-orange-500");
      }

      let percent = Math.round((offset / buffer.length) * 100);
      fwProgressBar.style.width = percent + "%";
      setStatus(`Sende Firmware... ${percent}%`, "text-green-500");
    }

    fwProgressBar.style.width = "100%";
    setStatus("Beende Firmware Update & Neustart...", "text-blue-500");
    await cmdChar.writeValue(encodeText("END_FW"));
    
    // Disconnect after reboot
    setTimeout(() => {
      if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
      }
    }, 1500);

  } catch (error) {
    console.error(error);
    setStatus("Fehler beim Firmware Upload.", "text-red-500");
  } finally {
    btnSelectFw.disabled = false;
    btnFetchOriginalFw.disabled = false;
  }
}

btnFetchOriginalFw.addEventListener("click", async () => {
  if (!settingsService) {
    setStatus("Bitte zuerst mit dem E-Paper verbinden.", "text-red-500");
    return;
  }
  
  try {
    setStatus("Lade Update-Informationen...", "text-blue-500");
    const res = await fetch("http://ul.epaperframe.de/espfota_epd7.json");
    if (!res.ok) throw new Error("JSON konnte nicht geladen werden.");
    const data = await res.json();
    
    if (!data.url) throw new Error("Keine Firmware URL im JSON gefunden.");
    
    setStatus("Lade Original-Firmware herunter...", "text-blue-500");
    const fwRes = await fetch(data.url);
    if (!fwRes.ok) throw new Error("Firmware konnte nicht geladen werden.");
    
    const arrayBuffer = await fwRes.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    await uploadFirmwareBle(buffer);
  } catch (err) {
    console.error(err);
    setStatus("Fehler beim Download der Original-Firmware: " + err.message, "text-red-500");
  }
});

if (btnSelectFw) {
  btnSelectFw.addEventListener("click", () => {
    if (!settingsService) {
      setStatus("Bitte zuerst mit dem E-Paper verbinden.", "text-red-500");
      return;
    }
    fwInput.click();
  });
}

fwInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const buffer = new Uint8Array(e.target.result);
    await uploadFirmwareBle(buffer);
    fwInput.value = ""; // Reset for re-selection
  };
  reader.readAsArrayBuffer(file);
});

paletteSelect.addEventListener("change", () => {
  customPalette = null;
  renderPaletteEditor();
  // By default, just reset the colorMatchingMode to rgb when switching palettes
  colorMatchingMode.value = "rgb";
  if (originalImage) updatePreviewAndBuffer();
});

// Initialize correct color mode on load
colorMatchingMode.value = "rgb";
renderPaletteEditor();

function renderPaletteEditor() {
  if (!paletteEditor) return;
  const basePalette = getBasePalette(paletteSelect.value);

  if (!customPalette) {
    customPalette = JSON.parse(JSON.stringify(basePalette));
  }

  paletteEditor.innerHTML = "";
  customPalette.forEach((c, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "flex flex-col items-center";

    const input = document.createElement("input");
    input.type = "color";
    // epdoptimize uses 6 digit hex length
    input.value = c.color.length === 4 ? "#" + c.color[1] + c.color[1] + c.color[2] + c.color[2] + c.color[3] + c.color[3] : c.color;
    input.className = "w-8 h-8 p-0 border-0 rounded cursor-pointer";
    input.title = c.name + " (" + input.value + ")";

    input.addEventListener("input", (e) => {
      customPalette[idx].color = e.target.value;
      input.title = c.name + " (" + e.target.value + ")";
    });

    input.addEventListener("change", () => {
      if (originalImage) updatePreviewAndBuffer();
    });

    const label = document.createElement("span");
    label.className = "text-[10px] text-gray-500 capitalize mt-1";
    // Limit name length if too long
    label.innerText = c.name.replace("gameboy", "GB");

    wrap.appendChild(input);
    wrap.appendChild(label);
    paletteEditor.appendChild(wrap);
  });
}

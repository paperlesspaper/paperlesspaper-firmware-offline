function getBasePalette(val) {
  if (val === "spectra6Custom") return spectra6CustomPalette;
  return spectra6OriginalPalette;
}
import { ditherImage, applyImageAdjustments, spectra6OriginalPalette, replaceColors, suggestCanvasProcessingOptions, getProcessingPresetOptions } from "epdoptimize";
import newProfile from "./profiles/new.json";

// --- Math and Profile Helpers ported from new project ---
const profilePaletteCache = new Map();

function rgbArrayToHex(rgb) {
  return "#" + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
}

function matTranspose(A) {
  const rows = A.length, cols = A[0].length;
  const T = [];
  for (let j = 0; j < cols; j++) {
    T[j] = [];
    for (let i = 0; i < rows; i++) T[j][i] = A[i][j];
  }
  return T;
}

function matMultiply(A, B) {
  const m = A.length, n = B[0].length, p = B.length;
  const C = [];
  for (let i = 0; i < m; i++) {
    C[i] = [];
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < p; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
  }
  return C;
}

function matInverse(M) {
  const n = M.length;
  const aug = M.map((row, i) => {
    const r = row.slice();
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let col = 0; col < n; col++) {
    let maxRow = col, maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) return null;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }
  return aug.map(row => row.slice(n));
}

function solveAffine(src, dst) {
  const A_aug = src.map(row => [...row, 1]);
  const At = matTranspose(A_aug);
  const AtA = matMultiply(At, A_aug);
  const AtA_inv = matInverse(AtA);
  if (!AtA_inv) return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  const AtB = matMultiply(At, dst);
  return matMultiply(AtA_inv, AtB);
}

function computeLightingMatrix(reference) {
  const patches = reference.filter(p => p.rgb);
  if (patches.length < 4) return null;
  const measured = patches.map(p => (p.measured || p.rgb).map(v => v / 255));
  const trueRGB = patches.map(p => p.rgb.map(v => v / 255));
  return solveAffine(measured, trueRGB);
}

function applyAffineToRGB(rgb, matrix) {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  return [
    Math.max(0, Math.min(255, Math.round((r * matrix[0][0] + g * matrix[1][0] + b * matrix[2][0] + matrix[3][0]) * 255))),
    Math.max(0, Math.min(255, Math.round((r * matrix[0][1] + g * matrix[1][1] + b * matrix[2][1] + matrix[3][1]) * 255))),
    Math.max(0, Math.min(255, Math.round((r * matrix[0][2] + g * matrix[1][2] + b * matrix[2][2] + matrix[3][2]) * 255))),
  ];
}

function buildPaletteFromProfile(profile) {
  const cacheKey = profile.name;
  if (profilePaletteCache.has(cacheKey)) return profilePaletteCache.get(cacheKey);

  const L_inv = profile.data.matrix || computeLightingMatrix(profile.data.reference);

  const palette = profile.data.palette.map(p => {
    let colorHex;
    if (p.measured && L_inv) {
      const corrected = applyAffineToRGB(p.measured, L_inv);
      colorHex = rgbArrayToHex(corrected);
    } else {
      colorHex = p.deviceColor;
    }
    return {
      name: p.id,
      color: colorHex,
      deviceColor: p.deviceColor,
    };
  });

  profilePaletteCache.set(cacheKey, palette);
  return palette;
}

function computeProfileAwareDitherOptions(profile, sourceCanvas) {
  const opts = {
    ditheringType: "errorDiffusion",
    errorDiffusionMatrix: "floydSteinberg",
    serpentine: true,
  };

  const paletteMeasured = profile.data.target;
  if (!paletteMeasured || paletteMeasured.length === 0) return opts;

  const whiteEntry = paletteMeasured.find(p => p.id === "white");
  const blackEntry = paletteMeasured.find(p => p.id === "black");

  let displayWhiteLum = 1.0;
  let displayBlackLum = 0.0;
  if (whiteEntry && whiteEntry.measured) {
    displayWhiteLum = (whiteEntry.measured[0] * 0.299 + whiteEntry.measured[1] * 0.587 + whiteEntry.measured[2] * 0.114) / 255;
  }
  if (blackEntry && blackEntry.measured) {
    displayBlackLum = (blackEntry.measured[0] * 0.299 + blackEntry.measured[1] * 0.587 + blackEntry.measured[2] * 0.114) / 255;
  }

  opts.dynamicRangeCompression = {
    mode: "percentile",
    strength: 0.85,
    lowPercentile: 0.003,
    highPercentile: 0.999,
  };

  opts.colorMatching = "rgb";

  const highlightCompressValue = -1.5 - (0.65 - displayWhiteLum) * 5;
  const clampedHC = Math.max(-3.0, Math.min(-0.5, highlightCompressValue));

  const redEntry = paletteMeasured.find(p => p.id === "red");
  const greenEntry = paletteMeasured.find(p => p.id === "green");
  const blueEntry = paletteMeasured.find(p => p.id === "blue");

  let avgSat = 1.0;
  if (redEntry && redEntry.measured && greenEntry && greenEntry.measured && blueEntry && blueEntry.measured) {
    const getSat = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / 255.0;
    avgSat = (getSat(redEntry.measured) + getSat(greenEntry.measured) + getSat(blueEntry.measured)) / 3.0;
  }

  const satBoost = Math.max(0, Math.min(0.6, (0.7 - avgSat) * 0.35));

  let exposureVal = 0.05;
  let contrastVal = 0.10;
  let imgSatBoost = 0;

  if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const data = imgData.data;

    let totalLum = 0;
    let totalSat = 0;
    let lums = [];

    // Sample pixels for performance (every 16th pixel)
    const step = 4 * 16;
    let count = 0;
    for (let i = 0; i < data.length; i += step) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = max === 0 ? 0 : (max - min) / max;

      totalLum += lum;
      totalSat += sat;
      lums.push(lum);
      count++;
    }

    if (count > 0) {
      const avgLum = totalLum / count;
      const avgImageSat = totalSat / count;

      lums.sort((a, b) => a - b);
      const p5 = lums[Math.floor(lums.length * 0.05)];
      const p95 = lums[Math.floor(lums.length * 0.95)];
      const dynamicRange = p95 - p5;

      // 1. Exposure: Push image luminance to slightly brighter than middle grey (0.55) to compensate for E-paper darkness
      const targetLum = 0.55;
      exposureVal = (targetLum - avgLum) * 0.5; // Apply 50% of the diff to avoid over-correction
      exposureVal = Math.max(-0.2, Math.min(0.4, exposureVal));

      // 2. Contrast: Boost contrast if dynamic range is low
      const targetRange = 0.8;
      if (dynamicRange < targetRange) {
        contrastVal = (targetRange - dynamicRange) * 0.6;
      } else {
        contrastVal = 0.05; // Base contrast for E-Paper
      }
      contrastVal = Math.max(0, Math.min(0.5, contrastVal));

      // 3. Saturation: If image is inherently dull, boost it more
      const targetImgSat = 0.4;
      if (avgImageSat < targetImgSat) {
        imgSatBoost = (targetImgSat - avgImageSat) * 0.5;
      }
    }
  }

  opts.toneMapping = {
    mode: "scurve",
    strength: 0.9,
    shadowBoost: 0,
    highlightCompress: clampedHC,
    midpoint: 0.5,
    exposure: exposureVal,
    contrast: contrastVal,
    saturation: Math.max(0.15, satBoost) + imgSatBoost,
  };

  return opts;
}
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
const SETTINGS_URL_UUID = "1000000b-0000-0000-0000-000000000001"; // READ/WRITE

const DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
const WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
const WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";
const WIFI_INFO_UUID = "4c578d4d-7b0e-11ed-a1eb-0242ac120002";
const SYSTEM_INFO_UUID = "60000001-7b0e-11ed-a1eb-0242ac120002";
// ACHTUNG: Wird dynamisch angepasst, basierend auf dem Bluetooth Namen
let EPD_WIDTH = 800;
let EPD_HEIGHT = 480;

let bleDevice = null;
let settingsService = null;
let wifiService = null;
let processedImageBuffer = null;
let reconnectInterval = null;
let manualDisconnect = false;
let reconnectAttempts = 0;

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
const settingSettingsUrl = document.getElementById("settingSettingsUrl");
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

const errorDiffusionMatrix = document.getElementById("errorDiffusionMatrix");
const serpentine = document.getElementById("serpentine");

const paletteSelect = document.getElementById("paletteSelect");
const paletteEditor = document.getElementById("paletteEditor");
const processingBrightness = document.getElementById("processingBrightness");
const processingContrast = document.getElementById("processingContrast");
const processingSaturation = document.getElementById("processingSaturation");
const btnAutoDither = document.getElementById("btnAutoDither");
const btnRotate = document.getElementById("btnRotate");

// Live Updates
let updateTimeout = null;
let lastUpdate = 0;
function throttledUpdatePreview() {
  if (!originalImage) return;
  const now = Date.now();
  if (now - lastUpdate >= 500) {
    updatePreviewAndBuffer();
    lastUpdate = now;
  } else {
    clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => {
      if (originalImage) updatePreviewAndBuffer();
      lastUpdate = Date.now();
    }, 500 - (now - lastUpdate));
  }
}

[errorDiffusionMatrix, paletteSelect, serpentine].forEach(el => {
  if (el) el.addEventListener("change", () => { if (originalImage) updatePreviewAndBuffer(); });
});
[processingBrightness, processingContrast, processingSaturation].forEach(el => {
  if (el) el.addEventListener("input", throttledUpdatePreview);
});

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
    setStatus(`Verbinde zu GATT Server... ${reconnectAttempts > 0 ? `(Versuch ${reconnectAttempts})` : ''}`, "text-blue-500");
    const server = await bleDevice.gatt.connect();
    reconnectAttempts = 0; // Reset on success

    setStatus("Lade Services...", "text-blue-500");
    settingsService = await server.getPrimaryService(SETTINGS_SERVICE_UUID);
    wifiService = await server.getPrimaryService(WIFI_SERVICE_UUID);

    // Initialen Device Sync starten
    try {
      setStatus("Lese Geräteeinstellungen...", "text-blue-500");
      // WLAN wird asynchron am Ende geladen

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

      // Lese HTTP Auth Settings & Sonstiges
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

        const settingsUrlChar = await settingsService.getCharacteristic(SETTINGS_URL_UUID);
        const settingsUrlData = await settingsUrlChar.readValue();
        settingSettingsUrl.value = new TextDecoder().decode(settingsUrlData).replace(/\0/g, "");
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
          if (typeof infoIp !== 'undefined' && infoIp) infoIp.innerText = info.ip;
          if (typeof infoRssi !== 'undefined' && infoRssi) infoRssi.innerText = info.rssi + " dBm";
          if (typeof infoSsid !== 'undefined' && infoSsid) infoSsid.innerText = info.ssid || "Netzwerk";
          if (typeof infoQuality !== 'undefined' && infoQuality) {
            if (info.rssi > -60) infoQuality.innerText = "Ausgezeichnet";
            else if (info.rssi > -75) infoQuality.innerText = "Gut";
            else infoQuality.innerText = "Schwach";
          }
        }
      } catch (e) {
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
            } catch (err) { }
          }
        });
        await sysInfoChar.startNotifications();
      } catch (e) {
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

    // Lade verfügbare WLANs und SSID asynchron herunter
    setTimeout(async () => {
      try {
        const ssidChar = await wifiService.getCharacteristic(WIFI_SSID_UUID);
        const ssidVal = await ssidChar.readValue();
        const ssidStr = new TextDecoder().decode(ssidVal).replace(/\0/g, "");
        if (ssidStr !== "" && ssidStr !== "wifi-ssid") {
          wifiSsid.value = ssidStr;
          syncBadgeWifi.classList.remove("hidden");
        }
      } catch (e) {
        console.warn("WLAN SSID konnte nicht geladen werden:", e);
      }

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

            if (foundNetworks) {
              isWifiScanned = true;
            }
            if (btnScanWifi && btnScanWifi.innerText === "Suche...") {
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
        if (initialScanData.byteLength > 0) {
          processScanData(initialScanData);
        }
      } catch (e) {
        console.warn("WLAN Liste konnte nicht geladen werden:", e);
      }
    }, 100);

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
      reconnectAttempts++;
      if (reconnectAttempts <= 12) {
        setStatus(`Verbindungsfehler. Reconnect in 5s... (${reconnectAttempts}/12)`, "text-orange-500");
        if (reconnectInterval) clearTimeout(reconnectInterval);
        reconnectInterval = setTimeout(() => {
          connectToDevice();
        }, 5000);
      } else {
        setStatus("Verbindung endgültig verloren.", "text-red-500");
        btnConnect.classList.remove("hidden");
        btnDisconnect.classList.add("hidden");
      }
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

    if (bleDevice.name && bleDevice.name.startsWith("epd13-")) {
      EPD_WIDTH = 1200;
      EPD_HEIGHT = 1600;
      document.title = "paper L Setup";
      const headerTitle = document.querySelector("h1");
      if (headerTitle) headerTitle.innerText = "paper L Setup";
    } else {
      EPD_WIDTH = 800;
      EPD_HEIGHT = 480;
      document.title = "paper 7 Setup";
      const headerTitle = document.querySelector("h1");
      if (headerTitle) headerTitle.innerText = "E-Paper Setup";
    }
    canvas.width = EPD_WIDTH;
    canvas.height = EPD_HEIGHT;
    if (originalImage) {
      updatePreviewAndBuffer();
    }

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
        reconnectAttempts = 1;
        setStatus(`Verbindung unterbrochen. Reconnect in 5s... (${reconnectAttempts}/12)`, "text-orange-500");
        reconnectInterval = setTimeout(() => {
          connectToDevice();
        }, 5000);
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
    } catch (e) {
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
    const encoder = new TextEncoder();
    const urlValidationStatus = document.getElementById("urlValidationStatus");
    if (urlValidationStatus) {
      urlValidationStatus.classList.add("hidden");
    }

    if (settingUrl.value) {
      const urlChar = await settingsService.getCharacteristic(URL_UUID);
      await urlChar.writeValue(encoder.encode(settingUrl.value));

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
    } else {
      const urlChar = await settingsService.getCharacteristic(URL_UUID);
      await urlChar.writeValue(encoder.encode(""));
    }

    const timeoutChar = await settingsService.getCharacteristic(TIMEOUT_UUID);
    await timeoutChar.writeValue(encoder.encode(settingTimeout.value || "3600"));

    try {
      const httpAuthUserChar = await settingsService.getCharacteristic(HTTP_AUTH_USER_UUID);
      await httpAuthUserChar.writeValue(encoder.encode(settingHttpAuthUser.value));

      const httpAuthPasswordChar = await settingsService.getCharacteristic(HTTP_AUTH_PASS_UUID);
      await httpAuthPasswordChar.writeValue(encoder.encode(settingHttpAuthPassword.value));

      const motionWakeupChar = await settingsService.getCharacteristic(MOTION_WAKEUP_UUID);
      await motionWakeupChar.writeValue(encoder.encode(settingMotionWakeup.checked ? "1" : "0"));

      const chargerModeChar = await settingsService.getCharacteristic(CHARGER_MODE_UUID);
      await chargerModeChar.writeValue(encoder.encode(settingChargerMode.checked ? "1" : "0"));

      const settingsUrlChar = await settingsService.getCharacteristic(SETTINGS_URL_UUID);
      await settingsUrlChar.writeValue(encoder.encode(settingSettingsUrl.value));
    } catch (e) {
      console.warn("Alte Firmware: Erweiterte Settings werden ignoriert", e);
    }

    // Tell the firmware to save all written settings to EEPROM at once
    const cmdChar = await settingsService.getCharacteristic(UPLOAD_CMD_UUID);
    await cmdChar.writeValue(encoder.encode("SAVE_SETTINGS"));

    setStatus("Einstellungen gespeichert!", "text-green-500");
    syncBadgeSettings.classList.remove("hidden");
  } catch (error) {
    console.error(error);
    setStatus("Fehler beim Speichern der Einstellungen", "text-red-500");
  }
});

let tempJsonSettings = null;

document.getElementById("btnPreviewJson")?.addEventListener("click", async () => {
  const rawUrl = settingSettingsUrl.value;
  if (!rawUrl) {
    alert("Bitte zuerst eine JSON URL eingeben.");
    return;
  }

  // Cache-Busting: Anfügen eines Timestamps, damit Proxys/Browser nicht cachen
  const cacheBuster = "nocache=" + new Date().getTime();
  const url = rawUrl + (rawUrl.includes("?") ? "&" : "?") + cacheBuster;

  document.getElementById("btnPreviewJson").innerText = "Lade...";
  try {
    let response;
    try {
      response = await fetch(url, { cache: "no-store" });
    } catch (err) {
      console.warn("Direct fetch failed (likely CORS). Trying via Proxy 1...", err);
      try {
        // Versuch 1: corsproxy.io
        response = await fetch("https://corsproxy.io/?" + encodeURIComponent(url));
      } catch (err2) {
        console.warn("Proxy 1 failed. Trying Proxy 2...", err2);
        // Versuch 2: allorigins (get mode) -> liefert { contents: "..." }
        const proxyResp = await fetch("https://api.allorigins.win/get?url=" + encodeURIComponent(url), { cache: "no-store" });
        if (!proxyResp.ok) throw new Error("HTTP Fehler Proxy: " + proxyResp.status);
        const proxyJson = await proxyResp.json();

        tempJsonSettings = JSON.parse(proxyJson.contents);
        document.getElementById("jsonPreviewContent").innerText = JSON.stringify(tempJsonSettings, null, 2);
        document.getElementById("jsonPreviewModal").classList.remove("hidden");
        document.getElementById("btnPreviewJson").innerText = "Prüfen";
        return;
      }
    }

    if (!response.ok) throw new Error("HTTP Fehler " + response.status);
    const json = await response.json();

    tempJsonSettings = json;
    document.getElementById("jsonPreviewContent").innerText = JSON.stringify(json, null, 2);
    document.getElementById("jsonPreviewModal").classList.remove("hidden");
  } catch (e) {
    console.error(e);
    alert("Fehler beim Abrufen der JSON (CORS oder ungültige URL). Wenn die Datei lokal (z.B. NAS) liegt, stelle sicher, dass der Server CORS-Header sendet (Access-Control-Allow-Origin: *). Details: " + e.message);
  }
  document.getElementById("btnPreviewJson").innerText = "Prüfen";
});

document.getElementById("btnCloseJsonPreview")?.addEventListener("click", () => {
  document.getElementById("jsonPreviewModal").classList.add("hidden");
});
document.getElementById("btnCancelJson")?.addEventListener("click", () => {
  document.getElementById("jsonPreviewModal").classList.add("hidden");
});

document.getElementById("btnApplyJson")?.addEventListener("click", async () => {
  document.getElementById("jsonPreviewModal").classList.add("hidden");
  if (!tempJsonSettings) return;

  // Apply JSON directly into input fields
  if (tempJsonSettings.timeout !== undefined) settingTimeout.value = tempJsonSettings.timeout;
  if (tempJsonSettings.downloadUrl !== undefined) settingUrl.value = tempJsonSettings.downloadUrl;
  if (tempJsonSettings.httpAuthUser !== undefined) settingHttpAuthUser.value = tempJsonSettings.httpAuthUser;
  if (tempJsonSettings.httpAuthPassword !== undefined) settingHttpAuthPassword.value = tempJsonSettings.httpAuthPassword;
  if (tempJsonSettings.motionWakeup !== undefined) settingMotionWakeup.checked = tempJsonSettings.motionWakeup;
  if (tempJsonSettings.chargerMode !== undefined) settingChargerMode.checked = tempJsonSettings.chargerMode;

  // Auto-save via existing save button logic
  document.getElementById("btnSaveSettings").click();
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

function getClosestColorIndex(r, g, b, palette, isNewProfile = false) {
  let minDst = Infinity;
  let bestIdx = 6;
  for (const entry of palette) {
    const c = hexToRgb(isNewProfile ? entry.deviceColor : entry.color);
    const dst = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (dst < minDst) {
      minDst = dst;
      bestIdx = SPECTRA_COLOR_INDICES[entry.name] ?? 6;
    }
  }
  return bestIdx;
}

function renderDisplayPreview(sourceCanvas, profile) {
  if (!profile || !profile.data.palette.every(p => p.measured)) return;

  const hoverCanvas = document.getElementById("previewHoverCanvas");
  if (!hoverCanvas) return;

  hoverCanvas.width = sourceCanvas.width;
  hoverCanvas.height = sourceCanvas.height;

  const hCtx = hoverCanvas.getContext("2d", { willReadFrequently: true });
  const srcCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const data = imgData.data;

  const L_inv = profile.data.matrix || computeLightingMatrix(profile.data.reference);
  const colorMap = new Map();
  for (const p of profile.data.palette) {
    if (p.measured) {
      const corrected = L_inv ? applyAffineToRGB(p.measured, L_inv) : p.measured;
      colorMap.set(p.deviceColor.toUpperCase(), corrected);
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let minDist = Infinity;
    let bestColor = null;
    for (const [devHex, corrected] of colorMap) {
      const ec = hexToRgb(devHex);
      const dist = (r - ec.r) ** 2 + (g - ec.g) ** 2 + (b - ec.b) ** 2;
      if (dist < minDist) {
        minDist = dist;
        bestColor = corrected;
      }
    }
    if (bestColor) {
      data[i] = bestColor[0];
      data[i + 1] = bestColor[1];
      data[i + 2] = bestColor[2];
    }
  }

  hCtx.putImageData(imgData, 0, 0);
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
  let activePalette;
  if (paletteSelect && paletteSelect.value === "new") {
    activePalette = buildPaletteFromProfile({ name: "new.json", data: newProfile });
  } else {
    activePalette = customPalette || getBasePalette(paletteSelect ? paletteSelect.value : "spectra6Custom");
  }

  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
  const colorMode = "rgb";

  const brightnessInt = parseInt(processingBrightness.value, 10);
  const contrastInt = parseInt(processingContrast.value, 10);
  const saturationInt = parseInt(processingSaturation.value, 10);

  const toneMappingMode = brightnessInt !== 0 || contrastInt !== 0 || saturationInt !== 0 ? "contrast" : "off";

  const ditherOptions = {
    ...options, // Damit btnAutoDither das überschreiben kann
    ditheringType: "errorDiffusion",
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

    const isNew = (paletteSelect && paletteSelect.value === "new");
    if (isNew) {
      replaceColors(canvas, canvas, activePalette);
    }

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
        let colorIndex = getClosestColorIndex(r, g, b, activePalette, isNew);

        let outIdx = Math.floor((y * EPD_WIDTH + x) / 2);
        if (x % 2 === 0) processedImageBuffer[outIdx] = colorIndex << 4;
        else processedImageBuffer[outIdx] |= colorIndex;
      }
    }

    if (isNew) {
      renderDisplayPreview(canvas, { name: "new.json", data: newProfile });
      const hoverCanvas = document.getElementById("previewHoverCanvas");
      if (hoverCanvas) hoverCanvas.style.opacity = "1";
    } else {
      const hoverCanvas = document.getElementById("previewHoverCanvas");
      if (hoverCanvas) {
        hoverCanvas.getContext("2d").clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
        hoverCanvas.style.opacity = "0";
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
    // Automatisches rotieren, wenn das Bild im Hochformat ist und das Display Querformat, oder umgekehrt
    if ((originalImage.height > originalImage.width && EPD_WIDTH > EPD_HEIGHT) ||
        (originalImage.width > originalImage.height && EPD_HEIGHT > EPD_WIDTH)) {
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



btnAutoDither.addEventListener("click", () => {
  if (!originalImage) return;

  drawOriginalToCanvas(ctx);

  if (paletteSelect && paletteSelect.value === "new") {
    const resolvedOptions = computeProfileAwareDitherOptions({ name: "new.json", data: newProfile }, canvas);

    // UI nach Vorschlag updaten
    errorDiffusionMatrix.value = resolvedOptions.errorDiffusionMatrix || "floydSteinberg";
    serpentine.checked = resolvedOptions.serpentine ?? true;

    if (resolvedOptions.toneMapping) {
      processingBrightness.value = Math.round((resolvedOptions.toneMapping.exposure ?? 0) * 100) || 0;
      processingContrast.value = Math.round((resolvedOptions.toneMapping.contrast ?? 0) * 100) || 0;
      processingSaturation.value = Math.round((resolvedOptions.toneMapping.saturation ?? 0) * 100) || 0;
    } else {
      processingBrightness.value = 0;
      processingContrast.value = 0;
      processingSaturation.value = 0;
    }

    setStatus(`Automatisches Setting gefunden: Custom Profile (new.json)`, "text-blue-500");
    updatePreviewAndBuffer(resolvedOptions);
    return;
  }

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
    errorDiffusionMatrix.value = resolvedOptions.errorDiffusionMatrix || "floydSteinberg";
    serpentine.checked = resolvedOptions.serpentine ?? true;

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
  if (originalImage) updatePreviewAndBuffer();
});


renderPaletteEditor();

function renderPaletteEditor() {
  if (!paletteEditor) return;

  if (paletteSelect.value !== "spectra6Custom") {
    paletteEditor.style.display = "none";
    return;
  } else {
    paletteEditor.style.display = "flex";
  }

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
      throttledUpdatePreview();
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

// --- Hover preview logic ---
const previewContainer = document.getElementById("previewContainer");
const previewHoverCanvas = document.getElementById("previewHoverCanvas");
const previewHoverLabel = document.getElementById("previewHoverLabel");

if (previewContainer) {
  previewContainer.addEventListener("mouseenter", () => {
    if (paletteSelect && paletteSelect.value === "new" && previewHoverCanvas && previewHoverCanvas.width > 0) {
      previewHoverCanvas.style.opacity = "0";
      if (previewHoverLabel) previewHoverLabel.style.opacity = "1";
    }
  });
  previewContainer.addEventListener("mouseleave", () => {
    if (paletteSelect && paletteSelect.value === "new" && previewHoverCanvas) {
      previewHoverCanvas.style.opacity = "1";
    }
    if (previewHoverLabel) previewHoverLabel.style.opacity = "0";
  });
}

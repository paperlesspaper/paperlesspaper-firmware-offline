import { GeneratePicture } from "./GeneratePicture.js";
import { DeviceBleInterface } from "./DeviceBleInterface.js";
import { ESPLoader, Transport } from "esptool-js";

const appConfig = window.__APP_CONFIG__ || {};
const runtimeConfig = {
  proxy1Base: appConfig.proxy1Base || "https://corsproxy.io/?",
  proxy2Base: appConfig.proxy2Base || "https://api.allorigins.win/raw?url=",
  factoryPreJsonBaseUrl: appConfig.factoryPreJsonBaseUrl || window.location.origin,
  factoryPreBinBaseUrl: appConfig.factoryPreBinBaseUrl || window.location.origin,
  offlineFirmwareBaseUrl: appConfig.offlineFirmwareBaseUrl || window.location.origin,
};

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

const generatePicture = new GeneratePicture();
const bleInterface = new DeviceBleInterface();

async function fetchWithProxy(url, options = {}) {
  try {
    const res = await fetch(url, options);
    return res;
  } catch (err) {
    console.warn("Direct fetch failed (likely CORS). Trying Proxy 1 (corsproxy.io)...", err);
  }

  try {
    const res = await fetch(runtimeConfig.proxy1Base + encodeURIComponent(url), options);
    if (res.ok) return res;
    console.warn(`Proxy 1 returned ${res.status}. Trying Proxy 2 (allorigins)...`);
  } catch (err2) {
    console.warn("Proxy 1 fetch failed. Trying Proxy 2 (allorigins)...", err2);
  }

  return await fetch(runtimeConfig.proxy2Base + encodeURIComponent(url), options);
}

let EPD_WIDTH = 800;
let EPD_HEIGHT = 480;

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
const settingAutoRotation = document.getElementById("settingAutoRotation");
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
const btnUpdateOfflineFw = document.getElementById("btnUpdateOfflineFw");
const otaDialog = document.getElementById("otaDialog");
const otaDeviceSelect = document.getElementById("otaDeviceSelect");
const otaVersion = document.getElementById("otaVersion");
const btnCancelOta = document.getElementById("btnCancelOta");
const btnConfirmOta = document.getElementById("btnConfirmOta");
const otaOfflineDialog = document.getElementById("otaOfflineDialog");
const offlineOtaDeviceSelect = document.getElementById("offlineOtaDeviceSelect");
const btnCancelOfflineOta = document.getElementById("btnCancelOfflineOta");
const btnConfirmOfflineOta = document.getElementById("btnConfirmOfflineOta");
const fwInput = document.getElementById("fwInput");
const btnSelectFw = document.getElementById("btnSelectFw");
const btnSelectSpiffs = document.getElementById("btnSelectSpiffs");
const spiffsInput = document.getElementById("spiffsInput");
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
const displaySizeSelect = document.getElementById("displaySizeSelect");

if (displaySizeSelect) {
  displaySizeSelect.addEventListener("change", (e) => {
    if (e.target.value === "13") {
      EPD_WIDTH = 1200;
      EPD_HEIGHT = 1600;
    } else {
      EPD_WIDTH = 800;
      EPD_HEIGHT = 480;
    }
    canvas.width = EPD_WIDTH;
    canvas.height = EPD_HEIGHT;
    if (generatePicture.getOriginalImage()) updatePreview();
  });
}

let updateTimeout = null;
let lastUpdate = 0;
function throttledUpdatePreview() {
  if (!generatePicture.getOriginalImage()) return;
  const now = Date.now();
  if (now - lastUpdate >= 500) {
    updatePreview();
    lastUpdate = now;
  } else {
    clearTimeout(updateTimeout);
    updateTimeout = setTimeout(
      () => {
        if (generatePicture.getOriginalImage()) updatePreview();
        lastUpdate = Date.now();
      },
      500 - (now - lastUpdate),
    );
  }
}
[errorDiffusionMatrix, paletteSelect, serpentine].forEach((el) => {
  if (el)
    el.addEventListener("change", () => {
      if (generatePicture.getOriginalImage()) updatePreview();
    });
});
[processingBrightness, processingContrast, processingSaturation].forEach((el) => {
  if (el) el.addEventListener("input", throttledUpdatePreview);
});

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

function setStatus(text, colorClass = "text-gray-500") {
  if (statusText) {
    statusText.className = `mt-3 text-sm font-semibold ${colorClass}`;
    statusText.innerText = text;
  }
  const statusFooter = document.getElementById("status");
  if (statusFooter) {
    statusFooter.className = `fixed bottom-0 left-0 right-0 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] py-3 px-4 text-center font-medium text-sm transition-colors z-50 ${colorClass}`;
    statusFooter.innerText = text;
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

bleInterface.onStatusChange = (text, colorClass) => {
  setStatus(text, colorClass);
};

bleInterface.onConnected = (isPaperL) => {
  if (isPaperL) {
    EPD_WIDTH = 1200;
    EPD_HEIGHT = 1600;
    document.title = "paper L Setup";
    const headerTitle = document.querySelector("h1");
    if (headerTitle) headerTitle.innerText = "paper L Setup";
    if (displaySizeSelect) displaySizeSelect.value = "13";
  } else {
    EPD_WIDTH = 800;
    EPD_HEIGHT = 480;
    document.title = "paper 7 Setup";
    const headerTitle = document.querySelector("h1");
    if (headerTitle) headerTitle.innerText = "E-Paper Setup";
    if (displaySizeSelect) displaySizeSelect.value = "7";
  }
  canvas.width = EPD_WIDTH;
  canvas.height = EPD_HEIGHT;
  if (generatePicture.getOriginalImage()) {
    updatePreview();
  }

  btnConnect.classList.add("hidden");
  btnDisconnect.classList.remove("hidden");

  // controlsOta is always visible in viewOta

  if (btnUploadImage) {
    btnUploadImage.disabled = false;
    btnUploadImage.classList.remove("bg-gray-500", "hover:bg-gray-600", "bg-gray-400");
    btnUploadImage.classList.add("bg-green-600", "hover:bg-green-700");
    btnUploadImage.innerText = "SENDEN";
  }

  controls.classList.remove("hidden");
  setTimeout(() => controls.classList.remove("opacity-0"), 100);
};

bleInterface.onDisconnected = () => {
  controls.classList.add("hidden", "opacity-0");
  // controlsOta is always visible in viewOta

  const statusBar = document.getElementById("systemStatusBar");
  if (statusBar) {
    statusBar.classList.add("opacity-0", "scale-95");
    setTimeout(() => statusBar.classList.add("hidden"), 500);
  }

  if (btnUploadImage) {
    btnUploadImage.disabled = true;
    btnUploadImage.classList.remove("bg-green-600", "hover:bg-green-700", "bg-green-500");
    btnUploadImage.classList.add("bg-gray-500", "hover:bg-gray-600");
    btnUploadImage.innerText = "SENDEN";
  }

  wifiList.innerHTML = "";

  btnConnect.classList.remove("hidden");
  btnDisconnect.classList.add("hidden");
};

bleInterface.onWifiStatusChange = (isConnected) => {
  updateWifiStatusUI(isConnected);
};

bleInterface.onWifiInfoChange = (info) => {
  if (info.ip) {
    if (typeof infoIp !== "undefined" && infoIp) infoIp.innerText = info.ip;
    if (typeof infoRssi !== "undefined" && infoRssi) infoRssi.innerText = info.rssi + " dBm";
    if (typeof infoSsid !== "undefined" && infoSsid) infoSsid.innerText = info.ssid || "Netzwerk";
    if (typeof infoQuality !== "undefined" && infoQuality) {
      if (info.rssi > -60) infoQuality.innerText = "Ausgezeichnet";
      else if (info.rssi > -75) infoQuality.innerText = "Gut";
      else infoQuality.innerText = "Schwach";
    }
  }
};

bleInterface.onWifiScanResult = (networks) => {
  wifiList.innerHTML = "";
  let foundNetworks = false;
  networks.forEach((net) => {
    const option = document.createElement("option");
    option.value = net.ssid;
    if (net.rssi) {
      option.text = `${net.ssid} (Signal: ${net.rssi} dBm)`;
    }
    wifiList.appendChild(option);
    foundNetworks = true;
  });

  if (btnScanWifi && btnScanWifi.innerText === "Suche...") {
    btnScanWifi.innerText = "Scan";
    btnScanWifi.disabled = false;
    btnScanWifi.classList.remove("opacity-50", "cursor-wait");
  }
};

bleInterface.onSystemStatusChange = (info) => {
  const statusBar = document.getElementById("systemStatusBar");
  const voltageEl = document.getElementById("systemVoltage");
  const chargerEl = document.getElementById("systemChargerStatus");
  const chargerIconBg = document.getElementById("chargerIconBg");
  const chargerIcon = document.getElementById("chargerIcon");
  const batteryIconBg = document.getElementById("batteryIconBg");
  const batteryIcon = document.getElementById("batteryIcon");

  if (!statusBar) return;

  statusBar.classList.remove("hidden");
  setTimeout(() => statusBar.classList.remove("scale-95", "opacity-0"), 50);

  const hasVoltage = typeof info.voltage === "number" && info.voltage > 500;
  const v = hasVoltage ? (info.voltage / 1000).toFixed(2) : null;

  if (hasVoltage) {
    if (info.charging) {
      voltageEl.innerText = `${v} V (Lädt)`;
      batteryIconBg.setAttribute("class", "bg-green-100 p-2 rounded-full");
      batteryIcon.setAttribute("class", "w-5 h-5 text-green-600");
    } else if (info.voltage > 3300) {
      voltageEl.innerText = `${v} V`;
      batteryIconBg.setAttribute("class", "bg-green-100 p-2 rounded-full");
      batteryIcon.setAttribute("class", "w-5 h-5 text-green-600");
    } else if (info.voltage > 2800) {
      voltageEl.innerText = `${v} V`;
      batteryIconBg.setAttribute("class", "bg-yellow-100 p-2 rounded-full");
      batteryIcon.setAttribute("class", "w-5 h-5 text-yellow-600");
    } else {
      voltageEl.innerText = `${v} V (Schwach)`;
      batteryIconBg.setAttribute("class", "bg-red-100 p-2 rounded-full");
      batteryIcon.setAttribute("class", "w-5 h-5 text-red-600");
    }
  } else {
    voltageEl.innerText = "Keine Batterie";
    batteryIconBg.setAttribute("class", "bg-red-100 p-2 rounded-full");
    batteryIcon.setAttribute("class", "w-5 h-5 text-red-600");
  }

  if (info.usb) {
    if (info.charging) {
      chargerEl.innerText = hasVoltage ? `Verbunden (Lädt - ${v} V)` : "Verbunden (Lädt)";
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

bleInterface.onSettingsLoaded = (settings) => {
  if (settings.url !== undefined) {
    settingUrl.value = settings.url;
    syncBadgeSettings.classList.remove("hidden");
  }
  if (settings.timeout !== undefined) {
    settingTimeout.value = settings.timeout;
    syncBadgeSettings.classList.remove("hidden");
  }
  if (settings.httpAuthUser !== undefined) settingHttpAuthUser.value = settings.httpAuthUser;
  if (settings.httpAuthPassword !== undefined) settingHttpAuthPassword.value = settings.httpAuthPassword;
  if (settings.motionWakeup !== undefined) settingMotionWakeup.checked = settings.motionWakeup;
  if (settings.chargerMode !== undefined) settingChargerMode.checked = settings.chargerMode;
  if (settings.autoRotation !== undefined) settingAutoRotation.checked = settings.autoRotation;
  if (settings.settingsUrl !== undefined) settingSettingsUrl.value = settings.settingsUrl;
  if (settings.wifiSsid !== undefined) {
    wifiSsid.value = settings.wifiSsid;
    syncBadgeWifi.classList.remove("hidden");
  }
};

bleInterface.onUploadProgress = (type, percent) => {
  if (type === "image") {
    progressBar.style.width = percent + "%";
  } else {
    fwProgressBar.style.width = percent + "%";
  }
};

btnConnect.addEventListener("click", async () => {
  await bleInterface.connect();
});

btnDisconnect.addEventListener("click", async () => {
  await bleInterface.disconnect();
});

btnScanWifi.addEventListener("click", async () => {
  btnScanWifi.innerText = "Suche...";
  btnScanWifi.disabled = true;
  btnScanWifi.classList.add("opacity-50", "cursor-wait");
  try {
    await bleInterface.scanWifi();
  } catch (e) {
    btnScanWifi.innerText = "Scan";
    btnScanWifi.disabled = false;
    btnScanWifi.classList.remove("opacity-50", "cursor-wait");
  }
});

btnSaveWifi.addEventListener("click", async () => {
  const originalText = btnSaveWifi.innerText;
  btnSaveWifi.innerText = "Verbinde...";
  btnSaveWifi.disabled = true;
  btnSaveWifi.classList.add("opacity-50", "cursor-wait");

  await bleInterface.saveWifi(wifiSsid.value, wifiPass.value);

  btnSaveWifi.innerText = originalText;
  btnSaveWifi.disabled = false;
  btnSaveWifi.classList.remove("opacity-50", "cursor-wait");
});

btnSaveSettings.addEventListener("click", async () => {
  const urlValidationStatus = document.getElementById("urlValidationStatus");
  if (urlValidationStatus) {
    urlValidationStatus.classList.add("hidden");
  }

  if (settingUrl.value && urlValidationStatus) {
    urlValidationStatus.classList.remove("hidden");
    urlValidationStatus.className = "text-sm font-medium mb-4 text-purple-500";
    urlValidationStatus.innerText = "Prüfe URL...";

    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
        img.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Invalid"));
        };
        img.src = settingUrl.value;
      });
      urlValidationStatus.className = "text-sm font-medium mb-4 text-green-500";
      urlValidationStatus.innerText = "✓ URL ist erreichbar und gültig.";
    } catch (err) {
      urlValidationStatus.className = "text-sm font-medium mb-4 text-orange-500";
      urlValidationStatus.innerText = "⚠ URL konnte nicht als Bild geladen werden (evtl. ungültig oder offline). Wird dennoch gespeichert.";
    }
  }

  const settings = {
    url: settingUrl.value,
    timeout: settingTimeout.value,
    httpAuthUser: settingHttpAuthUser.value,
    httpAuthPassword: settingHttpAuthPassword.value,
    motionWakeup: settingMotionWakeup.checked,
    chargerMode: settingChargerMode.checked,
    autoRotation: settingAutoRotation.checked,
    settingsUrl: settingSettingsUrl.value,
  };

  const success = await bleInterface.saveSettings(settings);
  if (success) {
    syncBadgeSettings.classList.remove("hidden");
  }
});

let tempJsonSettings = null;

document.getElementById("btnPreviewJson")?.addEventListener("click", async () => {
  const rawUrl = settingSettingsUrl.value;
  if (!rawUrl) {
    alert("Bitte zuerst eine JSON URL eingeben.");
    return;
  }

  const cacheBuster = "nocache=" + new Date().getTime();
  const url = rawUrl + (rawUrl.includes("?") ? "&" : "?") + cacheBuster;

  document.getElementById("btnPreviewJson").innerText = "Lade...";
  try {
    const response = await fetchWithProxy(url, { cache: "no-store" });
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

  if (tempJsonSettings.timeout !== undefined) settingTimeout.value = tempJsonSettings.timeout;
  if (tempJsonSettings.downloadUrl !== undefined) settingUrl.value = tempJsonSettings.downloadUrl;
  if (tempJsonSettings.httpAuthUser !== undefined) settingHttpAuthUser.value = tempJsonSettings.httpAuthUser;
  if (tempJsonSettings.httpAuthPassword !== undefined) settingHttpAuthPassword.value = tempJsonSettings.httpAuthPassword;
  if (tempJsonSettings.motionWakeup !== undefined) settingMotionWakeup.checked = tempJsonSettings.motionWakeup;
  if (tempJsonSettings.chargerMode !== undefined) settingChargerMode.checked = tempJsonSettings.chargerMode;
  if (tempJsonSettings.autoRotation !== undefined) settingAutoRotation.checked = tempJsonSettings.autoRotation;

  document.getElementById("btnSaveSettings").click();
});

btnFactoryReset.addEventListener("click", async () => {
  if (!confirm("Möchtest du das Gerät wirklich auf Werkseinstellungen zurücksetzen? Alle Einstellungen, WLAN-Zugangsdaten und gespeicherte Bilder werden gelöscht.")) {
    return;
  }
  await bleInterface.factoryReset();
});

settingMotionWakeup.addEventListener("change", async (e) => {
  settingMotionWakeup.disabled = true;
  await bleInterface.directSaveSetting("motionWakeup", settingMotionWakeup.checked);
  settingMotionWakeup.disabled = false;
});

settingChargerMode.addEventListener("change", async (e) => {
  settingChargerMode.disabled = true;
  await bleInterface.directSaveSetting("chargerMode", settingChargerMode.checked);
  settingChargerMode.disabled = false;
});

settingAutoRotation.addEventListener("change", async (e) => {
  settingAutoRotation.disabled = true;
  await bleInterface.directSaveSetting("autoRotation", settingAutoRotation.checked);
  settingAutoRotation.disabled = false;
});

let activeAutoOptions = null;

async function updatePreview(options = null) {
  if (!generatePicture.getOriginalImage()) return;

  if (options && Object.keys(options).length > 0) {
    activeAutoOptions = options;
  }

  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
  const brightnessInt = parseInt(processingBrightness.value, 10) || 0;
  const contrastInt = parseInt(processingContrast.value, 10) || 0;
  const saturationInt = parseInt(processingSaturation.value, 10) || 0;

  const currentOptions = activeAutoOptions ? { ...activeAutoOptions } : {};
  currentOptions.errorDiffusionMatrix = matrix;
  currentOptions.serpentine = isSerpentine;

  const hoverCanvas = document.getElementById("previewHoverCanvas");

  setStatus("Erzeuge Dithering Vorschau...", "text-yellow-600");

  try {
    generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
    await generatePicture.processPreview(canvas, hoverCanvas, paletteSelect ? paletteSelect.value : "spectra6Custom", matrix, isSerpentine, brightnessInt, contrastInt, saturationInt, currentOptions);

    btnUploadImage.disabled = false;
    btnDownloadBin.disabled = false;
    setStatus("Bildvorschau optimiert und bereit zum Upload!", "text-green-600");
  } catch (e) {
    setStatus("Fehler beim Dithering: " + e.message, "text-red-500");
    console.error(e);
  }
}

async function generateFullBuffer(options = null) {
  if (!generatePicture.getOriginalImage()) return;

  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
  const brightnessInt = parseInt(processingBrightness.value, 10) || 0;
  const contrastInt = parseInt(processingContrast.value, 10) || 0;
  const saturationInt = parseInt(processingSaturation.value, 10) || 0;

  const currentOptions = options && Object.keys(options).length > 0 ? options : (activeAutoOptions ? { ...activeAutoOptions } : {});
  currentOptions.errorDiffusionMatrix = matrix;
  currentOptions.serpentine = isSerpentine;

  generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
  await generatePicture.generateFullBuffer(paletteSelect ? paletteSelect.value : "spectra6Custom", matrix, isSerpentine, brightnessInt, contrastInt, saturationInt, currentOptions);
}

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  activeAutoOptions = null;

  const img = new Image();
  img.onload = () => {
    generatePicture.setOriginalImage(img);
    if ((img.height > img.width && EPD_WIDTH > EPD_HEIGHT) || (img.width > img.height && EPD_HEIGHT > EPD_WIDTH)) {
      generatePicture.setImageRotation(270);
    } else {
      generatePicture.setImageRotation(0);
    }
    updatePreview();
  };
  img.src = URL.createObjectURL(file);
});

if (btnRotate) {
  btnRotate.addEventListener("click", () => {
    if (generatePicture.getOriginalImage()) {
      generatePicture.setImageRotation((generatePicture.getImageRotation() + 90) % 360);
      updatePreview();
    }
  });
}

btnAutoDither.addEventListener("click", () => {
  if (!generatePicture.getOriginalImage()) return;

  generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
  const result = generatePicture.autoOptimise(canvas, paletteSelect ? paletteSelect.value : "spectra6Custom");

  if (result) {
    const resolvedOptions = result.resolvedOptions || result;
    const suggestion = result.suggestion;

    resolvedOptions.errorDiffusionMatrix = errorDiffusionMatrix.value;
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

    activeAutoOptions = resolvedOptions;

    if (paletteSelect && paletteSelect.value === "new") {
      setStatus("Automatisches Setting gefunden: Custom Color Profile", "text-blue-500");
    } else {
      setStatus(`Automatisches Setting gefunden: ${suggestion.classification.style}, Typ: ${suggestion.imageKind}`, "text-blue-500");
    }

    updatePreview(activeAutoOptions);
  }
});

btnDownloadBin.addEventListener("click", async () => {
  if (!generatePicture.getOriginalImage()) return;

  try {
    setStatus("Generiere volle Auflösung für Download...", "text-blue-500");
    await generateFullBuffer(generatePicture.getCurrentDitherOptions());
  } catch (err) {
    setStatus("Fehler beim Generieren: " + err.message, "text-red-500");
    return;
  }

  const headerSize = 118;
  const bufferSize = generatePicture.getProcessedImageBuffer().length;
  const fileSize = headerSize + bufferSize;
  const bmpBuffer = new ArrayBuffer(fileSize);
  const view = new DataView(bmpBuffer);
  const bytes = new Uint8Array(bmpBuffer);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, headerSize, true);

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

  bytes.set(generatePicture.getProcessedImageBuffer(), headerSize);

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

btnUploadImage.addEventListener("click", async () => {
  if (!generatePicture.getOriginalImage()) return;

  try {
    btnUploadImage.disabled = true;
    setStatus("Generiere volle Auflösung für Upload...", "text-blue-500");
    await generateFullBuffer(generatePicture.getCurrentDitherOptions());
  } catch (err) {
    setStatus("Fehler beim Generieren: " + err.message, "text-red-500");
    btnUploadImage.disabled = false;
    return;
  }

  try {
    btnUploadImage.disabled = true;
    progressContainer.classList.remove("hidden");
    progressBar.style.width = "0%";

    await bleInterface.uploadImage(generatePicture.getProcessedImageBuffer());
  } catch (error) {
    progressBar.classList.add("bg-red-500");
  } finally {
    btnUploadImage.disabled = false;
    btnDownloadBin.disabled = false;
  }
});

const btnOtaBle = document.getElementById("btnOtaBle");
const btnOtaSerial = document.getElementById("btnOtaSerial");
const serialModeNotice = document.getElementById("serialModeNotice");
const serialUnsupportedNotice = document.getElementById("serialUnsupportedNotice");

const serialMonitorContainer = document.getElementById("serialMonitorContainer");
const btnToggleSerialMonitor = document.getElementById("btnToggleSerialMonitor");
const btnClearSerialLog = document.getElementById("btnClearSerialLog");
const serialLogBox = document.getElementById("serialLogBox");
const serialLogOutput = document.getElementById("serialLogOutput");

let otaMethod = "ble";

if (btnOtaBle && btnOtaSerial) {
  btnOtaBle.addEventListener("click", () => {
    otaMethod = "ble";
    btnOtaBle.className = "flex-1 py-1.5 rounded-lg font-semibold bg-white text-gray-700 shadow-sm focus:outline-none transition-all";
    btnOtaSerial.className = "flex-1 py-1.5 rounded-lg font-semibold text-gray-500 hover:text-gray-700 focus:outline-none transition-all";
    if (serialModeNotice) serialModeNotice.classList.add("hidden");
    if (serialUnsupportedNotice) serialUnsupportedNotice.classList.add("hidden");
    if (btnSelectSpiffs) btnSelectSpiffs.classList.add("hidden");
    if (serialMonitorContainer) serialMonitorContainer.classList.add("hidden");
  });

  btnOtaSerial.addEventListener("click", () => {
    otaMethod = "serial";
    btnOtaBle.className = "flex-1 py-1.5 rounded-lg font-semibold text-gray-500 hover:text-gray-700 focus:outline-none transition-all";
    btnOtaSerial.className = "flex-1 py-1.5 rounded-lg font-semibold bg-white text-gray-700 shadow-sm focus:outline-none transition-all";
    if (btnSelectSpiffs) btnSelectSpiffs.classList.remove("hidden");
    if (serialMonitorContainer) serialMonitorContainer.classList.remove("hidden");
    
    if (!("serial" in navigator)) {
      if (serialUnsupportedNotice) serialUnsupportedNotice.classList.remove("hidden");
      if (serialModeNotice) serialModeNotice.classList.add("hidden");
    } else {
      if (serialModeNotice) serialModeNotice.classList.remove("hidden");
      if (serialUnsupportedNotice) serialUnsupportedNotice.classList.add("hidden");
    }
  });
}

let serialMonitorPort = null;
let serialMonitorReader = null;
let serialMonitorKeepReading = false;

async function disconnectSerialMonitor() {
  serialMonitorKeepReading = false;
  if (serialMonitorReader) {
    try {
      await serialMonitorReader.cancel();
    } catch (e) {
      console.warn("Reader cancel error:", e);
    }
    serialMonitorReader = null;
  }
  if (serialMonitorPort) {
    try {
      await serialMonitorPort.close();
    } catch (e) {
      console.warn("Serial port close error:", e);
    }
    serialMonitorPort = null;
  }
  if (btnToggleSerialMonitor) {
    btnToggleSerialMonitor.innerText = "Seriellen Debug Monitor verbinden";
    btnToggleSerialMonitor.className = "w-full bg-slate-700 hover:bg-slate-800 text-white font-bold py-2 rounded-lg transition-colors text-sm mb-3";
  }
}

async function connectSerialMonitor() {
  if (!("serial" in navigator)) {
    alert("Dein Browser unterstützt keine Web Serial API. Bitte verwende Chrome, Edge oder Opera.");
    return;
  }

  try {
    serialMonitorPort = await requestSerialPort();
    await serialMonitorPort.open({ baudRate: 115200 });

    serialMonitorKeepReading = true;
    if (serialLogBox) serialLogBox.classList.remove("hidden");
    if (btnToggleSerialMonitor) {
      btnToggleSerialMonitor.innerText = "🔌 Seriellen Debug Monitor trennen";
      btnToggleSerialMonitor.className = "w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg transition-colors text-sm mb-3";
    }

    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialMonitorPort.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    serialMonitorReader = reader;

    while (serialMonitorKeepReading) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value && serialLogOutput) {
        serialLogOutput.innerText += value;
        serialLogOutput.scrollTop = serialLogOutput.scrollHeight;
      }
    }
  } catch (err) {
    console.error("Serial Monitor Error:", err);
    await disconnectSerialMonitor();
    if (err.name !== "NotFoundError" && err.name !== "AbortError") {
      setStatus("Serial Monitor Fehler: " + err.message, "text-red-500");
    }
  }
}

if (btnToggleSerialMonitor) {
  btnToggleSerialMonitor.addEventListener("click", async () => {
    if (serialMonitorPort) {
      await disconnectSerialMonitor();
    } else {
      await connectSerialMonitor();
    }
  });
}

if (btnClearSerialLog) {
  btnClearSerialLog.addEventListener("click", () => {
    if (serialLogOutput) serialLogOutput.innerText = "";
  });
}

const SERIAL_FILTERS = [
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // Silicon Labs CP210x USB to UART Bridge (CP2102N etc.)
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340 USB to UART Bridge
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }, // CH343 USB to UART Bridge
  { usbVendorId: 0x303a, usbProductId: 0x1001 }, // Espressif USB JTAG/serial
  { usbVendorId: 0x303a, usbProductId: 0x1002 }  // Espressif USB CDC
];

async function requestSerialPort() {
  if (!("serial" in navigator)) {
    throw new Error("Dein Webbrowser unterstützt keine serielle Verbindung (Web Serial API). Nutze Chrome, Edge oder Opera.");
  }
  return await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
}

const usbFlashDialog = document.getElementById("usbFlashDialog");
const usbFlashTitle = document.getElementById("usbFlashTitle");
const usbFlashDescription = document.getElementById("usbFlashDescription");
const usbFlashFileName = document.getElementById("usbFlashFileName");
const usbFlashFileSize = document.getElementById("usbFlashFileSize");
const usbFlashTargetAddress = document.getElementById("usbFlashTargetAddress");
const btnCancelUsbFlash = document.getElementById("btnCancelUsbFlash");
const btnConfirmUsbFlash = document.getElementById("btnConfirmUsbFlash");

let pendingUsbFileBuffer = null;
let pendingUsbAddress = 0x10000;
let pendingUsbLabel = "Firmware";

if (btnCancelUsbFlash) {
  btnCancelUsbFlash.addEventListener("click", () => {
    if (usbFlashDialog) usbFlashDialog.close();
    pendingUsbFileBuffer = null;
  });
}

if (btnConfirmUsbFlash) {
  btnConfirmUsbFlash.addEventListener("click", async () => {
    let port = null;
    try {
      port = await requestSerialPort();
    } catch (e) {
      setStatus("USB Flashing abgebrochen: " + e.message, "text-orange-500");
      if (usbFlashDialog) usbFlashDialog.close();
      return;
    }

    if (usbFlashDialog) usbFlashDialog.close();

    if (pendingUsbFileBuffer) {
      const buffer = pendingUsbFileBuffer;
      const addr = pendingUsbAddress;
      const label = pendingUsbLabel;
      pendingUsbFileBuffer = null;
      await uploadFirmwareSerial(buffer, addr, label, port);
    }
  });
}

function openUsbFlashDialog(buffer, filename, fileSizeStr, addressHex, label) {
  pendingUsbFileBuffer = buffer;
  pendingUsbAddress = addressHex === "0x3B0000" ? 0x3B0000 : 0x10000;
  pendingUsbLabel = label;

  if (usbFlashTitle) usbFlashTitle.innerText = `USB Flashing: ${label}`;
  if (usbFlashDescription) usbFlashDescription.innerText = `Bereit zum Flashen an Adresse ${addressHex}`;
  if (usbFlashFileName) usbFlashFileName.innerText = filename;
  if (usbFlashFileSize) usbFlashFileSize.innerText = fileSizeStr;
  if (usbFlashTargetAddress) usbFlashTargetAddress.innerText = addressHex;

  if (usbFlashDialog) usbFlashDialog.showModal();
}

async function uploadFirmwareSerial(buffer, address = 0x10000, label = "Firmware", port = null) {
  let transport = null;
  try {
    await disconnectSerialMonitor();
    btnSelectFw.disabled = true;
    if (btnUpdateOfflineFw) btnUpdateOfflineFw.disabled = true;
    btnFetchOriginalFw.disabled = true;
    if (btnSelectSpiffs) btnSelectSpiffs.disabled = true;
    fwProgressContainer.classList.remove("hidden");
    fwProgressBar.style.width = "0%";

    setStatus("Verbindung mit USB-Gerät wird hergestellt...", "text-blue-500");
    
    if (!port) {
      port = await requestSerialPort();
    }
    transport = new Transport(port, true);

    const loaderTerminal = {
      clean: () => {},
      writeLine: (data) => {
        console.log(data);
      },
      write: (data) => {
        console.log(data);
      },
    };

    const esploader = new ESPLoader({
      transport: transport,
      baudrate: 921600,
      terminal: loaderTerminal
    });

    setStatus("Lade Bootloader...", "text-blue-500");
    await esploader.main();

    setStatus(`Flashe ${label}...`, "text-blue-500");
    const fileArray = [
      {
        data: buffer,
        address: address
      }
    ];

    await esploader.writeFlash({
      fileArray: fileArray,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const percent = Math.round((written / total) * 100);
        fwProgressBar.style.width = percent + "%";
        setStatus(`Flashe ${label} per USB: ${percent}%...`, "text-blue-500");
      }
    });

    try {
      await esploader.after("hard_reset");
    } catch (resetErr) {
      console.warn("Hard reset attempt:", resetErr);
    }

    fwProgressBar.style.width = "100%";
    setStatus(`✅ ${label} erfolgreich geflasht! Drücke jetzt den Reset-Knopf am E-Paper, um zu starten.`, "text-green-600");
  } catch (err) {
    console.error(err);
    if (err.name === "InvalidStateError" || err.message.includes("already open")) {
      setStatus("Fehler: Der COM-Port ist blockiert! Eventuell ist der PlatformIO Serial Monitor oder ein anderes Programm (z.B. ein anderer Browsertab) noch geöffnet. Bitte schließe diese Verbindungen und versuche es erneut.", "text-red-500");
    } else {
      setStatus("Fehler beim USB-Flash: " + err.message, "text-red-500");
    }
  } finally {
    if (transport) {
      try {
        await transport.disconnect();
      } catch (e) {
        console.warn("Disconnection failed:", e);
      }
    }
    btnSelectFw.disabled = false;
    if (btnUpdateOfflineFw) btnUpdateOfflineFw.disabled = false;
    btnFetchOriginalFw.disabled = false;
    if (btnSelectSpiffs) btnSelectSpiffs.disabled = false;
  }
}

async function uploadFirmwareBle(buffer) {
  try {
    btnSelectFw.disabled = true;
    if (btnUpdateOfflineFw) btnUpdateOfflineFw.disabled = true;
    btnFetchOriginalFw.disabled = true;
    if (btnSelectSpiffs) btnSelectSpiffs.disabled = true;
    fwProgressContainer.classList.remove("hidden");
    fwProgressBar.style.width = "0%";

    await bleInterface.uploadFirmware(buffer);
  } finally {
    btnSelectFw.disabled = false;
    if (btnUpdateOfflineFw) btnUpdateOfflineFw.disabled = false;
    btnFetchOriginalFw.disabled = false;
    if (btnSelectSpiffs) btnSelectSpiffs.disabled = false;
  }
}



let currentOtaUrl = null;

async function checkCloudFw() {
    otaVersion.innerText = "wird geladen...";
    btnConfirmOta.disabled = true;
    currentOtaUrl = null;
    try {
        const type = otaDeviceSelect.value;
        const targetUrl = `./factory/espfota_${type}_pre.json`;
        let isFallback = false;
        let res = await fetchWithProxy(targetUrl);
        
        // If local fetch fails (e.g. 404 on deployed page) or returns HTML (Vite SPA fallback on local dev server)
        const isHtml = res.ok && res.headers.get("content-type")?.includes("text/html");
        if (!res.ok || isHtml) {
            console.log("Local fetch failed or returned HTML. Trying remote fallback...");
            const fallbackUrl = joinUrl(runtimeConfig.factoryPreJsonBaseUrl, `espfota_${type}_pre.json`);
            res = await fetchWithProxy(fallbackUrl);
            isFallback = true;
        }

        if (!res.ok) throw new Error("JSON konnte nicht geladen werden.");
        const data = await res.json();
        
        otaVersion.innerText = data.version || data.date || "Verfügbar";
        
        // If we fell back to the remote server, use the remote binary URL
        if (isFallback) {
            currentOtaUrl = data.url || joinUrl(runtimeConfig.factoryPreBinBaseUrl, `firmware_${type}_pre.bin`);
        } else {
            currentOtaUrl = `./factory/firmware_${type}_pre.bin`;
        }
        btnConfirmOta.disabled = false;
    } catch (e) {
        otaVersion.innerText = "Fehler (" + e.message + ")";
    }
}

btnFetchOriginalFw.addEventListener("click", () => {
    if (otaMethod === "ble") {
        if (!bleInterface || !bleInterface.settingsService) {
            setStatus("Bitte zuerst mit dem E-Paper verbinden.", "text-red-500");
            return;
        }
        
        if (bleInterface.bleDevice && bleInterface.bleDevice.name && bleInterface.bleDevice.name.startsWith("epd13-")) {
            otaDeviceSelect.value = "epd13";
        } else {
            otaDeviceSelect.value = "epd7";
        }
    } else {
        otaDeviceSelect.value = "epd7"; // Default in serial mode
    }
    
    otaDialog.showModal();
    checkCloudFw();
});

otaDeviceSelect.addEventListener("change", checkCloudFw);

btnCancelOta.addEventListener("click", () => {
    otaDialog.close();
});

btnConfirmOta.addEventListener("click", async () => {
    let port = null;
    if (otaMethod === "serial") {
        try {
            port = await requestSerialPort();
        } catch (e) {
            setStatus("USB Flashing abgebrochen: " + e.message, "text-orange-500");
            otaDialog.close();
            return;
        }
    }
    otaDialog.close();
    if (!currentOtaUrl) return;
    
    try {
        setStatus("Lade Cloud-Firmware herunter...", "text-blue-500");
        const res = await fetchWithProxy(currentOtaUrl);
        if (!res.ok) throw new Error("Firmware konnte nicht geladen werden.");
        
        const arrayBuffer = await res.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);
        
        if (otaMethod === "ble") {
            await uploadFirmwareBle(buffer);
        } else {
            await uploadFirmwareSerial(buffer, 0x10000, "Original Cloud Firmware", port);
        }
    } catch (err) {
        console.error(err);
        setStatus("Fehler beim Download der Cloud-Firmware: " + err.message, "text-red-500");
    }
});

if (btnUpdateOfflineFw) {
    btnUpdateOfflineFw.addEventListener("click", () => {
        if (otaMethod === "ble") {
            if (!bleInterface || !bleInterface.settingsService) {
                setStatus("Bitte zuerst mit dem E-Paper verbinden.", "text-red-500");
                return;
            }
            
            if (bleInterface.bleDevice && bleInterface.bleDevice.name && bleInterface.bleDevice.name.startsWith("epd13-")) {
                offlineOtaDeviceSelect.value = "epd13";
            } else {
                offlineOtaDeviceSelect.value = "epd7";
            }
        } else {
            offlineOtaDeviceSelect.value = "epd7"; // Default in serial mode
        }
        
        otaOfflineDialog.showModal();
    });
}

if (btnCancelOfflineOta) {
    btnCancelOfflineOta.addEventListener("click", () => {
        otaOfflineDialog.close();
    });
}

if (btnConfirmOfflineOta) {
    btnConfirmOfflineOta.addEventListener("click", async () => {
        let port = null;
        if (otaMethod === "serial") {
            try {
                port = await requestSerialPort();
            } catch (e) {
                setStatus("USB Flashing abgebrochen: " + e.message, "text-orange-500");
                otaOfflineDialog.close();
                return;
            }
        }
        otaOfflineDialog.close();
        
        try {
            const type = offlineOtaDeviceSelect.value;
            const targetUrl = `./firmware_offline_${type}.bin`;
            
            setStatus("Lade Offline-Firmware herunter...", "text-blue-500");
            let res = await fetch(targetUrl);
            
            const isHtml = res.ok && res.headers.get("content-type")?.includes("text/html");
            if (!res.ok || isHtml) {
                console.log("Local offline firmware fetch failed or returned HTML. Trying remote fallback...");
                const fallbackUrl = joinUrl(runtimeConfig.offlineFirmwareBaseUrl, `firmware_offline_${type}.bin`);
                res = await fetchWithProxy(fallbackUrl);
            }

            if (!res.ok) throw new Error(`HTTP Error ${res.status} beim Download`);
            
            const arrayBuffer = await res.arrayBuffer();
            const buffer = new Uint8Array(arrayBuffer);
            
            if (otaMethod === "ble") {
                await uploadFirmwareBle(buffer);
            } else {
                await uploadFirmwareSerial(buffer, 0x10000, "Offline Firmware", port);
            }
        } catch (err) {
            console.error(err);
            setStatus("Fehler beim Download der Offline-Firmware: " + err.message, "text-red-500");
        }
    });
}

if (btnSelectFw) {
  btnSelectFw.addEventListener("click", () => {
    if (otaMethod === "ble") {
      if (!bleInterface || !bleInterface.settingsService) {
        setStatus("Bitte zuerst mit dem E-Paper verbinden.", "text-red-500");
        return;
      }
    }
    fwInput.click();
  });
}

fwInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const buffer = new Uint8Array(evt.target.result);
    if (otaMethod === "ble") {
      await uploadFirmwareBle(buffer);
    } else {
      const sizeKb = (file.size / 1024).toFixed(1) + " KB";
      openUsbFlashDialog(buffer, file.name, sizeKb, "0x10000", "Firmware");
    }
    fwInput.value = "";
  };
  reader.readAsArrayBuffer(file);
});

if (btnSelectSpiffs) {
  btnSelectSpiffs.addEventListener("click", () => {
    if (!("serial" in navigator)) {
      setStatus("⚠️ USB-Flashing wird von deinem Browser nicht unterstützt. Nutze Chrome, Edge oder Opera.", "text-red-500");
      alert("Dein Browser unterstützt keine serielle Verbindung (Web Serial API). Bitte nutze Chrome, Edge oder Opera für USB-Flashing.");
      return;
    }
    spiffsInput.click();
  });
}

if (spiffsInput) {
  spiffsInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const buffer = new Uint8Array(evt.target.result);
      const sizeKb = (file.size / 1024).toFixed(1) + " KB";
      openUsbFlashDialog(buffer, file.name, sizeKb, "0x3B0000", "SPIFFS (Zertifikat)");
      spiffsInput.value = "";
    };
    reader.readAsArrayBuffer(file);
  });
}

paletteSelect.addEventListener("change", () => {
  generatePicture.setCustomPalette(null);
  renderPaletteEditor();
  if (generatePicture.getOriginalImage()) updatePreview();
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

  const basePalette = generatePicture.getBasePalette(paletteSelect.value);

  if (!generatePicture.getCustomPalette()) {
    generatePicture.setCustomPalette(JSON.parse(JSON.stringify(basePalette)));
  }

  const currentCustomPalette = generatePicture.getCustomPalette();

  paletteEditor.innerHTML = "";
  currentCustomPalette.forEach((c, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "flex flex-col items-center";

    const input = document.createElement("input");
    input.type = "color";

    input.value = c.color.length === 4 ? "#" + c.color[1] + c.color[1] + c.color[2] + c.color[2] + c.color[3] + c.color[3] : c.color;
    input.className = "w-8 h-8 p-0 border-0 rounded cursor-pointer";
    input.title = c.name + " (" + input.value + ")";

    input.addEventListener("input", (e) => {
      currentCustomPalette[idx].color = e.target.value;
      input.title = c.name + " (" + e.target.value + ")";
      throttledUpdatePreview();
    });

    const label = document.createElement("span");
    label.className = "text-[10px] text-gray-500 capitalize mt-1";

    label.innerText = c.name.replace("gameboy", "GB");

    wrap.appendChild(input);
    wrap.appendChild(label);
    paletteEditor.appendChild(wrap);
  });
}

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

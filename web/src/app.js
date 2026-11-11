import { GeneratePicture } from "./GeneratePicture.js";
import { DeviceBleInterface, validateEsp32FirmwareBinary } from "./DeviceBleInterface.js";
import { ESPLoader, Transport } from "esptool-js";
import { $, setStatus, onStatus, currentStatus, setProgress, onProgress, setLed, initNavigation, navigate, getCurrentView, initDialogs, openDialog, closeDialog, showMessage, initCollapsibles, setCollapsible, nextFrame, byteLength, setFieldError, formatDuration, downloadBlob } from "./ui.js";

const EXPECTED_FW_VERSION = typeof __EXPECTED_FW_VERSION__ !== "undefined" ? __EXPECTED_FW_VERSION__ : "0.1.0";

// Release channel of this build: "main" (stable, site root), "dev" (preview, ./dev/) or "local".
// Each channel is a complete build that flashes the offline firmware of its own branch.
const RELEASE_CHANNEL = typeof __RELEASE_CHANNEL__ !== "undefined" ? __RELEASE_CHANNEL__ : "local";
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "";
const IS_DEV_CHANNEL = RELEASE_CHANNEL === "dev";
const PUBLIC_SITE_URL = "https://paperlesspaper.github.io/paperlesspaper-firmware-offline/";

// Limits enforced by the firmware (src/main.cpp). Values outside are silently ignored by the
// device, so they are validated here before writing.
const DEVICE_LIMITS = {
  wifiSsidBytes: 32, // MAX_WIFI_SSID_LEN
  wifiPassBytes: 64, // MAX_WIFI_PASS_LEN
  settingStringBytes: 128, // MAX_SETTING_STRING_LEN
  timeoutMin: 60, // MIN_SLEEP_TIMEOUT
  timeoutMax: 2592000, // MAX_SLEEP_TIMEOUT (30 days)
};

// Flash layout (part.csv)
const APP_ADDRESS = 0x10000;
const SPIFFS_ADDRESS = 0x3b0000;
const SPIFFS_SIZE = 0x40000; // 256 KB

function compareSemver(vA, vB) {
  const clean = (v) =>
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = clean(vA);
  const b = clean(vB);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

const generatePicture = new GeneratePicture();
const bleInterface = new DeviceBleInterface();
const bluetoothAvailable = DeviceBleInterface.isSupported();
const serialAvailable = "serial" in navigator;

/** Central UI state – every enabled/disabled/visible decision is derived from it in syncUi(). */
const state = {
  conn: "disconnected", // "disconnected" | "connecting" | "connected" | "reconnecting"
  busy: false, // a transfer (upload / flash / backup) is running
  hasImage: false,
  otaMethod: "ble", // "ble" | "serial"
  wifiScanning: false,
};

// ---------------------------------------------------------------------------
// Network helper
// ---------------------------------------------------------------------------

/** Hosts a public CORS proxy can never reach – sending them there would only leak the URL. */
function isPrivateUrl(url) {
  try {
    const host = new URL(url, location.href).hostname.toLowerCase();
    if (host === location.hostname) return true;
    if (host === "localhost" || host.startsWith("[") || !host.includes(".")) return true;
    if (/\.(local|lan|home|internal|intranet|fritz\.box|home\.arpa)$/.test(host)) return true;
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  } catch (e) {
    return true;
  }
}

async function fetchWithProxy(url, options = {}) {
  let directError = null;
  try {
    return await fetch(url, options);
  } catch (err) {
    directError = err;
  }

  if (isPrivateUrl(url)) {
    throw directError;
  }
  console.warn("Direct fetch failed (likely CORS). Trying Proxy 1 (corsproxy.io)...", directError);

  try {
    const res = await fetch("https://corsproxy.io/?" + encodeURIComponent(url), options);
    if (res.ok) return res;
    console.warn(`Proxy 1 returned ${res.status}. Trying Proxy 2 (allorigins)...`);
  } catch (err2) {
    console.warn("Proxy 1 fetch failed. Trying Proxy 2 (allorigins)...", err2);
  }

  return await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url), options);
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const btnConnect = $("btnConnect");
const btnDisconnect = $("btnDisconnect");
const connLed = $("connLed");
const systemStatusBar = $("systemStatusBar");
const notConnectedState = $("notConnectedState");
const controls = $("controls");

const wifiInputMask = $("wifiInputMask");
const btnSaveWifi = $("btnSaveWifi");
const wifiSsid = $("wifiSsid");
const btnScanWifi = $("btnScanWifi");
const wifiListBox = $("wifiListBox");
const wifiList = $("wifiList");
const wifiPass = $("wifiPass");
const wifiConnectedInfo = $("wifiConnectedInfo");
const btnEditWifi = $("btnEditWifi");
const infoSsid = $("infoSsid");
const infoIp = $("infoIp");
const infoRssi = $("infoRssi");
const infoQuality = $("infoQuality");
const syncBadgeWifi = $("syncBadgeWifi");
const syncBadgeSettings = $("syncBadgeSettings");

const settingsForm = $("settingsForm");
const settingsSaveZone = $("settingsSaveZone");
const btnSaveSettings = $("btnSaveSettings");
const btnFactoryReset = $("btnFactoryReset");
const btnPreviewJson = $("btnPreviewJson");
const settingTimeout = $("settingTimeout");
const settingTimeoutHint = $("settingTimeoutHint");
const settingUrl = $("settingUrl");
const urlValidationStatus = $("urlValidationStatus");
const settingSettingsUrl = $("settingSettingsUrl");
const settingHttpAuthUser = $("settingHttpAuthUser");
const settingHttpAuthPassword = $("settingHttpAuthPassword");
const settingMotionWakeup = $("settingMotionWakeup");
const settingChargerMode = $("settingChargerMode");
const settingAutoRotation = $("settingAutoRotation");

const fileInput = $("fileInput");
const btnPickImage = $("btnPickImage");
const btnUploadImage = $("btnUploadImage");
const btnDownloadBin = $("btnDownloadBin");
const canvas = $("previewCanvas");
const previewHoverCanvas = $("previewHoverCanvas");
const previewContainer = $("previewContainer");
const previewEmpty = $("previewEmpty");
const previewStage = $("previewStage");
const previewModeRow = $("previewModeRow");
const btnPreviewRaw = $("btnPreviewRaw");
const displayBadge = $("displayBadge");
const displayAutoBadge = $("displayAutoBadge");
const displaySizeSelect = $("displaySizeSelect");
const imageSettingsDetails = $("imageSettingsDetails");
const errorDiffusionMatrix = $("errorDiffusionMatrix");
const serpentine = $("serpentine");
const paletteSelect = $("paletteSelect");
const paletteEditor = $("paletteEditor");
const processingBrightness = $("processingBrightness");
const processingContrast = $("processingContrast");
const processingSaturation = $("processingSaturation");
const btnResetProcessing = $("btnResetProcessing");
const btnAutoDither = $("btnAutoDither");
const btnRotate = $("btnRotate");

const btnOtaBle = $("btnOtaBle");
const btnOtaSerial = $("btnOtaSerial");
const activeOtaModeBadge = $("activeOtaModeBadge");
const bleModeNotice = $("bleModeNotice");
const serialModeNotice = $("serialModeNotice");
const serialUnsupportedNotice = $("serialUnsupportedNotice");
const btnFetchOriginalFw = $("btnFetchOriginalFw");
const btnUpdateOfflineFw = $("btnUpdateOfflineFw");
const otaDialog = $("otaDialog");
const otaDeviceSelect = $("otaDeviceSelect");
const otaVersion = $("otaVersion");
const btnCancelOta = $("btnCancelOta");
const btnConfirmOta = $("btnConfirmOta");
const otaOfflineDialog = $("otaOfflineDialog");
const offlineOtaDeviceSelect = $("offlineOtaDeviceSelect");
const btnCancelOfflineOta = $("btnCancelOfflineOta");
const btnConfirmOfflineOta = $("btnConfirmOfflineOta");
const fwInput = $("fwInput");
const btnSelectFw = $("btnSelectFw");
const btnSelectSpiffs = $("btnSelectSpiffs");
const btnBackupSpiffs = $("btnBackupSpiffs");
const spiffsInput = $("spiffsInput");
const spiffsBleNotice = $("spiffsBleNotice");
const spiffsUsbTools = $("spiffsUsbTools");
const btnSwitchToUsb = $("btnSwitchToUsb");
const usbBackupDialog = $("usbBackupDialog");
const btnCancelUsbBackup = $("btnCancelUsbBackup");
const btnConfirmUsbBackup = $("btnConfirmUsbBackup");
const usbFlashDialog = $("usbFlashDialog");
const usbFlashTitle = $("usbFlashTitle");
const usbFlashDescription = $("usbFlashDescription");
const usbFlashFileName = $("usbFlashFileName");
const usbFlashFileSize = $("usbFlashFileSize");
const usbFlashTargetAddress = $("usbFlashTargetAddress");
const btnCancelUsbFlash = $("btnCancelUsbFlash");
const btnConfirmUsbFlash = $("btnConfirmUsbFlash");

const serialMonitorContainer = $("serialMonitorContainer");
const btnToggleSerialMonitor = $("btnToggleSerialMonitor");
const btnClearSerialLog = $("btnClearSerialLog");
const serialLogBox = $("serialLogBox");
const serialLogOutput = $("serialLogOutput");

const firmwareVersionWarning = $("firmwareVersionWarning");
const firmwareVersionWarningTitle = $("firmwareVersionWarningTitle");
const firmwareVersionWarningText = $("firmwareVersionWarningText");
const btnJumpToOta = $("btnJumpToOta");

const jsonPreviewModal = $("jsonPreviewModal");
const jsonPreviewContent = $("jsonPreviewContent");

const transferDialog = $("transferDialog");
const transferSpinner = $("transferSpinner");
const transferResultLed = $("transferResultLed");
const transferTitle = $("transferTitle");
const transferText = $("transferText");
const transferProgress = $("transferProgress");
const transferFill = $("transferFill");
const transferPct = $("transferPct");
const transferWarn = $("transferWarn");
const btnTransferAbort = $("btnTransferAbort");
const btnTransferOk = $("btnTransferOk");

$("expectedOfflineFwBadge").textContent = `v${EXPECTED_FW_VERSION}`;

// ---------------------------------------------------------------------------
// Central UI sync
// ---------------------------------------------------------------------------

const CONN_LABEL = {
  disconnected: "Nicht verbunden",
  connecting: "Verbindung wird aufgebaut",
  reconnecting: "Verbindung wird wiederhergestellt",
  connected: "Verbunden",
};

function syncUi() {
  const connected = state.conn === "connected";
  const pending = state.conn === "connecting" || state.conn === "reconnecting";
  const busy = state.busy;

  // App bar: one button whose meaning follows the connection state
  btnConnect.hidden = connected || pending;
  btnConnect.disabled = !bluetoothAvailable;
  btnDisconnect.hidden = !(connected || pending);
  btnDisconnect.textContent = connected ? "Trennen" : "Abbrechen";
  setLed(connLed, connected ? "ok" : pending ? "busy" : "idle");
  connLed.setAttribute("aria-label", CONN_LABEL[state.conn] || CONN_LABEL.disconnected);
  document.querySelectorAll('[data-action="connect"]').forEach((btn) => {
    btn.disabled = !bluetoothAvailable || pending;
    btn.textContent = pending ? "Verbinde…" : "Mit E-Paper verbinden";
  });

  systemStatusBar.hidden = !connected;
  notConnectedState.hidden = connected;
  controls.hidden = !connected;

  // Editor
  btnPickImage.classList.toggle("btn-neu-signal", !state.hasImage);
  btnPickImage.classList.toggle("btn-neu-primary", state.hasImage);
  btnPickImage.textContent = state.hasImage ? "Anderes Bild" : "Bild wählen";
  btnRotate.disabled = !state.hasImage || busy;
  btnAutoDither.disabled = !state.hasImage || busy;
  btnDownloadBin.disabled = !state.hasImage || busy;
  btnUploadImage.disabled = !state.hasImage || !connected || busy;
  // A disabled button says why it is disabled.
  btnUploadImage.textContent = !state.hasImage ? "Senden – kein Bild" : !connected ? "Senden – nicht verbunden" : "An Gerät senden";

  // Device settings
  btnSaveWifi.disabled = busy;
  btnSaveSettings.disabled = busy;
  btnScanWifi.disabled = busy || state.wifiScanning;
  btnScanWifi.textContent = state.wifiScanning ? "Suche…" : "Scan";
  btnFactoryReset.disabled = busy;
  btnPreviewJson.disabled = busy;

  // Firmware
  const usbBlocked = state.otaMethod === "serial" && !serialAvailable;
  [btnFetchOriginalFw, btnUpdateOfflineFw, btnSelectFw, btnBackupSpiffs, btnSelectSpiffs, btnToggleSerialMonitor].forEach((btn) => {
    btn.disabled = busy || usbBlocked;
  });
}

// ---------------------------------------------------------------------------
// Blocking transfer screen (upload / flashing / backup)
// ---------------------------------------------------------------------------

const transfer = { active: false, aborted: false };

function openTransfer(title, abortable) {
  transfer.active = true;
  transfer.aborted = false;
  transferTitle.textContent = title;
  transferTitle.classList.remove("is-err");
  transferText.textContent = "Bitte warten…";
  transferText.classList.remove("is-result");
  transferSpinner.hidden = false;
  transferResultLed.hidden = true;
  transferProgress.hidden = false;
  transferFill.classList.add("indeterminate");
  transferPct.textContent = "…";
  transferWarn.hidden = false;
  btnTransferAbort.hidden = !abortable;
  btnTransferAbort.disabled = false;
  btnTransferOk.hidden = true;
  openDialog(transferDialog);
}

function finishTransfer({ ok = true, title = "", message = "", sticky = false } = {}) {
  transfer.active = false;
  if (!sticky) {
    closeDialog(transferDialog);
    return;
  }
  transferSpinner.hidden = true;
  transferResultLed.hidden = false;
  setLed(transferResultLed, ok ? "ok" : "err");
  transferTitle.textContent = title;
  transferTitle.classList.toggle("is-err", !ok);
  transferText.textContent = message;
  transferText.classList.add("is-result");
  transferProgress.hidden = true;
  transferWarn.hidden = true;
  btnTransferAbort.hidden = true;
  btnTransferOk.hidden = false;
  openDialog(transferDialog);
  btnTransferOk.focus();
}

onStatus((text) => {
  if (transfer.active) transferText.textContent = text;
});

onProgress((value) => {
  if (!transfer.active) return;
  if (value === null) {
    transferFill.classList.add("indeterminate");
    transferPct.textContent = "…";
  } else {
    transferFill.classList.remove("indeterminate");
    transferFill.style.width = value + "%";
    transferPct.textContent = value + "%";
  }
});

// A running transfer must not be dismissed with Escape.
transferDialog.addEventListener("cancel", (e) => {
  if (transfer.active) e.preventDefault();
});
transferDialog.addEventListener("close", () => {
  if (transfer.active) openDialog(transferDialog);
});
btnTransferOk.addEventListener("click", () => closeDialog(transferDialog));
btnTransferAbort.addEventListener("click", () => {
  transfer.aborted = true;
  btnTransferAbort.disabled = true;
  transferText.textContent = "Breche ab…";
  bleInterface.disconnect();
});

/**
 * Runs a long transfer behind the blocking transfer screen.
 * `task` reports via setStatus()/setProgress() and throws an Error with a user-readable message.
 */
async function runTransfer({ title, abortable = false, successTitle = "Fertig", failTitle = "Fehlgeschlagen", stickySuccess = false }, task) {
  if (state.busy) return false;
  state.busy = true;
  syncUi();
  setProgress(null);
  openTransfer(title, abortable);
  let ok = false;
  try {
    await nextFrame();
    await task();
    ok = true;
    finishTransfer({ ok: true, title: successTitle, message: currentStatus.text, sticky: stickySuccess });
  } catch (err) {
    console.error(err);
    if (transfer.aborted) {
      setStatus("Übertragung abgebrochen.", "warn");
      finishTransfer();
    } else {
      const message = err?.message || String(err);
      if (!err?.reported) setStatus(`${failTitle}: ${message}`, "err");
      finishTransfer({ ok: false, title: failTitle, message, sticky: true });
    }
  } finally {
    state.busy = false;
    setProgress(null);
    syncUi();
  }
  return ok;
}

window.addEventListener("beforeunload", (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function setChip(valueId, text, tone = "neutral") {
  const valueEl = $(valueId);
  if (!valueEl) return;
  valueEl.textContent = text;
  valueEl.parentElement.dataset.tone = tone;
}

bleInterface.onStatusChange = (text, level) => {
  setStatus(text, level);
};

bleInterface.onConnectionStateChange = (connectionState) => {
  state.conn = connectionState;
  syncUi();
};

bleInterface.onConnected = (isPaperL) => {
  const is13Inch = Boolean(isPaperL);
  applyDisplayProfile(is13Inch, true);

  document.title = is13Inch ? 'paper L Setup (13.3")' : 'paper 7 Setup (7.3")';
  setChip("systemDeviceName", `${bleInterface.bleDevice?.name || "E-Paper"} · ${is13Inch ? '13.3"' : '7.3"'}`);

  state.conn = "connected";
  syncUi();
};

bleInterface.onDisconnected = () => {
  document.title = "E-Paper Konfiguration";

  displaySizeSelect.disabled = false;
  displaySizeSelect.title = "";
  displayAutoBadge.hidden = true;
  displayLockedToDevice = false;
  otaDeviceSelect.disabled = false;
  offlineOtaDeviceSelect.disabled = false;

  firmwareVersionWarning.hidden = true;
  setChip("systemFwVersion", "--");
  setChip("systemVoltage", "-- V");
  setChip("systemChargerStatus", "Prüfe…");

  finishWifiScan();
  wifiList.replaceChildren();
  wifiListBox.hidden = true;

  syncUi();
};

btnConnect.addEventListener("click", () => bleInterface.connect());
document.querySelectorAll('[data-action="connect"]').forEach((btn) => btn.addEventListener("click", () => bleInterface.connect()));
btnDisconnect.addEventListener("click", () => bleInterface.disconnect());

if (!bluetoothAvailable) {
  $("bluetoothUnsupported").hidden = false;
  if (!window.isSecureContext) {
    $("bluetoothUnsupportedText").textContent = "Web Bluetooth funktioniert nur über eine sichere Verbindung (HTTPS oder localhost). Bild-Editor und BMP-Download funktionieren trotzdem.";
  }
  setStatus("Bluetooth ist in diesem Browser nicht verfügbar – Bild-Editor und Download funktionieren trotzdem.", "warn");
} else {
  setStatus("Warte auf Verbindung…", "idle");
}

// ---------------------------------------------------------------------------
// Firmware version of the connected device
// ---------------------------------------------------------------------------

function updateFirmwareVersionUI(versionInfo) {
  const devVer = versionInfo?.version ? String(versionInfo.version).trim() : null;

  if (devVer && compareSemver(devVer, EXPECTED_FW_VERSION) >= 0) {
    firmwareVersionWarning.hidden = true;
    setChip("systemFwVersion", `v${devVer} ✓`, "ok");
    return;
  }

  firmwareVersionWarning.hidden = false;
  if (devVer) {
    firmwareVersionWarningTitle.textContent = `⚠️ Firmware-Update verfügbar (v${devVer} → v${EXPECTED_FW_VERSION})`;
    firmwareVersionWarningText.textContent = `Auf deinem E-Paper läuft Version v${devVer} (aktuell ist v${EXPECTED_FW_VERSION}). Bitte aktualisiere die Firmware für maximale Stabilität und Fehlerkorrektur.`;
    setChip("systemFwVersion", `v${devVer} ⚠`, "warn");
  } else {
    firmwareVersionWarningTitle.textContent = "⚠️ Veraltete oder abweichende Firmware erkannt";
    firmwareVersionWarningText.textContent = `Auf deinem E-Paper ist nicht die aktuelle Offline-Firmware v${EXPECTED_FW_VERSION} installiert. Ein Update wird empfohlen.`;
    setChip("systemFwVersion", "Veraltet ⚠", "warn");
  }
}

bleInterface.onFirmwareVersionCheck = (versionInfo) => {
  updateFirmwareVersionUI(versionInfo);
};

btnJumpToOta.addEventListener("click", () => {
  navigate("firmware");
  setOtaMode("ble");
  $("offlineFirmwareCard").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

bleInterface.onSystemStatusChange = (info) => {
  const hasVoltage = typeof info.voltage === "number" && info.voltage > 500;
  const v = hasVoltage ? (info.voltage / 1000).toFixed(2) : null;

  if (!hasVoltage) {
    setChip("systemVoltage", "Keine Batterie", "warn");
  } else if (info.charging) {
    setChip("systemVoltage", `${v} V · lädt`, "ok");
  } else if (info.voltage > 3300) {
    setChip("systemVoltage", `${v} V`, "ok");
  } else if (info.voltage > 2800) {
    setChip("systemVoltage", `${v} V`, "warn");
  } else {
    setChip("systemVoltage", `${v} V · schwach`, "err");
  }

  if (info.usb) {
    setChip("systemChargerStatus", info.charging ? "Verbunden · lädt" : "Verbunden", info.charging ? "ok" : "info");
  } else {
    setChip("systemChargerStatus", "Nicht verbunden");
  }

  if (info.display === "13" || info.display === 13 || info.display === "epd13") {
    applyDisplayProfile(true, true);
  } else if (info.display === "7" || info.display === 7 || info.display === "epd7") {
    applyDisplayProfile(false, true);
  }
  if (typeof info.version === "string" && info.version.trim()) {
    updateFirmwareVersionUI({ version: info.version.trim(), fw: info.fw });
  }
};

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------

function updateWifiStatusUI(isConnected) {
  wifiInputMask.hidden = isConnected;
  wifiConnectedInfo.hidden = !isConnected;
}

bleInterface.onWifiStatusChange = (isConnected) => {
  updateWifiStatusUI(isConnected);
};

bleInterface.onWifiInfoChange = (info) => {
  if (!info.ip) return;
  infoIp.textContent = info.ip;
  infoRssi.textContent = info.rssi + " dBm";
  infoSsid.textContent = info.ssid || "Netzwerk";
  if (info.rssi > -60) infoQuality.textContent = "Ausgezeichnet";
  else if (info.rssi > -75) infoQuality.textContent = "Gut";
  else infoQuality.textContent = "Schwach";
};

btnEditWifi.addEventListener("click", () => {
  updateWifiStatusUI(false);
  wifiSsid.focus();
});

let wifiScanTimer = null;

function finishWifiScan() {
  clearTimeout(wifiScanTimer);
  wifiScanTimer = null;
  if (!state.wifiScanning) return;
  state.wifiScanning = false;
  syncUi();
}

function signalBars(rssi) {
  const level = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -78 ? 2 : 1;
  const bars = document.createElement("span");
  bars.className = "signal-bars";
  bars.setAttribute("aria-hidden", "true");
  for (let i = 1; i <= 4; i++) {
    const bar = document.createElement("i");
    if (i <= level) bar.className = "on";
    bars.appendChild(bar);
  }
  return bars;
}

function renderWifiList(networks) {
  // strongest access point per SSID, strongest network first
  const bySsid = new Map();
  networks.forEach((net) => {
    const rssi = parseInt(net.rssi, 10);
    const entry = { ssid: net.ssid, rssi: Number.isFinite(rssi) ? rssi : null };
    const known = bySsid.get(net.ssid);
    if (!known || (entry.rssi ?? -999) > (known.rssi ?? -999)) bySsid.set(net.ssid, entry);
  });
  const sorted = [...bySsid.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));

  wifiList.replaceChildren();
  sorted.forEach((net) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wifi-item";
    if (net.ssid === wifiSsid.value) item.classList.add("is-selected");

    const name = document.createElement("span");
    name.className = "wifi-ssid";
    name.textContent = net.ssid;
    item.appendChild(name);

    if (net.rssi !== null) {
      const signal = document.createElement("span");
      signal.className = "wifi-signal";
      signal.append(`${net.rssi} dBm`, signalBars(net.rssi));
      item.appendChild(signal);
    }

    item.addEventListener("click", () => {
      wifiSsid.value = net.ssid;
      setFieldError(wifiSsid, "");
      wifiList.querySelectorAll(".is-selected").forEach((el) => el.classList.remove("is-selected"));
      item.classList.add("is-selected");
      wifiPass.focus();
    });
    wifiList.appendChild(item);
  });
  wifiListBox.hidden = sorted.length === 0;
}

bleInterface.onWifiScanResult = (networks) => {
  renderWifiList(networks);
  finishWifiScan();
};

btnScanWifi.addEventListener("click", async () => {
  if (state.wifiScanning) return;
  state.wifiScanning = true;
  syncUi();
  // The device answers with a notification. Without one (no network in range, old firmware)
  // the button must not stay locked forever.
  wifiScanTimer = setTimeout(() => {
    if (!state.wifiScanning) return;
    finishWifiScan();
    setStatus("Keine WLAN-Netze gefunden. Du kannst den Namen auch von Hand eingeben.", "warn");
  }, 15000);
  try {
    const started = await bleInterface.scanWifi();
    if (!started) finishWifiScan();
  } catch (e) {
    finishWifiScan();
    setStatus("WLAN-Scan konnte nicht gestartet werden.", "err");
  }
});

wifiSsid.addEventListener("input", () => setFieldError(wifiSsid, ""));
wifiPass.addEventListener("input", () => setFieldError(wifiPass, ""));

wifiInputMask.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;

  const ssid = wifiSsid.value;
  let valid = true;
  if (!ssid.trim()) {
    setFieldError(wifiSsid, "Bitte einen WLAN-Namen eingeben oder aus der Liste wählen.");
    valid = false;
  } else if (byteLength(ssid) > DEVICE_LIMITS.wifiSsidBytes) {
    setFieldError(wifiSsid, `Der WLAN-Name ist zu lang (maximal ${DEVICE_LIMITS.wifiSsidBytes} Zeichen).`);
    valid = false;
  } else {
    setFieldError(wifiSsid, "");
  }
  if (byteLength(wifiPass.value) > DEVICE_LIMITS.wifiPassBytes) {
    setFieldError(wifiPass, `Das Passwort ist zu lang (maximal ${DEVICE_LIMITS.wifiPassBytes} Zeichen).`);
    valid = false;
  } else {
    setFieldError(wifiPass, "");
  }
  if (!valid) {
    wifiInputMask.querySelector('[aria-invalid="true"]')?.focus();
    return;
  }

  const originalText = btnSaveWifi.textContent;
  btnSaveWifi.textContent = "Verbinde…";
  btnSaveWifi.disabled = true;
  try {
    await bleInterface.saveWifi(ssid, wifiPass.value);
  } finally {
    btnSaveWifi.textContent = originalText;
    syncUi();
  }
});

// Password reveal buttons
document.querySelectorAll("[data-reveal]").forEach((btn) => {
  const input = $(btn.dataset.reveal);
  if (!input) return;
  btn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.setAttribute("aria-pressed", String(reveal));
    btn.setAttribute("aria-label", reveal ? "Passwort verbergen" : "Passwort anzeigen");
    btn.querySelector("use")?.setAttribute("href", reveal ? "#i-eye-off" : "#i-eye");
  });
});

// ---------------------------------------------------------------------------
// Device settings
// ---------------------------------------------------------------------------

function markSettingsDirty(dirty) {
  settingsSaveZone.classList.toggle("settings-dirty", dirty);
}

function updateTimeoutHint() {
  const seconds = parseInt(settingTimeout.value, 10);
  const readable = formatDuration(seconds);
  settingTimeoutHint.textContent = readable ? `= ${readable} · erlaubt sind 60 Sekunden bis 30 Tage.` : "60 Sekunden bis 30 Tage.";
}

bleInterface.onSettingsLoaded = (settings) => {
  if (settings.url !== undefined) {
    settingUrl.value = settings.url;
    syncBadgeSettings.hidden = false;
  }
  if (settings.timeout !== undefined) {
    settingTimeout.value = settings.timeout;
    syncBadgeSettings.hidden = false;
  }
  if (settings.httpAuthUser !== undefined) settingHttpAuthUser.value = settings.httpAuthUser;
  if (settings.motionWakeup !== undefined) settingMotionWakeup.checked = settings.motionWakeup;
  if (settings.chargerMode !== undefined) settingChargerMode.checked = settings.chargerMode;
  if (settings.autoRotation !== undefined) settingAutoRotation.checked = settings.autoRotation;
  if (settings.settingsUrl !== undefined) settingSettingsUrl.value = settings.settingsUrl;
  if (settings.wifiSsid !== undefined) {
    wifiSsid.value = settings.wifiSsid;
    syncBadgeWifi.hidden = false;
  }

  [settingUrl, settingTimeout, settingSettingsUrl, settingHttpAuthUser, settingHttpAuthPassword].forEach((el) => setFieldError(el, ""));
  urlValidationStatus.hidden = true;
  updateTimeoutHint();
  markSettingsDirty(false);
};

[settingUrl, settingTimeout, settingSettingsUrl, settingHttpAuthUser, settingHttpAuthPassword].forEach((el) => {
  el.addEventListener("input", () => {
    setFieldError(el, "");
    markSettingsDirty(true);
  });
});
settingTimeout.addEventListener("input", updateTimeoutHint);

function validateUrlField(input) {
  const value = input.value.trim();
  input.value = value;
  if (!value) {
    setFieldError(input, "");
    return true;
  }
  if (!/^https?:\/\/\S+$/i.test(value)) {
    setFieldError(input, "Die URL muss mit http:// oder https:// beginnen und darf keine Leerzeichen enthalten.");
    return false;
  }
  if (byteLength(value) > DEVICE_LIMITS.settingStringBytes) {
    setFieldError(input, `Die URL ist zu lang (${byteLength(value)} von maximal ${DEVICE_LIMITS.settingStringBytes} Zeichen).`);
    return false;
  }
  setFieldError(input, "");
  return true;
}

function validateLengthField(input, label) {
  if (byteLength(input.value) > DEVICE_LIMITS.settingStringBytes) {
    setFieldError(input, `${label} ist zu lang (maximal ${DEVICE_LIMITS.settingStringBytes} Zeichen).`);
    return false;
  }
  setFieldError(input, "");
  return true;
}

function validateTimeoutField() {
  const raw = settingTimeout.value.trim();
  if (raw === "") {
    setFieldError(settingTimeout, "");
    return true; // empty = default (3600 s)
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < DEVICE_LIMITS.timeoutMin || seconds > DEVICE_LIMITS.timeoutMax) {
    setFieldError(settingTimeout, `Bitte eine ganze Zahl zwischen ${DEVICE_LIMITS.timeoutMin} und ${DEVICE_LIMITS.timeoutMax} Sekunden (30 Tage) eingeben.`);
    return false;
  }
  setFieldError(settingTimeout, "");
  return true;
}

function validateSettingsForm() {
  // run all checks so that every invalid field is marked
  const results = [validateUrlField(settingUrl), validateTimeoutField(), validateUrlField(settingSettingsUrl), validateLengthField(settingHttpAuthUser, "Der Benutzername"), validateLengthField(settingHttpAuthPassword, "Das Passwort")];
  return results.every(Boolean);
}

/**
 * Informational only: the device fetches the URL itself, the browser merely tries the same.
 * Runs after saving and never blocks it.
 */
function probeImageUrl(url) {
  urlValidationStatus.hidden = true;
  if (!url) return;
  if (location.protocol === "https:" && /^http:\/\//i.test(url)) {
    // Mixed content: the browser may not load http:// from this page, so the check would always fail.
    return;
  }
  urlValidationStatus.hidden = false;
  urlValidationStatus.textContent = "… Prüfe, ob die URL vom Browser aus erreichbar ist";
  const img = new Image();
  let settled = false;
  const finish = (reachable) => {
    if (settled || settingUrl.value !== url) return;
    settled = true;
    urlValidationStatus.textContent = reachable ? "✓ Die URL ist erreichbar und liefert ein Bild." : "⚠ Die URL konnte vom Browser nicht als Bild geladen werden (evtl. nur im lokalen Netz erreichbar). Sie wurde trotzdem gespeichert.";
  };
  const timeout = setTimeout(() => finish(false), 5000);
  img.onload = () => {
    clearTimeout(timeout);
    finish(true);
  };
  img.onerror = () => {
    clearTimeout(timeout);
    finish(false);
  };
  img.src = url;
}

async function saveDeviceSettings() {
  if (state.busy) return false;
  if (!validateSettingsForm()) {
    setStatus("Bitte die markierten Felder korrigieren.", "err");
    settingsForm.querySelector('[aria-invalid="true"]')?.focus();
    return false;
  }

  const settings = {
    url: settingUrl.value,
    timeout: settingTimeout.value.trim(),
    httpAuthUser: settingHttpAuthUser.value,
    // The device does not reveal its password: an empty field keeps the stored one.
    // Without a user name the password is cleared as well.
    httpAuthPassword: settingHttpAuthPassword.value !== "" ? settingHttpAuthPassword.value : settingHttpAuthUser.value === "" ? "" : undefined,
    motionWakeup: settingMotionWakeup.checked,
    chargerMode: settingChargerMode.checked,
    autoRotation: settingAutoRotation.checked,
    settingsUrl: settingSettingsUrl.value,
  };

  const originalText = btnSaveSettings.textContent;
  btnSaveSettings.textContent = "Speichere…";
  btnSaveSettings.disabled = true;
  let success = false;
  try {
    success = await bleInterface.saveSettings(settings);
  } finally {
    btnSaveSettings.textContent = originalText;
    syncUi();
  }

  if (success) {
    syncBadgeSettings.hidden = false;
    markSettingsDirty(false);
    probeImageUrl(settings.url);
  } else if (!bleInterface.isConnected) {
    setStatus("Nicht gespeichert: Das E-Paper ist nicht verbunden.", "err");
  }
  return success;
}

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  saveDeviceSettings();
});

// --- Settings JSON preview ---

let tempJsonSettings = null;

btnPreviewJson.addEventListener("click", async () => {
  if (!settingSettingsUrl.value.trim()) {
    setFieldError(settingSettingsUrl, "Bitte zuerst eine JSON-URL eingeben.");
    settingSettingsUrl.focus();
    return;
  }
  if (!validateUrlField(settingSettingsUrl)) {
    settingSettingsUrl.focus();
    return;
  }

  const rawUrl = settingSettingsUrl.value;
  const url = rawUrl + (rawUrl.includes("?") ? "&" : "?") + "nocache=" + Date.now();

  btnPreviewJson.textContent = "Lade…";
  btnPreviewJson.disabled = true;
  try {
    const response = await fetchWithProxy(url, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP Fehler " + response.status);

    const json = await response.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Die Datei enthält kein JSON-Objekt.");

    tempJsonSettings = json;
    jsonPreviewContent.textContent = JSON.stringify(json, null, 2);
    openDialog(jsonPreviewModal);
  } catch (e) {
    console.error(e);
    const mixedContent = location.protocol === "https:" && /^http:\/\//i.test(rawUrl);
    await showMessage({
      title: "JSON konnte nicht geladen werden",
      tone: "err",
      text: mixedContent ? "Der Browser darf von dieser HTTPS-Seite keine HTTP-Adresse abrufen. Das E-Paper selbst kann die URL trotzdem laden – die Vorschau funktioniert nur mit einer HTTPS-URL oder wenn du dieses Tool lokal über HTTP öffnest." : "Die Datei ist nicht erreichbar, kein gültiges JSON oder der Server erlaubt den Abruf nicht (CORS). Liegt sie lokal (z. B. auf einem NAS), muss der Server den Header „Access-Control-Allow-Origin: *“ senden.",
      detail: e.message,
    });
  } finally {
    btnPreviewJson.textContent = "Prüfen";
    syncUi();
  }
});

$("btnCancelJson").addEventListener("click", () => closeDialog(jsonPreviewModal));

$("btnApplyJson").addEventListener("click", async () => {
  closeDialog(jsonPreviewModal);
  if (!tempJsonSettings) return;

  if (tempJsonSettings.timeout !== undefined) settingTimeout.value = tempJsonSettings.timeout;
  if (tempJsonSettings.downloadUrl !== undefined) settingUrl.value = tempJsonSettings.downloadUrl;
  if (tempJsonSettings.httpAuthUser !== undefined) settingHttpAuthUser.value = tempJsonSettings.httpAuthUser;
  if (tempJsonSettings.httpAuthPassword !== undefined) settingHttpAuthPassword.value = tempJsonSettings.httpAuthPassword;
  if (tempJsonSettings.motionWakeup !== undefined) settingMotionWakeup.checked = Boolean(tempJsonSettings.motionWakeup);
  if (tempJsonSettings.chargerMode !== undefined) settingChargerMode.checked = Boolean(tempJsonSettings.chargerMode);
  if (tempJsonSettings.autoRotation !== undefined) settingAutoRotation.checked = Boolean(tempJsonSettings.autoRotation);
  updateTimeoutHint();
  markSettingsDirty(true);

  await saveDeviceSettings();
});

// --- Switches that are stored immediately ---

async function saveSwitch(input, type, label) {
  const enabled = input.checked;
  input.disabled = true;
  let saved = false;
  try {
    saved = await bleInterface.directSaveSetting(type, enabled);
  } finally {
    input.disabled = false;
  }
  if (saved) {
    setStatus(`${label} ${enabled ? "aktiviert" : "deaktiviert"}.`, "ok");
  } else {
    input.checked = !enabled; // show what the device really has
    setStatus(`${label} konnte nicht gespeichert werden.`, "err");
  }
}

settingMotionWakeup.addEventListener("change", () => saveSwitch(settingMotionWakeup, "motionWakeup", "Motion Wakeup"));
settingAutoRotation.addEventListener("change", () => saveSwitch(settingAutoRotation, "autoRotation", "Auto Rotation"));
settingChargerMode.addEventListener("change", async () => {
  if (settingChargerMode.checked) {
    // Charging non-rechargeable cells is a safety hazard: ask before switching it on.
    const confirmed = await showMessage({
      title: "Charger Mode aktivieren?",
      tone: "warn",
      text: "Der Charger Mode lädt die eingelegten Zellen über USB-C. Aktiviere ihn nur, wenn NiMH-Akkus eingelegt sind.",
      detail: "Normale Batterien (z. B. Alkaline) dürfen nicht geladen werden – sie können auslaufen oder überhitzen.",
      okLabel: "Ja, NiMH-Akkus eingelegt",
      cancelLabel: "Abbrechen",
      okVariant: "danger",
    });
    if (!confirmed) {
      settingChargerMode.checked = false;
      return;
    }
  }
  await saveSwitch(settingChargerMode, "chargerMode", "Charger Mode");
});

btnFactoryReset.addEventListener("click", async () => {
  const confirmed = await showMessage({
    title: "Gerät zurücksetzen?",
    tone: "err",
    text: "Das Gerät wird auf Werkseinstellungen zurückgesetzt und startet neu.",
    detail: "Gelöscht werden: alle Einstellungen, die WLAN-Zugangsdaten und gespeicherte Bilder.",
    okLabel: "Ja, zurücksetzen",
    cancelLabel: "Abbrechen",
    okVariant: "danger",
  });
  if (!confirmed) return;
  await bleInterface.factoryReset();
});

// ---------------------------------------------------------------------------
// Image editor
// ---------------------------------------------------------------------------

let EPD_WIDTH = 800;
let EPD_HEIGHT = 480;
let displayLockedToDevice = false;

function applyDisplayProfile(isPaperL, lockToDevice = false) {
  const nextWidth = isPaperL ? 1200 : 800;
  const nextHeight = isPaperL ? 1600 : 480;
  const dimsChanged = EPD_WIDTH !== nextWidth || EPD_HEIGHT !== nextHeight;
  const lockChanged = displayLockedToDevice !== lockToDevice;
  // The device reports its display every 10 s. Nothing to do if nothing changed – in particular
  // the preview canvas must not be touched (resizing a canvas clears it).
  if (!dimsChanged && !lockChanged) return;

  EPD_WIDTH = nextWidth;
  EPD_HEIGHT = nextHeight;
  displayLockedToDevice = lockToDevice;

  previewContainer.style.setProperty("--epd-ratio", `${EPD_WIDTH} / ${EPD_HEIGHT}`);
  displayBadge.textContent = isPaperL ? '13.3" · 1200×1600' : '7.3" · 800×480';
  displaySizeSelect.value = isPaperL ? "13" : "7";
  displaySizeSelect.disabled = lockToDevice;
  displaySizeSelect.title = lockToDevice ? `Automatisch an verbundenes Gerät angepasst (${isPaperL ? '13.3"' : '7.3"'})` : "";
  displayAutoBadge.hidden = !lockToDevice;

  const deviceCode = isPaperL ? "epd13" : "epd7";
  otaDeviceSelect.value = deviceCode;
  offlineOtaDeviceSelect.value = deviceCode;

  const img = generatePicture.getOriginalImage();
  if (img && dimsChanged) {
    applyAutoRotation(img);
    updatePreview();
  }
}

/** Landscape picture on a portrait display (or vice versa) is turned by 90°. */
function applyAutoRotation(img) {
  if ((img.height > img.width && EPD_WIDTH > EPD_HEIGHT) || (img.width > img.height && EPD_HEIGHT > EPD_WIDTH)) {
    generatePicture.setImageRotation(270);
  } else {
    generatePicture.setImageRotation(0);
  }
}

displaySizeSelect.addEventListener("change", (e) => {
  if (bleInterface.isConnected) {
    applyDisplayProfile(bleInterface.isPaperL, true);
    return;
  }
  applyDisplayProfile(e.target.value === "13", false);
});

// --- Processing options ---

let activeAutoOptions = null;
// After "Auto-Optimieren" the sliders show the suggested values. They only override the
// suggestion once the user actually moves one.
let toneSlidersTouched = false;

function updateSliderOutputs() {
  [processingBrightness, processingContrast, processingSaturation].forEach((slider) => {
    const value = parseInt(slider.value, 10) || 0;
    $(slider.id + "Out").textContent = value > 0 ? "+" + value : String(value);
  });
}

function collectProcessingInputs() {
  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
  const brightness = parseInt(processingBrightness.value, 10) || 0;
  const contrast = parseInt(processingContrast.value, 10) || 0;
  const saturation = parseInt(processingSaturation.value, 10) || 0;

  const options = activeAutoOptions ? { ...activeAutoOptions } : {};
  options.errorDiffusionMatrix = matrix;
  options.serpentine = isSerpentine;

  if (options.toneMapping && toneSlidersTouched) {
    // Without this the auto tone mapping always won and the sliders had no effect at all.
    const base = options.toneMapping;
    const merged = { ...base, exposure: brightness / 100, contrast: contrast / 100, saturation: saturation / 100 };
    if (base.mode === "off") {
      merged.mode = "contrast";
    } else if (base.mode === "scurve" && contrast !== 0) {
      // epdoptimize applies the contrast factor only in "contrast" mode; without a mode it
      // applies both the contrast and the S-curve.
      delete merged.mode;
      merged.strength = base.strength ?? 0.9;
    }
    options.toneMapping = merged;
  }

  return { palette: paletteSelect.value || "spectra6Custom", matrix, isSerpentine, brightness, contrast, saturation, options };
}

// --- Preview pipeline: never two renders on the same canvas at once ---

let previewRunning = false;
let previewQueued = false;

async function renderPreview() {
  const input = collectProcessingInputs();
  previewContainer.classList.add("is-busy");
  setStatus("Erzeuge Dithering-Vorschau…", "busy");
  await nextFrame();

  try {
    if (bleInterface.isConnected) {
      applyDisplayProfile(bleInterface.isPaperL, true);
    }
    generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
    const result = await generatePicture.processPreview(canvas, previewHoverCanvas, input.palette, input.matrix, input.isSerpentine, input.brightness, input.contrast, input.saturation, input.options);

    const hasSimulation = Boolean(result?.hasDisplaySimulation);
    previewStage.classList.toggle("has-simulation", hasSimulation);
    previewModeRow.hidden = !hasSimulation;
    if (!previewQueued) setStatus(bleInterface.isConnected ? "Bildvorschau optimiert und bereit zum Senden." : "Bildvorschau optimiert. Zum Senden das E-Paper verbinden oder als BMP herunterladen.", "ok");
  } catch (e) {
    setStatus("Fehler beim Dithering: " + e.message, "err");
    console.error(e);
  } finally {
    previewContainer.classList.remove("is-busy");
  }
}

async function updatePreview() {
  if (!generatePicture.getOriginalImage()) return;
  if (previewRunning) {
    previewQueued = true; // render once more with the latest settings when the current run ends
    return;
  }
  previewRunning = true;
  try {
    do {
      previewQueued = false;
      await renderPreview();
    } while (previewQueued);
  } finally {
    previewRunning = false;
  }
}

let previewDebounce = null;
function schedulePreview() {
  if (!generatePicture.getOriginalImage()) return;
  clearTimeout(previewDebounce);
  previewDebounce = setTimeout(updatePreview, 250);
}

async function generateFullBuffer() {
  if (!generatePicture.getOriginalImage()) return;
  if (bleInterface.isConnected) {
    applyDisplayProfile(bleInterface.isPaperL, true);
  }
  const input = collectProcessingInputs();
  generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
  await generatePicture.generateFullBuffer(input.palette, input.matrix, input.isSerpentine, input.brightness, input.contrast, input.saturation, input.options);
}

[errorDiffusionMatrix, serpentine].forEach((el) => el.addEventListener("change", updatePreview));

[processingBrightness, processingContrast, processingSaturation].forEach((el) => {
  el.addEventListener("input", () => {
    toneSlidersTouched = true;
    updateSliderOutputs();
    schedulePreview();
  });
});

btnResetProcessing.addEventListener("click", () => {
  activeAutoOptions = null;
  toneSlidersTouched = false;
  processingBrightness.value = 0;
  processingContrast.value = 0;
  processingSaturation.value = 0;
  updateSliderOutputs();
  updatePreview();
});

// --- Loading an image ---

let currentImageUrl = null;

function loadImageFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = url;

    activeAutoOptions = null;
    toneSlidersTouched = false;
    if (bleInterface.isConnected) {
      applyDisplayProfile(bleInterface.isPaperL, true);
    }
    generatePicture.setOriginalImage(img);
    applyAutoRotation(img);

    state.hasImage = true;
    previewEmpty.hidden = true;
    previewStage.hidden = false;
    setCollapsible(imageSettingsDetails, true);
    syncUi();
    updatePreview();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("Das Bild konnte nicht geladen werden. Bitte ein JPEG, PNG oder WebP wählen.", "err");
  };
  img.src = url;
}

fileInput.addEventListener("change", (e) => {
  loadImageFile(e.target.files[0]);
  fileInput.value = ""; // allows picking the same file again
});
btnPickImage.addEventListener("click", () => fileInput.click());
previewEmpty.addEventListener("click", () => fileInput.click());

// Drag & drop / paste (desktop)
["dragenter", "dragover"].forEach((type) =>
  previewContainer.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    previewContainer.classList.add("is-dragover");
  }),
);
["dragleave", "dragend", "drop"].forEach((type) =>
  previewContainer.addEventListener(type, (e) => {
    // dragleave also fires when moving onto a child element
    if (type === "dragleave" && previewContainer.contains(e.relatedTarget)) return;
    previewContainer.classList.remove("is-dragover");
  }),
);
previewContainer.addEventListener("drop", (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  loadImageFile(file);
});
document.addEventListener("paste", (e) => {
  if (getCurrentView() !== "bild" || state.busy) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) loadImageFile(file);
});

btnRotate.addEventListener("click", () => {
  if (!generatePicture.getOriginalImage()) return;
  generatePicture.setImageRotation((generatePicture.getImageRotation() + 90) % 360);
  updatePreview();
});

btnPreviewRaw.addEventListener("click", () => {
  const showRaw = btnPreviewRaw.getAttribute("aria-pressed") !== "true";
  btnPreviewRaw.setAttribute("aria-pressed", String(showRaw));
  previewStage.classList.toggle("show-raw", showRaw);
});

btnAutoDither.addEventListener("click", () => {
  if (!generatePicture.getOriginalImage()) return;

  generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
  const result = generatePicture.autoOptimise(canvas, paletteSelect.value || "spectra6Custom");
  if (!result) {
    setStatus("Für dieses Bild wurde keine automatische Einstellung gefunden.", "warn");
    updatePreview(); // autoOptimise drew the undithered picture onto the preview canvas
    return;
  }

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
  updateSliderOutputs();

  activeAutoOptions = resolvedOptions;
  toneSlidersTouched = false;

  if (paletteSelect.value === "new" || !suggestion) {
    setStatus("Automatisches Setting gefunden: Custom Color Profile", "ok");
  } else {
    setStatus(`Automatisches Setting gefunden: ${suggestion.classification.style}, Typ: ${suggestion.imageKind}`, "ok");
  }

  updatePreview();
});

// --- Palette ---

const PALETTE_LABELS = { black: "Schwarz", white: "Weiß", blue: "Blau", green: "Grün", red: "Rot", yellow: "Gelb" };

function renderPaletteEditor() {
  if (paletteSelect.value !== "spectra6Custom") {
    paletteEditor.hidden = true;
    return;
  }
  paletteEditor.hidden = false;

  if (!generatePicture.getCustomPalette()) {
    const basePalette = generatePicture.getBasePalette(paletteSelect.value);
    generatePicture.setCustomPalette(JSON.parse(JSON.stringify(basePalette)));
  }
  const currentCustomPalette = generatePicture.getCustomPalette();

  paletteEditor.replaceChildren();
  currentCustomPalette.forEach((c, idx) => {
    const label = PALETTE_LABELS[c.name] || c.name;
    const wrap = document.createElement("label");
    wrap.className = "swatch";

    const input = document.createElement("input");
    input.type = "color";
    input.value = c.color.length === 4 ? "#" + c.color[1] + c.color[1] + c.color[2] + c.color[2] + c.color[3] + c.color[3] : c.color;
    input.title = `${label} (${input.value})`;
    input.setAttribute("aria-label", `Farbe ${label}`);
    input.addEventListener("input", (e) => {
      currentCustomPalette[idx].color = e.target.value;
      input.title = `${label} (${e.target.value})`;
      schedulePreview();
    });

    const caption = document.createElement("span");
    caption.textContent = label;

    wrap.append(input, caption);
    paletteEditor.appendChild(wrap);
  });

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn-neu btn-util btn-neu-danger-text";
  reset.textContent = "Farben zurücksetzen";
  reset.addEventListener("click", () => {
    generatePicture.setCustomPalette(null);
    renderPaletteEditor();
    updatePreview();
  });
  paletteEditor.appendChild(reset);
}

paletteSelect.addEventListener("change", () => {
  generatePicture.setCustomPalette(null);
  renderPaletteEditor();
  if (paletteSelect.value !== "new") {
    btnPreviewRaw.setAttribute("aria-pressed", "false");
    previewStage.classList.remove("show-raw");
  }
  updatePreview();
});

// --- Download / upload ---

function buildBmp(imageBuffer) {
  const headerSize = 118;
  const bufferSize = imageBuffer.length;
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

  bytes.set(imageBuffer, headerSize);
  return new Blob([bmpBuffer], { type: "image/bmp" });
}

btnDownloadBin.addEventListener("click", async () => {
  if (!generatePicture.getOriginalImage() || state.busy) return;

  btnDownloadBin.disabled = true;
  try {
    setStatus("Generiere volle Auflösung für Download…", "busy");
    await nextFrame();
    await generateFullBuffer();
    downloadBlob(buildBmp(generatePicture.getProcessedImageBuffer()), "epaper_image.bmp");
    setStatus("BMP-Datei erstellt (epaper_image.bmp).", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Fehler beim Generieren: " + err.message, "err");
  } finally {
    syncUi();
  }
});

btnUploadImage.addEventListener("click", async () => {
  if (!generatePicture.getOriginalImage() || !bleInterface.isConnected) return;

  await runTransfer({ title: "Bild wird gesendet", abortable: true, failTitle: "Senden fehlgeschlagen" }, async () => {
    setStatus("Generiere volle Auflösung für Upload…", "busy");
    await nextFrame();
    await generateFullBuffer();
    await bleInterface.uploadImage(generatePicture.getProcessedImageBuffer());
  });
});

bleInterface.onUploadProgress = (type, percent) => {
  setProgress(percent);
};

// ---------------------------------------------------------------------------
// Firmware: connection method
// ---------------------------------------------------------------------------

function setOtaMode(mode) {
  state.otaMethod = mode === "serial" ? "serial" : "ble";
  const isBle = state.otaMethod === "ble";

  btnOtaBle.setAttribute("aria-pressed", String(isBle));
  btnOtaSerial.setAttribute("aria-pressed", String(!isBle));
  activeOtaModeBadge.textContent = isBle ? "Modus: Bluetooth" : "Modus: USB-Kabel";

  bleModeNotice.hidden = !isBle;
  serialModeNotice.hidden = isBle || !serialAvailable;
  serialUnsupportedNotice.hidden = isBle || serialAvailable;
  spiffsBleNotice.hidden = !isBle;
  spiffsUsbTools.hidden = isBle;
  serialMonitorContainer.hidden = isBle;

  document.querySelectorAll(".otaModeLabel").forEach((el) => {
    el.textContent = isBle ? "BLE" : "USB";
  });
  syncUi();
}

btnOtaBle.addEventListener("click", () => setOtaMode("ble"));
btnOtaSerial.addEventListener("click", () => setOtaMode("serial"));
btnSwitchToUsb.addEventListener("click", () => setOtaMode("serial"));

/** Bluetooth updates need a connected device: offer to connect instead of failing silently. */
async function ensureBleConnected() {
  if (bleInterface.settingsService) return true;
  if (!bluetoothAvailable) {
    await showMessage({ title: "Bluetooth nicht verfügbar", tone: "warn", text: "Dieser Browser unterstützt kein Web Bluetooth. Nutze Chrome, Edge oder Opera – oder wechsle auf einem PC zum Verbindungsweg USB-Kabel." });
    return false;
  }
  const connectNow = await showMessage({
    title: "Nicht verbunden",
    text: "Für das Update per Bluetooth muss das E-Paper verbunden sein. Drücke die Reset-Taste am Gerät und verbinde dich – oder wechsle zum Verbindungsweg USB-Kabel.",
    okLabel: "Verbinden",
    cancelLabel: "Abbrechen",
    okVariant: "signal",
  });
  if (connectNow) bleInterface.connect();
  return false;
}

// ---------------------------------------------------------------------------
// Serial port / USB flashing
// ---------------------------------------------------------------------------

const SERIAL_FILTERS = [
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // Silicon Labs CP210x USB to UART Bridge (CP2102N etc.)
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340 USB to UART Bridge
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }, // CH343 USB to UART Bridge
  { usbVendorId: 0x303a, usbProductId: 0x1001 }, // Espressif USB JTAG/serial
  { usbVendorId: 0x303a, usbProductId: 0x1002 }, // Espressif USB CDC
];

async function requestSerialPort() {
  if (!serialAvailable) {
    throw new Error("Dein Webbrowser unterstützt keine serielle Verbindung (Web Serial API). Nutze Chrome, Edge oder Opera.");
  }
  return await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
}

/** Must run directly inside a click handler (the port chooser needs a user gesture). */
async function pickSerialPort() {
  try {
    return await requestSerialPort();
  } catch (e) {
    if (e?.name === "NotFoundError" || e?.name === "AbortError") {
      setStatus("Kein COM-Port ausgewählt – Vorgang abgebrochen.", "warn");
    } else {
      setStatus("USB-Verbindung fehlgeschlagen: " + e.message, "err");
    }
    return null;
  }
}

function describeSerialError(err) {
  if (err?.name === "InvalidStateError" || err?.message?.includes("already open")) {
    return "Der COM-Port ist blockiert. Eventuell ist der PlatformIO Serial Monitor oder ein anderes Programm (z. B. ein anderer Browser-Tab) noch geöffnet. Bitte schließe diese Verbindungen und versuche es erneut.";
  }
  return err?.message || String(err);
}

const loaderTerminal = {
  clean: () => {},
  writeLine: (data) => console.log(data),
  write: (data) => console.log(data),
};

async function openEspLoader(port) {
  await disconnectSerialMonitor();
  setStatus("Verbindung mit USB-Gerät wird hergestellt…", "busy");
  // tracing off: it hex-dumps every packet to the console and into memory
  const transport = new Transport(port, false);
  const esploader = new ESPLoader({ transport, baudrate: 921600, terminal: loaderTerminal });
  return { transport, esploader };
}

async function closeTransport(transport) {
  if (!transport) return;
  try {
    await transport.disconnect();
  } catch (e) {
    console.warn("Disconnection failed:", e);
  }
}

async function flashSerial(buffer, address, label, port) {
  let transport = null;
  try {
    const loader = await openEspLoader(port);
    transport = loader.transport;
    const esploader = loader.esploader;

    setStatus("Lade Bootloader…", "busy");
    await esploader.main();

    setStatus(`Flashe ${label}…`, "busy");
    await esploader.writeFlash({
      fileArray: [{ data: buffer, address }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const percent = Math.round((written / total) * 100);
        setProgress(percent);
        setStatus(`Flashe ${label} per USB: ${percent}%...`, "busy");
      },
    });

    try {
      await esploader.after("hard_reset");
    } catch (resetErr) {
      console.warn("Hard reset attempt:", resetErr);
    }

    setProgress(100);
    setStatus(`✅ ${label} erfolgreich geflasht! Drücke jetzt den Reset-Knopf am E-Paper, um zu starten.`, "ok");
  } catch (err) {
    console.error(err);
    throw new Error(describeSerialError(err));
  } finally {
    await closeTransport(transport);
  }
}

// --- USB flash confirmation dialog (custom firmware / SPIFFS restore) ---

let pendingUsbFlash = null; // { buffer, address, label }

function openUsbFlashDialog(buffer, filename, fileSizeStr, address, label) {
  const addressHex = "0x" + address.toString(16).toUpperCase();
  pendingUsbFlash = { buffer, address, label };

  usbFlashTitle.textContent = `USB-Flashing: ${label}`;
  usbFlashDescription.textContent = `Bereit zum Flashen an Adresse ${addressHex}.`;
  usbFlashFileName.textContent = filename;
  usbFlashFileSize.textContent = fileSizeStr;
  usbFlashTargetAddress.textContent = addressHex;

  openDialog(usbFlashDialog);
}

btnCancelUsbFlash.addEventListener("click", () => closeDialog(usbFlashDialog));

btnConfirmUsbFlash.addEventListener("click", async () => {
  const job = pendingUsbFlash;
  const port = await pickSerialPort();
  pendingUsbFlash = null;
  closeDialog(usbFlashDialog);
  if (!port || !job) return;

  await runTransfer({ title: `${job.label} wird geflasht`, successTitle: "Erfolgreich geflasht", failTitle: "USB-Flash fehlgeschlagen", stickySuccess: true }, () => flashSerial(job.buffer, job.address, job.label, port));
});

// ---------------------------------------------------------------------------
// Firmware: original cloud firmware
// ---------------------------------------------------------------------------

let currentOtaUrl = null;
let cloudFwRequest = 0;

async function checkCloudFw() {
  const request = ++cloudFwRequest; // a newer request (device type changed) wins
  otaVersion.textContent = "wird geladen…";
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
      const fallbackUrl = `http://ul.epaperframe.de/espfota_${type}_pre.json`;
      res = await fetchWithProxy(fallbackUrl);
      isFallback = true;
    }

    if (!res.ok) throw new Error("JSON konnte nicht geladen werden.");
    const data = await res.json();
    if (request !== cloudFwRequest) return;

    otaVersion.textContent = data.version || data.date || "Verfügbar";

    // If we fell back to the remote server, use the remote binary URL
    if (isFallback) {
      currentOtaUrl = data.url || `http://ul.epaperframe.de/firmware_${type}_pre.bin`;
    } else {
      currentOtaUrl = `./factory/firmware_${type}_pre.bin`;
    }
    btnConfirmOta.disabled = false;
  } catch (e) {
    if (request !== cloudFwRequest) return;
    otaVersion.textContent = "Fehler (" + e.message + ")";
  }
}

/** Presets a device-type select: locked to the connected device for BLE, free choice for USB. */
function prepareDeviceSelect(select) {
  if (state.otaMethod === "ble") {
    select.value = bleInterface.isPaperL ? "epd13" : "epd7";
    select.disabled = true;
  } else {
    select.disabled = false;
    select.value = (bleInterface.isConnected ? bleInterface.isPaperL : displaySizeSelect.value === "13") ? "epd13" : "epd7";
  }
}

async function downloadFirmware(res, what) {
  if (!res.ok) throw new Error(`${what} konnte nicht geladen werden (HTTP ${res.status}).`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  await validateEsp32FirmwareBinary(buffer);
  return buffer;
}

btnFetchOriginalFw.addEventListener("click", async () => {
  if (state.otaMethod === "ble" && !(await ensureBleConnected())) return;
  prepareDeviceSelect(otaDeviceSelect);
  openDialog(otaDialog);
  checkCloudFw();
});

otaDeviceSelect.addEventListener("change", checkCloudFw);
btnCancelOta.addEventListener("click", () => closeDialog(otaDialog));

btnConfirmOta.addEventListener("click", async () => {
  const method = state.otaMethod;
  const url = currentOtaUrl;
  let port = null;
  if (method === "serial") {
    port = await pickSerialPort();
    if (!port) {
      closeDialog(otaDialog);
      return;
    }
  }
  closeDialog(otaDialog);
  if (!url) return;

  await runTransfer({ title: "Cloud-Firmware wird installiert", abortable: method === "ble", successTitle: "Firmware installiert", failTitle: "Firmware-Update fehlgeschlagen", stickySuccess: true }, async () => {
    setStatus("Lade Cloud-Firmware herunter…", "busy");
    const buffer = await downloadFirmware(await fetchWithProxy(url), "Die Cloud-Firmware");

    if (method === "ble") {
      await bleInterface.uploadFirmware(buffer);
    } else {
      await flashSerial(buffer, APP_ADDRESS, "Original Cloud Firmware", port);
    }
  });
});

// ---------------------------------------------------------------------------
// Firmware: offline firmware
// ---------------------------------------------------------------------------

btnUpdateOfflineFw.addEventListener("click", async () => {
  if (state.otaMethod === "ble" && !(await ensureBleConnected())) return;
  prepareDeviceSelect(offlineOtaDeviceSelect);
  openDialog(otaOfflineDialog);
});

btnCancelOfflineOta.addEventListener("click", () => closeDialog(otaOfflineDialog));

btnConfirmOfflineOta.addEventListener("click", async () => {
  const method = state.otaMethod;
  const type = offlineOtaDeviceSelect.value;
  let port = null;
  if (method === "serial") {
    port = await pickSerialPort();
    if (!port) {
      closeDialog(otaOfflineDialog);
      return;
    }
  }
  closeDialog(otaOfflineDialog);

  await runTransfer({ title: "Offline-Firmware wird installiert", abortable: method === "ble", successTitle: "Firmware installiert", failTitle: "Firmware-Update fehlgeschlagen", stickySuccess: true }, async () => {
    setStatus("Lade Offline-Firmware herunter…", "busy");
    let res = await fetch(`./firmware_offline_${type}.bin`);

    const isHtml = res.ok && res.headers.get("content-type")?.includes("text/html");
    if (!res.ok || isHtml) {
      console.log("Local offline firmware fetch failed or returned HTML. Trying remote fallback...");
      res = await fetchWithProxy(`${PUBLIC_SITE_URL}${IS_DEV_CHANNEL ? "dev/" : ""}firmware_offline_${type}.bin`);
    }
    const buffer = await downloadFirmware(res, "Die Offline-Firmware");

    if (method === "ble") {
      await bleInterface.uploadFirmware(buffer);
    } else {
      await flashSerial(buffer, APP_ADDRESS, "Offline Firmware", port);
    }
  });
});

// ---------------------------------------------------------------------------
// Firmware: custom .bin
// ---------------------------------------------------------------------------

btnSelectFw.addEventListener("click", async () => {
  if (state.otaMethod === "ble" && !(await ensureBleConnected())) return;
  fwInput.click();
});

fwInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  fwInput.value = "";
  if (!file) return;

  let buffer;
  try {
    buffer = new Uint8Array(await file.arrayBuffer());
    await validateEsp32FirmwareBinary(buffer);
  } catch (err) {
    console.error(err);
    setStatus("Ungültige Firmware-Datei: " + err.message, "err");
    await showMessage({ title: "Ungültige Firmware-Datei", tone: "err", text: err.message, detail: file.name });
    return;
  }

  if (state.otaMethod === "ble") {
    if (!(await ensureBleConnected())) return;
    const confirmed = await showMessage({
      title: "Eigene Firmware flashen?",
      tone: "warn",
      text: "Die Datei wird per Bluetooth auf das verbundene E-Paper übertragen und ersetzt die laufende Firmware.",
      detail: `${file.name} · ${(file.size / 1024).toFixed(1)} KB`,
      okLabel: "Ja, flashen",
      cancelLabel: "Abbrechen",
      okVariant: "signal",
    });
    if (!confirmed) return;
    await runTransfer({ title: "Firmware wird installiert", abortable: true, successTitle: "Firmware installiert", failTitle: "Firmware-Update fehlgeschlagen", stickySuccess: true }, () => bleInterface.uploadFirmware(buffer));
  } else {
    openUsbFlashDialog(buffer, file.name, (file.size / 1024).toFixed(1) + " KB", APP_ADDRESS, "Firmware");
  }
});

// ---------------------------------------------------------------------------
// Certificates (SPIFFS partition) via USB
// ---------------------------------------------------------------------------

btnSelectSpiffs.addEventListener("click", () => spiffsInput.click());

spiffsInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  spiffsInput.value = "";
  if (!file) return;

  if (file.size === 0 || file.size > SPIFFS_SIZE) {
    // Anything larger would be written past the partition into the coredump area.
    await showMessage({
      title: "Datei passt nicht in die SPIFFS-Partition",
      tone: "err",
      text: `Die Partition ist ${SPIFFS_SIZE / 1024} KB groß. Bitte wähle das Zertifikat-Backup (.bin) dieses Geräts.`,
      detail: `${file.name} · ${(file.size / 1024).toFixed(1)} KB`,
    });
    return;
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  openUsbFlashDialog(buffer, file.name, (file.size / 1024).toFixed(1) + " KB", SPIFFS_ADDRESS, "SPIFFS (Zertifikat)");
});

async function backupSpiffsSerial(port) {
  let transport = null;
  try {
    const loader = await openEspLoader(port);
    transport = loader.transport;
    const esploader = loader.esploader;

    setStatus("Lade Bootloader…", "busy");
    await esploader.main();

    setStatus("Lese SPIFFS Zertifikat-Partition aus…", "busy");
    const spiffsData = await esploader.readFlash(SPIFFS_ADDRESS, SPIFFS_SIZE, (packet, current, total) => {
      const percent = Math.round((current / total) * 100);
      setProgress(percent);
      setStatus(`Lese SPIFFS Zertifikate: ${percent}% (${Math.round(current / 1024)} KB / ${Math.round(total / 1024)} KB)...`, "busy");
    });

    // Detect EPD number (e.g. epd7-3485188f1dc8) from SPIFFS partition data or chip MAC
    let epdNumber = "";
    try {
      const spiffsText = new TextDecoder("latin1").decode(spiffsData);
      const match = spiffsText.match(/epd\d+-[0-9a-fA-F]+/i);
      if (match) {
        epdNumber = match[0].toLowerCase();
      }
    } catch (scanErr) {
      console.warn("Failed scanning SPIFFS for EPD identifier:", scanErr);
    }

    if (!epdNumber) {
      try {
        if (esploader.chip && typeof esploader.chip.readMac === "function") {
          const rawMac = await esploader.chip.readMac(esploader);
          if (rawMac) {
            const cleanMac = rawMac.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
            const prefix = displaySizeSelect.value === "13" || offlineOtaDeviceSelect.value === "epd13" ? "epd13-" : "epd7-";
            epdNumber = prefix + cleanMac;
          }
        }
      } catch (macErr) {
        console.warn("Could not read chip MAC:", macErr);
      }
    }

    if (!epdNumber && bleInterface.bleDevice?.name && bleInterface.bleDevice.name.toLowerCase().startsWith("epd")) {
      epdNumber = bleInterface.bleDevice.name.toLowerCase().trim();
    }

    try {
      await esploader.after("hard_reset");
    } catch (resetErr) {
      console.warn("Hard reset attempt:", resetErr);
    }

    setProgress(100);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = epdNumber ? `spiffs_backup_${epdNumber}_${dateStr}.bin` : `spiffs_certificates_backup_${dateStr}.bin`;
    downloadBlob(new Blob([spiffsData], { type: "application/octet-stream" }), filename);

    setStatus(`✅ SPIFFS Zertifikate erfolgreich heruntergeladen (${filename}, 256 KB)!`, "ok");
  } catch (err) {
    console.error("Backup SPIFFS Error:", err);
    throw new Error(describeSerialError(err));
  } finally {
    await closeTransport(transport);
  }
}

btnBackupSpiffs.addEventListener("click", () => openDialog(usbBackupDialog));
btnCancelUsbBackup.addEventListener("click", () => closeDialog(usbBackupDialog));

btnConfirmUsbBackup.addEventListener("click", async () => {
  const port = await pickSerialPort();
  closeDialog(usbBackupDialog);
  if (!port) return;

  await runTransfer({ title: "Zertifikate werden gesichert", successTitle: "Backup gespeichert", failTitle: "Backup fehlgeschlagen", stickySuccess: true }, () => backupSpiffsSerial(port));
});

// ---------------------------------------------------------------------------
// Serial debug monitor
// ---------------------------------------------------------------------------

const SERIAL_LOG_MAX_CHARS = 200000;
let serialMonitor = null; // { port, reader, closed }
let serialLogLength = 0;

function appendSerialLog(text) {
  const stickToBottom = serialLogOutput.scrollHeight - serialLogOutput.scrollTop - serialLogOutput.clientHeight < 40;
  serialLogOutput.append(text);
  serialLogLength += text.length;
  if (serialLogLength > SERIAL_LOG_MAX_CHARS) {
    // keep the newest half – an unbounded log slows the page down more and more
    const kept = serialLogOutput.textContent.slice(-SERIAL_LOG_MAX_CHARS / 2);
    serialLogOutput.textContent = kept;
    serialLogLength = kept.length;
  }
  if (stickToBottom) serialLogOutput.scrollTop = serialLogOutput.scrollHeight;
}

function updateSerialMonitorUi() {
  const active = Boolean(serialMonitor);
  btnToggleSerialMonitor.textContent = active ? "Monitor trennen" : "Monitor verbinden";
  btnToggleSerialMonitor.classList.toggle("btn-neu-danger-text", active);
}

async function disconnectSerialMonitor() {
  const monitor = serialMonitor;
  if (!monitor) return;
  serialMonitor = null;
  try {
    await monitor.reader.cancel();
  } catch (e) {
    console.warn("Reader cancel error:", e);
  }
  // The port can only be closed after the pipe has released its lock on port.readable.
  await monitor.closed;
  try {
    await monitor.port.close();
  } catch (e) {
    console.warn("Serial port close error:", e);
  }
  updateSerialMonitorUi();
}

async function connectSerialMonitor() {
  const port = await pickSerialPort();
  if (!port) return;

  try {
    await port.open({ baudRate: 115200 });
  } catch (err) {
    console.error("Serial Monitor Error:", err);
    setStatus("Serieller Monitor: " + describeSerialError(err), "err");
    return;
  }

  const textDecoder = new TextDecoderStream();
  const closed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
  const reader = textDecoder.readable.getReader();
  serialMonitor = { port, reader, closed };
  serialLogBox.hidden = false;
  updateSerialMonitorUi();
  setStatus("Serieller Monitor verbunden (115200 Baud).", "ok");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) appendSerialLog(value);
    }
  } catch (err) {
    console.error("Serial Monitor Error:", err);
    setStatus("Serieller Monitor: Verbindung verloren (" + err.message + ").", "warn");
  } finally {
    // also reached when the device is unplugged
    await disconnectSerialMonitor();
  }
}

btnToggleSerialMonitor.addEventListener("click", async () => {
  if (serialMonitor) {
    await disconnectSerialMonitor();
    setStatus("Serieller Monitor getrennt.", "idle");
  } else {
    await connectSerialMonitor();
  }
});

btnClearSerialLog.addEventListener("click", () => {
  serialLogOutput.textContent = "";
  serialLogLength = 0;
});

// ---------------------------------------------------------------------------
// Release channel (stable "main" / preview "dev")
// ---------------------------------------------------------------------------

const CHANNEL_LABEL = { main: "Stabil", dev: "Vorschau" };
const versionDialog = $("versionDialog");

/** main is published at the site root, dev in ./dev/ below it. */
function channelUrl(channel) {
  const here = new URL("./", location.href);
  if (channel === RELEASE_CHANNEL) return here;
  return new URL(IS_DEV_CHANNEL ? "../" : "dev/", here);
}

/** "main · v0.1.0 · a827d05" */
function describeBuild(channel, info) {
  const parts = [channel];
  if (info?.fwVersion) parts.push(`v${info.fwVersion}`);
  if (info?.commit) parts.push(String(info.commit).slice(0, 7));
  return parts.join(" · ");
}

function openVersionDialog() {
  if (state.busy) return;
  const notes = [];
  if (state.conn !== "disconnected") notes.push("Beim Wechsel wird die Bluetooth-Verbindung getrennt – danach einfach neu verbinden.");
  if (state.hasImage) notes.push("Das geladene Bild muss neu ausgewählt werden.");
  const note = $("versionSwitchNote");
  note.textContent = notes.join(" ");
  note.hidden = notes.length === 0;
  openDialog(versionDialog);
}

/** Loads the other version: a complete build with its own web UI and its own firmware. */
function switchChannel(target) {
  closeDialog(versionDialog);
  if (target === RELEASE_CHANNEL || state.busy) return;
  // keep the current view (#firmware, …)
  location.href = channelUrl(target).href + location.hash;
}

async function initReleaseChannel() {
  const ownInfo = { fwVersion: EXPECTED_FW_VERSION, commit: BUILD_COMMIT };
  const buildInfo = $("buildInfo");
  buildInfo.textContent = "Version: " + (RELEASE_CHANNEL === "local" ? ["Lokaler Build", `v${EXPECTED_FW_VERSION}`].join(" · ") : `${CHANNEL_LABEL[RELEASE_CHANNEL]} (${describeBuild(RELEASE_CHANNEL, ownInfo)})`);
  buildInfo.hidden = false;

  if (RELEASE_CHANNEL === "local") return; // nothing to switch to

  // The offline firmware card names the build it flashes: always the one of this web UI.
  const fwBadge = $("offlineFwChannelBadge");
  fwBadge.textContent = describeBuild(RELEASE_CHANNEL, { commit: BUILD_COMMIT });
  fwBadge.classList.toggle("badge-mode", IS_DEV_CHANNEL);
  fwBadge.hidden = false;

  if (IS_DEV_CHANNEL) {
    $("channelBanner").hidden = false;
    document.documentElement.classList.add("has-env-banner");
  }

  // Offer the switch only if the other version is really deployed next to this one.
  const other = IS_DEV_CHANNEL ? "main" : "dev";
  let otherInfo = null;
  try {
    const res = await fetch(new URL("channel.json", channelUrl(other)), { cache: "no-store" });
    if (res.ok) otherInfo = await res.json();
  } catch (e) {
    console.info("Release channel check:", e);
  }
  if (otherInfo?.channel !== other) return;

  const infos = { [RELEASE_CHANNEL]: ownInfo, [other]: otherInfo };
  $("channelMainInfo").textContent = describeBuild("main", infos.main);
  $("channelDevInfo").textContent = describeBuild("dev", infos.dev);
  for (const [channel, btn] of [
    ["main", $("btnChannelMain")],
    ["dev", $("btnChannelDev")],
  ]) {
    const current = channel === RELEASE_CHANNEL;
    btn.setAttribute("aria-pressed", String(current));
    btn.setAttribute("aria-label", `${CHANNEL_LABEL[channel]} (${channel})${current ? " – aktuell geöffnet" : " – jetzt wechseln"}`);
    btn.addEventListener("click", () => switchChannel(channel));
  }
  $("btnCloseVersion").addEventListener("click", () => closeDialog(versionDialog));

  const btnVersion = $("btnVersion");
  $("versionLabel").textContent = IS_DEV_CHANNEL ? "Dev" : "Stabil";
  btnVersion.dataset.channel = RELEASE_CHANNEL;
  btnVersion.setAttribute("aria-label", `Version: ${CHANNEL_LABEL[RELEASE_CHANNEL]} (${RELEASE_CHANNEL}). Version wechseln`);
  btnVersion.hidden = false;
  btnVersion.addEventListener("click", openVersionDialog);

  if (IS_DEV_CHANNEL) {
    const bannerSwitch = $("btnChannelBannerSwitch");
    bannerSwitch.hidden = false;
    bannerSwitch.addEventListener("click", openVersionDialog);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initNavigation();
initDialogs();
initCollapsibles();
renderPaletteEditor();
updateSliderOutputs();
setOtaMode("ble");
syncUi();
initReleaseChannel();

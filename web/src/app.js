import { GeneratePicture } from "./GeneratePicture.js";
import { DeviceBleInterface, validateEsp32FirmwareBinary } from "./DeviceBleInterface.js";
import { ESPLoader, Transport } from "esptool-js";
import { Gallery } from "./gallery.js";
import { openGalleryStore } from "./galleryStore.js";
import { DISPLAYS, GALLERY_HEADER_SIZE, GALLERY_MAX_ITEMS, GALLERY_WINDOW_BITS, buildContainer, parseContainer, readContainerHeader, repackContainer, idOf, makeThumb, rawToPng } from "./galleryFormat.js";
import { bootloaderAnswers, requestBootloader, readBootLog } from "./serialBoot.js";
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
  batteryOffMv: 4000, // BAT_OFF_VALUE: below this the device only sleeps when it runs on batteries
};

// 4 AA cells (alkaline or NiMH): about 1.1 V per cell is nearly empty for both.
const BATTERY_LOW_MV = 4400;

// Flash layout (part.csv)
const APP_ADDRESS = 0x10000; // app0, the first of the two app slots
const OTADATA_ADDRESS = 0xe000; // selects the app slot the bootloader starts
const OTADATA_SIZE = 0x2000;
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
const canConnect = bluetoothAvailable || serialAvailable; // Bluetooth or the USB link

/** The side of "Bild" that was open last. */
function storedSource() {
  try {
    return localStorage.getItem("bildSource") === "url" ? "url" : "gallery";
  } catch (e) {
    return "gallery";
  }
}

/** Central UI state – every enabled/disabled/visible decision is derived from it in syncUi(). */
const state = {
  conn: "disconnected", // "disconnected" | "connecting" | "connected" | "reconnecting"
  busy: false, // a transfer (upload / flash / backup) is running
  hasImage: false,
  otaMethod: "ble", // "ble" | "serial"
  source: storedSource(), // view "Bild": "gallery" | "url"
  deviceMode: null, // what the connected device shows: 0 = gallery, 1 = download URL, null = unknown
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
const systemStatusBar = $("systemStatusBar");
const notConnectedState = $("notConnectedState");

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
const settingSettingsUrl = $("settingSettingsUrl");
const settingHttpAuthUser = $("settingHttpAuthUser");
const settingHttpAuthPassword = $("settingHttpAuthPassword");
const settingMotionWakeup = $("settingMotionWakeup");
const settingChargerMode = $("settingChargerMode");
const settingAutoRotation = $("settingAutoRotation");

const galleryGrid = $("galleryGrid");
const galleryEmpty = $("galleryEmpty");
const galleryFileInput = $("galleryFileInput");
const galleryDisplayBadge = $("galleryDisplayBadge");
// The last box of the grid: adds pictures.
const btnAddPictures = document.createElement("button");
btnAddPictures.type = "button";
btnAddPictures.id = "btnAddPictures";
btnAddPictures.className = "tile-add-btn";
btnAddPictures.textContent = "+";
btnAddPictures.setAttribute("aria-label", "Bilder hinzufügen");
btnAddPictures.title = "Bilder hinzufügen";
const addTile = document.createElement("li");
addTile.className = "tile-add";
addTile.appendChild(btnAddPictures);
const btnSyncGallery = $("btnSyncGallery");
const syncHint = $("syncHint");
const galleryInterval = $("galleryInterval");
const galleryIntervalUnit = $("galleryIntervalUnit");

const editorDialog = $("editorDialog");
const editorDeviceNote = $("editorDeviceNote");
const btnSaveToGallery = $("btnSaveToGallery");
const btnDownloadBin = $("btnDownloadBin");
const canvas = $("previewCanvas");
const previewHoverCanvas = $("previewHoverCanvas");
const previewContainer = $("previewContainer");
const previewEmpty = $("previewEmpty");
const previewStage = $("previewStage");
const previewRawFlag = $("previewRawFlag");
const displayBadge = $("displayBadge");
const displayAutoBadge = $("displayAutoBadge");
const displaySizeSelect = $("displaySizeSelect");
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

function syncUi() {
  const connected = state.conn === "connected";
  const pending = state.conn === "connecting" || state.conn === "reconnecting";
  const busy = state.busy;

  // App bar: one button whose meaning follows the connection state
  btnConnect.hidden = connected || pending;
  btnConnect.disabled = !canConnect;
  btnDisconnect.hidden = !(connected || pending);
  btnDisconnect.textContent = connected ? "Trennen" : "Abbrechen";
  document.querySelectorAll('[data-action="connect"]').forEach((btn) => {
    btn.disabled = !canConnect || pending;
    btn.textContent = pending ? "Verbinde…" : "Mit E-Paper verbinden";
  });

  systemStatusBar.hidden = !connected;
  notConnectedState.hidden = connected;
  // left box: the WLAN of a connected device, else the hint how to connect
  $("wifiCard").hidden = !connected;
  $("deviceSettings").hidden = !connected; // without a device the settings only hold the way to connect
  $("bleCloudHint").hidden = connected || state.otaMethod !== "ble"; // a connected device is reachable

  // Bild: the gallery, or the download from a URL (stored on the device)
  $("btnSourceGallery").setAttribute("aria-pressed", String(state.source === "gallery"));
  $("btnSourceUrl").setAttribute("aria-pressed", String(state.source === "url"));
  $("sourceGallery").hidden = state.source !== "gallery";
  $("sourceUrl").hidden = state.source !== "url";
  // which of the two the connected device uses
  $("sourceGalleryActive").hidden = !connected || state.deviceMode !== 0;
  $("sourceUrlActive").hidden = !connected || state.deviceMode !== 1;

  // Editor
  btnRotate.hidden = !state.hasImage;
  btnRotate.disabled = busy;
  btnAutoDither.disabled = !state.hasImage || busy;
  btnDownloadBin.disabled = !state.hasImage || busy;
  btnSaveToGallery.disabled = !state.hasImage || busy;

  // Gallery. Syncing also works without a connection: the button then leads through connecting
  // first. That needs Web Bluetooth or Web Serial, though.
  const cannotConnect = !connected && !canConnect;
  btnSyncGallery.disabled = busy || cannotConnect || (connected && !bleInterface.gallerySupported);
  syncHint.textContent = galleryHint;
  syncHint.hidden = !galleryHint;
  [btnAddPictures, $("btnOrientLandscape"), $("btnOrientPortrait"), galleryInterval, galleryIntervalUnit, $("btnPlayOrder"), $("btnPlayShuffle"), $("btnPlayAuto"), $("btnPlayManual")].forEach((el) => {
    el.disabled = busy;
  });

  // Device settings
  btnSaveWifi.disabled = busy;
  btnSaveSettings.disabled = busy || (!connected && !canConnect);
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
    const outcome = await task();
    ok = true;
    finishTransfer({ ok: true, title: outcome?.title || successTitle, message: currentStatus.text, sticky: stickySuccess || Boolean(outcome?.sticky) });
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

/**
 * Sets one value of the device strip. `short` is the form for narrow screens, where all four
 * values share one row (shown by CSS in place of the text).
 */
function setChip(valueId, text, tone = "neutral", short = "") {
  const valueEl = $(valueId);
  if (!valueEl) return;
  valueEl.textContent = text;
  if (short && short !== text) valueEl.dataset.short = short;
  else delete valueEl.dataset.short;
  valueEl.parentElement.dataset.tone = tone;
}

/** "epd13-9c139ecf61a8" -> "epd13-…61a8": the type and the end of the id tell the frames apart. */
function shortDeviceName(name) {
  const match = /^([a-z]+\d+)-([0-9a-f]{6,})$/i.exec(name);
  return match ? `${match[1]}-…${match[2].slice(-4)}` : name;
}

bleInterface.onStatusChange = (text, level) => {
  setStatus(text, level);
};

bleInterface.onConnectionStateChange = (connectionState) => {
  if (connectionState === "connecting") userConnect = true;
  if (connectionState === "reconnecting") userConnect = false;
  state.conn = connectionState;
  // connecting was cancelled or failed for good: nothing is synced later on its own
  if (connectionState === "disconnected") syncAfterConnect = false;
  renderGallery();
};

bleInterface.onConnected = (isPaperL) => {
  const is13Inch = Boolean(isPaperL);
  applyDisplayProfile(is13Inch, true);

  document.title = is13Inch ? 'paper L Setup (13.3")' : 'paper 7 Setup (7.3")';
  const deviceName = bleInterface.bleDevice?.name || "E-Paper";
  setChip("systemDeviceName", `${deviceName} · ${is13Inch ? '13.3"' : '7.3"'}`, "neutral", shortDeviceName(deviceName));

  state.conn = "connected";
  renderGallery();

  // "Synchronisieren" was pressed before a device was connected: the sync starts now.
  if (syncAfterConnect) {
    syncAfterConnect = false;
    if (connectPurpose === "url") saveDeviceSettings();
    else startGallerySync();
  } else {
    offerSyncAfterList = userConnect; // not after a link that came back on its own
    refreshDeviceGallery();
  }
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
  setChip("systemChargerStatus", "Prüfe…", "neutral", "…");

  finishWifiScan();
  wifiList.replaceChildren();
  wifiListBox.hidden = true;

  listRev = null;
  offerSyncAfterList = false;
  state.deviceMode = null;
  syncBadgeSettings.hidden = true;
  $("syncBadgePlay").hidden = true;
  gallery.clearDevice(); // renders the gallery and the buttons
};

btnConnect.addEventListener("click", () => startConnect());
document.querySelectorAll('[data-action="connect"]').forEach((btn) => btn.addEventListener("click", () => startConnect()));
btnDisconnect.addEventListener("click", () => bleInterface.disconnect());

// --- Bluetooth or USB: asked every time, or chosen once under "Gerät" ---

const CONNECT_WAYS = ["ask", "ble", "usb"];
const connectWaySelect = $("connectWaySelect");
let connectWay = "ask";
try {
  const stored = localStorage.getItem("connectWay");
  if (CONNECT_WAYS.includes(stored)) connectWay = stored;
} catch (e) {
  // private mode: asks every time
}

/** The way "Verbinden" takes: the choice, as far as this browser offers it. */
function effectiveConnectWay() {
  if (!serialAvailable) return "ble";
  if (!bluetoothAvailable) return "usb";
  return connectWay;
}

function renderConnectWay() {
  const way = effectiveConnectWay();
  connectWaySelect.value = way;
  connectWaySelect.disabled = !bluetoothAvailable || !serialAvailable;
  $("connectWayHint").textContent =
    !bluetoothAvailable || !serialAvailable
      ? `Dieser Browser kann das E-Paper nur per ${serialAvailable ? "USB-Kabel" : "Bluetooth"} verbinden.`
      : { ask: "„Verbinden“ fragt jedes Mal, ob per Bluetooth oder USB-Kabel.", ble: "„Verbinden“ nimmt ohne Nachfrage Bluetooth.", usb: "„Verbinden“ nimmt ohne Nachfrage das USB-Kabel." }[way];
}

connectWaySelect.addEventListener("change", () => {
  connectWay = connectWaySelect.value;
  try {
    localStorage.setItem("connectWay", connectWay);
  } catch (e) {
    // lasts for this visit
  }
  renderConnectWay();
});
renderConnectWay();

/**
 * Starts connecting. Must run directly inside a click (the choosers need a user gesture).
 * sync: once the device is connected, the gallery or the download settings are synced (connectPurpose).
 */
async function startConnect({ sync = false } = {}) {
  if (state.conn !== "disconnected") return;
  const way = effectiveConnectWay();
  if (way === "ask") {
    openConnectDialog(sync);
  } else if (way === "usb") {
    syncAfterConnect = (await connectUsb()) && sync;
  } else {
    syncAfterConnect = sync;
    bleInterface.connect();
  }
}

/** Connects over the USB cable: everything that works over Bluetooth, on the serial line. */
async function connectUsb() {
  if (state.conn !== "disconnected") return false;
  const port = await pickSerialPort(); // must run directly inside the click
  if (!port) return false;
  bleInterface.connect({ usbPort: port });
  return true;
}

if (!bluetoothAvailable) {
  $("bluetoothUnsupported").hidden = false;
  if (!window.isSecureContext) {
    $("bluetoothUnsupportedText").textContent = "Web Bluetooth funktioniert nur über eine sichere Verbindung (HTTPS oder localhost). Galerie, Bild-Editor und BMP-Download funktionieren trotzdem.";
  } else if (serialAvailable) {
    $("bluetoothUnsupportedText").textContent = "Dieser Browser unterstützt kein Web Bluetooth. „Verbinden“ nutzt hier das USB-Kabel.";
  }
  setStatus("Bluetooth ist in diesem Browser nicht verfügbar – Galerie, Bild-Editor und Download funktionieren trotzdem.", "warn");
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
    setChip("systemFwVersion", "Veraltet ⚠", "warn", "alt ⚠");
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
    setChip("systemVoltage", "Keine Batterie", "warn", "keine");
  } else if (info.charging) {
    setChip("systemVoltage", `${v} V · lädt`, "ok", `${v} V`);
  } else if (info.voltage >= BATTERY_LOW_MV) {
    setChip("systemVoltage", `${v} V`, "ok");
  } else if (info.voltage >= DEVICE_LIMITS.batteryOffMv) {
    setChip("systemVoltage", `${v} V · schwach`, "warn", `${v} V`);
  } else {
    // Without USB power the device would not be awake at this voltage.
    setChip("systemVoltage", `${v} V · leer`, "err", `${v} V`);
  }

  if (info.usb) {
    setChip("systemChargerStatus", info.charging ? "Verbunden · lädt" : "Verbunden", info.charging ? "ok" : "info", info.charging ? "lädt" : "an");
  } else {
    setChip("systemChargerStatus", "Nicht verbunden", "neutral", "aus");
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
  $("btnCancelWifi").hidden = true; // only while a working network is being changed
}

bleInterface.onWifiStatusChange = (isConnected) => {
  updateWifiStatusUI(isConnected);
};

bleInterface.onWifiInfoChange = (info) => {
  if (!info.ip) return;
  infoIp.textContent = info.ip;
  infoRssi.textContent = info.rssi + " dBm";
  // Older firmware does not report the network name: the device then joined the one in the field.
  infoSsid.textContent = info.ssid || wifiSsid.value.trim() || "Netzwerk";
  if (info.rssi > -60) infoQuality.textContent = "Ausgezeichnet";
  else if (info.rssi > -75) infoQuality.textContent = "Gut";
  else infoQuality.textContent = "Schwach";
};

btnEditWifi.addEventListener("click", () => {
  updateWifiStatusUI(false);
  $("btnCancelWifi").hidden = false;
  wifiSsid.focus();
});

$("btnCancelWifi").addEventListener("click", () => {
  wifiPass.value = "";
  [wifiSsid, wifiPass].forEach((el) => setFieldError(el, ""));
  wifiSsid.value = infoSsid.textContent; // the network the device is still connected to
  updateWifiStatusUI(true);
  btnEditWifi.focus();
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

let settingsDirty = false; // the download settings were edited and are not on the device

function markSettingsDirty(dirty) {
  settingsDirty = dirty;
  settingsSaveZone.classList.toggle("settings-dirty", dirty);
}

function updateTimeoutHint() {
  const seconds = parseInt(settingTimeout.value, 10);
  const readable = formatDuration(seconds);
  settingTimeoutHint.textContent = readable ? `= ${readable} · erlaubt sind 60 Sekunden bis 30 Tage.` : "60 Sekunden bis 30 Tage.";
}

bleInterface.onSettingsLoaded = (settings) => {
  if (settings.imageMode !== undefined) {
    // without a URL there is nothing to download: the device then waits for a gallery
    state.deviceMode = settings.imageMode === 1 && settings.url ? 1 : 0;
  }
  // Download settings that were prepared here before connecting are kept: they are what the
  // user wants on the device.
  const keepForm = settingsDirty;
  if (settings.url !== undefined && !keepForm) {
    settingUrl.value = settings.url;
    syncBadgeSettings.hidden = false;
  }
  if (settings.timeout !== undefined) {
    if (!keepForm) {
      settingTimeout.value = settings.timeout;
      syncBadgeSettings.hidden = false;
    }
    setGalleryInterval(settings.timeout);
    intervalDirty = false;
  }
  if (settings.httpAuthUser !== undefined && !keepForm) settingHttpAuthUser.value = settings.httpAuthUser;
  if (settings.motionWakeup !== undefined) settingMotionWakeup.checked = settings.motionWakeup;
  if (settings.chargerMode !== undefined) settingChargerMode.checked = settings.chargerMode;
  if (settings.autoRotation !== undefined) settingAutoRotation.checked = settings.autoRotation;
  if (settings.settingsUrl !== undefined && !keepForm) settingSettingsUrl.value = settings.settingsUrl;
  if (settings.wifiSsid !== undefined) {
    wifiSsid.value = settings.wifiSsid;
    syncBadgeWifi.hidden = false;
  }

  updateTimeoutHint();
  if (keepForm) return;
  [settingUrl, settingTimeout, settingSettingsUrl, settingHttpAuthUser, settingHttpAuthPassword].forEach((el) => setFieldError(el, ""));
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

// --- Check of the picture behind the download URL ---

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

  // A download URL replaces the gallery on the device.
  const stored = Number(gallery.deviceState?.count) || 0;
  const replacesGallery = Boolean(settings.url) && state.deviceMode !== 1 && bleInterface.gallerySupported && stored > 0;
  if (replacesGallery) {
    const confirmed = await showMessage({
      title: "Auf Abruf per URL umstellen?",
      tone: "warn",
      text: `Das E-Paper zeigt dann das Bild der Download-URL. Die ${pictures(stored)} der Galerie werden vom Gerät gelöscht (in diesem Browser bleiben sie erhalten). Als Intervall gilt das Aktualisierungs-Intervall von hier, nicht mehr der Bildwechsel der Galerie.`,
      okLabel: "Umstellen",
      cancelLabel: "Abbrechen",
      okVariant: "danger",
    });
    if (!confirmed) return false;
  }

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
    if (settings.url) state.deviceMode = 1; // a stored URL switches the device to the download
    if (replacesGallery) {
      try {
        await bleInterface.galleryClear();
        refreshDeviceGallery();
      } catch (e) {
        setStatus("Einstellungen gespeichert, die Galerie auf dem E-Paper ließ sich aber nicht löschen: " + e.message, "warn");
      }
    }
    syncBadgeSettings.hidden = false;
    markSettingsDirty(false);
    setGalleryInterval(settings.timeout || "3600");
    intervalDirty = false;
    renderGallery();
    if (settings.url) offerToStartDownload(); // not awaited: the caller goes on with the result
  } else if (!bleInterface.isConnected) {
    setStatus("Nicht gespeichert: Das E-Paper ist nicht verbunden.", "err");
  }
  return success;
}

/** The device starts the download once the setup mode has ended: stay connected, or disconnect now? */
async function offerToStartDownload() {
  if (!bleInterface.isConnected) return;
  const leave = await showMessage({
    title: "Abruf jetzt starten?",
    text: "Die Einstellungen sind gespeichert. Das E-Paper lädt das Bild, sobald die Verbindung getrennt ist. Du kannst jetzt trennen – oder verbunden bleiben und weitere Einstellungen vornehmen.",
    okLabel: "Trennen und laden",
    cancelLabel: "Verbunden bleiben",
    okVariant: "signal",
  });
  if (leave && bleInterface.isConnected) bleInterface.disconnect();
}

/**
 * "Synchronisieren" of the download settings: stores them on the device. Without a connection
 * it leads through connecting first and stores them then (see onConnected).
 */
async function syncUrlSettings() {
  if (state.busy) return false;
  if (bleInterface.isConnected) return saveDeviceSettings();
  if (!validateSettingsForm()) {
    setStatus("Bitte die markierten Felder korrigieren.", "err");
    settingsForm.querySelector('[aria-invalid="true"]')?.focus();
    return false;
  }
  markSettingsDirty(true); // what the form says goes to the device, not the other way round
  connectPurpose = "url";
  if (state.conn !== "disconnected") {
    syncAfterConnect = true;
    setStatus("Verbindung wird aufgebaut – die Einstellungen werden danach übertragen.", "busy");
  } else {
    startConnect({ sync: true });
  }
  return false;
}

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  syncUrlSettings();
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
  // Like the device: the file can switch the charger off, never on. Switching it on needs the
  // confirmation that rechargeable batteries are inserted (the switch on this page).
  const chargerIgnored = Boolean(tempJsonSettings.chargerMode) && !settingChargerMode.checked;
  if (tempJsonSettings.chargerMode === false) settingChargerMode.checked = false;
  if (tempJsonSettings.autoRotation !== undefined) settingAutoRotation.checked = Boolean(tempJsonSettings.autoRotation);
  updateTimeoutHint();
  markSettingsDirty(true);

  const saved = await syncUrlSettings();
  if (saved && chargerIgnored) {
    setStatus("Einstellungen gespeichert. „chargerMode: true“ aus der Datei wurde nicht übernommen: Der Charger Mode lässt sich nur mit dem Schalter einschalten.", "warn");
  }
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
      okLabel: "Ja, NiMH eingelegt",
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
// Display format
// ---------------------------------------------------------------------------

let EPD_WIDTH = 800;
let EPD_HEIGHT = 480;
let displayLockedToDevice = false;

/** "7" or "13": the display the pictures are prepared for. */
function currentDisplay() {
  return EPD_WIDTH === 1200 ? "13" : "7";
}

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

  applyOrientationLayout();
  displayBadge.textContent = isPaperL ? '13.3" · 1200×1600' : '7.3" · 800×480';
  galleryDisplayBadge.textContent = isPaperL ? '13.3"' : '7.3"';
  displaySizeSelect.value = isPaperL ? "13" : "7";
  displaySizeSelect.disabled = lockToDevice;
  displaySizeSelect.title = lockToDevice ? `Automatisch an verbundenes Gerät angepasst (${isPaperL ? '13.3"' : '7.3"'})` : "";
  displayAutoBadge.hidden = !lockToDevice;

  const deviceCode = isPaperL ? "epd13" : "epd7";
  otaDeviceSelect.value = deviceCode;
  offlineOtaDeviceSelect.value = deviceCode;

  const img = generatePicture.getOriginalImage();
  if (img && dimsChanged) {
    generatePicture.setImageRotation(orientationRotation());
    updatePreview();
  }
  if (dimsChanged) renderGallery();
}

// --- Orientation of the frame ---

/** The picture rows of this display are taller than wide. */
const rasterPortrait = (display) => DISPLAYS[display].height > DISPLAYS[display].width;

/** The frame hangs upright (true) or across (false). Not chosen yet: as its display is built. */
function framePortrait(display = currentDisplay()) {
  return gallery.play.portrait ?? rasterPortrait(display);
}

/** How a picture is turned so that it is upright on the frame. */
function orientationRotation(display = currentDisplay()) {
  return framePortrait(display) !== rasterPortrait(display) ? 270 : 0;
}

/** Preview and tiles show the pictures as the frame hangs. */
function applyOrientationLayout() {
  const turned = orientationRotation() !== 0;
  const ratio = turned ? `${EPD_HEIGHT} / ${EPD_WIDTH}` : `${EPD_WIDTH} / ${EPD_HEIGHT}`;
  [previewContainer, galleryGrid].forEach((el) => {
    el.style.setProperty("--epd-ratio", ratio);
    el.toggleAttribute("data-turned", turned);
  });
}

displaySizeSelect.addEventListener("change", (e) => {
  if (bleInterface.isConnected) {
    applyDisplayProfile(bleInterface.isPaperL, true);
    return;
  }
  applyDisplayProfile(e.target.value === "13", false);
});

/** Size of the preview canvas for a display (the 13.3" preview is rendered at half size). */
function previewSizeFor(display) {
  const { width, height } = DISPLAYS[display];
  const scale = display === "13" ? 0.5 : 1;
  return [Math.floor(width * scale), Math.floor(height * scale)];
}

// ---------------------------------------------------------------------------
// Processing: from a picture and its edit settings to the picture file of the device
// ---------------------------------------------------------------------------

const DEFAULT_PALETTE = "new";
const plain = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));

let activeAutoOptions = null;
// After "Auto-Optimieren" the sliders show the suggested values. They only override the
// suggestion once the user actually moves one.
let toneSlidersTouched = false;

/** Edit settings of a picture, as they are stored with it. `rotation` belongs to `display`. */
function defaultUi(display = currentDisplay()) {
  return { palette: DEFAULT_PALETTE, matrix: "floydSteinberg", serpentine: true, brightness: 0, contrast: 0, saturation: 0, autoOptions: null, slidersTouched: false, customPalette: null, rotation: 0, display };
}

function readEditorUi() {
  return {
    palette: paletteSelect.value || "spectra6Custom",
    matrix: errorDiffusionMatrix.value,
    serpentine: serpentine.checked,
    brightness: parseInt(processingBrightness.value, 10) || 0,
    contrast: parseInt(processingContrast.value, 10) || 0,
    saturation: parseInt(processingSaturation.value, 10) || 0,
    autoOptions: plain(activeAutoOptions),
    slidersTouched: toneSlidersTouched,
    customPalette: plain(generatePicture.getCustomPalette()),
    rotation: generatePicture.getImageRotation(),
    display: currentDisplay(),
  };
}

function applyEditorUi(ui) {
  paletteSelect.value = ui.palette;
  errorDiffusionMatrix.value = ui.matrix;
  serpentine.checked = ui.serpentine;
  processingBrightness.value = ui.brightness;
  processingContrast.value = ui.contrast;
  processingSaturation.value = ui.saturation;
  updateSliderOutputs();
  activeAutoOptions = plain(ui.autoOptions);
  toneSlidersTouched = Boolean(ui.slidersTouched);
  generatePicture.setCustomPalette(plain(ui.customPalette));
  renderPaletteEditor();
}

function updateSliderOutputs() {
  [processingBrightness, processingContrast, processingSaturation].forEach((slider) => {
    const value = parseInt(slider.value, 10) || 0;
    $(slider.id + "Out").textContent = value > 0 ? "+" + value : String(value);
  });
}

/** What GeneratePicture needs for a set of edit settings. */
function processingInput(ui) {
  const options = ui.autoOptions ? { ...ui.autoOptions } : {};
  options.errorDiffusionMatrix = ui.matrix;
  options.serpentine = ui.serpentine;

  if (options.toneMapping && ui.slidersTouched) {
    // Without this the auto tone mapping always won and the sliders had no effect at all.
    const base = options.toneMapping;
    const merged = { ...base, exposure: ui.brightness / 100, contrast: ui.contrast / 100, saturation: ui.saturation / 100 };
    if (base.mode === "off") {
      merged.mode = "contrast";
    } else if (base.mode === "scurve" && ui.contrast !== 0) {
      // epdoptimize applies the contrast factor only in "contrast" mode; without a mode it
      // applies both the contrast and the S-curve.
      delete merged.mode;
      merged.strength = base.strength ?? 0.9;
    }
    options.toneMapping = merged;
  }

  return { palette: ui.palette || "spectra6Custom", matrix: ui.matrix, isSerpentine: ui.serpentine, brightness: ui.brightness, contrast: ui.contrast, saturation: ui.saturation, options };
}

/**
 * Suggested settings for the picture `gp` holds, analysed on `canvas` (preview size).
 * null if nothing was found; the canvas then shows the undithered picture.
 */
function suggestProcessing(gp, canvas, palette, matrix) {
  let result = null;
  try {
    result = gp.autoOptimise(canvas, palette);
  } catch (e) {
    console.error(e);
  }
  if (!result) return null;

  const options = result.resolvedOptions || result;
  options.errorDiffusionMatrix = matrix;
  const tone = options.toneMapping;
  return {
    options,
    suggestion: result.suggestion,
    serpentine: options.serpentine ?? true,
    brightness: tone ? Math.round((tone.exposure ?? 0) * 100) || 0 : 0,
    contrast: tone ? Math.round((tone.contrast ?? 0) * 100) || 0 : 0,
    saturation: tone ? Math.round((tone.saturation ?? 0) * 100) || 0 : 0,
  };
}

// Pictures are prepared without the editor (quick add, another display) on an instance of their own.
const renderer = new GeneratePicture();

/** The automatic settings every picture starts with. */
function autoUi(img, display) {
  const { width, height } = DISPLAYS[display];
  const ui = defaultUi(display);
  ui.rotation = orientationRotation(display);
  renderer.setOriginalImage(img);
  renderer.setEpdDimensions(width, height);
  renderer.setCustomPalette(null);
  renderer.setImageRotation(ui.rotation);
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = previewSizeFor(display);
  const suggested = suggestProcessing(renderer, canvas, ui.palette, ui.matrix);
  renderer.setOriginalImage(null);
  if (suggested) {
    Object.assign(ui, { autoOptions: plain(suggested.options), serpentine: suggested.serpentine, brightness: suggested.brightness, contrast: suggested.contrast, saturation: suggested.saturation });
  }
  return ui;
}

/** The 4 bit per pixel payload of the display for a picture and its edit settings. */
async function renderRaw(img, ui, display) {
  const { width, height } = DISPLAYS[display];
  const input = processingInput(ui);
  renderer.setOriginalImage(img);
  renderer.setEpdDimensions(width, height);
  renderer.setCustomPalette(plain(ui.customPalette));
  // a rotation chosen for one display format does not fit the other
  renderer.setImageRotation(ui.display === display ? ui.rotation : orientationRotation(display));
  try {
    await renderer.generateFullBuffer(input.palette, input.matrix, input.isSerpentine, input.brightness, input.contrast, input.saturation, input.options);
    return renderer.getProcessedImageBuffer();
  } finally {
    renderer.setOriginalImage(null);
  }
}

/** Picture file, id and preview for a payload. */
async function buildRender(raw, display) {
  const thumbBytes = await makeThumb(raw, display);
  const container = await buildContainer(raw, display, thumbBytes);
  return {
    id: idOf(container),
    container: new Blob([container], { type: "application/octet-stream" }),
    size: container.length,
    w: GALLERY_WINDOW_BITS,
    thumb: thumbBytes.length ? new Blob([thumbBytes], { type: "image/jpeg" }) : null,
  };
}

/** Decodes a picture file. The caller revokes `url` when the picture is no longer used. */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Das Bild konnte nicht geladen werden. Bitte ein JPEG, PNG oder WebP wählen."));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Picture editor (dialog)
// ---------------------------------------------------------------------------

const editor = {
  item: null, // picture of the gallery that is open, null for a new one
  remote: null, // { id, container }: a picture read from the device that is not in the gallery
  file: null, // Blob of the original
  name: "",
  url: null, // object URL of the loaded picture
  touched: false, // something was changed since the picture was opened
  focusKey: null, // key of the tile that gets the focus when the editor closes
};

function collectProcessingInputs() {
  return processingInput(readEditorUi());
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
    setSimulationAvailable(hasSimulation);
    if (!previewQueued) setStatus("Bildvorschau optimiert. „Speichern“ übernimmt das Bild.", "ok");
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

[errorDiffusionMatrix, serpentine].forEach((el) =>
  el.addEventListener("change", () => {
    editor.touched = true;
    updatePreview();
  }),
);

[processingBrightness, processingContrast, processingSaturation].forEach((el) => {
  el.addEventListener("input", () => {
    toneSlidersTouched = true;
    editor.touched = true;
    updateSliderOutputs();
    schedulePreview();
  });
});

btnResetProcessing.addEventListener("click", () => {
  activeAutoOptions = null;
  toneSlidersTouched = false;
  editor.touched = true;
  processingBrightness.value = 0;
  processingContrast.value = 0;
  processingSaturation.value = 0;
  updateSliderOutputs();
  updatePreview();
});

// --- Opening and closing ---

function setEditorImage(img, url) {
  if (editor.url) URL.revokeObjectURL(editor.url);
  editor.url = url;
  generatePicture.setOriginalImage(img);
  state.hasImage = Boolean(img);
  previewEmpty.hidden = state.hasImage;
  previewStage.hidden = !state.hasImage;
}

function editorTitle() {
  return editor.remote ? "Bild vom Gerät" : "Bild bearbeiten";
}

/** Opens a picture of the gallery in the editor. */
async function openEditor(item) {
  if (state.busy || !item) return;
  Object.assign(editor, { item, remote: null, file: item.original || null, name: item.name || "", touched: false, focusKey: item.key });
  setEditorImage(null, null);
  editorDeviceNote.hidden = !item.fromDevice;
  applyEditorUi(item.ui || defaultUi());
  generatePicture.setImageRotation(0);
  $("imageSecTitle").textContent = editorTitle();
  openDialog(editorDialog);
  syncUi();

  try {
    const { img, url } = await loadImage(item.original);
    setEditorImage(img, url);
    // a rotation chosen for one display format does not fit the other
    generatePicture.setImageRotation(item.ui && item.ui.display === currentDisplay() ? item.ui.rotation : orientationRotation());
    syncUi();
    updatePreview();
  } catch (e) {
    setStatus("Das Original dieses Bildes kann nicht mehr geladen werden.", "err");
  }
}

/** Reads a picture that is only on the device and opens it in the editor. */
async function openRemotePicture(entry) {
  if (state.busy) return;
  let container = null;
  let parsed = null;
  const ok = await runTransfer({ title: "Bild wird vom Gerät geladen", abortable: true, failTitle: "Laden fehlgeschlagen" }, async () => {
    setStatus("Lade Bild vom E-Paper…", "busy");
    container = await bleInterface.readGalleryPicture(entry.id, (received, total) => {
      const percent = Math.round((received / total) * 100);
      setProgress(percent);
      setStatus(`Lade Bild vom E-Paper… ${percent}%`, "busy");
    });
    if (idOf(container) !== entry.id) throw new Error("Das Bild wurde nicht vollständig übertragen. Bitte erneut versuchen.");
    parsed = await parseContainer(container);
    setStatus("Bild vom E-Paper geladen.", "ok");
  });
  if (!ok) return;

  let png, img, url;
  try {
    png = await rawToPng(parsed.raw, parsed.display);
    ({ img, url } = await loadImage(png));
  } catch (e) {
    console.warn(e);
    setStatus("Das Bild vom E-Paper kann nicht angezeigt werden.", "err");
    return;
  }
  Object.assign(editor, { item: null, remote: { id: entry.id, container }, file: png, name: `Bild ${entry.id}`, touched: false, focusKey: null });
  // the pure display colours and no adjustments: an unchanged picture stays exactly as it is
  applyEditorUi({ ...defaultUi(), palette: "spectra6Original" });
  setEditorImage(img, url);
  generatePicture.setImageRotation(0);
  editorDeviceNote.hidden = false;
  $("imageSecTitle").textContent = editorTitle();
  openDialog(editorDialog);
  syncUi();
  updatePreview();
}

/** Closes the editor; unsaved changes are confirmed first. */
async function requestCloseEditor() {
  if (state.busy) return;
  if (editor.touched && state.hasImage) {
    const discard = await showMessage({
      title: "Änderungen verwerfen?",
      text: "Das Bild wurde geändert, aber noch nicht in der Galerie gespeichert.",
      okLabel: "Verwerfen",
      cancelLabel: "Weiter bearbeiten",
      okVariant: "danger",
    });
    if (!discard) return;
  }
  closeDialog(editorDialog);
}

editorDialog.addEventListener("cancel", (e) => {
  e.preventDefault(); // Escape: ask before changes are lost
  requestCloseEditor();
});
editorDialog.addEventListener("close", () => {
  clearTimeout(previewDebounce);
  const focusKey = editor.focusKey;
  setEditorImage(null, null);
  Object.assign(editor, { item: null, remote: null, file: null, name: "", touched: false, focusKey: null });
  syncUi();
  // the tiles were rebuilt meanwhile: the focus goes to the picture that was open
  const tile = focusKey && galleryGrid.querySelector(`[data-key="${focusKey}"] .tile-open`);
  (tile || btnAddPictures).focus();
});
$("btnCloseEditor").addEventListener("click", requestCloseEditor);

/** Marks a drop zone while files are dragged over it. */
function watchFileDrag(zone) {
  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      zone.classList.add("is-dragover");
    }),
  );
  ["dragleave", "dragend", "drop"].forEach((type) =>
    zone.addEventListener(type, (e) => {
      // dragleave also fires when moving onto a child element
      if (type === "dragleave" && zone.contains(e.relatedTarget)) return;
      zone.classList.remove("is-dragover");
    }),
  );
}

const imageFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith("image/"));

document.addEventListener("paste", (e) => {
  if (state.busy) return;
  const files = imageFiles(e.clipboardData?.files);
  if (!files.length) return;
  if (getCurrentView() === "bild" && state.source === "gallery" && !document.querySelector("dialog[open]")) quickAdd(files);
});

btnRotate.addEventListener("click", () => {
  if (!generatePicture.getOriginalImage()) return;
  generatePicture.setImageRotation((generatePicture.getImageRotation() + 90) % 360);
  editor.touched = true;
  updatePreview();
});

// --- Simulation / raw data ---
// With the calibrated profile the preview simulates the real display colours. The raw colours
// that are sent to the device show while the mouse is over the picture, or after a tap on it
// (touch). A small flag on the picture says so.

function setRawPreview(showRaw) {
  const available = previewStage.classList.contains("has-simulation");
  const active = available && showRaw;
  previewStage.classList.toggle("show-raw", active);
  previewRawFlag.hidden = !active;
  if (available) previewStage.setAttribute("aria-pressed", String(active));
}

function setSimulationAvailable(available) {
  previewStage.classList.toggle("has-simulation", available);
  if (available) {
    previewStage.setAttribute("role", "button");
    previewStage.setAttribute("tabindex", "0");
    previewStage.setAttribute("aria-label", "Vorschau mit simulierten Display-Farben. Aktivieren zeigt die Rohdaten.");
  } else {
    ["role", "tabindex", "aria-label", "aria-pressed"].forEach((name) => previewStage.removeAttribute(name));
  }
  setRawPreview(previewStage.classList.contains("show-raw"));
}

let previewPointerType = "mouse";
previewStage.addEventListener("pointerenter", (e) => {
  if (e.pointerType === "mouse") setRawPreview(true);
});
previewStage.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "mouse") setRawPreview(false);
});
previewStage.addEventListener("pointerdown", (e) => {
  previewPointerType = e.pointerType;
});
previewStage.addEventListener("click", () => {
  // a mouse already shows the raw data by hovering
  if (previewPointerType !== "mouse") setRawPreview(!previewStage.classList.contains("show-raw"));
});
previewStage.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && previewStage.classList.contains("has-simulation")) {
    e.preventDefault();
    setRawPreview(!previewStage.classList.contains("show-raw"));
  }
});

/**
 * Finds processing settings for the loaded picture, shows them in the sliders and renders the
 * preview with them. Runs for every picture that is loaded and on "Auto-Optimieren".
 * `announce` reports the result in the status line (button only).
 */
function runAutoOptimise({ announce = false } = {}) {
  if (!generatePicture.getOriginalImage()) return;

  generatePicture.setEpdDimensions(EPD_WIDTH, EPD_HEIGHT);
  // The picture is analysed on the preview canvas: it needs the display format, also before the first preview.
  const [width, height] = previewSizeFor(currentDisplay());
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const suggested = suggestProcessing(generatePicture, canvas, paletteSelect.value || "spectra6Custom", errorDiffusionMatrix.value);
  toneSlidersTouched = false;
  if (!suggested) {
    activeAutoOptions = null;
    if (announce) setStatus("Für dieses Bild wurde keine automatische Einstellung gefunden.", "warn");
    updatePreview(); // autoOptimise drew the undithered picture onto the preview canvas
    return;
  }

  serpentine.checked = suggested.serpentine;
  processingBrightness.value = suggested.brightness;
  processingContrast.value = suggested.contrast;
  processingSaturation.value = suggested.saturation;
  updateSliderOutputs();
  activeAutoOptions = suggested.options;

  if (announce) {
    if (paletteSelect.value === "new" || !suggested.suggestion) {
      setStatus("Automatisches Setting gefunden: Custom Color Profile", "ok");
    } else {
      setStatus(`Automatisches Setting gefunden: ${suggested.suggestion.classification.style}, Typ: ${suggested.suggestion.imageKind}`, "ok");
    }
  }

  updatePreview();
}

btnAutoDither.addEventListener("click", () => {
  editor.touched = true;
  runAutoOptimise({ announce: true });
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
      editor.touched = true;
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
    editor.touched = true;
    renderPaletteEditor();
    updatePreview();
  });
  paletteEditor.appendChild(reset);
}

paletteSelect.addEventListener("change", () => {
  generatePicture.setCustomPalette(null);
  editor.touched = true;
  renderPaletteEditor();
  if (paletteSelect.value !== "new") setRawPreview(false);
  updatePreview();
});

// --- BMP download ---

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
  const img = generatePicture.getOriginalImage();
  if (!img || state.busy) return;

  btnDownloadBin.disabled = true;
  try {
    setStatus("Generiere volle Auflösung für Download…", "busy");
    await nextFrame();
    downloadBlob(buildBmp(await renderRaw(img, readEditorUi(), currentDisplay())), "epaper_image.bmp");
    setStatus("BMP-Datei erstellt (epaper_image.bmp).", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Fehler beim Generieren: " + err.message, "err");
  } finally {
    syncUi();
  }
});

// --- Saving, deleting, showing ---

/** Stores the picture of the editor in the gallery and closes the editor. Resolves to the picture, or null. */
async function saveEditorToGallery() {
  const img = generatePicture.getOriginalImage();
  if (!img || state.busy) return null;
  if (!editor.item && gallery.items.length >= GALLERY_MAX_ITEMS) {
    setStatus(`Die Galerie fasst höchstens ${GALLERY_MAX_ITEMS} Bilder. Entferne zuerst eines.`, "warn");
    return null;
  }

  state.busy = true;
  syncUi();
  navigator.storage?.persist?.().catch(() => {}); // asks the browser not to clear the gallery on its own
  setStatus("Speichere das Bild in der Galerie…", "busy");
  await nextFrame();
  let saved = null;
  try {
    const display = currentDisplay();
    const ui = readEditorUi();
    let render;
    if (editor.remote && !editor.touched) {
      // unchanged picture from the device: its file is taken over as it is (packed again if it
      // came from a page that used the large window)
      const bytes = await repackContainer(editor.remote.container);
      const header = readContainerHeader(bytes);
      const thumbBytes = bytes.subarray(GALLERY_HEADER_SIZE, GALLERY_HEADER_SIZE + header.thumbLen);
      render = {
        id: idOf(bytes),
        container: new Blob([bytes], { type: "application/octet-stream" }),
        size: bytes.length,
        w: header.window,
        thumb: header.thumbLen ? new Blob([thumbBytes], { type: "image/jpeg" }) : gallery.remoteThumbs.get(editor.remote.id) || null,
      };
    } else {
      render = await buildRender(await renderRaw(img, ui, display), display);
    }
    const fields = {
      name: editor.name || "Bild",
      original: editor.file,
      ui,
      renders: { [display]: { id: render.id, container: render.container, size: render.size, w: render.w } },
      thumb: render.thumb,
    };
    if (editor.item) {
      saved = Object.assign(editor.item, fields);
      await gallery.update(saved);
    } else {
      // a picture from the device replaces the one it was read from at the next sync
      saved = await gallery.add({ ...fields, fromDevice: Boolean(editor.remote), synced: editor.remote ? { [display]: editor.remote.id } : {} });
    }
    editor.touched = false;
    editor.focusKey = saved.key;
    closeDialog(editorDialog);
    setStatus("Bild in der Galerie gespeichert. „Synchronisieren“ überträgt es auf das E-Paper.", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Das Bild konnte nicht gespeichert werden: " + err.message, "err");
    saved = null;
  } finally {
    state.busy = false;
    syncUi();
  }
  return saved;
}

btnSaveToGallery.addEventListener("click", () => saveEditorToGallery());

/** Removes a picture of the gallery (item) or one that is only on the device (remote entry). */
async function deletePicture({ item = null, remote = null }) {
  if (state.busy || (!item && !remote)) return;
  const onDevice = remote || (gallery.status(item, currentDisplay()) !== "new" && bleInterface.isConnected);
  const confirmed = await showMessage({
    title: "Bild löschen?",
    tone: "warn",
    text: remote ? "Das Bild liegt nur auf dem E-Paper. Es wird dort beim nächsten Synchronisieren gelöscht und lässt sich nicht wiederherstellen." : "Das Bild wird mit seinem Original aus der Galerie entfernt." + (onDevice ? " Auf dem E-Paper wird es beim nächsten Synchronisieren gelöscht." : ""),
    okLabel: "Löschen",
    cancelLabel: "Abbrechen",
    okVariant: "danger",
  });
  if (!confirmed) return;
  if (item) await gallery.remove(item.key);
  else await gallery.forgetRemote(remote.id);
  setStatus("Bild gelöscht.", "ok");
  btnAddPictures.focus();
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

const gallery = new Gallery(openGalleryStore);
let intervalDirty = false; // the interval was changed here and is not on the device yet

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

const pictures = (count) => (count === 1 ? "1 Bild" : `${count} Bilder`);

const thumbUrls = new WeakMap(); // Blob of a preview -> object URL
function thumbUrl(blob) {
  if (!blob) return "";
  if (!thumbUrls.has(blob)) thumbUrls.set(blob, URL.createObjectURL(blob));
  return thumbUrls.get(blob);
}

const TILE_STATUS = {
  synced: { label: "Synchron", tone: "ok" },
  new: { label: "Neu", tone: "warn" },
  changed: { label: "Geändert", tone: "warn" },
  remote: { label: "Nur auf dem Gerät", tone: "info" },
};

let dragKey = null; // key of the tile that is being dragged

function buildTile({ label, thumb, status, shown, onOpen, onDelete }) {
  const tile = document.createElement("li");
  tile.className = "tile";
  if (status) tile.dataset.status = status;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "tile-open";
  open.setAttribute("aria-label", [label, status ? TILE_STATUS[status].label : "", shown ? "wird gerade angezeigt" : "", "Bearbeiten"].filter(Boolean).join(", "));
  if (thumb) {
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.src = thumbUrl(thumb);
    open.appendChild(img);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "tile-placeholder";
    placeholder.textContent = "Vorschau lädt…";
    open.appendChild(placeholder);
  }
  if (status) {
    const badge = document.createElement("span");
    badge.className = `tile-badge badge badge-${TILE_STATUS[status].tone}`;
    badge.textContent = TILE_STATUS[status].label;
    open.appendChild(badge);
  }
  if (shown) {
    const flag = document.createElement("span");
    flag.className = "tile-shown";
    flag.textContent = "▶ Auf dem Display";
    open.appendChild(flag);
  }
  // shown over the picture on hover and focus, always on touch screens
  const edit = document.createElement("span");
  edit.className = "tile-edit";
  edit.setAttribute("aria-hidden", "true");
  edit.textContent = "✎ Bearbeiten";
  open.appendChild(edit);
  open.addEventListener("click", onOpen);
  tile.appendChild(open);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tile-delete";
  remove.textContent = "✕";
  remove.title = "Bild löschen";
  remove.setAttribute("aria-label", `${label} löschen`);
  remove.addEventListener("click", onDelete);
  tile.appendChild(remove);
  return tile;
}

function itemTile(item, index, display, shownId) {
  const status = gallery.status(item, display);
  const id = gallery.idFor(item, display);
  const tile = buildTile({
    label: `Bild ${index + 1}: ${item.name}`,
    thumb: item.thumb,
    status: status === "local" ? null : status,
    shown: Boolean(id) && id === shownId,
    onOpen: () => openEditor(item),
    onDelete: () => deletePicture({ item }),
  });
  tile.dataset.key = item.key;

  // The order: drag and drop, or Shift + arrow keys on the focused picture.
  const open = tile.querySelector(".tile-open");
  open.setAttribute("aria-keyshortcuts", "Shift+ArrowLeft Shift+ArrowRight");
  open.addEventListener("keydown", async (e) => {
    const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!e.shiftKey || !delta || state.busy) return;
    e.preventDefault();
    const target = gallery.items.indexOf(item) + delta;
    if (target < 0 || target >= gallery.items.length) return;
    await gallery.moveTo(item.key, target);
    galleryGrid.querySelector(`[data-key="${item.key}"] .tile-open`)?.focus();
  });

  tile.draggable = true;
  tile.addEventListener("dragstart", (e) => {
    if (state.busy) {
      e.preventDefault();
      return;
    }
    dragKey = item.key;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.name);
    tile.classList.add("is-dragging");
  });
  tile.addEventListener("dragend", () => {
    dragKey = null;
    galleryGrid.querySelectorAll(".is-dragging, .is-droptarget").forEach((el) => el.classList.remove("is-dragging", "is-droptarget"));
  });
  tile.addEventListener("dragover", (e) => {
    if (!dragKey || dragKey === item.key) return;
    e.preventDefault();
    tile.classList.add("is-droptarget");
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("is-droptarget"));
  tile.addEventListener("drop", (e) => {
    if (!dragKey) return;
    e.preventDefault();
    e.stopPropagation();
    const key = dragKey;
    dragKey = null;
    if (!state.busy) gallery.moveTo(key, index);
  });
  return tile;
}

function remoteTile(entry, shownId) {
  const tile = buildTile({
    label: `Bild auf dem Gerät (${formatBytes(entry.size)})`,
    thumb: gallery.remoteThumbs.get(entry.id) || null,
    status: "remote",
    shown: entry.id === shownId,
    onOpen: () => openRemotePicture(entry),
    onDelete: () => deletePicture({ remote: entry }),
  });
  tile.dataset.remote = entry.id;
  if (!entry.thumbLen) tile.querySelector(".tile-placeholder")?.replaceChildren("Keine Vorschau");
  return tile;
}

/** Text below the "Synchronisieren" button: what a sync would do. */
function syncHintText(display) {
  if (!bleInterface.isConnected) return canConnect ? "" : "kein Bluetooth";
  if (!bleInterface.gallerySupported) return "Firmware-Update nötig";
  if (!gallery.deviceList) return "";
  const plan = gallery.plan(display);
  const changes = plan.puts.length + plan.deletes.length + (plan.order ? 1 : 0) + (plan.settings || (intervalDirty && gallery.play.auto) ? 1 : 0);
  return changes ? `${changes} ${changes === 1 ? "Änderung" : "Änderungen"}` : "alles synchron";
}

function renderGalleryDevice(display) {
  const meter = $("galleryMeter");
  const text = $("galleryDeviceText");
  const connected = bleInterface.isConnected;
  const deviceState = gallery.deviceState;
  $("galleryFirmwareNote").hidden = !connected || bleInterface.gallerySupported;
  meter.hidden = true;

  if (!connected) {
    text.textContent = "Nicht verbunden. Die Bilder liegen in diesem Browser und werden beim Synchronisieren übertragen.";
  } else if (!bleInterface.gallerySupported) {
    text.textContent = "Verbunden. Die Galerie lässt sich erst nach dem Firmware-Update übertragen.";
  } else if (!deviceState) {
    text.textContent = "Lese die Galerie des E-Paper…";
  } else {
    const used = Number(deviceState.used) || 0;
    const free = Number(deviceState.free) || 0;
    const where = deviceState.storage === "sd" ? "SD-Karte" : "Flash";
    let line = `Auf dem E-Paper: ${pictures(Number(deviceState.count) || 0)} · ${formatBytes(used)} belegt, ${formatBytes(free)} frei (${where}).`;
    if (gallery.deviceList) {
      const pending = gallery.plan(display).puts;
      const bytes = pending.reduce((sum, item) => sum + (item.renders?.[display]?.size || 0), 0);
      if (pending.length) line += ` Zu übertragen: ${pictures(pending.length)}${bytes ? ` (${formatBytes(bytes)})` : ""}.`;
      if (bytes > free) line += " Das passt nicht ganz auf das Gerät.";
    }
    if (state.deviceMode === 1) line += " Derzeit zeigt das E-Paper das Bild der Download-URL; Synchronisieren stellt es auf die Galerie um.";
    text.textContent = line;
    if (used + free > 0) {
      const percent = Math.round((used / (used + free)) * 100);
      meter.hidden = false;
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", `Speicher des E-Paper zu ${percent} % belegt`);
      $("galleryMeterFill").style.width = percent + "%";
    }
  }
}

function renderPlay() {
  const { shuffle, auto } = gallery.play;
  const portrait = framePortrait();
  $("btnOrientLandscape").setAttribute("aria-pressed", String(!portrait));
  $("btnOrientPortrait").setAttribute("aria-pressed", String(portrait));
  $("btnPlayOrder").setAttribute("aria-pressed", String(!shuffle));
  $("btnPlayShuffle").setAttribute("aria-pressed", String(shuffle));
  $("btnPlayAuto").setAttribute("aria-pressed", String(auto));
  $("btnPlayManual").setAttribute("aria-pressed", String(!auto));
  $("playIntervalField").hidden = !auto;
  $("playAutoHint").textContent = auto ? "Das E-Paper wacht im eingestellten Abstand auf und zeigt das nächste Bild. Die Reset-Taste zeigt es früher: zweimal drücken sofort, einmal drücken nach 10 Sekunden ohne Verbindung." : "Kein automatisches Aufwachen: Das Bild wechselt nur, wenn du die Reset-Taste drückst.";
}

let galleryHint = "";

function renderGallery() {
  const display = currentDisplay();
  const shownId = gallery.deviceState?.current || "";
  const tiles = gallery.items.map((item, index) => itemTile(item, index, display, shownId));
  gallery.remoteOnly(display).forEach((entry) => tiles.push(remoteTile(entry, shownId)));
  galleryGrid.replaceChildren(...tiles, addTile);
  galleryEmpty.hidden = tiles.length > 0;
  $("galleryCount").textContent = pictures(tiles.length);
  $("galleryStoreNote").hidden = gallery.persistent;
  renderGalleryDevice(display);
  renderPlay();
  galleryHint = syncHintText(display);
  syncUi();
}

gallery.onChange = renderGallery;

// --- Adding pictures ---

/** Adds a picture with the automatic settings, prepared for the current display. */
async function addOriginal(file) {
  const { img, url } = await loadImage(file);
  try {
    const display = currentDisplay();
    const ui = autoUi(img, display);
    const render = await buildRender(await renderRaw(img, ui, display), display);
    await gallery.add({ name: file.name || "Bild", original: file, ui, renders: { [display]: { id: render.id, container: render.container, size: render.size, w: render.w } }, thumb: render.thumb });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Quick add: several files, each with the automatic settings. */
async function quickAdd(files) {
  if (state.busy) return;
  const images = imageFiles(files);
  if (!images.length) {
    setStatus("Das sind keine Bilddateien. Bitte JPEG, PNG oder WebP wählen.", "warn");
    return;
  }
  const room = GALLERY_MAX_ITEMS - gallery.items.length;
  const accepted = images.slice(0, Math.max(0, room));

  state.busy = true;
  syncUi();
  let failed = 0;
  try {
    navigator.storage?.persist?.().catch(() => {}); // asks the browser not to clear the gallery on its own
    for (const [index, file] of accepted.entries()) {
      setStatus(`Bereite Bild ${index + 1} von ${accepted.length} auf…`, "busy");
      setProgress((index / accepted.length) * 100);
      await nextFrame();
      try {
        await addOriginal(file);
      } catch (e) {
        console.warn("Picture could not be added:", file.name, e);
        failed++;
      }
    }
  } finally {
    state.busy = false;
    setProgress(null);
    renderGallery();
  }

  const added = accepted.length - failed;
  const notes = [];
  if (failed) notes.push(`${pictures(failed)} ließ${failed === 1 ? "" : "en"} sich nicht lesen.`);
  if (images.length > accepted.length) notes.push(`Die Galerie fasst höchstens ${GALLERY_MAX_ITEMS} Bilder.`);
  setStatus(`${pictures(added)} hinzugefügt.${notes.length ? " " + notes.join(" ") : " „Synchronisieren“ überträgt sie auf das E-Paper."}`, notes.length ? "warn" : "ok");
}

btnAddPictures.addEventListener("click", () => galleryFileInput.click());
galleryFileInput.addEventListener("change", (e) => {
  const files = [...e.target.files];
  galleryFileInput.value = "";
  quickAdd(files);
});

const galleryCard = $("galleryCard");
watchFileDrag(galleryCard);
galleryCard.addEventListener("drop", (e) => {
  const files = imageFiles(e.dataTransfer?.files);
  if (!files.length) return;
  e.preventDefault();
  quickAdd(files);
});

$("btnGalleryFirmware").addEventListener("click", () => btnJumpToOta.click());

// --- Gallery or download from a URL ---

function setSource(source) {
  state.source = source;
  try {
    localStorage.setItem("bildSource", source);
  } catch (e) {
    // private mode: the choice lasts for this visit
  }
  syncUi();
}
$("btnSourceGallery").addEventListener("click", () => setSource("gallery"));
$("btnSourceUrl").addEventListener("click", () => setSource("url"));

// --- Orientation of the frame: every picture is prepared for it ---

/** Prepares the pictures of the gallery again, upright for the way the frame hangs. */
async function turnAllPictures() {
  const display = currentDisplay();
  // a picture taken over from a device has no original: it stays as it is
  const items = gallery.items.filter((item) => item.original && !item.fromDevice);
  if (!items.length) return;

  state.busy = true;
  syncUi();
  let failed = 0;
  try {
    for (const [index, item] of items.entries()) {
      setStatus(`Richte Bild ${index + 1} von ${items.length} neu aus…`, "busy");
      setProgress((index / items.length) * 100);
      await nextFrame();
      try {
        const { img, url } = await loadImage(item.original);
        try {
          const ui = { ...(item.ui || autoUi(img, display)), rotation: orientationRotation(display), display };
          const render = await buildRender(await renderRaw(img, ui, display), display);
          item.ui = ui;
          item.renders = { [display]: { id: render.id, container: render.container, size: render.size, w: render.w } };
          item.thumb = render.thumb;
          await gallery.update(item);
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        console.warn("Picture could not be turned:", item.name, e);
        failed++;
      }
    }
  } finally {
    state.busy = false;
    setProgress(null);
    renderGallery();
  }
  setStatus(failed ? `${pictures(failed)} ließ${failed === 1 ? "" : "en"} sich nicht neu ausrichten.` : `${pictures(items.length)} neu ausgerichtet. „Synchronisieren“ überträgt sie auf das E-Paper.`, failed ? "warn" : "ok");
}

async function setOrientation(portrait) {
  if (state.busy || framePortrait() === portrait) return;
  await gallery.setPlay({ portrait }, { dirty: gallery.play.dirty });
  applyOrientationLayout();
  await turnAllPictures();
}

$("btnOrientLandscape").addEventListener("click", () => setOrientation(false));
$("btnOrientPortrait").addEventListener("click", () => setOrientation(true));

// --- Play settings ---

$("btnPlayOrder").addEventListener("click", () => gallery.setPlay({ shuffle: false }));
$("btnPlayShuffle").addEventListener("click", () => gallery.setPlay({ shuffle: true }));
$("btnPlayAuto").addEventListener("click", () => gallery.setPlay({ auto: true }));
$("btnPlayManual").addEventListener("click", () => gallery.setPlay({ auto: false }));

const INTERVAL_UNITS = [86400, 3600, 60];

/** Shows an interval in seconds in the largest unit that fits. */
function setGalleryInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return;
  const unit = INTERVAL_UNITS.find((u) => value % u === 0) || 60;
  galleryInterval.value = Math.max(1, Math.round(value / unit));
  galleryIntervalUnit.value = String(unit);
  setFieldError(galleryInterval, "");
}

/** The interval of the gallery view in seconds, null if it is not allowed. */
function galleryIntervalSeconds() {
  const count = Number(galleryInterval.value);
  if (!Number.isInteger(count) || count < 1) return null;
  const seconds = count * Number(galleryIntervalUnit.value);
  return seconds >= DEVICE_LIMITS.timeoutMin && seconds <= DEVICE_LIMITS.timeoutMax ? seconds : null;
}

function onGalleryIntervalInput() {
  const seconds = galleryIntervalSeconds();
  if (seconds === null) {
    setFieldError(galleryInterval, "Erlaubt sind 1 Minute bis 30 Tage, in ganzen Zahlen.");
    return;
  }
  setFieldError(galleryInterval, "");
  intervalDirty = true;
  settingTimeout.value = seconds; // the same value on the device
  updateTimeoutHint();
  renderGallery();
}

galleryInterval.addEventListener("input", onGalleryIntervalInput);
galleryIntervalUnit.addEventListener("change", onGalleryIntervalInput);

// --- The gallery of the connected device ---

let listRev = null; // `rev` of the device state the list was read for
const deviceRefresh = { running: false, again: false };

bleInterface.onGalleryStateChange = (deviceState) => {
  gallery.setDeviceState(deviceState);
  if (!gallery.play.dirty && (gallery.play.shuffle !== Boolean(deviceState.shuffle) || gallery.play.auto !== Boolean(deviceState.auto))) {
    gallery.setPlay({ shuffle: Boolean(deviceState.shuffle), auto: Boolean(deviceState.auto) }, { dirty: false });
  }
  $("syncBadgePlay").hidden = gallery.play.dirty;
  renderGallery();
  if (state.conn === "connected" && deviceState.rev !== listRev) refreshDeviceGallery();
};

/** Runs a read of the background refresh; waits while the display is busy. null: give up. */
async function readQuietly(read) {
  while (bleInterface.isConnected && !state.busy) {
    try {
      return await read();
    } catch (e) {
      if (e?.code !== "BUSY") {
        console.warn("Gallery of the device:", e);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return null;
}

/** Reads the list of the device and then the previews of pictures that are only there. In the background. */
async function refreshDeviceGallery() {
  if (!bleInterface.isConnected || !bleInterface.gallerySupported) return;
  if (deviceRefresh.running) {
    deviceRefresh.again = true;
    return;
  }
  deviceRefresh.running = true;
  try {
    do {
      deviceRefresh.again = false;
      const rev = gallery.deviceState?.rev ?? null;
      const list = await readQuietly(() => bleInterface.readGalleryList({ quiet: true }));
      if (!list) break;
      listRev = rev;
      gallery.setDeviceList(list);
      offerSync();

      for (const entry of gallery.remoteOnly(currentDisplay())) {
        if (!entry.thumbLen || gallery.remoteThumbs.has(entry.id)) continue;
        const bytes = await readQuietly(() => bleInterface.readGalleryThumb(entry.id, { quiet: true }));
        if (!bytes) break;
        await gallery.putRemoteThumb(entry.id, new Blob([bytes], { type: "image/jpeg" }));
        renderGallery();
      }
    } while (deviceRefresh.again && bleInterface.isConnected);
  } catch (e) {
    console.warn("Gallery of the device:", e);
  } finally {
    deviceRefresh.running = false;
  }
}

/**
 * After connecting by hand: the device shows the gallery, and it differs from the one in this
 * browser. Offers to sync, once.
 */
let userConnect = false; // the running connection was started by the user
let offerSyncAfterList = false;

async function offerSync() {
  if (!offerSyncAfterList) return;
  offerSyncAfterList = false;
  if (state.busy || state.deviceMode === 1 || !gallery.items.length || document.querySelector("dialog[open]")) return;
  const plan = gallery.plan(currentDisplay());
  const changes = plan.puts.length + plan.deletes.length + (plan.order ? 1 : 0);
  if (!changes) return;
  const sync = await showMessage({
    title: "Galerie synchronisieren?",
    text: `Die Galerie in diesem Browser und die auf dem E-Paper unterscheiden sich (${changes} ${changes === 1 ? "Änderung" : "Änderungen"}).`,
    okLabel: "Synchronisieren",
    cancelLabel: "Später",
    okVariant: "signal",
  });
  if (sync && bleInterface.isConnected) startGallerySync();
}

// --- Sync ---

/** Prepares a picture for a display it was not rendered for yet. */
async function ensureRender(item, display) {
  if (item.renders?.[display]) return;
  if (!item.original) throw new Error(`„${item.name}“ kann für dieses Display nicht aufbereitet werden: Das Original fehlt.`);
  const { img, url } = await loadImage(item.original);
  try {
    const render = await buildRender(await renderRaw(img, item.ui || autoUi(img, display), display), display);
    item.renders = { ...item.renders, [display]: { id: render.id, container: render.container, size: render.size, w: render.w } };
    item.thumb = render.thumb;
    await gallery.update(item);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Brings the device to the state of the gallery. Every step can be repeated: a sync that was
 * interrupted continues where it stopped when it is started again.
 */
async function syncGallery() {
  const display = currentDisplay();

  const unprepared = gallery.items.filter((item) => !gallery.idFor(item, display));
  for (const [index, item] of unprepared.entries()) {
    setStatus(`Bereite Bild ${index + 1} von ${unprepared.length} für dieses Display auf…`, "busy");
    await nextFrame();
    await ensureRender(item, display);
  }

  setStatus("Vergleiche mit dem E-Paper…", "busy");
  let list = await bleInterface.readGalleryList();
  gallery.setDeviceList(list);
  const plan = gallery.plan(display);

  for (const [index, id] of plan.deletes.entries()) {
    setStatus(`Lösche Bild ${index + 1} von ${plan.deletes.length} auf dem E-Paper…`, "busy");
    await bleInterface.galleryDelete(id);
  }
  await gallery.dropTombstones(plan.deletes);

  const totalBytes = plan.puts.reduce((sum, item) => sum + item.renders[display].size, 0);
  let sentBytes = 0;
  let notFitting = 0;
  for (const [index, item] of plan.puts.entries()) {
    const render = item.renders[display];
    const bytes = new Uint8Array(await render.container.arrayBuffer());
    const label = `Sende Bild ${index + 1} von ${plan.puts.length}`;
    setStatus(`${label}…`, "busy");
    try {
      await bleInterface.galleryPut(render.id, bytes, { label, onProgress: (fraction) => setProgress(((sentBytes + fraction * bytes.length) / totalBytes) * 100) });
    } catch (e) {
      if (e.code !== "NO_SPACE") throw e;
      notFitting++;
    }
    sentBytes += bytes.length;
  }
  setProgress(null);

  setStatus("Übertrage Reihenfolge und Einstellungen…", "busy");
  if (plan.deletes.length || plan.puts.length) list = await bleInterface.readGalleryList();
  if (gallery.orderDiffers(display, list)) {
    await bleInterface.galleryOrder(gallery.orderFor(display, list));
    list = await bleInterface.readGalleryList();
  }
  const deviceState = gallery.deviceState;
  if (gallery.play.dirty || !deviceState || Boolean(deviceState.shuffle) !== gallery.play.shuffle || Boolean(deviceState.auto) !== gallery.play.auto) {
    await bleInterface.gallerySet(gallery.play.shuffle, gallery.play.auto);
    await gallery.setPlay({}, { dirty: false });
  }
  if (intervalDirty && gallery.play.auto) {
    const seconds = galleryIntervalSeconds();
    if (seconds !== null) {
      await bleInterface.saveTimeout(seconds);
      intervalDirty = false;
    }
  }

  // what the device holds now is the synced state of the gallery
  const onDevice = new Set(list.map((entry) => entry.id));
  for (const item of gallery.items) {
    const id = gallery.idFor(item, display);
    if (id && onDevice.has(id) && item.synced?.[display] !== id) {
      item.synced = { ...item.synced, [display]: id };
      await gallery.update(item);
    }
  }
  const latest = (await bleInterface.readGalleryState()) || deviceState;
  if (latest) {
    gallery.setDeviceState(latest);
    listRev = latest.rev ?? null;
  }
  gallery.setDeviceList(list);

  // the gallery is what the device shows from now on
  let shown = false;
  if (list.length) {
    const mode = await bleInterface.readImageMode();
    const current = latest?.current && onDevice.has(latest.current) ? latest.current : "";
    if (!current || mode !== 0) {
      await bleInterface.galleryShow(current || gallery.orderFor(display, list)[0] || list[0].id);
      shown = true;
    }
  }

  if (notFitting) {
    setStatus(`${notFitting === 1 ? "1 Bild passte" : `${notFitting} Bilder passten`} nicht mehr auf das E-Paper: Der Speicher ist voll oder die Höchstzahl von ${GALLERY_MAX_ITEMS} Bildern erreicht. Entferne Bilder aus der Galerie und synchronisiere erneut.`, "warn");
    return { title: "Nicht alles übertragen", sticky: true };
  }
  if (list.length) state.deviceMode = 0;
  setStatus(shown ? "Galerie synchronisiert. Das E-Paper zeigt sie jetzt an." : "Galerie synchronisiert.", "ok");
  return undefined;
}

async function startGallerySync() {
  if (state.busy) return;
  if (!bleInterface.gallerySupported) {
    setStatus("Die Firmware des E-Paper kennt die Galerie noch nicht. Bitte zuerst die Firmware aktualisieren.", "warn");
    return;
  }
  if (gallery.play.auto && galleryIntervalSeconds() === null) {
    setFieldError(galleryInterval, "Erlaubt sind 1 Minute bis 30 Tage, in ganzen Zahlen.");
    galleryInterval.focus();
    return;
  }
  await runTransfer({ title: "Galerie wird synchronisiert", abortable: true, failTitle: "Synchronisieren fehlgeschlagen" }, syncGallery);
  renderGallery();
  refreshDeviceGallery();
}

// "Synchronisieren" without a connected device: a dialog explains how to connect (the steps of
// the device view). Its button opens the Bluetooth device chooser, and once the device is
// connected the sync starts by itself (see onConnected).
const connectDialog = $("connectDialog");
let syncAfterConnect = false;
let connectPurpose = "gallery"; // what is synced once the device is connected: "gallery" | "url"

let connectDialogSync = false; // the dialog was opened by a sync button

function openConnectDialog(sync) {
  connectDialogSync = sync;
  const steps = $("connectDialogSteps");
  if (!steps.hasChildNodes()) {
    steps.append(document.querySelector("#notConnectedState .step-list").cloneNode(true));
  }
  $("connectDialogTitle").textContent = sync ? "Kein Gerät verbunden" : "Mit E-Paper verbinden";
  $("connectDialogText").textContent = sync
    ? "Zum Synchronisieren wird das E-Paper per Bluetooth oder USB-Kabel verbunden. Sobald die Verbindung steht, startet die Übertragung von selbst."
    : "Per Bluetooth oder per USB-Kabel? Unter „Gerät“ lässt sich das fest einstellen.";
  openDialog(connectDialog);
}

$("btnCancelConnectDialog").addEventListener("click", () => closeDialog(connectDialog));

$("btnConnectAndSend").addEventListener("click", () => {
  syncAfterConnect = connectDialogSync;
  closeDialog(connectDialog);
  bleInterface.connect(); // opens the device chooser; must be called directly from this click
});

$("btnConnectUsbAndSend").hidden = !serialAvailable;
$("btnConnectAndSend").disabled = !bluetoothAvailable;
$("btnConnectUsbAndSend").addEventListener("click", async () => {
  closeDialog(connectDialog);
  syncAfterConnect = (await connectUsb()) && connectDialogSync;
});

btnSyncGallery.addEventListener("click", () => {
  if (state.busy) return;
  connectPurpose = "gallery";

  if (bleInterface.isConnected) {
    startGallerySync();
  } else if (state.conn !== "disconnected") {
    // a connection attempt is already running: sync as soon as it succeeds
    syncAfterConnect = true;
    setStatus("Verbindung wird aufgebaut – die Galerie wird danach synchronisiert.", "busy");
  } else {
    startConnect({ sync: true });
  }
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
    tone: "warn",
    text: "Für das Update per Bluetooth muss das E-Paper verbunden sein. Drücke die Reset-Taste am Gerät und verbinde dich – oder wechsle zum Verbindungsweg USB-Kabel.",
    detail: "Noch die Cloud-Firmware installiert? Dort ist Bluetooth nur nach einem Werksreset aktiv: Reset-Taste 5× schnell hintereinander drücken und warten, bis der WLAN-Verbindungsbildschirm erscheint.",
    okLabel: "Verbinden",
    cancelLabel: "Abbrechen",
    okVariant: "signal",
  });
  if (connectNow) startConnect();
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

const DRIVER_LINK = { href: "https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers?tab=downloads", label: "Treiber von Silicon Labs ↗" };

/** No port was picked: without its driver the device is missing in the list of the chooser. */
async function explainMissingPort() {
  const canCheck = "usb" in navigator;
  const check = await showMessage({
    title: "E-Paper nicht in der Liste?",
    text: "Dann erkennt dein PC den USB-Anschluss des E-Paper nicht. Unter Windows fehlt meist der Treiber „CP210x Universal Windows Driver“: Im Geräte-Manager steht das E-Paper dann unter „Andere Geräte“. Auch ein USB-Kabel ohne Datenleitungen kommt in Frage.",
    link: DRIVER_LINK,
    okLabel: canCheck ? "USB prüfen" : "OK",
    cancelLabel: canCheck ? "Schließen" : null,
  });
  if (!check || !canCheck) return;

  // WebUSB lists the device also without a driver.
  let device = null;
  try {
    device = await navigator.usb.requestDevice({ filters: SERIAL_FILTERS.map((f) => ({ vendorId: f.usbVendorId, productId: f.usbProductId })) });
  } catch (e) {
    if (e?.name !== "NotFoundError") {
      setStatus("USB-Prüfung nicht möglich: " + e.message, "warn");
      return;
    }
  }
  if (device) {
    await showMessage({
      title: "Treiber fehlt",
      tone: "warn",
      text: "Das E-Paper ist per USB angeschlossen. Fehlte es eben in der Liste der seriellen Anschlüsse, ist sein Treiber nicht installiert. Installiere ihn und starte den Vorgang erneut.",
      detail: device.productName || "",
      link: DRIVER_LINK,
    });
  } else {
    await showMessage({
      title: "Kein E-Paper am USB gefunden",
      tone: "warn",
      text: "Dein PC sieht das E-Paper nicht. Nimm ein USB-C-Kabel mit Datenleitungen, stecke es direkt am PC an und prüfe, ob es am E-Paper ganz eingesteckt ist.",
    });
  }
}

/** The flasher and the monitor open the serial port themselves: a session of the USB link ends first. */
function releaseUsbLink() {
  return bleInterface.releaseUsb();
}

/** Must run directly inside a click handler (the port chooser needs a user gesture). */
async function pickSerialPort() {
  await releaseUsbLink();
  try {
    return await requestSerialPort();
  } catch (e) {
    if (e?.name === "NotFoundError" || e?.name === "AbortError") {
      setStatus("Kein COM-Port ausgewählt – Vorgang abgebrochen.", "warn");
      await explainMissingPort();
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

// What to do after a firmware update (shown with the result)
const RECONNECT_NEXT_STEP = "Drücke danach die Reset-Taste am E-Paper und verbinde dich wieder per Bluetooth.";
const CLOUD_NEXT_STEP = "Mit der Cloud-Firmware ist das E-Paper über die paperlesspaper-App erreichbar.";

const BOOT_BUTTON_STEPS = "Holzabdeckung abnehmen, kleinen Knopf halten, Reset kurz drücken, kleinen Knopf loslassen";
const BOOTLOADER_HELP = `Der Bootloader des E-Paper antwortet nicht. Starte den Vorgang erneut und drücke nach der Aufforderung kurz Reset. Klappt es weiter nicht, bringe das Gerät von Hand in den Bootloader: ${BOOT_BUTTON_STEPS} (Hilfe: „USB: Probleme beheben“).`;
const AUTO_BOOTLOADER_MS = 4000;

/** Brings the device into the bootloader (see serialBoot.js) and connects to it. */
async function openEspLoader(port) {
  await disconnectSerialMonitor();
  setStatus("Verbindung mit USB-Gerät wird hergestellt…", "busy");
  let mode = "default_reset"; // boards with auto reset
  if (await bootloaderAnswers(port, loaderTerminal)) {
    mode = "no_reset";
  } else {
    setStatus("Prüfe, ob das E-Paper von selbst in den Bootloader wechselt…", "busy");
    let entered = await requestBootloader(port, { timeoutMs: AUTO_BOOTLOADER_MS });
    if (!entered) {
      setStatus(`Das E-Paper wechselt nicht von selbst in den Bootloader. Drücke jetzt kurz die Reset-Taste (großer Knopf).`, "busy");
      entered = await requestBootloader(port, {
        onUnsupported: () => setStatus(`Diese Firmware wechselt nicht von selbst in den Bootloader. Jetzt von Hand: ${BOOT_BUTTON_STEPS}.`, "busy"),
      });
    }
    if (entered) {
      mode = "no_reset";
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  setStatus("Lade Bootloader…", "busy");
  // tracing off: it hex-dumps every packet to the console and into memory
  const transport = new Transport(port, false);
  const esploader = new ESPLoader({ transport, baudrate: 921600, terminal: loaderTerminal });
  try {
    await esploader.main(mode);
  } catch (err) {
    await closeTransport(transport);
    if (err?.name === "InvalidStateError" || err?.message?.includes("already open")) throw err;
    console.error(err);
    throw new Error(BOOTLOADER_HELP);
  }
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

/**
 * Waits for the start of a firmware that was just flashed and tells whether it is the one that runs.
 * expected: { offline, version } of the flashed firmware, null if unknown (own file).
 */
async function confirmFirmwareStart(port, label, expected) {
  setProgress(null);
  setStatus(`${label} ist geschrieben. Drücke jetzt kurz die Reset-Taste am E-Paper, damit sie startet…`, "busy");
  let boot = null;
  try {
    boot = await readBootLog(port);
  } catch (err) {
    console.warn("Boot log:", err);
  }
  if (!boot) {
    setStatus(`${label} ist geschrieben, der Start wurde aber nicht erkannt. Drücke die Reset-Taste und verbinde dich per Bluetooth: Die Geräteleiste zeigt dann die laufende Firmware.`, "warn");
    return { title: "Geschrieben, Start nicht geprüft" };
  }

  const running = `${boot.offline ? "Offline" : "Cloud"}-Firmware v${boot.version}`;
  const rightSlot = boot.slot === null || boot.slot === "app0";
  const rightFirmware = !expected || (expected.offline === boot.offline && (!expected.version || expected.version === boot.version));
  if (!rightSlot || !rightFirmware) {
    throw new Error(`Auf dem E-Paper startet die ${running}${boot.slot ? ` (${boot.slot})` : ""}, nicht die eben geflashte Firmware. Bitte erneut flashen.`);
  }
  const next = boot.offline ? "Verbinde dich jetzt per Bluetooth. Wird das E-Paper nicht gefunden, drücke vorher noch einmal die Reset-Taste." : CLOUD_NEXT_STEP;
  setStatus(`✅ Die ${running} läuft auf dem E-Paper. ${next}`, "ok");
  return undefined;
}

async function flashSerial(buffer, address, label, port, expected = null) {
  let transport = null;
  try {
    const loader = await openEspLoader(port);
    transport = loader.transport;
    const esploader = loader.esploader;

    const fileArray = [{ data: buffer, address }];
    if (address === APP_ADDRESS) {
      fileArray.push({ data: new Uint8Array(OTADATA_SIZE).fill(0xff), address: OTADATA_ADDRESS });
    }

    setStatus(`Flashe ${label}…`, "busy");
    await esploader.writeFlash({
      fileArray,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        if (fileIndex !== 0) return; // otadata: a few bytes
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
  } catch (err) {
    console.error(err);
    throw new Error(describeSerialError(err));
  } finally {
    await closeTransport(transport);
  }

  if (address === APP_ADDRESS) return confirmFirmwareStart(port, label, expected);
  setStatus(`✅ ${label} erfolgreich geflasht! Drücke jetzt den Reset-Knopf am E-Paper, um zu starten.`, "ok");
  return undefined;
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
      await bleInterface.uploadFirmware(buffer, CLOUD_NEXT_STEP);
    } else {
      return flashSerial(buffer, APP_ADDRESS, "Original Cloud Firmware", port, { offline: false });
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

// The backup of the certificates, right where the firmware is changed. It runs over USB.
$("btnOfflineOtaBackup").disabled = !serialAvailable;
$("offlineOtaBackupUnsupported").hidden = serialAvailable;
$("btnOfflineOtaBackup").addEventListener("click", async () => {
  if (state.busy) return;
  const port = await pickSerialPort();
  if (!port) return;
  closeDialog(otaOfflineDialog);
  await runTransfer({ title: "Zertifikate werden gesichert", successTitle: "Backup gespeichert", failTitle: "Backup fehlgeschlagen", stickySuccess: true }, () => backupSpiffsSerial(port));
  // back to the dialog, to go on with the firmware
  const reopen = () => openDialog(otaOfflineDialog);
  if (transferDialog.open) transferDialog.addEventListener("close", reopen, { once: true });
  else reopen();
});

btnConfirmOfflineOta.addEventListener("click", async () => {
  const method = state.otaMethod;
  const type = offlineOtaDeviceSelect.value;
  let port = null;
  if (method === "ble" && !bleInterface.settingsService) {
    // the backup over USB has restarted the device: connect again first
    closeDialog(otaOfflineDialog);
    await ensureBleConnected();
    return;
  }
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
      await bleInterface.uploadFirmware(buffer, RECONNECT_NEXT_STEP);
    } else {
      // a local build may load the firmware of the published site: its version is not known here
      return flashSerial(buffer, APP_ADDRESS, "Offline Firmware", port, { offline: true, version: RELEASE_CHANNEL === "local" ? null : EXPECTED_FW_VERSION });
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
    await runTransfer({ title: "Firmware wird installiert", abortable: true, successTitle: "Firmware installiert", failTitle: "Firmware-Update fehlgeschlagen", stickySuccess: true }, () => bleInterface.uploadFirmware(buffer, RECONNECT_NEXT_STEP));
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
  btnToggleSerialMonitor.textContent = active ? "Stoppen" : "Starten";
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
  if (state.conn !== "disconnected") notes.push("Beim Wechsel wird die Verbindung zum E-Paper getrennt – danach einfach neu verbinden.");
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
  // Short (commit only) so the header stays on one line; amber marks the preview build.
  const fwBadge = $("offlineFwChannelBadge");
  fwBadge.textContent = BUILD_COMMIT || RELEASE_CHANNEL;
  fwBadge.title = describeBuild(RELEASE_CHANNEL, { fwVersion: EXPECTED_FW_VERSION, commit: BUILD_COMMIT });
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
  $("versionLabel").textContent = IS_DEV_CHANNEL ? "Dev" : "Main";
  btnVersion.dataset.channel = RELEASE_CHANNEL; // dev: amber
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
// Install as an app (PWA)
// ---------------------------------------------------------------------------

// The service worker keeps the page for starting without internet (see public/sw.js).
// Only in a built page: the dev server changes files all the time.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker:", err));
  });
}

const installBanner = $("installBanner");
const INSTALL_DISMISSED_KEY = "paperlesspaper-install-dismissed";
const INSTALL_ASK_AGAIN_MS = 14 * 24 * 60 * 60 * 1000; // after "Später": two weeks of quiet
let installPrompt = null; // the browser's "beforeinstallprompt" event, kept until the user decides

function installRecentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(INSTALL_DISMISSED_KEY));
    return at > 0 && Date.now() - at < INSTALL_ASK_AGAIN_MS;
  } catch (e) {
    return false; // storage blocked: ask again
  }
}

function rememberInstallDismissed() {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
  } catch (e) {
    // storage blocked: nothing to remember
  }
}

// Fired by Chromium browsers when the page can be installed (and is not installed yet).
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); // our own banner instead of the browser's mini bar
  installPrompt = event;
  // The banner is for phones and tablets; on a PC the browser offers the installation in its address bar.
  const touchDevice = window.matchMedia("(pointer: coarse)").matches;
  installBanner.hidden = !touchDevice || installRecentlyDismissed();
});

$("btnInstallApp").addEventListener("click", async () => {
  const prompt = installPrompt;
  installPrompt = null;
  installBanner.hidden = true;
  if (!prompt) return;
  prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice?.outcome !== "accepted") rememberInstallDismissed();
});

$("btnInstallLater").addEventListener("click", () => {
  installBanner.hidden = true;
  rememberInstallDismissed();
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installBanner.hidden = true;
  setStatus("Die App ist installiert und liegt jetzt auf dem Startbildschirm.", "ok");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initNavigation();
initDialogs();
initCollapsibles();
// Links to one section of the help open that section.
document.querySelectorAll("[data-help-target]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const section = $(link.dataset.helpTarget).closest("[data-collapsible]");
    navigate("hilfe");
    setCollapsible(section, true);
    section.scrollIntoView({ block: "start" });
  });
});
// With room for two columns the picture settings stand open next to the picture.
if (window.matchMedia("(min-width: 900px)").matches) {
  setCollapsible($("imageSettingsDetails"), true);
}
renderPaletteEditor();
updateSliderOutputs();
setOtaMode("ble");
applyOrientationLayout();
setGalleryInterval(3600);
renderGallery();
gallery.ready.then(() => {
  applyOrientationLayout(); // the stored orientation is known now
  renderGallery();
});
initReleaseChannel();

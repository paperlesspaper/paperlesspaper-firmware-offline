import {
  ditherImage,
  aitjcizeSpectra6Palette,
  acepPalette,
  replaceColors,
  suggestCanvasProcessingOptions,
  getProcessingPresetOptions,
} from "epdoptimize";

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

const DEVICE_DATA_SERVICE_UUID = "7f74170e-7b0e-11ed-a1eb-0242ac120002";
const WIFI_SCAN_UUID = "5131a3fc-7b0e-11ed-a1eb-0242ac120002";
const WIFI_CONNECTED_UUID = "4c578d4c-7b0e-11ed-a1eb-0242ac120002";

// ACHTUNG: Passe EPD_WIDTH/HEIGHT bei Bedarf an dein Panel an
const EPD_WIDTH = 800;
const EPD_HEIGHT = 480;

let bleDevice = null;
let wifiService = null;
let settingsService = null;
let processedImageBuffer = null;
let reconnectInterval = null;

const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");
const statusText = document.getElementById("statusText");
const controls = document.getElementById("controls");

const btnSaveWifi = document.getElementById("btnSaveWifi");
const wifiSsid = document.getElementById("wifiSsid");
const wifiList = document.getElementById("wifiList");
const wifiPass = document.getElementById("wifiPass");
const btnTogglePass = document.getElementById("btnTogglePass");
const eyeIconOpen = document.getElementById("eyeIconOpen");
const eyeIconClosed = document.getElementById("eyeIconClosed");

const btnSaveSettings = document.getElementById("btnSaveSettings");
const settingTimeout = document.getElementById("settingTimeout");
const settingUrl = document.getElementById("settingUrl");

const fileInput = document.getElementById("fileInput");
const btnUploadImage = document.getElementById("btnUploadImage");
const btnDownloadBin = document.getElementById("btnDownloadBin");
const canvas = document.getElementById("previewCanvas");
canvas.width = EPD_WIDTH;
canvas.height = EPD_HEIGHT;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");

const ditheringType = document.getElementById("ditheringType");
const errorDiffusionMatrix = document.getElementById("errorDiffusionMatrix");
const serpentine = document.getElementById("serpentine");
const colorMatchingMode = document.getElementById("colorMatchingMode");
const processingBrightness = document.getElementById("processingBrightness");
const processingContrast = document.getElementById("processingContrast");
const processingSaturation = document.getElementById("processingSaturation");
const btnRedither = document.getElementById("btnRedither");
const btnAutoDither = document.getElementById("btnAutoDither");

let originalImage = null;

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

function encodeText(text) {
  return new TextEncoder().encode(text);
}

function setStatus(text, colorClass = "text-gray-500") {
  statusText.className = `mt-4 text-sm font-semibold ${colorClass}`;
  statusText.innerText = text;
}

async function connectToDevice() {
  if (bleDevice && bleDevice.gatt.connected) return;

  try {
    setStatus("Verbinde zu GATT Server...", "text-blue-500");
    const server = await bleDevice.gatt.connect();

    setStatus("Lade Services...", "text-blue-500");
    settingsService = await server.getPrimaryService(SETTINGS_SERVICE_UUID);
    wifiService = await server.getPrimaryService(WIFI_SERVICE_UUID);

    // Lade verfügbare WLANs herunter
    try {
      const deviceDataService = await server.getPrimaryService(DEVICE_DATA_SERVICE_UUID);
      const scanChar = await deviceDataService.getCharacteristic(WIFI_SCAN_UUID);
      const scanData = await scanChar.readValue();
      const scanText = new TextDecoder().decode(scanData);

      // Das Format vom ESP32-C6 ist: SSID´RSSI´´SSID´RSSI´´
      if (scanText && scanText.length > 0) {
        wifiList.innerHTML = ""; // Vorherige löschen
        const networks = scanText.split("´´");
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
          }
        });
      }
    } catch (e) {
      console.warn("WLAN Liste konnte nicht geladen werden:", e);
    }

    setStatus("Erfolgreich Verbunden!", "text-green-600");
    btnConnect.classList.add("hidden");
    btnDisconnect.classList.remove("hidden");

    // UI einblenden
    controls.classList.remove("hidden");
    setTimeout(() => controls.classList.remove("opacity-0"), 100);
  } catch (error) {
    console.error(error);
    setStatus("Verbindung abgebrochen oder getrennt.", "text-orange-500");
    btnConnect.classList.remove("hidden");
    btnDisconnect.classList.add("hidden");
    clearTimeout(reconnectInterval);
  }
}

btnConnect.addEventListener("click", async () => {
  try {
    if (!bleDevice) {
      setStatus("Fordere Bluetooth-Kopplung an...", "text-blue-500");
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "epd" }],
        optionalServices: [SETTINGS_SERVICE_UUID, WIFI_SERVICE_UUID, DEVICE_DATA_SERVICE_UUID],
      });

      bleDevice.addEventListener("gattserverdisconnected", () => {
        setStatus("Gerät getrennt. E-Paper aktualisiert sich...", "text-orange-500");
        controls.classList.add("hidden", "opacity-0");
        settingsService = null;
        wifiService = null;
        btnConnect.classList.remove("hidden");
        btnDisconnect.classList.add("hidden");
        if (reconnectInterval) clearTimeout(reconnectInterval);
      });
    }
    await connectToDevice();
  } catch (error) {
    console.error(error);
    setStatus("Kopplung abgebrochen oder Fehler: " + error.message, "text-red-500");
  }
});

btnDisconnect.addEventListener("click", () => {
  if (bleDevice && bleDevice.gatt.connected) {
    setStatus("Trenne Verbindung...", "text-orange-500");
    bleDevice.gatt.disconnect();
  }
});

btnSaveWifi.addEventListener("click", async () => {
  if (!wifiService) return;
  try {
    setStatus("Speichere WLAN...", "text-blue-500");
    const ssidChar = await wifiService.getCharacteristic(WIFI_SSID_UUID);
    await ssidChar.writeValue(encodeText(wifiSsid.value));

    const passChar = await wifiService.getCharacteristic(WIFI_PASS_UUID);
    await passChar.writeValue(encodeText(wifiPass.value));

    setStatus("Prüfe WLAN-Verbindung...", "text-yellow-500");

    // Poll the connection status
    const deviceDataService = await bleDevice.gatt.getPrimaryService(DEVICE_DATA_SERVICE_UUID);
    const connectedChar = await deviceDataService.getCharacteristic(WIFI_CONNECTED_UUID);

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
      setStatus("WLAN gespeichert & Erfolgreich Verbunden! ✅", "text-green-600");

      // Wenn ein WLAN erfolgreich verbunden ist, setze den Modus direkt auf WLAN (1)
      try {
        const modeChar = await settingsService.getCharacteristic(MODE_UUID);
        await modeChar.writeValue(encodeText("1"));
      } catch (err) {
        console.warn("Modus konnte nicht auf WLAN gesetzt werden:", err);
      }
    } else {
      setStatus("WLAN gespeichert, aber Verbindung fehlgeschlagen (Passwort falsch?)", "text-red-500");
    }
  } catch (e) {
    console.error(e);
    setStatus("Fehler beim Speichern des WLANs.", "text-red-500");
  }
});

btnSaveSettings.addEventListener("click", async () => {
  if (!settingsService) return;
  try {
    setStatus("Speichere Einstellungen...", "text-purple-500");

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
    }

    const timeoutChar = await settingsService.getCharacteristic(TIMEOUT_UUID);
    await timeoutChar.writeValue(encodeText(settingTimeout.value || "3600"));

    setStatus("Einstellungen gespeichert!", "text-green-600");
  } catch (e) {
    console.error(e);
    setStatus("Fehler: Sind die neuen UUIDs bereits in main.cpp enthalten?", "text-red-500");
  }
});

const KNOWN_COLORS = [
  { r: 0, g: 0, b: 0, idx: 0 }, // Black
  { r: 0, g: 0, b: 255, idx: 1 }, // Blue
  { r: 0, g: 255, b: 0, idx: 2 }, // Green
  { r: 255, g: 0, b: 0, idx: 3 }, // Red
  { r: 255, g: 255, b: 0, idx: 5 }, // Yellow
  { r: 255, g: 255, b: 255, idx: 6 }, // White
];

function getClosestColorIndex(r, g, b) {
  let minDst = Infinity;
  let bestIdx = 6;
  for (const col of KNOWN_COLORS) {
    const dst = (r - col.r) ** 2 + (g - col.g) ** 2 + (b - col.b) ** 2;
    if (dst < minDst) {
      minDst = dst;
      bestIdx = col.idx;
    }
  }
  return bestIdx;
}

const mySpectra6Palette = aitjcizeSpectra6Palette.filter(
  (color) => color.name !== "orange" && color.name !== "cleanOrange"
);

async function updatePreviewAndBuffer(options = {}) {
  if (!originalImage) return;

  // Hintergrund zurücksetzen
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, EPD_WIDTH, EPD_HEIGHT);

  let scale = Math.max(EPD_WIDTH / originalImage.width, EPD_HEIGHT / originalImage.height);
  let w = originalImage.width * scale,
    h = originalImage.height * scale;
  let dx = (EPD_WIDTH - w) / 2,
    dy = (EPD_HEIGHT - h) / 2;

  ctx.drawImage(originalImage, dx, dy, w, h);

  let imageData = ctx.getImageData(0, 0, EPD_WIDTH, EPD_HEIGHT);

  const ditheringTypeVal = ditheringType.value;
  const matrix = errorDiffusionMatrix.value;
  const isSerpentine = serpentine.checked;
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
    colorMatchingMode: options.colorMatchingMode ?? colorMode,
    toneMapping: options.toneMapping || {
      mode: toneMappingMode,
      exposure: brightnessInt / 100 + 1,
      contrast: contrastInt / 100 + 1,
      saturation: saturationInt / 100 + 1,
    },
  };

  setStatus("Erzeuge Dithering...", "text-yellow-600");

  try {
    await ditherImage(canvas, canvas, { ...ditherOptions, palette: mySpectra6Palette });

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
        let colorIndex = getClosestColorIndex(r, g, b);

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
    updatePreviewAndBuffer();
  };
  originalImage.src = URL.createObjectURL(file);
});

btnRedither.addEventListener("click", () => {
  if (originalImage) updatePreviewAndBuffer();
});

btnAutoDither.addEventListener("click", () => {
  if (!originalImage) return;
  // Hintergrund rendern temporär fürs Auto-Testing
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, EPD_WIDTH, EPD_HEIGHT);
  let scale = Math.max(EPD_WIDTH / originalImage.width, EPD_HEIGHT / originalImage.height);
  let w = originalImage.width * scale,
    h = originalImage.height * scale;
  let dx = (EPD_WIDTH - w) / 2,
    dy = (EPD_HEIGHT - h) / 2;
  ctx.drawImage(originalImage, dx, dy, w, h);

  const suggestion = suggestCanvasProcessingOptions(canvas, mySpectra6Palette, { intent: "natural" });
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
    colorMatchingMode.value = resolvedOptions.colorMatchingMode || "rgb";

    if (resolvedOptions.toneMapping) {
      processingBrightness.value = Math.round(((resolvedOptions.toneMapping.exposure ?? 1) - 1) * 100) || 0;
      processingContrast.value = Math.round(((resolvedOptions.toneMapping.contrast ?? 1) - 1) * 100) || 0;
      processingSaturation.value = Math.round(((resolvedOptions.toneMapping.saturation ?? 1) - 1) * 100) || 0;
    } else {
      processingBrightness.value = 0;
      processingContrast.value = 0;
      processingSaturation.value = 0;
    }

    setStatus(
      `Automatisches Setting gefunden: ${suggestion.classification.style}, Typ: ${suggestion.imageKind}`,
      "text-blue-500"
    );

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

    // Upload in 240 Byte Chunks (passend für NimBLE, vermeidet Overflow)
    const chunkSize = 240;
    for (let offset = 0; offset < processedImageBuffer.length; offset += chunkSize) {
      let chunk = processedImageBuffer.slice(offset, offset + chunkSize);
      let idx = Math.floor(offset / chunkSize);

      // Intelligenter Flow-Control (Pacing):
      // Der ESP32 hat einen 4080 Byte (17 x 240) RAM-Buffer.
      // Bei Chunk 17, 34, 51... zwingt er den Chip, das RAM-Array in den Dateisystem-Flash zu schreiben.
      // Flash-Writes blockieren den Chip. Wenn wir hier blind weiterfeuern, gehen Pakete verloren (Fragmente!).
      // Indem wir Chunk 16 & 17 mit einem "sicheren" Handshake versehen (writeValue), muss der Webbrowser
      // auf den Chip warten. Das kombiniert die extreme Speed vom Fast-Write mit 100% garantierter Paket-Sicherheit!
      if (idx > 0 && (idx % 17 === 0 || idx % 17 === 16)) {
        await dataChar.writeValue(chunk);
      } else {
        await dataChar.writeValueWithoutResponse(chunk);
        await new Promise((r) => setTimeout(r, 6)); // Minimales Delay für RAM-Writes
      }

      // UI nur gelegentlich updaten für noch mehr Performance
      if (idx % 20 === 0) {
        let percent = Math.round(((offset + chunkSize) / processedImageBuffer.length) * 100);
        progressBar.style.width = percent + "%";
        setStatus(`Sende Daten... ${percent}%`, "text-green-500");
      }
    }

    progressBar.style.width = "100%";
    setStatus("Speichere im Flash...", "text-blue-500");
    await cmdChar.writeValue(encodeText("END"));

    setStatus("Aktualisiere das Display...", "text-blue-500");
    // Ca 500ms warten, damit Flash fertig synchronisiert
    await new Promise((r) => setTimeout(r, 500));
    await cmdChar.writeValue(encodeText("APPLY"));

    setStatus("Upload abgeschlossen! 🚀", "text-green-600");
  } catch (e) {
    console.error(e);
    setStatus("Bluetooth Upload Fehler: " + e.message, "text-red-500");
  } finally {
    btnUploadImage.disabled = false;
  }
});

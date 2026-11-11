// Checks whether the offline firmware can show a picture file.
//
// Mirrors the limits of the firmware (processImageFile() in src/main.cpp) and of its JPEG
// decoder (JPEGDEC). Only the beginning of the file is needed: the headers up to the picture data.

const SOF_NAMES = {
  0xc1: "Extended Sequential",
  0xc3: "Lossless",
  0xc5: "Differential Sequential",
  0xc6: "Differential Progressive",
  0xc7: "Differential Lossless",
  0xc9: "arithmetische Kodierung",
  0xca: "arithmetische Kodierung, progressiv",
  0xcb: "arithmetische Kodierung, Lossless",
  0xcd: "arithmetische Kodierung",
  0xce: "arithmetische Kodierung",
  0xcf: "arithmetische Kodierung",
};

const isJpeg = (b) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;
const isBmp = (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d;

/**
 * Walks the JPEG markers up to the picture data (SOS).
 * complete = false means: more bytes of the file are needed.
 */
function parseJpegHeader(b) {
  const info = { complete: false, valid: true, sof: 0, width: 0, height: 0, components: 0, sampling: 0, tables: [] };
  let i = 2;
  for (;;) {
    if (i + 4 > b.length) return info;
    if (b[i] !== 0xff) {
      // not a marker: the decoder skips single bytes until it finds one
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      // end of image without picture data
      info.complete = true;
      info.valid = false;
      return info;
    }
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // marker without length
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) {
      info.complete = true;
      info.valid = false;
      return info;
    }
    if (marker === 0xda) {
      info.complete = true; // start of scan: the headers are complete
      return info;
    }
    if (i + 2 + length > b.length) return info;

    const start = i + 4;
    const end = i + 2 + length;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info.sof = marker;
      info.height = (b[start + 1] << 8) | b[start + 2];
      info.width = (b[start + 3] << 8) | b[start + 4];
      info.components = b[start + 5];
      info.sampling = info.components === 1 ? 0x11 : b[start + 7]; // sampling factors of the first (Y) component
    } else if (marker === 0xc4) {
      // Huffman tables: class/id, 16 counts (codes per bit length), then the values
      let p = start;
      while (p + 17 <= end) {
        const counts = Array.from(b.subarray(p + 1, p + 17));
        const total = counts.reduce((sum, n) => sum + n, 0);
        info.tables.push({ ac: (b[p] & 0x10) !== 0, counts });
        p += 17 + total;
      }
    }
    i = end;
  }
}

/**
 * JPEGDEC decodes Huffman codes with shortened lookup tables. That only works if
 *  - DC codes are at most 12 bits long and every code longer than 6 bits starts with 11111,
 *  - every AC code longer than 10 bits starts with 111111.
 * The standard tables fulfil this, tables "optimised" for one picture not always.
 */
function huffmanTablesDecodable(tables, progressive) {
  for (const table of tables) {
    if (table.ac && progressive) continue; // not used: only the first scan of a progressive JPEG is decoded
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      for (let n = 0; n < table.counts[bits - 1]; n++) {
        if (table.ac) {
          if (bits > 10 && code >> (bits - 6) !== 0x3f) return false;
        } else {
          if (bits > 12) return false;
          if (bits > 6 && code >> (bits - 5) !== 0x1f) return false;
        }
        code++;
      }
      code <<= 1;
    }
  }
  return true;
}

/** How the firmware places a picture: scaled down to fit if too large, otherwise unchanged, always centred. */
function describeFit(width, height, display) {
  if (width === display.width && height === display.height) return "füllt das Display ganz aus";
  if (width <= display.width && height <= display.height) return `wird in Originalgröße mittig angezeigt (Display: ${display.width}×${display.height})`;
  let outW;
  let outH;
  if (width * display.height >= height * display.width) {
    outW = display.width;
    outH = Math.max(1, Math.floor((height * display.width) / width));
  } else {
    outH = display.height;
    outW = Math.max(1, Math.floor((width * display.height) / height));
  }
  const fills = outW === display.width && outH === display.height;
  return `wird auf ${outW}×${outH} verkleinert${fills ? "" : ` und mittig angezeigt (Display: ${display.width}×${display.height})`}`;
}

function checkJpeg(b, display) {
  const info = parseJpegHeader(b);
  if (!info.valid || !info.sof || info.width === 0 || info.height === 0) {
    return { level: "err", text: "Die Datei ist kein vollständiges JPEG." };
  }
  const size = `${info.width}×${info.height}`;
  if (info.sof !== 0xc0 && info.sof !== 0xc2) {
    return { level: "err", text: `Dieses JPEG (${size}, ${SOF_NAMES[info.sof] || "Sonderformat"}) kann das Gerät nicht dekodieren. Speichere es als normales Baseline-JPEG.` };
  }
  const progressive = info.sof === 0xc2;
  if (!huffmanTablesDecodable(info.tables, progressive)) {
    return { level: "err", text: `Dieses JPEG (${size}) kann das Gerät nicht dekodieren: Es nutzt optimierte Huffman-Tabellen. Speichere es ohne die Option „Optimiert“ neu oder nutze ein BMP aus dem Bild-Editor.` };
  }
  if (![0x11, 0x12, 0x21, 0x22].includes(info.sampling)) {
    return { level: "err", text: `Dieses JPEG (${size}) nutzt eine Farbunterabtastung, die das Gerät nicht dekodieren kann. Speichere es mit 4:4:4, 4:2:2 oder 4:2:0.` };
  }
  if (info.components !== 1 && info.components !== 3) {
    return { level: "err", text: `Dieses JPEG (${size}) ist kein RGB-Bild (z. B. CMYK). Das Gerät stellt die Farben falsch dar. Speichere es als RGB-JPEG.` };
  }
  if (progressive) {
    return { level: "warn", text: `Progressives JPEG (${size}): Das Gerät stellt es nur grob dar, mit 1/8 der Auflösung. Speichere es als normales Baseline-JPEG.` };
  }
  return { level: "ok", text: `JPEG ${size}: ${describeFit(info.width, info.height, display)}.` };
}

function checkBmp(b, display) {
  if (b.length < 54) return { level: "err", text: "Die Datei ist kein vollständiges BMP." };
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const size = `${width}×${height}`;

  const formatOk = [4, 24, 32].includes(bpp) && (compression === 0 || (compression === 3 && bpp === 32));
  if (dibSize < 40 || !formatOk || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    return { level: "err", text: `Dieses BMP (${size}, ${bpp} Bit${compression ? ", komprimiert" : ""}) kann das Gerät nicht anzeigen. Möglich sind unkomprimierte BMPs mit 24 oder 32 Bit oder ein BMP aus dem Bild-Editor.` };
  }
  if (bpp === 4 && topDown && width === display.width && height === display.height) {
    return { level: "ok", text: `BMP aus dem Bild-Editor (${size}): wird unverändert angezeigt.` };
  }
  return { level: "ok", text: `BMP ${size}, ${bpp} Bit: ${describeFit(width, height, display)}.` };
}

function describeOtherFormat(b) {
  const ascii = String.fromCharCode(...b.subarray(0, 16));
  if (b[0] === 0x89 && ascii.startsWith("PNG", 1)) return "ein PNG";
  if (ascii.startsWith("GIF8")) return "ein GIF";
  if (ascii.startsWith("RIFF") && ascii.startsWith("WEBP", 8)) return "ein WebP";
  if (ascii.startsWith("ftyp", 4)) return "ein HEIC/AVIF";
  if (/^\s*[<{[]/.test(ascii)) return "eine Webseite oder Textdatei";
  return "";
}

/** true as soon as `bytes` (the beginning of a file) holds everything checkImageForDevice() needs. */
export function imageHeaderComplete(bytes) {
  if (isJpeg(bytes)) return parseJpegHeader(bytes).complete;
  return bytes.length >= 64;
}

/**
 * Judges the beginning of a picture file.
 * display: { width, height } of the display raster (800×480 or 1200×1600).
 * Returns { level: "ok" | "warn" | "err", text }.
 */
export function checkImageForDevice(bytes, display) {
  if (isJpeg(bytes)) return checkJpeg(bytes, display);
  if (isBmp(bytes)) return checkBmp(bytes, display);
  if (bytes.length >= 2 && bytes[0] === 0x66 && bytes[1] === 0x66) return { level: "ok", text: "Rohdaten im Display-Format: werden unverändert angezeigt." };
  if (bytes.length === 0) return { level: "err", text: "Die URL liefert eine leere Datei." };
  const kind = describeOtherFormat(bytes);
  return { level: "err", text: `Die URL liefert ${kind || "kein JPEG oder BMP"}. Das Gerät zeigt nur JPEG und BMP an.` };
}

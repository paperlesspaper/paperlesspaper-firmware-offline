// Picture file of the gallery ("container") and what is needed to make and read one.
// Layout, limits and status codes are shared with the firmware (src/types.h) and the simulated device.

import { deflateRaw as pakoDeflateRaw } from "pako";

export const GALLERY_MAX_ITEMS = 400;
export const GALLERY_HEADER_SIZE = 16;
export const GALLERY_MAX_THUMB_SIZE = 8192;
export const GALLERY_SIZE_MARGIN = 1024;
// Window of the deflate stream as a power of two. The device unpacks with a buffer of that
// size: 4 KB instead of the 32 KB of the usual window, for 0.5 % more data.
export const GALLERY_WINDOW_BITS = 12;

export const STATUS_NO_SPACE = 0xfffc;
export const STATUS_DISPLAY_BUSY = 0xfffd;
export const STATUS_SEQ_ERROR = 0xfffe;
export const STATUS_UPLOAD_ERROR = 0xffff;

const CONTAINER_VERSION = 1;

// Display type ("7" / "13") -> picture format
export const DISPLAYS = {
  7: { width: 800, height: 480, label: '7.3"' },
  13: { width: 1200, height: 1600, label: '13.3"' },
};

export function rawLength(display) {
  const d = DISPLAYS[display];
  return (d.width * d.height) / 2;
}

/** Largest picture file the device accepts for this preview. */
export function maxContainerSize(display, thumbLen) {
  return GALLERY_HEADER_SIZE + thumbLen + rawLength(display) + GALLERY_SIZE_MARGIN;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const hexId = (value) => (value >>> 0).toString(16).padStart(8, "0");

/** The id of a picture: CRC32 of the whole file. */
export const idOf = (container) => hexId(crc32(container));

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const deflateRaw = async (bytes) => pakoDeflateRaw(bytes, { level: 6, windowBits: GALLERY_WINDOW_BITS });
export const inflateRaw = (bytes) => pipeThrough(bytes, new DecompressionStream("deflate-raw"));

/** raw: the 4 bit per pixel payload of the display. thumb: bytes of the preview (JPEG). */
/** A picture file from a device in the form this page makes: the same picture, packed with the small window. */
export async function repackContainer(container) {
  const header = readContainerHeader(container);
  if (header && header.window <= GALLERY_WINDOW_BITS) return container;
  const parsed = await parseContainer(container);
  return buildContainer(parsed.raw, parsed.display, parsed.thumb);
}

export async function buildContainer(raw, display, thumb) {
  if (raw.length !== rawLength(display)) throw new Error("Das Bild hat nicht das Format des Displays.");
  if (thumb.length > GALLERY_MAX_THUMB_SIZE) throw new Error("Die Vorschau ist zu groß.");
  const packed = await deflateRaw(raw);
  const container = new Uint8Array(GALLERY_HEADER_SIZE + thumb.length + packed.length);
  const view = new DataView(container.buffer);
  container[0] = 0x50; // "PG"
  container[1] = 0x47;
  container[2] = CONTAINER_VERSION;
  container[3] = Number(display);
  view.setUint16(4, thumb.length, true);
  container[6] = GALLERY_WINDOW_BITS;
  view.setUint32(8, raw.length, true);
  view.setUint32(12, crc32(raw), true);
  container.set(thumb, GALLERY_HEADER_SIZE);
  container.set(packed, GALLERY_HEADER_SIZE + thumb.length);
  if (container.length > maxContainerSize(display, thumb.length)) throw new Error("Das Bild lässt sich nicht klein genug packen.");
  return container;
}

/** Header of a picture file, or null if it is not one. */
export function readContainerHeader(container) {
  if (container.length < GALLERY_HEADER_SIZE || container[0] !== 0x50 || container[1] !== 0x47 || container[2] !== CONTAINER_VERSION) return null;
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const display = container[3];
  const thumbLen = view.getUint16(4, true);
  const rawLen = view.getUint32(8, true);
  if (!DISPLAYS[display] || rawLen !== rawLength(display) || thumbLen > GALLERY_MAX_THUMB_SIZE || GALLERY_HEADER_SIZE + thumbLen > container.length) return null;
  const window = container[6] || 15; // not named: the usual window
  if (window < 9 || window > 15) return null;
  return { display, thumbLen, rawLen, rawCrc: view.getUint32(12, true), window };
}

/** Unpacks a picture file: { display, thumb, raw }. Throws if it is damaged. */
export async function parseContainer(container) {
  const header = readContainerHeader(container);
  if (!header) throw new Error("Die Bilddatei vom Gerät ist ungültig.");
  const thumb = container.subarray(GALLERY_HEADER_SIZE, GALLERY_HEADER_SIZE + header.thumbLen);
  let raw;
  try {
    raw = await inflateRaw(container.subarray(GALLERY_HEADER_SIZE + header.thumbLen));
  } catch (e) {
    throw new Error("Die Bilddatei vom Gerät lässt sich nicht entpacken.");
  }
  if (raw.length !== header.rawLen || crc32(raw) !== header.rawCrc) throw new Error("Die Bilddatei vom Gerät ist beschädigt.");
  return { display: header.display, thumb, raw };
}

// Colour codes of the display -> colours roughly as the display shows them
const CODE_RGB = { 0: [31, 34, 38], 1: [65, 108, 225], 2: [6, 116, 6], 3: [234, 72, 67], 5: [219, 213, 41], 6: [226, 226, 226] };
// ... and the pure colours the editor expects (the palette "Originalfarben")
const CODE_RGB_PURE = { 0: [0, 0, 0], 1: [0, 0, 255], 2: [0, 255, 0], 3: [255, 0, 0], 5: [255, 255, 0], 6: [255, 255, 255] };

/** Draws the payload of the display onto a new canvas of the display size. */
export function rawToCanvas(raw, display, { pure = false } = {}) {
  const { width, height } = DISPLAYS[display];
  const colours = pure ? CODE_RGB_PURE : CODE_RGB;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const out = image.data;
  for (let i = 0, o = 0; i < raw.length; i++) {
    for (const code of [raw[i] >> 4, raw[i] & 0x0f]) {
      const rgb = colours[code] || colours[6];
      out[o++] = rgb[0];
      out[o++] = rgb[1];
      out[o++] = rgb[2];
      out[o++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Die Vorschau konnte nicht erzeugt werden."))), type, quality));
}

/** A small JPEG of the picture as the display shows it, at most GALLERY_MAX_THUMB_SIZE bytes. */
export async function makeThumb(raw, display) {
  const source = rawToCanvas(raw, display);
  for (const [longSide, quality] of [
    [160, 0.72],
    [160, 0.5],
    [120, 0.5],
    [96, 0.4],
  ]) {
    const scale = longSide / Math.max(source.width, source.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, "image/jpeg", quality);
    if (blob.size <= GALLERY_MAX_THUMB_SIZE) return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(0); // a picture without preview is still a valid file
}

/** The picture as a PNG file in the pure display colours (the "original" of a picture read from a device). */
export function rawToPng(raw, display) {
  return canvasBlob(rawToCanvas(raw, display, { pure: true }), "image/png");
}

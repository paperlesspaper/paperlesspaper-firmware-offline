// USB link: the read / write / notify operations of the Bluetooth interface, in frames on the
// serial line (README "USB link"). The objects have the shape of Web Bluetooth (device.gatt,
// service, characteristic), so DeviceBleInterface uses both ways with the same code.

export const USB_LINK_START_BAUD = 115200;
export const USB_LINK_MAX_PAYLOAD = 512;
export const USB_LINK_SESSION_TIMEOUT = 20; // seconds without a frame until the device ends the session

const START_0 = 0xa5;
const START_1 = 0x5a;
const TYPE_HELLO = 0x01;
const TYPE_PING = 0x02;
const TYPE_BYE = 0x03;
const TYPE_READ = 0x10;
const TYPE_WRITE = 0x11;
const TYPE_WRITE_NR = 0x12;
const TYPE_NOTIFY = 0x20;
const TYPE_ERROR = 0x7f;
const TYPE_ANSWER = 0x80;

const HEADER_SIZE = 8; // type, seq, len, key
const HELLO_WAIT_MS = 8000;
const REQUEST_TIMEOUT_MS = 30000;
const KEEP_ALIVE_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export function encodeFrame(type, seq, key = 0, payload = new Uint8Array(0)) {
  const frame = new Uint8Array(2 + HEADER_SIZE + payload.length + 4);
  const view = new DataView(frame.buffer);
  frame[0] = START_0;
  frame[1] = START_1;
  frame[2] = type;
  frame[3] = seq;
  view.setUint16(4, payload.length, true);
  view.setUint32(6, key >>> 0, true);
  frame.set(payload, 10);
  view.setUint32(10 + payload.length, crc32(frame, 2, 10 + payload.length), true);
  return frame;
}

/** Takes the frames out of the bytes of the serial line; the log text between them is dropped. */
export class FrameReader {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const frames = [];
    let pos = 0;
    for (;;) {
      while (pos < joined.length - 1 && !(joined[pos] === START_0 && joined[pos + 1] === START_1)) pos++;
      if (pos >= joined.length - 1) {
        if (joined.length && joined[joined.length - 1] !== START_0) pos = joined.length;
        break;
      }
      if (joined.length - pos < 2 + HEADER_SIZE) break;
      const length = joined[pos + 4] | (joined[pos + 5] << 8);
      const end = pos + 2 + HEADER_SIZE + length + 4;
      if (length > USB_LINK_MAX_PAYLOAD) {
        pos += 2; // not a frame
        continue;
      }
      if (joined.length < end) break;
      const view = new DataView(joined.buffer, pos, end - pos);
      if (view.getUint32(10 + length, true) !== crc32(joined, pos + 2, pos + 10 + length)) {
        pos += 2;
        continue;
      }
      frames.push({ type: joined[pos + 2], seq: joined[pos + 3], key: view.getUint32(6, true), payload: joined.slice(pos + 10, pos + 10 + length) });
      pos = end;
    }
    this.buffer = joined.slice(pos);
    return frames;
  }
}

const linkError = (message, name = "NetworkError") => new DOMException(message, name);

class UsbCharacteristic extends EventTarget {
  constructor(gatt, uuid) {
    super();
    this.gatt = gatt;
    this.uuid = uuid;
    this.key = parseInt(uuid.slice(0, 8), 16) >>> 0;
    this.value = null;
  }

  async readValue() {
    const payload = await this.gatt._request(TYPE_READ, this.key);
    this.value = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return this.value;
  }

  async writeValue(data) {
    await this.gatt._request(TYPE_WRITE, this.key, toBytes(data));
  }

  writeValueWithResponse(data) {
    return this.writeValue(data);
  }

  writeValueWithoutResponse(data) {
    return this.gatt._post(TYPE_WRITE_NR, this.key, toBytes(data));
  }

  async startNotifications() {
    return this; // the device reports every change without a subscription
  }

  async stopNotifications() {
    return this;
  }
}

class UsbGatt {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this._characteristics = new Map();
    this._reader = null;
    this._writer = null;
    this._frames = new FrameReader();
    this._pending = null; // { type, seq, resolve, reject }
    this._chain = Promise.resolve(); // one request at a time
    this._seq = 0;
    this._closing = null;
    this._connecting = null;
    this._aborted = false;
    this._keepAlive = null;
    this._lastSentAt = 0;
  }

  async _open(baudRate) {
    try {
      await this.device.port.open({ baudRate, bufferSize: 16384 });
    } catch (e) {
      // another program holds the port (a serial monitor, a second tab), or the cable is gone
      throw linkError(`Der USB-Anschluss lässt sich nicht öffnen. Schließe andere Programme, die ihn nutzen (z. B. einen seriellen Monitor). (${e?.message || e})`);
    }
    this._frames = new FrameReader();
    this._writer = this.device.port.writable.getWriter();
    const reader = this.device.port.readable.getReader();
    this._reader = reader;
    this._pump(reader);
  }

  async _pump(reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of this._frames.push(value)) this._onFrame(frame);
      }
    } catch (e) {
      // the port is gone (cable pulled)
    }
    if (this._reader === reader && this.connected) this._lost("Die USB-Verbindung zum E-Paper wurde getrennt.");
  }

  async _close() {
    const reader = this._reader;
    const writer = this._writer;
    this._reader = this._writer = null;
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (writer) writer.releaseLock();
    await this.device.port.close().catch(() => {});
  }

  _onFrame(frame) {
    if (frame.type === TYPE_NOTIFY) {
      for (const characteristic of this._characteristics.values()) {
        if (characteristic.key !== frame.key) continue;
        characteristic.value = new DataView(frame.payload.buffer);
        characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
      }
      return;
    }
    const pending = this._pending;
    if (!pending) return;
    // a late answer to an earlier HELLO counts too: the device has already changed its speed
    if (frame.seq !== pending.seq && pending.type !== TYPE_HELLO) return;
    if (frame.type === TYPE_ERROR) {
      this._pending = null;
      pending.reject(linkError("Das E-Paper kennt diese Anfrage nicht.", "NotSupportedError"));
    } else if (frame.type === (pending.type | TYPE_ANSWER)) {
      this._pending = null;
      pending.resolve(frame.payload);
    }
  }

  async _write(type, seq, key, payload) {
    if (!this._writer) throw linkError("Keine USB-Verbindung zum E-Paper (GATT nicht verbunden).");
    if (payload.length > USB_LINK_MAX_PAYLOAD) throw linkError("Zu viele Daten für eine Anfrage.", "InvalidModificationError");
    this._lastSentAt = Date.now();
    await this._writer.write(encodeFrame(type, seq, key, payload));
  }

  /** Sends a frame and waits for its answer; null after `timeoutMs` if `optional`. */
  async _exchange(type, key, payload, timeoutMs, optional = false) {
    this._seq = (this._seq % 255) + 1;
    const seq = this._seq;
    let timer = null;
    const answer = new Promise((resolve, reject) => {
      this._pending = { type, seq, resolve, reject };
      timer = setTimeout(() => {
        if (this._pending?.seq !== seq) return;
        this._pending = null;
        if (optional) resolve(null);
        else reject(linkError("Das E-Paper antwortet nicht mehr über USB."));
      }, timeoutMs);
    });
    answer.catch(() => {});
    try {
      await this._write(type, seq, key, payload);
      return await answer;
    } catch (e) {
      if (this._pending?.seq === seq) this._pending = null;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  _queue(task) {
    const run = this._chain.then(task, task);
    this._chain = run.catch(() => {});
    return run;
  }

  _request(type, key = 0, payload = new Uint8Array(0)) {
    return this._queue(async () => {
      if (!this.connected) throw linkError("Keine USB-Verbindung zum E-Paper (GATT nicht verbunden).");
      try {
        return await this._exchange(type, key, payload, REQUEST_TIMEOUT_MS);
      } catch (e) {
        if (e?.name === "NetworkError" && this.connected) this._lost(e.message);
        throw e;
      }
    });
  }

  _post(type, key, payload) {
    return this._queue(async () => {
      if (!this.connected) throw linkError("Keine USB-Verbindung zum E-Paper (GATT nicht verbunden).");
      await this._write(type, 0, key, payload);
    });
  }

  _checkAbort() {
    if (this._aborted) throw linkError("Verbindungsaufbau abgebrochen", "AbortError");
  }

  connect() {
    this._connecting = this._connect();
    return this._connecting;
  }

  async _connect() {
    if (this.connected) return this;
    if (this._closing) await this._closing;
    this._aborted = false;
    this._characteristics.clear();
    try {
      await this._open(USB_LINK_START_BAUD);
      let hello = null;
      for (const end = Date.now() + HELLO_WAIT_MS; !hello; ) {
        this._checkAbort();
        if (Date.now() > end) throw linkError("Das E-Paper antwortet nicht über USB. Drücke einmal die Reset-Taste am E-Paper: Danach ist es 20 Sekunden bereit.");
        hello = await this._exchange(TYPE_HELLO, 0, new Uint8Array(0), 500, true);
      }
      const info = JSON.parse(new TextDecoder().decode(hello));
      this.device.name = String(info.name || "");
      const baud = Number(info.baud) || USB_LINK_START_BAUD;
      if (baud !== USB_LINK_START_BAUD) {
        await this._close();
        await sleep(60);
        await this._open(baud);
      }
      let answered = false;
      for (let i = 0; i < 20 && !answered; i++) {
        this._checkAbort();
        answered = (await this._exchange(TYPE_PING, 0, new Uint8Array(0), 400, true)) !== null;
      }
      if (!answered) throw linkError(`Das E-Paper antwortet nicht mit ${baud} Baud.`);
    } catch (e) {
      await this._close();
      throw e;
    }
    this.connected = true;
    this._keepAlive = setInterval(() => {
      if (this.connected && !this._pending && Date.now() - this._lastSentAt > KEEP_ALIVE_MS) {
        this._request(TYPE_PING).catch(() => {});
      }
    }, 1000);
    return this;
  }

  _end(sendBye) {
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this._keepAlive);
    const pending = this._pending;
    this._pending = null;
    if (pending) pending.reject(linkError("Die USB-Verbindung zum E-Paper wurde getrennt (GATT disconnect)."));
    const previous = this._closing || Promise.resolve();
    this._closing = previous.then(async () => {
      if (sendBye && this._writer) {
        await this._writer.write(encodeFrame(TYPE_BYE, 0)).catch(() => {});
        await sleep(50);
      }
      await this._close();
    });
    if (wasConnected) this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }

  _lost() {
    this._end(false);
  }

  /** Ends the session, or a connection attempt that is still running. */
  disconnect() {
    if (!this.connected) {
      this._aborted = true;
      return;
    }
    this._end(true);
  }

  /** Resolves when the serial port is free again (for the flasher, which opens the same port). */
  async closed() {
    if (this._connecting) await this._connecting.catch(() => {});
    if (this._closing) await this._closing;
  }

  async getPrimaryService() {
    if (!this.connected) throw linkError("Keine USB-Verbindung zum E-Paper (GATT nicht verbunden).");
    return {
      getCharacteristic: async (uuid) => {
        if (!this.connected) throw linkError("Keine USB-Verbindung zum E-Paper (GATT nicht verbunden).");
        uuid = String(uuid).toLowerCase();
        if (!this._characteristics.has(uuid)) this._characteristics.set(uuid, new UsbCharacteristic(this, uuid));
        return this._characteristics.get(uuid);
      },
    };
  }
}

/** The device behind a serial port of Web Serial, in the shape of a BluetoothDevice. */
export class UsbLinkDevice extends EventTarget {
  constructor(port) {
    super();
    this.port = port;
    this.name = ""; // known after connecting (HELLO)
    this.gatt = new UsbGatt(this);
  }
}

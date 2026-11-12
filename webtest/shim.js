// Replaces navigator.bluetooth in the page under test.
//
// The web UI talks to this object exactly as it talks to Chrome's Web Bluetooth. Every GATT
// operation is forwarded to the test process (window.__bleBridge, see harness.py), which
// answers from a simulated device or from the real device over the PC's Bluetooth.
//
// Behaviour copied from Chrome because the web UI depends on it:
//   * getCharacteristic() returns the same object for the same characteristic
//   * readValue() also fires "characteristicvaluechanged"
//   * operations on a disconnected device reject with a NetworkError that mentions "GATT"
//   * gatt.disconnect() fires "gattserverdisconnected" on the device
(() => {
  const stats = { operations: 0, running: 0, maxParallel: 0, chooserCalls: 0 };
  window.__bleStats = stats;

  const toBase64 = (data) => {
    const bytes = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  };
  const fromBase64 = (text) => {
    const raw = atob(text || "");
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new DataView(bytes.buffer);
  };

  async function call(op, args = {}) {
    stats.operations++;
    stats.running++;
    stats.maxParallel = Math.max(stats.maxParallel, stats.running);
    try {
      const result = await window.__bleBridge(op, args);
      if (result && result.error) {
        throw new DOMException(result.error.message, result.error.name || "NetworkError");
      }
      return result || {};
    } finally {
      stats.running--;
    }
  }

  const disconnectedError = () => new DOMException("GATT Server is disconnected. Cannot perform GATT operations. (Re)connect first with `device.gatt.connect`.", "NetworkError");

  class Characteristic extends EventTarget {
    constructor(service, uuid) {
      super();
      this.service = service;
      this.uuid = uuid;
      this.value = null;
    }
    _check() {
      if (!this.service.device.gatt.connected) throw disconnectedError();
    }
    _emit(view) {
      this.value = view;
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
    async readValue() {
      this._check();
      const result = await call("read", { uuid: this.uuid });
      const view = fromBase64(result.data);
      this._emit(view);
      return view;
    }
    async _write(data, response) {
      this._check();
      await call("write", { uuid: this.uuid, data: toBase64(data), response });
    }
    writeValue(data) {
      return this._write(data, true);
    }
    writeValueWithResponse(data) {
      return this._write(data, true);
    }
    writeValueWithoutResponse(data) {
      return this._write(data, false);
    }
    async startNotifications() {
      this._check();
      await call("subscribe", { uuid: this.uuid });
      return this;
    }
    async stopNotifications() {
      return this;
    }
  }

  class Service {
    constructor(device, uuid) {
      this.device = device;
      this.uuid = uuid;
      this.characteristics = new Map();
    }
    async getCharacteristic(uuid) {
      if (!this.device.gatt.connected) throw disconnectedError();
      uuid = String(uuid).toLowerCase();
      if (!this.characteristics.has(uuid)) {
        const found = await call("has_characteristic", { service: this.uuid, uuid });
        if (!found.exists) throw new DOMException(`No Characteristics matching UUID ${uuid} found in Service with UUID ${this.uuid}.`, "NotFoundError");
        this.characteristics.set(uuid, new Characteristic(this, uuid));
      }
      return this.characteristics.get(uuid);
    }
  }

  class GattServer {
    constructor(device) {
      this.device = device;
      this.connected = false;
      this.services = new Map();
    }
    async connect() {
      await call("connect");
      this.connected = true;
      this.services.clear();
      return this;
    }
    disconnect() {
      if (!this.connected) return;
      this._dropped();
      window.__bleBridge("disconnect", {});
    }
    _dropped() {
      if (!this.connected) return;
      this.connected = false;
      this.services.clear();
      this.device.dispatchEvent(new Event("gattserverdisconnected"));
    }
    async getPrimaryService(uuid) {
      if (!this.connected) throw disconnectedError();
      uuid = String(uuid).toLowerCase();
      if (!this.services.has(uuid)) {
        const found = await call("has_service", { uuid });
        if (!found.exists) throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, "NotFoundError");
        this.services.set(uuid, new Service(this.device, uuid));
      }
      return this.services.get(uuid);
    }
  }

  class Device extends EventTarget {
    constructor(name) {
      super();
      this.id = "test-device";
      this.name = name;
      this.gatt = new GattServer(this);
    }
  }

  let current = null;

  // Called by the test process: a notification of the device, or the device closed the link.
  window.__bleEvent = (event) => {
    if (!current) return;
    if (event.type === "disconnected") {
      current.gatt._dropped();
    } else if (event.type === "notify" && current.gatt.connected) {
      for (const service of current.gatt.services.values()) {
        const characteristic = service.characteristics.get(event.uuid);
        if (characteristic) characteristic._emit(fromBase64(event.data));
      }
    }
  };

  const bluetooth = {
    async requestDevice(options) {
      stats.chooserCalls++;
      const result = await call("request_device", { filters: options?.filters || [] });
      current = new Device(result.name);
      return current;
    },
    async getAvailability() {
      return true;
    },
  };
  Object.defineProperty(navigator, "bluetooth", { value: bluetooth, configurable: true });
})();
